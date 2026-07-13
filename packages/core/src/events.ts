import { z } from 'zod';
import type { EventInput } from './schemas.js';

// The domain event vocabulary (spec §3.3 / slice-0.md). Each type carries a zod
// payload schema; helper constructors build EventInput records ready for
// store.append()/router.emit(). Stream is the appSessionId unless the event is
// system-scoped.

export const EVENT_TYPES = {
  sessionCreated: 'session_created',
  livenessChanged: 'liveness_changed',
  transitionRejected: 'transition_rejected',
  gateFired: 'gate_fired',
  questionAsked: 'question_asked',
  runCompleted: 'run_completed',
  watchdogStale: 'watchdog_stale',
  taskQuarantined: 'task_quarantined',
  notificationTrigger: 'notification_trigger',
  seen: 'seen',
  attentionCleared: 'attention_cleared',
  claudeSessionMapped: 'claude_session_mapped',
  ttlTierObserved: 'ttl_tier_observed',
  billingBucketObserved: 'billing_bucket_observed',
  message: 'message',
  usageBlock: 'usage_block',
  lineQuarantined: 'line_quarantined',
  hostStarted: 'host_started',
  hostStopped: 'host_stopped',
  // The two sanctioned slice-0 vocabulary additions (step 4, budget-wall
  // profile): a meter crossing its threshold, and the dispatcher stub refusing.
  meterThresholdCrossed: 'meter_threshold_crossed',
  dispatchRefused: 'dispatch_refused',
} as const;

export const SYSTEM_STREAM = 'system';

const livenessSchema = z.enum(['spawning', 'running', 'dormant', 'interrupted', 'dead']);
export type Liveness = z.infer<typeof livenessSchema>;

const attentionReasonSchema = z.enum(['gate', 'question', 'completed', 'stale', 'quarantined']);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

// ——— payload schemas ———

export const sessionCreatedPayloadSchema = z.object({
  appSessionId: z.string(),
  channel: z.enum(['sdk', 'pty']),
  cwd: z.string(),
  name: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  taskRef: z
    .object({ taskId: z.string(), stage: z.string() })
    .nullable(),
});

export const livenessChangedPayloadSchema = z.object({
  appSessionId: z.string(),
  to: livenessSchema,
  cause: z.string(),
});

export const transitionRejectedPayloadSchema = z.object({
  appSessionId: z.string(),
  from: livenessSchema,
  to: livenessSchema,
  cause: z.string(),
});

export const gateFiredPayloadSchema = z.object({ appSessionId: z.string(), prompt: z.string() });
export const questionAskedPayloadSchema = z.object({ appSessionId: z.string(), prompt: z.string() });
export const runCompletedPayloadSchema = z.object({ appSessionId: z.string() });
export const watchdogStalePayloadSchema = z.object({ appSessionId: z.string() });
export const taskQuarantinedPayloadSchema = z.object({ appSessionId: z.string(), taskId: z.string() });

export const notificationTriggerPayloadSchema = z.object({
  appSessionId: z.string(),
  reason: attentionReasonSchema,
});

export const seenPayloadSchema = z.object({ appSessionId: z.string() });

export const attentionClearedPayloadSchema = z.object({
  appSessionId: z.string(),
  cause: z.enum(['gate_answered', 'dismissed', 'run_resumed']),
});

export const claudeSessionMappedPayloadSchema = z.object({
  appSessionId: z.string(),
  claudeSessionId: z.string(),
  jsonlPath: z.string(),
});

export const ttlTierObservedPayloadSchema = z.object({
  appSessionId: z.string(),
  tier: z.enum(['1h', '5m', 'mixed', 'unknown']),
});

export const billingBucketObservedPayloadSchema = z.object({
  appSessionId: z.string(),
  bucket: z.enum(['interactive', 'non-interactive', 'unknown']),
});

// Loose by design (rule 0.6): message bodies are stored inline (D12); role and
// content are not constrained beyond presence, and usage tolerates unknown
// upstream fields.
export const messagePayloadSchema = z.object({
  appSessionId: z.string(),
  role: z.string(),
  content: z.unknown(),
});

export const usageBlockPayloadSchema = z.object({
  appSessionId: z.string(),
  usage: z.object({}).passthrough(),
});

export const lineQuarantinedPayloadSchema = z.object({
  appSessionId: z.string(),
  raw: z.string(),
  reason: z.string(),
});

export const hostStartedPayloadSchema = z.object({}).passthrough();
export const hostStoppedPayloadSchema = z.object({}).passthrough();

// meter_threshold_crossed lives on the 'usage' stream; pct is the observed
// used/limit percentage at the crossing (0..100+). dispatch_refused lives on the
// 'tasks' stream; reason names why the dispatcher stub declined.
export const meterThresholdCrossedPayloadSchema = z.object({
  meterId: z.string(),
  pct: z.number(),
});
export const dispatchRefusedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});

export const EVENT_PAYLOAD_SCHEMAS = {
  [EVENT_TYPES.sessionCreated]: sessionCreatedPayloadSchema,
  [EVENT_TYPES.livenessChanged]: livenessChangedPayloadSchema,
  [EVENT_TYPES.transitionRejected]: transitionRejectedPayloadSchema,
  [EVENT_TYPES.gateFired]: gateFiredPayloadSchema,
  [EVENT_TYPES.questionAsked]: questionAskedPayloadSchema,
  [EVENT_TYPES.runCompleted]: runCompletedPayloadSchema,
  [EVENT_TYPES.watchdogStale]: watchdogStalePayloadSchema,
  [EVENT_TYPES.taskQuarantined]: taskQuarantinedPayloadSchema,
  [EVENT_TYPES.notificationTrigger]: notificationTriggerPayloadSchema,
  [EVENT_TYPES.seen]: seenPayloadSchema,
  [EVENT_TYPES.attentionCleared]: attentionClearedPayloadSchema,
  [EVENT_TYPES.claudeSessionMapped]: claudeSessionMappedPayloadSchema,
  [EVENT_TYPES.ttlTierObserved]: ttlTierObservedPayloadSchema,
  [EVENT_TYPES.billingBucketObserved]: billingBucketObservedPayloadSchema,
  [EVENT_TYPES.message]: messagePayloadSchema,
  [EVENT_TYPES.usageBlock]: usageBlockPayloadSchema,
  [EVENT_TYPES.lineQuarantined]: lineQuarantinedPayloadSchema,
  [EVENT_TYPES.hostStarted]: hostStartedPayloadSchema,
  [EVENT_TYPES.hostStopped]: hostStoppedPayloadSchema,
  [EVENT_TYPES.meterThresholdCrossed]: meterThresholdCrossedPayloadSchema,
  [EVENT_TYPES.dispatchRefused]: dispatchRefusedPayloadSchema,
} as const;

export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema>;
export type LivenessChangedPayload = z.infer<typeof livenessChangedPayloadSchema>;
export type TransitionRejectedPayload = z.infer<typeof transitionRejectedPayloadSchema>;
export type GateFiredPayload = z.infer<typeof gateFiredPayloadSchema>;
export type QuestionAskedPayload = z.infer<typeof questionAskedPayloadSchema>;
export type RunCompletedPayload = z.infer<typeof runCompletedPayloadSchema>;
export type WatchdogStalePayload = z.infer<typeof watchdogStalePayloadSchema>;
export type TaskQuarantinedPayload = z.infer<typeof taskQuarantinedPayloadSchema>;
export type NotificationTriggerPayload = z.infer<typeof notificationTriggerPayloadSchema>;
export type SeenPayload = z.infer<typeof seenPayloadSchema>;
export type AttentionClearedPayload = z.infer<typeof attentionClearedPayloadSchema>;
export type ClaudeSessionMappedPayload = z.infer<typeof claudeSessionMappedPayloadSchema>;
export type TtlTierObservedPayload = z.infer<typeof ttlTierObservedPayloadSchema>;
export type BillingBucketObservedPayload = z.infer<typeof billingBucketObservedPayloadSchema>;
export type MessagePayload = z.infer<typeof messagePayloadSchema>;
export type UsageBlockPayload = z.infer<typeof usageBlockPayloadSchema>;
export type LineQuarantinedPayload = z.infer<typeof lineQuarantinedPayloadSchema>;
export type MeterThresholdCrossedPayload = z.infer<typeof meterThresholdCrossedPayloadSchema>;
export type DispatchRefusedPayload = z.infer<typeof dispatchRefusedPayloadSchema>;

// Discriminated union over the vocabulary — the domain-event value space.
export type DomainEvent =
  | { type: typeof EVENT_TYPES.sessionCreated; payload: SessionCreatedPayload }
  | { type: typeof EVENT_TYPES.livenessChanged; payload: LivenessChangedPayload }
  | { type: typeof EVENT_TYPES.transitionRejected; payload: TransitionRejectedPayload }
  | { type: typeof EVENT_TYPES.gateFired; payload: GateFiredPayload }
  | { type: typeof EVENT_TYPES.questionAsked; payload: QuestionAskedPayload }
  | { type: typeof EVENT_TYPES.runCompleted; payload: RunCompletedPayload }
  | { type: typeof EVENT_TYPES.watchdogStale; payload: WatchdogStalePayload }
  | { type: typeof EVENT_TYPES.taskQuarantined; payload: TaskQuarantinedPayload }
  | { type: typeof EVENT_TYPES.notificationTrigger; payload: NotificationTriggerPayload }
  | { type: typeof EVENT_TYPES.seen; payload: SeenPayload }
  | { type: typeof EVENT_TYPES.attentionCleared; payload: AttentionClearedPayload }
  | { type: typeof EVENT_TYPES.claudeSessionMapped; payload: ClaudeSessionMappedPayload }
  | { type: typeof EVENT_TYPES.ttlTierObserved; payload: TtlTierObservedPayload }
  | { type: typeof EVENT_TYPES.billingBucketObserved; payload: BillingBucketObservedPayload }
  | { type: typeof EVENT_TYPES.message; payload: MessagePayload }
  | { type: typeof EVENT_TYPES.usageBlock; payload: UsageBlockPayload }
  | { type: typeof EVENT_TYPES.lineQuarantined; payload: LineQuarantinedPayload }
  | { type: typeof EVENT_TYPES.hostStarted; payload: Record<string, never> }
  | { type: typeof EVENT_TYPES.hostStopped; payload: Record<string, never> }
  | { type: typeof EVENT_TYPES.meterThresholdCrossed; payload: MeterThresholdCrossedPayload }
  | { type: typeof EVENT_TYPES.dispatchRefused; payload: DispatchRefusedPayload };

// Maps each attention-setting event type to the needsAttention reason it sets.
const ATTENTION_SETTER_REASON: Readonly<Record<string, AttentionReason>> = {
  [EVENT_TYPES.gateFired]: 'gate',
  [EVENT_TYPES.questionAsked]: 'question',
  [EVENT_TYPES.runCompleted]: 'completed',
  [EVENT_TYPES.watchdogStale]: 'stale',
  [EVENT_TYPES.taskQuarantined]: 'quarantined',
};

export const ATTENTION_SETTER_TYPES: ReadonlySet<string> = new Set(Object.keys(ATTENTION_SETTER_REASON));

export function attentionReasonForSetter(eventType: string): AttentionReason | null {
  return ATTENTION_SETTER_REASON[eventType] ?? null;
}

// ——— constructors (each returns a single EventInput) ———

export function sessionCreated(payload: SessionCreatedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.sessionCreated, payload };
}
export function livenessChanged(payload: LivenessChangedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.livenessChanged, payload };
}
export function transitionRejected(payload: TransitionRejectedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.transitionRejected, payload };
}
export function gateFired(payload: GateFiredPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.gateFired, payload };
}
export function questionAsked(payload: QuestionAskedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.questionAsked, payload };
}
export function runCompleted(payload: RunCompletedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.runCompleted, payload };
}
export function watchdogStale(payload: WatchdogStalePayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.watchdogStale, payload };
}
export function taskQuarantined(payload: TaskQuarantinedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.taskQuarantined, payload };
}
export function notificationTrigger(payload: NotificationTriggerPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.notificationTrigger, payload };
}
export function seen(payload: SeenPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.seen, payload };
}
export function attentionCleared(payload: AttentionClearedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.attentionCleared, payload };
}
export function claudeSessionMapped(payload: ClaudeSessionMappedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.claudeSessionMapped, payload };
}
export function ttlTierObserved(payload: TtlTierObservedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.ttlTierObserved, payload };
}
export function billingBucketObserved(payload: BillingBucketObservedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.billingBucketObserved, payload };
}
export function message(payload: MessagePayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.message, payload };
}
export function usageBlock(payload: UsageBlockPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.usageBlock, payload };
}
export function lineQuarantined(payload: LineQuarantinedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.lineQuarantined, payload };
}
export function hostStarted(): EventInput {
  return { stream: SYSTEM_STREAM, type: EVENT_TYPES.hostStarted, payload: {} };
}
export function hostStopped(): EventInput {
  return { stream: SYSTEM_STREAM, type: EVENT_TYPES.hostStopped, payload: {} };
}
// 'usage' matches meters' USAGE_STREAM; literal here keeps the vocabulary module
// free-standing (no dependency on the meters projection).
export function meterThresholdCrossed(payload: MeterThresholdCrossedPayload): EventInput {
  return { stream: 'usage', type: EVENT_TYPES.meterThresholdCrossed, payload };
}
export function dispatchRefused(payload: DispatchRefusedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.dispatchRefused, payload };
}

// The I5 batch rule (settled in step-2 review): an attention-setting event and
// its notification_trigger land adjacently in ONE append batch. Returns the pair
// so seq(trigger) === seq(setter)+1 on the same stream.
export function withNotificationTrigger(setterInput: EventInput): EventInput[] {
  const reason = attentionReasonForSetter(setterInput.type);
  if (reason === null) {
    throw new Error(
      `withNotificationTrigger: '${setterInput.type}' is not an attention-setting event`,
    );
  }
  const appSessionId = setterInput.stream;
  return [setterInput, notificationTrigger({ appSessionId, reason })];
}
