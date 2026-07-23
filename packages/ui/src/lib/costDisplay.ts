// Pure derivation for the cost-ledger view (slice 5b step 4b) — turns the
// cost-ledger body (GET /api/cost/ledger) into display-ready shapes. No Vue, no
// DOM, no I/O: every branch is unit-tested without a browser (same split as
// lib/meterDisplay.ts and lib/cacheBadge.ts).
//
// THE INTEGRITY RULE (pillar 4 — the whole reason this slice exists): a money
// figure is NEVER re-computed here. Every amount arrives as { nanoDollars, usd }
// and nothing in this module ever sums, converts, or apportions a dollar figure
// — `formatMoney` (D38) is the one deliberate exception, and it is presentation,
// not computation: it REFORMATS the exact `nanoDollars` integer to 2 dp for
// display, the same number, never a different one (docs/decisions.md D38 records
// why this doesn't breach the rule). An un-known (unpriced / unpriceable /
// flagged row) contributes NOTHING to a dollar total and is surfaced beside it as
// a token count — never rendered, and never allowed to be rendered, as $0.
//
// SCOPE, not a bill. The body carries a fixed `scopeLabel` ("VIMES-hosted work
// on this host"); this module passes it through verbatim and never rephrases it
// as "your spend"/"your bill". There is NO percent-of-window anywhere (cut by
// C1): this reports what was spent, never a fraction of a budget.
//
// @vimes/core is deliberately NOT a dependency of packages/ui (see the header of
// lib/types.ts), so the wire shapes below mirror
// packages/core/src/pricing/costLedgerReadModel.ts narrowly, exactly as
// meterDisplay.ts mirrors the derived-usage shapes. Unknown keys are tolerated.

// ── Mirrored wire shapes ────────────────────────────────────────────────────

// The four pricing outcomes (mirrors packages/core PriceStatus). 'priced' is the
// only one that carries dollars; the other three are the un-knowns.
export type PriceStatus = 'priced' | 'unpriced' | 'unpriceable' | 'flagged';

// The three un-known statuses, in the order they are surfaced beside a total.
export const UNKNOWN_STATUSES: readonly PriceStatus[] = ['unpriced', 'unpriceable', 'flagged'];

// Every figure carries BOTH the exact integer nano-dollars AND its formatted USD.
export interface MoneyAmount {
  readonly nanoDollars: number;
  readonly usd: string;
}

export type PriceStatusCountsView = { readonly [Status in PriceStatus]: number };

export interface RollupView {
  // The PRICED sum only — the honest dollar total. Un-knowns are NOT in here.
  readonly priced: MoneyAmount;
  // Of `priced`, the portion priced by analogy (unvalidated), so the UI can
  // render "(incl. $X unvalidated)" honestly.
  readonly unvalidated: MoneyAmount;
  // Row counts per status.
  readonly statusCounts: PriceStatusCountsView;
  // Token sums per status — the "N tokens unpriced" number that keeps an un-known
  // from vanishing behind a $0.
  readonly tokensByStatus: PriceStatusCountsView;
  readonly rowCount: number;
}

export interface AgentView {
  readonly sessionId: string;
  readonly agentId: string;
  readonly parentAgentId: string | null;
  // TRUE = parent recovered from a toolUseResult edge; FALSE = attached to the
  // session root (no recoverable parent). Rendered as an honest confidence marker.
  readonly parentResolved: boolean;
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly children: readonly AgentView[];
}

export interface SessionView {
  readonly sessionId: string;
  // The directory node this session hangs off.
  readonly directoryPath: string;
  // The session's own launch cwd (kept even for outside-roots sessions), or null.
  readonly cwd: string | null;
  // The human-given name, when the daemon's join found one.
  readonly name: string | null;
  // D37's identity ladder, already resolved by core (`name` → cwd basename →
  // short id) and NEVER blank. The view renders this; it does not re-derive it.
  readonly label: string;
  readonly own: RollupView;
  readonly subtree: RollupView;
  readonly agents: readonly AgentView[];
}

// A node of the D37 directory rollup: a real directory some session ran in, or an
// ancestor of one. No project boundary is inferred anywhere — see decisions.md D37.
export interface DirectoryView {
  readonly directoryPath: string;
  // The last path segment (or a sentinel bucket key) — never blank.
  readonly label: string;
  // Depth below the top of its own chain; a top-level node is 0.
  readonly depth: number;
  // FALSE only for the single outside-VIMES_PROJECT_ROOTS bucket (rule 9).
  readonly insideProjectRoots: boolean;
  // What was spent by sessions launched in THIS directory itself.
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

export interface SpendHistoryPoint {
  readonly day: string;
  readonly priced: MoneyAmount;
}

export interface DirectorySpendSeries {
  readonly directoryPath: string;
  readonly points: readonly SpendHistoryPoint[];
}

export interface SpendHistory {
  readonly grand: readonly SpendHistoryPoint[];
  // One series per DIRECTORY NODE (each node's subtree), so the selector can
  // offer the same nodes the tree shows.
  readonly byDirectory: readonly DirectorySpendSeries[];
}

export interface CostLedgerReadModel {
  readonly scopeLabel: string;
  readonly priceTableDate: string;
  readonly grandTotal: RollupView;
  readonly directories: readonly DirectoryView[];
  readonly spendHistory: SpendHistory;
  readonly byAttributionSkill: readonly AttributionView[];
  readonly byAttributionAgent: readonly AttributionView[];
}

// The whole GET /api/cost/ledger body (mirrors daemon costLedgerApi.ts).
export interface CostLedgerBody {
  // FALSE = cost ingestion is disabled — there is no store and no ledger. This is
  // distinct from "enabled but nothing ingested yet" (ingestionEnabled true,
  // ledger present, projects empty), which is a real observed answer.
  readonly ingestionEnabled: boolean;
  readonly ledger: CostLedgerReadModel | null;
}

// ── Un-knowns beside a total (pillar 4) ─────────────────────────────────────

// A human label for each un-known status, used in the "+ N tokens unpriced" note.
const UNKNOWN_STATUS_LABEL: Readonly<Record<PriceStatus, string>> = {
  priced: 'priced',
  unpriced: 'unpriced',
  unpriceable: 'unpriceable',
  flagged: 'flagged',
};

export interface UnknownTokenBadge {
  readonly status: PriceStatus;
  readonly label: string;
  readonly tokens: number;
  // The token count rendered compactly (e.g. "12.3k") — never money.
  readonly tokensLabel: string;
}

/**
 * The un-known token badges for a node — one per un-known status (unpriced /
 * unpriceable / flagged) that has a non-zero token sum. Priced tokens are never
 * a badge (they are already the dollar total). An empty array means the node is
 * fully priced: nothing hidden behind its dollar figure.
 *
 * This is the pillar-4 surface: it is what keeps an un-known from being rendered
 * as $0. The view shows these token counts, never a fabricated zero-dollar row.
 */
export function unknownTokenBadges(rollup: RollupView | null | undefined): UnknownTokenBadge[] {
  if (rollup === null || rollup === undefined) {
    return [];
  }
  const tokensByStatus = rollup.tokensByStatus ?? emptyCounts();
  const badges: UnknownTokenBadge[] = [];
  for (const status of UNKNOWN_STATUSES) {
    const tokens = finiteNonNegative(tokensByStatus[status]);
    if (tokens > 0) {
      badges.push({
        status,
        label: UNKNOWN_STATUS_LABEL[status],
        tokens,
        tokensLabel: formatTokenCount(tokens),
      });
    }
  }
  return badges;
}

/** True when the node has any un-known tokens at all — the view flags it. */
export function hasUnknownTokens(rollup: RollupView | null | undefined): boolean {
  return unknownTokenBadges(rollup).length > 0;
}

/**
 * The "(incl. $X unvalidated)" note for a rollup, or null when nothing was priced
 * by analogy. Priced-by-analogy money is real and counted — it is simply less
 * certain, so the view says so beside the total rather than hiding it.
 *
 * D38: the note renders at DISPLAY precision (formatMoney), not the 6-dp `usd`
 * string the wire carries — every price site in this view speaks the same
 * precision, or the ledger shows two different truths for the same money.
 */
export function unvalidatedNote(rollup: RollupView | null | undefined): string | null {
  if (rollup === null || rollup === undefined) {
    return null;
  }
  const unvalidated = rollup.unvalidated;
  if (unvalidated === undefined || finiteNonNegative(unvalidated.nanoDollars) <= 0) {
    return null;
  }
  return `incl. ${formatMoney(unvalidated.nanoDollars)} unvalidated`;
}

// ── D38: money at DISPLAY precision (2 dp) ──────────────────────────────────
// `formatUsd` (packages/core/src/pricing/priceTable.ts) stays at 6 dp forever —
// micro-dollars are the Money boundary the figure spike C2 reconciles against
// OTel's USD, and rounding at the source would trade that validation for a
// formatting preference (docs/decisions.md D38). Two decimal places is a VIEW
// concern, so it lives here, downstream of the boundary, touching nothing core
// computed.
//
// 1 cent = 1e7 nanoDollars (NANO_DOLLARS_PER_DOLLAR / 100 in priceTable.ts).
// Restated rather than imported: @vimes/core is deliberately NOT a dependency
// of packages/ui (see this file's header and lib/types.ts).
const NANO_DOLLARS_PER_CENT = 10_000_000;

/**
 * Money at DISPLAY precision: two decimal places, ROUND HALF-UP — never
 * truncate. String-slicing `"$0.999999"` to `"$0.99"` understates every figure
 * in the ledger by up to a cent; `Math.round` on whole cents matches
 * `nanoDollarsToMicroDollars`'s existing round-half-up rule instead (D38).
 *
 * A non-zero amount under one cent renders `<$0.01`, never `$0.00` — the same
 * pillar-4 line this module already holds when it refuses to render an
 * unpriced row as `$0` (see `unknownTokenBadges`): a real sub-cent spend
 * collapsing to `$0.00` is the identical lie in different clothing. A true
 * zero still renders `$0.00`, so the two stay distinguishable.
 *
 * Takes `nanoDollars` — the exact integer every `MoneyAmount` carries —
 * rather than reparsing the `usd` string this module (or the daemon) already
 * formatted once; parsing a self-formatted string just to reformat it is a
 * lossy round trip (module header, "prefer the exact field"). Locale-free: no
 * `Intl`, no `toLocaleString` — same determinism posture as `formatTokenCount`.
 *
 * Total and safe (I8): non-finite, negative, null, undefined, or an absent
 * field all render `$0.00` — never a throw, never `NaN`.
 */
export function formatMoney(nanoDollars: number | null | undefined): string {
  if (typeof nanoDollars !== 'number' || !Number.isFinite(nanoDollars) || nanoDollars <= 0) {
    return '$0.00';
  }
  if (nanoDollars < NANO_DOLLARS_PER_CENT) {
    return '<$0.01';
  }
  const totalCents = Math.round(nanoDollars / NANO_DOLLARS_PER_CENT);
  const wholeDollars = Math.trunc(totalCents / 100);
  const centsRemainder = totalCents % 100;
  return `$${wholeDollars}.${String(centsRemainder).padStart(2, '0')}`;
}

// ── Spend history bars ──────────────────────────────────────────────────────

export interface SpendBar {
  readonly day: string;
  // The day's priced dollars at DISPLAY precision (formatMoney) — the exact
  // nanoDollars below is never recomputed, only reformatted (D38).
  readonly usd: string;
  readonly nanoDollars: number;
  // Bar height as a 0..100 percentage of the tallest day in the SAME series. A
  // non-zero day always gets at least MIN_VISIBLE_PERCENT so a real spend is
  // never invisible; a genuine $0 day stays flat at 0.
  readonly heightPercent: number;
}

// A real (non-zero) day never renders shorter than this, so a small-but-real
// spend beside a huge one is still visible. Purely visual — it shapes bar
// height only, never a number or a verdict.
const MIN_VISIBLE_PERCENT = 4;

/**
 * Normalize a spend series into bar heights relative to its own tallest day.
 *
 * Empty series → []. An all-zero series → every bar flat at 0 (no division by a
 * zero max, and no fabricated height). Heights are relative WITHIN the series
 * only; the dollar label is the authority, the bar is the glance.
 */
export function spendBars(points: readonly SpendHistoryPoint[] | null | undefined): SpendBar[] {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const maxNanoDollars = points.reduce(
    (runningMax, point) => Math.max(runningMax, finiteNonNegative(point.priced?.nanoDollars)),
    0,
  );
  return points.map((point) => {
    const nanoDollars = finiteNonNegative(point.priced?.nanoDollars);
    let heightPercent = 0;
    if (maxNanoDollars > 0 && nanoDollars > 0) {
      heightPercent = Math.max(MIN_VISIBLE_PERCENT, Math.round((nanoDollars / maxNanoDollars) * 100));
    }
    return {
      day: point.day,
      usd: formatMoney(nanoDollars),
      nanoDollars,
      heightPercent,
    };
  });
}

// The chart's y-axis top tick: the series max, at DISPLAY precision, or `null`
// when there is nothing honest to put there (empty series, or every bar flat
// at 0 — the empty-series case already has its own "No priced spend recorded"
// state, and an all-zero series showing a `$0.00` ceiling next to a `$0.00`
// floor would be an axis that says nothing, not a fabricated one, but the view
// skips it rather than render two identical labels).
//
// Deliberately reads `bar.nanoDollars`, the SAME field `heightPercent` was
// derived from in `spendBars` above — so the axis label and the bar heights
// can never disagree about which day is tallest.
export interface SpendAxisTick {
  readonly usd: string;
  readonly nanoDollars: number;
}

export function spendAxisMax(bars: readonly SpendBar[] | null | undefined): SpendAxisTick | null {
  if (!Array.isArray(bars) || bars.length === 0) {
    return null;
  }
  let maxNanoDollars = 0;
  for (const bar of bars) {
    if (bar.nanoDollars > maxNanoDollars) {
      maxNanoDollars = bar.nanoDollars;
    }
  }
  if (maxNanoDollars <= 0) {
    return null;
  }
  return { usd: formatMoney(maxNanoDollars), nanoDollars: maxNanoDollars };
}

/**
 * Resolve the spend series to chart for a selected directory node.
 * `null`/absent selection → the grand (everything) series. A selection that
 * matches no series → [] (rather than silently falling back to grand, which
 * would misattribute all spend to one node).
 */
export function seriesForSelection(
  spendHistory: SpendHistory | null | undefined,
  selectedDirectoryPath: string | null,
): readonly SpendHistoryPoint[] {
  if (spendHistory === null || spendHistory === undefined) {
    return [];
  }
  if (selectedDirectoryPath === null) {
    return Array.isArray(spendHistory.grand) ? spendHistory.grand : [];
  }
  const match = (spendHistory.byDirectory ?? []).find(
    (series) => series.directoryPath === selectedDirectoryPath,
  );
  return match?.points ?? [];
}

// ── D37: the directory tree, flattened for rendering ────────────────────────

// The node-key namespaces. A directory path and a session id can never collide
// once each carries its own prefix.
export function directoryRowKey(directoryPath: string): string {
  return `dir:${directoryPath}`;
}
export function sessionRowKey(directoryPath: string, sessionId: string): string {
  return `session:${directoryPath}::${sessionId}`;
}

// One rendered line of the ledger tree. The view walks a FLAT list and indents by
// `depth`, so the nesting logic is unit-tested here instead of inside a template.
export type LedgerTreeRow =
  | {
      readonly kind: 'directory';
      readonly key: string;
      readonly depth: number;
      readonly directory: DirectoryView;
      readonly expandable: boolean;
      readonly expanded: boolean;
    }
  | {
      readonly kind: 'session';
      readonly key: string;
      readonly depth: number;
      readonly session: SessionView;
      readonly expandable: boolean;
      readonly expanded: boolean;
    }
  | {
      readonly kind: 'agent';
      readonly key: string;
      readonly depth: number;
      readonly agent: AgentView;
    };

// How deep the tree opens on first render: nodes SHALLOWER than this are
// expanded, everything below starts collapsed. Two levels down from each root is
// the granularity the D37 defect was hiding (root → category → repo) and it still
// fits a phone; deeper is one tap away. Presentation only — it shapes no number.
export const DEFAULT_EXPANDED_DIRECTORY_DEPTH = 2;

/**
 * The directory-node keys to expand on first render: every node whose depth is
 * below `maxDepth`. Sessions are NOT expanded by default — a session's agents are
 * a deliberate drill-down, not a default view.
 */
export function defaultExpandedKeys(
  directories: readonly DirectoryView[] | null | undefined,
  maxDepth: number = DEFAULT_EXPANDED_DIRECTORY_DEPTH,
): string[] {
  const keys: string[] = [];
  for (const node of flattenDirectoryNodes(directories)) {
    if (node.depth < maxDepth && node.children.length + node.sessions.length > 0) {
      keys.push(directoryRowKey(node.directoryPath));
    }
  }
  return keys;
}

/**
 * Every directory node in the tree, pre-order (parent before its children) — the
 * order the rows render in, and the order the history selector offers. Total: a
 * missing/!Array node list yields [].
 */
export function flattenDirectoryNodes(
  directories: readonly DirectoryView[] | null | undefined,
): DirectoryView[] {
  if (!Array.isArray(directories)) {
    return [];
  }
  const flattened: DirectoryView[] = [];
  const pendingStack: DirectoryView[] = [...directories].reverse();
  while (pendingStack.length > 0) {
    const node = pendingStack.pop()!;
    flattened.push(node);
    const children = Array.isArray(node.children) ? node.children : [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      pendingStack.push(children[childIndex]!);
    }
  }
  return flattened;
}

/**
 * The rows to render, given which node keys are expanded.
 *
 * Order within an expanded directory: its OWN sessions first (they are that
 * node's `own` money), then its child directories (deeper rollups). Agents of an
 * expanded session follow that session, flattened by their own nesting depth.
 *
 * Depth is the render indent: a directory uses its tree depth; a session sits one
 * level below its directory; an agent one below its session, plus its own depth
 * in the agent tree.
 */
export function ledgerTreeRows(
  directories: readonly DirectoryView[] | null | undefined,
  expandedKeys: ReadonlySet<string>,
): LedgerTreeRow[] {
  const rows: LedgerTreeRow[] = [];
  if (!Array.isArray(directories)) {
    return rows;
  }

  const emitAgents = (agents: readonly AgentView[], baseDepth: number): void => {
    const pendingStack: Array<{ agent: AgentView; depth: number }> = [];
    for (let index = agents.length - 1; index >= 0; index -= 1) {
      pendingStack.push({ agent: agents[index]!, depth: baseDepth });
    }
    while (pendingStack.length > 0) {
      const { agent, depth } = pendingStack.pop()!;
      rows.push({
        kind: 'agent',
        key: `agent:${agent.sessionId}::${agent.agentId}`,
        depth,
        agent,
      });
      const children = Array.isArray(agent.children) ? agent.children : [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pendingStack.push({ agent: children[index]!, depth: depth + 1 });
      }
    }
  };

  // Pre-order DFS with an explicit stack (no recursion — path depth is unbounded).
  const pendingDirectories: DirectoryView[] = [...directories].reverse();
  while (pendingDirectories.length > 0) {
    const node = pendingDirectories.pop()!;
    const nodeKey = directoryRowKey(node.directoryPath);
    const sessions = Array.isArray(node.sessions) ? node.sessions : [];
    const children = Array.isArray(node.children) ? node.children : [];
    const expandable = sessions.length + children.length > 0;
    const expanded = expandable && expandedKeys.has(nodeKey);
    rows.push({ kind: 'directory', key: nodeKey, depth: node.depth, directory: node, expandable, expanded });
    if (!expanded) {
      continue;
    }
    for (const session of sessions) {
      const sessionKey = sessionRowKey(node.directoryPath, session.sessionId);
      const agents = Array.isArray(session.agents) ? session.agents : [];
      const sessionExpanded = agents.length > 0 && expandedKeys.has(sessionKey);
      rows.push({
        kind: 'session',
        key: sessionKey,
        depth: node.depth + 1,
        session,
        expandable: agents.length > 0,
        expanded: sessionExpanded,
      });
      if (sessionExpanded) {
        emitAgents(agents, node.depth + 2);
      }
    }
    // Reversed so the stack pops them back into their natural order, immediately
    // after this node and before any sibling still pending.
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      pendingDirectories.push(children[childIndex]!);
    }
  }
  return rows;
}

// One option of the spend-history selector: the SAME nodes the tree shows, in the
// same pre-order.
export interface DirectorySelectOption {
  readonly directoryPath: string;
  // The FULL directory path, deliberately — a bare segment would render two
  // different `vimes` nodes under different roots as the same option, and a
  // <select> collapses leading whitespace so an indent cannot disambiguate them.
  readonly label: string;
  // Tree depth, exposed so a caller can style the option without re-parsing paths.
  readonly depth: number;
}

export function directorySelectOptions(
  directories: readonly DirectoryView[] | null | undefined,
): DirectorySelectOption[] {
  return flattenDirectoryNodes(directories).map((node) => ({
    directoryPath: node.directoryPath,
    label: node.directoryPath,
    depth: node.depth,
  }));
}

// ── Emptiness ───────────────────────────────────────────────────────────────

/**
 * Classify the body into the state the view must render:
 * - 'disabled'  → ingestion is off; there is no ledger at all.
 * - 'empty'     → ingestion is on but nothing has been ingested yet.
 * - 'populated' → a real ledger with at least one directory node.
 *
 * 'disabled' and 'empty' are deliberately distinct: "the feature is off" and
 * "the feature is on but has seen no work" are different truths, and neither is
 * ever a fake $0 tree.
 */
export type LedgerState = 'disabled' | 'empty' | 'populated';

export function ledgerState(body: CostLedgerBody | null | undefined): LedgerState {
  if (body === null || body === undefined || body.ingestionEnabled !== true || body.ledger === null) {
    return 'disabled';
  }
  const directories = body.ledger.directories;
  return Array.isArray(directories) && directories.length > 0 ? 'populated' : 'empty';
}

// ── Attribution rows ────────────────────────────────────────────────────────

export interface AttributionRow {
  readonly key: string;
  // A blank/absent bucket key is shown with this placeholder, never dropped.
  readonly label: string;
  // Priced dollars at DISPLAY precision (formatMoney), not the wire's 6-dp
  // string — every price site in the ledger speaks the same precision (D38).
  readonly usd: string;
  readonly nanoDollars: number;
  readonly unknownBadges: readonly UnknownTokenBadge[];
}

// The label for the attribution bucket whose key is empty (rows that carried no
// skill/agent attribution). Kept and labelled, never silently dropped.
export const ABSENT_ATTRIBUTION_LABEL = '(none attributed)';

/**
 * Attribution groups into display rows, sorted by priced dollars descending
 * (stable by key for ties), the absent bucket kept and labelled. The dollar
 * strings are `formatMoney`'d from the exact `nanoDollars` (D38, 2 dp); only
 * ordering and precision are derived here — the underlying figure is untouched.
 */
export function attributionRows(groups: readonly AttributionView[] | null | undefined): AttributionRow[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .map((group) => ({
      key: group.key,
      label: group.key.trim().length > 0 ? group.key : ABSENT_ATTRIBUTION_LABEL,
      usd: formatMoney(group.totals?.priced?.nanoDollars),
      nanoDollars: finiteNonNegative(group.totals?.priced?.nanoDollars),
      unknownBadges: unknownTokenBadges(group.totals),
    }))
    .sort((left, right) =>
      right.nanoDollars !== left.nanoDollars
        ? right.nanoDollars - left.nanoDollars
        : left.key < right.key
          ? -1
          : left.key > right.key
            ? 1
            : 0,
    );
}

// ── Small helpers ───────────────────────────────────────────────────────────

// Compact, LOCALE-FREE token count (no Intl/toLocaleString — deterministic like
// meterDisplay.ts's durations). 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M".
export function formatTokenCount(tokenCount: number): string {
  const tokens = finiteNonNegative(tokenCount);
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${trimOneDecimal(tokens / 1000)}k`;
  }
  return `${trimOneDecimal(tokens / 1_000_000)}M`;
}

// One decimal place, trailing ".0" trimmed: 12.0 → "12", 12.34 → "12.3".
function trimOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyCounts(): PriceStatusCountsView {
  return { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 };
}
