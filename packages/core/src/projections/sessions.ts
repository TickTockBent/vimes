import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, SessionRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  attentionReasonForSetter,
  attentionClearedPayloadSchema,
  billingBucketObservedPayloadSchema,
  claudeSessionMappedPayloadSchema,
  livenessChangedPayloadSchema,
  seenPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionCreatedPayloadSchema,
  sessionRenamedPayloadSchema,
  taskQuarantinedPayloadSchema,
  ttlTierObservedPayloadSchema,
} from '../events.js';
import { isTranscriptAppendEventType } from '../tasks/watchdogDecision.js';

export interface SessionsState {
  sessions: Record<string, SessionRecord>;
}

// Immutably replace one session; a no-op when the session is unknown (log is
// truth, nothing throws — events for sessions we never saw created are ignored).
function withSession(
  state: SessionsState,
  appSessionId: string,
  update: (session: SessionRecord) => SessionRecord,
): SessionsState {
  const existingSession = state.sessions[appSessionId];
  if (existingSession === undefined) {
    return state;
  }
  return {
    sessions: { ...state.sessions, [appSessionId]: update(existingSession) },
  };
}

// ─── D34: the watchdog HEARTBEAT fold (slice 6 step 5b) ──────────────────────
//
// `lastAppendAt` answers "when did this session last append to its transcript?"
// — a fact about a SESSION, folded here because the events that answer it are
// SESSION-stream events. That is the whole of D34: `bootFromSnapshot` folds each
// stream to completion in alphabetical order and the log has no global ordering
// column, so a projection may only fold events from its own stream
// (architecture.md, "Projections are STREAM-LOCAL"). Take 1 of this step put the
// field on the TaskRecord and folded session appends into the TASKS projection;
// every session stream is a UUID and sorts before `'tasks'`, so the appends were
// folded before the `task_session_attached` that gave them meaning, and I6
// broke. Every event consulted below is constructed with
// `stream: payload.appSessionId` (events.ts), so this fold is same-stream.
//
// ⚠ **WHICH EVENTS COUNT IS NOT DECIDED HERE.** The membership test is 5a's
// exported `isTranscriptAppendEventType`, so the watchdog's decision and this
// projection read ONE definition of "the run appended" (principle 9). Only
// events the TAILER derived from a real JSONL record are in it; daemon-authored
// bookkeeping (`liveness_changed`, `notification_trigger`, `seen`,
// `attention_cleared`, `watchdog_stale`, `session_renamed`, the `task_*` family)
// is NOT, and must never be added.
//
// **The self-defeating bug that exclusion prevents:** if bookkeeping counted,
// the watchdog writing `watchdog_stale` would refresh the very heartbeat it is
// judging — every check would then observe a fresh append, silence would reset
// to zero on each escalation, and the guard could never escalate at all. A guard
// that disarms itself on use. Rule 0.7 says it from the other side: staleness is
// OBSERVED (append cadence), never DECLARED.
function withTranscriptAppendHeartbeat(
  state: SessionsState,
  event: EventRecord,
): SessionsState {
  if (!isTranscriptAppendEventType(event.type)) {
    return state;
  }
  // Every transcript-append payload carries `appSessionId`; `seenPayloadSchema`
  // is exactly `{ appSessionId }` and Zod STRIPS the rest, so one parse serves
  // all nine types without this fold owning a second copy of their schemas. The
  // same trick the attention-setter branch below already uses for
  // `watchdog_stale`. A payload without a usable `appSessionId` is malformed →
  // state unchanged, never a throw (I8).
  const parsed = seenPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    return state;
  }
  // `withSession` ignores an unknown session, and returns a NEW record — the
  // input state is never mutated (snapshots share references with live state).
  return withSession(state, parsed.data.appSessionId, (session) => ({
    ...session,
    lastAppendAt: event.ts,
  }));
}

export const sessionsProjection: Projection<SessionsState> = {
  id: 'sessions',

  init(): SessionsState {
    return { sessions: {} };
  },

  // TOTAL: unknown event types are no-ops; events for unknown sessions are
  // no-ops; a malformed payload is a no-op. Nothing throws.
  apply(incomingState: SessionsState, event: EventRecord): SessionsState {
    // The heartbeat fold runs FIRST and COMPOSES with the type switch below: a
    // `gate_fired` both advances `lastAppendAt` (the run appended — it was alive
    // enough to ask) and raises attention. Everything after this line therefore
    // folds against `state` = "the incoming state with the heartbeat already
    // applied"; for every event type outside the exported append set it is the
    // incoming state unchanged.
    const state = withTranscriptAppendHeartbeat(incomingState, event);
    switch (event.type) {
      case EVENT_TYPES.sessionCreated: {
        const parsed = sessionCreatedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        if (state.sessions[payload.appSessionId] !== undefined) {
          // Duplicate creation is a no-op — never clobber an existing record.
          return state;
        }
        const bornSession: SessionRecord = {
          appSessionId: payload.appSessionId,
          channel: payload.channel,
          cwd: payload.cwd,
          claudeSessionIds: [],
          liveness: 'spawning',
          needsAttention: null,
          seenAt: null,
          forkedFrom: payload.forkedFrom,
          taskRef: payload.taskRef,
          observedTtlTier: 'unknown',
          observedBillingBucket: 'unknown',
          name: payload.name,
          createdAt: event.ts,
          // E1/D18: default 'claude-code' when the payload omits provider, so old
          // session_created events (predating the field) project without breaking.
          provider: payload.provider ?? 'claude-code',
          // D10: default 'host' when the payload omits custody, so old
          // session_created events project as host-owned; discovery sets 'external'.
          custody: payload.custody ?? 'host',
        };
        return { sessions: { ...state.sessions, [payload.appSessionId]: bornSession } };
      }

      case EVENT_TYPES.livenessChanged: {
        const parsed = livenessChangedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        // Applied totally — edge enforcement lives in sessionMachine/emitters.
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          liveness: parsed.data.to,
        }));
      }

      case EVENT_TYPES.gateFired:
      case EVENT_TYPES.questionAsked:
      case EVENT_TYPES.runCompleted:
      case EVENT_TYPES.watchdogStale:
      case EVENT_TYPES.taskQuarantined: {
        const reason = attentionReasonForSetter(event.type);
        if (reason === null) {
          return state;
        }
        // All setters carry appSessionId; task_quarantined carries an extra
        // taskId (validated but unused by the SessionRecord).
        const parsed =
          event.type === EVENT_TYPES.taskQuarantined
            ? taskQuarantinedPayloadSchema.safeParse(event.payload)
            : seenPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => {
          const attendedSession: SessionRecord = {
            ...session,
            needsAttention: { reason, since: event.ts },
          };
          if (event.type !== EVENT_TYPES.watchdogStale) {
            return attendedSession;
          }
          // D34: count the stale EPISODE on the session, same stream as the
          // event that reports it. Note what this is NOT: it is not a retry
          // count, because nothing retries — the watchdog reports and stops
          // (slice 6 step 5b). `?? 0` is the old-snapshot path: a record written
          // before this field existed has no count, and its first episode is 1.
          //
          // ⚠ `watchdog_stale` deliberately does NOT advance `lastAppendAt` —
          // it is not in `TRANSCRIPT_APPEND_EVENT_TYPES`, so the heartbeat fold
          // above skipped it. See that fold's note: a watchdog whose own report
          // refreshed the heartbeat it is judging could never escalate.
          return { ...attendedSession, staleEpisodes: (session.staleEpisodes ?? 0) + 1 };
        });
      }

      case EVENT_TYPES.seen: {
        const parsed = seenPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        // Sets seenAt only — NEVER touches needsAttention.
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          seenAt: event.ts,
        }));
      }

      case EVENT_TYPES.attentionCleared: {
        const parsed = attentionClearedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        // The ONLY clear path.
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          needsAttention: null,
        }));
      }

      case EVENT_TYPES.claudeSessionMapped: {
        const parsed = claudeSessionMappedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // I1 — rotation changes ONLY the mapping; append-only.
        return withSession(state, payload.appSessionId, (session) => ({
          ...session,
          claudeSessionIds: [
            ...session.claudeSessionIds,
            { id: payload.claudeSessionId, jsonlPath: payload.jsonlPath, observedAt: event.ts },
          ],
        }));
      }

      case EVENT_TYPES.ttlTierObserved: {
        const parsed = ttlTierObservedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          observedTtlTier: parsed.data.tier,
        }));
      }

      case EVENT_TYPES.billingBucketObserved: {
        const parsed = billingBucketObservedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          observedBillingBucket: parsed.data.bucket,
        }));
      }

      case EVENT_TYPES.sessionAdopted: {
        const parsed = sessionAdoptedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        // D10: adoption flips custody to 'host' — the session is now VIMES-owned
        // (writable/killable/resumable). Liveness is untouched (a separate axis).
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          custody: 'host',
        }));
      }

      case EVENT_TYPES.sessionRenamed: {
        const parsed = sessionRenamedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          name: parsed.data.name,
        }));
      }

      // transition_rejected, notification_trigger, host_started, host_stopped,
      // resync_marker (a client-facing signal only), and any unknown type do not
      // change a SessionRecord here.
      //
      // message, usage_block and line_quarantined reach no case of their own —
      // but they are NOT no-ops any more: they are transcript appends, and
      // `withTranscriptAppendHeartbeat` above already advanced `lastAppendAt`
      // for them before this switch ran. They change nothing else.
      default:
        return state;
    }
  },

  serialize(state: SessionsState): string {
    return canonicalJson(state);
  },
};
