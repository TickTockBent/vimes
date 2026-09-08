import type { ParsedWorkflow } from '@vimes/core';

// ─── S20·U1 (slice-20 §3.3) — READING the boot declaration's ACCEPTANCE ──────
//
// One question in two directions: **what does the BOOT-RESOLVED declaration say
// this node accepts** — and, going backwards, **which node does a filed report
// verb belong to?** The second direction is the one the dispatcher's hard-coded
// stage literals stand in for today (slice-20 §0.5's reverse-lookup key).
//
// ── why a SIBLING of `briefingDeclarations.ts` and not another section of it ──
//
// `briefingDeclarations.ts` states its own scope in its first line: "what does
// the BOOT-RESOLVED declaration say about this node's BRIEFING?" — the composer,
// the input rows, the tool ids, the permission footing, the captures. Acceptance
// is a different declaration table answering a different question (where does
// the instance GO), read by a different caller at a different moment (a report
// arriving, not a spawn departing). Folding it in would give that module two
// subjects; a sibling keeps each file's one-question shape, which is the pattern
// S19 established rather than an invention here. The LAW below is the same law,
// deliberately, and is restated rather than cross-referenced so this file can be
// read alone.
//
// ── the law this module obeys (Move 3's signed F2, slice-19 §3.3 precedent) ───
//
//   "Dispatch follows Move 3's one-boot-declaration law. The dispatcher reads
//    the boot-resolved declaration (same source adjudication uses); no
//    per-instance re-resolution, and a rev difference is not a mismatch."
//
// That is why these functions take a `ParsedWorkflow` and nothing else. No I/O,
// no cache, nothing resolved per instance: `app.ts` calls `loadShippedWorkflow()`
// EXACTLY ONCE at boot and hands the same object to the `InstanceWriter` (which
// adjudicates against it), to the instance API (which serves its edge table) and
// to the briefing preflight. The acceptance read is the FOURTH reading of that
// ONE declaration, wired the same way, from the same variable.
//
// ⚠ **TOTAL — NOTHING HERE THROWS.** An unknown node id, a node with no
// acceptance table, a verb no node declares: each is a typed ABSENCE, never an
// exception. A throw at this depth would surface as an unhandled rejection
// inside a report-filing callback, after the report had already been recorded.
//
// ⚠ **NOTHING CALLS THESE YET.** U1 builds and proves the pure pieces; U2 wires
// the declaration path in beside the compiled routings, and U3 flips. Rule 0.5:
// the shapes land, the consumer arrives next.

// ── the types, derived from the barrel rather than re-declared ───────────────
//
// `ParsedAcceptance` is declared in core's `extensions/manifest.ts` and is
// deliberately NOT on core's barrel (`packages/core/src/index.ts` exports a
// NAMED list, and it is not on it). Widening that barrel is not this unit's
// business and hand-copying the interface here would create a structural twin
// that can rot silently — so it is reached by INDEXED ACCESS off the one type
// the barrel does export, exactly as `briefingDeclarations.ts` reaches
// `ParsedBriefing`. A field rename upstream reddens here rather than drifting.

/** One node of the boot-resolved workflow. */
type DeclaredWorkflowNode = ParsedWorkflow['nodes'][number];
/** A node's `[workflows.nodes.acceptance]` table, as the parser produced it. */
export type DeclaredAcceptance = NonNullable<DeclaredWorkflowNode['acceptance']>;

// ── direction 1: node → what it accepts ─────────────────────────────────────

/**
 * Why a node has no acceptance declaration to read. TWO reasons, kept apart
 * because they are different operator errors: a node id nothing declares (a
 * plumbing bug, or a stage vocabulary that drifted from the workflow's node
 * ids), and a declared node that simply carries no `[…].acceptance` table —
 * node-kit §1.8.4 (f) NONE, the ordinary resting case for eight of the shipped
 * workflow's eleven nodes.
 */
export type AcceptanceDeclarationAbsence = 'unknown-node' | 'node-declares-no-acceptance';

/** The total answer: a declaration, or a named absence. NEVER a throw. */
export type AcceptanceDeclarationLookup =
  | { readonly declared: true; readonly nodeId: string; readonly acceptance: DeclaredAcceptance }
  | { readonly declared: false; readonly absence: AcceptanceDeclarationAbsence };

/**
 * Read one node's acceptance declaration off the BOOT-RESOLVED workflow.
 *
 * PURE and TOTAL. The workflow is the same object `InstanceWriter` adjudicates
 * against; this function does not re-resolve, re-parse, or cache it.
 */
export function acceptanceFor(workflow: ParsedWorkflow, nodeId: string): AcceptanceDeclarationLookup {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return { declared: false, absence: 'unknown-node' };
  }
  const acceptance: DeclaredAcceptance | undefined = node.acceptance;
  if (acceptance === undefined) {
    return { declared: false, absence: 'node-declares-no-acceptance' };
  }
  return { declared: true, nodeId: node.id, acceptance };
}

// ── direction 2: report verb → the node that declared it ────────────────────

/**
 * Why a report verb resolves no node: nothing in the boot declaration names it
 * on an `acceptance.report`.
 *
 * This is the honest answer for a SPURIOUS call — a report filed through a verb
 * the workflow binds to nothing. Slice-20 A5 keeps that a total runtime NO-OP
 * rather than dissolving the guard: the fact still records, nothing routes.
 */
export type ReportVerbBindingAbsence = 'no-node-declares-verb';

/** The total answer: the declaring node's id, or a named absence. NEVER a throw. */
export type ReportVerbBindingLookup =
  | { readonly bound: true; readonly nodeId: string }
  | { readonly bound: false; readonly absence: ReportVerbBindingAbsence };

/**
 * Which node's acceptance does a filed report verb satisfy? — the reverse lookup
 * that replaces the dispatcher's hard-coded stage literals (§0.5 class (a)).
 *
 * ⚠ **THE ANSWER IS UNIQUE BY PARSE, NOT BY THIS SEARCH.** Two nodes declaring
 * the same verb is `acceptance-report-not-unique`, refused before a workflow can
 * ever boot (slice-20 §3.3a, manifest.ts), so the first match IS the only match.
 * This still takes the first rather than asserting, because the module's whole
 * contract is that it never throws — a parser regression must not become an
 * exception inside a report callback.
 *
 * PURE and TOTAL, over the same injected declaration as `acceptanceFor`.
 */
export function nodeDeclaringReportVerb(
  workflow: ParsedWorkflow,
  verbId: string,
): ReportVerbBindingLookup {
  const node = workflow.nodes.find((candidate) => candidate.acceptance?.report === verbId);
  if (node === undefined) {
    return { bound: false, absence: 'no-node-declares-verb' };
  }
  return { bound: true, nodeId: node.id };
}
