import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupeUsageRowsGlobally,
  scanCostCorpus,
  type CorpusFileSystem,
  type CostCorpusFileProgress,
  type CostUsageRow,
} from './costCorpus.js';
import { SqliteCostStore } from './sqliteCostStore.js';
import { ingestCostCorpus } from './costIngest.js';

// ─── slice 5b step 1 — the ten binding data rules, as tests ──────────────────
//
// Fixtures are synthetic and live in a temp dir. NOTHING here reads ~/.claude:
// the real-corpus integration check is run out of band (it is nondeterministic by
// construction — the corpus grows).

const temporaryDirectories: string[] = [];

function makeTemporaryCorpus(): { projectsRoot: string; projectRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'vimes-cost-corpus-'));
  temporaryDirectories.push(base);
  const projectsRoot = join(base, 'claude-projects');
  const projectRoot = join(base, 'projects');
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { projectsRoot, projectRoot };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

interface UsageLineOptions {
  messageId?: string | null;
  model?: string;
  cwd?: string;
  sessionId?: string;
  agentId?: string;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
  // `undefined` = the key is ABSENT from the JSON entirely (rule 8's case).
  speed?: string | null;
  serviceTier?: string | null;
  attributionAgent?: string;
  attributionSkill?: string;
  isSidechain?: boolean;
  requestId?: string;
  toolUseResultAgentId?: string;
  // Deliberately inconsistent with the top-level fields so rule 4 can be tested:
  // if anything sums iterations[], the total moves.
  iterationsOutputTokens?: number;
}

function usageLine(options: UsageLineOptions): string {
  const usage: Record<string, unknown> = {
    input_tokens: options.inputTokens ?? 0,
    output_tokens: options.outputTokens ?? 0,
    cache_read_input_tokens: options.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: options.cacheCreationInputTokens ?? 0,
    cache_creation: {
      ephemeral_5m_input_tokens: options.cacheCreation5m ?? 0,
      ephemeral_1h_input_tokens: options.cacheCreation1h ?? 0,
    },
  };
  if (options.speed !== undefined) {
    usage.speed = options.speed;
  }
  if (options.serviceTier !== undefined) {
    usage.service_tier = options.serviceTier;
  }
  if (options.iterationsOutputTokens !== undefined) {
    usage.iterations = [{ type: 'message', output_tokens: options.iterationsOutputTokens }];
  }
  const message: Record<string, unknown> = {
    model: options.model ?? 'claude-opus-4-8',
    type: 'message',
    role: 'assistant',
    usage,
  };
  if (options.messageId !== null) {
    message.id = options.messageId ?? 'msg_default';
  }
  const record: Record<string, unknown> = {
    type: 'assistant',
    timestamp: options.timestamp ?? '2026-07-21T12:00:00.000Z',
    cwd: options.cwd ?? '/nowhere',
    sessionId: options.sessionId ?? 'session-1',
    message,
  };
  if (options.agentId !== undefined) {
    record.agentId = options.agentId;
  }
  if (options.attributionAgent !== undefined) {
    record.attributionAgent = options.attributionAgent;
  }
  if (options.attributionSkill !== undefined) {
    record.attributionSkill = options.attributionSkill;
  }
  if (options.isSidechain !== undefined) {
    record.isSidechain = options.isSidechain;
  }
  if (options.requestId !== undefined) {
    record.requestId = options.requestId;
  }
  if (options.toolUseResultAgentId !== undefined) {
    record.toolUseResult = { agentId: options.toolUseResultAgentId };
  }
  return JSON.stringify(record) + '\n';
}

function writeTranscript(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, lines.join(''), 'utf8');
}

function totalOutputTokens(rows: readonly CostUsageRow[]): number {
  return rows.reduce((runningTotal, row) => runningTotal + row.outputTokens, 0);
}

function totalAllTokens(rows: readonly CostUsageRow[]): number {
  return rows.reduce(
    (runningTotal, row) =>
      runningTotal +
      row.inputTokens +
      row.outputTokens +
      row.cacheReadInputTokens +
      row.cacheCreationInputTokens,
    0,
  );
}

describe('rule 1 — dedupe by message.id takes the ELEMENTWISE MAX', () => {
  it('THE HEADLINE: a progressive-snapshot message reports 455, not 5 and not 465', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    // The exact shape from the D17 finding: output_tokens [5, 5, 455] under ONE id.
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_progressive', outputTokens: 5, cwd: projectRoot }),
      usageLine({ messageId: 'msg_progressive', outputTokens: 5, cwd: projectRoot }),
      usageLine({ messageId: 'msg_progressive', outputTokens: 455, cwd: projectRoot }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    // First-wins would read 5 — the raw rows prove the trap is present.
    expect(scan.rows).toHaveLength(3);
    expect(scan.rows[0]!.outputTokens).toBe(5);

    const deduped = dedupeUsageRowsGlobally(scan.rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.outputTokens).toBe(455); // max, not first (5), not sum (465)
  });

  it('maxes each token field independently, so a partial snapshot never lowers a total', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({
        messageId: 'msg_mixed',
        outputTokens: 400,
        cacheReadInputTokens: 10,
        cwd: projectRoot,
      }),
      usageLine({
        messageId: 'msg_mixed',
        outputTokens: 12,
        cacheReadInputTokens: 90_000,
        cwd: projectRoot,
      }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    const [merged] = dedupeUsageRowsGlobally(scan.rows);
    expect(merged!.outputTokens).toBe(400);
    expect(merged!.cacheReadInputTokens).toBe(90_000);
  });
});

describe('rule 2 — the walk is RECURSIVE, including subagents/workflows/wf_*/', () => {
  it('finds flat subagents AND workflow subagents, and labels each source kind', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const slugDirectory = join(projectsRoot, '-slug');
    writeTranscript(join(slugDirectory, 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_parent', outputTokens: 1, cwd: projectRoot }),
    ]);
    writeTranscript(join(slugDirectory, 'session-1', 'subagents', 'agent-aaa.jsonl'), [
      usageLine({ messageId: 'msg_flat_agent', outputTokens: 2, cwd: projectRoot }),
    ]);
    writeTranscript(
      join(slugDirectory, 'session-1', 'subagents', 'workflows', 'wf_1', 'agent-bbb.jsonl'),
      [usageLine({ messageId: 'msg_workflow_agent', outputTokens: 4, cwd: projectRoot })],
    );

    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.stats.jsonlFilesFound).toBe(3);
    const kindByMessageId = new Map(scan.rows.map((row) => [row.messageId, row.sourceKind]));
    expect(kindByMessageId.get('msg_parent')).toBe('session');
    expect(kindByMessageId.get('msg_flat_agent')).toBe('subagent');
    expect(kindByMessageId.get('msg_workflow_agent')).toBe('workflow-subagent');
    // A non-recursive glob would report 1 and miss 6 of the 7 output tokens.
    expect(totalOutputTokens(scan.rows)).toBe(7);
  });
});

describe('rule 3 — usage rows with no message.id are KEPT and marked undedupable', () => {
  it('counts them, keeps them, never merges them, and keys them idempotently', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: null, outputTokens: 11, cwd: projectRoot }),
      usageLine({ messageId: null, outputTokens: 13, cwd: projectRoot }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.stats.usageRecordsWithoutMessageId).toBe(2);
    expect(scan.rows.every((row) => row.undedupable && row.messageId === null)).toBe(true);
    // Two identical-looking rows must NOT collapse into one — they are real spend.
    const deduped = dedupeUsageRowsGlobally(scan.rows);
    expect(deduped).toHaveLength(2);
    expect(totalOutputTokens(deduped)).toBe(24);
    // Their keys are byte-offset based, so a second scan produces the same keys.
    const rescan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(rescan.rows.map((row) => row.rowKey)).toEqual(scan.rows.map((row) => row.rowKey));
  });
});

describe('rule 4 — usage.iterations[] is already rolled into the top-level fields', () => {
  it('never sums iterations into the total', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({
        messageId: 'msg_iterations',
        outputTokens: 484,
        iterationsOutputTokens: 484,
        cwd: projectRoot,
      }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(totalOutputTokens(scan.rows)).toBe(484); // not 968
  });
});

describe('rule 5 — forks and ancestor prefixes must not double-count (GLOBAL dedupe)', () => {
  it('a fork copying the spawner prefix adds only its own new spend', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const slugDirectory = join(projectsRoot, '-slug');
    const ancestorPrefix = [
      usageLine({ messageId: 'msg_a', outputTokens: 100, cwd: projectRoot, sessionId: 'spawner' }),
      usageLine({ messageId: 'msg_b', outputTokens: 200, cwd: projectRoot, sessionId: 'spawner' }),
    ];
    writeTranscript(join(slugDirectory, 'spawner.jsonl'), ancestorPrefix);
    // subagent_type: 'fork' copies the spawner's usage rows verbatim…
    writeTranscript(join(slugDirectory, 'spawner', 'subagents', 'agent-fork.jsonl'), [
      ...ancestorPrefix,
      usageLine({ messageId: 'msg_fork_own', outputTokens: 50, cwd: projectRoot }),
    ]);
    // …and a forked/compacted SESSION copies the whole ancestor prefix into a
    // sibling session file — 394 ids were observed in more than one session file.
    writeTranscript(join(slugDirectory, 'forked-session.jsonl'), [
      ...ancestorPrefix,
      usageLine({ messageId: 'msg_forked_session_own', outputTokens: 7, cwd: projectRoot }),
    ]);

    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    // Per-FILE dedupe would bank the inflation: 300 + 350 + 307 = 957.
    expect(totalOutputTokens(scan.rows)).toBe(957);
    const deduped = dedupeUsageRowsGlobally(scan.rows);
    expect(deduped).toHaveLength(4);
    expect(totalOutputTokens(deduped)).toBe(357); // 100 + 200 + 50 + 7, each once
  });

  it('the store deduplicates globally too, so ingest order cannot inflate a rollup', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const slugDirectory = join(projectsRoot, '-slug');
    writeTranscript(join(slugDirectory, 'spawner.jsonl'), [
      usageLine({ messageId: 'msg_shared', outputTokens: 100, cwd: projectRoot }),
    ]);
    writeTranscript(join(slugDirectory, 'spawner', 'subagents', 'agent-fork.jsonl'), [
      usageLine({ messageId: 'msg_shared', outputTokens: 100, cwd: projectRoot }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      expect(store.countUsageRows()).toBe(1);
      expect(totalOutputTokens(store.readUsageRows())).toBe(100);
    } finally {
      store.dispose();
    }
  });
});

describe('rule 6 — <synthetic> is excluded as unpriceable; an unknown model is preserved', () => {
  it('drops <synthetic>, counts it, and carries an unrecognised model string through intact', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_synthetic', model: '<synthetic>', cwd: projectRoot }),
      usageLine({
        messageId: 'msg_future',
        model: 'claude-not-yet-released-9',
        outputTokens: 3,
        cwd: projectRoot,
      }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.stats.syntheticRecordsExcluded).toBe(1);
    expect(scan.rows).toHaveLength(1);
    expect(scan.rows[0]!.model).toBe('claude-not-yet-released-9');
    expect(scan.rows.some((row) => row.model === '<synthetic>')).toBe(false);
  });
});

describe('rule 7 — slugs are not projects; outside-roots rows go in a labelled bucket', () => {
  it('classifies against projectRoots using the record cwd and RETAINS outside rows', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-home-ticktockbent', 'session-outside.jsonl'), [
      usageLine({ messageId: 'msg_outside', outputTokens: 9, cwd: '/home/ticktockbent' }),
    ]);
    writeTranscript(join(projectsRoot, '-home-ticktockbent-projects-x', 'session-inside.jsonl'), [
      usageLine({ messageId: 'msg_inside', outputTokens: 5, cwd: join(projectRoot, 'x') }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.stats.rowsOutsideProjectRoots).toBe(1);
    const rowsByMessageId = new Map(scan.rows.map((row) => [row.messageId, row]));
    expect(rowsByMessageId.get('msg_outside')!.insideProjectRoots).toBe(false);
    expect(rowsByMessageId.get('msg_outside')!.projectSlug).toBe('-home-ticktockbent');
    expect(rowsByMessageId.get('msg_inside')!.insideProjectRoots).toBe(true);
    // Retained, never discarded — the bucket is a label, not a filter.
    expect(totalOutputTokens(scan.rows)).toBe(14);
  });

  it('a sibling directory that merely shares a prefix is NOT inside the root', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_prefix', cwd: `${projectRoot}-elsewhere`, outputTokens: 1 }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.rows[0]!.insideProjectRoots).toBe(false);
  });
});

describe('rule 8 — speed / service_tier / inference_geo: ABSENT is not "standard"', () => {
  it('carries an absent field through as null and never defaults it', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      // speed omitted entirely (observed in SPIKE C2)
      usageLine({ messageId: 'msg_no_speed', cwd: projectRoot, outputTokens: 1 }),
      // and the explicit-null form the CLI writes on some records
      usageLine({
        messageId: 'msg_null_speed',
        cwd: projectRoot,
        outputTokens: 1,
        speed: null,
        serviceTier: null,
      }),
      usageLine({
        messageId: 'msg_with_speed',
        cwd: projectRoot,
        outputTokens: 1,
        speed: 'standard',
        serviceTier: 'standard',
      }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    const rowsByMessageId = new Map(scan.rows.map((row) => [row.messageId, row]));
    expect(rowsByMessageId.get('msg_no_speed')!.speed).toBeNull();
    expect(rowsByMessageId.get('msg_null_speed')!.speed).toBeNull();
    expect(rowsByMessageId.get('msg_null_speed')!.serviceTier).toBeNull();
    expect(rowsByMessageId.get('msg_with_speed')!.speed).toBe('standard');
  });

  it('a null speed survives the round trip through the durable store', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_no_speed', cwd: projectRoot, outputTokens: 1 }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      expect(store.readUsageRows()[0]!.speed).toBeNull();
      expect(store.readUsageRows()[0]!.inferenceGeo).toBeNull();
    } finally {
      store.dispose();
    }
  });
});

describe('rules 9 + 10 — timestamps and per-message model, plus the carried join keys', () => {
  it('stores the model on the ROW, so one agent file may mix models', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1', 'subagents', 'agent-a.jsonl'), [
      usageLine({ messageId: 'msg_1', model: 'claude-opus-4-8', cwd: projectRoot }),
      usageLine({ messageId: 'msg_2', model: 'claude-sonnet-5', cwd: projectRoot }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.rows.map((row) => row.model)).toEqual(['claude-opus-4-8', 'claude-sonnet-5']);
  });

  it('carries timestamps and every field the tree will need in step 3', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1', 'subagents', 'agent-a.jsonl'), [
      usageLine({
        messageId: 'msg_rich',
        cwd: projectRoot,
        timestamp: '2026-07-21T09:08:07.006Z',
        sessionId: 'session-1',
        agentId: 'a7115147bd4c58d44',
        attributionAgent: 'general-purpose',
        attributionSkill: 'software-orchestration',
        isSidechain: true,
        requestId: 'req_011Cd',
        toolUseResultAgentId: 'parent-agent-id',
      }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    const row = scan.rows[0]!;
    expect(row.timestamp).toBe('2026-07-21T09:08:07.006Z');
    expect(row.sessionId).toBe('session-1');
    expect(row.agentId).toBe('a7115147bd4c58d44');
    expect(row.attributionAgent).toBe('general-purpose');
    expect(row.attributionSkill).toBe('software-orchestration');
    expect(row.isSidechain).toBe(true);
    expect(row.requestId).toBe('req_011Cd');
    expect(row.toolUseResultAgentId).toBe('parent-agent-id');
    expect(row.projectSlug).toBe('-slug');
  });
});

describe('the durable store — idempotent, incremental, and max-preserving', () => {
  it('re-ingesting the same corpus changes nothing', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_a', outputTokens: 5, cwd: projectRoot }),
      usageLine({ messageId: 'msg_a', outputTokens: 455, cwd: projectRoot }),
      usageLine({ messageId: 'msg_b', outputTokens: 20, cwd: projectRoot }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      const first = await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      expect(first.storedRowCount).toBe(2);
      expect(totalOutputTokens(store.readUsageRows())).toBe(475);

      const second = await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:05:00.000Z',
      });
      // Nothing changed on disk, so the file is skipped entirely…
      expect(second.stats.filesSkippedUnchanged).toBe(1);
      expect(second.stats.filesRead).toBe(0);
      // …and neither the row count nor the max-wins result moved.
      expect(store.countUsageRows()).toBe(2);
      expect(totalOutputTokens(store.readUsageRows())).toBe(475);
      expect(store.watermark()).toBe('2026-07-21T12:05:00.000Z');
    } finally {
      store.dispose();
    }
  });

  it('a second ingest that first sees only the partial snapshot still settles to the MAX', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const transcriptPath = join(projectsRoot, '-slug', 'session-1.jsonl');
    writeTranscript(transcriptPath, [
      usageLine({ messageId: 'msg_progressive', outputTokens: 5, cwd: projectRoot }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      expect(store.readUsageRows()[0]!.outputTokens).toBe(5);

      // The settled record lands in a LATER run — the SQL upsert must raise, not
      // ignore (an INSERT OR IGNORE store would keep the 5 forever).
      appendFileSync(
        transcriptPath,
        usageLine({ messageId: 'msg_progressive', outputTokens: 455, cwd: projectRoot }),
      );
      const second = await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:05:00.000Z',
      });
      expect(second.stats.filesRead).toBe(1);
      expect(store.countUsageRows()).toBe(1);
      expect(store.readUsageRows()[0]!.outputTokens).toBe(455);
    } finally {
      store.dispose();
    }
  });

  it('an incremental re-scan reads only the appended tail, and totals stay right', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const transcriptPath = join(projectsRoot, '-slug', 'session-1.jsonl');
    writeTranscript(transcriptPath, [
      usageLine({ messageId: 'msg_a', outputTokens: 10, cwd: projectRoot }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      appendFileSync(
        transcriptPath,
        usageLine({ messageId: 'msg_b', outputTokens: 20, cwd: projectRoot }),
      );
      const second = await ingestCostCorpus({
        store,
        projectsRoot,
        projectRoots: [projectRoot],
        nowIso: () => '2026-07-21T12:05:00.000Z',
      });
      // Only the appended record was parsed — not the whole file again.
      expect(second.rowsUpserted).toBe(1);
      expect(store.countUsageRows()).toBe(2);
      expect(totalAllTokens(store.readUsageRows())).toBe(30);
    } finally {
      store.dispose();
    }
  });

  it('records a watermark and a schema version', async () => {
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      expect(store.watermark()).toBeNull();
      expect(store.schemaVersion()).toBe(1);
      store.setWatermark('2026-07-21T12:00:00.000Z');
      expect(store.watermark()).toBe('2026-07-21T12:00:00.000Z');
    } finally {
      store.dispose();
    }
  });
});

// ── a file that GROWS mid-scan ───────────────────────────────────────────────
// The D27 survey noted the active session's file grows while it is being read.
// A fake filesystem makes the race deterministic: stat reports the pre-growth
// size, and the read returns extra bytes ending in a HALF-WRITTEN record.
describe('a transcript that grows while it is being read', () => {
  const growingFilePath = '/fake/projects/-slug/session-1.jsonl';

  function makeGrowingFileSystem(state: {
    statSizeBytes: number;
    mtimeMs: number;
    contentAtReadTime: string;
  }): CorpusFileSystem {
    return {
      async listDirectory(directoryPath: string): Promise<
        Array<{ name: string; isDirectory: boolean; isFile: boolean }>
      > {
        if (directoryPath === '/fake/projects') {
          return [{ name: '-slug', isDirectory: true, isFile: false }];
        }
        if (directoryPath === '/fake/projects/-slug') {
          return [{ name: 'session-1.jsonl', isDirectory: false, isFile: true }];
        }
        return [];
      },
      async statFile(): Promise<{ sizeBytes: number; mtimeMs: number }> {
        return { sizeBytes: state.statSizeBytes, mtimeMs: state.mtimeMs };
      },
      async readTextFrom(_filePath: string, fromByteOffset: number): Promise<string> {
        return Buffer.from(state.contentAtReadTime, 'utf8').subarray(fromByteOffset).toString('utf8');
      },
    };
  }

  it('consumes only whole lines, never parses the fragment, and picks it up next scan', async () => {
    const settledLine = usageLine({ messageId: 'msg_a', outputTokens: 10, cwd: '/fake/root' });
    const appendedLine = usageLine({ messageId: 'msg_b', outputTokens: 20, cwd: '/fake/root' });
    const halfWrittenLine = appendedLine.slice(0, 40); // no trailing newline: mid-write

    const state = {
      // stat ran BEFORE the growth, so it under-reports.
      statSizeBytes: Buffer.byteLength(settledLine, 'utf8'),
      mtimeMs: 1000,
      contentAtReadTime: settledLine + appendedLine + halfWrittenLine,
    };
    const fileSystem = makeGrowingFileSystem(state);

    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      const first = await ingestCostCorpus({
        store,
        projectsRoot: '/fake/projects',
        projectRoots: ['/fake/root'],
        fileSystem,
        nowIso: () => '2026-07-21T12:00:00.000Z',
      });
      // The fragment was NOT parsed as a record and did NOT count as malformed…
      expect(first.stats.malformedLines).toBe(0);
      expect(first.stats.filesWithPartialTrailingLine).toBe(1);
      // …and both COMPLETE records landed, including the one that arrived after stat.
      expect(store.countUsageRows()).toBe(2);
      expect(totalOutputTokens(store.readUsageRows())).toBe(30);
      const progress = store.fileProgress().get(growingFilePath)!;
      // consumedBytes ran PAST the stat size, so the skip check cannot fire.
      expect(progress.consumedBytes).toBeGreaterThan(progress.observedSizeBytes);

      // Next scan: the record finished being written.
      state.contentAtReadTime = settledLine + appendedLine + appendedLine.replace('msg_b', 'msg_c');
      state.statSizeBytes = Buffer.byteLength(state.contentAtReadTime, 'utf8');
      state.mtimeMs = 2000;
      const second = await ingestCostCorpus({
        store,
        projectsRoot: '/fake/projects',
        projectRoots: ['/fake/root'],
        fileSystem,
        nowIso: () => '2026-07-21T12:05:00.000Z',
      });
      expect(second.stats.filesSkippedUnchanged).toBe(0);
      expect(store.countUsageRows()).toBe(3);
      // 10 + 20 + 20 — counted once each, no corruption from the interrupted read.
      expect(totalOutputTokens(store.readUsageRows())).toBe(50);
    } finally {
      store.dispose();
    }
  });
});

describe('robustness of the walk', () => {
  it('ignores malformed lines and non-usage records without failing the scan', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      '{not json at all\n',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      usageLine({ messageId: 'msg_ok', outputTokens: 3, cwd: projectRoot }),
    ]);
    const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(scan.stats.malformedLines).toBe(1);
    expect(scan.rows).toHaveLength(1);
  });

  it('returns an empty result when the projects root does not exist', async () => {
    const scan = await scanCostCorpus({
      projectsRoot: join(tmpdir(), 'vimes-cost-corpus-does-not-exist'),
      projectRoots: [],
    });
    expect(scan.rows).toHaveLength(0);
    expect(scan.stats.jsonlFilesFound).toBe(0);
  });

  it('scan order is stable, so merge tie-breaks are deterministic', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    const slugDirectory = join(projectsRoot, '-slug');
    writeTranscript(join(slugDirectory, 'b-session.jsonl'), [
      usageLine({ messageId: 'msg_b', cwd: projectRoot }),
    ]);
    writeTranscript(join(slugDirectory, 'a-session.jsonl'), [
      usageLine({ messageId: 'msg_a', cwd: projectRoot }),
    ]);
    const firstScan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    const secondScan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
    expect(firstScan.rows.map((row) => row.rowKey)).toEqual(['msg:msg_a', 'msg:msg_b']);
    expect(secondScan.rows.map((row) => row.rowKey)).toEqual(firstScan.rows.map((r) => r.rowKey));
  });
});

describe('file progress bookkeeping', () => {
  it('round-trips through the store keyed on (path, size, mtime, consumed)', async () => {
    const { projectsRoot, projectRoot } = makeTemporaryCorpus();
    writeTranscript(join(projectsRoot, '-slug', 'session-1.jsonl'), [
      usageLine({ messageId: 'msg_a', cwd: projectRoot }),
    ]);
    const store = new SqliteCostStore({ path: ':memory:' });
    try {
      const scan = await scanCostCorpus({ projectsRoot, projectRoots: [projectRoot] });
      store.recordFileProgress(scan.fileProgress);
      const stored = store.fileProgress();
      expect(stored.size).toBe(1);
      const entry: CostCorpusFileProgress = stored.get(scan.fileProgress[0]!.path)!;
      expect(entry.consumedBytes).toBe(scan.fileProgress[0]!.consumedBytes);
      expect(entry.observedMtimeMs).toBe(scan.fileProgress[0]!.observedMtimeMs);
    } finally {
      store.dispose();
    }
  });
});
