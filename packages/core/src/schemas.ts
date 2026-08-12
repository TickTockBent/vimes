import { z } from 'zod';

export const sessionRecordSchema = z.object({
  appSessionId: z.string(),
  channel: z.enum(['sdk', 'pty']),
  cwd: z.string(),
  claudeSessionIds: z.array(
    z.object({
      id: z.string(),
      jsonlPath: z.string(),
      observedAt: z.string(),
    }),
  ),
  liveness: z.enum(['spawning', 'running', 'dormant', 'interrupted', 'dead']),
  needsAttention: z
    .object({
      // 'rate-limited' and 'brake' are reserved (rule 0.5): no setter emits
      // them yet — 'rate-limited' lands with slice 5 (StopFailure/
      // rate_limit_event), 'brake' with slice 7 (cascade guard).
      reason: z.enum(['gate', 'question', 'completed', 'stale', 'quarantined', 'rate-limited', 'brake']),
      since: z.string(),
    })
    .nullable(),
  seenAt: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  taskRef: z
    .object({
      taskId: z.string(),
      stage: z.string(),
    })
    .nullable(),
  observedTtlTier: z.enum(['1h', '5m', 'mixed', 'unknown']),
  observedBillingBucket: z.enum(['interactive', 'non-interactive', 'unknown']),
  name: z.string().nullable(),
  createdAt: z.string(),
  // D18 (E1): which provider hosts this session. MVP is Claude-only, so the
  // sessions projection stamps 'claude-code' whenever session_created omits it;
  // the field is reserved now so later payloads inherit the neutrality review.
  // Old snapshots (cache-class, rebuilt from the log) may lack it at runtime —
  // tolerated: nothing validates a snapshot's records against this schema on
  // load, and the next snapshot save self-heals.
  provider: z.string(),
  // D10: custody of the session's Claude process. 'host' — VIMES spawned it and
  // owns the process (writable, killable, resumable). 'external' — a
  // terminal-started/historical session VIMES only mirrors read-only via the
  // tailer; the host never writes to it and attention setters never fire for it,
  // until it is adopted (explicit or resume-through-VIMES). Defaulted to 'host'
  // at the projection when session_created omits it, so old logs/snapshots
  // tolerate — same neutrality posture as provider.
  custody: z.enum(['host', 'external']),
  // ── D34: the watchdog's heartbeat lives HERE, on the session ───────────────
  //
  // Both fields are OPTIONAL-only widenings, for the same reason `provider` and
  // `custody` document above: nothing validates a snapshot's records against
  // this schema on load, so a record written before these fields existed must
  // still load and serialize identically. The sessions projection therefore
  // leaves both ABSENT until the event that gives them a value folds.
  //
  // **Why here and not on the TaskRecord** (this is the whole of D34): a
  // projection may only fold events from its OWN stream — `bootFromSnapshot`
  // folds each stream to completion in alphabetical order and the log has no
  // global ordering column, so a tasks projection folding session appends folds
  // them in a different phase entirely (architecture.md, "Projections are
  // STREAM-LOCAL"). "When did this session last append?" is a fact about a
  // SESSION, and the session stream already carries the events that answer it.
  //
  // When this session was last observed APPENDING TO ITS TRANSCRIPT — advanced
  // only by `TRANSCRIPT_APPEND_EVENT_TYPES` (tasks/watchdogDecision.ts), i.e.
  // only by events the tailer derived from a real JSONL record. NEVER advanced
  // by daemon-authored bookkeeping; see the fold in projections/sessions.ts for
  // the self-defeating bug that rule prevents. Absent/null = never observed.
  lastAppendAt: z.string().nullable().optional(),
  // How many `watchdog_stale` records this session has accumulated.
  //
  // ⚠ NAMED FOR WHAT IT COUNTS. These are stale EPISODES, not retries: the
  // watchdog performs NO retries — nothing nudges, re-prompts or restarts a run
  // (slice 6 step 5b). The slice-0 name `staleRetries` described a mechanism
  // that was never built, and D34 is the moment it stops being carried forward.
  staleEpisodes: z.number().optional(),
  // ── D5/D30: a correction is QUEUED here until it is observed DELIVERED ─────
  //
  // OPTIONAL-only, for the same reason the two D34 fields above are: nothing
  // validates a snapshot's records against this schema on load, so a record
  // written before this field existed must still load and serialize identically.
  // The sessions projection leaves it ABSENT until a `correction_queued` folds.
  //
  // The `ts` of the last `correction_queued` VIMES accepted, cleared to `null`
  // when the matching `correction_delivered` is observed in the transcript.
  //
  // **The reason this field exists at all is the watchdog.** D5 measured a
  // correction sitting in the SDK queue for 30.4 s against a 40 s tool, with an
  // unbounded worst case, because injection does not preempt an in-flight tool.
  // A run being steered therefore looks EXACTLY like a run going quiet — and
  // D30 says in as many words that a queued-but-undelivered correction is NOT
  // staleness. Without this field the watchdog reports a healthy corrected run
  // as stale, which raises attention, which pushes a notification to a real
  // person's phone about work that was fine.
  pendingCorrectionAt: z.string().nullable().optional(),
  // ── D35: is a model turn actually IN FLIGHT right now? ────────────────────
  //
  // OPTIONAL-only, exactly like the three fields above and for the same reason:
  // a record written before this field existed must still load and serialize
  // identically, so the projection leaves it ABSENT until a `message` sets it.
  // (`.optional()` without `.nullable()` matches `staleEpisodes` — the cleared
  // value here is `false`, a real value, not "cleared to null"; there is no
  // third state to encode.)
  //
  // ⚠ **THIS IS NOT `liveness`, AND CONFUSING THE TWO IS THE DEFECT D35 WAS
  // WRITTEN ABOUT.** `liveness: 'running'` means the PROCESS is alive; an SDK
  // session sits in streaming-input mode, `running`, from `liveness_changed
  // {cause:'spawn'}` onward — before any prompt exists. `turnInFlight` means a
  // turn VIMES delivered has not finished yet. Session `138d3ef4` was `running`
  // with no turn in flight and got its opening prompt recorded as a
  // course-correction; that trace is why the two facts are separate fields.
  //
  // Set by `message` (VIMES delivered a turn), cleared by `run_completed` (the
  // turn ended) and by a `liveness_changed` to a non-live state. NEVER set by
  // liveness — see the fold in projections/sessions.ts.
  turnInFlight: z.boolean().optional(),
  // ── Q3: the SYSTEM-owned title, and the reason `name` is not it ────────────
  //
  // OPTIONAL-only, exactly like the four fields above and for the same reason:
  // nothing validates a snapshot's records against this schema on load, so a
  // record written before this field existed must still load and serialize
  // identically (I6). **ABSENT STAYS ABSENT, NEVER `''`** — the same discipline
  // `taskRecordSchema.title` documents: an empty string is a title someone
  // chose, and an untitled session is a different fact from a session titled
  // with nothing.
  //
  // ⚠ **TWO FIELDS, AND THE SYSTEM WRITES ONLY THIS ONE.** Wes's rule is *"if a
  // user name has been set the system never automatically changes it"*. `name`
  // has exactly two writers, both HUMAN — `session_created` (the spawn op's
  // optional name) and `session_renamed` (one emitter, `renameSession`,
  // reachable only from the WS `rename` op). The auto-titler writes
  // `derivedTitle` and nothing else, so the rule is not something a future
  // change can forget: it is IMPOSSIBLE, because the code that would break it
  // does not touch that field. Display resolves `name ?? derivedTitle ??
  // <fallback>` (core/sessionIdentity.ts `resolveSessionLabel`).
  //
  // **No flag is needed.** `name !== null` already means "a human chose this".
  //
  // WRITE-ONCE: set from the first qualifying user `message` and never changed
  // after, so a long session does not re-title itself on every prompt and a
  // replay produces the same value as a live fold (I6).
  derivedTitle: z.string().optional(),
  // ── D56 (S8·3): this session IS the standing orchestrator for that project ──
  //
  // OPTIONAL-only, exactly like the five fields above and for the same reason: a
  // record written before this field existed must still load and serialize
  // identically (I6), so the sessions projection leaves it ABSENT unless the
  // birth record carried it. **ABSENT STAYS ABSENT, NEVER `''`** — an ordinary
  // session is not "the orchestrator of nothing", it simply has no such key.
  //
  // ⚠ **PRESENCE IS THE KIND.** There is no `kind: 'orchestrator'` companion
  // field: the projectId this session stands for and the fact that it stands for
  // one are ONE fact, and splitting them would create a pair that can disagree.
  // Readers ask `record.orchestratorForProjectId === projectId`, which is both
  // the identity test and the D56 singleton's key.
  //
  // WRITE-ONCE BY CONSTRUCTION: `session_created` is the only event that carries
  // it, and a session is born once. A transcript that rotates (D56/D57) does so
  // by FOUNDING A NEW SESSION carrying the same projectId — the previous record
  // keeps its own marking, which is exactly what makes the rotation legible in
  // the log rather than a field that quietly moved.
  orchestratorForProjectId: z.string().optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const eventRecordSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().positive(),
  stream: z.string(),
  ts: z.string(),
  type: z.string(),
  payload: z.unknown(),
});
export type EventRecord = z.infer<typeof eventRecordSchema>;

export const eventInputSchema = z.object({
  stream: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
});
export type EventInput = z.infer<typeof eventInputSchema>;

// ⚠ **`version` IS D86'S CARRIER AND IT IS REQUIRED** (2026-08-12). It is the
// RECORD-SHAPE version of the projection that wrote the state — not the event
// log's `schemaVersion()`, which is a fact about the spine and which nothing
// branches on. `bootFromSnapshot` compares it against the projection's declared
// `version` and treats a difference exactly as no-snapshot-found. Required
// rather than optional-defaulting-to-1 because a snapshot with no shape stamp
// is a snapshot nobody can reason about; stores that predate the field supply
// the default at the storage layer (see sqliteSnapshotStore's additive column),
// which is the one place where "written before D86" is a knowable fact.
export const projectionSnapshotSchema = z.object({
  projectionId: z.string(),
  version: z.number().int(),
  lastAppliedSeq: z.record(z.string(), z.number()),
  state: z.unknown(),
  savedAt: z.string(),
});
export type ProjectionSnapshot = z.infer<typeof projectionSnapshotSchema>;

// One acceptance criterion — INDIVIDUALLY ADDRESSABLE (D43: acceptance-as-a-list,
// not prose). `id` is STABLE across amendments so `report_review` (S7·6) can key
// per-criterion pass/fail to it; `text` is the human-readable criterion. Reserved
// in S7·1; the authoring form (S7·3) and report_review (S7·6) are the consumers.
export const acceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

// ── the stage vocabulary — HOISTED HERE BY S7·7b (D52 finding 1) ─────────────
//
// It lived in `tasks/taskStateMachine.ts` and was DERIVED from
// `taskRecordSchema.shape.stage`. That direction became impossible the moment
// `taskRecordSchema` gained `lastReview`/`lastCompletion`: those fields are typed
// by the report payload schemas, the report payloads are keyed by stage, and the
// stage came back off the record — a cycle inside one file, and a cycle between
// `schemas.ts` and `tasks/` across files (D52 finding 1, deferred from S7·6a to
// here precisely so it could be resolved with its consumer).
//
// The resolution is to make `schemas.ts` the TRUE LEAF: the enum is declared here
// once, `taskRecordSchema.stage` consumes it, and everything downstream — the
// state machine, the work-order payloads, the event payloads — imports it from
// here. The one-source-of-record rule (principle 9) is unchanged; only the
// direction of derivation flipped, from record → enum to enum → record.
//
// ⚠ `tasks/taskStateMachine.ts` RE-EXPORTS `taskStageSchema`/`TaskStage`, so every
// pre-S7·7b import path (`from './taskStateMachine.js'`, and the package index)
// still resolves. Do not "clean that up" without checking the consumers.
export const taskStageSchema = z.enum([
  'backlog',
  'planning',
  'plan-ready',
  'implementing',
  'review',
  'done',
  'blocked-external',
  'quarantined',
  'cancelled',
]);
export type TaskStage = z.infer<typeof taskStageSchema>;

// ── the two REPORT payloads — HOISTED HERE BY S7·7b (D52 finding 1) ──────────
//
// Both lived in `tasks/workOrder.ts`. They move here for one reason: they are the
// TYPES OF TWO TASK-RECORD FIELDS (`lastReview` / `lastCompletion`, below), and a
// leaf module cannot import from a module that imports it. `workOrder.ts`
// RE-EXPORTS both, so `events.ts`, `tasks/reviewOutcome.ts`, the package index and
// every test keep their existing import paths.
//
// Everything ELSE in `workOrder.ts` (`submitPlanPayloadSchema`,
// `stageRunIdentitySchema`, `artifactEnvelopeSchema`, `scopedTokenBindingSchema`)
// deliberately STAYED there: nothing in this file consumes them, and hoisting a
// shape with no leaf-side consumer would be moving code for symmetry's sake.

// ── reportReviewPayloadSchema — per-criterion pass/fail (S7·6) ────────────────
//
// This is what makes acceptance-as-a-list (D43) earn its structure rather than
// being decorative: the reviewer reports AGAINST the list, one verdict per
// criterion, keyed by `criterionId` back to `acceptanceCriterionSchema.id` on
// the task record. A review that could only say "pass" or "fail" for the whole
// task would make the list's individual addressability pointless. Consumers:
// S7·6 (`review_reported` + `deriveReviewOutcome` + the daemon's `report_review`
// tool) and S7·7b (`lastReview` below + the fix-seed briefing).
export const reportReviewPayloadSchema = z.object({
  taskId: z.string(),
  stage: taskStageSchema,
  attempt: z.number().int().positive(),
  workOrderRev: z.number().int().nonnegative(),
  criteria: z.array(
    z.object({
      // Keys to `acceptanceCriterionSchema.id` on the task record. DERIVED
      // rather than re-typed as `z.string()`, so the two can never drift apart
      // (principle 9, the same reason `taskCreatedPayloadSchema.title` derives
      // from `taskRecordSchema.shape.title` rather than restating it).
      criterionId: acceptanceCriterionSchema.shape.id,
      verdict: z.enum(['pass', 'fail']),
      note: z.string().optional(),
    }),
  ),
});
export type ReportReviewPayload = z.infer<typeof reportReviewPayloadSchema>;

// ── reportCompletionPayloadSchema — the worklog fix-seed (D46) ────────────────
//
// D46: because every stage run spawns fresh, a fixer handed a failed review
// starts with NO memory of what the previous attempt already tried and
// rejected. What it loses is the DEAD ENDS, not the code (the code is on disk,
// in the worktree, in the diff — D53's rider has the fixer read it with
// `git diff` rather than the dispatcher inlining it) — so the worklog is the
// FIX-SEED that carries those dead ends forward, on purpose, so a fresh fixer
// does not re-explore paths already rejected on our tokens. Consumers: S7·7b
// (`lastCompletion` below + the fix-seed briefing) and S7·7b-daemon (the
// `report_completion` tool that writes it).
export const reportCompletionPayloadSchema = z.object({
  taskId: z.string(),
  stage: taskStageSchema,
  attempt: z.number().int().positive(),
  workOrderRev: z.number().int().nonnegative(),
  worklog: z.object({
    decisionsMade: z.array(z.string()),
    pathsRejected: z.array(z.string()),
  }),
});
export type ReportCompletionPayload = z.infer<typeof reportCompletionPayloadSchema>;

export const taskRecordSchema = z.object({
  taskId: z.string(),
  projectRoot: z.string(),
  // ⚠ ADDED IN SLICE 6 STEP 9, **OPTIONAL-ONLY** — the same widening discipline
  // `gates` followed in step 4b and `meterRecordSchema` documents above. A task
  // had no human-readable name at all until now, which made a board labelled by
  // UUID the only board that could exist. Every `task_created` already written
  // omits it, still validates, and still serializes to the same bytes (I6).
  //
  // ⚠ **ABSENT STAYS ABSENT, NEVER `''`.** The projection does not default this
  // the way it defaults `gates` to `{}`: an empty string is a title someone
  // chose, and an untitled task is a different fact from a task titled with
  // nothing. The UI falls back to a short taskId rather than rendering a blank.
  //
  // Set at creation ONLY. There is deliberately no `task_renamed` event and no
  // PATCH — renaming would need its own decision (sessions have
  // `session_renamed` as the precedent if it is ever wanted).
  title: z.string().optional(),
  // ── S7·1 (rule 0.5): the work-order fields, reserved with NO consumer yet ──
  //
  // All five below are OPTIONAL-only widenings, for the exact reason `title`
  // above documents: nothing validates a snapshot's records against this schema
  // on load, so a `task_created` written before slice 7 omits every one of
  // these, still validates, and still serializes to the SAME BYTES (I6). This
  // unit adds no new required field to an existing record — that is the whole
  // discipline that keeps I6 assertable.
  //
  // ⚠ **ABSENT STAYS ABSENT.** Unlike `gates`, which the projection defaults to
  // `{}` because an ungated task and a task with no gates are the same fact, no
  // fold ever turns one of these from absent to present on its own: S7·1 shipped
  // the reservation with no fold at all, and the folds that followed (S7·2a's
  // birth-record spread, S7·2b's amendment patch) each SPREAD a field only when
  // the event carries it. A pre-slice-7 `task_created` still folds to a record
  // with NONE of these keys, exactly as it did before the widening landed.
  //
  // The first consumer of the four authored fields was S7·2a (`create_task`);
  // S7·2b (`work_order_amended`) is the second, and the only one that can change
  // them after birth.
  scope: z.string().optional(),
  explicitlyOut: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).optional(),
  killCriterion: z.string().optional(),
  // The work-order revision this record currently reflects (D43: revisioned,
  // not mutated). ABSENT UNTIL THE FIRST AMENDMENT — a never-amended task has no
  // such key, and the readers that need a number (`recordPlan`, `recordReview`,
  // `recordCompletion`) spell that as `?? 0` rather than the record defaulting it.
  // The writer is S7·2b: `TaskWriter.amendWorkOrder` computes the next rev and
  // states it on the `work_order_amended` payload, and the fold records what the
  // payload says — this field is never derived by counting events.
  workOrderRev: z.number().int().nonnegative().optional(),
  // The content hash of the CURRENT plan artifact submitted for this task (D48,
  // S7·5a). The plan BLOB lives in the artifact store; the record carries only the
  // reference, so the handoff (S7·7a) fetches the plan by hash. OPTIONAL-only, same
  // I6 discipline as the work-order fields above: a task with no plan submitted yet
  // has NO such key (absent stays absent — the projection does not default it), so
  // every pre-S7·5a task_created folds byte-identically. LATEST-WINS: a re-plan
  // overwrites it (see the fold). Consumer: S7·7a (handoff) + the board.
  planArtifactHash: z.string().optional(),
  // ── S7·7b: the FIX-SEED fields (D46) — the review that sent this task back,
  // and the worklog of the attempt it sent back ────────────────────────────────
  //
  // Both are OPTIONAL-only widenings, same I6 discipline as `planArtifactHash`
  // above and the S7·1 work-order fields: nothing validates a snapshot's records
  // against this schema on load, so a task that has never been reviewed and never
  // reported a completion folds to a record with NEITHER key present —
  // byte-identical to what it folded to before this widening landed. **ABSENT
  // STAYS ABSENT**; the projection does not default either one, and an
  // `undefined`-but-present key would change the serialized bytes.
  //
  // LATEST-WINS, like `planArtifactHash` and unlike `sessionRefs`' accumulation:
  // the LOG keeps every report ever made (that is the audit trail), the RECORD
  // keeps only the newest, because the fix-seed the next implementer needs is the
  // review that just failed it and the worklog of the attempt that just ended —
  // never a history of every lap round the loop.
  //
  // ⚠ These carry the report payload WHOLE (not just `criteria`/`worklog`): the
  // `(taskId, stage, attempt, workOrderRev)` prefix is what makes a stored report
  // attributable to a specific run (D46's identity tuple), and dropping it here
  // would leave the board unable to say WHICH attempt a piece of feedback judged.
  // Consumer: `composeStageInstruction`'s fix-seed branch (S7·7b) via the daemon.
  lastReview: reportReviewPayloadSchema.optional(),
  lastCompletion: reportCompletionPayloadSchema.optional(),
  // The stage enum itself is declared ABOVE as `taskStageSchema` and consumed
  // here, rather than declared inline and derived back out — see the hoist note
  // on `taskStageSchema` for why that direction had to flip in S7·7b.
  stage: taskStageSchema,
  manualReviewRequired: z.boolean(),
  isolation: z.enum(['shared-dir', 'worktree']),
  gates: z.object({
    deferUntilReset: z.string().optional(),
    requireHeadroom: z
      .object({
        meterId: z.string(),
        pct: z.number(),
      })
      .optional(),
  }),
  sessionRefs: z.array(
    z.object({
      stage: z.string(),
      appSessionId: z.string(),
    }),
  ),
  createdBy: z.enum(['human', 'orchestrator']),
  // ⚠ **RETIRED by D34 (2026-07-22). NOTHING WRITES THIS FIELD.** Superseded by
  // `SessionRecord.lastAppendAt`, which is where the heartbeat now lives: a
  // projection may only fold events from its own stream, and the appends that
  // move a heartbeat are SESSION-stream events (architecture.md, "Projections
  // are STREAM-LOCAL"). The tasks projection sets this to `null` at birth and
  // never touches it again — a reserved field left looking live is how the next
  // person rebuilds the cross-stream fold D34 exists to prevent. RETAINED
  // rather than deleted because removing it is a breaking schema change that
  // needs its own decision; read the heartbeat off the session record instead.
  lastHeartbeatAt: z.string().nullable(),
  // ⚠ **RETIRED by D34 (2026-07-22). NOTHING WRITES THIS FIELD.** Superseded by
  // `SessionRecord.staleEpisodes` — same stream-locality reason as above, plus
  // the name: the watchdog counts stale EPISODES and performs no retries at
  // all. Stays at `0` forever. Same retention rationale as `lastHeartbeatAt`.
  staleRetries: z.number(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

// ── the PROJECT record (S8·1, D42) ───────────────────────────────────────────
//
// D42: a project is a **DECLARED** boundary — a directory the user picked — and
// never an inferred one (D37 refused inference on Wes's own objection, and this
// record is the boundary D37 withheld, supplied by a human instead of a
// heuristic). The registry is EVENT-SOURCED rather than config: projects are
// created at runtime, carry mutable user metadata, and have a lifecycle
// (created → optionally initialized → optionally archived), which is event-log
// state (rule 0.3, I12), not something an operator edits into a file.
//
// ⚠ **`root` IS THE BOUNDARY, AND IT IS THE ONE FIELD NOTHING PATCHES.** The
// directory IS the project (D42), so a different directory is a different
// project — see `project_updated`'s note in events.ts. Everything a user may
// change afterwards is metadata.
//
// ⚠ **ABSENT STAYS ABSENT for `name`/`description`, NEVER `''`** — the same
// discipline `taskRecordSchema.title` documents, and here it is load-bearing
// twice over. D42 says an unnamed project displays its directory BASENAME, and
// that fallback is a **READ-TIME derivation, never stored**: writing the
// basename into the record at creation would make "named after its folder" and
// "deliberately named the same as its folder" the same fact, and a later folder
// rename would leave a stale name nobody typed. An empty string is a name
// someone chose; an absent key is a project nobody named.
//
// `archived` is REQUIRED and always present: D42's lifecycle is archive, NOT
// delete — nothing is ever removed from the log, and the projection keeps an
// archived project's record in the map with the flag raised (history
// attribution over its cwd prefix has to keep working after archiving). A
// boolean that is always written is a different shape from the optional
// metadata above precisely because "not archived" is a fact about every project,
// where "no description" is the absence of one.
//
// ⚠ **`createdAt` IS THE DURABLE CREATION MARKER (S14-F2, 2026-08-12).** It is
// the `ts` of the project's own `project_created` record — the `SessionRecord.createdAt`
// precedent, spelled the same way and for the same reason. Before it existed,
// "project-creation order" survived only as the projection map's INSERTION
// order, which is exact on a fresh fold and silently lexicographic-by-projectId
// after the first snapshot round-trip (`canonicalJson` sorts object keys
// deeply). The tree's root ordering sorts on this field, so the order a client
// renders is a function of the RECORDS rather than of how the state was
// reconstructed.
//
// REQUIRED, never optional: every project has a birth event, so there is no
// honest absence to express — and an optional marker would put `undefined` in a
// comparator, which is the ordering lie wearing a different hat. Adding it is a
// RECORD-SHAPE change, so `projectsProjection.version` bumps to 2 (D86); stored
// version-1 snapshots are discarded and replayed rather than read through this
// shape.
export const projectRecordSchema = z.object({
  projectId: z.string(),
  root: z.string(),
  createdAt: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  archived: z.boolean(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

// D26 (2026-07-21, signed off): the authoritative usage source reports
// PERCENTAGES ONLY. `percent` + `unit` are explicit; `used`/`limit` are optional
// and present ONLY when a source actually supplies absolutes. A percentage is
// NEVER collapsed into `used = 29, limit = 100` — manufacturing an absolute the
// source never gave is precisely the lying meter pillar 4 forbids.
//
// Every widening here is OPTIONAL-only, so records written against the slice-0
// shape (the `budget-wall` harness profile, the daemon boot tests) still
// validate unchanged and serialize to the same bytes.
export const meterRecordSchema = z.object({
  meterId: z.string(),
  kind: z.enum(['rolling-window', 'weekly-cap', 'monthly-credit']),
  // Widened from the slice-0 enum to a free string: the endpoint's `limits[]`
  // entries scope a weekly cap to a model name (U1), which no closed enum can
  // enumerate without drifting (rule 0.6). The old enum values still validate.
  scope: z.string().nullable().optional(),
  // Legacy, superseded by `scope`. Optional so a percent-only source need not
  // invent it.
  modelFamily: z.string().nullable().optional(),
  // 0..100 — the observed utilization, the ONLY quantity the endpoint gives us.
  percent: z.number().nullable().optional(),
  // Absolutes: present only when a source genuinely supplies them (D26).
  used: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  // What `used`/`limit` are denominated in; null/absent when there are none.
  unit: z.enum(['tokens', 'percent', 'usd']).nullable().optional(),
  // The SERVER's own judgement (U1) — preferred over a local ⟨tune 80%⟩
  // threshold wherever it is present.
  severity: z.string().nullable().optional(),
  // Whether this is the currently BINDING limit, per the source (U1).
  isActive: z.boolean().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  source: z.enum(['jsonl', 'otel', 'endpoint']),
  // REQUIRED on every sample, so freshness is always DERIVABLE.
  observedAt: z.string(),
  // DEPRECATED (D26): freshness is derived by `meterFreshness`, never stored —
  // a stored flag lets a stale record masquerade as fresh. Retained as an
  // optional field only so slice-0-era records keep validating; no derivation
  // in meterDerivations.ts reads it.
  stale: z.boolean().nullable().optional(),
});
export type MeterRecord = z.infer<typeof meterRecordSchema>;

export const achievementProgressSchema = z.object({
  achievementId: z.string(),
  progress: z.number(),
  target: z.number(),
  unlockedAt: z.string().nullable(),
  sourceEventIds: z.array(z.string()),
});
export type AchievementProgress = z.infer<typeof achievementProgressSchema>;
