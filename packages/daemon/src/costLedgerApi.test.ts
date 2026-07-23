import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SteppingClock, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { CorpusDirectoryEntry, CorpusFileStat, CorpusFileSystem, CostUsageRow } from './costCorpus.js';
import { SqliteCostStore } from './sqliteCostStore.js';

// ─── slice 5b step 4a — the /api/cost/ledger endpoint (integration) ───────────
//
// Every test injects a temp-file ledger store and an EMPTY corpus filesystem, so
// no test reads ~/.claude and none touches the real ledger db. The store is
// seeded directly (upsertUsageRows) so the served body is a function of known
// rows, not of a live scan.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-cost-api-'));
let fileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const rejectingVerifier: AccessVerifier = {
  verify: async () => ({ ok: false, reason: 'invalid-token' }),
};
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

// A corpus that lists nothing — the daemon's boot ingest scan finds no files, so
// only the rows a test seeds directly into the store are ever served.
const emptyCorpusFileSystem: CorpusFileSystem = {
  async listDirectory(): Promise<CorpusDirectoryEntry[]> {
    return [];
  },
  async statFile(): Promise<CorpusFileStat> {
    throw new Error('empty corpus: no files');
  },
  async readTextFrom(): Promise<string> {
    return '';
  },
};

function nextPath(prefix: string): string {
  fileCounter += 1;
  return join(temporaryDirectory, `${prefix}-${fileCounter}.db`);
}

// A complete CostUsageRow. Defaults price to a known Opus row; overrides tailor
// attribution / model / timestamp per case.
function costRow(overrides: Partial<CostUsageRow> = {}): CostUsageRow {
  const rowKey = overrides.rowKey ?? `msg:${randomUUID()}`;
  return {
    rowKey,
    messageId: rowKey,
    undedupable: false,
    timestamp: '2026-07-21T12:00:00.000Z',
    model: 'claude-opus-4-8',
    projectSlug: '-home-ticktockbent-projects-alpha',
    projectCwd: '/home/ticktockbent/projects/alpha',
    insideProjectRoots: true,
    sessionId: 'session-1',
    agentId: null,
    attributionAgent: null,
    attributionSkill: null,
    isSidechain: null,
    requestId: null,
    toolUseResultAgentId: null,
    sourcePath: '/fake/session-1.jsonl',
    sourceKind: 'session',
    speed: null,
    serviceTier: null,
    inferenceGeo: null,
    inputTokens: 1_000,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    settledScore: 1_000,
    ...overrides,
  };
}

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  fileCounter += 1;
  return {
    port: 0,
    hookPort: 0,
    dbPath: join(temporaryDirectory, `events-${fileCounter}.db`),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    expectedSdkCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: ['/home/ticktockbent/projects'],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    // The stage-run watchdog (slice 6 step 5b): DISABLED in tests — 0 means the
    // daemon never creates the timer, so no test daemon can wake up and write
    // attention/notifications behind a case's back. The policy values are inert
    // while the interval is 0.
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    // Worker isolation (slice 6 step 8): OFF in tests, which is also the shipped
    // default — so no test daemon can create a worktree, and this root is never
    // touched. The flip is a human's; see taskDispatcher.ts's isolation block.
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
    ...overrides,
  };
}

interface StartOptions {
  config: DaemonConfig;
  verifier?: AccessVerifier;
  costLedgerStore?: SqliteCostStore;
}

async function startDaemon(options: StartOptions): Promise<Daemon> {
  const daemon = createDaemon({
    config: options.config,
    clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: options.verifier ?? permissiveVerifier,
    costLedgerPath: nextPath('cost-ledger'),
    costCorpusFileSystem: emptyCorpusFileSystem,
    costLedgerStore: options.costLedgerStore,
  });
  await daemon.start();
  return daemon;
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('GET /api/cost/ledger', () => {
  it('enabled + seeded rows → serves the priced body behind auth', async () => {
    const store = new SqliteCostStore({ path: nextPath('seed') });
    store.upsertUsageRows([
      costRow({ rowKey: 'msg:a', timestamp: '2026-07-20T10:00:00.000Z' }),
      costRow({ rowKey: 'msg:b', timestamp: '2026-07-21T10:00:00.000Z' }),
    ]);
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerStore: store,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/cost/ledger`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ingestionEnabled).toBe(true);
      expect(body.ledger.scopeLabel).toBe('VIMES-hosted work on this host');
      // Two priced Opus rows of 1_000 input tokens each → nonzero, and the USD is
      // formatted alongside the exact nano integer.
      expect(body.ledger.grandTotal.priced.nanoDollars).toBeGreaterThan(0);
      expect(typeof body.ledger.grandTotal.priced.usd).toBe('string');
      expect(body.ledger.grandTotal.statusCounts.priced).toBe(2);
      // Two distinct days → two grand history points.
      expect(body.ledger.spendHistory.grand.map((point: { day: string }) => point.day)).toEqual([
        '2026-07-20',
        '2026-07-21',
      ]);
      // One project (alpha).
      expect(body.ledger.projects).toHaveLength(1);
      expect(body.ledger.projects[0].projectKey).toBe('/home/ticktockbent/projects/alpha');
    } finally {
      await daemon.stop();
    }
  });

  it('is behind the auth wall — a rejected token gets 401, never the body', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      verifier: rejectingVerifier,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/cost/ledger`);
      expect(response.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('disabled ingestion (interval 0) → { ingestionEnabled: false, ledger: null }, not a crash', async () => {
    const daemon = await startDaemon({ config: buildConfig({ costIngestIntervalMs: 0 }) });
    try {
      // The in-process view.
      expect(daemon.costLedger()).toEqual({ ingestionEnabled: false, ledger: null });
      // And over HTTP.
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/cost/ledger`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ingestionEnabled: false, ledger: null });
    } finally {
      await daemon.stop();
    }
  });

  it('a reconciliation finding surfaces as HTTP 500, never a wrong 200', async () => {
    // buildCostTree always reconciles by construction, so the only way a finding
    // reaches the route in production is a genuine builder bug. We simulate that
    // throw at the store boundary — the route's guard is identical regardless of
    // which line throws — and prove it becomes a 500 carrying the finding, not a
    // 200 with a fabricated number.
    const store = new SqliteCostStore({ path: nextPath('throwing') });
    (store as unknown as { readUsageRows: () => never }).readUsageRows = () => {
      throw new Error('cost-tree reconciliation FAILED (rule 0.1 finding): simulated');
    };
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerStore: store,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/cost/ledger`);
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('reconciliation FAILED');
    } finally {
      await daemon.stop();
    }
  });
});
