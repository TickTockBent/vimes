// ─── slice 5b step 3 — the tree + rollups (PURE, packages/core) ──────────────
//
// Assemble Step 2's per-row `PricedRow`s into the hierarchy Wes asked for —
// directory → … → directory → session → subagent, as a genuine TREE (nesting is
// real to depth 3+, survey Q2) — with dollar rollups that RECONCILE exactly.
//
// ⚠ D37: THE TOP OF THE TREE IS A DIRECTORY ROLLUP, NOT AN INFERRED PROJECT.
// This module does NOT detect a project boundary — not `.git`, not `package.json`,
// not any marker file, not a fixed depth below a root. A cwd is a FACT; a project
// boundary is an INFERENCE, and Wes may work without a repo or with another VCS.
// So every directory node is a real directory some session actually ran in, or an
// ancestor of one, and the operator picks granularity by EXPANDING rather than by
// trusting a boundary someone guessed (docs/decisions.md D37).
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
  // The record's own cwd. Slugs are NOT projects (rule 9); classification runs
  // against cwd + insideProjectRoots, never the slug directory name.
  readonly projectCwd: string | null;
  // FALSE = the outside-`VIMES_PROJECT_ROOTS` bucket. Retained + labelled, never
  // dropped (rule 9).
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
  // The directory node this session hangs off. For an inside-roots session this
  // IS its launch cwd, verbatim (D37) — never a truncated/inferred project key;
  // for an outside-roots session it is the shared sentinel bucket.
  readonly directoryPath: string;
  // The session's OWN launch cwd, normalized, kept even when the session is
  // bucketed outside roots — it is what the identity ladder's basename rung
  // reads. Null when the rows carried no usable cwd.
  readonly cwd: string | null;
  // The human-given session name, when the caller supplied one via
  // `sessionNames`. Null = no name known (not "no name exists").
  readonly name: string | null;
  // The identity ladder (D37): `name` → cwd basename → short id. NEVER blank —
  // a session leaf must always render as something a human can read.
  readonly label: string;
  // Rows on this node directly = the session's own messages (agentId null).
  readonly own: RollupTotals;
  // Top-level agents: parent recovered as the session root, or unattributed.
  readonly agents: readonly AgentNode[];
  readonly subtree: RollupTotals;
}

// A node of the DIRECTORY ROLLUP (D37). Every node is either a real directory a
// session ran in, or an ancestor of one on the path down from a matched
// `VIMES_PROJECT_ROOTS` entry — plus the two explicit sentinel buckets
// (outside-roots, unknown-directory), which are top-level and childless.
export interface DirectoryNode {
  // The absolute directory path, normalized (no trailing/duplicate separators),
  // or a sentinel bucket key. This is the node's identity on the wire.
  readonly directoryPath: string;
  // The last path segment — what a surface shows. Never blank: `/` labels as
  // `/`, and a sentinel labels as itself.
  readonly label: string;
  // Depth below the top of ITS OWN chain (top-level node = 0). Lets a surface
  // indent and pick a default expansion depth without re-parsing paths.
  readonly depth: number;
  // FALSE only for the single outside-`VIMES_PROJECT_ROOTS` bucket.
  readonly insideProjectRoots: boolean;
  // Sessions LAUNCHED IN THIS EXACT DIRECTORY. A session launched in a
  // subdirectory belongs to that subdirectory's node, not this one.
  readonly sessions: readonly SessionNode[];
  // Child directories, ascending by directoryPath.
  readonly children: readonly DirectoryNode[];
  // The spend of the sessions launched in THIS directory itself = Σ
  // sessions.subtree. (Rows never attach to a directory — every row has a
  // session — so `own` is a roll-up of this node's own sessions, which is
  // exactly the "what was spent here, not below here" number.)
  readonly own: RollupTotals;
  // own + Σ children.subtree, BY CONSTRUCTION.
  readonly subtree: RollupTotals;
}

export interface AttributionGroup {
  // The attributionSkill / attributionAgent value, or the ABSENT sentinel.
  readonly key: string;
  readonly totals: RollupTotals;
}

export interface CostTree {
  // The TOP-LEVEL directory nodes, ascending by directoryPath. Each matched
  // `VIMES_PROJECT_ROOTS` entry that has spend under it is one top-level node;
  // a cwd that matched no root is its own top-level node; the two sentinel
  // buckets sit here too.
  readonly directories: readonly DirectoryNode[];
  // Grand total over every row = Σ top-level directory subtrees. Reconciles with
  // the secondary groupings (each row lands in exactly one skill and one agent
  // bucket).
  readonly grandTotal: RollupTotals;
  readonly byAttributionSkill: readonly AttributionGroup[];
  readonly byAttributionAgent: readonly AttributionGroup[];
}

export interface BuildCostTreeOptions {
  // `VIMES_PROJECT_ROOTS` (injected data, pure — the daemon supplies the lab's
  // roots). D37: these are the FILTER and the CEILING of the rollup, never a
  // boundary detector. A row's directory is its cwd verbatim; the matched root
  // is simply where its ancestor chain stops climbing. Empty (default) → every
  // distinct cwd is its own top-level node, with no invented ancestors.
  readonly projectRoots?: readonly string[];
  // Externally-harvested agent→agent parent edges (parent-edge fix, unit 1). Applied
  // FIRST (authoritative), then row-derived edges fill the rest — see mergeParentEdges.
  // Absent/empty (default) → behaviour is exactly the row-only buildParentMap path.
  readonly parentEdges?: readonly ExplicitAgentParentEdge[];
  // Human-given session names, keyed by the SAME session id the cost rows carry,
  // for the D37 identity ladder (`name` → cwd basename → short id). Injected
  // DATA, not a lookup: core stays pure and never reaches for a projection.
  // Absent (default) → the ladder starts at the cwd basename.
  readonly sessionNames?: Readonly<Record<string, string | null>>;
}

// The single explicit bucket for rows outside VIMES_PROJECT_ROOTS (rule 9).
export const OUTSIDE_ROOTS_PROJECT_KEY = '<outside-project-roots>';
// The bucket for a row that claims to be INSIDE roots but carries no usable cwd
// (blank after normalization). Never seen in the live corpus; handled rather than
// assumed away, and given a printable non-blank key so it can never render as an
// empty directory label. A null cwd keeps its existing home in the outside bucket
// — this sentinel deliberately does not move any row that already had one.
export const UNKNOWN_DIRECTORY_KEY = '<unknown-directory>';
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

// An externally-supplied parent edge (parent-edge fix, unit 1). On the real corpus
// the agent→agent edge lives on `toolUseResult.agentId`, which appears ONLY on
// non-usage-bearing `type:user` records — so the usage rows the tree ingests carry
// `toolUseResultAgentId: null` and `buildParentMap(rows)` recovers nothing. A caller
// that harvested those edges out-of-band (unit 2, the daemon) supplies them here so
// the tree can nest. Keyed within a session (the child shares the spawner's session);
// `parentAgentId` null = spawned by the session root directly (fallback, unresolved).
export interface ExplicitAgentParentEdge {
  readonly sessionId: string | null;
  readonly childAgentId: string;
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

// Merge injected `parentEdges` with the row-derived edges into ONE parent map, of
// the same `Map<string, AgentParentEdge>` shape `buildParentMap` returns and keyed
// by the same `nodeKey(sessionId, childAgentId)`.
//
// Union order (deterministic, first-wins per (sessionId, childAgentId) node key):
//   1. Injected `parentEdges` FIRST, in array order — authoritative for the real
//      corpus, whose usage rows carry no `toolUseResult.agentId` edge. A child
//      already present is skipped (the earlier injected edge wins).
//   2. THEN the row-derived edges from `buildParentMap(rows)`, filling only children
//      not already claimed by an injected edge.
// The result is a pure function of (parentEdges, rows): Map insertion order is fixed
// by the fold order above, so the same inputs always produce the same map.
function mergeParentEdges(
  parentEdges: readonly ExplicitAgentParentEdge[],
  rows: readonly CostTreeInputRow[],
): Map<string, AgentParentEdge> {
  const parentByChildNodeKey = new Map<string, AgentParentEdge>();
  // Pass 1: injected edges, array order, first-wins per child node key.
  for (const injectedEdge of parentEdges) {
    const childNodeKey = nodeKey(injectedEdge.sessionId, injectedEdge.childAgentId);
    if (!parentByChildNodeKey.has(childNodeKey)) {
      parentByChildNodeKey.set(childNodeKey, { parentAgentId: injectedEdge.parentAgentId });
    }
  }
  // Pass 2: row-derived edges fill any child an injected edge did not already claim.
  const rowDerivedEdges = buildParentMap(rows);
  for (const [childNodeKey, edge] of rowDerivedEdges) {
    if (!parentByChildNodeKey.has(childNodeKey)) {
      parentByChildNodeKey.set(childNodeKey, edge);
    }
  }
  return parentByChildNodeKey;
}

// ── Deliverable 2: directory classification (rule 9 + D37) ───────────────────
//
// ⚠ Nothing below detects a project. It splits a path into segments and compares
// prefixes — both facts about the string the row already carried.

// Split a POSIX path into its non-empty segments, remembering whether it was
// absolute. Empty segments (from `//`, or a trailing `/`) are dropped, so
// `/a//b/` and `/a/b` are the SAME directory — path equivalence, not inference.
function splitDirectorySegments(rawPath: string): { isAbsolute: boolean; segments: string[] } {
  const isAbsolute = rawPath.startsWith(PATH_SEPARATOR);
  const segments = rawPath.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  return { isAbsolute, segments };
}

// The canonical spelling of a directory path: absolute paths keep their leading
// separator (`/` alone for the filesystem root), relative ones are joined as-is.
// A path with nothing in it normalizes to '' — the caller decides what that means.
function normalizeDirectoryPath(rawPath: string): string {
  const { isAbsolute, segments } = splitDirectorySegments(rawPath);
  if (isAbsolute) {
    return PATH_SEPARATOR + segments.join(PATH_SEPARATOR);
  }
  return segments.join(PATH_SEPARATOR);
}

// TRUE when `candidatePath` is the root itself or sits beneath it. Both sides are
// compared segment-wise, so `/a/bc` is never "inside" `/a/b`.
function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const candidate = splitDirectorySegments(candidatePath);
  const rootParts = splitDirectorySegments(root);
  if (candidate.isAbsolute !== rootParts.isAbsolute) {
    return false;
  }
  if (candidate.segments.length < rootParts.segments.length) {
    return false;
  }
  return rootParts.segments.every((segment, index) => candidate.segments[index] === segment);
}

// The longest configured root that contains `directoryPath`, or null. Length is
// measured in SEGMENTS (a longer path string is not necessarily a deeper root).
function longestMatchingRoot(
  directoryPath: string,
  projectRoots: readonly string[],
): string | null {
  let bestRoot: string | null = null;
  let bestSegmentCount = -1;
  for (const root of projectRoots) {
    const normalizedRoot = normalizeDirectoryPath(root);
    if (!isPathWithinRoot(directoryPath, normalizedRoot)) {
      continue;
    }
    const segmentCount = splitDirectorySegments(normalizedRoot).segments.length;
    if (segmentCount > bestSegmentCount) {
      bestSegmentCount = segmentCount;
      bestRoot = normalizedRoot;
    }
  }
  return bestRoot;
}

/**
 * The DIRECTORY a row belongs to (D37) — the row's own cwd, normalized, and
 * nothing else. The OUTSIDE bucket when the row is not inside roots (or carries
 * no cwd at all); the unknown-directory bucket when the cwd is present but blank.
 *
 * This function deliberately does NOT truncate the cwd to some level below a
 * root: that truncation was the D37 defect (it grouped a whole category of
 * repositories into one line). Rolling several cwds up into a shared parent is
 * the TREE's job, and it does it with real ancestor directories.
 */
export function resolveDirectoryKey(
  row: CostTreeInputRow,
  projectRoots: readonly string[],
): { directoryPath: string; insideProjectRoots: boolean } {
  if (!row.insideProjectRoots || row.projectCwd === null) {
    return { directoryPath: OUTSIDE_ROOTS_PROJECT_KEY, insideProjectRoots: false };
  }
  const normalizedCwd = normalizeDirectoryPath(row.projectCwd);
  if (normalizedCwd === '') {
    return { directoryPath: UNKNOWN_DIRECTORY_KEY, insideProjectRoots: true };
  }
  // `projectRoots` is not consulted here at all: it bounds the ancestor chain in
  // `ancestorChainFor`, it does not reshape the directory the session ran in.
  void projectRoots;
  return { directoryPath: normalizedCwd, insideProjectRoots: true };
}

// The chain of directory nodes from the top of the rollup down to
// `directoryPath`, inclusive and in that order.
//
// - A sentinel bucket is its own single-node chain (it has no ancestors and must
//   not be folded into the tree).
// - Inside a matched root, the chain starts AT the root: the root is the ceiling
//   of the rollup, so `…/projects` is the full-spend node and nothing above it is
//   invented.
// - With no root matched (or none configured), the chain is the cwd alone — a
//   standalone top-level node. Climbing to `/` here would fabricate ancestors
//   nobody asked for.
function ancestorChainFor(directoryPath: string, projectRoots: readonly string[]): string[] {
  if (directoryPath === OUTSIDE_ROOTS_PROJECT_KEY || directoryPath === UNKNOWN_DIRECTORY_KEY) {
    return [directoryPath];
  }
  const matchedRoot = longestMatchingRoot(directoryPath, projectRoots);
  if (matchedRoot === null) {
    return [directoryPath];
  }
  const rootSegmentCount = splitDirectorySegments(matchedRoot).segments.length;
  const { isAbsolute, segments } = splitDirectorySegments(directoryPath);
  const chain: string[] = [matchedRoot];
  for (let segmentIndex = rootSegmentCount; segmentIndex < segments.length; segmentIndex += 1) {
    const prefixSegments = segments.slice(0, segmentIndex + 1);
    chain.push(
      isAbsolute
        ? PATH_SEPARATOR + prefixSegments.join(PATH_SEPARATOR)
        : prefixSegments.join(PATH_SEPARATOR),
    );
  }
  return chain;
}

// The display label for a directory node: its last path segment. `/` labels as
// `/`; a sentinel labels as itself. NEVER blank.
function directoryLabelFor(directoryPath: string): string {
  if (directoryPath === OUTSIDE_ROOTS_PROJECT_KEY || directoryPath === UNKNOWN_DIRECTORY_KEY) {
    return directoryPath;
  }
  const { segments } = splitDirectorySegments(directoryPath);
  const lastSegment = segments[segments.length - 1];
  return lastSegment === undefined || lastSegment === '' ? directoryPath : lastSegment;
}

// How many leading characters of a session id make the last-resort short id. Long
// enough to be distinguishable at a glance in a uuid corpus, short enough to fit a
// phone row. Presentation only — it never keys anything.
const SHORT_SESSION_ID_LENGTH = 8;

/**
 * The D37 session identity ladder: human `name` → cwd basename → short id.
 *
 * `sessionCwd` is the session's OWN launch directory, not the node it hangs off
 * — an outside-roots session shares one bucket with 30 others, so labelling it
 * with the bucket key would make every one of them look identical. Total: it
 * NEVER returns a blank string, so a session leaf can never render empty. A
 * session id shorter than the short-id length is used whole.
 */
export function sessionDisplayLabel(
  sessionId: string,
  sessionCwd: string | null,
  sessionName: string | null,
): string {
  if (sessionName !== null && sessionName.trim().length > 0) {
    return sessionName.trim();
  }
  if (sessionCwd !== null) {
    const cwdBasename = directoryLabelFor(sessionCwd);
    if (cwdBasename.trim().length > 0) {
      return cwdBasename;
    }
  }
  if (sessionId.trim().length > 0) {
    return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
  }
  return UNKNOWN_SESSION_KEY;
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
  // Union of injected edges (first, authoritative) and row-derived edges. With no
  // injected edges this equals buildParentMap(rows) exactly — same map, same keys.
  const parentMap = mergeParentEdges(options.parentEdges ?? [], rows);

  // Pass 0: a session belongs to ONE directory. A session is launched in one
  // directory, and its session-root records (agentId null) carry that launch cwd
  // — the truth — even when subagents cd into worktrees that classify elsewhere
  // (3 sessions span >1 classification in the live corpus). So each session's
  // directory is chosen from its root rows (the lexically smallest, for
  // determinism, if a session's roots ever disagree); a session with no root row
  // (defensive — none in the corpus) falls back to the smallest among all its
  // rows. D37 changed WHAT is chosen (the full cwd, not a truncation), not HOW.
  const rootDirectoryCandidates = new Map<string, Set<string>>();
  const anyDirectoryCandidates = new Map<string, Set<string>>();
  const insideRootsByDirectory = new Map<string, boolean>();
  // The session's raw launch cwd, chosen by the SAME rule and kept even when the
  // session is bucketed outside roots — the identity ladder's basename rung reads
  // it, and the outside bucket key would otherwise make 31 sessions look alike.
  const rootCwdCandidates = new Map<string, Set<string>>();
  const anyCwdCandidates = new Map<string, Set<string>>();
  for (const row of rows) {
    const sessionId = sessionKeyOf(row.sessionId);
    const classification = resolveDirectoryKey(row, projectRoots);
    insideRootsByDirectory.set(classification.directoryPath, classification.insideProjectRoots);
    const anySet = anyDirectoryCandidates.get(sessionId) ?? new Set<string>();
    anySet.add(classification.directoryPath);
    anyDirectoryCandidates.set(sessionId, anySet);
    if (row.agentId === null) {
      const rootSet = rootDirectoryCandidates.get(sessionId) ?? new Set<string>();
      rootSet.add(classification.directoryPath);
      rootDirectoryCandidates.set(sessionId, rootSet);
    }

    const normalizedCwd = row.projectCwd === null ? '' : normalizeDirectoryPath(row.projectCwd);
    if (normalizedCwd !== '') {
      const anyCwdSet = anyCwdCandidates.get(sessionId) ?? new Set<string>();
      anyCwdSet.add(normalizedCwd);
      anyCwdCandidates.set(sessionId, anyCwdSet);
      if (row.agentId === null) {
        const rootCwdSet = rootCwdCandidates.get(sessionId) ?? new Set<string>();
        rootCwdSet.add(normalizedCwd);
        rootCwdCandidates.set(sessionId, rootCwdSet);
      }
    }
  }
  const sessionDirectoryPath = new Map<string, string>();
  for (const [sessionId, anySet] of anyDirectoryCandidates) {
    const rootSet = rootDirectoryCandidates.get(sessionId);
    const candidates = rootSet !== undefined && rootSet.size > 0 ? rootSet : anySet;
    const chosen = [...candidates].sort()[0]!;
    sessionDirectoryPath.set(sessionId, chosen);
  }
  const sessionLaunchCwd = new Map<string, string>();
  for (const [sessionId, anyCwdSet] of anyCwdCandidates) {
    const rootCwdSet = rootCwdCandidates.get(sessionId);
    const candidates = rootCwdSet !== undefined && rootCwdSet.size > 0 ? rootCwdSet : anyCwdSet;
    sessionLaunchCwd.set(sessionId, [...candidates].sort()[0]!);
  }

  // Pass 1: bucket every row into exactly one node's `own`.
  // directory → … → directory → session → (session-own | agent-own).
  interface DirectoryBuildState {
    readonly directoryPath: string;
    readonly depth: number;
    readonly insideProjectRoots: boolean;
    readonly sessionIds: string[];
    readonly childDirectoryPaths: Set<string>;
    // TRUE only for the first node of an ancestor chain — the roots of the forest.
    isTopLevel: boolean;
  }
  const directoryStates = new Map<string, DirectoryBuildState>();
  const sessionOwnTotals = new Map<string, MutableTotals>();
  const sessionAgentIds = new Map<string, string[]>();
  const agentStates = new Map<string, AgentBuildState>();

  // Materialize the whole ancestor chain for a directory, linking parent→child.
  // Idempotent: an ancestor shared by two sessions is created once.
  const ensureDirectoryChain = (directoryPath: string, insideRoots: boolean): void => {
    const chain = ancestorChainFor(directoryPath, projectRoots);
    chain.forEach((chainPath, chainDepth) => {
      let state = directoryStates.get(chainPath);
      if (state === undefined) {
        state = {
          directoryPath: chainPath,
          depth: chainDepth,
          // An ancestor of an inside-roots directory is itself inside roots; the
          // flag is FALSE only for the outside bucket, which is its own chain.
          insideProjectRoots: insideRoots,
          sessionIds: [],
          childDirectoryPaths: new Set<string>(),
          isTopLevel: chainDepth === 0,
        };
        directoryStates.set(chainPath, state);
      }
      const parentPath = chainDepth === 0 ? null : chain[chainDepth - 1]!;
      if (parentPath !== null) {
        directoryStates.get(parentPath)!.childDirectoryPaths.add(chainPath);
        // A node first seen as the top of a shorter chain (a session launched AT
        // the root) is not top-level once a deeper chain reveals its parent.
        state.isTopLevel = false;
      }
    });
  };

  const ensureSession = (sessionId: string, directoryPath: string): void => {
    if (!sessionOwnTotals.has(sessionId)) {
      sessionOwnTotals.set(sessionId, newMutableTotals());
      sessionAgentIds.set(sessionId, []);
      const directoryState = directoryStates.get(directoryPath);
      if (directoryState !== undefined) {
        directoryState.sessionIds.push(sessionId);
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
    const directoryPath = sessionDirectoryPath.get(sessionId)!;
    const insideProjectRoots = insideRootsByDirectory.get(directoryPath) ?? false;
    ensureDirectoryChain(directoryPath, insideProjectRoots);
    ensureSession(sessionId, directoryPath);

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
  // session subtree = own + Σ top-level agent subtrees; directory own = Σ its own
  // sessions' subtrees; directory subtree = own + Σ child directory subtrees;
  // grand total = Σ top-level directory subtrees. Subtree === own + Σ children BY
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

  const sessionNames = options.sessionNames ?? {};

  const buildSessionNode = (sessionId: string, directoryPath: string): SessionNode => {
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
    // The session's own launch cwd — the sentinel buckets carry no directory, so
    // the basename rung of the ladder has nothing to read there and falls through.
    const sessionCwd =
      directoryPath === OUTSIDE_ROOTS_PROJECT_KEY || directoryPath === UNKNOWN_DIRECTORY_KEY
        ? sessionLaunchCwd.get(sessionId) ?? null
        : directoryPath;
    // `Object.hasOwn` (not a bare lookup) so an inherited key like "toString"
    // can never masquerade as a session name (I8).
    const sessionName = Object.hasOwn(sessionNames, sessionId) ? sessionNames[sessionId] ?? null : null;
    return {
      sessionId,
      directoryPath,
      cwd: sessionCwd,
      name: sessionName,
      label: sessionDisplayLabel(sessionId, sessionCwd, sessionName),
      own: freezeTotals(ownMutable),
      agents: agentNodes,
      subtree: freezeTotals(subtree),
    };
  };

  // Freeze the directory forest bottom-up with an EXPLICIT stack rather than
  // recursion: a pathological cwd can be arbitrarily deep, and a deep path must
  // never blow the stack (I8, assertion 6).
  const frozenDirectoryCache = new Map<string, DirectoryNode>();
  const buildDirectoryNode = (rootPath: string): DirectoryNode => {
    const pendingStack: string[] = [rootPath];
    while (pendingStack.length > 0) {
      const currentPath = pendingStack[pendingStack.length - 1]!;
      if (frozenDirectoryCache.has(currentPath)) {
        pendingStack.pop();
        continue;
      }
      const state = directoryStates.get(currentPath)!;
      const sortedChildPaths = [...state.childDirectoryPaths].sort();
      const unfrozenChildPaths = sortedChildPaths.filter((childPath) => !frozenDirectoryCache.has(childPath));
      if (unfrozenChildPaths.length > 0) {
        pendingStack.push(...unfrozenChildPaths);
        continue;
      }
      pendingStack.pop();
      const sortedSessionIds = [...state.sessionIds].sort();
      const sessionNodes = sortedSessionIds.map((sessionId) => buildSessionNode(sessionId, currentPath));
      // `own` = the spend of the sessions launched in THIS directory itself.
      const own = newMutableTotals();
      for (const sessionNode of sessionNodes) {
        addTotals(own, sessionNode.subtree);
      }
      const frozenOwn = freezeTotals(own);
      const childNodes = sortedChildPaths.map((childPath) => frozenDirectoryCache.get(childPath)!);
      const subtree = newMutableTotals();
      addTotals(subtree, frozenOwn);
      for (const childNode of childNodes) {
        addTotals(subtree, childNode.subtree);
      }
      frozenDirectoryCache.set(currentPath, {
        directoryPath: currentPath,
        label: directoryLabelFor(currentPath),
        depth: state.depth,
        insideProjectRoots: state.insideProjectRoots,
        sessions: sessionNodes,
        children: childNodes,
        own: frozenOwn,
        subtree: freezeTotals(subtree),
      });
    }
    return frozenDirectoryCache.get(rootPath)!;
  };

  const topLevelDirectoryPaths = [...directoryStates.values()]
    .filter((state) => state.isTopLevel)
    .map((state) => state.directoryPath)
    .sort();
  const directoryNodes = topLevelDirectoryPaths.map((rootPath) => buildDirectoryNode(rootPath));
  const grandTotal = newMutableTotals();
  for (const directoryNode of directoryNodes) {
    addTotals(grandTotal, directoryNode.subtree);
  }

  // ── Deliverable 4: secondary flat groupings ────────────────────────────────
  const byAttributionSkill = groupRowsBy(rows, (row) => row.attributionSkill);
  const byAttributionAgent = groupRowsBy(rows, (row) => row.attributionAgent);

  return {
    directories: directoryNodes,
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
  readonly nodeKind: 'agent' | 'session' | 'directory' | 'grand-total';
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
    // Names the identity under test when a node has more than one (a directory
    // checks both `subtree === own + Σ children` and `own === Σ sessions`).
    fieldPrefix = '',
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
    for (const [fieldName, expectedValue, actualValue] of fields) {
      const field = fieldPrefix + fieldName;
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

  // Walk the directory forest with an explicit stack (no recursion — a cwd can be
  // arbitrarily deep and the verifier must survive it too).
  const grandExpected = newMutableTotals();
  const pendingDirectories: DirectoryNode[] = [...tree.directories];
  while (pendingDirectories.length > 0) {
    const directoryNode = pendingDirectories.pop()!;
    pendingDirectories.push(...directoryNode.children);

    for (const sessionNode of directoryNode.sessions) {
      for (const agentNode of sessionNode.agents) {
        checkAgent(agentNode);
      }
      const sessionExpected = sumChildren(
        sessionNode.agents.map((agentNode) => agentNode.subtree),
        sessionNode.own,
      );
      compareTotals('session', sessionNode.sessionId, sessionExpected, sessionNode.subtree);
    }
    // Identity 1: a directory's `own` IS the roll-up of the sessions launched in it.
    const ownExpected = sumChildren(
      directoryNode.sessions.map((sessionNode) => sessionNode.subtree),
      emptyTotals(),
    );
    compareTotals('directory', directoryNode.directoryPath, ownExpected, directoryNode.own, 'own.');
    // Identity 2: the load-bearing one — subtree === own + Σ children.subtree.
    const subtreeExpected = sumChildren(
      directoryNode.children.map((childNode) => childNode.subtree),
      directoryNode.own,
    );
    compareTotals('directory', directoryNode.directoryPath, subtreeExpected, directoryNode.subtree);
  }
  for (const topLevelDirectory of tree.directories) {
    addTotals(grandExpected, topLevelDirectory.subtree);
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
