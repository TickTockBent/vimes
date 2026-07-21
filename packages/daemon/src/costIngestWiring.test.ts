import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SteppingClock, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type {
  CorpusDirectoryEntry,
  CorpusFileStat,
  CorpusFileSystem,
} from './costCorpus.js';
import { SqliteCostStore } from './sqliteCostStore.js';
import { defaultCostProjectsRoot } from './costIngest.js';

// ─── slice 5b — the cost ingester wired into the live daemon ─────────────────
//
// Every test injects a SYNTHETIC CorpusFileSystem and a temp-file ledger path:
// no test reads ~/.claude and no test writes the real cost-ledger db. The usage
// poller is left disabled (usagePollIntervalMs: 0) so nothing reaches the
// network here either.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-cost-wiring-'));
let ledgerFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

// Records land under the REAL default projects root the daemon scans when no
// projectsRoot override is passed — the injected fake filesystem answers for
// that path in memory, so the real directory is never touched.
const FAKE_PROJECTS_ROOT = defaultCostProjectsRoot();

function nextLedgerPath(): string {
  ledgerFileCounter += 1;
  return join(temporaryDirectory, `cost-ledger-${ledgerFileCounter}.db`);
}

// A minimal transcript record carrying a priced message.usage and a message.id.
function usageRecordLine(messageId: string, outputTokens: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-21T12:00:00.000Z',
      cwd: '/fake/root',
      sessionId: 'session-1',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { output_tokens: outputTokens },
      },
    }) + '\n'
  );
}

// An in-memory CorpusFileSystem built from an absolute-path → content map. Every
// ancestor directory of every file is registered so the recursive walk resolves
// entirely from memory. `scanCount` counts full scans (one listDirectory of the
// projects root per scan) so a test can observe repeat ticks without a db read.
function makeInMemoryCorpus(filesByPath: Map<string, string>): {
  fileSystem: CorpusFileSystem;
  getScanCount: () => number;
} {
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
  let scanCount = 0;
  const fileSystem: CorpusFileSystem = {
    async listDirectory(directoryPath: string): Promise<CorpusDirectoryEntry[]> {
      if (directoryPath === FAKE_PROJECTS_ROOT) {
        scanCount += 1;
      }
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
  return { fileSystem, getScanCount: () => scanCount };
}

// Two-row synthetic corpus: a session transcript with two distinct message ids.
function twoRowCorpus(): { fileSystem: CorpusFileSystem; getScanCount: () => number } {
  const files = new Map<string, string>([
    [
      join(FAKE_PROJECTS_ROOT, '-slug', 'session-1.jsonl'),
      usageRecordLine('msg_a', 10) + usageRecordLine('msg_b', 20),
    ],
  ]);
  return makeInMemoryCorpus(files);
}

const throwingCorpusFileSystem: CorpusFileSystem = {
  async listDirectory(): Promise<CorpusDirectoryEntry[]> {
    throw new Error('corpus is dead');
  },
  async statFile(): Promise<CorpusFileStat> {
    throw new Error('corpus is dead');
  },
  async readTextFrom(): Promise<string> {
    throw new Error('corpus is dead');
  },
};

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const ledgerDbPath = nextLedgerPath();
  return {
    port: 0,
    hookPort: 0,
    dbPath: join(temporaryDirectory, `events-${ledgerFileCounter}.db`),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    ...overrides,
  };
}

interface StartOptions {
  config: DaemonConfig;
  costLedgerPath: string;
  costCorpusFileSystem: CorpusFileSystem;
  // Optional test seam (app.ts's DaemonDeps.costLedgerStore): a caller-built
  // store, e.g. one whose write methods have been overridden to throw, so the
  // daemon's non-fatal ingest guard can be exercised for real.
  costLedgerStore?: SqliteCostStore;
}

function startDaemon(options: StartOptions): Promise<Daemon> {
  const daemon = createDaemon({
    config: options.config,
    clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
    costLedgerPath: options.costLedgerPath,
    costCorpusFileSystem: options.costCorpusFileSystem,
    costLedgerStore: options.costLedgerStore,
  });
  return daemon.start().then(() => daemon);
}

// A read-only view over the on-disk ledger, opened on a SEPARATE connection so a
// test can assert what the daemon's own store persisted without exposing it.
function readLedgerRowCount(ledgerPath: string): number {
  const reader = new SqliteCostStore({ path: ledgerPath });
  try {
    return reader.countUsageRows();
  } finally {
    reader.dispose();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadlineMs) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('cost ingester wired into the daemon', () => {
  it('enabled → boot performs one immediate ingest that captures the corpus', async () => {
    const ledgerPath = nextLedgerPath();
    const corpus = twoRowCorpus();
    // A long interval: the timer cannot fire inside the test budget, so any rows
    // that appear must come from the immediate boot scan, not a scheduled tick.
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: corpus.fileSystem,
    });
    try {
      const reader = new SqliteCostStore({ path: ledgerPath });
      try {
        await waitUntil(() => reader.countUsageRows() === 2);
        expect(reader.countUsageRows()).toBe(2);
      } finally {
        reader.dispose();
      }
      // Exactly one full scan ran at boot.
      expect(corpus.getScanCount()).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it('a positive interval schedules repeat scans on the timer', async () => {
    const ledgerPath = nextLedgerPath();
    const corpus = twoRowCorpus();
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 20 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: corpus.fileSystem,
    });
    try {
      // The immediate boot scan is #1; the interval must produce at least one more
      // without error.
      await waitUntil(() => corpus.getScanCount() >= 2);
      expect(corpus.getScanCount()).toBeGreaterThanOrEqual(2);
    } finally {
      await daemon.stop();
    }
    // stop() cleared the timer: the scan count does not keep climbing.
    const scanCountAtStop = corpus.getScanCount();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    expect(corpus.getScanCount()).toBe(scanCountAtStop);
  });

  it('is idempotent across ticks — a second ingest does not double the stored rows', async () => {
    const ledgerPath = nextLedgerPath();
    const corpus = twoRowCorpus();
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: corpus.fileSystem,
    });
    try {
      // Deterministically drive two scans of the same unchanged corpus.
      await daemon.ingestCostOnce();
      await daemon.ingestCostOnce();
      expect(readLedgerRowCount(ledgerPath)).toBe(2);
    } finally {
      await daemon.stop();
    }
  });

  it('disabled (interval 0) → no store, no db file, no scan, no capture', async () => {
    const ledgerPath = nextLedgerPath();
    const corpus = twoRowCorpus();
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 0 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: corpus.fileSystem,
    });
    try {
      // ingestCostOnce is a no-op when disabled; the corpus is never touched.
      await daemon.ingestCostOnce();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      expect(corpus.getScanCount()).toBe(0);
      // No store was opened, so no ledger db file was ever created.
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('an unreadable corpus is skipped by the scanner, not fatal', async () => {
    const ledgerPath = nextLedgerPath();
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: throwingCorpusFileSystem,
    });
    try {
      // A direct scan of the dead corpus must resolve, never reject. NOTE: this
      // is the scanner's own resilience (scanCostCorpus swallows a throwing
      // listDirectory internally, costCorpus.ts's "an unreadable directory is
      // skipped, never fatal") — the throw never reaches the daemon's catch
      // below. See the next test for that path.
      await expect(daemon.ingestCostOnce()).resolves.toBeUndefined();
      // The store was opened (enabled), so the file exists but holds no rows.
      expect(readLedgerRowCount(ledgerPath)).toBe(0);
    } finally {
      // The daemon is still up and shuts down cleanly.
      await daemon.stop();
    }
  });

  it('non-fatal — a ledger write that throws never rejects ingestCostOnce or crashes the daemon', async () => {
    const corpus = twoRowCorpus();
    let failingWriteWasInvoked = false;
    const failingLedgerStore = new SqliteCostStore({ path: nextLedgerPath() });
    // The scanner cannot swallow this: it lives on the STORE, past the point
    // scanCostCorpus hands rows off. Only the daemon's own try/catch in
    // ingestCostOnce (app.ts) stands between this throw and an unhandled
    // rejection.
    (failingLedgerStore as unknown as { upsertUsageRows: (rows: unknown) => void }).upsertUsageRows =
      () => {
        failingWriteWasInvoked = true;
        throw new Error('ledger write failed');
      };
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 60_000 }),
      costLedgerPath: nextLedgerPath(),
      costCorpusFileSystem: corpus.fileSystem,
      costLedgerStore: failingLedgerStore,
    });
    try {
      // The scan succeeded (real corpus, real rows) and reached the store write,
      // which threw. The daemon's catch must swallow it so the call still
      // resolves — this is the daemon's own guard, not scanner resilience.
      await expect(daemon.ingestCostOnce()).resolves.toBeUndefined();
      // Prove the throwing override actually fired — the scan ran and reached
      // the store write, so the resolved call above is proof of the daemon's
      // catch, not a coincidence of the scan never getting that far. (At least
      // 1, not exactly 1: costIngestIntervalMs > 0 also fires an unawaited scan
      // at boot — against this same failing store — so that fire-and-forget
      // scan may already have landed before this explicit call runs.)
      expect(failingWriteWasInvoked).toBe(true);
      expect(corpus.getScanCount()).toBeGreaterThanOrEqual(1);
    } finally {
      // The daemon is still up and shuts down cleanly.
      await expect(daemon.stop()).resolves.toBeUndefined();
    }
  });

  it('stop() clears the ingest timer and closes the ledger store cleanly', async () => {
    const ledgerPath = nextLedgerPath();
    const corpus = twoRowCorpus();
    const daemon = await startDaemon({
      config: buildConfig({ costIngestIntervalMs: 20 }),
      costLedgerPath: ledgerPath,
      costCorpusFileSystem: corpus.fileSystem,
    });
    await daemon.ingestCostOnce();
    // A clean shutdown resolves, clears the (unref'd) timer, and disposes the
    // store — no open-handle leak keeps the process alive.
    await expect(daemon.stop()).resolves.toBeUndefined();
    // The timer is gone: no further scans run after stop().
    const scanCountAtStop = corpus.getScanCount();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    expect(corpus.getScanCount()).toBe(scanCountAtStop);
  });

  // The store-close path is guarded against double-disposal (stop() disposes the
  // ledger during the same shutdown phase the other stores close). better-sqlite3
  // close() is a no-op on an already-closed handle, so the disposal can never
  // throw even if it runs twice.
  it('the ledger store dispose() is idempotent — a second close never throws', () => {
    const store = new SqliteCostStore({ path: ':memory:' });
    store.dispose();
    expect(() => store.dispose()).not.toThrow();
  });
});
