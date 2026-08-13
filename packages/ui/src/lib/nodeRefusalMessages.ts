// ─── S15·U1 — refusal messages for the engine's 11-reason node vocabulary
// (ui-doctrine.md U4, slice-15.md A5) ──────────────────────────────────────────
//
// The write surface (U3, later in this slice) fires `POST /api/nodes` and its
// siblings and renders whatever the daemon refuses with. This module is the
// ONE place a `NodeRefusalReason` (packages/daemon/src/nodeWriter.ts
// `nodeRefusalReasonSchema`) becomes an operator-legible sentence — every
// message below states what was refused and why, in words an operator can act
// on, using ENGINE nouns only (session, node, project) per doctrine U4. No
// workflow vocabulary reaches this surface.
//
// The messages are TRUE to what the writer actually checks — each was written
// from `nodeWriter.ts`'s own per-reason comment, not guessed from the reason's
// spelling, because a plausible-sounding wrong explanation is worse than none.

// An unrecognized reason renders VERBATIM rather than throwing or hiding: a
// future engine may refuse for reasons this build has never heard of, and an
// honest raw string beats a crash or a silent swallow (slice-15 A5). This is
// the same forward-compat posture `nodeWriter.ts`'s CLOSED-but-assertable
// vocabulary anticipates on the writer side — the display side must not be
// stricter than the engine it renders.
export function nodeRefusalMessage(reason: string): string {
  switch (reason) {
    // ── createNode ──
    case 'unknown-project':
      // nodeWriter.ts: an ARCHIVED project counts as unknown for create too —
      // new organization is never born under a boundary that has stopped
      // claiming live work.
      return 'No live project matches this id — an archived project cannot receive new nodes.';
    case 'unknown-parent':
      return 'The named parent node does not exist.';
    case 'parent-closed':
      // Effective closure: the parent's own flag, or an ancestor's.
      return 'The parent node is closed (or sits under a closed ancestor) — nothing new can be created under a finished subtree.';
    case 'cross-project-parent':
      return "The parent node belongs to a different project — a node cannot straddle two projects.";
    case 'empty-name':
      return 'The name is empty or whitespace-only — a node needs a real label.';

    // ── closeNode ──
    case 'unknown-node':
      return 'No node matches this id.';
    case 'already-closed':
      // Record-level idempotence refusal, NOT effective closure — this is the
      // node's own flag already being set.
      return 'This node is already closed.';

    // ── attachSession ──
    case 'node-closed':
      // Effective closure again, this time on the attach path: an ancestor's
      // closure counts, not only the node's own flag.
      return 'This node is closed (or sits under a closed ancestor) — nothing new can attach to a finished subtree.';
    case 'unknown-session':
      return 'No session matches this id.';
    case 'already-attached':
      return 'This session is already attached to this node.';
    case 'attached-elsewhere':
      // The load-bearing one (nodeWriter.ts): v1 has no move, so a re-attach
      // would be a move wearing attach's clothes.
      return 'This session is already attached to another node — sessions attach exactly once, and nothing moves them in v1.';

    default:
      return reason;
  }
}
