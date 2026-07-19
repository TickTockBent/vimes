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
  sessionCreatedPayloadSchema,
  taskQuarantinedPayloadSchema,
  ttlTierObservedPayloadSchema,
} from '../events.js';

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

export const sessionsProjection: Projection<SessionsState> = {
  id: 'sessions',

  init(): SessionsState {
    return { sessions: {} };
  },

  // TOTAL: unknown event types are no-ops; events for unknown sessions are
  // no-ops; a malformed payload is a no-op. Nothing throws.
  apply(state: SessionsState, event: EventRecord): SessionsState {
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
        return withSession(state, parsed.data.appSessionId, (session) => ({
          ...session,
          needsAttention: { reason, since: event.ts },
        }));
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

      // transition_rejected, notification_trigger, message, usage_block,
      // line_quarantined, host_started, host_stopped, and any unknown type do
      // not change a SessionRecord.
      default:
        return state;
    }
  },

  serialize(state: SessionsState): string {
    return canonicalJson(state);
  },
};
