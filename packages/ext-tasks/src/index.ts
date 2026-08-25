// @vimes/ext-tasks — the task tenant (D-slice 18, §1/§3.4).
//
// Empty on day one BY DESIGN: S18·U1 builds the walls (this package, its
// wiring, and the boundary checker) without moving any product code. S18·U2
// populates this barrel with `stageInstruction.ts` (verbatim) and
// `createTaskToolPayloadSchema` (split out of `workOrder.ts`); later
// per-declaration moves add the rest of the map's tenant rows. `@vimes/core`
// is absent from this package's dependencies — see package.json — and stays
// that way; everything this package needs from the engine comes through
// `@vimes/ext-host`'s curated re-export surface.
export {};
