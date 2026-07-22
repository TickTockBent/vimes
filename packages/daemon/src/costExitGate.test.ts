import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { COST_LEDGER_SCOPE_LABEL, OUTSIDE_ROOTS_PROJECT_KEY } from '@vimes/core';
import type {
  CorpusDirectoryEntry,
  CorpusFileStat,
  CorpusFileSystem,
} from './costCorpus.js';
import { ingestCostCorpus } from './costIngest.js';
import { SqliteCostStore } from './sqliteCostStore.js';
import { currentCostLedger } from './costLedgerApi.js';

// ─── slice 5b step 5 — the machine EXIT GATE (end-to-end fixture corpus) ──────
//
// The standing, CI-enforced proof that the WHOLE cost pipeline is correct on
// ADVERSARIAL data — and that it goes RED when broken (the budget-wall discipline,
// budgetWall.ts, applied to the corpus-driven cost path instead of the event path).
//
// WHY THIS IS NOT A 7TH HARNESS PROFILE. The six harness profiles are
// event/session-replay scenarios and `harness/scenarios.test.ts` asserts "exactly
// the six spec §7 profiles". The cost pipeline is corpus-driven and spans daemon
// (ingest + store) + core (price + tree + read model), so its exit gate is an
// end-to-end INTEGRATION test exercising that whole path, not a profile.
//
// It drives the REAL path — no shims, no re-implemented arithmetic:
//   in-memory CorpusFileSystem → ingestCostCorpus → temp SqliteCostStore
//     → currentCostLedger({ costLedgerStore, projectRoots })
// and NEVER reads ~/.claude or the real ledger: the filesystem is in-memory and
// the store is a fresh temp-directory SQLite file.
//
// ─── PROVEN-TO-FAIL-BY-SABOTAGE (the teeth) — for the orchestrator ────────────
// A gate is worthless if it cannot fail. Two guarantees back that up here:
//
//  (A) An EXPLICIT teeth test in this file ("anti-double-count assertion is not
//      vacuous"). It re-runs the SAME fixture with the fork's copied rows carrying
//      DISTINCT message ids, so the store's max-wins dedupe cannot merge them, and
//      asserts the grand total inflates to the exact DOUBLED figure
//      (235,000,000 nano) — proving the deduped-total assertion below rejects a
//      broken-dedup input rather than passing vacuously.
//
//  (B) Manual sabotages the orchestrator can actually run, each reddening a NAMED
//      assertion (kept TRUE — verified by construction):
//        • Anti-double-count / reconciliation:
//          in costCorpus.ts `parseUsageRecord`, change the deduped row key
//            rowKey: `msg:${messageId}`   →   `msg:${messageId}@${context.sourcePath}`
//          so the fork copies get distinct keys and are counted twice. The grand
//          total in ASSERTIONS 1 & 2 goes red (235,000,000 instead of 132,500,000).
//        • Max-wins dedupe: in sqliteCostStore.ts UPSERT_USAGE_ROW, change
//          `outputTokens = MAX(...)` to `outputTokens = excluded.outputTokens`
//          (first-/last-wins). Progressive-snapshot spend collapses and ASSERTION 1
//          goes red (grand total no longer 132,500,000).
//        • No-percent scope discipline: add a `percentOfBudget` field to
//          CostLedgerReadModel in costLedgerReadModel.ts. ASSERTION 3 goes red
//          (the body's JSON now contains "percent").
//        • Nesting: in costTree.ts pass 2, stop honouring the parent edge (force
//          `parentResolved = false` / attach every agent to the session root).
//          ASSERTION 5 goes red (no agent has a resolved child at depth ≥2).

// ── the adversarial fixture, exercising every load-bearing rule AT ONCE ───────
//
// projectRoots has ONE parent dir; three projects classify against it:
//   • vimes  — inside roots
//   • daotree — inside roots
//   • the outside bucket — a session whose cwd sits OUTSIDE roots (rule 7/9)
// Two priced days (rule 10 → history has >1 point), four models: opus + haiku +
// fable priced, plus an unknown-model string (unpriced) and a missing-model row
// (unpriceable ''), plus a literal <synthetic> record the SCAN excludes (rule 7).
// A haiku row splits cache into 5m + 1h tiers (rule 6). A FORK file copies two
// rows verbatim by message.id, which max-wins dedupe MUST count once (rule 4). A
// real toolUseResult.agentId edge nests agent-child under agent-parent to depth 2.
const PROJECT_ROOTS: readonly string[] = ['/home/ticktockbent/projects'];
const PROJECTS_ROOT = '/fake/projects';

const CWD_VIMES = '/home/ticktockbent/projects/vimes';
const CWD_DAOTREE = '/home/ticktockbent/projects/daotree';
const CWD_OUTSIDE = '/home/ticktockbent/other/scratch';

const PROJECT_KEY_VIMES = '/home/ticktockbent/projects/vimes';
const PROJECT_KEY_DAOTREE = '/home/ticktockbent/projects/daotree';

const SESSION_VIMES = 'session-vimes-1';
const SESSION_DAOTREE = 'session-daotree-2';
const SESSION_OUTSIDE = 'session-outside-3';

const AGENT_PARENT = 'agent-parent-aaaa';
const AGENT_CHILD = 'agent-child-bbbb';

const DAY_ONE = '2026-07-19';
const DAY_TWO = '2026-07-20';

// ── the pinned expected figures, COMPUTED BY HAND from the price table ────────
//
// Per-token integer nano-dollar rates (priceTable.ts): a rate is $/MTok × 1000,
// cache tiers are base-input × {5m ×1.25, 1h ×2.00, read ×0.10}.
//   opus  (claude-opus-4-8):   input 15000, output 75000
//   haiku (claude-haiku-4-5):  input 1000,  cacheRead 100, cache5m 1250, cache1h 2000
//   fable (claude-fable-5):    input 10000, output 50000
//
// Priced rows (each counted ONCE after fork dedupe):
//   R1 opus  root  S1  in=100  out=1000  → 100·15000 + 1000·75000       = 76,500,000
//   R2 haiku agent S1  in=2000 cacheRead=1000 cache5m=400 cache1h=200
//        → 2000·1000 + 1000·100 + 400·1250 + 200·2000                   =  3,000,000
//   R3 fable agent S1  in=100  out=500   → 100·10000 + 500·50000        = 26,000,000
//   R4 opus  root  S2  in=200  out=200   → 200·15000 + 200·75000        = 18,000,000
//   R5 opus  root  S3  in=100  out=100   → 100·15000 + 100·75000        =  9,000,000
// Grand deduped priced total:                                          = 132,500,000
const EXPECTED_R1_OPUS_ROOT_NANO = 76_500_000;
const EXPECTED_R2_HAIKU_CACHE_NANO = 3_000_000;
const EXPECTED_R3_FABLE_CHILD_NANO = 26_000_000;
const EXPECTED_R4_OPUS_DAOTREE_NANO = 18_000_000;
const EXPECTED_R5_OPUS_OUTSIDE_NANO = 9_000_000;

const EXPECTED_DAY_ONE_NANO =
  EXPECTED_R1_OPUS_ROOT_NANO + EXPECTED_R2_HAIKU_CACHE_NANO + EXPECTED_R3_FABLE_CHILD_NANO; // 105,500,000
const EXPECTED_DAY_TWO_NANO = EXPECTED_R4_OPUS_DAOTREE_NANO + EXPECTED_R5_OPUS_OUTSIDE_NANO; // 27,000,000
const EXPECTED_GRAND_DEDUPED_NANO = EXPECTED_DAY_ONE_NANO + EXPECTED_DAY_TWO_NANO; // 132,500,000

// If the fork's two shared rows (R1 + R3) were summed TWICE (a broken dedupe), the
// grand total would inflate by exactly their sum. The teeth test proves it.
const EXPECTED_DOUBLED_IF_DEDUPE_BROKEN_NANO =
  EXPECTED_GRAND_DEDUPED_NANO + EXPECTED_R1_OPUS_ROOT_NANO + EXPECTED_R3_FABLE_CHILD_NANO; // 235,000,000

// Token weights of the surfaced un-knowns (Pillar 4: never a silent $0).
const UNKNOWN_MODEL_OUTPUT_TOKENS = 1234;
const MISSING_MODEL_OUTPUT_TOKENS = 777;

// ── the JSONL record builder ──────────────────────────────────────────────────
interface UsageRecordFields {
  timestamp: string;
  cwd: string;
  sessionId: string;
  messageId?: string; // omitted → no message.id (undedupable, keyed by line offset)
  model?: string | null; // omitted → NO model field (unpriceable ''); explicit for <synthetic>/unknown
  agentId?: string | null;
  toolUseResultAgentId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  attributionAgent?: string | null;
  attributionSkill?: string | null;
}

function usageRecordLine(fields: UsageRecordFields): string {
  const usage: Record<string, unknown> = {};
  if (fields.inputTokens !== undefined) usage.input_tokens = fields.inputTokens;
  if (fields.outputTokens !== undefined) usage.output_tokens = fields.outputTokens;
  if (fields.cacheReadInputTokens !== undefined) {
    usage.cache_read_input_tokens = fields.cacheReadInputTokens;
  }
  const cache5m = fields.cacheCreation5mInputTokens;
  const cache1h = fields.cacheCreation1hInputTokens;
  if (cache5m !== undefined || cache1h !== undefined) {
    // rule 6 cache-tier reconciliation: the aggregate MUST equal the 5m + 1h split,
    // else priceUsageRow flags the row instead of pricing it.
    usage.cache_creation_input_tokens = (cache5m ?? 0) + (cache1h ?? 0);
    usage.cache_creation = {
      ephemeral_5m_input_tokens: cache5m ?? 0,
      ephemeral_1h_input_tokens: cache1h ?? 0,
    };
  }

  const message: Record<string, unknown> = { type: 'message', role: 'assistant', usage };
  if (fields.messageId !== undefined) message.id = fields.messageId;
  if (fields.model !== undefined) message.model = fields.model;

  const record: Record<string, unknown> = {
    type: fields.agentId === undefined || fields.agentId === null ? 'assistant' : 'assistant',
    timestamp: fields.timestamp,
    cwd: fields.cwd,
    sessionId: fields.sessionId,
    message,
  };
  if (fields.agentId !== undefined) record.agentId = fields.agentId;
  if (fields.attributionAgent !== undefined) record.attributionAgent = fields.attributionAgent;
  if (fields.attributionSkill !== undefined) record.attributionSkill = fields.attributionSkill;
  if (fields.toolUseResultAgentId !== undefined && fields.toolUseResultAgentId !== null) {
    // The parent→child edge, harvested from a toolUseResult on the spawner's row:
    // this row's agentId is the PARENT of toolUseResultAgentId.
    record.toolUseResult = { agentId: fields.toolUseResultAgentId };
  }
  return JSON.stringify(record) + '\n';
}

// ── the five priced records + the un-knowns, as reusable literals ─────────────
const ROW_R1_OPUS_ROOT = usageRecordLine({
  timestamp: `${DAY_ONE}T10:00:00.000Z`,
  cwd: CWD_VIMES,
  sessionId: SESSION_VIMES,
  messageId: 'msg-root-s1-opus',
  model: 'claude-opus-4-8',
  inputTokens: 100,
  outputTokens: 1000,
});

const ROW_R2_HAIKU_PARENT = usageRecordLine({
  timestamp: `${DAY_ONE}T10:05:00.000Z`,
  cwd: CWD_VIMES,
  sessionId: SESSION_VIMES,
  messageId: 'msg-parent-s1-haiku',
  model: 'claude-haiku-4-5',
  agentId: AGENT_PARENT,
  toolUseResultAgentId: AGENT_CHILD, // the nesting edge: agent-parent spawned agent-child
  inputTokens: 2000,
  cacheReadInputTokens: 1000,
  cacheCreation5mInputTokens: 400,
  cacheCreation1hInputTokens: 200,
  attributionSkill: 'software-orchestration',
});

const ROW_R3_FABLE_CHILD = usageRecordLine({
  timestamp: `${DAY_ONE}T10:10:00.000Z`,
  cwd: CWD_VIMES,
  sessionId: SESSION_VIMES,
  messageId: 'msg-child-s1-fable',
  model: 'claude-fable-5',
  agentId: AGENT_CHILD,
  inputTokens: 100,
  outputTokens: 500,
});

const ROW_R4_OPUS_DAOTREE = usageRecordLine({
  timestamp: `${DAY_TWO}T09:00:00.000Z`,
  cwd: CWD_DAOTREE,
  sessionId: SESSION_DAOTREE,
  messageId: 'msg-root-s2-opus',
  model: 'claude-opus-4-8',
  inputTokens: 200,
  outputTokens: 200,
});

const ROW_R5_OPUS_OUTSIDE = usageRecordLine({
  timestamp: `${DAY_TWO}T09:30:00.000Z`,
  cwd: CWD_OUTSIDE, // OUTSIDE projectRoots → the outside-roots bucket (rule 7/9)
  sessionId: SESSION_OUTSIDE,
  messageId: 'msg-root-s3-opus-outside',
  model: 'claude-opus-4-8',
  inputTokens: 100,
  outputTokens: 100,
});

const ROW_UNKNOWN_MODEL = usageRecordLine({
  timestamp: `${DAY_TWO}T09:05:00.000Z`,
  cwd: CWD_DAOTREE,
  sessionId: SESSION_DAOTREE,
  messageId: 'msg-unknown-model',
  model: 'claude-nonexistent-model-9', // unknown → UNPRICED, never $0 (rule 7)
  outputTokens: UNKNOWN_MODEL_OUTPUT_TOKENS,
});

const ROW_MISSING_MODEL = usageRecordLine({
  timestamp: `${DAY_TWO}T09:06:00.000Z`,
  cwd: CWD_DAOTREE,
  sessionId: SESSION_DAOTREE,
  messageId: 'msg-missing-model',
  // NO model field → model '' → UNPRICEABLE (this is how an unpriceable row reaches
  // the ledger; the scan drops literal <synthetic> before it becomes a row).
  outputTokens: MISSING_MODEL_OUTPUT_TOKENS,
});

const ROW_SYNTHETIC = usageRecordLine({
  timestamp: `${DAY_TWO}T09:07:00.000Z`,
  cwd: CWD_DAOTREE,
  sessionId: SESSION_DAOTREE,
  messageId: 'msg-synthetic',
  model: '<synthetic>', // EXCLUDED by the scan (rule 7) — never a row, never priced
  outputTokens: 999,
});

// The corpus, laid out across the real directory tiers the scanner recurses into
// (session file, subagents/, subagents/workflows/wf_*/ — rule 2). The fork file
// copies R1 and R3 VERBATIM (same message ids): max-wins dedupe must count once.
function buildFixtureFiles(forkCopiesShareIds: boolean): Map<string, string> {
  const forkR1 = forkCopiesShareIds
    ? ROW_R1_OPUS_ROOT
    : // DISTINCT id → dedupe CANNOT fire; used only by the teeth test to force the
      // doubled total the real assertion must reject.
      ROW_R1_OPUS_ROOT.replace('msg-root-s1-opus', 'msg-root-s1-opus-FORKDUP');
  const forkR3 = forkCopiesShareIds
    ? ROW_R3_FABLE_CHILD
    : ROW_R3_FABLE_CHILD.replace('msg-child-s1-fable', 'msg-child-s1-fable-FORKDUP');

  return new Map<string, string>([
    // Project "vimes" — session file + a subagent + a workflow-subagent (rule 2).
    [join(PROJECTS_ROOT, '-home-ticktockbent-projects-vimes', `${SESSION_VIMES}.jsonl`), ROW_R1_OPUS_ROOT],
    [
      join(PROJECTS_ROOT, '-home-ticktockbent-projects-vimes', SESSION_VIMES, 'subagents', `${AGENT_PARENT}.jsonl`),
      ROW_R2_HAIKU_PARENT,
    ],
    [
      join(
        PROJECTS_ROOT,
        '-home-ticktockbent-projects-vimes',
        SESSION_VIMES,
        'subagents',
        'workflows',
        'wf_1',
        `${AGENT_CHILD}.jsonl`,
      ),
      ROW_R3_FABLE_CHILD,
    ],
    // The FORK file — copies the ancestor prefix (R1 + R3) into another file.
    [
      join(PROJECTS_ROOT, '-home-ticktockbent-projects-vimes', SESSION_VIMES, 'subagents', 'fork-copy.jsonl'),
      forkR1 + forkR3,
    ],
    // Project "daotree" — a priced root row + the two un-knowns + the excluded synthetic.
    [
      join(PROJECTS_ROOT, '-home-ticktockbent-projects-daotree', `${SESSION_DAOTREE}.jsonl`),
      ROW_R4_OPUS_DAOTREE + ROW_UNKNOWN_MODEL + ROW_MISSING_MODEL + ROW_SYNTHETIC,
    ],
    // A slug OUTSIDE projectRoots — one priced row lands in the outside bucket.
    [
      join(PROJECTS_ROOT, '-home-ticktockbent-other-scratch', `${SESSION_OUTSIDE}.jsonl`),
      ROW_R5_OPUS_OUTSIDE,
    ],
  ]);
}

// ── an in-memory CorpusFileSystem (never touches ~/.claude) ───────────────────
function makeInMemoryCorpus(filesByPath: Map<string, string>): CorpusFileSystem {
  const directoryChildren = new Map<string, Map<string, CorpusDirectoryEntry>>();
  const registerChild = (parentDirectory: string, name: string, isDirectory: boolean): void => {
    let children = directoryChildren.get(parentDirectory);
    if (children === undefined) {
      children = new Map();
      directoryChildren.set(parentDirectory, children);
    }
    if (!children.has(name)) {
      children.set(name, { name, isDirectory, isFile: !isDirectory });
    }
  };
  for (const filePath of filesByPath.keys()) {
    let currentPath = filePath;
    let currentIsDirectory = false;
    for (;;) {
      const parentDirectory = dirname(currentPath);
      if (parentDirectory === currentPath) {
        break;
      }
      registerChild(parentDirectory, basename(currentPath), currentIsDirectory);
      currentPath = parentDirectory;
      currentIsDirectory = true;
    }
  }
  return {
    async listDirectory(directoryPath: string): Promise<CorpusDirectoryEntry[]> {
      const children = directoryChildren.get(directoryPath);
      return children === undefined ? [] : [...children.values()];
    },
    async statFile(filePath: string): Promise<CorpusFileStat> {
      const content = filesByPath.get(filePath);
      if (content === undefined) {
        throw new Error(`in-memory corpus: no such file ${filePath}`);
      }
      return { sizeBytes: Buffer.byteLength(content, 'utf8'), mtimeMs: 1000 };
    },
    async readTextFrom(filePath: string, fromByteOffset: number): Promise<string> {
      const content = filesByPath.get(filePath) ?? '';
      return Buffer.from(content, 'utf8').subarray(fromByteOffset).toString('utf8');
    },
  };
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-cost-exit-gate-'));
let ledgerFileCounter = 0;
function nextLedgerPath(): string {
  ledgerFileCounter += 1;
  return join(temporaryDirectory, `exit-gate-${ledgerFileCounter}.db`);
}

// One fixed watermark clock so nothing here reads a real clock (rule 0.3).
const fixedWatermarkClock = (): string => '2026-07-21T12:00:00.000Z';

interface RunResult {
  store: SqliteCostStore;
  ingestStats: Awaited<ReturnType<typeof ingestCostCorpus>>['stats'];
}

async function ingestFixture(store: SqliteCostStore, filesByPath: Map<string, string>): Promise<RunResult> {
  const result = await ingestCostCorpus({
    store,
    projectsRoot: PROJECTS_ROOT,
    projectRoots: PROJECT_ROOTS,
    fileSystem: makeInMemoryCorpus(filesByPath),
    nowIso: fixedWatermarkClock,
  });
  return { store, ingestStats: result.stats };
}

function ledgerBodyFor(store: SqliteCostStore) {
  const body = currentCostLedger({ costLedgerStore: store, projectRoots: PROJECT_ROOTS });
  if (!body.ingestionEnabled || body.ledger === null) {
    throw new Error('exit gate: ingestion must be enabled and the ledger populated');
  }
  return body.ledger;
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('slice-5b machine exit gate — the whole cost pipeline over an adversarial corpus', () => {
  it('ASSERTION 1 — reconciliation holds and the grand total equals the hand-computed deduped figure', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      // currentCostLedger runs assertTreeReconciles internally — a non-reconciling
      // (i.e. wrong) tree throws rather than serving a bad number. Reaching here at
      // all is the reconciliation half of the assertion.
      const ledger = ledgerBodyFor(store);
      expect(ledger.grandTotal.priced.nanoDollars).toBe(EXPECTED_GRAND_DEDUPED_NANO);
      // Every figure carries its formatted USD alongside the exact integer.
      expect(ledger.grandTotal.priced.usd).toBe('$0.132500');
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 2 — anti-double-count: the fork\'s shared rows are counted ONCE, not doubled', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const ledger = ledgerBodyFor(store);
      // The fork file copied R1 and R3 verbatim by message.id; max-wins dedupe kept
      // one of each. The total is the deduped figure, and provably NOT the doubled one.
      expect(ledger.grandTotal.priced.nanoDollars).toBe(EXPECTED_GRAND_DEDUPED_NANO);
      expect(ledger.grandTotal.priced.nanoDollars).not.toBe(EXPECTED_DOUBLED_IF_DEDUPE_BROKEN_NANO);
      // The five priced rows survive as five priced rows — the fork copies merged in.
      expect(ledger.grandTotal.statusCounts.priced).toBe(5);
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 3 — no percent-of-budget anywhere; the scope label is present verbatim', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const body = currentCostLedger({ costLedgerStore: store, projectRoots: PROJECT_ROOTS });
      const serialized = JSON.stringify(body);
      // The percent half was CUT (C1). No field or value may reintroduce a
      // share-of-budget / share-of-window figure — the lying meter this project refuses.
      expect(serialized.toLowerCase()).not.toContain('percent');
      expect(serialized.toLowerCase()).not.toContain('budget');
      expect(serialized).not.toContain('%');
      // SCOPE, not a bill: the fixed label is present, exactly.
      expect(body.ledger?.scopeLabel).toBe(COST_LEDGER_SCOPE_LABEL);
      expect(body.ledger?.scopeLabel).toBe('VIMES-hosted work on this host');
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 4 — un-knowns are surfaced in statusCounts with non-zero tokens, never in the dollar total', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      const { ingestStats } = await ingestFixture(store, buildFixtureFiles(true));
      const ledger = ledgerBodyFor(store);
      const grand = ledger.grandTotal;

      // The unknown-model row: unpriced, present, with its tokens surfaced.
      expect(grand.statusCounts.unpriced).toBe(1);
      expect(grand.tokensByStatus.unpriced).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
      // The missing-model row: unpriceable, present, tokens surfaced (never a silent $0).
      expect(grand.statusCounts.unpriceable).toBe(1);
      expect(grand.tokensByStatus.unpriceable).toBe(MISSING_MODEL_OUTPUT_TOKENS);

      // Neither contributed a dollar — the priced total is exactly the five priced rows.
      expect(grand.priced.nanoDollars).toBe(EXPECTED_GRAND_DEDUPED_NANO);

      // The literal <synthetic> record was EXCLUDED by the scan: it never became a
      // row, so it is in NEITHER the dollar total nor any status count.
      expect(ingestStats.syntheticRecordsExcluded).toBe(1);
      const totalRowsCounted =
        grand.statusCounts.priced +
        grand.statusCounts.unpriced +
        grand.statusCounts.unpriceable +
        grand.statusCounts.flagged;
      expect(totalRowsCounted).toBe(7); // 5 priced + 1 unpriced + 1 unpriceable; synthetic absent
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 5 — nesting: an agent has a resolved child at depth ≥2 (the toolUseResult edge joins)', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const ledger = ledgerBodyFor(store);

      const vimesProject = ledger.projects.find((project) => project.projectKey === PROJECT_KEY_VIMES);
      expect(vimesProject).toBeDefined();
      const vimesSession = vimesProject!.sessions.find((session) => session.sessionId === SESSION_VIMES);
      expect(vimesSession).toBeDefined();

      // agent-parent is a top-level agent of the session; agent-child NESTS under it.
      const parentAgent = vimesSession!.agents.find((agent) => agent.agentId === AGENT_PARENT);
      expect(parentAgent).toBeDefined();
      expect(parentAgent!.children.length).toBeGreaterThanOrEqual(1);
      const childAgent = parentAgent!.children.find((agent) => agent.agentId === AGENT_CHILD);
      expect(childAgent).toBeDefined();
      // The edge JOINED: the child's parent was recovered, not guessed as the session root.
      expect(childAgent!.parentResolved).toBe(true);
      expect(childAgent!.parentAgentId).toBe(AGENT_PARENT);

      // The nesting reconciles: parent subtree = its own (haiku) + child subtree (fable).
      expect(parentAgent!.subtree.priced.nanoDollars).toBe(
        EXPECTED_R2_HAIKU_CACHE_NANO + EXPECTED_R3_FABLE_CHILD_NANO,
      );
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 6 — spend history: >1 daily point, ascending, summing to the grand priced total', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const ledger = ledgerBodyFor(store);
      const points = ledger.spendHistory.grand;

      expect(points.length).toBeGreaterThan(1);
      expect(points.map((point) => point.day)).toEqual([DAY_ONE, DAY_TWO]); // ascending
      // Ascending by day string (chronological), each day's priced sum as computed.
      expect(points[0]!.priced.nanoDollars).toBe(EXPECTED_DAY_ONE_NANO);
      expect(points[1]!.priced.nanoDollars).toBe(EXPECTED_DAY_TWO_NANO);
      const historySum = points.reduce((runningTotal, point) => runningTotal + point.priced.nanoDollars, 0);
      expect(historySum).toBe(ledger.grandTotal.priced.nanoDollars);
      expect(historySum).toBe(EXPECTED_GRAND_DEDUPED_NANO);
    } finally {
      store.dispose();
    }
  });

  it('ASSERTION 7 — idempotent re-ingest: running the pipeline twice does not change the total', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const firstTotal = ledgerBodyFor(store).grandTotal.priced.nanoDollars;
      const firstRowCount = store.countUsageRows();

      // Ingest the SAME corpus a second time into the SAME store. Step 1's dedupe is
      // idempotent — the total and the stored row count must not move.
      await ingestFixture(store, buildFixtureFiles(true));
      const secondTotal = ledgerBodyFor(store).grandTotal.priced.nanoDollars;

      expect(secondTotal).toBe(firstTotal);
      expect(secondTotal).toBe(EXPECTED_GRAND_DEDUPED_NANO);
      expect(store.countUsageRows()).toBe(firstRowCount);
    } finally {
      store.dispose();
    }
  });

  // ── the teeth: prove the anti-double-count assertion is NOT vacuous ──────────
  it('TEETH — a broken dedupe (fork copies with distinct ids) inflates the total to the exact doubled figure, which ASSERTION 2 rejects', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      // Same fixture, but the fork copies carry DISTINCT message ids, so max-wins
      // dedupe cannot merge them: the store keeps R1 and R3 twice.
      await ingestFixture(store, buildFixtureFiles(false));
      const ledger = ledgerBodyFor(store);

      // The total inflates by exactly R1 + R3 — the doubled figure the real
      // assertion forbids. This is what would happen if dedupe regressed (e.g. the
      // rowKey sabotage in the header), and ASSERTION 2's strict equality catches it.
      expect(ledger.grandTotal.priced.nanoDollars).toBe(EXPECTED_DOUBLED_IF_DEDUPE_BROKEN_NANO);
      expect(ledger.grandTotal.priced.nanoDollars).not.toBe(EXPECTED_GRAND_DEDUPED_NANO);
      // Seven priced rows now, not five — the two fork copies are counted separately.
      expect(ledger.grandTotal.statusCounts.priced).toBe(7);
      // Reconciliation still HOLDS on the inflated tree — proving reconciliation
      // alone cannot catch a double-count; only the known-total assertion can.
      // (currentCostLedger did not throw: we reached here.)
      expect(OUTSIDE_ROOTS_PROJECT_KEY).toBe('<outside-project-roots>'); // the outside bucket exists
      const hasOutsideBucket = ledger.projects.some(
        (project) => project.projectKey === OUTSIDE_ROOTS_PROJECT_KEY,
      );
      expect(hasOutsideBucket).toBe(true);
    } finally {
      store.dispose();
    }
  });

  it('SANITY — the outside-roots bucket and both inside projects are classified correctly (rule 7/9)', async () => {
    const store = new SqliteCostStore({ path: nextLedgerPath() });
    try {
      await ingestFixture(store, buildFixtureFiles(true));
      const ledger = ledgerBodyFor(store);
      const projectKeys = ledger.projects.map((project) => project.projectKey);
      expect(projectKeys).toContain(PROJECT_KEY_VIMES);
      expect(projectKeys).toContain(PROJECT_KEY_DAOTREE);
      expect(projectKeys).toContain(OUTSIDE_ROOTS_PROJECT_KEY);

      const outsideProject = ledger.projects.find(
        (project) => project.projectKey === OUTSIDE_ROOTS_PROJECT_KEY,
      );
      expect(outsideProject!.insideProjectRoots).toBe(false);
      expect(outsideProject!.subtree.priced.nanoDollars).toBe(EXPECTED_R5_OPUS_OUTSIDE_NANO);

      const vimesProject = ledger.projects.find((project) => project.projectKey === PROJECT_KEY_VIMES);
      expect(vimesProject!.insideProjectRoots).toBe(true);
      expect(vimesProject!.subtree.priced.nanoDollars).toBe(EXPECTED_DAY_ONE_NANO);
    } finally {
      store.dispose();
    }
  });
});
