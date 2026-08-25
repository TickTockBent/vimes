// @vimes/ext-tasks — the task tenant (D-slice 18, §1/§3.4).
//
// S18·U1 built the walls (this package, its wiring, and the boundary checker)
// without moving any product code. S18·U2 moved in the first furniture:
// `stageInstruction.ts` (VERBATIM — A6 byte-stability, everything below the
// import block unchanged) and `createTaskToolPayloadSchema` (split out of
// core's `workOrder.ts`); later per-declaration moves add the rest of the
// map's tenant rows. `@vimes/core` is absent from this package's dependencies
// — see package.json — and stays that way; everything this package needs from
// the engine comes through `@vimes/ext-host`'s curated re-export surface.
//
// ⚠ ROOT BARREL ONLY. The boundary checker refuses deep imports into this
// package, so anything a host needs must be named here.

// The dispatcher's instruction seam — WHAT a dispatched worker is told. Moved
// out of `packages/core/src/tasks/` by S18·U2; the words are tenant policy,
// the engine only decides WHETHER and WHO (`stageRunner`, `dispatchDecision`,
// both still core).
export { composeStageInstruction, type StageInstructionContext } from './stageInstruction.js';

// The `create_task` tool payload — WHICH work-order fields a task-authoring
// model may name, and which the daemon decides for it. Split out of core's
// `tasks/workOrder.ts` by S18·U2; the engine-bound shapes it sat beside stayed
// in core (§3.4 c1). Consumer: the daemon's `createTaskTool.ts`.
export { createTaskToolPayloadSchema, type CreateTaskToolPayload } from './createTaskPayload.js';

// S19·U1 (slice-19 §3.1) — the Tier-1 COMPOSER TABLE. `[…].briefing.composer`
// is an entry-point STRING; this is where the tenant resolves it. Thin wrappers
// over the prose module above — zero prose bytes moved — and no fallback row:
// an unresolvable entry point is a preflight refusal (§3.5), never a generic
// briefing. `BriefingInputs` is the tenant-side STRUCTURAL TWIN of the engine's
// `BriefingInputSet`; the two are joined in the daemon, and
// `packages/ext-host/surface.json` does not grow for it (A7 ⟨signed⟩).
export {
  briefingComposers,
  type BriefingComposer,
  type BriefingInputs,
  type ProjectedTaskRecord,
} from './briefingComposers.js';
