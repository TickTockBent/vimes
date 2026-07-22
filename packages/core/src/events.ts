import { z } from 'zod';
import type { EventInput } from './schemas.js';
import { meterRecordSchema, taskRecordSchema } from './schemas.js';
// The task-event payloads validate against the STATE MACHINE's own vocabulary
// (stages, refusal reasons, proposer) rather than re-declaring it — one source of
// record per fact (principle 9). Direction is events.ts → tasks/ → schemas.ts;
// the state machine imports nothing from here, so there is no cycle.
import {
  taskStageSchema,
  transitionProposedBySchema,
  transitionRejectionReasonSchema,
} from './tasks/taskStateMachine.js';

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
  //
  // **`meter_threshold_crossed` is DEPRECATED** (calibration.md 2026-07-21). It
  // and `meter_alert` both mean "a meter crossed a line" — two events for one
  // fact (principle 9) — and `meter_alert` is the real one: it carries the
  // window identity and the reserved disposition that suppression and slice-7's
  // brake need. Its ONLY producer was the slice-0 budget-wall profile, which no
  // longer emits it; nothing in core, the daemon or the UI produces it now.
  // The type, schema and factory are RETAINED (never deleted) so historical
  // events still validate, exactly as the deprecated `stale` field was retained.
  // DO NOT EMIT IT. Emit `meterAlert` instead.
  meterThresholdCrossed: 'meter_threshold_crossed',
  dispatchRefused: 'dispatch_refused',
  // Slice-2 hook ingress vocabulary (B). One event per observed hook (fixtures/
  // hooks, CLI 2.1.215); consumers beyond correlation arrive in later slices
  // (rule 0.5 — schema now). Emitted on the session's stream.
  hookSessionStart: 'hook_session_start',
  hookStop: 'hook_stop',
  hookStopFailure: 'hook_stop_failure',
  hookPreToolUse: 'hook_pre_tool_use',
  hookSessionEnd: 'hook_session_end',
  // Slice-2 runtime-drift (E4): boot-time CLI version observation, warn-only.
  runtimeDriftObserved: 'runtime_drift_observed',
  // Slice-2 custody vocabulary (D10). session_adopted flips custody host; the
  // `via` distinguishes explicit adoption from resume-through-VIMES.
  // session_renamed updates the display name (any custody). resync_marker is a
  // client-facing signal that a mirrored session's stream history predates the
  // event log (spec §3.2) — a projection no-op.
  sessionAdopted: 'session_adopted',
  sessionRenamed: 'session_renamed',
  resyncMarker: 'resync_marker',
  // Slice-2 push vocabulary (step 3). A delivery attempt outcome per subscription,
  // system-scoped. PRIVACY (log-is-forever): the subscription endpoint/keys NEVER
  // appear here — only the appSessionId, the attention reason that triggered the
  // push, and (on failure) the HTTP status. `reason` mirrors the notification
  // trigger's attention reason so a consumer can tell WHY the push was sent.
  pushSent: 'push_sent',
  pushFailed: 'push_failed',
  // Slice-5 step 4: an ACCOUNT-WIDE meter crossed a caller-supplied threshold.
  // Deliberately NOT `notification_trigger`: that payload is keyed to an
  // appSessionId and its D9 suppression answers "has the user already seen this
  // session's attention?". A meter threshold crossing belongs to no session, and
  // its suppression question is a different one — "have we already alerted for
  // this threshold in THIS window?". Forcing it into a session-shaped event
  // would either fabricate a session id or corrupt D9's semantics; one source of
  // record per fact (principle 9). Lives on the 'usage' stream beside
  // `meter_sample`.
  meterAlert: 'meter_alert',
  // Slice-5 D29: the delivery outcome of a meter-alert push, on the 'usage'
  // stream. Its sibling `push_sent`/`push_failed` are SESSION-scoped (they carry
  // an `appSessionId`), and a meter belongs to no session — so a meter alert used
  // to leave NO delivery trail at all. The consequence, felt live (calibration.md
  // 2026-07-21): when a meter push failed, the log could not even say whether the
  // push was ATTEMPTED. This event closes that gap without widening the
  // session-scoped payloads (rule 0.5). PRIVACY: like its siblings, it NEVER
  // carries the subscription endpoint or key material — only the meterId, whether
  // a send was attempted, and (when attempted) the outcome + any HTTP status.
  meterPushOutcome: 'meter_push_outcome',
  // Slice-6 step 1: the task vocabulary, on the 'tasks' stream beside the
  // already-reserved `dispatch_refused`. Rule 0.5 — the shapes land with the
  // state machine, ahead of the projection (step 2) and the dispatcher (step 3).
  //
  // `task_transition_rejected` is **I7's RECORD**. The invariant is not "the
  // machine returns a rejection", it is "the rejection is *evented*" — a
  // rejection nobody wrote down is, for I7's purposes, a rejection that never
  // happened. Every REJECT outcome from `proposeTransition` gets one of these.
  taskCreated: 'task_created',
  taskTransitioned: 'task_transitioned',
  taskTransitionRejected: 'task_transition_rejected',
  // Slice-6 step 4a: the link between a task and the session that runs one of
  // its stages. A stage run IS an ordinary session (spec §3.5) and
  // `TaskRecord.sessionRefs` was reserved in slice 0 to hold the link — but
  // until this event existed NOTHING appended to it, so "open this task's
  // session" had no data path. The dispatcher (packages/daemon/taskDispatcher)
  // emits exactly one of these per successful spawn.
  taskSessionAttached: 'task_session_attached',
} as const;

export const SYSTEM_STREAM = 'system';

const livenessSchema = z.enum(['spawning', 'running', 'dormant', 'interrupted', 'dead']);
export type Liveness = z.infer<typeof livenessSchema>;

// 'rate-limited' and 'brake' are reserved (rule 0.5): no setter emits them
// yet. 'rate-limited' lands with slice 5 (StopFailure/rate_limit_event
// signals); 'brake' lands with slice 7 (cascade guard/brakes layer). Widening
// here only extends the value space — ATTENTION_SETTER_REASON below still
// keys on setter event TYPES, so no existing setter starts emitting these.
const attentionReasonSchema = z.enum([
  'gate',
  'question',
  'completed',
  'stale',
  'quarantined',
  'rate-limited',
  'brake',
]);
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
  // D18 (E1): optional provider; the sessions projection defaults 'claude-code'
  // when absent, so old logs (session_created without this field) tolerate.
  provider: z.string().optional(),
  // D10: optional custody; the sessions projection defaults 'host' when absent,
  // so old session_created events (predating the field) project as host-owned.
  // Discovery mints external sessions by setting this to 'external'.
  custody: z.enum(['host', 'external']).optional(),
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

// requestId is optional (not required): harness profiles emit gate_fired
// without it, while the daemon's real SDK gate carries it so the phone can
// answer this exact gate (sessionHost.ts's handleGate). toolName/target are
// optional on the same footing (rule 0.5 — land the shape now): the daemon's
// real gate populates them from the SDK tool INPUT so the phone can headline
// WHICH tool + WHAT target is being gated (a path approved unread, smoke #4);
// harness profiles omit them, keeping the scenario double-run byte-identical.
export const gateFiredPayloadSchema = z.object({
  appSessionId: z.string(),
  prompt: z.string(),
  requestId: z.string().optional(),
  toolName: z.string().optional(),
  target: z.string().optional(),
});
export const questionAskedPayloadSchema = z.object({ appSessionId: z.string(), prompt: z.string() });
export const runCompletedPayloadSchema = z.object({ appSessionId: z.string() });
// ⚠ WIDENED IN SLICE 6 STEP 5b, OPTIONAL-only — the same widening discipline
// `taskCreatedPayloadSchema.gates` and `meterRecordSchema` document. Every
// `watchdog_stale` already written carries only `appSessionId`, still validates,
// and still folds to `needsAttention: 'stale'` byte-for-byte as before.
//
// **Why it had to widen: a staleness record that cannot explain itself is
// useless as evidence.** The pre-5b payload could say only "this session went
// stale" — not how stale, not which task, not how many times. Slice 6's named
// rule-0.1 finding is "the watchdog quarantines a HEALTHY run", and the
// investigation that finding earns is conducted out of the log: without these
// fields the log cannot answer "how long had it actually been silent?" or "was
// this the first episode or the fourth?".
export const watchdogStalePayloadSchema = z.object({
  appSessionId: z.string(),
  // Which task's stage run this session was. Optional because the watchdog is
  // the only writer that knows it, and older records predate the field.
  taskId: z.string().optional(),
  // The silence the DECISION measured (`assessStageRun`'s `observedSilenceMs`),
  // recorded verbatim rather than re-derived by a reader from timestamps that
  // may since have moved.
  observedSilenceMs: z.number().optional(),
  // Which stale EPISODE this is for the run, 1-based. Named `retryNumber` to
  // match the `assessStageRun` verdict field it copies verbatim — but read it as
  // "episode", not "attempt": the watchdog performs NO retries. Nothing nudges,
  // re-prompts or restarts a run; it observes silence and writes down what it saw.
  retryNumber: z.number().optional(),
  // ⟨CALIBRATION FIELD — the whole reason 5b exists in this shape⟩
  // TRUE when `assessStageRun` returned `quarantine` and **we deliberately did
  // not quarantine**. Rule 0.2: the retry ⟨tune⟩s (retries-before-quarantine,
  // backoff curve) have NO evidence behind them — S3 measured staleness, not
  // retry behaviour — so they may not drive a destructive action yet. This flag
  // is how the number gets earned: it is the column Wes reads when pricing
  // ⟨tune 3⟩, answering "how often WOULD we have quarantined, and would it have
  // been right?" against real work, before anything is allowed to act on it.
  wouldQuarantine: z.boolean().optional(),
});
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
  // D17 (E2): the SDK assistant message id this usage snapshot belongs to. One
  // turn emits several assistant messages with identical usage; messageId lets a
  // later consumer (slice 5) dedupe. Optional — harness/PTY paths omit it.
  messageId: z.string().optional(),
});

export const lineQuarantinedPayloadSchema = z.object({
  appSessionId: z.string(),
  raw: z.string(),
  reason: z.string(),
});

export const hostStartedPayloadSchema = z.object({}).passthrough();
export const hostStoppedPayloadSchema = z.object({}).passthrough();

// Hook ingress payloads (B). LOOSE by design (rule 0.6): the hook body is a
// fragile external surface (golden fixtures @ fixtures/hooks, CLI 2.1.215) — the
// named fields are the ones observed across the fixtures, everything else rides
// through passthrough. `appSessionId` is stamped by the ingress from the URL;
// the rest is the verbatim hook stdin body. All five hook events share this
// shape; per-event fields (e.g. StopFailure's reason/resetsAt) arrive via
// passthrough and are typed by their consumers when those land (later slices).
export const hookEventPayloadSchema = z
  .object({
    appSessionId: z.string(),
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();
export type HookEventPayload = z.infer<typeof hookEventPayloadSchema>;

// runtime_drift_observed (E4): observed CLI version at boot vs the (optional)
// pinned expectation. Warn-only, never gates. `expected` is null when unpinned;
// `observed` is null when the version probe could not read a version.
//
// `channel` names WHICH Claude Code binary was observed: 'pty' is the PATH
// `claude` (the escape hatch), 'sdk' is the binary the Agent SDK vendors and
// actually runs for every SDK session (the D4 default channel) — the two
// legitimately differ. `binaryPath` records the exact file observed, when known.
// Both are OPTIONAL: the log is append-only and drift events written before the
// channel split carry neither field, so they must keep validating.
export const runtimeDriftObservedPayloadSchema = z
  .object({
    expected: z.string().nullable(),
    observed: z.string().nullable(),
    channel: z.enum(['pty', 'sdk']).optional(),
    binaryPath: z.string().nullable().optional(),
  })
  .passthrough();
export type RuntimeDriftObservedPayload = z.infer<typeof runtimeDriftObservedPayloadSchema>;

// D10 custody-transition payloads. session_adopted flips custody to 'host'; `via`
// records whether adoption was an explicit action or a resume-through-VIMES.
export const sessionAdoptedPayloadSchema = z.object({
  appSessionId: z.string(),
  via: z.enum(['explicit', 'resume']),
});
export const sessionRenamedPayloadSchema = z.object({
  appSessionId: z.string(),
  name: z.string(),
});
// The single sanctioned resync reason (spec §3.2): a mirrored session whose
// early transcript predates the event log. Loose-tolerant of a future reason.
export const resyncMarkerPayloadSchema = z.object({
  appSessionId: z.string(),
  reason: z.enum(['pre-adoption-history']),
});

// Push delivery outcomes (system-scoped). `reason` is the attention reason that
// triggered the push (parallels notification_trigger). push_failed adds the HTTP
// statusCode when the push service returned one (404/410 → the daemon prunes the
// dead subscription). NO endpoint or key material is ever carried here.
export const pushSentPayloadSchema = z.object({
  appSessionId: z.string(),
  reason: attentionReasonSchema,
});
export const pushFailedPayloadSchema = z.object({
  appSessionId: z.string(),
  reason: attentionReasonSchema,
  statusCode: z.number().optional(),
});

// meter_threshold_crossed lives on the 'usage' stream; pct is the observed
// used/limit percentage at the crossing (0..100+). DEPRECATED — superseded by
// `meterAlertPayloadSchema` below; retained for historical events only (see the
// note on EVENT_TYPES.meterThresholdCrossed). dispatch_refused lives on the
// 'tasks' stream; reason names why the dispatcher stub declined.
export const meterThresholdCrossedPayloadSchema = z.object({
  meterId: z.string(),
  pct: z.number(),
});
export const dispatchRefusedPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});

// meter_alert (slice-5 step 4) — one account-wide meter crossed one threshold,
// on the 'usage' stream. Every field records what was OBSERVED at the crossing;
// nothing here is derived-and-stored (D26), and nothing here is a session.
//
// `disposition` is a RULE-0.5 SCHEMA RESERVATION (Wes, 2026-07-21). The
// prior-art mining found codor's brake semantics — work is HELD, not failed,
// with one-tap release from the phone — which is a better end state than a bare
// notification. Slice 7 owns that enforcement. The vocabulary is reserved now so
// slice 7 needs no migration: the field's type is the full 'notify' | 'hold'
// union, but **NOTHING IN SLICE 5 EVER SETS 'hold'** — exactly like the
// already-reserved `needsAttention: brake` (ratified 2026-07-20). If you are
// grepping for the code path that emits a hold, there isn't one yet, and that is
// deliberate.
export const meterAlertDispositionSchema = z.enum(['notify', 'hold']);
export const meterAlertPayloadSchema = z.object({
  meterId: z.string(),
  // WHICH threshold was crossed (a caller-supplied ⟨tune⟩ value — core never
  // pins one, rule 0.2).
  thresholdPercent: z.number(),
  // What we actually saw at the crossing, which is >= thresholdPercent and may
  // overshoot it by a lot when a poll jumps.
  observedPercent: z.number(),
  kind: meterRecordSchema.shape.kind,
  scope: z.string().nullable().optional(),
  // Identifies the WINDOW this alert belongs to: re-arming compares it.
  resetsAt: z.string().nullable().optional(),
  // The observation that triggered the alert (never `now` — rule 0.3).
  observedAt: z.string(),
  disposition: meterAlertDispositionSchema,
});

// meter_push_outcome (slice-5 D29) — the delivery outcome of ONE meter-alert push
// attempt, on the 'usage' stream. `attempted` is false ONLY when there was no
// subscription to send to (nobody to notify); when true, `outcome` records
// whether the push service accepted ('sent') or rejected ('failed') it, and
// `statusCode` carries the HTTP status the push service returned when it gave one
// (a 404/410 is the daemon's cue to prune the dead subscription). No endpoint or
// key material is ever carried here.
export const meterPushOutcomeResultSchema = z.enum(['sent', 'failed']);
export const meterPushOutcomePayloadSchema = z.object({
  meterId: z.string(),
  attempted: z.boolean(),
  // Present iff `attempted` is true.
  outcome: meterPushOutcomeResultSchema.optional(),
  // Present only when the push service returned an HTTP status.
  statusCode: z.number().optional(),
});

// ——— task payloads (slice-6 step 1), all on the 'tasks' stream ———
//
// task_created — the birth record. `isolation` is REQUIRED here rather than
// defaulted downstream: D32 pins the default to 'worktree', and a task whose
// isolation is only implied is a task whose worker directory nobody can audit
// after the fact. The creator names it; this event records what was named.
// `stage` is carried (rather than assumed `backlog`) so the projection folds a
// stated starting stage instead of re-deriving one.
//
// ⚠ WIDENED IN SLICE 6 STEP 4b with `gates`, OPTIONAL-only — the same widening
// discipline `meterRecordSchema` documents. Every `task_created` already written
// omits the field, still validates, and still serializes to the same bytes.
//
// The gap this closes: `taskRecordSchema.gates` has existed since slice 0 and the
// projection defaults it to `{}`, but until now NO EVENT COULD EVER SET IT. That
// made `requireHeadroom` / `deferUntilReset` unreachable in production and I10's
// entire refusal path test-only — a gate nobody could ever ask for. The creator
// names the gates; this event records what was named (rule 0.5: the data shape
// lands with its consumer, which is the task API in this same step).
export const taskCreatedPayloadSchema = z.object({
  taskId: z.string(),
  projectRoot: z.string(),
  createdBy: taskRecordSchema.shape.createdBy,
  isolation: taskRecordSchema.shape.isolation,
  stage: taskStageSchema,
  gates: taskRecordSchema.shape.gates.optional(),
});

// task_transitioned — one ACCEPTED transition, exactly as the state machine
// decided it. `manualReviewRequired` is the RESULTING flag (the convergence
// exit), not the proposal's request: the machine only honours it into `done`, so
// recording the result keeps the log and the projection from disagreeing.
export const taskTransitionedPayloadSchema = z.object({
  taskId: z.string(),
  fromStage: taskStageSchema,
  toStage: taskStageSchema,
  manualReviewRequired: z.boolean(),
  proposedBy: transitionProposedBySchema,
  note: z.string().optional(),
});

// task_transition_rejected — I7's record. Carries the ATTEMPTED edge (both ends)
// and the enumerated reason, so a reviewer can tell a quarantined run that tried
// to complete apart from a plain typo, without re-running anything.
// `attemptedToStage` is named distinctly from `toStage` precisely because NO
// transition happened — the task is still in `fromStage`.
//
// ⚠ Both stage fields are deliberately `z.string()` and NOT `taskStageSchema`,
// unlike the accepted event above. The whole point of this event is to record
// what the machine REFUSED, and one of the refusals is `unknown-stage` — a stage
// outside the enum. Validating these against the enum would make exactly that
// rejection unrecordable, which is I7 failing silently in the one case (slice 7's
// hostile input) where the record matters most. An accepted transition is within
// the vocabulary by construction; a rejected one is not.
export const taskTransitionRejectedPayloadSchema = z.object({
  taskId: z.string(),
  fromStage: z.string(),
  attemptedToStage: z.string(),
  reason: transitionRejectionReasonSchema,
  proposedBy: transitionProposedBySchema,
});

// task_session_attached — one stage run, linked to its task. Emitted by the
// dispatcher AFTER the session host has actually returned an `appSessionId`, so
// this event is a record of a session that EXISTS, never of one that was
// attempted (a refused spawn emits nothing here — the host already evented its
// own refusal, and inventing a task-side record of a session that never spawned
// would put a dangling ref on the board).
//
// ⚠ `stage` is deliberately `z.string()` rather than `taskStageSchema`, matching
// BOTH shapes this event bridges: `taskRecordSchema.sessionRefs[].stage` (the
// slice-0 frozen record it folds into) and `sessionCreatedPayloadSchema.taskRef
// .stage`. A ref is a LABEL of which stage ran, not an authority over stage —
// `task_transitioned` is that authority (principle 9) — so narrowing it here
// would put a second, stricter vocabulary on a field the record it feeds keeps
// loose, and the fold would start dropping refs the schema itself accepts.
export const taskSessionAttachedPayloadSchema = z.object({
  taskId: z.string(),
  stage: z.string(),
  appSessionId: z.string(),
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
  [EVENT_TYPES.hookSessionStart]: hookEventPayloadSchema,
  [EVENT_TYPES.hookStop]: hookEventPayloadSchema,
  [EVENT_TYPES.hookStopFailure]: hookEventPayloadSchema,
  [EVENT_TYPES.hookPreToolUse]: hookEventPayloadSchema,
  [EVENT_TYPES.hookSessionEnd]: hookEventPayloadSchema,
  [EVENT_TYPES.runtimeDriftObserved]: runtimeDriftObservedPayloadSchema,
  [EVENT_TYPES.sessionAdopted]: sessionAdoptedPayloadSchema,
  [EVENT_TYPES.sessionRenamed]: sessionRenamedPayloadSchema,
  [EVENT_TYPES.resyncMarker]: resyncMarkerPayloadSchema,
  [EVENT_TYPES.pushSent]: pushSentPayloadSchema,
  [EVENT_TYPES.pushFailed]: pushFailedPayloadSchema,
  [EVENT_TYPES.meterAlert]: meterAlertPayloadSchema,
  [EVENT_TYPES.meterPushOutcome]: meterPushOutcomePayloadSchema,
  [EVENT_TYPES.taskCreated]: taskCreatedPayloadSchema,
  [EVENT_TYPES.taskTransitioned]: taskTransitionedPayloadSchema,
  [EVENT_TYPES.taskTransitionRejected]: taskTransitionRejectedPayloadSchema,
  [EVENT_TYPES.taskSessionAttached]: taskSessionAttachedPayloadSchema,
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
export type SessionAdoptedPayload = z.infer<typeof sessionAdoptedPayloadSchema>;
export type SessionRenamedPayload = z.infer<typeof sessionRenamedPayloadSchema>;
export type ResyncMarkerPayload = z.infer<typeof resyncMarkerPayloadSchema>;
export type PushSentPayload = z.infer<typeof pushSentPayloadSchema>;
export type PushFailedPayload = z.infer<typeof pushFailedPayloadSchema>;
export type MeterAlertPayload = z.infer<typeof meterAlertPayloadSchema>;
export type MeterAlertDisposition = z.infer<typeof meterAlertDispositionSchema>;
export type MeterPushOutcomePayload = z.infer<typeof meterPushOutcomePayloadSchema>;
export type MeterPushOutcomeResult = z.infer<typeof meterPushOutcomeResultSchema>;
export type TaskCreatedPayload = z.infer<typeof taskCreatedPayloadSchema>;
export type TaskTransitionedPayload = z.infer<typeof taskTransitionedPayloadSchema>;
export type TaskTransitionRejectedPayload = z.infer<typeof taskTransitionRejectedPayloadSchema>;
export type TaskSessionAttachedPayload = z.infer<typeof taskSessionAttachedPayloadSchema>;

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
  | { type: typeof EVENT_TYPES.dispatchRefused; payload: DispatchRefusedPayload }
  | { type: typeof EVENT_TYPES.hookSessionStart; payload: HookEventPayload }
  | { type: typeof EVENT_TYPES.hookStop; payload: HookEventPayload }
  | { type: typeof EVENT_TYPES.hookStopFailure; payload: HookEventPayload }
  | { type: typeof EVENT_TYPES.hookPreToolUse; payload: HookEventPayload }
  | { type: typeof EVENT_TYPES.hookSessionEnd; payload: HookEventPayload }
  | { type: typeof EVENT_TYPES.runtimeDriftObserved; payload: RuntimeDriftObservedPayload }
  | { type: typeof EVENT_TYPES.sessionAdopted; payload: SessionAdoptedPayload }
  | { type: typeof EVENT_TYPES.sessionRenamed; payload: SessionRenamedPayload }
  | { type: typeof EVENT_TYPES.resyncMarker; payload: ResyncMarkerPayload }
  | { type: typeof EVENT_TYPES.pushSent; payload: PushSentPayload }
  | { type: typeof EVENT_TYPES.pushFailed; payload: PushFailedPayload }
  | { type: typeof EVENT_TYPES.meterAlert; payload: MeterAlertPayload }
  | { type: typeof EVENT_TYPES.meterPushOutcome; payload: MeterPushOutcomePayload }
  | { type: typeof EVENT_TYPES.taskCreated; payload: TaskCreatedPayload }
  | { type: typeof EVENT_TYPES.taskTransitioned; payload: TaskTransitionedPayload }
  | { type: typeof EVENT_TYPES.taskTransitionRejected; payload: TaskTransitionRejectedPayload }
  | { type: typeof EVENT_TYPES.taskSessionAttached; payload: TaskSessionAttachedPayload };

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
//
// @deprecated Use `meterAlert`. Retained so historical `meter_threshold_crossed`
// records still validate; it has no producer anywhere in the codebase.
export function meterThresholdCrossed(payload: MeterThresholdCrossedPayload): EventInput {
  return { stream: 'usage', type: EVENT_TYPES.meterThresholdCrossed, payload };
}

// Mirrors `meterSample()` (projections/meters.ts): same 'usage' stream, literal
// here for the same reason — the vocabulary module stays free-standing.
export const METER_ALERT_TYPE = EVENT_TYPES.meterAlert;
export function meterAlert(payload: MeterAlertPayload): EventInput {
  return { stream: 'usage', type: EVENT_TYPES.meterAlert, payload };
}
// Same 'usage' stream as `meter_alert` and `meter_sample`; literal for the same
// reason (the vocabulary module stays free-standing).
export function meterPushOutcome(payload: MeterPushOutcomePayload): EventInput {
  return { stream: 'usage', type: EVENT_TYPES.meterPushOutcome, payload };
}
export function dispatchRefused(payload: DispatchRefusedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.dispatchRefused, payload };
}

// The slice-6 task constructors. Same 'tasks' stream as `dispatch_refused`,
// literal for the same reason the meter constructors use a literal 'usage': the
// vocabulary module stays free-standing (no dependency on a projection).
export function taskCreated(payload: TaskCreatedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskCreated, payload };
}
export function taskTransitioned(payload: TaskTransitionedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskTransitioned, payload };
}
// I7's record — emitted for EVERY rejected proposal, never conditionally.
export function taskTransitionRejected(payload: TaskTransitionRejectedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskTransitionRejected, payload };
}
// The task↔session link (step 4a). On the 'tasks' stream and NOT the session's
// stream: it is a fact about the TASK's record (`sessionRefs`), and the tasks
// projection folds only its own stream. The session's own birth record
// (`session_created`) already lives on the session stream.
export function taskSessionAttached(payload: TaskSessionAttachedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskSessionAttached, payload };
}

// Hook ingress constructors (B). Each emits on the session's stream; the ingress
// has already stamped appSessionId onto the (loose) hook body.
export function hookSessionStart(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookSessionStart, payload };
}
export function hookStop(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookStop, payload };
}
export function hookStopFailure(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookStopFailure, payload };
}
export function hookPreToolUse(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookPreToolUse, payload };
}
export function hookSessionEnd(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookSessionEnd, payload };
}
// System-scoped (E4): boot-time observation, not tied to a session.
export function runtimeDriftObserved(payload: RuntimeDriftObservedPayload): EventInput {
  return { stream: SYSTEM_STREAM, type: EVENT_TYPES.runtimeDriftObserved, payload };
}
// Push delivery outcomes (system-scoped). Endpoints are never in the payload.
export function pushSent(payload: PushSentPayload): EventInput {
  return { stream: SYSTEM_STREAM, type: EVENT_TYPES.pushSent, payload };
}
export function pushFailed(payload: PushFailedPayload): EventInput {
  return { stream: SYSTEM_STREAM, type: EVENT_TYPES.pushFailed, payload };
}
// D10 custody transitions — each on the session's stream.
export function sessionAdopted(payload: SessionAdoptedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.sessionAdopted, payload };
}
export function sessionRenamed(payload: SessionRenamedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.sessionRenamed, payload };
}
export function resyncMarker(payload: ResyncMarkerPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.resyncMarker, payload };
}

// The observed Claude `hook_event_name` → VIMES constructor map (fragile-adapter
// boundary, rule 0.6 — the ONE place the CLI's event names are named). The
// ingress uses this to route a validated hook body; an unrecognized name has no
// entry and is quarantined by the caller rather than crashing.
export const HOOK_EVENT_CONSTRUCTORS: Readonly<
  Record<string, (payload: HookEventPayload) => EventInput>
> = {
  SessionStart: hookSessionStart,
  Stop: hookStop,
  StopFailure: hookStopFailure,
  PreToolUse: hookPreToolUse,
  SessionEnd: hookSessionEnd,
};

// The five hook event names registered in an injected per-session settings file.
export const REGISTERED_HOOK_EVENT_NAMES: readonly string[] = Object.keys(HOOK_EVENT_CONSTRUCTORS);

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
