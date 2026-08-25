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
// Direction: workOrder.ts → schemas.ts, and NOTHING else. S7·7b (D52 finding 1)
// hoisted `taskStageSchema` and the two REPORT payload schemas into `schemas.ts`,
// which made that module the true leaf and removed this module's dependency on
// `taskStateMachine.ts` entirely. `schemas.ts` imports nothing but zod, so there
// is no cycle in either direction.
//
// ⚠ THE TWO REPORT PAYLOADS ARE RE-EXPORTED, NOT DECLARED, HERE. They had to move
// because `taskRecordSchema.lastReview`/`.lastCompletion` are typed by them and a
// leaf cannot import from a module that imports it. The re-export below is what
// keeps every existing `from '../tasks/workOrder.js'` import path valid — do not
// remove it without fixing events.ts, tasks/reviewOutcome.ts, the package index
// and their tests. (`projections/instances.ts` reaches for the report schemas at their
// new home, since S7·7b wrote its fold; it still imports `submitPlanPayloadSchema`
// from here.)

import { z } from 'zod';
import {
  reportCompletionPayloadSchema,
  reportReviewPayloadSchema,
  taskStageSchema,
  type ReportCompletionPayload,
  type ReportReviewPayload,
} from '../schemas.js';

export { reportReviewPayloadSchema, reportCompletionPayloadSchema };
export type { ReportReviewPayload, ReportCompletionPayload };

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

// ── 4/5. reportReviewPayloadSchema + reportCompletionPayloadSchema ────────────
//
// MOVED TO `schemas.ts` BY S7·7b (D52 finding 1) and RE-EXPORTED at the top of
// this file, so this module's public surface is unchanged. They are declared
// beside `taskRecordSchema` now because they are the TYPES OF TWO OF ITS FIELDS
// (`lastReview` / `lastCompletion`); read them, and the reasoning for the move,
// there. The numbering below keeps its original position so the section numbers
// in this file do not renumber under anyone's cross-reference.

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

// ── 7. createTaskToolPayloadSchema — the `create_task` MCP tool payload ───────
//
// MOVED TO `@vimes/ext-tasks` BY S18·U2 (Move 4, `docs/slice-18.md` §3.4), with
// its whole doctrine comment — read it, and the reasoning behind every field it
// refuses, at `packages/ext-tasks/src/createTaskPayload.ts`. It went because it
// is the tenant's half of this module: it says what a task-authoring MODEL may
// name, and it had no core consumer to hold it here (the daemon's
// `createTaskTool.ts` was its only reader). Everything above stayed — the
// identity tuple is engine, and `submitPlanPayloadSchema` plus the report
// payloads are bound by `events.ts` at runtime (§3.4 c1). This heading keeps its
// position and its number so the section numbers in this file do not renumber
// under anyone's cross-reference, exactly as sections 4/5 above do.
