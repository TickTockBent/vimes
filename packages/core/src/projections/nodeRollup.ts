import { subtreeNodeIds, type NodesState } from './nodes.js';

// ─── S9·1 — the subtree aggregation (architecture.md E2-b, PURE) ─────────────
//
// ⚠ **THIS IS THE ONE PLACE "WORST" IS DEFINED.** E2-b settled it emphatically:
// clients are not the only consumers — attention debounce, the unattended-era
// escalation policy and extensions asking "is anything under this node red" all
// read subtree state, and three implementations of "worst" is three answers on
// the day one of them misses a severity. Every consumer calls THIS.
//
// It is a PURE DERIVATION, not an event fold, and that is deliberate: severity
// is per-SESSION state that lives in the sessions projection (stream-local to
// each session's own stream, D34), so the tree cannot fold it without reaching
// across streams. The caller — which already holds both projections — supplies
// the per-session reading, and this module owns only the two things E2-b says
// the engine must own: the ORDER and the COUNTING RULE.

// ⚠ **AN EXPLICIT, VERSIONED TOTAL ORDER (E2-b pin 1).** Every reserved or
// future reason declares its severity rank AT RESERVATION TIME, or the rollup
// silently misorders the day it lands — a new state defaulting to "unknown, so
// last" would make a red subtree read amber with nothing erroring anywhere.
//
// ADDITIONS APPEND with a declared rank. REORDERING IS A VERSIONED CHANGE: bump
// `ATTENTION_SEVERITY_ORDER_VERSION` so a consumer that cached a comparison
// (a debounce watermark, an escalation ladder) can tell that the ordering it
// reasoned against is no longer the ordering in force. The version is not the
// map's size — adding a rank at the top of the range keeps every existing
// pairwise comparison true, and only a REORDER breaks one.
export const ATTENTION_SEVERITY_ORDER_VERSION = 1;
export const ATTENTION_SEVERITY_RANKS = {
  idle: 0,
  working: 1,
  waiting_input: 2,
  gate_fired: 3,
  error: 4,
} as const; // higher = worse; rollup takes max

export type AttentionSeverity = keyof typeof ATTENTION_SEVERITY_RANKS;

export interface NodeRollup {
  worst: AttentionSeverity | null;
  processCount: number;
}

// Aggregate one node's SUBTREE (the node itself included — a node's rollup
// covers the work sitting on it, not only under it).
//
// `sessionSeverity` is the caller's per-session reading: `undefined` means "this
// session is not one I have a severity for", which is a different statement from
// `'idle'` and is treated as one (see below).
//
// PURE and TOTAL: no clock, no I/O, no mutation of `state`. An unknown nodeId
// rolls up to `{ worst: null, processCount: 0 }` rather than throwing.
export function rollupNode(
  state: NodesState,
  nodeId: string,
  sessionSeverity: (appSessionId: string) => AttentionSeverity | undefined,
): NodeRollup {
  let processCount = 0;
  let worstRank = -1;
  let worst: AttentionSeverity | null = null;

  for (const subtreeNodeId of subtreeNodeIds(state, nodeId)) {
    const node = state.nodes[subtreeNodeId];
    if (node === undefined) {
      continue;
    }
    // ⚠ **COUNT PROCESSES, NOT OPEN NODES (E2-b pin 2).** There is no filter on
    // `node.closed` here and there must never be one. E2's three axes make
    // closure tree-state and kill process-state: a CLOSED node can still have
    // living processes under it, because closing a node kills nothing. A rollup
    // that skipped closed nodes would turn closed-but-alive sessions into
    // invisible spend — a subtree that reads quiet while it burns tokens is
    // exactly the going-silently-dark failure the attention system exists to
    // prevent, and tidying up (closing a node you are done looking at) would be
    // the act that caused it.
    for (const appSessionId of node.sessionIds) {
      // ATTACHMENT is what counts: a session attached to a node in this subtree
      // is a process this subtree is responsible for, whether or not the caller
      // can say anything about its state.
      processCount += 1;
      const severity = sessionSeverity(appSessionId);
      if (severity === undefined) {
        // The caller has no reading for this session. It still COUNTED above; it
        // contributes nothing to `worst`, because inventing a severity for a
        // session we know nothing about would be fabricating the very signal
        // this function exists to report honestly (pillar 4).
        continue;
      }
      const rank: number | undefined = ATTENTION_SEVERITY_RANKS[severity];
      // TOTAL against a caller outside the type system (a JS consumer, a value
      // read back off the wire): a severity with no declared rank contributes
      // nothing rather than sorting arbitrarily.
      if (rank === undefined) {
        continue;
      }
      if (rank > worstRank) {
        worstRank = rank;
        worst = severity;
      }
    }
  }

  // `null`, never `'idle'`: "no session supplied a severity" and "every session
  // is idle" are different facts, and collapsing them would let an empty subtree
  // impersonate a quiet one.
  return { worst, processCount };
}
