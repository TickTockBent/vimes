import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, SessionRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  attentionReasonForSetter,
  attentionClearedPayloadSchema,
  billingBucketObservedPayloadSchema,
  claudeSessionMappedPayloadSchema,
  correctionDeliveredPayloadSchema,
  correctionQueuedPayloadSchema,
  livenessChangedPayloadSchema,
  messagePayloadSchema,
  seenPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionCreatedPayloadSchema,
  sessionRenamedPayloadSchema,
  taskQuarantinedPayloadSchema,
  ttlTierObservedPayloadSchema,
  type Liveness,
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

// ─── D35: the two liveness states in which a turn can still be in flight ─────
//
// Used ONE WAY ONLY — to decide whether a `liveness_changed` CLEARS
// `turnInFlight`. Nothing here ever SETS it: `running` says the process is
// alive, not that a turn is running, and reading it as "a turn started" is
// precisely the phantom D35 was written about (`138d3ef4` was `running` from
// `liveness_changed{cause:'spawn'}` before any prompt existed). `spawning` is
// listed beside `running` because a resume in flight has not ended anything
// either — a session mid-resume must not have a turn cleared out from under it.
const LIVENESS_STATES_A_TURN_CAN_SURVIVE: ReadonlySet<Liveness> = new Set<Liveness>([
  'spawning',
  'running',
]);

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
        return withSession(state, parsed.data.appSessionId, (session) => {
          const movedSession: SessionRecord = { ...session, liveness: parsed.data.to };
          // ⚠ **D35: CLEAR-ONLY, NEVER SET.** A transition INTO a live state
          // leaves `turnInFlight` exactly as it was — a
          // `liveness_changed{to:'running', cause:'spawn'}` says a process
          // started, and reading that as "a turn started" is defect A itself.
          // A transition OUT of the live states (dormant / interrupted / dead)
          // ends whatever turn was running: the process cannot still be
          // thinking, so an unfinished turn must not stay marked in flight and
          // make the operator's next opening prompt look like a steer.
          if (LIVENESS_STATES_A_TURN_CAN_SURVIVE.has(parsed.data.to)) {
            return movedSession;
          }
          return { ...movedSession, turnInFlight: false };
        });
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
          // ── D35: `run_completed` is THE TURN BOUNDARY, and the clear ────────
          //
          // ⚠ **THIS BRANCH IS `run_completed` ALONE.** The other four events in
          // this case group (`gate_fired`, `question_asked`, `watchdog_stale`,
          // `task_quarantined`) set attention and NOTHING else — none of them
          // ends a turn (a gate is asked mid-turn, a staleness report is the
          // watchdog talking about a run, not the run talking), so none of them
          // may acquire a correction-clearing side effect.
          //
          // Two clears, and the second one is LOAD-BEARING, not a backstop:
          //
          // 1. `turnInFlight → false`. The turn ended; the next thing the
          //    operator types is a fresh prompt, not a steer.
          // 2. `pendingCorrectionAt → null`. D35 measured corrections arriving
          //    in TWO shapes: mid-turn (a `queued_command` attachment the
          //    transcript mapper sees — on the PTY channel) and AFTER THE TURN
          //    ENDED (an ordinary user message with no attachment at all, which
          //    emits **no signal any tailer could ever see, on any channel**).
          //    `correction_delivered` covers only the first shape, and only
          //    where the transcript is read at all — the SDK skip means its
          //    lifetime count in the production log is 0. So this is the ONLY
          //    path that covers both shapes, and without it the composer's
          //    "correction queued" indicator sticks forever, which is exactly
          //    what a real operator hit.
          //
          // Both are written UNCONDITIONALLY, unlike `correction_delivered`
          // below, which deliberately refuses to create a field that was never
          // there. The asymmetry is deliberate: a delivery with nothing pending
          // is a COMMON event for sessions VIMES never steered (a human typing
          // into a PTY), and stamping those records would be inventing state
          // from someone else's activity. A `run_completed` is VIMES observing
          // the end of a turn on a session it is already rewriting (attention,
          // above) — there is no untouched byte-shape left to preserve, and
          // "no correction is pending" is a true statement about it.
          if (event.type === EVENT_TYPES.runCompleted) {
            return { ...attendedSession, turnInFlight: false, pendingCorrectionAt: null };
          }
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
        //
        // ── D35: adoption also RESETS `turnInFlight`, and only ever to false ──
        //
        // ⚠ **A MIRRORED SESSION ACCUMULATES A TURN NOTHING CAN END.** The tailer
        // emits `message` events for an externally-discovered session, so the
        // fold above sets `turnInFlight: true` — but VIMES is not driving that
        // process, so no `run_completed` ever arrives and its liveness never
        // moves (discovery parks it at `interrupted` and leaves it there). While
        // the session stays mirrored that is harmless: the host refuses every
        // send with `external-custody` before anything is emitted, and a refused
        // send emits nothing. Adoption is where it would start to lie — the very
        // next send would read a stale `true` and record a phantom
        // course-correction, which is the defect D35 exists to kill.
        //
        // `false` rather than "leave it alone" because adoption means VIMES has
        // just taken custody of a process it was NEVER DRIVING: what that process
        // is doing right now is genuinely UNKNOWN, and unknown resolves to
        // false — the same fail-safe direction the rest of D35 takes. An absent
        // correction record costs the watchdog a protection it did not need; a
        // phantom one switches the staleness guard OFF on a run nobody is
        // steering. The next `message` sets it truthfully anyway.
        //
        // ⚠ LIVENESS STAYS UNTOUCHED HERE. Custody and liveness are separate
        // axes (the D10 line above), and this clear does not widen that.
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          custody: 'host',
          turnInFlight: false,
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

      // ── D5/D30: the COURSE-CORRECTION fold (slice 6 step 6a) ──────────────
      //
      // ⚠ **THIS IS THE PROJECTION D34 WAS ABOUT, SO SAY IT OUT LOUD: BOTH
      // EVENTS BELOW ARE SAME-STREAM.** `correctionQueued` and
      // `correctionDelivered` are constructed with `stream: payload.appSessionId`
      // (events.ts), exactly like `liveness_changed` and the transcript appends,
      // so this fold reads only the SESSION stream it belongs to and D34 /
      // architecture.md ("Projections are STREAM-LOCAL") is satisfied by
      // construction rather than by luck. The version of this that would be
      // ILLEGAL is the tempting one: putting `pendingCorrectionAt` on the
      // TaskRecord and folding these session events into the tasks projection —
      // which is precisely take 1 of step 5b, and precisely what D34 forbids.
      //
      // ⚠ Note what does NOT happen here: `correction_delivered` does not
      // advance `lastAppendAt`. It is not in `TRANSCRIPT_APPEND_EVENT_TYPES`
      // (tasks/watchdogDecision.ts owns that set), so the heartbeat fold above
      // skipped it. That is deliberate and load-bearing — delivery must RELEASE
      // the protection without also resetting the silence clock, or a run that
      // wedges immediately after being steered would look freshly alive.
      case EVENT_TYPES.correctionQueued: {
        const parsed = correctionQueuedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        // The event's `ts`, never a clock read (rule 0.3) and never the
        // operator's own wall time.
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          pendingCorrectionAt: event.ts,
        }));
      }

      // ── D35: a delivered message means a turn is IN FLIGHT ────────────────
      //
      // Same-stream by construction, like everything else folded here: `message`
      // is emitted with `stream: payload.appSessionId` (events.ts), so D34 /
      // architecture.md ("Projections are STREAM-LOCAL") is satisfied.
      //
      // ⚠ **THE SET LIVES HERE AND NOWHERE ELSE.** This is the only event that
      // may set `turnInFlight`, because it is the only one that observes VIMES
      // actually handing text to a live process — `sessionHost.deliverMessage`
      // echoes every operator turn as `message(role:'user')` BEFORE it reaches
      // the SDK stream / PTY (D12), and the model's own turns append as
      // `message(role:'assistant')`. Both mean the same thing for this bit: the
      // run is mid-turn. Liveness must never set it; see the `liveness_changed`
      // fold above for the trace that proves why.
      //
      // Note what this case does NOT do: it does not touch `lastAppendAt`.
      // `message` is in `TRANSCRIPT_APPEND_EVENT_TYPES`, so
      // `withTranscriptAppendHeartbeat` above ALREADY advanced the heartbeat
      // before this switch ran — this case composes with that fold rather than
      // duplicating it (the same composition the attention setters use).
      case EVENT_TYPES.message: {
        const parsed = messagePayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          turnInFlight: true,
        }));
      }

      case EVENT_TYPES.correctionDelivered: {
        const parsed = correctionDeliveredPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        return withSession(state, parsed.data.appSessionId, (session) => {
          if (session.pendingCorrectionAt === undefined || session.pendingCorrectionAt === null) {
            // ⚠ A DELIVERY WITH NOTHING PENDING IS A NO-OP, NOT AN ERROR — and
            // it is the COMMON case, not a corner one. A human typing directly
            // into a PTY produces a `commandMode:'prompt'` queued_command that
            // VIMES never queued and has no `correction_queued` for; so does any
            // correction that was in flight when the daemon last restarted. The
            // session record is returned UNTOUCHED (not stamped with a `null`),
            // so a session that never had a pending correction never acquires
            // the field at all.
            return session;
          }
          return { ...session, pendingCorrectionAt: null };
        });
      }

      // transition_rejected, notification_trigger, host_started, host_stopped,
      // resync_marker (a client-facing signal only), and any unknown type do not
      // change a SessionRecord here.
      //
      // usage_block and line_quarantined reach no case of their own — but they
      // are NOT no-ops: they are transcript appends, and
      // `withTranscriptAppendHeartbeat` above already advanced `lastAppendAt`
      // for them before this switch ran. They change nothing else. (`message`
      // used to be in this list; D35 gave it a case of its own — it is still a
      // transcript append, and now also the one event that sets `turnInFlight`.)
      default:
        return state;
    }
  },

  serialize(state: SessionsState): string {
    return canonicalJson(state);
  },
};
