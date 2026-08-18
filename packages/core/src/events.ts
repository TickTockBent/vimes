import { z } from 'zod';
import type { EventInput } from './schemas.js';
import {
  meterRecordSchema,
  projectRecordSchema,
  sessionRecordSchema,
  taskRecordSchema,
} from './schemas.js';
// The task-event payloads validate against the STATE MACHINE's own vocabulary
// (stages, refusal reasons, proposer) rather than re-declaring it — one source of
// record per fact (principle 9). Direction is events.ts → tasks/ → schemas.ts;
// the state machine imports nothing from here, so there is no cycle.
import {
  taskStageSchema,
  transitionProposedBySchema,
  transitionRejectionReasonSchema,
} from './tasks/taskStateMachine.js';
// S7·5a: `plan_submitted`'s payload REUSES the reserved `submit_plan` MCP tool
// payload (D48) rather than re-declaring a shape that would inevitably drift
// from it — one source of record per fact (principle 9), the same discipline
// the header comment above documents for the state-machine imports. Direction
// is events.ts -> tasks/workOrder.ts -> schemas.ts; that module imports nothing
// from here, so there is no cycle.
import { submitPlanPayloadSchema, type SubmitPlanPayload } from './tasks/workOrder.js';
// S7·6a: `review_reported`'s payload REUSES the reserved `report_review` MCP tool
// payload (D43) and `completion_reported`'s the reserved `report_completion` payload,
// exactly as `plan_submitted` reuses `submit_plan` — one source of record per fact
// (principle 9).
//
// ⚠ Both schemas LIVE IN `schemas.ts` as of S7·7b (D52 finding 1 — they type
// `taskRecordSchema.lastReview`/`.lastCompletion`, so the leaf had to own them);
// `tasks/workOrder.ts` re-exports them, and this import path is deliberately
// unchanged so the hoist stayed invisible to every consumer.
import {
  reportReviewPayloadSchema,
  type ReportReviewPayload,
  reportCompletionPayloadSchema,
  type ReportCompletionPayload,
} from './tasks/workOrder.js';

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
  // ⚠ THE SIXTH HOOK, ADDED IN S8·4 (D64) — and the ONLY one the ingress ANSWERS
  // rather than merely records. PreCompact is the compaction DOOR: the relay
  // translates the ingress's answer into the hook's exit code, because exit 2 is
  // the sole veto channel the CLI honors (a JSON `decision:"block"` is accepted,
  // logged as success, and silently ignored — OBSERVED SP8·1 Q3b, re-verified on
  // CLI 2.1.221 at the S8·4 step-0 gate). Registering it here is what puts it in
  // `REGISTERED_HOOK_EVENT_NAMES`, i.e. in the injected settings file, and what
  // lets `ingestHook` route it instead of quarantining it as an unknown name.
  hookPreCompact: 'hook_pre_compact',
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
  // happened. Every REJECT decision the adjudicator returns
  // (`extensions/proposeMove.ts`, reading the workflow declaration) gets one of
  // these.
  //
  // ⚠ **THE WHOLE TASK FAMILY BELOW IS RETIRED AS OF S11 (D72 Move 2).** Each
  // kind keeps its type, schema and constructor FOREVER — the precedent
  // `meter_threshold_crossed` set above, for the same reason: the log is
  // append-only, and history has to keep validating. What changed is the WRITE
  // side: nothing in production emits one after S11·U2, and the reducer reads
  // them through `RETIRED_EVENT_KINDS` (below) into their generic siblings.
  // DO NOT EMIT THEM. The siblings are, in order:
  //   task_created             -> instance_created
  //   task_transitioned        -> instance_moved
  //   task_transition_rejected -> instance_move_rejected
  //   task_session_attached    -> instance_run_attached
  //   work_order_amended       -> instance_payload_revised
  //   plan_submitted           -> capture_recorded
  //   review_reported          -> report_filed (reportKind: 'review')
  //   completion_reported      -> report_filed (reportKind: 'completion')
  // `task_worktree_created`, `task_quarantined` and `dispatch_refused` are NOT
  // retired — this slice does not rename kinds whose consumers it has not moved.
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
  // Slice-6 step 8: a task's ISOLATED WORKTREE was created, on the 'tasks' stream.
  //
  // This event is **THE CALIBRATION RECORD FOR D32's UNMEASURED AXIS**, and that is
  // its primary job rather than a side effect. D32 chose worktree isolation on a
  // known benefit against an *unmeasured cost* and said so in as many words: spike
  // S2 "says nothing about … what worktree isolation COSTS in setup time, disk, and
  // git overhead", and asked step 8 to "measure worktree setup cost as it lands".
  // `setupMs` is that measurement, taken from the manager's injected clock, so the
  // cost can be priced against real work from the log rather than re-measured by
  // hand later. It plays exactly the role `wouldQuarantine` plays for the retry
  // ⟨tune⟩s: a column that makes a future decision cheap and evidenced.
  //
  // ⚠ EMITTED ONLY WHEN A WORKTREE WAS ACTUALLY CREATED. `ensureWorktree` is
  // idempotent, and a re-dispatch that REUSES an existing worktree creates nothing —
  // eventing "created" there would be a false fact in an append-only log, and it
  // would also poison the setup-cost column with near-zero readings that measure a
  // `git worktree list` rather than a checkout.
  taskWorktreeCreated: 'task_worktree_created',
  // Slice-6 step 6a: COURSE CORRECTION, on the SESSION stream. D5 settled the
  // mechanism (steer = inject into the live streaming-input queue; `interrupt()`
  // is the hard stop, not the fallback), so these two events are the SEMANTICS
  // and the EVIDENCE, not new plumbing.
  //
  // They are deliberately TWO events for two different facts (principle 9), and
  // the gap between them is the whole point: D5 measured a correction sitting in
  // the queue for **30.4 s** against a 40 s tool, with an UNBOUNDED worst case (a
  // long build or test suite), because delivery is bounded by the NEXT MODEL
  // CALL and injection does not preempt an in-flight tool.
  //
  //   • `correction_queued`    — VIMES accepted it and handed it to the queue.
  //                              WE are the author; emitted at the send boundary.
  //   • `correction_delivered` — the CLI actually delivered it, OBSERVED in the
  //                              transcript (rule 0.7: observed truth, never
  //                              declared). We are not the author of this fact;
  //                              we are the witness.
  //
  // Without the pair, the watchdog reads a healthy steered run as stale (D30
  // says explicitly that a queued-but-undelivered correction is NOT staleness)
  // and pushes a notification to a real person's phone about work that is fine.
  correctionQueued: 'correction_queued',
  correctionDelivered: 'correction_delivered',
  // Slice-7 D43: a work order was AMENDED — a scope/acceptance/kill-criterion
  // change, recorded as an APPENDED event (I12) that bumps `workOrderRev`,
  // never a mutation of the existing record. It landed in S7·1 as a RULE-0.5
  // RESERVATION (type + schema + constructor, deliberately no emitter),
  // following the precedent `dispatch_refused` set (reserved slice 0, emitted
  // slice 6) and the `meterAlert` `disposition: 'hold'` reservation.
  //
  // **S7·2b SPENT THE RESERVATION AND LANDED THE EMITTER:
  // `TaskWriter.amendWorkOrder` (packages/daemon — the SOLE writer of task
  // state, I7), reached over HTTP by the amend-work-order route (the deprecated
  // task-alias spelling through S13·U3, `POST /api/instances/:instanceId/
  // payload-revisions` since).** The grep that used to come up empty now lands
  // there, and the instance store folds the patch onto the record. D46's
  // second correction door is this event.
  //
  // ⚠ **RETIRED BY S11 (D72 Move 2).** Its generic sibling is
  // `instance_payload_revised`; this kind keeps its type, schema and constructor
  // forever so history still validates, and `RETIRED_EVENT_KINDS` adapts it on
  // the way into the fold. DO NOT EMIT IT.
  workOrderAmended: 'work_order_amended',
  // Slice-7 D48: a plan crossed the tool boundary. RESERVED, no emitter yet
  // (S7·5b — the daemon's SDK adapter — intercepts `ExitPlanMode` and emits
  // exactly one of these per submitted plan), following the same posture as
  // `dispatch_refused` (schema landed slice 0, emitted slice 6) and
  // `work_order_amended` just above.
  //
  // Like `task_session_attached`, this AUGMENTS the task record — it folds
  // `planArtifactHash` onto it — and is deliberately NOT a stage transition.
  // The planning -> plan-ready move is a separate `task_transitioned`, emitted
  // by the dispatcher (S7·5b) once it has observed the plan submission; folding
  // a stage change in HERE as well would let the record disagree with itself
  // about which event is the authority for stage (principle 9).
  planSubmitted: 'plan_submitted',
  // Slice-7 S7·6a: a captured independent REVIEW crossed the tool boundary — the
  // reviewer's per-criterion pass/fail verdict, recorded as an event. RESERVED, no
  // emitter yet (S7·6b — the daemon's SDK adapter — registers the `report_review`
  // MCP tool and emits exactly one of these per captured review), same posture as
  // `plan_submitted` above. It is the durable RECORD of the verdict and is
  // deliberately NOT a stage transition: the review -> done / review -> implementing
  // move is a SEPARATE `task_transitioned` the dispatcher emits (S7·6b) after
  // deriving the target via `deriveReviewOutcome` (tasks/reviewOutcome.ts) directly
  // from this event's payload. Folding a stage change in here too would give the
  // record two authorities over its own stage (principle 9). It DOES fold as of
  // S7·7b: the fold writes the payload onto `lastReview` (latest-wins), which is
  // the fix-seed the next implementer's briefing renders.
  //
  // ⚠ **RETIRED BY S11 (D72 Move 2)** — absorbed by `report_filed`
  // (`reportKind: 'review'`). Retained for history; DO NOT EMIT IT.
  reviewReported: 'review_reported',
  // Slice-7 S7·7b: the worklog FIX-SEED (D46). Folds onto `TaskRecord.lastCompletion`
  // (latest-wins), the sibling of `lastReview` above — together they are the two
  // halves of what a FRESH fixer needs that the diff on disk cannot give it (D53's
  // rider: the diff is read from disk, the feedback and the dead ends are carried).
  // ⚠ STILL NO EMITTER as of S7·7b-core: the `report_completion` tool that writes
  // one is 7b-daemon's job, and `implementing → review` on capture is D53's outcome
  // rule. The constructor below is real; the caller is the next unit.
  completionReported: 'completion_reported',
  // ── S8·1 D42: the PROJECT REGISTRY vocabulary, on the 'projects' stream ─────
  //
  // The first stream in the vocabulary that belongs to no session and no task. A
  // project is a **DECLARED** boundary — the directory a human picked in the
  // picker — and D42 makes the registry EVENT-SOURCED rather than config for the
  // reason rule 0.3/I12 always give: it is created at runtime, it carries mutable
  // metadata, and it has a lifecycle. Config would have made every one of those a
  // file edit plus a restart.
  //
  // ⚠ **DECLARATION IS FENCED BY `VIMES_PROJECT_ROOTS` (D60).** Declaring a
  // project does NOT widen the file/git allow-list; the picker may only name
  // directories inside the STATIC config roots, checked at the ROUTE
  // (packages/daemon/src/projectApi.ts) before any of these events is written.
  // The vocabulary itself holds no path policy — it records what was declared.
  //
  // ⚠ **NOTHING HERE IS EVER STAMPED ONTO ANOTHER EVENT.** D42's attribution is a
  // READ-TIME derivation over cwd (`projectForCwd`, projections/projects.ts), so
  // no session, cost row or task gains a `projectId` field: declaring a project
  // retroactively scopes its whole history for free, and that only works because
  // nothing was ever stamped.
  projectCreated: 'project_created',
  projectUpdated: 'project_updated',
  projectArchived: 'project_archived',
  // ⚠ **RESERVED (rule 0.5) — NOTHING EMITS THIS.** D42 reserves the shape for
  // the project ONBOARDING HOOK (`design-directions.md` → "Project onboarding"),
  // whose workflow is deliberately built when it has a consumer and not before.
  // The posture is `work_order_amended`'s before S7·2b, verbatim: type + payload
  // schema + constructor land now, the emitter lands with the feature. If you are
  // grepping for the code path that writes one of these, there isn't one, and
  // that is the point — see the constructor's own note at the bottom of this file.
  projectInitialized: 'project_initialized',
  // ── S8·4a: compaction visibility, on the SESSION's own stream ──────────────
  //
  // A `/compact` OBSERVED in either of the two ingestion paths — the transcript
  // mapper's `compact_boundary` system record (packages/core/src/transcript/
  // mapper.ts) or the SDK stream's `system`/`compact_boundary` message
  // (packages/daemon/src/sessionHost.ts). Exactly one event per observed
  // boundary: the tailer SKIPS any jsonl `markSdkJsonl` has marked
  // (packages/daemon/src/tailer.ts's `skipPaths`, set from sessionHost.ts's
  // `system`/`init` handling) — one source of record per compaction (principle
  // 9), so an SDK-spawned session's boundary is never double-ingested by the
  // transcript path too.
  //
  // Like `correction_delivered`, we are the WITNESS of this fact, not its
  // author — every field is evidence copied off the CLI's own record, never
  // something VIMES decided. Fixtures for both paths are real SP8·1 spike
  // captures: scratchpad/sp8-1-evidence/logs/q6-after-compact.jsonl (the
  // transcript, camelCase `compactMetadata`) and q1b-stream.jsonl (the SDK
  // stream, snake_case `compact_metadata`) — two casings for one fact, the
  // CLI's own inconsistency, each path reads its own verbatim.
  compactionObserved: 'compaction_observed',
  // ── S8·4 (D64): the transcript lifecycle's two facts, both session-scoped ──
  //
  // `compaction_nudge_sent` is VIMES's OWN decision (unlike its S8·4a neighbour,
  // where we are only the witness): the daemon steward crossed a ⟨tune⟩ threshold
  // and injected an escalating capture nudge into the orchestrator's transcript.
  // It doubles as the escalation MEMORY — folded back by
  // `rememberCompactionNudge` so a level fires once per transcript-epoch and a
  // daemon restart re-derives exactly the escalation state it had.
  //
  // `compaction_held` records the other half: the PreCompact hook's answer came
  // back `hold`, so a compaction was vetoed (exit 2 — the ONLY veto channel the
  // CLI honors, OBSERVED at SP8·1 and re-verified on 2.1.221). Allows are NOT
  // evented; see the payload schema for why.
  compactionNudgeSent: 'compaction_nudge_sent',
  compactionHeld: 'compaction_held',
  // ── S9·1 — the session-tree spine (architecture.md E2), on the 'nodes' stream ─
  //
  // ⚠ **RESERVED (rule 0.5) — NOTHING EMITS THESE.** The tree is the one new
  // engine primitive E2 settles: sessions live in a FOREST rooted in D42
  // projects, not a flat list. The vocabulary lands now — type + payload schema +
  // constructor + the two projections that read it back — and the daemon wiring,
  // the API and the clients land with their consumers (D11, first-consumer rule).
  // Same posture as `project_initialized` and `work_order_amended` before S7·2b.
  //
  // THREE events, and the shape of the set is itself the decision (E2, walked
  // 2026-08-05):
  //
  // - `node_created` — ONE node kind (E2-a), worktree-ness carried as a nullable
  //   `provenance` PROPERTY rather than a second identity. Provenance is
  //   WRITE-ONCE-AT-CREATION: `null` stays `null` forever, and "converting" a
  //   group to a checkout means creating a worktree CHILD under it. That closes
  //   the mutation loophole while keeping one table and one event family.
  // - `node_closed` — closure is TREE-state, axis 1 of E2's three orthogonal
  //   axes. It kills no process (axis 2) and removes nothing on disk (axis 3);
  //   every cross-axis act is its own explicit event, so nothing here may ever
  //   grow a "and also kill/remove" clause.
  // - `session_attached_to_node` — the one-parent-per-session link.
  //
  // ⚠ **THERE IS NO `node_moved`, AND ITS ABSENCE IS THE DESIGN.** E2 bans moves
  // in v1: the forest invariant (no cycles, no orphans) is trivially preserved
  // while nothing is ever re-parented, and provenance-bearing nodes make
  // cross-project moves genuinely weird — the disk path divorces from the tree
  // position. Adding one is a D-record somebody has to write, not a widening.
  nodeCreated: 'node_created',
  nodeClosed: 'node_closed',
  sessionAttachedToNode: 'session_attached_to_node',
  // ── S17·U1 — checkout_removed, a NODES-STREAM AUDIT FACT (slice-17.md §1) ──
  //
  // ⚠ **NOT A FOURTH MEMBER OF THE S9·1 SET ABOVE — that set is still exactly
  // three, and the test that pins it stays green.** `checkout_removed` records
  // that a checkout's DISK was actually removed; it is orthogonal to
  // `node_closed`'s TREE fact, same three-axis discipline the S9·1 note above
  // states. RESERVED (rule 0.5): the schema lands so the event validates and
  // constructs, but the FOLD is DEFERRED to its first consumer (a later,
  // deliberate nodes-projection bump, D86) — see the payload schema's docblock.
  checkoutRemoved: 'checkout_removed',
  // ── S11 (D72 Move 2) — THE GENERIC INSTANCE VOCABULARY ─────────────────────
  //
  // The task family above, re-spelled in the engine's own words (node-kit §1.7):
  // an INSTANCE of a workflow sitting on a NODE, with a tenant-shaped PAYLOAD the
  // engine never reads to decide anything. The seven kinds here absorb the seven
  // the old tasks reducer folded, and `RETIRED_EVENT_KINDS` (below, beside the
  // payload schemas) maps each retired spelling to its sibling here so recorded
  // history replays without being rewritten.
  //
  // ⚠ **SAME `'tasks'` STREAM — the stream name is NOT part of this rename.**
  // The stream is persisted state: (stream, seq) contiguity and the deployed
  // UI's re-read trigger both live on it, so generic kinds append to the stream
  // that already exists (slice-11.md, "The persisted stream stays 'tasks'").
  // Per-workflow stream naming is a decision for the day a second workflow
  // exists, not a side effect of a vocabulary move.
  //
  // ⚠ `report_filed` absorbs BOTH `review_reported` and `completion_reported`,
  // discriminated in the payload by `reportKind`, and `capture_recorded`
  // absorbs `plan_submitted` with `captureKind` drawn from the engine's closed
  // capture catalogue (`CAPTURE_CATALOGUE` in extensions/manifest.ts, whose one
  // v1 entry is 'plan'). Two events for one fact would be principle 9 all over
  // again; the discriminator is what keeps the catalogue extendable without a
  // new kind per entry.
  instanceCreated: 'instance_created',
  instanceMoved: 'instance_moved',
  instanceMoveRejected: 'instance_move_rejected',
  instancePayloadRevised: 'instance_payload_revised',
  instanceRunAttached: 'instance_run_attached',
  reportFiled: 'report_filed',
  captureRecorded: 'capture_recorded',
} as const;

export const SYSTEM_STREAM = 'system';

// The tree's own stream, beside SYSTEM_STREAM: the forest is ENGINE STATE, not
// display sugar (E2), and it is scoped to no single session — so it gets a
// system-adjacent stream of its own rather than riding a session's. Same shape
// of decision as the 'projects' and 'tasks' streams its neighbours use, spelled
// as a constant here because the tree projections are the only readers.
export const NODES_STREAM = 'nodes';

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
  // ⚠ WIDENED IN S8·3 with `orchestratorForProjectId`, OPTIONAL-only — the same
  // widening discipline `taskCreatedPayloadSchema.title` documents. Every
  // `session_created` already written omits it, still validates, and still folds
  // to a byte-identical SessionRecord (I6).
  //
  // D56: the STANDING ORCHESTRATOR for one project. **Presence IS the kind** —
  // there is deliberately no separate `kind: 'orchestrator'` field, because a
  // kind that did not name its project would let two facts (this is an
  // orchestrator / this is whose orchestrator) drift apart, and the singleton
  // invariant is stated over the pairing of the two. Derived from the record's
  // own field so the event and the record cannot drift on the shape.
  orchestratorForProjectId: sessionRecordSchema.shape.orchestratorForProjectId,
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
// D68: the structured question payload an AskUserQuestion gate carries. A single
// AskUserQuestion tool call presents 1–4 questions, each single- or multi-select,
// each with its own options. `options.title` is UNDEFINED for this tool, so the
// question TEXT is the real prompt; `header` is a short label the SDK also sends.
// These schemas exist so the option structure survives the typed layers to the UI
// instead of collapsing into the binary allow/deny gate. Kept OPTIONAL on the
// gate_fired payload below — a real permission gate (Bash/Write/…) has no
// questions, so existing events/tests stay byte-identical.
export const gateQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export const gateQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(gateQuestionOptionSchema),
  multiSelect: z.boolean().optional(),
});
export const gateFiredPayloadSchema = z.object({
  appSessionId: z.string(),
  prompt: z.string(),
  requestId: z.string().optional(),
  toolName: z.string().optional(),
  target: z.string().optional(),
  // D68: present ONLY on an AskUserQuestion gate (same optional-widening
  // discipline as requestId/toolName/target above). Absent on every permission
  // gate and every harness profile, so the fold and existing events are unchanged.
  questions: z.array(gateQuestionSchema).optional(),
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
  // ⚠ WIDENED IN S8·4a, OPTIONAL-only — the same discipline
  // `taskCreatedPayloadSchema.title` documents. Every `message` already written
  // omits this key, still validates, and still folds/serializes byte-identical
  // (I6).
  //
  // The transcript's compaction summary is an ORDINARY `user` message carrying
  // `isCompactSummary: true` — the ONLY thing that distinguishes it from any
  // other 4KB user turn (observed verbatim, SP8·1's
  // scratchpad/sp8-1-evidence/logs/q6-after-compact.jsonl, the record right
  // after the `compact_boundary`). TRUE for that one record only; every
  // ordinary message omits the key entirely — absent-stays-absent, never
  // `false`.
  //
  // ⚠ NOT WIDENED ON THE SDK PATH (sessionHost.ts). The SAME summary DOES
  // arrive there as a stream message (q1b-stream.jsonl line 12, `type:"user"`)
  // — but it carries NO `isCompactSummary` key at all; it carries
  // `isSynthetic:true`/`isReplay:false` instead. Rule 0.7: we do not build for
  // a shape we did not observe, so the SDK path's message handling is left
  // unchanged. See the comment on sessionHost.ts's assistant/user branch.
  isCompactSummary: z.literal(true).optional(),
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
// the rest is the verbatim hook stdin body. All SIX hook events share this
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
// ⚠ WIDENED AGAIN IN SLICE 6 STEP 9 with `title`, OPTIONAL-only, exactly as
// `gates` was widened above and for the same reason: a birth record written
// before the field existed omits it, still validates, and still serializes to
// the same bytes. Title is named at creation and never changed — there is no
// `task_renamed` (see the note on `taskRecordSchema.title`).
// ⚠ WIDENED AGAIN IN S7·2a with the four AUTHORED work-order fields — `scope`,
// `explicitlyOut`, `acceptanceCriteria`, `killCriterion` — OPTIONAL-only, exactly
// as `gates` and `title` were widened above and for the same I6 reason: every
// `task_created` already written omits all four, still validates, and still
// serializes to the same bytes. They are DERIVED from `taskRecordSchema.shape.*`
// (not re-typed) so the event and the record can never drift on the shape, and
// because all four are already `.optional()` on the record they ride through
// optional here without a further `.optional()` call. `acceptanceCriteria` is the
// FULL record shape `{id,text}[]` (the reserved `acceptanceCriterionSchema`): the
// writer mints each id server-side and writes it INTO this event, so replay reads
// the stored ids and nothing re-mints on fold (deterministic, I6).
//
// ⚠ `workOrderRev` is DELIBERATELY NOT ADDED to the birth payload. Creation has
// no revision — a task is born at rev-absent, and the first amendment (S7·2b, via
// the reserved `work_order_amended` event) is what introduces a rev. Adding it
// here would let a creator fabricate a revision for an unamended work order.
export const taskCreatedPayloadSchema = z.object({
  taskId: z.string(),
  projectRoot: z.string(),
  // Derived from the record's own field rather than re-typed, so the event and
  // the record can never drift on the shape (`title` is already optional there).
  title: taskRecordSchema.shape.title,
  createdBy: taskRecordSchema.shape.createdBy,
  isolation: taskRecordSchema.shape.isolation,
  stage: taskStageSchema,
  gates: taskRecordSchema.shape.gates.optional(),
  scope: taskRecordSchema.shape.scope,
  explicitlyOut: taskRecordSchema.shape.explicitlyOut,
  acceptanceCriteria: taskRecordSchema.shape.acceptanceCriteria, // full {id,text}[]
  killCriterion: taskRecordSchema.shape.killCriterion,
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

// task_worktree_created — one isolated worker directory, recorded at the moment it
// came into existence (slice-6 step 8). Both names are DERIVED from the taskId by
// `tasks/worktreePaths.ts`, so they are re-derivable rather than remembered; they
// are carried anyway because the log is the audit trail for "which directory did
// this worker actually edit?", and a fact you have to re-run a function to recover
// is a fact an operator reading the log does not have.
//
// `setupMs` is D32's missing cost measurement — see the type's own note above. It
// is a DURATION, never a timestamp, and it comes from the manager's INJECTED clock
// (rule 0.3); nothing in this vocabulary calls a real clock.
export const taskWorktreeCreatedPayloadSchema = z.object({
  taskId: z.string(),
  // The absolute path of the created worktree.
  path: z.string(),
  // The branch it checks out, e.g. `vimes/task-<id>`.
  branch: z.string(),
  // Wall-clock milliseconds the creation took, from the injected clock.
  setupMs: z.number(),
});

// ——— course-correction payloads (slice-6 step 6a), on the SESSION stream ———
//
// correction_queued — VIMES accepted a correction and handed it to the SDK's
// streaming-input queue. Emitted by the daemon at the send boundary, and ONLY
// after the host has said the send succeeded: a refused send queued nothing, and
// a record of a correction that never entered the queue would make the watchdog
// protect a run that is not being steered.
//
// ⚠ **PRIVACY — `text` IS THE OPERATOR'S OWN WORDS, AND THE LOG IS FOREVER.**
// This is the only payload in the vocabulary that carries free human prose the
// operator typed, into an APPEND-ONLY store: it cannot later be edited, redacted
// or scrubbed, and it will be replayed into every projection and every snapshot
// for the life of the database. It is carried DELIBERATELY, not incidentally,
// because a correction whose text nobody can read is unauditable — "why did this
// run change direction?" is exactly the question the log exists to answer, and
// the sibling `message(role:'user')` echo already carries the same words inline
// (D12). Note what this event does NOT carry, on the same reasoning the push
// payloads document: no endpoint, no credential, no path, no environment.
export const correctionQueuedPayloadSchema = z.object({
  appSessionId: z.string(),
  text: z.string(),
});

// correction_delivered — a `queued_command` attachment was OBSERVED in the
// transcript (rule 0.7). Every field below is EVIDENCE of what was seen, carried
// so the log can be re-read against a future CLI rather than re-measured.
//
// Shapes and populations MEASURED 2026-07-22 over 30 real transcripts / 134
// attachments (risk-register.md, "`queued_command` attachment shape"):
//   • `commandMode`: 'prompt' ×72, 'task-notification' ×62 — i.e. ~46% of these
//     attachments are AGENT task-notifications, not human steers.
//   • `origin.kind`: task-notification → absent 62/62; prompt → 'human' ×47,
//     ABSENT ×25.
//   • the enqueue `timestamp`: ABSENT in 27/134 (~20%).
export const correctionDeliveredPayloadSchema = z.object({
  appSessionId: z.string(),
  // ⚠ DELIBERATELY `z.string()` AND NOT AN ENUM, for the reason
  // `taskTransitionRejectedPayloadSchema` gives for its stage fields: this event
  // records what was OBSERVED. The mapper copies the mode VERBATIM off the
  // record rather than restating the constant it matched, so if the discriminator
  // is ever widened after a CLI bump the value already rides in the log and no
  // schema change is needed to read it back.
  commandMode: z.string(),
  // `attachment.origin.kind` when the record carried one. OPTIONAL, and it MUST
  // stay optional: 25 of the 72 observed `prompt` records have no origin at all,
  // and that unmarked population is the one VIMES's own SDK injections most
  // resemble. This is EVIDENCE, never a filter — see the mapper.
  originKind: z.string().optional(),
  // `attachment.timestamp` — the ENQUEUE time, not the delivery time. OPTIONAL
  // because ~20% of real records simply do not have it.
  //
  // ⚠ NOT AN ORDERING KEY. The attachment carries the enqueue time but sits at
  // the DELIVERY file position (30.4 s apart in observed run A5), so this value
  // is systematically EARLIER than the moment it is being reported. Read it as
  // "when the operator asked", never as "when this happened".
  enqueuedAt: z.string().optional(),
});

// work_order_amended (S7·1 reserved the shape; S7·2b landed the writer — see the
// note on EVENT_TYPES.workOrderAmended above). A PATCH of the amendable
// work-order fields plus the rev the record reflects AFTER this amendment —
// never the whole record, and never a mutation of it (D43: revisioned, not
// mutated; I12: append-only).
//
// Each patch field is DERIVED from `taskRecordSchema.shape.*` rather than
// re-typed, so the event and the record can never drift on the shape (the same
// discipline `taskCreatedPayloadSchema.title` follows). All four are already
// `.optional()` on the record, so they ride through optional here too — an
// amendment that touches only `scope` simply omits the rest; it is not required
// to restate fields it left alone.
//
// ⚠ `amendedBy` WAS ADDED IN S7·2b, REQUIRED, AND THAT WIDENING IS I6-SAFE ONLY
// BECAUSE THE RESERVATION HAD NO EMITTER: not one `work_order_amended` had ever
// been written when it landed, so there is no stored payload for a new required
// field to invalidate. Do NOT read this as a precedent for widening a payload
// that HAS been emitted — that is a migration, and rule 0.5's reservations exist
// precisely so this window is the only one where it is free.
export const workOrderAmendedPayloadSchema = z.object({
  taskId: z.string(),
  // The rev AFTER this amendment is applied.
  workOrderRev: z.number().int().nonnegative(),
  // WHO amended the work order. **TWO VALUES, NOT `transitionProposedBySchema`'s
  // THREE**, and the missing one is the point: `dispatcher` NEVER amends. D53
  // partitions movement into decisions (a human/orchestrator judgment), outcomes
  // (the work reporting itself) and mechanics (dispatch) — an amendment is
  // squarely a DECISION, so the machinery has no business authoring one. Reusing
  // the transition enum whole would make `amendedBy: 'dispatcher'` a recordable
  // fact and invite a future dispatcher branch to rewrite the very work order it
  // was dispatched against.
  //
  // Enumerated explicitly for the same fail-closed reason `shouldDispatchOnTransition`
  // matches its two promoter values rather than testing `!== 'dispatcher'`: a
  // fourth actor added to the transition vocabulary must EARN its way into
  // amending, in a diff someone reviews.
  amendedBy: z.enum(['human', 'orchestrator']),
  scope: taskRecordSchema.shape.scope,
  explicitlyOut: taskRecordSchema.shape.explicitlyOut,
  acceptanceCriteria: taskRecordSchema.shape.acceptanceCriteria,
  killCriterion: taskRecordSchema.shape.killCriterion,
});
export type WorkOrderAmendedPayload = z.infer<typeof workOrderAmendedPayloadSchema>;

// plan_submitted (S7·5a, RESERVED — see the note on EVENT_TYPES.planSubmitted
// above; S7·5b is the emitter). D48: **the reserved `submit_plan` MCP tool
// payload IS the event payload**, not a second, restated shape — the same
// `submitPlanPayloadSchema` (imported above from `tasks/workOrder.js`) that
// validates the tool call crossing the boundary is registered VERBATIM below
// as this event's payload schema. Declaring a second, near-identical
// `planSubmittedPayloadSchema` here would be exactly the "one source of record
// per fact" violation principle 9 exists to name — the tool input and the
// event would carry the same facts under two names, free to drift the moment
// either changed alone. No new payload type is minted either: `SubmitPlanPayload`
// (from `tasks/workOrder.js`) is the type used everywhere below.

// ——— project-registry payloads (S8·1, D42), all on the 'projects' stream ———
//
// project_created — the BIRTH RECORD of a declared boundary. `root` is the
// directory the user picked, already resolved and allow-list-checked by the route
// (D60), so what is persisted is what was checked.
//
// `name` / `description` are DERIVED from the record's own fields rather than
// re-typed, so the event and the record can never drift on the shape (the same
// discipline `taskCreatedPayloadSchema.title` follows); both are already
// `.optional()` there, so they ride through optional here without a further
// `.optional()` call.
//
// ⚠ **AN UNNAMED PROJECT'S BIRTH RECORD CARRIES NO `name` KEY AT ALL** — not
// `''`, and not the directory basename. D42's basename fallback is a READ-TIME
// derivation and is never stored (see `projectRecordSchema`'s note): storing it
// would make "unnamed" and "named after its folder" the same recorded fact, and
// would go stale the day the folder is renamed. The writer omits the key rather
// than sending `undefined`, so an unnamed project's bytes stay minimal (I6).
export const projectCreatedPayloadSchema = z.object({
  projectId: z.string(),
  root: z.string(),
  name: projectRecordSchema.shape.name,
  description: projectRecordSchema.shape.description,
});

// project_updated — the MUTABLE-METADATA PATCH, mirroring
// `workOrderAmendedPayloadSchema`'s discipline exactly: **present in the payload
// → REPLACES the record's field; absent → the record's field is left exactly as
// it was.** An update that renames without touching the description omits the
// description, and it survives untouched — restating it would be the only
// alternative, and it would make every rename a full rewrite that silently
// clobbers whatever a concurrent one just changed.
//
// ⚠ **`root` IS NOT PATCHABLE, AND ITS ABSENCE HERE IS THE DESIGN, NOT AN
// OVERSIGHT.** D42: the directory IS the project boundary, so a different
// directory is a DIFFERENT PROJECT — one that must be declared (and get its own
// projectId) rather than smuggled into an existing record's history. Moving a
// boundary would also silently re-attribute every session and cost row that ever
// sat under the old prefix, retroactively and with no record of the change.
// Adding `root` here is a decision somebody has to write down, not a widening.
export const projectUpdatedPayloadSchema = z.object({
  projectId: z.string(),
  name: projectRecordSchema.shape.name,
  description: projectRecordSchema.shape.description,
});

// project_archived — the lifecycle's terminal step. **ARCHIVE, NOT DELETE:**
// nothing is ever removed from an append-only log (I12), and the projection keeps
// the record in the map with `archived: true` rather than dropping it, because
// history attribution over the archived root must keep working — a cost row from
// last month still sits under that directory. Only LIVE projects take part in
// `projectForCwd`'s longest-prefix match; the record itself never goes away.
//
// Carries the projectId and nothing else: the fact is "this project was
// archived", and every other field is already on the record.
export const projectArchivedPayloadSchema = z.object({
  projectId: z.string(),
});

// project_initialized (S8·1, **RESERVED — see EVENT_TYPES.projectInitialized**).
// D42 reserves it for the onboarding hook (`design-directions.md` → "Project
// onboarding"); rule 0.5 says the shape lands now and the workflow lands with its
// consumer. Deliberately NOT folded by `projections/projects.ts` — a reserved
// event that quietly changed a record would be a workflow nobody built.
export const projectInitializedPayloadSchema = z.object({
  projectId: z.string(),
});

// compaction_observed (S8·4a) — see EVENT_TYPES.compactionObserved above for
// the full rule-0.7 / one-source-of-record note. Every field is EVIDENCE of
// what the CLI reported for one `/compact`.
export const compactionObservedPayloadSchema = z.object({
  appSessionId: z.string(),
  // ⚠ DELIBERATELY `z.string()`, NOT AN ENUM — same posture as
  // `correctionDeliveredPayloadSchema.commandMode`: this records what the CLI
  // reported (`'manual'` is the only value SP8·1's real captures observed)
  // rather than a closed vocabulary VIMES declares. The recognizer copies the
  // value verbatim off the record, so a future CLI's trigger vocabulary needs
  // no schema change to be read back out of the log.
  trigger: z.string(),
  // The observed pre/post-compaction token counts and wall-clock duration, off
  // `compactMetadata`/`compact_metadata`. ALL OPTIONAL: the boundary itself is
  // the fact being witnessed; a boundary observed with missing or malformed
  // metadata still emits an event — these numbers are decoration, never the
  // event's reason to exist. Nonnegative integers because they are copied
  // verbatim off counts/a duration that can never be negative.
  preTokens: z.number().int().nonnegative().optional(),
  postTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

// ── S8·4 (D64) — the transcript lifecycle's own two facts ────────────────────

// compaction_nudge_sent — the daemon steward DELIVERED an escalating nudge turn
// into an orchestrator's session (D57's agency mechanism).
//
// ⚠ THE EVENT MEANS *DELIVERED*, NOT *DECIDED*. The steward emits this only
// after `sendMessage` accepted the turn, because this event IS the escalation
// memory: `rememberCompactionNudge` folds it, and a level recorded as sent is a
// level that never fires again this epoch. Eventing a nudge that never reached a
// live session would silently burn that level. See compactionSteward.ts (daemon).
export const compactionNudgeSentPayloadSchema = z.object({
  appSessionId: z.string(),
  // The escalation step, 1-based and ascending — L1 is the gentle capture-soon
  // nudge, L2 names the door. A positive int rather than an enum so the ⟨tune⟩
  // ladder can grow a rung without a schema change (the config owns the rungs).
  level: z.number().int().positive(),
  // The fill reading that crossed the threshold — `latestContextTokens` summed,
  // copied verbatim off the observation that fired the nudge. Evidence of WHY
  // this level fired, and what the calibration pass will read back out of the log
  // when the ⟨tune⟩ thresholds are finally pinned (Gate-D, D64).
  contextTokens: z.number().int().nonnegative(),
});

// compaction_held — the PreCompact ingress answered `hold`: VIMES vetoed a
// compaction because the orchestrator's state was still unbanked (D64's door).
//
// ⚠ ONLY HOLDS ARE EVENTED, NEVER ALLOWS. `allow` is the universal default (the
// door fails OPEN — see `decideCompactionGate`), and the compaction that follows
// an allow is ALREADY witnessed by S8·4a's `compaction_observed`. So an allow
// event would be a second, redundant record of a fact the log already carries,
// on the hot path of every compaction. Holds are the exception and the news.
//
// Volume: while held, the CLI re-offers the compaction on EVERY turn (OBSERVED,
// SP8·1 Q3d — 5 consecutive re-offers, no breaker), so a long hold writes one
// event per turn. That cadence is accepted deliberately: the nudges exist
// precisely so holds are rare and short (D64).
export const compactionHeldPayloadSchema = z.object({
  appSessionId: z.string(),
  // The fill reading at the moment of the veto, when one was known. OPTIONAL
  // because the gate deliberately does NOT require a fill reading to answer (an
  // unknown fill answers `allow`, so a `hold` always has one in practice today) —
  // the field degrades to absent rather than to a fabricated 0 (pillar 4).
  contextTokens: z.number().int().nonnegative().optional(),
});

// ── S9·1 — the session-tree payloads (architecture.md E2), 'nodes' stream ─────
//
// See the EVENT_TYPES block above for why there are exactly three of these and
// why `node_moved` is not among them. All three are RESERVED (rule 0.5): the
// shapes land now, the emitters land with their consumers.

// The checkout a worktree node was born against — the four facts that make a
// provenance claim checkable later (E2's worktree lineage, herdr's model).
// `resolvedCommit` is what `baseRef` MEANT at creation time, recorded because a
// ref moves and a commit does not: without it, "branched off main" degrades into
// an unfalsifiable story the moment main advances.
//
// Every field is required and non-empty: a partial provenance is worse than
// none, because it reads as a checkout while naming nothing checkable. A node
// with no checkout carries `provenance: null` instead (below).
export const nodeProvenanceSchema = z.object({
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  resolvedCommit: z.string().min(1),
  path: z.string().min(1),
});

// node_created — the birth record of one node in the forest. ONE node kind
// (E2-a): `project`, `group` and `worktree` are not separate families, they are
// this shape with different fields filled in.
export const nodeCreatedPayloadSchema = z.object({
  nodeId: z.string().min(1),
  parentNodeId: z.string().min(1).nullable(), // null = tree root (a project node)
  projectId: z.string().min(1),               // the D42 root this tree hangs off
  name: z.string().min(1),
  // E2-a: WRITE-ONCE-AT-CREATION. null stays null forever; a checkout is a
  // new child node, never a mutation of this one.
  provenance: nodeProvenanceSchema.nullable(),
  // E3-a: directory OPTIONAL — label-only groups scope nothing. When present,
  // spawn-default cwd (meaning #2 of three; never containment).
  directory: z.string().min(1).nullable(),
  // E3-a: RESERVED (rule 0.5) — per-node config arrives with its first real
  // tenant need. Schema reserves the key, accepts only null tonight.
  nodeConfig: z.null(),
});

// node_closed — carries the nodeId and nothing else, because closure IS the
// whole fact.
export const nodeClosedPayloadSchema = z.object({
  nodeId: z.string().min(1),
  // Closure is TREE-state (axis 1 of three): closing kills no process,
  // removes nothing on disk. Subtree closure is the projection's fold.
});

// session_attached_to_node — the link that gives every session exactly one
// parent node. On the tree's stream rather than the session's: it is a fact
// about the NODE's membership list, and the nodes projection folds only its own
// stream (D34, stream-local).
export const sessionAttachedToNodePayloadSchema = z.object({
  nodeId: z.string().min(1),
  appSessionId: z.string().min(1),
});

// checkout_removed — a NODES-STREAM AUDIT FACT (slice-17.md §1), NOT a fourth
// member of the S9·1 family above. It records that a checkout's DISK was
// actually removed; the node itself, its provenance, and its tree position are
// untouched by this event — removal here is a DISK fact, orthogonal to
// `node_closed`'s TREE fact (same three-axis discipline the S9·1 note above
// states, extended to a fourth axis-adjacent verb rather than folded into
// closure).
//
// ⚠ **RESERVED SHAPE, FOLD DEFERRED (rule 0.5).** The schema is registered now
// so the event validates and constructs; `projections/nodes.ts` does not fold
// it yet, and that is safe by construction — the fold is TOTAL, so an unknown
// event kind is already a no-op there. The first consumer (a later, deliberate
// nodes-projection bump, D86 — NOT this unit) wires the fold. Emitted ONLY when
// disk was actually removed (never on the idempotent no-op second remove,
// slice-17.md §3.10) — the payload's `branch` field is carried so an audit log
// reads human-legible without a join back to the node's own (by-then-still-
// live) provenance record.
export const checkoutRemovedPayloadSchema = z.object({
  nodeId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
});

// ── S11 (D72 Move 2) — the GENERIC INSTANCE payloads ─────────────────────────
//
// Each one generalises exactly one retired task payload, field for field. The
// three renames that carry the whole move are `taskId` -> `instanceId`,
// `projectRoot` -> `project`, and every `stage` -> a `node` (workflow node ids
// are the tenant's vocabulary, not an engine enum).
//
// ⚠ **THE NODE FIELDS ARE `z.string()`, NEVER `taskStageSchema`, AND THAT IS THE
// POINT OF THE MOVE.** A node id belongs to the workflow definition that
// declares it (node-kit §1.7); validating one against the compiled task enum
// would make the generic vocabulary unable to express any workflow but the one
// hard-coded today, which is the carve-out this slice exists to remove. The old
// enum still guards the LEGACY spelling — every adapter in `RETIRED_EVENT_KINDS`
// below parses its legacy schema first, so a `task_created` with a stage outside
// the enum is still a malformed payload and still folds to nothing.
//
// ⚠ **ABSENT-VS-EMPTY DISCIPLINE IS CARRIED OVER EXACTLY.** `gates` is optional
// here for the same reason it is optional on `task_created` (the fold defaults it
// to `{}` — an ungated instance and an instance with no gates are the same fact),
// while every field inside `payload` is optional AND absent-stays-absent (an
// empty scope is a scope someone chose). Read `taskCreatedPayloadSchema`'s note
// and the fold in projections/instances.ts together; the asymmetry is designed.

// The workflow this instance is an instance OF (node-kit §1.7's identity).
//
// ⚠ **RESERVED S11 (rule 0.5), FILLED BY S12·U2 (D72 Move 3).** Slice 11 reserved
// the shape while the writer still stamped `null` — no pinned workflow definition
// governed adjudication, so an identity nothing pinned would have been DECLARED
// truth over observed (rule 0.7). Move 3 ends that condition: the writer now
// stamps the boot-resolved declaration's ref. `null` remains a RECORDED fact —
// every pre-Move-3 birth record carries it, and the `task_created` alias adapter
// still writes it — which is why the field stays nullable rather than required.
export const workflowRefSchema = z.object({
  // The extension package that declares the workflow.
  extension: z.string(),
  // The workflow id within that package.
  workflow: z.string(),
  // The manifest revision the instance was created against.
  //
  // ⚠ **A SEMVER STRING, CORRECTED S12·U2 (2026-08-10) BEFORE ITS FIRST
  // PRODUCER.** Reserved S11 as `z.number().int().nonnegative()`; the signed
  // skeleton says this ref stamps "rev: manifest version", and a manifest
  // `version` is semver by parse rule (`extension-model` §2.2, enforced in
  // `extensions/manifest.ts`) — `"1.0.0"`, not a counter. Rule 0.5's cheap
  // moment, taken: verified ZERO producers and ZERO recorded non-null refs
  // anywhere before this edit (the alias adapter and the pre-flip writer both
  // stamp `null`), so no written byte changes meaning and no migration is owed.
  rev: z.string(),
});
export type WorkflowRef = z.infer<typeof workflowRefSchema>;

// The tenant-shaped payload (slice-11.md's record split). The engine NEVER reads
// a field in here to decide anything — that is what makes it opaque, and it is
// why the five authored work-order fields moved under one key rather than staying
// scattered across the core record. Each field DERIVES from `taskRecordSchema`
// rather than being re-typed, so the two spellings cannot drift while both exist
// (the same discipline `taskCreatedPayloadSchema` follows).
export const instancePayloadSchema = z.object({
  title: taskRecordSchema.shape.title,
  scope: taskRecordSchema.shape.scope,
  explicitlyOut: taskRecordSchema.shape.explicitlyOut,
  acceptanceCriteria: taskRecordSchema.shape.acceptanceCriteria,
  killCriterion: taskRecordSchema.shape.killCriterion,
});
export type InstancePayload = z.infer<typeof instancePayloadSchema>;

// instance_created — the birth record, generalising `task_created`.
export const instanceCreatedPayloadSchema = z.object({
  instanceId: z.string(),
  project: z.string(),
  // The node the instance starts on — carried, never re-derived, exactly as
  // `task_created.stage` was.
  node: z.string(),
  createdBy: taskRecordSchema.shape.createdBy,
  // Nullable, not optional: `null` is the stated fact "no workflow definition
  // governs this instance yet", which is different from a field nobody wrote.
  workflow: workflowRefSchema.nullable(),
  // TRANSITIONAL core (slice-11.md's fence): the engine still reads both to
  // decide, so neither may live in `payload`. `isolation` retires into the
  // node-kind declaration, `gates` into the dispatch-gates declaration.
  isolation: taskRecordSchema.shape.isolation,
  gates: taskRecordSchema.shape.gates.optional(),
  payload: instancePayloadSchema,
});

// instance_moved — one ACCEPTED move, generalising `task_transitioned`.
// `manualReviewRequired` is the RESULTING flag as the machine decided it, and it
// rides along TRANSITIONALLY: it retires into workflow data at Move 3
// (slice-11.md's fence), which is why it sits here rather than in the payload.
export const instanceMovedPayloadSchema = z.object({
  instanceId: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  manualReviewRequired: z.boolean(),
  proposedBy: transitionProposedBySchema,
  note: z.string().optional(),
});

// instance_move_rejected — I7's record, generalising `task_transition_rejected`
// field for field. `attemptedToNode` is named distinctly from `toNode` precisely
// because NO move happened: the instance is still on `fromNode`.
//
// ⚠ Both node fields stay LOOSE for the reason the legacy schema states in full:
// one of the recordable refusals IS the unknown-node one, so validating the
// attempted end against any vocabulary would make exactly that rejection
// unrecordable.
//
// ⚠ `reason` IS LOOSE TOO, AS OF S13·U1 (slice-13 F1), AND FOR THE SAME FAMILY OF
// REASON — one channel of the vocabulary is not the engine's to enumerate.
//
//   • the ENGINE's refusals are a closed enum (`engineRefusalReasonSchema`,
//     `extensions/proposeMove.ts`) — but that enum lives beside its AUTHOR, not
//     beside the record, because
//   • a workflow's `forbidden` row declares its OWN reason string, and a second
//     tenant may declare a refusal no enum in this repo has ever contained. A
//     closed `reason` here would make that rejection unrecordable — the exact
//     failure the loose node fields above exist to prevent, one field over.
//
// What guarantees the field is not a free-text dumping ground is PROVENANCE, not
// this schema: `adjudicateAgainstDeclaration` is the only author of a refusal
// reason, and it produces either engine vocabulary or the pinned declaration's
// row. No caller-supplied string reaches here (F1 ⟨signed⟩). The static "was this
// reason declared" check belongs to the validator work stream, not to the record.
//
// THREE SPELLING FAMILIES MUST PARSE, PERMANENTLY: the legacy engine spellings
// already in the log (`terminal-stage` and friends — history is never rewritten,
// q21), the node-generic engine spellings written from S13 on, and every declared
// tenant string. The mixed log is the DESIGNED outcome (F2 ⟨signed⟩); do not
// "tidy" it by narrowing this field.
//
// SIDE EFFECT WORTH KEEPING: this schema no longer imports the tenant vocabulary
// from `tasks/taskStateMachine.ts`. The generic event family should not need a
// tenant's module to describe itself (#16).
export const instanceMoveRejectedPayloadSchema = z.object({
  instanceId: z.string(),
  fromNode: z.string(),
  attemptedToNode: z.string(),
  reason: z.string().min(1),
  proposedBy: transitionProposedBySchema,
});

// instance_payload_revised — generalising `work_order_amended` (D43: revisioned,
// never mutated). PATCH SEMANTICS, unchanged: present in `patch` REPLACES the
// record's field, absent leaves it exactly as it was, and an explicit `[]` IS a
// replacement rather than an omission. `payloadRev` is RECORDED, NEVER COMPUTED —
// the payload states the rev the record reflects AFTER this revision and the fold
// writes down what the event says (a fold that counted events would be a second
// authority over the rev and would break replay from a snapshot).
export const instancePayloadRevisedPayloadSchema = z.object({
  instanceId: z.string(),
  payloadRev: z.number().int().nonnegative(),
  // WHO revised it — two values, not the proposer's three, for the reason
  // `workOrderAmendedPayloadSchema.amendedBy` gives at length: the dispatcher
  // never revises the payload it was dispatched against.
  revisedBy: z.enum(['human', 'orchestrator']),
  // ⚠ `title` is deliberately NOT patchable, exactly as `work_order_amended`
  // could not amend it: a title is set at creation and there is no rename event.
  patch: z.object({
    scope: taskRecordSchema.shape.scope,
    explicitlyOut: taskRecordSchema.shape.explicitlyOut,
    acceptanceCriteria: taskRecordSchema.shape.acceptanceCriteria,
    killCriterion: taskRecordSchema.shape.killCriterion,
  }),
});

// instance_run_attached — one run of one node, linked to its instance;
// generalising `task_session_attached`. The fold is idempotent on
// `appSessionId` and deliberately NOT on `node` (see projections/instances.ts).
export const instanceRunAttachedPayloadSchema = z.object({
  instanceId: z.string(),
  node: z.string(),
  appSessionId: z.string(),
});

// report_filed — ONE event absorbing `review_reported` AND `completion_reported`,
// discriminated on `reportKind`. The `(instanceId, node, attempt, payloadRev)`
// prefix is D46's identity tuple — what makes a filed report attributable to a
// specific run — and it is hoisted OUT of the kind-specific body precisely
// because it is the same four facts either way. The body carries what only that
// kind has, DERIVED from the legacy schemas so the two cannot drift: `criteria`
// for a review, `worklog` for a completion. Nothing is lost in the generalisation
// — every field of both legacy payloads lands in exactly one place here.
export const reportFiledPayloadSchema = z.discriminatedUnion('reportKind', [
  z.object({
    instanceId: z.string(),
    node: z.string(),
    attempt: z.number().int().positive(),
    payloadRev: z.number().int().nonnegative(),
    reportKind: z.literal('review'),
    body: z.object({ criteria: reportReviewPayloadSchema.shape.criteria }),
  }),
  z.object({
    instanceId: z.string(),
    node: z.string(),
    attempt: z.number().int().positive(),
    payloadRev: z.number().int().nonnegative(),
    reportKind: z.literal('completion'),
    body: z.object({ worklog: reportCompletionPayloadSchema.shape.worklog }),
  }),
]);

// capture_recorded — the engine CAPTURE event, absorbing `plan_submitted`.
//
// ⚠ `captureKind` is a CLOSED catalogue with exactly one v1 entry, and it must
// agree with `CAPTURE_CATALOGUE` in extensions/manifest.ts (node-kit §1.8.3: "an
// extension can opt into an interception; it cannot add one"). It is spelled
// literally here rather than imported because the dependency runs the other way
// — manifest.ts imports this module — and a cycle would be a worse price than a
// restated one-entry enum. A test asserts the two agree, so a second entry
// added on one side reddens rather than drifting.
export const captureKindSchema = z.enum(['plan']);
export const captureRecordedPayloadSchema = z.object({
  instanceId: z.string(),
  captureKind: captureKindSchema,
  // The captured artifact's address in the artifact store — the blob itself
  // never rides on the event (D48: by reference only).
  artifactHash: z.string(),
  node: z.string(),
  attempt: z.number().int().positive(),
  payloadRev: z.number().int().nonnegative(),
  // The session the capture was taken from (`plannerSessionRef`, generalised).
  capturedFrom: z.object({ appSessionId: z.string() }),
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
  [EVENT_TYPES.hookPreCompact]: hookEventPayloadSchema,
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
  [EVENT_TYPES.taskWorktreeCreated]: taskWorktreeCreatedPayloadSchema,
  [EVENT_TYPES.correctionQueued]: correctionQueuedPayloadSchema,
  [EVENT_TYPES.correctionDelivered]: correctionDeliveredPayloadSchema,
  [EVENT_TYPES.workOrderAmended]: workOrderAmendedPayloadSchema,
  // Reused verbatim — see the note above `EVENT_TYPES.planSubmitted` /
  // just above this schema's own registration.
  [EVENT_TYPES.planSubmitted]: submitPlanPayloadSchema,
  // Reused verbatim (S7·6a) — the `report_review` / `report_completion` tool
  // payloads ARE these event payloads (D43/D46), not restated shapes.
  [EVENT_TYPES.reviewReported]: reportReviewPayloadSchema,
  [EVENT_TYPES.completionReported]: reportCompletionPayloadSchema,
  // S8·1 D42 — the project registry. `project_initialized` is registered here
  // like its siblings even though nothing emits it: a reserved shape that is not
  // in the payload table is a shape no consumer can validate against, which
  // defeats the point of reserving it.
  [EVENT_TYPES.projectCreated]: projectCreatedPayloadSchema,
  [EVENT_TYPES.projectUpdated]: projectUpdatedPayloadSchema,
  [EVENT_TYPES.projectArchived]: projectArchivedPayloadSchema,
  [EVENT_TYPES.projectInitialized]: projectInitializedPayloadSchema,
  [EVENT_TYPES.compactionObserved]: compactionObservedPayloadSchema,
  [EVENT_TYPES.compactionNudgeSent]: compactionNudgeSentPayloadSchema,
  [EVENT_TYPES.compactionHeld]: compactionHeldPayloadSchema,
  [EVENT_TYPES.nodeCreated]: nodeCreatedPayloadSchema,
  [EVENT_TYPES.nodeClosed]: nodeClosedPayloadSchema,
  [EVENT_TYPES.sessionAttachedToNode]: sessionAttachedToNodePayloadSchema,
  // S17·U1 — reserved (fold deferred to D86); see the payload schema's docblock.
  [EVENT_TYPES.checkoutRemoved]: checkoutRemovedPayloadSchema,
  // S11 (D72 Move 2) — the generic instance family. Registered beside the task
  // rows they retire, which stay registered forever: history still validates.
  [EVENT_TYPES.instanceCreated]: instanceCreatedPayloadSchema,
  [EVENT_TYPES.instanceMoved]: instanceMovedPayloadSchema,
  [EVENT_TYPES.instanceMoveRejected]: instanceMoveRejectedPayloadSchema,
  [EVENT_TYPES.instancePayloadRevised]: instancePayloadRevisedPayloadSchema,
  [EVENT_TYPES.instanceRunAttached]: instanceRunAttachedPayloadSchema,
  [EVENT_TYPES.reportFiled]: reportFiledPayloadSchema,
  [EVENT_TYPES.captureRecorded]: captureRecordedPayloadSchema,
} as const;

export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema>;
export type LivenessChangedPayload = z.infer<typeof livenessChangedPayloadSchema>;
export type TransitionRejectedPayload = z.infer<typeof transitionRejectedPayloadSchema>;
export type GateFiredPayload = z.infer<typeof gateFiredPayloadSchema>;
export type GateQuestion = z.infer<typeof gateQuestionSchema>;
export type GateQuestionOption = z.infer<typeof gateQuestionOptionSchema>;
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
export type TaskWorktreeCreatedPayload = z.infer<typeof taskWorktreeCreatedPayloadSchema>;
export type CorrectionQueuedPayload = z.infer<typeof correctionQueuedPayloadSchema>;
export type CorrectionDeliveredPayload = z.infer<typeof correctionDeliveredPayloadSchema>;
export type ProjectCreatedPayload = z.infer<typeof projectCreatedPayloadSchema>;
export type ProjectUpdatedPayload = z.infer<typeof projectUpdatedPayloadSchema>;
export type ProjectArchivedPayload = z.infer<typeof projectArchivedPayloadSchema>;
export type ProjectInitializedPayload = z.infer<typeof projectInitializedPayloadSchema>;
export type CompactionObservedPayload = z.infer<typeof compactionObservedPayloadSchema>;
export type CompactionNudgeSentPayload = z.infer<typeof compactionNudgeSentPayloadSchema>;
export type CompactionHeldPayload = z.infer<typeof compactionHeldPayloadSchema>;
export type NodeProvenance = z.infer<typeof nodeProvenanceSchema>;
export type NodeCreatedPayload = z.infer<typeof nodeCreatedPayloadSchema>;
export type NodeClosedPayload = z.infer<typeof nodeClosedPayloadSchema>;
export type SessionAttachedToNodePayload = z.infer<typeof sessionAttachedToNodePayloadSchema>;
export type CheckoutRemovedPayload = z.infer<typeof checkoutRemovedPayloadSchema>;
export type InstanceCreatedPayload = z.infer<typeof instanceCreatedPayloadSchema>;
export type InstanceMovedPayload = z.infer<typeof instanceMovedPayloadSchema>;
export type InstanceMoveRejectedPayload = z.infer<typeof instanceMoveRejectedPayloadSchema>;
export type InstancePayloadRevisedPayload = z.infer<typeof instancePayloadRevisedPayloadSchema>;
export type InstanceRunAttachedPayload = z.infer<typeof instanceRunAttachedPayloadSchema>;
export type ReportFiledPayload = z.infer<typeof reportFiledPayloadSchema>;
export type CaptureKind = z.infer<typeof captureKindSchema>;
export type CaptureRecordedPayload = z.infer<typeof captureRecordedPayloadSchema>;
// WorkOrderAmendedPayload is exported alongside `workOrderAmendedPayloadSchema`
// above, adjacent to its schema rather than grouped down here with the rest —
// no functional difference, kept next to the RESERVATION note it belongs with.

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
  | { type: typeof EVENT_TYPES.hookPreCompact; payload: HookEventPayload }
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
  | { type: typeof EVENT_TYPES.taskSessionAttached; payload: TaskSessionAttachedPayload }
  | { type: typeof EVENT_TYPES.taskWorktreeCreated; payload: TaskWorktreeCreatedPayload }
  | { type: typeof EVENT_TYPES.correctionQueued; payload: CorrectionQueuedPayload }
  | { type: typeof EVENT_TYPES.correctionDelivered; payload: CorrectionDeliveredPayload }
  | { type: typeof EVENT_TYPES.workOrderAmended; payload: WorkOrderAmendedPayload }
  | { type: typeof EVENT_TYPES.planSubmitted; payload: SubmitPlanPayload }
  | { type: typeof EVENT_TYPES.reviewReported; payload: ReportReviewPayload }
  | { type: typeof EVENT_TYPES.completionReported; payload: ReportCompletionPayload }
  | { type: typeof EVENT_TYPES.projectCreated; payload: ProjectCreatedPayload }
  | { type: typeof EVENT_TYPES.projectUpdated; payload: ProjectUpdatedPayload }
  | { type: typeof EVENT_TYPES.projectArchived; payload: ProjectArchivedPayload }
  | { type: typeof EVENT_TYPES.projectInitialized; payload: ProjectInitializedPayload }
  | { type: typeof EVENT_TYPES.compactionObserved; payload: CompactionObservedPayload }
  | { type: typeof EVENT_TYPES.compactionNudgeSent; payload: CompactionNudgeSentPayload }
  | { type: typeof EVENT_TYPES.compactionHeld; payload: CompactionHeldPayload }
  | { type: typeof EVENT_TYPES.nodeCreated; payload: NodeCreatedPayload }
  | { type: typeof EVENT_TYPES.nodeClosed; payload: NodeClosedPayload }
  | { type: typeof EVENT_TYPES.sessionAttachedToNode; payload: SessionAttachedToNodePayload }
  | { type: typeof EVENT_TYPES.instanceCreated; payload: InstanceCreatedPayload }
  | { type: typeof EVENT_TYPES.instanceMoved; payload: InstanceMovedPayload }
  | { type: typeof EVENT_TYPES.instanceMoveRejected; payload: InstanceMoveRejectedPayload }
  | { type: typeof EVENT_TYPES.instancePayloadRevised; payload: InstancePayloadRevisedPayload }
  | { type: typeof EVENT_TYPES.instanceRunAttached; payload: InstanceRunAttachedPayload }
  | { type: typeof EVENT_TYPES.reportFiled; payload: ReportFiledPayload }
  | { type: typeof EVENT_TYPES.captureRecorded; payload: CaptureRecordedPayload };

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
//
// ⚠ **RETIRED (S11, D72 Move 2) — DO NOT CALL THESE FROM PRODUCTION CODE.** They
// are retained so tests and fixtures can still WRITE the historical spelling the
// alias table exists to READ; the generic constructors are further down this
// file. S11-A6 is the grep that keeps this honest.
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
// work_order_amended (S7·1 reserved it, S7·2b landed the writer — see
// EVENT_TYPES.workOrderAmended and workOrderAmendedPayloadSchema above). Same
// 'tasks' stream as its siblings, literal `'tasks'` for the same reason the
// other task constructors use one: the vocabulary module stays free-standing.
//
// ITS ONE CALLER IS `TaskWriter.amendWorkOrder` (packages/daemon), which is the
// SOLE writer of task state (I7) and the only place `workOrderRev` is computed;
// the fold records the rev this payload states rather than deriving one of its
// own, which is what keeps replay deterministic (I6).
export function workOrderAmended(payload: WorkOrderAmendedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.workOrderAmended, payload };
}
// plan_submitted (S7·5a, RESERVED — see EVENT_TYPES.planSubmitted and
// `submitPlanPayloadSchema`'s registration above). Same 'tasks' stream and same
// literal-string reasoning as its siblings: the vocabulary module stays
// free-standing. NO CALLER INVOKES THIS YET — S7·5b (the daemon's SDK adapter,
// after intercepting `ExitPlanMode`) is the emitter. It AUGMENTS the task
// record (folds `planArtifactHash` — see projections/instances.ts) and is not a
// stage transition; the dispatcher's own `task_transitioned` handles
// planning -> plan-ready separately.
export function planSubmitted(payload: SubmitPlanPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.planSubmitted, payload };
}
// review_reported (S7·6a, RESERVED — see EVENT_TYPES.reviewReported and
// `reportReviewPayloadSchema`'s registration above). Same 'tasks' stream and same
// literal-string reasoning as its siblings: the vocabulary module stays
// free-standing. NO CALLER INVOKES THIS YET — S7·6b (the daemon's SDK adapter,
// after capturing a `report_review` tool call) is the emitter. It is the durable
// record of the verdict and is not a stage transition; the dispatcher's own
// `task_transitioned` handles review -> done / review -> implementing separately,
// deriving the target via `deriveReviewOutcome` from this payload. S7·7b added the
// projection fold: the payload lands on `TaskRecord.lastReview` (latest-wins).
export function reviewReported(payload: ReportReviewPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.reviewReported, payload };
}
// completion_reported (S7·7b — see EVENT_TYPES.completionReported above). Same
// 'tasks' stream and same free-standing reasoning as its siblings; the mirror of
// `reviewReported` for the FIX side. It AUGMENTS the task record (folds
// `lastCompletion` — see projections/instances.ts) and is not a stage transition; the
// implementing -> review move D53 makes an OUTCOME is a separate `task_transitioned`
// the dispatcher proposes through the I7 choke.
//
// ⚠ NO CALLER INVOKES THIS YET. The emitter is S7·7b-DAEMON: the daemon's SDK
// adapter exposes the `report_completion` tool (D52's channel), captures the
// worklog in the tool handler, and calls this. The constructor and the fold are
// real as of S7·7b-core; only the writer is still missing.
export function completionReported(payload: ReportCompletionPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.completionReported, payload };
}

// ── S11 (D72 Move 2) — the GENERIC INSTANCE constructors ─────────────────────
//
// Same literal `'tasks'` stream as the retired siblings above, for BOTH reasons
// those siblings state: the vocabulary module stays free-standing (no dependency
// on a projection), and the stream name is persisted state this rename does not
// touch (slice-11.md). The writer that calls these is `instanceWriter.ts`
// (S11·U2); as of U1 the only callers are tests — the reducer already folds
// these kinds, and the old writer's legacy spellings reach the same fold through
// `RETIRED_EVENT_KINDS` below. That is one writer with one spelling at every
// moment, never a dual write of the spine (D72's governing rule).
export function instanceCreated(payload: InstanceCreatedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.instanceCreated, payload };
}
export function instanceMoved(payload: InstanceMovedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.instanceMoved, payload };
}
// I7's record — emitted for EVERY rejected proposal, never conditionally, exactly
// as `taskTransitionRejected` was. Folded by nothing (a refusal changed nothing);
// it is evidence, and it lives in the log.
export function instanceMoveRejected(payload: InstanceMoveRejectedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.instanceMoveRejected, payload };
}
export function instancePayloadRevised(payload: InstancePayloadRevisedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.instancePayloadRevised, payload };
}
export function instanceRunAttached(payload: InstanceRunAttachedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.instanceRunAttached, payload };
}
export function reportFiled(payload: ReportFiledPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.reportFiled, payload };
}
export function captureRecorded(payload: CaptureRecordedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.captureRecorded, payload };
}

// ── S11 (D72 Move 2, q21) — THE ALIAS TABLE ──────────────────────────────────
//
// **PERMANENT AND VERSIONED, not a migration script.** The log is append-only and
// forever: every `task_created` ever written stays a `task_created`, and nothing
// in this codebase may ever rewrite one. This table is how the engine keeps
// READING them — the instances reducer resolves an incoming kind through it
// before switching, so recorded history folds through exactly one code path with
// the current vocabulary, and the retired cases never accumulate as a second
// (inevitably diverging) fold.
//
// `since` is the ALIAS-TABLE VERSION that introduced the row, not the engine
// version and not a date: it is what lets a later reader tell a row that has been
// answering for three years from one added last week, and it is why the type pins
// `1` as a literal — a second wave of retirements adds `since: 2` rows in a diff
// somebody reviews, rather than silently joining the first.
//
// Each `adapt` is PURE and LOSSLESS:
//   • PURE — no clocks, no ids, no I/O; the same legacy payload always adapts to
//     the same generic payload, which is what keeps replay deterministic (I6).
//   • LOSSLESS — every field of the legacy payload lands somewhere in the generic
//     one. A field quietly dropped here is a fact that survives in the log but
//     disappears from every read of it, which is the worst shape a migration can
//     take: silent, and only visible years later.
//   • TOTAL — the legacy schema is `safeParse`d and a failure returns `null`,
//     meaning "malformed, fold nothing". The reducer turns `null` into a no-op
//     that returns its state object by IDENTITY. Hostile input must not crash a
//     fold (I8), and it must not fabricate a record either.
//
// ⚠ **NOT IN THIS TABLE, DELIBERATELY:** `task_worktree_created`,
// `task_quarantined`, `dispatch_refused`. The old reducer folded none of them
// (see its "deliberately NOT folded" block, carried into projections/
// instances.ts), and their generic siblings arrive with the E2 tree store and the
// watchdog/dispatcher splits — renaming a kind whose consumer has not been
// designed yet would be reserving the wrong shape. `task_transition_rejected` IS
// in the table even though nothing folds it either, because it is the direct
// sibling of a kind this slice DOES generalise: the rename is settled, so the row
// is real, and the fold still does nothing with it.
export interface RetiredEventKind {
  // The generic sibling's kind — a value from `EVENT_TYPES`.
  canonical: string;
  // The alias-table version that introduced this row.
  since: 1;
  // Legacy payload -> the canonical kind's payload; `null` when the legacy
  // payload does not parse (fold nothing). TypeScript collapses the written
  // `unknown | null` to `unknown`; the `null` is load-bearing at runtime and is
  // spelled in the return position so the contract reads off the type.
  adapt: (legacyPayload: unknown) => unknown | null;
}

export const RETIRED_EVENT_KINDS: Readonly<Record<string, RetiredEventKind>> = {
  [EVENT_TYPES.taskCreated]: {
    canonical: EVENT_TYPES.instanceCreated,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = taskCreatedPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        project: legacy.projectRoot,
        node: legacy.stage,
        createdBy: legacy.createdBy,
        // No `task_created` ever named a workflow — there were no workflow
        // definitions when they were written. `null` is the honest answer
        // (rule 0.7: observed truth), and it is the same value this slice's own
        // writer stamps, so a legacy and a generic birth record fold alike.
        workflow: null,
        isolation: legacy.isolation,
        // ABSENT STAYS ABSENT here so the FOLD keeps its one defaulting rule in
        // one place (`gates ?? {}` lives in the reducer, exactly where it lived
        // in the old one). An adapter that defaulted would move a documented
        // asymmetry into a second file.
        ...(legacy.gates === undefined ? {} : { gates: legacy.gates }),
        payload: {
          ...(legacy.title === undefined ? {} : { title: legacy.title }),
          ...(legacy.scope === undefined ? {} : { scope: legacy.scope }),
          ...(legacy.explicitlyOut === undefined ? {} : { explicitlyOut: legacy.explicitlyOut }),
          ...(legacy.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: legacy.acceptanceCriteria }),
          ...(legacy.killCriterion === undefined ? {} : { killCriterion: legacy.killCriterion }),
        },
      };
    },
  },
  [EVENT_TYPES.taskTransitioned]: {
    canonical: EVENT_TYPES.instanceMoved,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = taskTransitionedPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        fromNode: legacy.fromStage,
        toNode: legacy.toStage,
        manualReviewRequired: legacy.manualReviewRequired,
        proposedBy: legacy.proposedBy,
        // Carried even though no fold reads it: losslessness is the rule, and a
        // `note` is exactly the kind of audit fact that would vanish silently.
        ...(legacy.note === undefined ? {} : { note: legacy.note }),
      };
    },
  },
  [EVENT_TYPES.taskTransitionRejected]: {
    canonical: EVENT_TYPES.instanceMoveRejected,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = taskTransitionRejectedPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        fromNode: legacy.fromStage,
        attemptedToNode: legacy.attemptedToStage,
        reason: legacy.reason,
        proposedBy: legacy.proposedBy,
      };
    },
  },
  [EVENT_TYPES.taskSessionAttached]: {
    canonical: EVENT_TYPES.instanceRunAttached,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = taskSessionAttachedPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        node: legacy.stage,
        appSessionId: legacy.appSessionId,
      };
    },
  },
  [EVENT_TYPES.workOrderAmended]: {
    canonical: EVENT_TYPES.instancePayloadRevised,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = workOrderAmendedPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        payloadRev: legacy.workOrderRev,
        revisedBy: legacy.amendedBy,
        // ⚠ ABSENT STAYS ABSENT, and an explicit `[]` RIDES THROUGH. The patch's
        // whole semantics live in the difference between "this field was not
        // mentioned" and "this field was set to empty"; an adapter that spread
        // `undefined`s would turn every amendment into a full rewrite.
        patch: {
          ...(legacy.scope === undefined ? {} : { scope: legacy.scope }),
          ...(legacy.explicitlyOut === undefined ? {} : { explicitlyOut: legacy.explicitlyOut }),
          ...(legacy.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: legacy.acceptanceCriteria }),
          ...(legacy.killCriterion === undefined ? {} : { killCriterion: legacy.killCriterion }),
        },
      };
    },
  },
  [EVENT_TYPES.planSubmitted]: {
    canonical: EVENT_TYPES.captureRecorded,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = submitPlanPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        captureKind: 'plan',
        artifactHash: legacy.planArtifactHash,
        node: legacy.stage,
        attempt: legacy.attempt,
        payloadRev: legacy.workOrderRev,
        capturedFrom: legacy.plannerSessionRef,
      };
    },
  },
  [EVENT_TYPES.reviewReported]: {
    canonical: EVENT_TYPES.reportFiled,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = reportReviewPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        node: legacy.stage,
        attempt: legacy.attempt,
        payloadRev: legacy.workOrderRev,
        reportKind: 'review',
        body: { criteria: legacy.criteria },
      };
    },
  },
  [EVENT_TYPES.completionReported]: {
    canonical: EVENT_TYPES.reportFiled,
    since: 1,
    adapt: (legacyPayload) => {
      const parsed = reportCompletionPayloadSchema.safeParse(legacyPayload);
      if (!parsed.success) {
        return null;
      }
      const legacy = parsed.data;
      return {
        instanceId: legacy.taskId,
        node: legacy.stage,
        attempt: legacy.attempt,
        payloadRev: legacy.workOrderRev,
        reportKind: 'completion',
        body: { worklog: legacy.worklog },
      };
    },
  },
};

// ── the project-registry constructors (S8·1, D42) ────────────────────────────
//
// All four on the 'projects' stream, literal for the same reason the task and
// meter constructors use a literal: the vocabulary module stays free-standing (no
// dependency on a projection). The stream is deliberately its OWN — a project
// belongs to no session and no task, and `projections/projects.ts` folds only
// this stream (D34, projections are stream-local).
//
// The SOLE WRITER of the first three is `ProjectWriter` (packages/daemon), reached
// over HTTP by `projectApi.ts`. Nothing else in the tree may emit them.
export function projectCreated(payload: ProjectCreatedPayload): EventInput {
  return { stream: 'projects', type: EVENT_TYPES.projectCreated, payload };
}
export function projectUpdated(payload: ProjectUpdatedPayload): EventInput {
  return { stream: 'projects', type: EVENT_TYPES.projectUpdated, payload };
}
export function projectArchived(payload: ProjectArchivedPayload): EventInput {
  return { stream: 'projects', type: EVENT_TYPES.projectArchived, payload };
}
// ⚠ **NOTHING EMITS THIS, AND NOTHING FOLDS IT** (rule 0.5 — see
// EVENT_TYPES.projectInitialized and the payload schema above). D42 reserves
// `project_initialized` for the project ONBOARDING HOOK, described in
// `design-directions.md` → "Project onboarding"; that workflow is built when it
// has a consumer, not before. The constructor is real so the reservation is a
// shape a future emitter can call rather than a comment — the same posture
// `dispatch_refused` held from slice 0 to slice 6, and `work_order_amended` held
// from S7·1 to S7·2b. If a grep for callers of this function comes up empty, that
// is the expected result.
export function projectInitialized(payload: ProjectInitializedPayload): EventInput {
  return { stream: 'projects', type: EVENT_TYPES.projectInitialized, payload };
}

// compaction_observed (S8·4a — see EVENT_TYPES.compactionObserved above). Same
// stream posture as `usage_block`: the session's OWN stream
// (payload.appSessionId) — a compaction is a fact about that session's context
// window, sibling to the token/cache facts `usage_block` already carries there.
export function compactionObserved(payload: CompactionObservedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.compactionObserved, payload };
}

// S8·4 (D64). Both ride the SESSION's own stream, beside the `compaction_observed`
// they bracket — the nudge that tried to make a compaction cheap, and the veto
// that bought time for it. Same-stream placement is also what lets the daemon's
// ledger fold ONE session's escalation memory with one bounded-free read.
export function compactionNudgeSent(payload: CompactionNudgeSentPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.compactionNudgeSent, payload };
}
export function compactionHeld(payload: CompactionHeldPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.compactionHeld, payload };
}

// ── S9·1 — the session-tree constructors (RESERVED, rule 0.5) ────────────────
//
// All three on NODES_STREAM, including `session_attached_to_node`: the tree is
// engine state scoped to no single session, and `projections/nodes.ts` folds
// only this stream (D34, stream-local). Nothing in the tree calls these yet —
// see the EVENT_TYPES block for the reservation note and for why there is no
// `nodeMoved` beside them.
export function nodeCreated(payload: NodeCreatedPayload): EventInput {
  return { stream: NODES_STREAM, type: EVENT_TYPES.nodeCreated, payload };
}
export function nodeClosed(payload: NodeClosedPayload): EventInput {
  return { stream: NODES_STREAM, type: EVENT_TYPES.nodeClosed, payload };
}
export function sessionAttachedToNode(payload: SessionAttachedToNodePayload): EventInput {
  return { stream: NODES_STREAM, type: EVENT_TYPES.sessionAttachedToNode, payload };
}

// checkout_removed (S17·U1 — see EVENT_TYPES.checkoutRemoved and the payload
// schema above). Same NODES_STREAM as its three siblings — it is a fact about
// a node's checkout, and `projections/nodes.ts` folds only this stream (D34) —
// even though the fold itself is deferred.
export function checkoutRemoved(payload: CheckoutRemovedPayload): EventInput {
  return { stream: NODES_STREAM, type: EVENT_TYPES.checkoutRemoved, payload };
}

// The task↔session link (step 4a). On the 'tasks' stream and NOT the session's
// stream: it is a fact about the TASK's record (`sessionRefs`), and the tasks
// projection folds only its own stream. The session's own birth record
// (`session_created`) already lives on the session stream.
export function taskSessionAttached(payload: TaskSessionAttachedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskSessionAttached, payload };
}

// The isolated worker directory (step 8). Same 'tasks' stream as its siblings: it
// is a fact about the TASK — where its work is happening — and the tasks
// projection folds only its own stream.
//
// ⚠ NO PROJECTION FOLDS THIS TODAY, DELIBERATELY. `TaskRecord` has no worktree
// field (slice 0 froze the record), and inventing one here would be a schema change
// nobody signed off in a step whose whole discipline is "ship it off". The event is
// the RECORD and the calibration column; a board column, if it is ever wanted, is a
// later projection decision made against real logs.
export function taskWorktreeCreated(payload: TaskWorktreeCreatedPayload): EventInput {
  return { stream: 'tasks', type: EVENT_TYPES.taskWorktreeCreated, payload };
}

// The course-correction pair (step 6a). BOTH on the SESSION's own stream — which
// is what makes the sessions projection's fold of them same-stream and therefore
// legal under D34 / architecture.md ("Projections are STREAM-LOCAL"). A
// correction is a fact about the SESSION being steered, not about the task that
// happens to own it; the task↔session link already lives on `sessionRefs`.
export function correctionQueued(payload: CorrectionQueuedPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.correctionQueued, payload };
}
export function correctionDelivered(payload: CorrectionDeliveredPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.correctionDelivered, payload };
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
export function hookPreCompact(payload: HookEventPayload): EventInput {
  return { stream: payload.appSessionId, type: EVENT_TYPES.hookPreCompact, payload };
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
  // S8·4 (D64) — the compaction door. Recorded like every sibling; what makes it
  // different is that the ingress ALSO answers it (`hold`/`allow`), and the relay
  // turns that answer into an exit code. The recording half is here so the log
  // carries the fire itself, veto or not.
  PreCompact: hookPreCompact,
};

// The hook event names registered in an injected per-session settings file — SIX
// since S8·4 added PreCompact (five from slice 2). Derived from the constructor
// map on purpose: a name the ingress cannot route is a name the settings file
// must not register, and vice versa.
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
