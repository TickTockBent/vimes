// ─── S20·U1 (slice-20 §3.5) — the ENGINE REPORT-VERB CATALOGUE, one home ─────
//
// What the engine can actually mount as a stage-run report tool, and what SHAPE
// of body each of those tools files. Two facts, one place.
//
// ⚠ **RE-HOMED FROM `packages/daemon/src/briefingDeclarations.ts` (S19·U1), NOT
// COPIED.** S19 authored the id set in the daemon under a documented "one place"
// contract; slice-20 §3.5 needs the SAME set inside core's parser (the
// `acceptance.report` catalogue rules, manifest.ts), and core cannot import from
// the daemon. A second spelling would break a signed invariant rather than
// merely risk drift (slice-20 §0.12, Sol round-3 P1b), so the constants MOVED
// here — beside `events.ts` / `tasks/workOrder.ts`, which hold the very body
// schemas the map below points at — and `briefingDeclarations.ts` now
// RE-EXPORTS them so every daemon consumer keeps reading one constant.
//
// ── why the ids are still AUTHORED rather than read from the host ────────────
//
// (S19's reasoning, preserved verbatim in substance and re-pointed to this
// home.) The names are spelled inside `sessionHost.ts`'s `buildReviewSpec` /
// `buildCompletionSpec`, both PRIVATE METHODS on `SessionHost`; the server name
// is that module's local `DEFAULT_TOOL_SERVER`. Neither is exported, and the
// specs cannot even be constructed before `spawnSession` allocates the session
// id they close over — which is why the declaration path carries IDS across the
// seam instead of specs (slice-19 §3.6).
//
// So THIS MODULE is the one place the id set is written in the declaration path
// — every consumer (the daemon preflight's validation, the parser's catalogue
// rules, the tests' expectations) reads THESE constants and never a second copy.
// The tie to the host is a MACHINE CHECK, not a comment:
// `briefingPreflight.test.ts`'s A2 differential compares the ids a dispatched
// stage actually mounts against this set, so renaming a tool in `sessionHost.ts`
// reddens the differential instead of quietly refusing a declaration that used
// to be legal. That differential still passes UNCHANGED across this relocation
// — it is the machine check guarding the move.

/**
 * The in-process MCP server the stage-run report tools mount under (D65). The
 * model sees `mcp__vimes_report__<tool>`; the manifest spells the same fact
 * `vimes_report.<tool>`.
 */
export const ENGINE_REPORT_TOOL_SERVER = 'vimes_report';

/**
 * What SHAPE of body each catalogue verb files — the fact slice-20 §3.5's
 * ASYMMETRIC compatibility matrix is decided against.
 *
 *   • `criteria` — a per-criterion pass/fail list (`reportReviewPayloadSchema`,
 *     schemas.ts): contents a rubric can DERIVE a verdict from.
 *   • `worklog`  — the fix-seed worklog (`reportCompletionPayloadSchema`): a
 *     real, schema-valid report that carries no per-criterion verdicts at all.
 */
export type EngineReportBodyKind = 'criteria' | 'worklog';

/**
 * ⚠ **THE ROOT OF THE CATALOGUE — the only place a report tool NAME is spelled.**
 * Everything else in this module is derived from it, so a new catalogue verb is
 * ONE row here and nothing else. `report_filed` is a CLOSED two-member
 * discriminated union (events.ts) — review and completion bodies only — so this
 * table is the WHOLE truth about what an `acceptance.report` can ever receive at
 * Tier 1 (slice-20 §0.11). That is what lets the parser refuse a `rubric` bound
 * to a body with no criteria in it, and what keeps `scalar` honestly dormant: no
 * current body carries dimensions.
 *
 * Insertion order IS the catalogue order the derived arrays below publish.
 */
const ENGINE_REPORT_BODY_BY_TOOL_NAME: Readonly<Record<string, EngineReportBodyKind>> = {
  report_review: 'criteria',
  report_completion: 'worklog',
};

/** The report tools this engine knows how to build, by their bare spec names. */
export const ENGINE_REPORT_TOOL_NAMES: readonly string[] = Object.keys(
  ENGINE_REPORT_BODY_BY_TOOL_NAME,
);

/**
 * The engine-known report tool IDS, in the spelling a manifest uses:
 * `<server>.<tool>`. DERIVED from the two constants above rather than listed
 * again, so the server name and the tool names each have exactly one home.
 */
export const ENGINE_REPORT_TOOL_IDS: readonly string[] = ENGINE_REPORT_TOOL_NAMES.map(
  (toolName) => `${ENGINE_REPORT_TOOL_SERVER}.${toolName}`,
);

/** Is this declared tool id one the engine can actually mount? Fail-closed. */
export function isEngineKnownToolId(toolId: string): boolean {
  return ENGINE_REPORT_TOOL_IDS.includes(toolId);
}

/**
 * The catalogue the DECLARATION path reads: `{ verb id → body kind }`, in the
 * spelling a manifest uses.
 *
 * ⚠ KEYED BY THE DERIVED IDS, never by re-spelled strings — the whole point of
 * the single home is that `report_review` is written exactly once, in
 * `ENGINE_REPORT_BODY_BY_TOOL_NAME` above, and the server name exactly once in
 * `ENGINE_REPORT_TOOL_SERVER`. This map is the composition of the two.
 *
 * Consumer: the manifest parser's `acceptance.report` catalogue rules
 * (slice-20 §3.5), injected through `ParseManifestOptions.reportVerbCatalogue`
 * so every refusal is testable against a synthetic catalogue. The EVALUATOR
 * deliberately does not read this map — by the time a table is evaluated the
 * parser has already proved the binding compatible, and `kind = "report"` is
 * existence-only (§3.5's asymmetry).
 */
export const ENGINE_REPORT_VERB_BODIES: Readonly<Record<string, EngineReportBodyKind>> =
  Object.fromEntries(
    Object.entries(ENGINE_REPORT_BODY_BY_TOOL_NAME).map(([toolName, bodyKind]) => [
      `${ENGINE_REPORT_TOOL_SERVER}.${toolName}`,
      bodyKind,
    ]),
  );
