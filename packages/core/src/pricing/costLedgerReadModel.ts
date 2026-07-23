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
  resolveProjectKey,
  OUTSIDE_ROOTS_PROJECT_KEY,
  UNKNOWN_SESSION_KEY,
  type AgentNode,
  type AttributionGroup,
  type CostTree,
  type CostTreeInputRow,
  type ExplicitAgentParentEdge,
  type ProjectNode,
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
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly agents: readonly AgentView[];
}

export interface ProjectView {
  readonly projectKey: string;
  // FALSE only for the single outside-VIMES_PROJECT_ROOTS bucket (rule 9).
  readonly insideProjectRoots: boolean;
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly sessions: readonly SessionView[];
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
    own: toRollupView(sessionNode.own),
    subtree: toRollupView(sessionNode.subtree),
    agents: sessionNode.agents.map(toAgentView),
  };
}

function toProjectView(projectNode: ProjectNode): ProjectView {
  return {
    projectKey: projectNode.projectKey,
    insideProjectRoots: projectNode.insideProjectRoots,
    own: toRollupView(projectNode.own),
    subtree: toRollupView(projectNode.subtree),
    sessions: projectNode.sessions.map(toSessionView),
  };
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

export interface ProjectSpendSeries {
  readonly projectKey: string;
  // Ascending by day (string sort of YYYY-MM-DD is chronological).
  readonly points: readonly SpendHistoryPoint[];
}

export interface SpendHistory {
  // The grand daily series — every project summed, ascending by day.
  readonly grand: readonly SpendHistoryPoint[];
  // Per-project daily series, ascending by projectKey; each series ascending by
  // day. A project's points sum to that project's priced subtree total.
  readonly byProject: readonly ProjectSpendSeries[];
}

// ── the servable body ────────────────────────────────────────────────────────
export interface CostLedgerReadModel {
  // Fixed: "VIMES-hosted work on this host". Never "your spend"/"your costs".
  readonly scopeLabel: string;
  // The price-table snapshot every figure priced against (rule 0.5), so the UI
  // can render "as of <date>".
  readonly priceTableDate: string;
  // Grand total over every row = Σ project subtrees.
  readonly grandTotal: RollupView;
  // The project list (ascending by projectKey), each drillable to sessions →
  // agents with per-status breakdowns at every node.
  readonly projects: readonly ProjectView[];
  readonly spendHistory: SpendHistory;
  // Secondary flat groupings (Step 3, deliverable 4) — spend by attributed skill
  // and by attributed agent, each with the ABSENT bucket kept, never dropped.
  readonly byAttributionSkill: readonly AttributionView[];
  readonly byAttributionAgent: readonly AttributionView[];
}

export interface BuildCostLedgerOptions {
  // The price table to price against. Defaults to the pinned slice-5b snapshot.
  readonly priceTable?: PriceTable;
  // Project-parent roots (VIMES_PROJECT_ROOTS) for tree classification — passed
  // straight through to buildCostTree so project keys match rule 7.
  readonly projectRoots?: readonly string[];
  // Externally-harvested agent→agent parent edges (parent-edge fix, unit 1), passed
  // straight through to buildCostTree so the tree can nest agents whose usage rows
  // carry no toolUseResult edge. Absent (default) → row-only behaviour, unchanged.
  readonly parentEdges?: readonly ExplicitAgentParentEdge[];
  // A test seam to inject a non-reconciling tree so the builder's reconciliation
  // guard can be exercised — absent in prod (buildCostTree reconciles by
  // construction, so no INPUT alone can make the builder's tree fail to reconcile).
  readonly buildTree?: (
    rows: readonly CostTreeInputRow[],
    opts: { projectRoots: readonly string[]; parentEdges?: readonly ExplicitAgentParentEdge[] },
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
// sentinel), so a row's history bucket lands under the same project the tree
// consolidated its session into.
function sessionKeyOf(sessionId: string | null): string {
  return sessionId ?? UNKNOWN_SESSION_KEY;
}

// Read sessionId → projectKey off the ALREADY-BUILT tree, so per-project history
// reconciles with the tree's project totals (a session belongs to one project —
// the tree already decided which; this does not re-decide it).
function sessionToProjectKeyFromTree(tree: CostTree): Map<string, string> {
  const sessionToProjectKey = new Map<string, string>();
  for (const projectNode of tree.projects) {
    for (const sessionNode of projectNode.sessions) {
      sessionToProjectKey.set(sessionNode.sessionId, projectNode.projectKey);
    }
  }
  return sessionToProjectKey;
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
  const tree = buildTreeFn(treeRows, { projectRoots, parentEdges });
  // The load-bearing guard — a non-reconciling tree is a lie; let it throw.
  assertTreeReconciles(tree);

  const spendHistory = buildSpendHistory(inputRows, pricedByRowIndex, tree, projectRoots);

  return {
    scopeLabel: COST_LEDGER_SCOPE_LABEL,
    priceTableDate: priceTable.effectiveDate,
    grandTotal: toRollupView(tree.grandTotal),
    projects: tree.projects.map(toProjectView),
    spendHistory,
    byAttributionSkill: tree.byAttributionSkill.map(toAttributionView),
    byAttributionAgent: tree.byAttributionAgent.map(toAttributionView),
  };
}

// Day-bucket the priced dollars into a grand series and a per-project series.
// Only priced rows carry dollars; the rest add nothing here (they are surfaced
// in the tree's status counts, never as a $0 point).
function buildSpendHistory(
  inputRows: readonly CostLedgerInputRow[],
  pricedByRowIndex: ReadonlyArray<{ status: PriceStatus; amountNanoDollars: number | null }>,
  tree: CostTree,
  projectRoots: readonly string[],
): SpendHistory {
  const sessionToProjectKey = sessionToProjectKeyFromTree(tree);
  const grandByDay = new Map<string, number>();
  // projectKey → (day → nanoDollars)
  const projectByDay = new Map<string, Map<string, number>>();

  const addNano = (target: Map<string, number>, day: string, nanoDollars: number): void => {
    target.set(day, (target.get(day) ?? 0) + nanoDollars);
  };

  inputRows.forEach((row, rowIndex) => {
    const priced = pricedByRowIndex[rowIndex]!;
    if (priced.status !== 'priced' || priced.amountNanoDollars === null) {
      return;
    }
    const day = dayBucketOf(row.timestamp);
    const projectKey =
      sessionToProjectKey.get(sessionKeyOf(row.sessionId)) ??
      projectKeyFallback(row, projectRoots);

    addNano(grandByDay, day, priced.amountNanoDollars);
    let daysForProject = projectByDay.get(projectKey);
    if (daysForProject === undefined) {
      daysForProject = new Map<string, number>();
      projectByDay.set(projectKey, daysForProject);
    }
    addNano(daysForProject, day, priced.amountNanoDollars);
  });

  return {
    grand: toSortedPoints(grandByDay),
    byProject: [...projectByDay.keys()].sort().map((projectKey) => ({
      projectKey,
      points: toSortedPoints(projectByDay.get(projectKey)!),
    })),
  };
}

// Defensive fallback: a row whose session is somehow not in the tree (never seen
// in the corpus — every row has a session and every session is in the tree).
// Classify it the same way the tree would rather than drop its dollars.
function projectKeyFallback(row: CostLedgerInputRow, projectRoots: readonly string[]): string {
  if (row.sessionId === null) {
    return OUTSIDE_ROOTS_PROJECT_KEY;
  }
  return resolveProjectKey(
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
  ).projectKey;
}

function toSortedPoints(byDay: Map<string, number>): SpendHistoryPoint[] {
  return [...byDay.keys()].sort().map((day) => ({
    day,
    priced: toMoney(byDay.get(day)!),
  }));
}
