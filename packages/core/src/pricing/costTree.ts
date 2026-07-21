// ─── slice 5b step 3 — the tree + rollups (PURE, packages/core) ──────────────
//
// Assemble Step 2's per-row `PricedRow`s into the hierarchy Wes asked for —
// project → session → subagent, as a genuine TREE (nesting is real to depth 3+,
// survey Q2) — with dollar rollups that RECONCILE exactly.
//
// Rule 0.3: pure arithmetic over data. No clock, no randomness, no I/O. This
// module NEVER re-prices — it consumes the `PricedRow` Step 2 produced.
//
// The load-bearing guarantee (Deliverable 3): for every node,
//   subtree === own + Σ(child.subtree)   — exact integer equality.
// A mismatch is a rule-0.1 FINDING: `assertTreeReconciles` throws with the
// offending node and the delta; it is never "fixed" by adjusting a total.
//
// Two truths the naive project→session→subagent model gets wrong (survey Q2):
//   1. The agent→agent edge is NOT in the directory layout (flat). It is
//      harvested from `toolUseResult.agentId`: a row whose toolUseResultAgentId
//      is B means that row's own agentId is B's PARENT. Coverage is ~46%.
//   2. The other ~54% have no recoverable parent — they attach to their SESSION
//      ROOT (the session edge is reliable, 0 orphans). Never guessed.
//
// Pillar 4 discipline: a non-priced row (unpriced / unpriceable / flagged,
// amountNanoDollars null) must NEVER collapse to $0. The dollar total is the
// PRICED sum only; the un-knowns are carried ALONGSIDE as per-status counts and
// token sums, at every node and rolled up. An un-known that reads as $0 is a lie.

import type { PriceStatus, PricedRow } from './priceUsageRow.js';

// ── the input row ────────────────────────────────────────────────────────────
// The attribution-relevant fields of the daemon's `CostUsageRow` (costCorpus.ts),
// re-declared here so core does NOT import from the daemon (rule 0.3), plus the
// `PricedRow` Step 2 produced for this row. Take only what the tree needs.
export interface CostTreeInputRow {
  // The session edge — reliable, 0 orphans (survey Q1). Never guessed. In the live
  // corpus this is never null; typed nullable to mirror the daemon row and handled
  // via a stable sentinel if it ever is.
  readonly sessionId: string | null;
  // null on a session-root record (the main session's own messages); a hex id on a
  // subagent record. Node identity is (sessionId, agentId).
  readonly agentId: string | null;
  // The parent→child JOIN key: on a row that SPAWNED an agent, this is the CHILD's
  // agentId, so this row's own `agentId` is the child's parent (survey Q2). Used to
  // build the parent map; ~46% of agents have a recoverable edge this way.
  readonly toolUseResultAgentId: string | null;

  readonly projectSlug: string;
  // The record's own cwd. Slugs are NOT projects (rule 7); classification runs
  // against cwd + insideProjectRoots, never the slug directory name.
  readonly projectCwd: string | null;
  // FALSE = the outside-`VIMES_PROJECT_ROOTS` bucket. Retained + labelled, never
  // dropped (rule 7).
  readonly insideProjectRoots: boolean;

  readonly attributionAgent: string | null;
  readonly attributionSkill: string | null;
  readonly sourceKind: string;

  // The row's raw token counts (Step 1's six fields, minus the cache aggregate).
  // Optional: dollars come entirely from `priced`, so omitting this leaves dollar
  // rollups exact. It feeds ONLY tokensByStatus, so a node can quantify how much
  // un-known token volume (unpriced / unpriceable / flagged) sits alongside its
  // priced dollars — the Pillar-4 "N tokens unpriced" number.
  readonly tokens?: RowTokenCounts;

  // Step 2's output for this row. Consumed, never re-derived.
  readonly priced: PricedRow;
}

// ── rollup totals — dollars AND the un-knowns carried alongside ──────────────
export type PriceStatusCounts = { readonly [Status in PriceStatus]: number };

export interface RollupTotals {
  // Integer nano-dollars — the PRICED sum only. Non-priced rows contribute 0 here
  // and are surfaced in the fields below instead (never as $0 in the dollar total).
  readonly pricedNanoDollars: number;
  // Of `pricedNanoDollars`, the portion from unvalidated (priced-by-analogy,
  // sonnet-4-6) rows — so a surface can render "$ (unvalidated)" honestly.
  readonly unvalidatedNanoDollars: number;
  // Row counts per status: how many priced / unpriced / unpriceable / flagged.
  readonly statusCounts: PriceStatusCounts;
  // Token sums per status: a node can say "$X priced, PLUS N tokens unpriced /
  // M unpriceable / K flagged" — the un-known never vanishes and never reads $0.
  readonly tokensByStatus: PriceStatusCounts;
  readonly rowCount: number;
}

// The six token fields Step 1 emits; summed to attribute a row's token weight to
// its status bucket. cacheCreationInputTokens (the aggregate) is EXCLUDED — it is
// 5m+1h and adding it double-counts (the part-4 cache-tier trap).
export interface RowTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
}

// ── the tree nodes ───────────────────────────────────────────────────────────
export interface AgentNode {
  readonly sessionId: string;
  readonly agentId: string;
  // The resolved parent agentId; null = attached directly to the session root.
  readonly parentAgentId: string | null;
  // TRUE = parent recovered from a `toolUseResult.agentId` edge; FALSE = no edge,
  // fell back to the session root (the ~54%). Lets a surface show attribution
  // confidence honestly.
  readonly parentResolved: boolean;
  readonly own: RollupTotals;
  readonly children: readonly AgentNode[];
  readonly subtree: RollupTotals;
}

export interface SessionNode {
  readonly sessionId: string;
  // Rows on this node directly = the session's own messages (agentId null).
  readonly own: RollupTotals;
  // Top-level agents: parent recovered as the session root, or unattributed.
  readonly agents: readonly AgentNode[];
  readonly subtree: RollupTotals;
}

export interface ProjectNode {
  // The project directory (inside roots) or the shared outside-roots sentinel.
  readonly projectKey: string;
  // FALSE only for the single outside-`VIMES_PROJECT_ROOTS` bucket.
  readonly insideProjectRoots: boolean;
  readonly sessions: readonly SessionNode[];
  // No rows attach directly to a project (every row has a session), so own is
  // always zero-valued; kept for a uniform node shape and reconciliation.
  readonly own: RollupTotals;
  readonly subtree: RollupTotals;
}

export interface AttributionGroup {
  // The attributionSkill / attributionAgent value, or the ABSENT sentinel.
  readonly key: string;
  readonly totals: RollupTotals;
}

export interface CostTree {
  readonly projects: readonly ProjectNode[];
  // Grand total over every row = Σ project subtrees. Reconciles with the secondary
  // groupings (each row lands in exactly one skill and one agent bucket).
  readonly grandTotal: RollupTotals;
  readonly byAttributionSkill: readonly AttributionGroup[];
  readonly byAttributionAgent: readonly AttributionGroup[];
}

export interface BuildCostTreeOptions {
  // Project-parent directories (injected data, pure — the daemon supplies the
  // lab's category dirs). A row's project is the immediate child of the longest
  // matched root. Empty (default) → project keys fall back to the honest full cwd.
  readonly projectRoots?: readonly string[];
}

// The single explicit bucket for rows outside VIMES_PROJECT_ROOTS (rule 7).
export const OUTSIDE_ROOTS_PROJECT_KEY = '<outside-project-roots>';
// The bucket for a row whose sessionId is absent (never seen in the live corpus;
// handled rather than assumed away).
export const UNKNOWN_SESSION_KEY = '<unknown-session>';
// The explicit bucket for an absent attributionSkill / attributionAgent — its own
// bucket, never dropped (Deliverable 4).
export const ABSENT_ATTRIBUTION_KEY = '<absent>';

// Path separator for project-root prefix matching. The corpus is POSIX; a
// separator-boundary compare so `/a/bc` never counts as inside `/a/b`.
const PATH_SEPARATOR = '/';

const EMPTY_STATUS_COUNTS: PriceStatusCounts = {
  priced: 0,
  unpriced: 0,
  unpriceable: 0,
  flagged: 0,
};

// ── row → its token weight (excludes the cache aggregate) ────────────────────
function rowTokenTotal(tokenCounts: RowTokenCounts): number {
  return (
    tokenCounts.inputTokens +
    tokenCounts.outputTokens +
    tokenCounts.cacheReadInputTokens +
    tokenCounts.cacheCreation5mInputTokens +
    tokenCounts.cacheCreation1hInputTokens
  );
}

// ── mutable accumulator (internal) ───────────────────────────────────────────
interface MutableTotals {
  pricedNanoDollars: number;
  unvalidatedNanoDollars: number;
  statusCounts: { priced: number; unpriced: number; unpriceable: number; flagged: number };
  tokensByStatus: { priced: number; unpriced: number; unpriceable: number; flagged: number };
  rowCount: number;
}

function newMutableTotals(): MutableTotals {
  return {
    pricedNanoDollars: 0,
    unvalidatedNanoDollars: 0,
    statusCounts: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 },
    tokensByStatus: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 },
    rowCount: 0,
  };
}

// Fold one row's priced result into an accumulator. The ONLY place a row's dollars
// and status are counted — every row folds into exactly one node's `own` (and, via
// the flat pass, exactly one skill and one agent bucket).
function foldRow(target: MutableTotals, row: CostTreeInputRow): void {
  const priced = row.priced;
  target.rowCount += 1;
  target.statusCounts[priced.status] += 1;

  const tokenWeight = tokenTotalForRow(row);
  target.tokensByStatus[priced.status] += tokenWeight;

  if (priced.status === 'priced' && priced.amountNanoDollars !== null) {
    target.pricedNanoDollars += priced.amountNanoDollars;
    if (priced.validated === false) {
      target.unvalidatedNanoDollars += priced.amountNanoDollars;
    }
  }
  // unpriced / unpriceable / flagged: amountNanoDollars is null — it contributes
  // NOTHING to the dollar total (never a silent $0), and is surfaced via the
  // status counts + token sums above.
}

// Token weight of a row, from its optional explicit token counts. When omitted,
// token weight is 0 — dollars are unaffected (they come from `priced`); this only
// feeds the tokensByStatus report.
function tokenTotalForRow(row: CostTreeInputRow): number {
  if (row.tokens === undefined) {
    return 0;
  }
  return rowTokenTotal(row.tokens);
}

function freezeTotals(mutable: MutableTotals): RollupTotals {
  return {
    pricedNanoDollars: mutable.pricedNanoDollars,
    unvalidatedNanoDollars: mutable.unvalidatedNanoDollars,
    statusCounts: { ...mutable.statusCounts },
    tokensByStatus: { ...mutable.tokensByStatus },
    rowCount: mutable.rowCount,
  };
}

// Sum a list of already-frozen child totals into a running accumulator (used to
// build a subtree from its children).
function addTotals(target: MutableTotals, addend: RollupTotals): void {
  target.pricedNanoDollars += addend.pricedNanoDollars;
  target.unvalidatedNanoDollars += addend.unvalidatedNanoDollars;
  target.rowCount += addend.rowCount;
  for (const status of ['priced', 'unpriced', 'unpriceable', 'flagged'] as const) {
    target.statusCounts[status] += addend.statusCounts[status];
    target.tokensByStatus[status] += addend.tokensByStatus[status];
  }
}

function emptyTotals(): RollupTotals {
  return freezeTotals(newMutableTotals());
}

// ── Deliverable 1: the parent-edge map (the 54% problem) ─────────────────────
// A row whose `toolUseResultAgentId` is B means that row's own `agentId` is B's
// PARENT. Build childAgentId → parentAgentId (parent null = spawned by the session
// root directly). Keyed within a session — the child shares the spawner's session.
export interface AgentParentEdge {
  readonly parentAgentId: string | null;
}

// Composite key for a (sessionId, agentId) node. The `::` delimiter cannot appear
// in a uuid session id or a hex agent id, so the join is unambiguous — and it is
// printable, never a control byte.
const NODE_KEY_DELIMITER = '::';

function sessionKeyOf(sessionId: string | null): string {
  return sessionId ?? UNKNOWN_SESSION_KEY;
}

function nodeKey(sessionId: string | null, agentId: string): string {
  return `${sessionKeyOf(sessionId)}${NODE_KEY_DELIMITER}${agentId}`;
}

export function buildParentMap(rows: readonly CostTreeInputRow[]): Map<string, AgentParentEdge> {
  const parentByChildNodeKey = new Map<string, AgentParentEdge>();
  for (const row of rows) {
    const childAgentId = row.toolUseResultAgentId;
    if (childAgentId === null) {
      continue;
    }
    const childNodeKey = nodeKey(row.sessionId, childAgentId);
    // First edge wins deterministically; a child has one spawner.
    if (!parentByChildNodeKey.has(childNodeKey)) {
      parentByChildNodeKey.set(childNodeKey, { parentAgentId: row.agentId });
    }
  }
  return parentByChildNodeKey;
}

// ── Deliverable 2: project classification (rule 7) ───────────────────────────
function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const rootWithBoundary = root.endsWith(PATH_SEPARATOR) ? root : root + PATH_SEPARATOR;
  return candidatePath === root || candidatePath.startsWith(rootWithBoundary);
}

// The project a row belongs to: the OUTSIDE bucket when not inside roots, else the
// immediate child directory of the longest matched project-parent root, else (no
// root matched / none configured) the honest full cwd. Never a slug (rule 7).
export function resolveProjectKey(
  row: CostTreeInputRow,
  projectRoots: readonly string[],
): { projectKey: string; insideProjectRoots: boolean } {
  if (!row.insideProjectRoots || row.projectCwd === null) {
    return { projectKey: OUTSIDE_ROOTS_PROJECT_KEY, insideProjectRoots: false };
  }
  const projectCwd = row.projectCwd;
  let longestMatchedRoot: string | null = null;
  for (const root of projectRoots) {
    if (isPathWithinRoot(projectCwd, root) && (longestMatchedRoot === null || root.length > longestMatchedRoot.length)) {
      longestMatchedRoot = root;
    }
  }
  if (longestMatchedRoot === null) {
    // No project-parent root configured/matched: group by the honest cwd rather
    // than invent a project boundary.
    return { projectKey: projectCwd, insideProjectRoots: true };
  }
  const rootWithBoundary = longestMatchedRoot.endsWith(PATH_SEPARATOR)
    ? longestMatchedRoot
    : longestMatchedRoot + PATH_SEPARATOR;
  const belowRoot = projectCwd.startsWith(rootWithBoundary)
    ? projectCwd.slice(rootWithBoundary.length)
    : '';
  const firstSegment = belowRoot.split(PATH_SEPARATOR)[0];
  if (firstSegment === undefined || firstSegment === '') {
    // cwd IS the root exactly (e.g. a session launched at the project-parent) —
    // no project segment below it; keep the cwd as the honest key.
    return { projectKey: projectCwd, insideProjectRoots: true };
  }
  return { projectKey: rootWithBoundary + firstSegment, insideProjectRoots: true };
}

// ── the build: bottom-up so every subtree = own + Σ children by construction ──
interface AgentBuildState {
  readonly sessionId: string;
  readonly agentId: string;
  parentAgentId: string | null;
  parentResolved: boolean;
  readonly own: MutableTotals;
  readonly childAgentIds: string[];
}

export function buildCostTree(
  rows: readonly CostTreeInputRow[],
  options: BuildCostTreeOptions = {},
): CostTree {
  const projectRoots = options.projectRoots ?? [];
  const parentMap = buildParentMap(rows);

  // Pass 0: a session belongs to ONE project (project → session → agent). A
  // session is launched in one directory, and its session-root records (agentId
  // null) carry that launch cwd — the true project — even when subagents cd into
  // worktrees that classify elsewhere (3 sessions span >1 classification in the
  // live corpus). So each session's project is chosen from its root rows (the
  // lexically smallest key, for determinism, if a session's roots ever disagree);
  // a session with no root row (defensive — none in the corpus) falls back to the
  // smallest project key among all its rows.
  const rootProjectCandidates = new Map<string, Set<string>>();
  const anyProjectCandidates = new Map<string, Set<string>>();
  const projectClassificationByKey = new Map<string, boolean>();
  for (const row of rows) {
    const sessionId = sessionKeyOf(row.sessionId);
    const classification = resolveProjectKey(row, projectRoots);
    projectClassificationByKey.set(classification.projectKey, classification.insideProjectRoots);
    const anySet = anyProjectCandidates.get(sessionId) ?? new Set<string>();
    anySet.add(classification.projectKey);
    anyProjectCandidates.set(sessionId, anySet);
    if (row.agentId === null) {
      const rootSet = rootProjectCandidates.get(sessionId) ?? new Set<string>();
      rootSet.add(classification.projectKey);
      rootProjectCandidates.set(sessionId, rootSet);
    }
  }
  const sessionProjectKey = new Map<string, string>();
  for (const [sessionId, anySet] of anyProjectCandidates) {
    const rootSet = rootProjectCandidates.get(sessionId);
    const candidates = rootSet !== undefined && rootSet.size > 0 ? rootSet : anySet;
    const chosen = [...candidates].sort()[0]!;
    sessionProjectKey.set(sessionId, chosen);
  }

  // Pass 1: bucket every row into exactly one node's `own`.
  // project → session → (session-own | agent-own).
  interface ProjectBuildState {
    readonly projectKey: string;
    readonly insideProjectRoots: boolean;
    readonly sessionIds: string[];
  }
  const projectStates = new Map<string, ProjectBuildState>();
  const sessionOwnTotals = new Map<string, MutableTotals>();
  const sessionAgentIds = new Map<string, string[]>();
  const agentStates = new Map<string, AgentBuildState>();

  const ensureProject = (projectKey: string, insideRoots: boolean): ProjectBuildState => {
    let state = projectStates.get(projectKey);
    if (state === undefined) {
      state = { projectKey, insideProjectRoots: insideRoots, sessionIds: [] };
      projectStates.set(projectKey, state);
    }
    return state;
  };

  const ensureSession = (sessionId: string, projectKey: string): void => {
    if (!sessionOwnTotals.has(sessionId)) {
      sessionOwnTotals.set(sessionId, newMutableTotals());
      sessionAgentIds.set(sessionId, []);
      const projectState = projectStates.get(projectKey);
      if (projectState !== undefined) {
        projectState.sessionIds.push(sessionId);
      }
    }
  };

  const ensureAgent = (sessionId: string, agentId: string): AgentBuildState => {
    const key = nodeKey(sessionId, agentId);
    let state = agentStates.get(key);
    if (state === undefined) {
      state = {
        sessionId,
        agentId,
        parentAgentId: null,
        parentResolved: false,
        own: newMutableTotals(),
        childAgentIds: [],
      };
      agentStates.set(key, state);
      const agentList = sessionAgentIds.get(sessionId);
      if (agentList !== undefined) {
        agentList.push(agentId);
      }
    }
    return state;
  };

  for (const row of rows) {
    const sessionId = sessionKeyOf(row.sessionId);
    const projectKey = sessionProjectKey.get(sessionId)!;
    const insideProjectRoots = projectClassificationByKey.get(projectKey) ?? false;
    ensureProject(projectKey, insideProjectRoots);
    ensureSession(sessionId, projectKey);

    if (row.agentId === null) {
      // Session-root record: the session's own messages.
      foldRow(sessionOwnTotals.get(sessionId)!, row);
    } else {
      const agentState = ensureAgent(sessionId, row.agentId);
      foldRow(agentState.own, row);
    }
  }

  // Pass 2: resolve each agent's parent. Edge from the parent map (46%) → nest
  // under that agent (if it exists as a node and does not form a cycle); else
  // attach to the session root (the ~54% fallback). parent === null in the map
  // means "spawned by the session root" → also the session root.
  const agentChildLinks = new Map<string, string[]>(); // parent nodeKey → child agentIds
  for (const agentState of agentStates.values()) {
    const edge = parentMap.get(nodeKey(agentState.sessionId, agentState.agentId));
    if (edge !== undefined && edge.parentAgentId !== null) {
      const parentKey = nodeKey(agentState.sessionId, edge.parentAgentId);
      const parentExists = agentStates.has(parentKey);
      if (parentExists && !wouldFormCycle(agentStates, agentState.sessionId, agentState.agentId, edge.parentAgentId)) {
        agentState.parentAgentId = edge.parentAgentId;
        agentState.parentResolved = true;
        const links = agentChildLinks.get(parentKey) ?? [];
        links.push(agentState.agentId);
        agentChildLinks.set(parentKey, links);
        continue;
      }
    }
    // Fallback: attach to the session root (the ~54%, or an edge whose parent is
    // missing / would cycle). parentResolved stays false.
    agentState.parentAgentId = null;
    agentState.parentResolved = false;
  }

  // Record resolved child lists on the agent states (deterministic order).
  for (const [parentKey, childAgentIds] of agentChildLinks) {
    const parentState = agentStates.get(parentKey);
    if (parentState !== undefined) {
      childAgentIds.sort();
      parentState.childAgentIds.push(...childAgentIds);
    }
  }

  // Pass 3: freeze bottom-up. Agent subtree = own + Σ child subtrees (recursive);
  // session subtree = own + Σ top-level agent subtrees; project subtree = Σ session
  // subtrees; grand total = Σ project subtrees. Subtree === own + Σ children BY
  // CONSTRUCTION — `assertTreeReconciles` verifies it independently.
  const frozenAgentCache = new Map<string, AgentNode>();

  const buildAgentNode = (sessionId: string, agentId: string): AgentNode => {
    const cacheKey = nodeKey(sessionId, agentId);
    const cached = frozenAgentCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const state = agentStates.get(cacheKey)!;
    const childNodes = state.childAgentIds.map((childAgentId) => buildAgentNode(sessionId, childAgentId));
    const subtree = newMutableTotals();
    addTotals(subtree, freezeTotals(state.own));
    for (const childNode of childNodes) {
      addTotals(subtree, childNode.subtree);
    }
    const node: AgentNode = {
      sessionId,
      agentId,
      parentAgentId: state.parentAgentId,
      parentResolved: state.parentResolved,
      own: freezeTotals(state.own),
      children: childNodes,
      subtree: freezeTotals(subtree),
    };
    frozenAgentCache.set(cacheKey, node);
    return node;
  };

  const buildSessionNode = (sessionId: string): SessionNode => {
    const ownMutable = sessionOwnTotals.get(sessionId)!;
    const topLevelAgentIds = (sessionAgentIds.get(sessionId) ?? []).filter((agentId) => {
      const state = agentStates.get(nodeKey(sessionId, agentId))!;
      return state.parentAgentId === null;
    });
    topLevelAgentIds.sort();
    const agentNodes = topLevelAgentIds.map((agentId) => buildAgentNode(sessionId, agentId));
    const subtree = newMutableTotals();
    addTotals(subtree, freezeTotals(ownMutable));
    for (const agentNode of agentNodes) {
      addTotals(subtree, agentNode.subtree);
    }
    return {
      sessionId,
      own: freezeTotals(ownMutable),
      agents: agentNodes,
      subtree: freezeTotals(subtree),
    };
  };

  const projectNodes: ProjectNode[] = [];
  const sortedProjectKeys = [...projectStates.keys()].sort();
  const grandTotal = newMutableTotals();
  for (const projectKey of sortedProjectKeys) {
    const projectState = projectStates.get(projectKey)!;
    const sortedSessionIds = [...projectState.sessionIds].sort();
    const sessionNodes = sortedSessionIds.map((sessionId) => buildSessionNode(sessionId));
    const subtree = newMutableTotals();
    for (const sessionNode of sessionNodes) {
      addTotals(subtree, sessionNode.subtree);
    }
    const frozenSubtree = freezeTotals(subtree);
    projectNodes.push({
      projectKey,
      insideProjectRoots: projectState.insideProjectRoots,
      sessions: sessionNodes,
      own: emptyTotals(),
      subtree: frozenSubtree,
    });
    addTotals(grandTotal, frozenSubtree);
  }

  // ── Deliverable 4: secondary flat groupings ────────────────────────────────
  const byAttributionSkill = groupRowsBy(rows, (row) => row.attributionSkill);
  const byAttributionAgent = groupRowsBy(rows, (row) => row.attributionAgent);

  return {
    projects: projectNodes,
    grandTotal: freezeTotals(grandTotal),
    byAttributionSkill,
    byAttributionAgent,
  };
}

// Detect whether making `candidateParentAgentId` the parent of `childAgentId`
// would create a cycle: walk up from the candidate parent's existing chain; if we
// reach the child, refuse (defensive — the real corpus is acyclic).
function wouldFormCycle(
  agentStates: Map<string, AgentBuildState>,
  sessionId: string,
  childAgentId: string,
  candidateParentAgentId: string,
): boolean {
  let cursor: string | null = candidateParentAgentId;
  const visited = new Set<string>();
  while (cursor !== null) {
    if (cursor === childAgentId) {
      return true;
    }
    if (visited.has(cursor)) {
      return true;
    }
    visited.add(cursor);
    const state: AgentBuildState | undefined = agentStates.get(nodeKey(sessionId, cursor));
    cursor = state === undefined ? null : state.parentAgentId;
  }
  return false;
}

function groupRowsBy(
  rows: readonly CostTreeInputRow[],
  selectKey: (row: CostTreeInputRow) => string | null,
): AttributionGroup[] {
  const accumulators = new Map<string, MutableTotals>();
  for (const row of rows) {
    const rawKey = selectKey(row);
    const key = rawKey ?? ABSENT_ATTRIBUTION_KEY;
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = newMutableTotals();
      accumulators.set(key, accumulator);
    }
    foldRow(accumulator, row);
  }
  return [...accumulators.keys()]
    .sort()
    .map((key) => ({ key, totals: freezeTotals(accumulators.get(key)!) }));
}

// ── Deliverable 3: the reconciliation assertion (the load-bearing guard) ─────
export interface ReconciliationViolation {
  readonly nodeKind: 'agent' | 'session' | 'project' | 'grand-total';
  readonly nodeId: string;
  readonly field: string;
  readonly expected: number;
  readonly actual: number;
  readonly delta: number;
}

// Every additive field of a subtree must equal own + Σ(child subtrees), exactly, in
// integers. Returns every violation found (empty = reconciles). This is the
// independent verifier — it recomputes rather than trusting the builder, so a
// hand-corrupted or mis-built tree is CAUGHT (proven by the sabotage test).
export function findReconciliationViolations(tree: CostTree): ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];

  const compareTotals = (
    nodeKind: ReconciliationViolation['nodeKind'],
    nodeId: string,
    expected: RollupTotals,
    actual: RollupTotals,
  ): void => {
    const fields: Array<[string, number, number]> = [
      ['pricedNanoDollars', expected.pricedNanoDollars, actual.pricedNanoDollars],
      ['unvalidatedNanoDollars', expected.unvalidatedNanoDollars, actual.unvalidatedNanoDollars],
      ['rowCount', expected.rowCount, actual.rowCount],
    ];
    for (const status of ['priced', 'unpriced', 'unpriceable', 'flagged'] as const) {
      fields.push([`statusCounts.${status}`, expected.statusCounts[status], actual.statusCounts[status]]);
      fields.push([`tokensByStatus.${status}`, expected.tokensByStatus[status], actual.tokensByStatus[status]]);
    }
    for (const [field, expectedValue, actualValue] of fields) {
      if (expectedValue !== actualValue) {
        violations.push({
          nodeKind,
          nodeId,
          field,
          expected: expectedValue,
          actual: actualValue,
          delta: actualValue - expectedValue,
        });
      }
    }
  };

  const sumChildren = (childSubtrees: readonly RollupTotals[], own: RollupTotals): RollupTotals => {
    const accumulator = newMutableTotals();
    addTotals(accumulator, own);
    for (const childSubtree of childSubtrees) {
      addTotals(accumulator, childSubtree);
    }
    return freezeTotals(accumulator);
  };

  const checkAgent = (agentNode: AgentNode): void => {
    for (const childNode of agentNode.children) {
      checkAgent(childNode);
    }
    const expected = sumChildren(
      agentNode.children.map((childNode) => childNode.subtree),
      agentNode.own,
    );
    compareTotals('agent', `${agentNode.sessionId}/${agentNode.agentId}`, expected, agentNode.subtree);
  };

  const grandExpected = newMutableTotals();
  for (const projectNode of tree.projects) {
    for (const sessionNode of projectNode.sessions) {
      for (const agentNode of sessionNode.agents) {
        checkAgent(agentNode);
      }
      const sessionExpected = sumChildren(
        sessionNode.agents.map((agentNode) => agentNode.subtree),
        sessionNode.own,
      );
      compareTotals('session', sessionNode.sessionId, sessionExpected, sessionNode.subtree);
    }
    const projectExpected = sumChildren(
      projectNode.sessions.map((sessionNode) => sessionNode.subtree),
      projectNode.own,
    );
    compareTotals('project', projectNode.projectKey, projectExpected, projectNode.subtree);
    addTotals(grandExpected, projectNode.subtree);
  }
  compareTotals('grand-total', '<grand-total>', freezeTotals(grandExpected), tree.grandTotal);

  return violations;
}

// Throws a rule-0.1 FINDING on the first reconciliation failure — STOP, do not
// silently adjust a total. Green on a well-built tree; the sabotage test proves it
// fires on a corrupted one.
export function assertTreeReconciles(tree: CostTree): void {
  const violations = findReconciliationViolations(tree);
  if (violations.length > 0) {
    const first = violations[0]!;
    throw new Error(
      `cost-tree reconciliation FAILED (rule 0.1 finding): ` +
        `${violations.length} violation(s); first at ${first.nodeKind} "${first.nodeId}" ` +
        `field ${first.field}: subtree=${first.actual} but own+Σchildren=${first.expected} ` +
        `(delta ${first.delta}). A total was NOT adjusted; report this node.`,
    );
  }
}
