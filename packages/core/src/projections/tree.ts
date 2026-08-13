import type { NodeProvenance } from '../events.js';
import type { ProjectRecord, SessionRecord } from '../schemas.js';
import { shortSessionIds } from '../sessionShortIds.js';
import {
  isEffectivelyClosed,
  nodeIdForSession,
  type NodeRecord,
  type NodesState,
} from './nodes.js';
import {
  rollupNode,
  ATTENTION_SEVERITY_ORDER_VERSION,
  ATTENTION_SEVERITY_RANKS,
  type AttentionSeverity,
  type NodeRollup,
} from './nodeRollup.js';
import { projectDisplayName, projectForCwd, type ProjectsState } from './projects.js';
import { sessionSeverityOf } from './sessionSeverity.js';
import type { SessionsState } from './sessions.js';

// ─── S14·U2 — the composed tree read model (slice-14.md §3 F1/F2, PURE) ──────
//
// ONE fold per fact, ONE composition here. The three states this function takes
// are folded independently and stream-locally (D34); nothing below folds
// anything, reaches for a clock, or touches a disk. It JOINS what three
// projections already hold into the single shape every client renders, so that
// no client computes its own forest (E2, walked) and no two surfaces disagree
// about what hangs where.
//
// Rule 0.3: pure and deterministic. Called twice over the same three states it
// yields byte-identical `canonicalJson` (S14-A8).
//
// ── the two structural decisions this module implements ─────────────────────
//
// **F1: project roots are VIRTUAL.** No birth event exists for a root and none
// is backfilled — project identity has ONE source of record (principle 9), the
// project registry, and minting node events to mirror it would create a second.
// A root is composed here, at read time, and carries a SYNTHETIC NAMESPACED id
// so a client can address, expand and select it. See the grammar below.
//
// **F2: a session with no explicit attachment finds its root by PATH, not by
// lookup.** A session record carries a `cwd`; it has never carried a projectId.
// The derivation is `defaultRootForSession`, a named exported function with its
// own tests — never an incidental join buried in the composition below.

// ── the virtual id grammar (F1's rider, S14-A10) ────────────────────────────
//
// ⚠ **THE `:` IS THE WHOLE SAFETY ARGUMENT.** Engine-minted node ids come from
// `IdSource.uuid()` — hex and hyphens — so a real nodeId can never take either
// virtual form, and the collision that would let a client address a node and get
// a root (or the reverse) is structurally impossible rather than merely
// unlikely. Both forms are part of the wire contract: change either one and
// every stored client selection points at nothing.
export const PROJECT_ROOT_ID_PREFIX = 'project:';

// The singleton root for everything no live project claims (F2's orphan answer,
// settled by live data: 21 of 47 sessions resolved to no project). A bare
// literal rather than a namespaced form because there is exactly one of it and
// it has no id to namespace — and it must never be prefix-matched into: `unfil`
// addresses nothing, `unfiled` addresses this.
export const UNFILED_ROOT_ID = 'unfiled';

// The display label for the singleton root. Engine words only (#16): it says
// what the root IS — the estate nothing has filed — not what anybody intends to
// do about it.
export const UNFILED_ROOT_NAME = 'unfiled';

// The deterministic virtual id of a project's root. The ONE spelling: a consumer
// that needs to build or compare one calls this rather than concatenating.
export function projectRootId(projectId: string): string {
  return `${PROJECT_ROOT_ID_PREFIX}${projectId}`;
}

// ── the wire shape ──────────────────────────────────────────────────────────
//
// Field names are CONTRACT. Every one of them is an engine word (#16): the
// engine describes processes, directories and attention, and it never learns a
// workflow's vocabulary. Workflow state reaches this surface through the
// reserved `overlays` map or not at all.

/**
 * ⚠ **RESERVED SHAPE, EMPTY IN THIS SLICE (rule 0.5).** Every `overlays` map on
 * the wire is `{}` today and there is no writer anywhere in the codebase. The
 * shape lands now so the first producer — the tasks extension, per
 * extension-model §2.5 — is a value change rather than a wire change, and so
 * clients that render overlays are written against a field that already exists.
 * It is also the ONLY door through which a workflow's own vocabulary may ever
 * reach this payload (S14-A7).
 */
export type TreeOverlays = Readonly<Record<string, unknown>>;

// One shared frozen instance: nothing may write into a reserved map, and there
// is no per-node state to distinguish one empty map from another. Freezing makes
// "reserved" enforceable rather than merely stated.
const NO_OVERLAYS: TreeOverlays = Object.freeze({});

/**
 * A session leaf.
 *
 * ⚠ **`seenAt` AND `needsAttention` ARE TWO FIELDS AND MUST NEVER BE MERGED**
 * (D83, S14-A5). Having LOOKED at a session and having HANDLED what it asked for
 * are different facts: the `seen` fold sets `seenAt` and deliberately does not
 * touch attention, so a surface that collapsed them into one "unread" flag would
 * clear a gate by scrolling past it.
 *
 * `severity` is precomputed by `sessionSeverityOf` — the same join the rollup
 * above this leaf took its maximum over — so a client that colours a leaf and a
 * client that colours its ancestor can never disagree about which is worse.
 */
export interface TreeSession {
  readonly appSessionId: string;
  // The D79 handle, rendered against the WHOLE ESTATE (F4) — never against this
  // node's leaves, or the same four characters would name different sessions in
  // different parts of the same payload.
  readonly shortId: string;
  // The HUMAN name, or null. Distinct from `derivedTitle` on purpose: the
  // identity ladder is the client's to render, and merging the two rungs here
  // would throw away the fact that a person chose one of them.
  readonly name: string | null;
  readonly derivedTitle: string | null;
  readonly liveness: SessionRecord['liveness'];
  readonly needsAttention: SessionRecord['needsAttention'];
  readonly seenAt: string | null;
  readonly custody: SessionRecord['custody'];
  readonly severity: AttentionSeverity;
  readonly overlays: TreeOverlays;
  // Copied verbatim from `SessionRecord.createdAt` — no derivation (S15-F3).
  // The identity ladder's bottom rung renders this beside the 8-char
  // distinguisher for nameless sessions; without it two hex strings sit
  // side by side with nothing to tell them apart.
  readonly createdAt: string;
}

/**
 * A real node — one `node_created` in the log, one record in the fold.
 *
 * ORDERING IS DECLARED (S14-A11), not incidental: `nodes` are in CREATION order
 * and `sessions` are in ATTACHMENT order (the order the fold appended them to
 * `sessionIds`, which is recorded in the log rather than derived).
 *
 * `closed` and `effectivelyClosed` are both carried because they are different
 * facts: the first is what this node's own `node_closed` recorded, the second is
 * what it inherits from an ancestor. Collapsing them would lose the distinction
 * between a node somebody shut and a node sitting under one.
 */
export interface TreeNode {
  readonly nodeId: string;
  readonly name: string;
  readonly provenance: NodeProvenance | null;
  readonly directory: string | null;
  readonly closed: boolean;
  readonly effectivelyClosed: boolean;
  // Covers this node's whole SUBTREE, itself included, and counts PROCESSES
  // rather than open nodes — a closed node with a living session under it stays
  // visible in the count (E2-b pin 2, S14-A3).
  readonly rollup: NodeRollup;
  readonly overlays: TreeOverlays;
  readonly nodes: readonly TreeNode[];
  readonly sessions: readonly TreeSession[];
}

/**
 * A VIRTUAL root — composed from the project registry, never folded from an
 * event (F1). There are exactly two kinds and the id says which: a live
 * project's `project:<projectId>`, and the singleton `unfiled`.
 *
 * ORDERING IS DECLARED: roots come in project-creation order with `unfiled`
 * LAST; `nodes` are this root's top-level nodes in creation order; `sessions`
 * are the sessions that landed here by derivation rather than by attachment, in
 * session-creation order.
 *
 * `rollup` covers the root's WHOLE estate — every node beneath it plus the
 * sessions hanging directly on it. A root that counted only its nodes would read
 * quiet while unattached work burned tokens under it, which is the going-dark
 * failure the attention system exists to prevent.
 */
export interface TreeRoot {
  readonly rootId: string;
  readonly name: string;
  // The project's declared root directory; `null` for `unfiled`, which is not a
  // place on disk and must not pretend to be one.
  readonly directory: string | null;
  readonly rollup: NodeRollup;
  readonly nodes: readonly TreeNode[];
  readonly sessions: readonly TreeSession[];
}

/**
 * The whole payload.
 *
 * `orderVersion` is `ATTENTION_SEVERITY_ORDER_VERSION`, carried so a client that
 * cached a comparison against the severity order can tell that the order it
 * reasoned against is no longer the order in force. It describes the SEVERITY
 * ranking, not the sibling ordering above.
 */
export interface TreeResponse {
  readonly orderVersion: number;
  readonly roots: readonly TreeRoot[];
}

/**
 * Scoping options.
 *
 * `rootId` takes a value in the F1 grammar — `project:<projectId>` or the
 * literal `unfiled` — and matches EXACTLY. A virtual id is never prefix-resolved
 * (S14-A10): `project:` is not a wildcard and a partial id addresses nothing. An
 * id that names no root yields an empty root list rather than an error, because
 * "the scope you asked for holds nothing" is a true answer and a client that
 * kept a stale selection deserves it rather than a crash.
 */
export interface TreeOptions {
  readonly rootId?: string;
}

// ── F2's named derivation ───────────────────────────────────────────────────

/**
 * Where a session hangs when nothing has explicitly attached it: the virtual
 * root of the live project whose declared boundary contains its `cwd`, or
 * `unfiled` when none does.
 *
 * ⚠ **IT DELEGATES TO `projectForCwd` AND MUST KEEP DOING SO.** That function is
 * the only attribution authority in VIMES — longest-prefix-wins over
 * non-archived projects, segment-boundary exact, ties structurally impossible
 * because the writer refuses a duplicate live root. Re-spelling prefix matching
 * here would be a second opinion about what a project contains, and the day the
 * two disagree is the day a session appears under the wrong estate.
 *
 * An ARCHIVED project's boundary claims nothing (that is what archiving means to
 * `projectForCwd`), so a session inside one lands in `unfiled` — visible, never
 * silently dropped.
 *
 * PURE and TOTAL: string comparison only, and it always returns a root id.
 */
export function defaultRootForSession(projects: ProjectsState, cwd: string): string {
  const owningProject = projectForCwd(projects, cwd);
  if (owningProject === null) {
    return UNFILED_ROOT_ID;
  }
  return projectRootId(owningProject.projectId);
}

// ── the composition ─────────────────────────────────────────────────────────

/**
 * The forest, composed.
 *
 * ⚠ **EVERY SESSION IN `sessions` APPEARS EXACTLY ONCE (S14-A1).** Explicit
 * attachment wins; everything else falls to `defaultRootForSession`. There is no
 * third path and no path that drops a session: a session whose cwd matches
 * nothing lands in `unfiled`, and a session whose project has been archived
 * lands there too.
 *
 * ⚠ **ORDERING IS DECLARED AND EVERY DIMENSION OF IT IS DURABLE** (S14-F2
 * closed, 2026-08-12). Attachment order is recorded (an array in the fold);
 * project-, node- and session-creation order are each SORTED from a `createdAt`
 * that is the `ts` of the record's own birth event, with the record's id as the
 * declared tiebreak. Nothing here reads a projection map's insertion order,
 * which is the point: a snapshot serializes state through `canonicalJson` and
 * that sorts object keys deeply, so any order taken from map iteration would be
 * exact in a fresh fold and silently lexicographic-by-id in production. See the
 * ordering helpers at the bottom of this file.
 */
export function treeOf(
  projects: ProjectsState,
  nodes: NodesState,
  sessions: SessionsState,
  options: TreeOptions = {},
): TreeResponse {
  // ── whole-estate joins, computed ONCE and before any scoping ──────────────
  //
  // ⚠ **SCOPE IS THE ESTATE, NOT THE FILTER (F4).** Short ids are rendered over
  // every session the projection holds, so asking for one root's subtree yields
  // the same handles as asking for all of them. Rendering them per-scope would
  // make the same four characters name different sessions either side of a
  // project switch, and a command grammar built on that is unsafe.
  const estateSessionIds = Object.keys(sessions.sessions);
  const shortIdBySessionId = shortSessionIds(estateSessionIds);

  // The ONE severity reading per session, taken here so the leaf and every
  // rollup above it are literally the same value rather than two calls that
  // could drift.
  const severityBySessionId = new Map<string, AttentionSeverity>();
  for (const session of Object.values(sessions.sessions)) {
    severityBySessionId.set(
      session.appSessionId,
      sessionSeverityOf(session.liveness, session.needsAttention),
    );
  }
  const severityOfSession = (appSessionId: string): AttentionSeverity | undefined =>
    severityBySessionId.get(appSessionId);

  // ── which roots exist ─────────────────────────────────────────────────────
  //
  // ⚠ **A ROOT PER LIVE PROJECT, AND EVERYTHING ELSE UNDER `unfiled`.** Archived
  // projects get no root, for the same reason `projectForCwd` skips them: an
  // archived boundary has stopped claiming live work, and that is one rule
  // rather than two. The consequence is deliberate — a node still carrying an
  // archived project's id hangs under `unfiled` beside the sessions whose cwd
  // resolves nowhere, which is the honest place for an estate no live boundary
  // claims. What must never happen is either of them vanishing from the payload.
  const orderedProjects = liveProjectsInCreationOrder(projects);
  const rootIdByProjectId = new Map<string, string>();
  for (const project of orderedProjects) {
    rootIdByProjectId.set(project.projectId, projectRootId(project.projectId));
  }

  // ── where each session hangs ──────────────────────────────────────────────
  const defaultedSessionIdsByRootId = new Map<string, string[]>();
  for (const session of sessionsInCreationOrder(sessions)) {
    if (nodeIdForSession(nodes, session.appSessionId) !== null) {
      // Explicitly attached — it is rendered at its node, in attachment order.
      continue;
    }
    appendTo(
      defaultedSessionIdsByRootId,
      defaultRootForSession(projects, session.cwd),
      session.appSessionId,
    );
  }

  // ── which nodes sit directly under which root ─────────────────────────────
  //
  // Only PARENTLESS nodes need placing: every other node is placed by its own
  // `parentNodeId`, and the fold guarantees that parent exists (a creation with
  // an unknown parent is dropped, which is what makes the forest a forest).
  //
  // ⚠ SORTED BEFORE BUCKETING, not after: these buckets ARE the render order
  // for a root's top-level nodes, and iterating the map here would reintroduce
  // exactly the insertion-order dependence `childNodeIdsInCreationOrder` was
  // fixed to remove — one level up, where it is harder to see.
  const topLevelNodeIdsByRootId = new Map<string, string[]>();
  for (const node of Object.values(nodes.nodes).sort(compareNodesByCreation)) {
    if (node.parentNodeId !== null) {
      continue;
    }
    appendTo(
      topLevelNodeIdsByRootId,
      rootIdByProjectId.get(node.projectId) ?? UNFILED_ROOT_ID,
      node.nodeId,
    );
  }

  const buildContext: BuildContext = {
    nodes,
    sessions,
    shortIdBySessionId,
    severityBySessionId,
    severityOfSession,
    topLevelNodeIdsByRootId,
    defaultedSessionIdsByRootId,
  };

  const allRoots: TreeRoot[] = orderedProjects.map((project) =>
    buildRoot(buildContext, projectRootId(project.projectId), projectDisplayName(project), project.root),
  );
  // ⚠ **`unfiled` IS LAST AND IT IS ALWAYS PRESENT**, even holding nothing. Last
  // because it is the residue rather than a peer of the declared boundaries;
  // always because a root list whose membership depends on the data is a list
  // clients cannot address reliably — `rootId: 'unfiled'` would sometimes match
  // nothing and sometimes match an empty root, for reasons invisible from the
  // outside.
  allRoots.push(buildRoot(buildContext, UNFILED_ROOT_ID, UNFILED_ROOT_NAME, null));

  const requestedRootId = options.rootId;
  const selectedRoots =
    requestedRootId === undefined
      ? allRoots
      : // EXACT match, never a prefix — see `TreeOptions`.
        allRoots.filter((root) => root.rootId === requestedRootId);

  return { orderVersion: ATTENTION_SEVERITY_ORDER_VERSION, roots: selectedRoots };
}

interface BuildContext {
  readonly nodes: NodesState;
  readonly sessions: SessionsState;
  readonly shortIdBySessionId: ReadonlyMap<string, string>;
  readonly severityBySessionId: ReadonlyMap<string, AttentionSeverity>;
  readonly severityOfSession: (appSessionId: string) => AttentionSeverity | undefined;
  readonly topLevelNodeIdsByRootId: ReadonlyMap<string, readonly string[]>;
  readonly defaultedSessionIdsByRootId: ReadonlyMap<string, readonly string[]>;
}

function buildRoot(
  context: BuildContext,
  rootId: string,
  name: string,
  directory: string | null,
): TreeRoot {
  const childNodes = (context.topLevelNodeIdsByRootId.get(rootId) ?? []).map((nodeId) =>
    buildNode(context, nodeId),
  );
  const rootSessions = (context.defaultedSessionIdsByRootId.get(rootId) ?? []).flatMap(
    (appSessionId) => {
      const leaf = buildSession(context, appSessionId);
      return leaf === null ? [] : [leaf];
    },
  );

  // The root's own rollup: the sum of its subtrees plus the work hanging
  // directly on it. Composed from the children's rollups rather than re-walked,
  // so there is one counting rule (`rollupNode`'s) and this function only adds.
  let processCount = 0;
  const severities: (AttentionSeverity | null)[] = [];
  for (const childNode of childNodes) {
    processCount += childNode.rollup.processCount;
    severities.push(childNode.rollup.worst);
  }
  for (const leaf of rootSessions) {
    processCount += 1;
    severities.push(leaf.severity);
  }

  return {
    rootId,
    name,
    directory,
    rollup: { worst: worstOf(severities), processCount },
    nodes: childNodes,
    sessions: rootSessions,
  };
}

function buildNode(context: BuildContext, nodeId: string): TreeNode {
  const node = context.nodes.nodes[nodeId]!;
  return {
    nodeId: node.nodeId,
    name: node.name,
    // Write-once at creation and never touched by any fold since (S14-A2); this
    // read model has no path that could change it either — it copies.
    provenance: node.provenance,
    directory: node.directory,
    closed: node.closed,
    effectivelyClosed: isEffectivelyClosed(context.nodes, node.nodeId),
    rollup: rollupNode(context.nodes, node.nodeId, context.severityOfSession),
    overlays: NO_OVERLAYS,
    nodes: childNodeIdsInCreationOrder(context.nodes, node.nodeId).map((childNodeId) =>
      buildNode(context, childNodeId),
    ),
    // ATTACHMENT ORDER, straight off the record — the fold appends and never
    // sorts, so this order is recorded in the log rather than derived here.
    sessions: node.sessionIds.flatMap((appSessionId) => {
      const leaf = buildSession(context, appSessionId);
      return leaf === null ? [] : [leaf];
    }),
  };
}

// `null` when the sessions projection has no record for this id. That is not an
// error and it is not silence either: `rollupNode` has already COUNTED the
// attachment (it counts `sessionIds`, not records), so an attachment to a
// session this projection has never seen still shows up in the process count of
// every ancestor. What is impossible is rendering a leaf for it, because every
// field of that leaf would have to be invented.
function buildSession(context: BuildContext, appSessionId: string): TreeSession | null {
  const session = context.sessions.sessions[appSessionId];
  if (session === undefined) {
    return null;
  }
  return {
    appSessionId: session.appSessionId,
    // The estate-wide handle; falls back to the id itself if the session somehow
    // was not in the set the map was built from, which cannot happen from inside
    // this function but keeps the field a string rather than an optional.
    shortId: context.shortIdBySessionId.get(appSessionId) ?? appSessionId,
    name: session.name,
    derivedTitle: session.derivedTitle ?? null,
    liveness: session.liveness,
    needsAttention: session.needsAttention,
    seenAt: session.seenAt,
    custody: session.custody,
    severity:
      context.severityBySessionId.get(appSessionId) ??
      sessionSeverityOf(session.liveness, session.needsAttention),
    overlays: NO_OVERLAYS,
    createdAt: session.createdAt,
  };
}

// ── ordering helpers, each with its own honesty note ────────────────────────

// ⚠ **PROJECT-CREATION ORDER IS DURABLE (S14-F2 fixed, 2026-08-12).** It is
// SORTED from `ProjectRecord.createdAt` — the `ts` of the project's own
// `project_created` record — rather than read off the projection map's
// insertion order. Map order is exact on a fresh fold and silently
// lexicographic-by-projectId after a snapshot round-trip (`canonicalJson` sorts
// object keys deeply), so the pre-fix ordering told the truth in tests and quietly
// degraded in production. Sorting on a recorded field makes the rendered order a
// function of the RECORDS, not of how the state was reconstructed.
//
// **TIEBREAK: `projectId`, and it is DECLARED rather than incidental.** Two
// projects created in the same millisecond is not hypothetical — the writer can
// append two `project_created` records in one batch, and this store stamps a
// batch from one clock read per record but a real clock has finite resolution.
// The id makes the comparison TOTAL, so the sort is a pure function of the
// records and never depends on their arrival order. Same shape as
// `sessionsInCreationOrder` below, deliberately.
function liveProjectsInCreationOrder(projects: ProjectsState): ProjectRecord[] {
  return Object.values(projects.projects)
    .filter((project) => !project.archived)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      if (left.projectId === right.projectId) {
        return 0;
      }
      return left.projectId < right.projectId ? -1 : 1;
    });
}

// The same rule, on the same durable marker, for the same reason:
// `NodeRecord.createdAt` is the `ts` of the node's own `node_created` record,
// and `nodeId` is the DECLARED tiebreak that makes the comparison total.
function childNodeIdsInCreationOrder(nodes: NodesState, parentNodeId: string): string[] {
  return Object.values(nodes.nodes)
    .filter((candidateNode) => candidateNode.parentNodeId === parentNodeId)
    .sort(compareNodesByCreation)
    .map((node) => node.nodeId);
}

function compareNodesByCreation(left: NodeRecord, right: NodeRecord): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.nodeId === right.nodeId) {
    return 0;
  }
  return left.nodeId < right.nodeId ? -1 : 1;
}

// ⚠ **SESSION-CREATION ORDER IS DURABLE, AND THIS IS WHY IT IS SORTED RATHER
// THAN READ OFF MAP ORDER.** `SessionRecord.createdAt` is the `ts` of the
// session's own birth record, so this ordering survives a snapshot round-trip
// that map order would not. `appSessionId` breaks ties — two sessions created in
// the same millisecond is not hypothetical (the live log holds a pair one
// millisecond apart) — so the comparison is total and the sort is stable in the
// only sense that matters: it is a function of the records, not of their
// arrival.
function sessionsInCreationOrder(sessions: SessionsState): SessionRecord[] {
  return Object.values(sessions.sessions).sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    if (left.appSessionId === right.appSessionId) {
      return 0;
    }
    return left.appSessionId < right.appSessionId ? -1 : 1;
  });
}

// ── small shared mechanics ──────────────────────────────────────────────────

function appendTo(buckets: Map<string, string[]>, key: string, value: string): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [value]);
    return;
  }
  bucket.push(value);
}

// The maximum of a set of readings under the versioned order, `null` when there
// is nothing to report. ⚠ `null` is NEVER coerced to the quietest rank: "nothing
// to report" and "everything is quiet" are different facts, and an empty root
// impersonating a calm one is the same lie an empty node would tell (S14-A4's
// empty-node clause, applied one level up).
function worstOf(severities: readonly (AttentionSeverity | null)[]): AttentionSeverity | null {
  let worstRank = -1;
  let worst: AttentionSeverity | null = null;
  for (const severity of severities) {
    if (severity === null) {
      continue;
    }
    const rank: number | undefined = ATTENTION_SEVERITY_RANKS[severity];
    if (rank === undefined || rank <= worstRank) {
      continue;
    }
    worstRank = rank;
    worst = severity;
  }
  return worst;
}
