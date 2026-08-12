// ─── S12·U1 (D72 Move 3) — the declaration-reading adjudicator (PURE, core) ──
//
// One question, one answer: **may an instance move from this node to that node,
// under this declared workflow?** The declaration is the authority and this
// module is only its reader. No tenant's vocabulary is compiled in — principle
// #16 in its assertable form ("the engine's source may not contain a tenant's
// word", node-kit §1.10). A sibling test greps THIS FILE for tenant words and
// reddens if one appears, so the principle is executable rather than promised.
//
// ── provenance ───────────────────────────────────────────────────────────────
// This is the declaration-reading twin of the engine-table machine in
// `taskStateMachine.ts` (the one filename citation this file is allowed). D72
// Move 3 moves the SEAM — where the legality table lives, compiled engine data
// → the extension's declaration — and deliberately NOT the behaviour. While
// both machines stand, S12-A1 proves them equal across the full cross product;
// the older one remains the runtime path until the writer flip.
//
// ── the rules this module is built on ────────────────────────────────────────
// Rule 0.3: **PURE.** No clock, no randomness, no I/O, no mutation. The caller
// supplies the current node, the proposal and the parsed declaration, and
// receives a decision. Nothing here dispatches, persists, projects or emits;
// its callers do, and a refusal MUST be evented — an unrecorded refusal is a
// refusal that never happened.
//
// Rule: **NEVER THROW.** `proposeMove` is TOTAL. Every (current node, proposal,
// workflow) triple maps to a decision, including ids outside the declared
// vocabulary and a declaration carrying no nodes at all. A refusal is a normal,
// evented outcome, not an exception.
//
// F5 (slice-12): a **DECISION ONLY**. No next record, no derived flag, no event
// payload. Computing the next record needs the tenant's own vocabulary, so it
// stays beside that vocabulary and never leaks in here.

import { z } from 'zod';

import type { ParsedWorkflow } from './manifest.js';

// ── the engine-vocabulary refusals — S13·U1 (slice-13 F1) ────────────────────
//
// THE VOCABULARY SPLITS INTO TWO CHANNELS, and this is the closed one.
//
//   • **The ENGINE channel** — these four, and only these four. Closed, spelled
//     in the engine's own generic terms (`*-node`, never a tenant's word for a
//     node), and authored NOWHERE but this file. `engineRefusalReasonSchema`
//     exists to make that membership assertable (S13-A1); it is deliberately NOT
//     the schema the RECORD validates against.
//   • **The DECLARED channel** — any string a workflow's `forbidden` row names
//     (step 4 below). OPEN, never enumerated here, echoed verbatim. A second
//     tenant may declare a refusal this engine has never heard of, and it must
//     reach the record intact; an engine that enumerated tenant refusals would
//     have to learn every tenant's prose forever (#16, and F1's rationale).
//
// The guarantee on the open channel is PROVENANCE, not validation: a refusal
// reason is produced HERE, from either the four below or the pinned
// declaration's own row. No caller-supplied string ever reaches it. That is why
// the writer records `MoveDecision.reason` verbatim and adds no membership check
// (F1 ⟨signed⟩ — a record-time check would re-derive adjudication).
//
// The spellings below were `*-stage` until this slice. The respelling is
// wire-visible, which is why it waited for the alias-death deploy. Old spellings
// persist in the log FOREVER and the read side keeps rendering them (F2
// ⟨signed⟩: the mixed log is the designed outcome, not an incomplete migration).
export const engineRefusalReasonSchema = z.enum([
  /** A node id on either end that the declaration does not declare. */
  'unknown-node',
  /** A no-op: the proposal names the node the instance already occupies. */
  'same-node',
  /** A proposal OUT of a node the declaration gives no way out of. */
  'terminal-node',
  /** The generic refusal: the proposed edge is simply not in the declared table. */
  'illegal-edge',
]);
export type EngineRefusalReason = z.infer<typeof engineRefusalReasonSchema>;

/** A node id on either end that the declaration does not declare. */
const UNKNOWN_NODE_REASON: EngineRefusalReason = 'unknown-node';
/** A no-op: the proposal names the node the instance already occupies. */
const SAME_NODE_REASON: EngineRefusalReason = 'same-node';
/** A proposal OUT of a node the declaration gives no way out of. */
const TERMINAL_NODE_REASON: EngineRefusalReason = 'terminal-node';
/** The generic refusal: the proposed edge is simply not in the declared table. */
const ILLEGAL_EDGE_REASON: EngineRefusalReason = 'illegal-edge';

export interface MoveProposal {
  /** The node the proposer wants the instance to occupy next. */
  readonly toNode: string;
  /**
   * Proposer class. **RECORDED CONTEXT ONLY this slice.** `by` allow-list
   * enforcement is explicitly out of D72 Move 3 (it is behaviour-shaping and
   * earns its own D-record); this parameter is that rule's landing pad and is
   * deliberately unread today. `ParsedEdge.by` is likewise not consulted below.
   */
  readonly proposedBy: string;
}

export type MoveDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

/** A node is KNOWN iff the declaration lists it — the NODE list, never the edge
 *  table. A node with no way out has no rows in the edge table and exists all
 *  the same; deriving the vocabulary from the edges would erase it. */
function isDeclaredNode(candidateNodeId: string, workflow: ParsedWorkflow): boolean {
  return workflow.nodes.some((declaredNode) => declaredNode.id === candidateNodeId);
}

/**
 * Decide a single proposed move against a declared workflow. TOTAL and PURE:
 * every input maps to a decision, nothing throws, nothing is mutated, and the
 * same inputs always produce the same decision.
 *
 * REFUSAL PRECEDENCE — the order is load-bearing, and each step earns its
 * place. Ported from the older machine's own comment block, restated in
 * declaration terms:
 *
 *   1. `unknown-node` — a node id outside the DECLARED node list, on either
 *      end. Checked first because every rule below assumes a known vocabulary.
 *   2. `same-node` — a no-op proposal; nothing is being asked for.
 *      TIE-BREAK PRESERVED: a node with no way out, proposed to ITSELF, is both
 *      a no-op and a proposal touching such a node. It resolves here, because
 *      nothing was proposed to *leave* it. That same node → any OTHER node is
 *      step 3.
 *   3. `terminal-node` — proposing out of a node whose DECLARED out-edge set
 *      (rows with `from` equal to the current node) is EMPTY. Terminal is
 *      DERIVED from the table rather than read off a node property, so the
 *      legality table stays the single source of record for legality.
 *   4. **the forbidden rows**, echoing the row's own declared `reason`,
 *      verbatim. MUST run BEFORE the generic table lookup: a safety rule that
 *      reported as a bland `illegal-edge` would be indistinguishable from a
 *      typo, and the whole point of a named refusal is that the operator can
 *      tell the difference (node-kit §1.4.4).
 *   5. `illegal-edge` — the generic declared-table lookup.
 *
 * Deliberately NOT consulted, each explicitly out of D72 Move 3 with its own
 * D-record pending: `proposal.proposedBy` and `ParsedEdge.by` (allow-list
 * enforcement), `ParsedEdge.maxTraversals` and `ParsedEdge.onExhausted` (the
 * bounded loop and its exhaustion exit). Reading any of them here would be a
 * behaviour-shaping change wearing a refactor's clothes.
 */
export function proposeMove(
  currentNode: string,
  proposal: MoveProposal,
  workflow: ParsedWorkflow,
): MoveDecision {
  const targetNode: string = proposal.toNode;

  // 1. defensive — a node id outside the declared vocabulary, on either end.
  if (!isDeclaredNode(currentNode, workflow) || !isDeclaredNode(targetNode, workflow)) {
    return { accepted: false, reason: UNKNOWN_NODE_REASON };
  }

  // 2. no-op (and the documented self-proposal tie-break).
  if (currentNode === targetNode) {
    return { accepted: false, reason: SAME_NODE_REASON };
  }

  // 3. no declared way out — reopening such a node is a new instance, not a
  //    resurrection, so the audit trail stays honest.
  const hasAnyDeclaredExit = workflow.edges.some((edge) => edge.from === currentNode);
  if (!hasAnyDeclaredExit) {
    return { accepted: false, reason: TERMINAL_NODE_REASON };
  }

  // 4. the named refusals the DECLARATION carries, BEFORE the generic lookup.
  const forbiddenRow = workflow.forbidden.find(
    (row) => row.from === currentNode && row.to === targetNode,
  );
  if (forbiddenRow !== undefined) {
    return { accepted: false, reason: forbiddenRow.reason };
  }

  // 5. the declared table.
  const hasDeclaredEdge = workflow.edges.some(
    (edge) => edge.from === currentNode && edge.to === targetNode,
  );
  if (!hasDeclaredEdge) {
    return { accepted: false, reason: ILLEGAL_EDGE_REASON };
  }

  // F5: the decision, and nothing else. No payload rides along.
  return { accepted: true };
}
