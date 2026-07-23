// ─── slice 5b step 4a — the cost-ledger READ MODEL (PURE, packages/core) ──────
//
// Assemble the servable body the cost UI (step 4b) consumes: the priced
// project → session → agent tree (Step 3), a day-bucketed spend history, and a
// grand total — every dollar figure carrying BOTH the exact integer nano-dollars
// AND its formatted USD, so the screen renders money without re-deriving it.
//
// Rule 0.3: pure. No clock, no randomness, no I/O. Day bucketing is a STRING
// SLICE of the row's own `timestamp` (its `YYYY-MM-DD` prefix) — never a `Date`
// object, never `new Date`, so the nondeterminism gate stays clean and the same
// rows always bucket the same way.
//
// This module NEVER re-prices and NEVER re-builds the tree: it consumes
// `priceUsageRow` (Step 2) and `buildCostTree` / `assertTreeReconciles` (Step 3).
//
// Pillar 4, carried to the screen: a non-priced row (unpriced / unpriceable /
// flagged) contributes NOTHING to the dollar total but is surfaced in every
// node's status counts and token sums — an un-known is never a silent $0.
//
// SCOPE, not a bill. The body carries a fixed `scopeLabel` — "VIMES-hosted work
// on this host", NEVER "your spend" / "your costs" — so the UI cannot forget
// that this measures work VIMES hosted, not a personal invoice. There is NO
// percent-of-window anywhere (cut by C1): this reports what was spent, never a
// fraction of a budget.

import {
  formatUsd,
  SLICE_5B_PRICE_TABLE,
  type PriceTable,
} from './priceTable.js';
import {
  priceUsageRow,
  type PriceStatus,
  type PriceableUsageRow,
} from './priceUsageRow.js';
import {
  assertTreeReconciles,
  buildCostTree,
  resolveDirectoryKey,
  OUTSIDE_ROOTS_PROJECT_KEY,
  UNKNOWN_SESSION_KEY,
  type AgentNode,
  type AttributionGroup,
  type CostTree,
  type CostTreeInputRow,
  type DirectoryNode,
  type ExplicitAgentParentEdge,
  type RollupTotals,
  type SessionNode,
} from './costTree.js';

// Canonical export is costTree.ts; re-exported here for callers that build the read
// model and supply edges in one import.
export type { ExplicitAgentParentEdge } from './costTree.js';

// The fixed scope label. This measures VIMES-hosted work, not a personal bill —
// the string is a constant in the body so the UI can never substitute
// "your spend" (a build-order requirement).
export const COST_LEDGER_SCOPE_LABEL = 'VIMES-hosted work on this host';

// The bucket for a row whose timestamp is absent/too short to yield a day prefix.
// Never seen in the live corpus (timestamps are ISO); handled rather than
// assumed away, and printable — never a control byte.
export const UNKNOWN_DAY_KEY = '<unknown-day>';

// ── the input row ────────────────────────────────────────────────────────────
// Field-for-field the pricing + attribution + history slice of the daemon's
// `CostUsageRow` (costCorpus.ts), re-declared here so core does NOT import from
// the daemon (rule 0.3). The builder prices each row itself (Step 2) and builds
// the tree (Step 3); the caller supplies raw rows.
export interface CostLedgerInputRow {
  // ── pricing inputs (PriceableUsageRow) ──
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  readonly speed: string | null;
  readonly serviceTier: string | null;
  readonly inferenceGeo: string | null;

  // ── attribution / tree inputs ──
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly toolUseResultAgentId: string | null;
  readonly projectSlug: string;
  readonly projectCwd: string | null;
  readonly insideProjectRoots: boolean;
  readonly attributionAgent: string | null;
  readonly attributionSkill: string | null;
  readonly sourceKind: string;

  // ── history input ──
  // The row's ISO timestamp. Its YYYY-MM-DD prefix is the history bucket (pure
  // string slice — no clock, no Date).
  readonly timestamp: string;
}

// ── money: every figure carries BOTH the exact nano integer and its USD ──────
export interface MoneyAmount {
  readonly nanoDollars: number;
  readonly usd: string;
}

function toMoney(nanoDollars: number): MoneyAmount {
  return { nanoDollars, usd: formatUsd(nanoDollars) };
}

export type PriceStatusCountsView = { readonly [Status in PriceStatus]: number };

// A node's rollup, with money formatted alongside the nano integers and the
// un-knowns (status + token counts) carried so "un-known ≠ $0" survives to the UI.
export interface RollupView {
  // The PRICED sum only — the honest dollar total. Non-priced rows are NOT here.
  readonly priced: MoneyAmount;
  // Of `priced`, the portion from priced-by-analogy (unvalidated) rows, so the UI
  // can render "$ (unvalidated)" honestly.
  readonly unvalidated: MoneyAmount;
  // Row counts per status — how many priced / unpriced / unpriceable / flagged.
  readonly statusCounts: PriceStatusCountsView;
  // Token sums per status — the "N tokens unpriced" number that keeps an un-known
  // from vanishing behind a $0.
  readonly tokensByStatus: PriceStatusCountsView;
  readonly rowCount: number;
}

function toRollupView(totals: RollupTotals): RollupView {
  return {
    priced: toMoney(totals.pricedNanoDollars),
    unvalidated: toMoney(totals.unvalidatedNanoDollars),
    statusCounts: { ...totals.statusCounts },
    tokensByStatus: { ...totals.tokensByStatus },
    rowCount: totals.rowCount,
  };
}

// ── the node views (mirror the tree, with money formatted) ───────────────────
export interface AgentView {
  readonly sessionId: string;
  readonly agentId: string;
  readonly parentAgentId: string | null;
  // TRUE = parent recovered from a toolUseResult edge; FALSE = attached to the
  // session root (the ~54% with no recoverable parent). Lets the UI show
  // attribution confidence honestly.
  readonly parentResolved: boolean;
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly children: readonly AgentView[];
}

export interface SessionView {
  readonly sessionId: string;
  // The directory node this session hangs off.
  readonly directoryPath: string;
  // The session's OWN launch cwd (kept even for outside-roots sessions), or null.
  readonly cwd: string | null;
  // The session's title as the caller resolved it — `name ?? derivedTitle` from
  // the sessions projection — else null. Null here means "no human name AND no
  // derived title", which is exactly the condition a surface wants to mark.
  readonly title: string | null;
  // The earliest `timestamp` across this session's rows, or null. Carried so a
  // surface can re-derive the same label without a second data source.
  readonly earliestRowTimestamp: string | null;
  // The identity ladder — `title` → `Jul 19 23:25 · a1b2c3d4`. NEVER blank.
  //
  // ⚠ There is deliberately NO cwd-basename rung: under D37 the parent DIRECTORY
  // node already renders that exact string (sessionIdentity.ts).
  readonly label: string;
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly agents: readonly AgentView[];
}

// A node of the D37 directory rollup. Plain and serialisable; `children` nests.
export interface DirectoryView {
  readonly directoryPath: string;
  // The last path segment (or the sentinel key) — never blank.
  readonly label: string;
  // Depth below the top of its own chain; a top-level node is 0.
  readonly depth: number;
  // FALSE only for the single outside-VIMES_PROJECT_ROOTS bucket (rule 9).
  readonly insideProjectRoots: boolean;
  // The spend of the sessions launched in THIS directory itself.
  readonly own: RollupView;
  // own + Σ children.subtree.
  readonly subtree: RollupView;
  readonly sessions: readonly SessionView[];
  readonly children: readonly DirectoryView[];
}

export interface AttributionView {
  readonly key: string;
  readonly totals: RollupView;
}

function toAgentView(agentNode: AgentNode): AgentView {
  return {
    sessionId: agentNode.sessionId,
    agentId: agentNode.agentId,
    parentAgentId: agentNode.parentAgentId,
    parentResolved: agentNode.parentResolved,
    own: toRollupView(agentNode.own),
    subtree: toRollupView(agentNode.subtree),
    children: agentNode.children.map(toAgentView),
  };
}

function toSessionView(sessionNode: SessionNode): SessionView {
  return {
    sessionId: sessionNode.sessionId,
    directoryPath: sessionNode.directoryPath,
    cwd: sessionNode.cwd,
    title: sessionNode.title,
    earliestRowTimestamp: sessionNode.earliestRowTimestamp,
    label: sessionNode.label,
    own: toRollupView(sessionNode.own),
    subtree: toRollupView(sessionNode.subtree),
    agents: sessionNode.agents.map(toAgentView),
  };
}

// Depth is bounded only by how deep a cwd is, so this mirrors the tree with an
// explicit stack instead of recursion (I8 — a pathological path must not blow it).
function toDirectoryViews(directoryNodes: readonly DirectoryNode[]): DirectoryView[] {
  const viewByPath = new Map<string, DirectoryView>();
  const pendingStack: DirectoryNode[] = [...directoryNodes];
  while (pendingStack.length > 0) {
    const directoryNode = pendingStack[pendingStack.length - 1]!;
    if (viewByPath.has(directoryNode.directoryPath)) {
      pendingStack.pop();
      continue;
    }
    const unconvertedChildren = directoryNode.children.filter(
      (childNode) => !viewByPath.has(childNode.directoryPath),
    );
    if (unconvertedChildren.length > 0) {
      pendingStack.push(...unconvertedChildren);
      continue;
    }
    pendingStack.pop();
    viewByPath.set(directoryNode.directoryPath, {
      directoryPath: directoryNode.directoryPath,
      label: directoryNode.label,
      depth: directoryNode.depth,
      insideProjectRoots: directoryNode.insideProjectRoots,
      own: toRollupView(directoryNode.own),
      subtree: toRollupView(directoryNode.subtree),
      sessions: directoryNode.sessions.map(toSessionView),
      children: directoryNode.children.map((childNode) => viewByPath.get(childNode.directoryPath)!),
    });
  }
  return directoryNodes.map((directoryNode) => viewByPath.get(directoryNode.directoryPath)!);
}

function toAttributionView(group: AttributionGroup): AttributionView {
  return { key: group.key, totals: toRollupView(group.totals) };
}

// ── the spend history ────────────────────────────────────────────────────────
// One point per day. The money is the PRICED sum for that day — a spend-over-time
// view is a money-over-time view. Non-priced rows carry no dollars and so add
// nothing here (they are still counted in the tree's status counts).
export interface SpendHistoryPoint {
  // The YYYY-MM-DD day bucket (or the unknown-day sentinel).
  readonly day: string;
  readonly priced: MoneyAmount;
}

export interface DirectorySpendSeries {
  readonly directoryPath: string;
  // Ascending by day (string sort of YYYY-MM-DD is chronological).
  readonly points: readonly SpendHistoryPoint[];
}

export interface SpendHistory {
  // The grand daily series — every row summed, ascending by day.
  readonly grand: readonly SpendHistoryPoint[];
  // D37: one series per DIRECTORY NODE of the tree — not per leaf directory —
  // ascending by directoryPath, each series ascending by day.
  //
  // A node's series is its SUBTREE, so its points sum to exactly the number the
  // tree shows beside that node. That is what lets the history selector offer the
  // same nodes the tree does: selecting `…/projects/infrastructure` charts the
  // rollup of everything beneath it, and selecting `…/infrastructure/vimes`
  // charts just that repo. A leaf-only keying would have left every interior node
  // with no series, and `seriesForSelection` (correctly) never falls back to the
  // grand series — the selector would have silently charted nothing.
  readonly byDirectory: readonly DirectorySpendSeries[];
}

// ── the servable body ────────────────────────────────────────────────────────
export interface CostLedgerReadModel {
  // Fixed: "VIMES-hosted work on this host". Never "your spend"/"your costs".
  readonly scopeLabel: string;
  // The price-table snapshot every figure priced against (rule 0.5), so the UI
  // can render "as of <date>".
  readonly priceTableDate: string;
  // Grand total over every row = Σ top-level directory subtrees.
  readonly grandTotal: RollupView;
  // D37: the DIRECTORY ROLLUP — top-level nodes ascending by directoryPath, each
  // nesting into child directories and drillable to sessions → agents with
  // per-status breakdowns at every node. No project boundary is inferred
  // anywhere: every node is a directory a session ran in, or an ancestor of one.
  readonly directories: readonly DirectoryView[];
  readonly spendHistory: SpendHistory;
  // Secondary flat groupings (Step 3, deliverable 4) — spend by attributed skill
  // and by attributed agent, each with the ABSENT bucket kept, never dropped.
  readonly byAttributionSkill: readonly AttributionView[];
  readonly byAttributionAgent: readonly AttributionView[];
}

export interface BuildCostLedgerOptions {
  // The price table to price against. Defaults to the pinned slice-5b snapshot.
  readonly priceTable?: PriceTable;
  // VIMES_PROJECT_ROOTS — passed straight through to buildCostTree so directory
  // classification matches binding data rule 9 ("Slugs are not projects":
  // classification runs against cwd + insideProjectRoots, never the slug, and an
  // outside-roots bucket must exist). Rule 7 is the unrelated "unknown model →
  // UNPRICED, never $0".
  readonly projectRoots?: readonly string[];
  // Externally-harvested agent→agent parent edges (parent-edge fix, unit 1), passed
  // straight through to buildCostTree so the tree can nest agents whose usage rows
  // carry no toolUseResult edge. Absent (default) → row-only behaviour, unchanged.
  readonly parentEdges?: readonly ExplicitAgentParentEdge[];
  // Session titles (`name ?? derivedTitle`) keyed by the SAME session id the cost
  // rows carry — the identity ladder's top rung — passed straight through to
  // buildCostTree. Injected data: core never reaches for the sessions projection.
  readonly sessionTitles?: Readonly<Record<string, string | null>>;
  // A test seam to inject a non-reconciling tree so the builder's reconciliation
  // guard can be exercised — absent in prod (buildCostTree reconciles by
  // construction, so no INPUT alone can make the builder's tree fail to reconcile).
  readonly buildTree?: (
    rows: readonly CostTreeInputRow[],
    opts: {
      projectRoots: readonly string[];
      parentEdges?: readonly ExplicitAgentParentEdge[];
      sessionTitles?: Readonly<Record<string, string | null>>;
    },
  ) => CostTree;
}

function pricingInputOf(row: CostLedgerInputRow): PriceableUsageRow {
  return {
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheCreation5mInputTokens: row.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: row.cacheCreation1hInputTokens,
    speed: row.speed,
    serviceTier: row.serviceTier,
    inferenceGeo: row.inferenceGeo,
  };
}

// The YYYY-MM-DD bucket for a row — a pure prefix slice of its ISO timestamp. No
// clock, no Date: the same timestamp always yields the same day.
function dayBucketOf(timestamp: string): string {
  if (timestamp.length >= 10) {
    return timestamp.slice(0, 10);
  }
  return timestamp.length > 0 ? timestamp : UNKNOWN_DAY_KEY;
}

// The session key exactly as the tree keys it (null → the unknown-session
// sentinel), so a row's history bucket lands under the same directory the tree
// consolidated its session into.
function sessionKeyOf(sessionId: string | null): string {
  return sessionId ?? UNKNOWN_SESSION_KEY;
}

// Flatten the directory forest into pre-order (parents before children), with an
// explicit stack — the same no-recursion posture as the rest of this file.
function flattenDirectoryNodes(tree: CostTree): DirectoryNode[] {
  const flattened: DirectoryNode[] = [];
  const pendingStack: DirectoryNode[] = [...tree.directories].reverse();
  while (pendingStack.length > 0) {
    const directoryNode = pendingStack.pop()!;
    flattened.push(directoryNode);
    for (let childIndex = directoryNode.children.length - 1; childIndex >= 0; childIndex -= 1) {
      pendingStack.push(directoryNode.children[childIndex]!);
    }
  }
  return flattened;
}

// Read sessionId → the directory node it hangs off, off the ALREADY-BUILT tree,
// so per-directory history reconciles with the tree's totals (a session belongs
// to one directory — the tree already decided which; this does not re-decide it).
function sessionToDirectoryPathFromTree(directoryNodes: readonly DirectoryNode[]): Map<string, string> {
  const sessionToDirectoryPath = new Map<string, string>();
  for (const directoryNode of directoryNodes) {
    for (const sessionNode of directoryNode.sessions) {
      sessionToDirectoryPath.set(sessionNode.sessionId, directoryNode.directoryPath);
    }
  }
  return sessionToDirectoryPath;
}

/**
 * Build the servable cost-ledger read model. Pure: everything (the price table,
 * the project roots) is an argument or a pinned constant.
 *
 * With no rows this returns the envelope with an empty tree and empty history —
 * never a throw. "Nothing has been ingested yet" is a real, servable answer.
 *
 * Reconciliation: `assertTreeReconciles` runs on the built tree; if it throws
 * (a rule-0.1 finding), the throw propagates — the daemon turns it into a 500,
 * so a non-reconciling (wrong) number is NEVER served.
 */
export function buildCostLedgerReadModel(
  inputRows: readonly CostLedgerInputRow[],
  options: BuildCostLedgerOptions = {},
): CostLedgerReadModel {
  const priceTable = options.priceTable ?? SLICE_5B_PRICE_TABLE;
  const projectRoots = options.projectRoots ?? [];
  const parentEdges = options.parentEdges;

  // Price each row once (Step 2) and carry the result into the tree row (Step 3
  // consumes it, never re-prices). The priced result is retained per input row
  // (same order) so the history can reuse it without pricing twice.
  const pricedByRowIndex = inputRows.map((row) => priceUsageRow(pricingInputOf(row), priceTable));

  const treeRows: CostTreeInputRow[] = inputRows.map((row, rowIndex) => ({
    sessionId: row.sessionId,
    agentId: row.agentId,
    toolUseResultAgentId: row.toolUseResultAgentId,
    projectSlug: row.projectSlug,
    projectCwd: row.projectCwd,
    insideProjectRoots: row.insideProjectRoots,
    attributionAgent: row.attributionAgent,
    attributionSkill: row.attributionSkill,
    sourceKind: row.sourceKind,
    // Carried into the tree for ONE purpose: the earliest row per session, which
    // is the time half of the identity ladder's fallback rung. No new field —
    // the history pass below already reads the same `timestamp`.
    timestamp: row.timestamp,
    tokens: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreation5mInputTokens: row.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: row.cacheCreation1hInputTokens,
    },
    priced: pricedByRowIndex[rowIndex]!,
  }));

  const buildTreeFn = options.buildTree ?? buildCostTree;
  const tree = buildTreeFn(treeRows, { projectRoots, parentEdges, sessionTitles: options.sessionTitles });
  // The load-bearing guard — a non-reconciling tree is a lie; let it throw.
  assertTreeReconciles(tree);

  const spendHistory = buildSpendHistory(inputRows, pricedByRowIndex, tree, projectRoots);

  return {
    scopeLabel: COST_LEDGER_SCOPE_LABEL,
    priceTableDate: priceTable.effectiveDate,
    grandTotal: toRollupView(tree.grandTotal),
    directories: toDirectoryViews(tree.directories),
    spendHistory,
    byAttributionSkill: tree.byAttributionSkill.map(toAttributionView),
    byAttributionAgent: tree.byAttributionAgent.map(toAttributionView),
  };
}

// Day-bucket the priced dollars into a grand series and one series per DIRECTORY
// NODE. Only priced rows carry dollars; the rest add nothing here (they are
// surfaced in the tree's status counts, never as a $0 point).
//
// Two stages, deliberately: rows fold into the day-map of the EXACT directory
// their session hangs off, then each node's series is that map plus its
// children's — the same own + Σ(children) shape the totals use. Summing a node's
// series independently from the rows would let the chart and the tree disagree.
function buildSpendHistory(
  inputRows: readonly CostLedgerInputRow[],
  pricedByRowIndex: ReadonlyArray<{ status: PriceStatus; amountNanoDollars: number | null }>,
  tree: CostTree,
  projectRoots: readonly string[],
): SpendHistory {
  const directoryNodes = flattenDirectoryNodes(tree);
  const sessionToDirectoryPath = sessionToDirectoryPathFromTree(directoryNodes);
  const grandByDay = new Map<string, number>();
  // directoryPath → (day → nanoDollars), for the sessions attached AT that node.
  const ownByDayByDirectory = new Map<string, Map<string, number>>();

  const addNano = (target: Map<string, number>, day: string, nanoDollars: number): void => {
    target.set(day, (target.get(day) ?? 0) + nanoDollars);
  };
  const daysFor = (byDirectory: Map<string, Map<string, number>>, directoryPath: string): Map<string, number> => {
    let days = byDirectory.get(directoryPath);
    if (days === undefined) {
      days = new Map<string, number>();
      byDirectory.set(directoryPath, days);
    }
    return days;
  };

  inputRows.forEach((row, rowIndex) => {
    const priced = pricedByRowIndex[rowIndex]!;
    if (priced.status !== 'priced' || priced.amountNanoDollars === null) {
      return;
    }
    const day = dayBucketOf(row.timestamp);
    const directoryPath =
      sessionToDirectoryPath.get(sessionKeyOf(row.sessionId)) ??
      directoryPathFallback(row, projectRoots);

    addNano(grandByDay, day, priced.amountNanoDollars);
    addNano(daysFor(ownByDayByDirectory, directoryPath), day, priced.amountNanoDollars);
  });

  // Roll each node's own day-map up through its children (deepest first, so a
  // parent always reads already-complete child maps).
  const subtreeByDayByDirectory = new Map<string, Map<string, number>>();
  for (let nodeIndex = directoryNodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
    const directoryNode = directoryNodes[nodeIndex]!;
    const rolledUp = new Map<string, number>(ownByDayByDirectory.get(directoryNode.directoryPath) ?? []);
    for (const childNode of directoryNode.children) {
      const childDays = subtreeByDayByDirectory.get(childNode.directoryPath);
      if (childDays !== undefined) {
        for (const [day, nanoDollars] of childDays) {
          addNano(rolledUp, day, nanoDollars);
        }
      }
    }
    subtreeByDayByDirectory.set(directoryNode.directoryPath, rolledUp);
  }
  // A fallback-classified row landed on a path with no node in the tree (the
  // defensive branch below). Keep its series rather than drop its dollars.
  for (const [directoryPath, ownDays] of ownByDayByDirectory) {
    if (!subtreeByDayByDirectory.has(directoryPath)) {
      subtreeByDayByDirectory.set(directoryPath, ownDays);
    }
  }

  return {
    grand: toSortedPoints(grandByDay),
    byDirectory: [...subtreeByDayByDirectory.keys()]
      .sort()
      .filter((directoryPath) => subtreeByDayByDirectory.get(directoryPath)!.size > 0)
      .map((directoryPath) => ({
        directoryPath,
        points: toSortedPoints(subtreeByDayByDirectory.get(directoryPath)!),
      })),
  };
}

// Defensive fallback: a row whose session is somehow not in the tree (never seen
// in the corpus — every row has a session and every session is in the tree).
// Classify it the same way the tree would rather than drop its dollars.
function directoryPathFallback(row: CostLedgerInputRow, projectRoots: readonly string[]): string {
  if (row.sessionId === null) {
    return OUTSIDE_ROOTS_PROJECT_KEY;
  }
  return resolveDirectoryKey(
    {
      sessionId: row.sessionId,
      agentId: row.agentId,
      toolUseResultAgentId: row.toolUseResultAgentId,
      projectSlug: row.projectSlug,
      projectCwd: row.projectCwd,
      insideProjectRoots: row.insideProjectRoots,
      attributionAgent: row.attributionAgent,
      attributionSkill: row.attributionSkill,
      sourceKind: row.sourceKind,
      priced: { status: 'unpriced', amountNanoDollars: null, priceTableDate: null, modelMatched: null, validated: null, flagReason: null, categories: null },
    },
    projectRoots,
  ).directoryPath;
}

function toSortedPoints(byDay: Map<string, number>): SpendHistoryPoint[] {
  return [...byDay.keys()].sort().map((day) => ({
    day,
    priced: toMoney(byDay.get(day)!),
  }));
}
