// ─── S7·1 — the task-as-work-order shapes (RESERVED, packages/core) ──────────
//
// Rule 0.5: schema reservations are cheap; retrofits are expensive. Every
// shape in this module is a slice-7 data shape landed AHEAD of its consumer —
// the spec-and-verify loop D43/D44/D46 describe — with the machinery it feeds
// still stubbed. Each export below names its consumer explicitly, and until
// that consumer's unit lands, NOTHING in the daemon, the dispatcher, any MCP
// server or the UI constructs, reads, or persists one of these. They exist so
// the later units need no migration, exactly the way `dispatch_refused` was
// reserved (slice 0) ahead of its emitter (slice 6).
//
// Direction: workOrder.ts → { schemas.ts, taskStateMachine.ts }. Both of those
// are leaves relative to this module (neither imports from `tasks/workOrder.js`),
// so this dependency introduces no cycle.

import { z } from 'zod';
import { acceptanceCriterionSchema } from '../schemas.js';
import { taskStageSchema } from './taskStateMachine.js';

// ── 1. stageRunIdentitySchema — D46's stage-run identity tuple ────────────────
//
// D46: every stage run — whether it was spawned to STEER an in-flight attempt
// or to carry an AMENDMENT — spawns fresh. There is no in-place resume of a
// stage run; a new run is a new attempt, always. That makes the tuple below the
// full identity of one stage run: `(taskId, stage, attempt, workOrderRev)`
// names exactly which task, which stage, which numbered spawn, and which
// work-order revision it was dispatched against. Consumer: S7·7a (the handoff
// that hands a fresh worker its run identity).
export const stageRunIdentitySchema = z.object({
  taskId: z.string(),
  stage: taskStageSchema,
  // 1-based. A fresh spawn is a new attempt — this is never reused for the
  // "same" run resumed; D46 says explicitly that no such resume exists.
  attempt: z.number().int().positive(),
  workOrderRev: z.number().int().nonnegative(),
});
export type StageRunIdentity = z.infer<typeof stageRunIdentitySchema>;

// ── 2. artifactEnvelopeSchema — the content-addressed blob envelope ───────────
//
// Slice-7 floor piece 1. The artifact STORE is a daemon concern (out of scope
// here, per the work-order); this is only the envelope shape a stored artifact
// carries. `kind` is `z.string()` and NOT an enum ON PURPOSE — it is RESERVED
// OPEN. The consumer (S7·4) is the one that gets to decide whether 'plan' |
// 'diff' | 'review' | … is the right closed set, and pinning it here would be
// deciding that question a slice early, with no dedup or GC policy behind it
// yet either — both are EXPLICITLY DEFERRED to S7·4.
export const artifactEnvelopeSchema = z.object({
  // The content address of the blob.
  hash: z.string(),
  // Reserved open — see the module note above. S7·4 pins this if it must.
  kind: z.string(),
  taskRef: z.object({ taskId: z.string(), stage: z.string() }),
  // The workOrderRev the artifact was produced against.
  rev: z.number().int().nonnegative(),
  // The session that produced it.
  createdBy: z.object({ appSessionId: z.string() }),
  createdAt: z.string(),
});
export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;

// ── 3. submitPlanPayloadSchema — the `submit_plan` MCP tool payload ───────────
//
// D44: a plan crosses the tool boundary and is VALIDATED IN-RUN, and this is
// the shape that crossing takes. The plan CONTENT itself does NOT live here —
// it lives in the artifact blob referenced by `planArtifactHash` — this payload
// carries it BY REFERENCE only, plus the run identity and the planner session
// so the record can be tied back to who produced it. Consumer: S7·5.
export const submitPlanPayloadSchema = z.object({
  taskId: z.string(),
  stage: taskStageSchema,
  attempt: z.number().int().positive(),
  workOrderRev: z.number().int().nonnegative(),
  // The plan blob's address in the artifact store — see artifactEnvelopeSchema.
  planArtifactHash: z.string(),
  plannerSessionRef: z.object({ appSessionId: z.string() }),
});
export type SubmitPlanPayload = z.infer<typeof submitPlanPayloadSchema>;

// ── 4. reportReviewPayloadSchema — per-criterion pass/fail (S7·6) ─────────────
//
// This is what makes acceptance-as-a-list (D43) earn its structure rather than
// being decorative: the reviewer reports AGAINST the list, one verdict per
// criterion, keyed by `criterionId` back to `acceptanceCriterionSchema.id` on
// the task record. A review that could only say "pass" or "fail" for the whole
// task would make the list's individual addressability pointless. Consumer:
// S7·6.
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

// ── 5. reportCompletionPayloadSchema — the worklog fix-seed (D46) ─────────────
//
// D46: because every stage run spawns fresh, a fixer handed a failed review
// starts with NO memory of what the previous attempt already tried and
// rejected. What it loses is the DEAD ENDS, not the code (the code is on disk,
// in the worktree, in the diff) — so the worklog is the FIX-SEED that carries
// those dead ends forward, on purpose, so a fresh fixer does not re-explore
// paths already rejected on our tokens. Consumer: S7·6 (the report tool that
// writes it) and S7·7b (the fix-seed composition that reads it back).
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

// ── 6. scopedTokenBindingSchema — what a per-role credential is bound to ──────
//
// Slice-7 floor piece 2 (S7·5 confirms). Binds a credential to
// `(taskId, stage, attempt)` so, for example, a planner's credential may
// `submit_plan` ONLY for its own run — not for any other task, stage, or
// attempt. `workOrderRev` is DELIBERATELY NOT part of the binding: a token
// authorizes the RUN, not a specific revision of the work order: which rev the
// run was dispatched against is recorded on `stageRunIdentitySchema`, not
// gated by the credential. This is the binding SHAPE only — no secret or
// credential material lives in `packages/core`; issuing and checking tokens is
// a daemon concern.
export const scopedTokenBindingSchema = z.object({
  taskId: z.string(),
  stage: taskStageSchema,
  attempt: z.number().int().positive(),
});
export type ScopedTokenBinding = z.infer<typeof scopedTokenBindingSchema>;
