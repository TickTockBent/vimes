// @vimes/ext-host — the Tier-1 extension-host interface package (D-slice 18,
// §1/§3.2). v1 is a curated, EXACT-ORIGIN-ALLOWLISTED re-export surface over
// `@vimes/core`.
//
// §3.2's law: every statement here is a DIRECT re-export —
// `export { X } from '@vimes/core'` or `export type { X } from '@vimes/core'`
// — nothing else. No local declarations, no aliasing (`export { X as Y }`),
// no wrapper values, no `export *`. The public name MUST equal the upstream
// original symbol name. This is enforced two ways: the allowlist in
// `surface.json` (the interface artifact — its diff IS the changelog) and
// `scripts/check-ext-boundary.mjs` (the mechanical gate, run by ci-gate.sh).
// Extending this file means extending `surface.json` first, in the same
// reviewable diff — see the header there.

export type { TaskRecord, ReportCompletionPayload, ReportReviewPayload, StageRunnerPlan } from '@vimes/core';
export { canonicalJson } from '@vimes/core';
