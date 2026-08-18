import { z } from 'zod';
import {
  isEffectivelyClosed,
  nodeClosed,
  nodeCreated,
  nodeIdForSession,
  sessionAttachedToNode,
  type EventInput,
  type IdSource,
  type NodeProvenance,
  type NodeRecord,
  type NodesState,
  type ProjectsState,
  type SessionsState,
} from '@vimes/core';

// ─── S14·U3 — the SOLE WRITER of tree state, and the FIRST EMITTER of the E2
// node events (daemon I/O) ───────────────────────────────────────────────────
//
// The three `nodes`-stream events (`node_created`, `node_closed`,
// `session_attached_to_node`) have existed in core since S9·1 with a fold, a
// registry entry and tests — and with **nothing anywhere that wrote one**
// (slice-14.md §0 item 1: "Nothing emits the three events"). This class is what
// ends that condition, and it is the ONE place any of the three is authored.
// Everything else — the REST API in this same unit, the tree UI that will call
// it, any later spawn-into-a-node flow — is a CALLER of it.
//
// The shape is `projectWriter.ts`'s, deliberately and line for line: fresh
// projection reads per call, an injected id source, one emit per accepted
// operation, a read-back from the fold as the return value, and a discriminated
// outcome so callers tell the cases apart WITHOUT inspecting HTTP semantics.
//
// ⚠ **THE WRITER'S RULES ARE NOT THE FOLD'S RULES, AND BOTH ARE LOAD-BEARING.**
// `projections/nodes.ts` already DROPS a creation with an unknown parent, a
// self-parenting creation, and a second attach of a session that lives
// somewhere else — that is the forest invariant defended at the fold, where it
// also holds against replay of a log written by some future careless caller.
// This class refuses the same acts EARLIER and, crucially, **LOUDLY**: a fold
// that drops an event leaves the caller with a 200 and no record, while a
// refusal here writes nothing at all and names the reason. Two layers, one
// answer, and neither is redundant — the fold protects the STATE, the writer
// protects the LOG.
//
// ⚠ **v1 CANNOT CREATE A PROVENANCE-BEARING NODE, AND THE ABSENCE IS THE
// ENFORCEMENT** (slice-14.md §2, S14-A2). `CreateNodeInput` has no provenance
// parameter — not an ignored one, not a nullable one a caller could fill — so
// there is no request shape through this class that mints a checkout claim.
// Provenance stays write-once in the schema and arrives with the E2-c unit that
// actually performs git operations; until then every node this writer creates
// records `provenance: null`, and `null` stays `null` forever (the fold never
// updates it).
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()`. Every method runs
// to completion inside the call that invoked it, and the only non-determinism is
// the injected id source. `createdAt` on the born record is the STORE's `ts` for
// the birth event (S14-F2), never a clock this class reads.

// ── the refusal vocabulary — CLOSED, ENGINE-SPELLED, AUTHORED ONLY HERE ──────
//
// The `engineRefusalReasonSchema` pattern (core `extensions/proposeMove.ts`,
// S13·U1): **vocabulary lives beside its author.** Every string below is
// produced by a method in this file and by nothing else; no caller-supplied
// string ever reaches a `reason` field. The enum exists to make that membership
// ASSERTABLE — a test can enumerate it and prove each member is reachable, and
// a future member added without a producer fails that same test.
//
// ⚠ **ENGINE WORDS ONLY (#16).** These name tree facts — a project, a parent, a
// node, a session — and never a workflow's vocabulary for what a node is FOR.
// The tree is estate structure; what a tenant calls a branch is the tenant's
// business and reaches no surface of this class.
export const nodeRefusalReasonSchema = z.enum([
  // ── createNode ──
  /**
   * No LIVE project by that id. ⚠ **An ARCHIVED project counts as unknown for
   * CREATE**, deliberately: archiving is how a boundary stops claiming live
   * work, and minting new organization under a dead boundary would create a
   * subtree that `treeOf` immediately hangs under `unfiled` (an archived
   * project gets no root) — organization nobody asked to be homeless. Note the
   * asymmetry with the READ side, which keeps rendering nodes whose project was
   * archived AFTER they were created: existing structure is never dropped, but
   * new structure is never born orphaned either.
   */
  'unknown-project',
  /** The named parent node does not exist. Only `null` — a top-level node — is a legal absent parent. */
  'unknown-parent',
  /**
   * The parent is EFFECTIVELY closed (its own flag, or an ancestor's). Creating
   * under a closed subtree would put fresh organization somewhere the tree
   * already says is finished.
   */
  'parent-closed',
  /** The parent's `projectId` is not the requested one. A node may not straddle two D42 boundaries. */
  'cross-project-parent',
  /** A name of nothing but whitespace. A node is a LABEL for a group; an unnamed one labels nothing. */
  'empty-name',

  // ── closeNode ──
  /** No node by that id. */
  'unknown-node',
  /**
   * This node's OWN `closed` flag is already set. ⚠ **Record-level, NOT
   * effective closure**: closing a child whose PARENT is closed is ACCEPTED and
   * writes a real `node_closed`, because E2's semantics let a subtree record its
   * own explicit closure — and the read model carries `closed` and
   * `effectivelyClosed` as two fields precisely so that difference survives.
   */
  'already-closed',

  // ── attachSession ──
  /**
   * The node is EFFECTIVELY closed (unlike `already-closed` above, an ancestor's
   * closure counts): no attaching new work into a subtree that is finished.
   */
  'node-closed',
  /** The sessions projection holds no such session. A node's membership list may not name a session that does not exist. */
  'unknown-session',
  /** This session is ALREADY attached to THIS node. Idempotence refused honestly — a second event would claim a human attached it twice. */
  'already-attached',
  /**
   * ⚠ **THE LOAD-BEARING ONE.** This session is attached to a DIFFERENT node.
   * v1 has no move, and accepting a re-attach would be a move wearing attach's
   * clothes (E2-a bans `node_moved`, and its absence is what makes the forest
   * acyclic). It is also what the tree's EXACTLY-ONCE property leans on
   * (S14-A1): `treeOf` renders an attached session at its node and an
   * unattached one under its derived root, so a session listed by two nodes
   * would appear twice in one payload. The fold refuses the second attach too —
   * this is the loud half of the same rule.
   */
  'attached-elsewhere',
]);
export type NodeRefusalReason = z.infer<typeof nodeRefusalReasonSchema>;

// ── the inputs ──────────────────────────────────────────────────────────────

/**
 * What a CREATOR names.
 *
 * Deliberately NOT a `NodeRecord`: `nodeId` is minted here, `closed` and
 * `sessionIds` are the projection's business, `createdAt` is the store's, and
 * **`provenance` and `nodeConfig` are not offered at all** — see the class
 * header. Letting a caller supply any of them would let the API create a node
 * that was born closed, born populated, or born claiming a git checkout that no
 * git operation ever performed.
 */
export interface CreateNodeInput {
  /** A LIVE project's id (D42). The node hangs under that boundary's virtual root. */
  readonly projectId: string;
  /** The parent node, or `null` for a top-level node under the project root. */
  readonly parentNodeId: string | null;
  /** The human label. Trimmed by this class; whitespace-only is refused. */
  readonly name: string;
  /**
   * E3-a: the SPAWN-DEFAULT cwd, or `null` for a label-only group that scopes
   * nothing. ⚠ **RECORDED AS ORGANIZATION, NEVER AS CONTAINMENT** — nothing in
   * VIMES treats this as a permission boundary, and the route deliberately does
   * not validate it against `VIMES_PROJECT_ROOTS` (see nodeApi.ts).
   */
  readonly directory: string | null;
}

// ─── S17·U2 — THE SEAL'S DELIBERATE OPENING (slice-17.md §1, Part B) ─────────
//
// Everything above says v1 cannot create a provenance-bearing node and that the
// ABSENCE of a parameter is the enforcement. **This is the unit that opens that
// seal, and it opens it exactly one crack wide.**
//
// `CreateNodeInput` STILL has no provenance field; `nodeApi.ts` is untouched and
// still cannot reach this; the public create path still stamps `provenance:
// null` and every S14-A2 assertion about it stays green UNMODIFIED. What changes
// is that ONE engine caller — `checkoutCoordinator.ts`, which has actually just
// run `git worktree add` — may now record what it performed. The rule the seal
// was defending is unchanged and is worth restating: **a provenance claim may
// only be minted by the code that performed the git operation it claims.**
// A request shape never mints one, because a request never performs one.
//
// ⚠ **A3's REFUSAL LIVES HERE, AT THE WRITER.** `projections/nodes.ts` ignores a
// second `node_created` for an id it already holds — that is the STRUCTURAL
// backstop (write-once against replay of a log some future careless caller
// wrote), and slice-17.md §4/A3 says explicitly that it is the backstop and not
// the refusal. The refusal is `node-already-exists` below: LOUD, nothing
// emitted, so a second provenance write is a named answer rather than a 200
// with no record.
//
// ⚠ **THE nodeId IS THE CALLER'S, AND THAT IS FORCED BY §3.2.** Every other
// method here mints from the injected source. The coordinator cannot: the branch
// name and the checkout path are DERIVED FROM THE nodeId (§3.6) and must exist
// before `git worktree add` runs, so the id is minted one layer up — from the
// same injected `IdSource`, at the top of the same critical section — and
// arrives here already spent. This class therefore does not mint for this
// method, and the `ids` dep is untouched by it.

// The engine path's OWN closed vocabulary, deliberately NOT a widening of
// `nodeRefusalReasonSchema`. That enum is pinned by an exact-equality test over
// the reasons REACHABLE THROUGH THE HTTP API (nodeApi.test.ts) — "no dead
// vocabulary, no free text" — and these reasons are reachable through no route
// at all, by construction. Two enums, two audiences, and the seam between them
// is the same seam that keeps a request from minting a provenance.
export const checkoutNodeRefusalReasonSchema = z.enum([
  /** No LIVE project by that id. Archived counts as unknown, exactly as it does for `createNode`. */
  'unknown-project',
  /**
   * ⚠ **A3, THE WRITER HALF.** A node by this id already exists, so this would
   * be a SECOND birth record — and for a provenance-bearing node that means a
   * second checkout claim over a node whose claim is already written and
   * write-once. Refused loudly, nothing emitted. The fold's ignore-duplicate is
   * the structural backstop behind this, never a substitute for it.
   */
  'node-already-exists',
  /** A name of nothing but whitespace — same rule, same reason, as `createNode`. */
  'empty-name',
  /** An empty nodeId. Unreachable from an injected uuid source; refused anyway, because this method takes the id from its caller rather than minting it. */
  'empty-node-id',
]);
export type CheckoutNodeRefusalReason = z.infer<typeof checkoutNodeRefusalReasonSchema>;

/**
 * What the CHECKOUT COORDINATOR names — after git has already performed.
 *
 * Every field here describes something that EXISTS on disk by the time this is
 * called: the id the branch and path were derived from, the project the
 * repository belongs to, and the provenance recording which commit was checked
 * out where. Nothing in this shape is a request's; it is a report of work done.
 */
export interface CreateCheckoutNodeInput {
  /** The id MINTED BY THE COORDINATOR (§3.2) — the branch and path already derive from it. */
  readonly nodeId: string;
  /** A LIVE project's id (D42), resolved from the repository's root. */
  readonly projectId: string;
  /** The human label. The coordinator passes the BRANCH name — see its own docblock for why. */
  readonly name: string;
  /**
   * The checkout path. NOT nullable here (unlike `CreateNodeInput.directory`):
   * a checkout node without a directory would be a claim about a place with no
   * place. Same E3-a meaning as everywhere else — spawn-default cwd, never
   * containment.
   */
  readonly directory: string;
  /** The four checkable facts (§3.1): branch, baseRef, resolvedCommit, path. */
  readonly provenance: NodeProvenance;
}

export type CreateCheckoutNodeResult =
  | { readonly outcome: 'created'; readonly node: NodeRecord }
  | { readonly outcome: 'refused'; readonly reason: CheckoutNodeRefusalReason };

export interface CloseNodeInput {
  readonly nodeId: string;
}

export interface AttachSessionInput {
  readonly nodeId: string;
  readonly appSessionId: string;
}

// ── the outcomes ────────────────────────────────────────────────────────────
//
// ONE refused shape across all three operations rather than a per-method union,
// because the reason enum above is already the closed vocabulary and a caller
// that branches on `outcome` then reads `reason` needs nothing more. The
// accepted shapes carry the record **as the projection folded it** — see
// `createNode`'s note on why the read-back is the point rather than a formality.

export type CreateNodeResult =
  | { readonly outcome: 'created'; readonly node: NodeRecord }
  | { readonly outcome: 'refused'; readonly reason: NodeRefusalReason };

export type CloseNodeResult =
  | { readonly outcome: 'closed'; readonly node: NodeRecord }
  | { readonly outcome: 'refused'; readonly reason: NodeRefusalReason };

export type AttachSessionResult =
  | { readonly outcome: 'attached'; readonly node: NodeRecord }
  | { readonly outcome: 'refused'; readonly reason: NodeRefusalReason };

// Thrown ONLY when the log and the projection disagree: an event was written and
// the fold did not produce the record it describes. That is a rule-0.1 finding
// (the log is the source of record, I12), not an input error — so it surfaces as
// a 500 with the finding in it rather than a plausible-looking 200. It is
// unreachable through any request shape; only a projection/event divergence
// produces it. The sibling of `ProjectProjectionDisagreementError`.
export class NodeProjectionDisagreementError extends Error {}

export interface NodeWriterDeps {
  // The router's emit — the ONLY write path. Nothing here touches the store, a
  // snapshot or a projection object directly.
  emit: (events: EventInput[]) => void;
  // Projection reads, called FRESH on every call and never cached in a field.
  // Three of them, because this writer's rules span three folds: the D42
  // registry says whether a project is live, the nodes fold says what the forest
  // looks like, and the sessions fold says whether a session exists at all. A
  // writer working from stale copies would attach to a node somebody just
  // closed, or refuse a project somebody just declared.
  readProjects: () => ProjectsState;
  readNodes: () => NodesState;
  readSessions: () => SessionsState;
  // INJECTED (rule 0.3). The only source of new nodeIds; nothing here calls
  // randomUUID, so a test with a CountingIdSource gets byte-identical ids.
  //
  // ⚠ It also underwrites the F1 virtual-id grammar: `IdSource.uuid()` yields
  // hex and hyphens, so a minted nodeId can never take the `project:<id>` or
  // `unfiled` form a client addresses a virtual root with (S14-A10).
  ids: IdSource;
}

export class NodeWriter {
  private readonly deps: NodeWriterDeps;

  constructor(deps: NodeWriterDeps) {
    this.deps = deps;
  }

  /**
   * Create a node: mint an id, emit ONE `node_created`, and return the record
   * **as the projection folded it**.
   *
   * ⚠ The read-back is the point, not a formality (the reasoning
   * `ProjectWriter.createProject` states): returning a hand-built echo of the
   * input would make this method agree with itself by construction, where
   * reading the fold proves the log is the source of record (I12) and turns any
   * projection/event disagreement into an immediate, loud failure instead of a
   * forest that quietly disagrees with its own log. Here it is worth more than
   * usual: `createdAt` and `closed` and `sessionIds` exist ONLY on the folded
   * record, so an echo could not have produced them at all without inventing
   * them.
   *
   * ⚠ **THE REFUSAL ORDER IS DECLARED**, not incidental: project, then parent
   * existence, then parent closure, then parent project, then name. A request
   * that violates two rules gets the EARLIER reason, deterministically, so a
   * client (and a test) can rely on which one comes back.
   *
   * TOTAL over its input space (I8): no input throws. The one throw below is the
   * rule-0.1 projection/log divergence.
   */
  createNode(input: CreateNodeInput): CreateNodeResult {
    // Fresh reads, every call. See `NodeWriterDeps`.
    const project = this.deps.readProjects().projects[input.projectId];
    // ⚠ ARCHIVED COUNTS AS UNKNOWN HERE — see `unknown-project` in the enum.
    if (project === undefined || project.archived) {
      return { outcome: 'refused', reason: 'unknown-project' };
    }

    const nodes = this.deps.readNodes();
    if (input.parentNodeId !== null) {
      const parentNode = nodes.nodes[input.parentNodeId];
      if (parentNode === undefined) {
        return { outcome: 'refused', reason: 'unknown-parent' };
      }
      // EFFECTIVE closure (the derived walk), not the parent's own flag: a node
      // three levels under a closed ancestor is just as finished as the ancestor.
      if (isEffectivelyClosed(nodes, input.parentNodeId)) {
        return { outcome: 'refused', reason: 'parent-closed' };
      }
      if (parentNode.projectId !== input.projectId) {
        return { outcome: 'refused', reason: 'cross-project-parent' };
      }
    }

    // TRIMMED, THEN CHECKED, and the order is the point: a name of three spaces
    // is refused rather than recorded as three spaces. What reaches the event is
    // the trimmed value, so no record carries whitespace nobody meant to type.
    const trimmedName = input.name.trim();
    if (trimmedName.length === 0) {
      return { outcome: 'refused', reason: 'empty-name' };
    }

    // The id is minted only AFTER every refusal, so a refused creation consumes
    // nothing from the injected source and the sequence a later accepted one
    // mints from is the one it would have had if the refused request had never
    // arrived (the ordering discipline `ProjectWriter.createProject` states).
    const nodeId = this.deps.ids.uuid();
    this.deps.emit([
      nodeCreated({
        nodeId,
        parentNodeId: input.parentNodeId,
        projectId: input.projectId,
        name: trimmedName,
        // ⚠ ALWAYS `null` IN v1, and there is no parameter that could make it
        // anything else (S14-A2, class header).
        provenance: null,
        directory: input.directory,
        // D11 / rule 0.5: the key is reserved and accepts only `null` today.
        nodeConfig: null,
      }),
    ]);

    const bornNode = this.deps.readNodes().nodes[nodeId];
    if (bornNode === undefined) {
      throw new NodeProjectionDisagreementError(
        `node_created was written for ${nodeId} but the nodes projection did not fold it`,
      );
    }
    return { outcome: 'created', node: bornNode };
  }

  /**
   * **ENGINE-ONLY (S17·U2).** Create a node that WAS BORN WITH A CHECKOUT: emit
   * ONE provenance-bearing `node_created` and return the record as the
   * projection folded it.
   *
   * ⚠ **THE ONLY CALLER IS `checkoutCoordinator.ts`, AND THAT IS THE WHOLE
   * DESIGN** (slice-17.md §1, and the seal block above this method's input
   * type). No route reaches it, no MCP tool reaches it, and adding a caller that
   * has not itself just run `git worktree add` is a decision record, not a
   * patch: provenance is a claim about the filesystem, and only the code that
   * changed the filesystem is in a position to make it.
   *
   * ⚠ **A3's REFUSAL IS `node-already-exists`, HERE, LOUDLY.** The nodes fold
   * already ignores a duplicate birth — that is the structural backstop against
   * replay; this is the refusal, and slice-17.md §4 says the difference matters.
   *
   * The read-back is the point for exactly the reason `createNode` states, with
   * one addition specific to this path: the returned record's `provenance` comes
   * from THE FOLD, so a projection that dropped or mangled the claim surfaces
   * here as a disagreement rather than as an echo of what we hoped it stored.
   *
   * TOTAL over its input space (I8): no input throws. The one throw is the
   * rule-0.1 projection/log divergence, as everywhere else in this class.
   */
  createCheckoutNode(input: CreateCheckoutNodeInput): CreateCheckoutNodeResult {
    if (input.nodeId.trim().length === 0) {
      return { outcome: 'refused', reason: 'empty-node-id' };
    }

    // Fresh reads, every call. ARCHIVED COUNTS AS UNKNOWN, exactly as in
    // `createNode`: a checkout under a dead boundary is organization nobody
    // asked to be homeless, and the git work it claims is not a reason to
    // reopen a boundary somebody archived.
    const project = this.deps.readProjects().projects[input.projectId];
    if (project === undefined || project.archived) {
      return { outcome: 'refused', reason: 'unknown-project' };
    }

    // A3, the writer half. Checked BEFORE the name so a duplicate id is always
    // reported as a duplicate id, whatever else is wrong with the request.
    if (this.deps.readNodes().nodes[input.nodeId] !== undefined) {
      return { outcome: 'refused', reason: 'node-already-exists' };
    }

    const trimmedName = input.name.trim();
    if (trimmedName.length === 0) {
      return { outcome: 'refused', reason: 'empty-name' };
    }

    this.deps.emit([
      nodeCreated({
        nodeId: input.nodeId,
        // v1: a checkout node is born TOP-LEVEL under its project's virtual
        // root. There is no `parentNodeId` parameter — not an ignored one — for
        // the same reason `CreateNodeInput` has no `provenance` one: the shape
        // that does not exist cannot be misused. Hanging a checkout under a
        // group node is a real want and a real decision (which group? chosen by
        // whom? through what surface?), and it lands with the surface that asks
        // the question, not with the unit that performs git.
        parentNodeId: null,
        projectId: input.projectId,
        name: trimmedName,
        // ⚠ **THE SEAL'S ONE CRACK.** Write-once at creation, exactly as the
        // E2-a schema promises: the fold never updates it, so what is written
        // here is what this node claims forever.
        provenance: input.provenance,
        directory: input.directory,
        // D11 / rule 0.5, unchanged: the key is reserved and accepts only null.
        nodeConfig: null,
      }),
    ]);

    const bornNode = this.deps.readNodes().nodes[input.nodeId];
    if (bornNode === undefined) {
      throw new NodeProjectionDisagreementError(
        `node_created (with provenance) was written for ${input.nodeId} but the nodes projection did not fold it`,
      );
    }
    return { outcome: 'created', node: bornNode };
  }

  /**
   * Close a node: emit ONE `node_closed` and return the record **as the
   * projection folded it**.
   *
   * ⚠ **CLOSURE IS TREE STATE AND NOTHING ELSE** (E2's three orthogonal axes).
   * This kills no process and removes nothing on disk; a living session under a
   * closed node keeps living, and E2-b's `processCount` keeps counting it so the
   * estate cannot go quiet by being tidied.
   *
   * ⚠ **THE IDEMPOTENCE CHECK IS ON THE NODE'S OWN FLAG, NOT ON EFFECTIVE
   * CLOSURE**, and that is a decision rather than an oversight: closing a child
   * whose parent is already closed is ACCEPTED and writes a real event, because
   * E2 lets a subtree record its own explicit closure and the read model carries
   * both facts (`closed` / `effectivelyClosed`) so the difference survives. Only
   * a node whose own flag is set is refused, and then nothing is emitted — a
   * second `node_closed` would claim a human closed it twice, and the log is the
   * audit trail.
   *
   * ⚠ **THERE IS NO REOPEN, HERE OR ANYWHERE.** E2's walked vocabulary has three
   * events and reopening is not among them; adding one is a D-record, not a
   * boolean this method learns to flip both ways.
   */
  closeNode(input: CloseNodeInput): CloseNodeResult {
    const nodes = this.deps.readNodes();
    const node = nodes.nodes[input.nodeId];
    if (node === undefined) {
      return { outcome: 'refused', reason: 'unknown-node' };
    }
    if (node.closed) {
      return { outcome: 'refused', reason: 'already-closed' };
    }

    this.deps.emit([nodeClosed({ nodeId: node.nodeId })]);

    const closedNode = this.deps.readNodes().nodes[input.nodeId];
    if (closedNode === undefined) {
      // Unreachable — closing does not remove the record; that is the whole
      // point of the fold. See NodeProjectionDisagreementError.
      throw new NodeProjectionDisagreementError(
        `node_closed was written for ${input.nodeId} but the nodes projection no longer holds it`,
      );
    }
    return { outcome: 'closed', node: closedNode };
  }

  /**
   * Attach a session to a node: emit ONE `session_attached_to_node` and return
   * the NODE **as the projection folded it** (the record whose membership list
   * changed — the session's own record is untouched, because the fact recorded
   * is about the node, which is why the event rides the `nodes` stream at all).
   *
   * ⚠ **`attached-elsewhere` IS WHY THIS METHOD HAS NO MOVE.** See the enum
   * entry: re-attaching is `node_moved` under another name, and the tree's
   * exactly-once property (S14-A1) is stated over the fact that a session is
   * listed by at most one node.
   *
   * ⚠ **THE SESSION MUST EXIST IN THE SESSIONS PROJECTION.** The fold would
   * happily append an unknown id (it validates the NODE, not the session), and
   * `rollupNode` counts `sessionIds` rather than records — so an attachment to a
   * session that never existed would inflate every ancestor's `processCount`
   * forever while rendering no leaf anybody could look at. Refused here, loudly,
   * which is the whole reason this writer reads a third projection.
   */
  attachSession(input: AttachSessionInput): AttachSessionResult {
    const nodes = this.deps.readNodes();
    const node = nodes.nodes[input.nodeId];
    if (node === undefined) {
      return { outcome: 'refused', reason: 'unknown-node' };
    }
    // EFFECTIVE closure here, unlike `closeNode`'s record-level check: new work
    // may not enter a subtree that is finished, however far up the closure sits.
    if (isEffectivelyClosed(nodes, input.nodeId)) {
      return { outcome: 'refused', reason: 'node-closed' };
    }
    if (this.deps.readSessions().sessions[input.appSessionId] === undefined) {
      return { outcome: 'refused', reason: 'unknown-session' };
    }

    const currentHomeNodeId = nodeIdForSession(nodes, input.appSessionId);
    if (currentHomeNodeId === input.nodeId) {
      return { outcome: 'refused', reason: 'already-attached' };
    }
    if (currentHomeNodeId !== null) {
      return { outcome: 'refused', reason: 'attached-elsewhere' };
    }

    this.deps.emit([
      sessionAttachedToNode({ nodeId: node.nodeId, appSessionId: input.appSessionId }),
    ]);

    const attachedNode = this.deps.readNodes().nodes[input.nodeId];
    if (attachedNode === undefined || !attachedNode.sessionIds.includes(input.appSessionId)) {
      // Unreachable through any request shape: the node existed a moment ago,
      // nothing removes nodes, and the fold's own refusals (unknown node, session
      // already homed) were both checked above. A disagreement here means the
      // fold declined an attach this class had proved acceptable — exactly the
      // divergence the read-back exists to expose.
      throw new NodeProjectionDisagreementError(
        `session_attached_to_node was written for ${input.appSessionId} on ${input.nodeId} but the nodes projection did not fold it`,
      );
    }
    return { outcome: 'attached', node: attachedNode };
  }
}
