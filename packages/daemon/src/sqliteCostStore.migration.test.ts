import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CostAgentEdge, CostUsageRow } from './costCorpus.js';
import { SqliteCostStore } from './sqliteCostStore.js';

// ─── unit parent-edge 2 — the v1→v2 migration is SAFE ─────────────────────────
//
// v2 adds cost_agent_edges and forward-migrates a v1 DB by clearing cost_ingest_files
// ONLY — forcing a one-time full re-scan so the new agent-edge harvest backfills. The
// migration MUST NOT touch cost_usage_rows: transcripts get pruned, so those rows are
// the DURABLE copy of real spend; dropping them would lose spend whose source file is
// already gone. This test proves the progress is cleared, the spend survives, and the
// edge table is present and first-wins idempotent.
//
// Never reads ~/.claude or the real ledger — a fresh temp-directory SQLite file only.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-cost-migration-'));
let migrationDbCounter = 0;
function nextMigrationDbPath(): string {
  migrationDbCounter += 1;
  return join(temporaryDirectory, `migration-${migrationDbCounter}.db`);
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

// A fully-populated priced usage row — the durable spend the migration must preserve.
function sampleUsageRow(): CostUsageRow {
  return {
    rowKey: 'msg:migration-durable-row',
    messageId: 'migration-durable-row',
    undedupable: false,
    timestamp: '2026-07-20T10:00:00.000Z',
    model: 'claude-opus-4-8',
    projectSlug: '-home-ticktockbent-projects-vimes',
    projectCwd: '/home/ticktockbent/projects/vimes',
    insideProjectRoots: true,
    sessionId: 'session-migration-1',
    agentId: null,
    attributionAgent: null,
    attributionSkill: null,
    isSidechain: null,
    requestId: null,
    toolUseResultAgentId: null,
    sourcePath: '/fake/projects/-home-ticktockbent-projects-vimes/session-migration-1.jsonl',
    sourceKind: 'session',
    speed: null,
    serviceTier: null,
    inferenceGeo: null,
    inputTokens: 100,
    outputTokens: 1000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    settledScore: 1100,
  };
}

// Open a store, seed one usage row + one ingest-progress row, then forcibly stamp the
// stored schema_version back to '1' via a raw handle so the NEXT open sees a v1 DB.
function seedV1Store(path: string): void {
  const store = new SqliteCostStore({ path });
  store.upsertUsageRows([sampleUsageRow()]);
  store.recordFileProgress([
    {
      path: '/fake/projects/-home-ticktockbent-projects-vimes/session-migration-1.jsonl',
      observedSizeBytes: 4242,
      observedMtimeMs: 1000,
      consumedBytes: 4242,
    },
  ]);
  store.dispose();

  const rawHandle = new Database(path);
  rawHandle.prepare("UPDATE cost_meta SET value = '1' WHERE key = 'schema_version'").run();
  rawHandle.close();
}

describe('SqliteCostStore v1→v2 migration', () => {
  it('clears cost_ingest_files, PRESERVES cost_usage_rows, stamps version 2, and adds cost_agent_edges', () => {
    const path = nextMigrationDbPath();
    seedV1Store(path);

    // Sanity: the seed really did leave a v1 DB with one usage row and one progress row.
    const rawHandle = new Database(path);
    const seededVersion = rawHandle
      .prepare("SELECT value FROM cost_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(seededVersion.value).toBe('1');
    const seededProgressCount = rawHandle
      .prepare('SELECT COUNT(*) AS count FROM cost_ingest_files')
      .get() as { count: number };
    expect(seededProgressCount.count).toBe(1);
    const seededRowCount = rawHandle
      .prepare('SELECT COUNT(*) AS count FROM cost_usage_rows')
      .get() as { count: number };
    expect(seededRowCount.count).toBe(1);
    rawHandle.close();

    // Reopen: the constructor runs the forward migration.
    const migratedStore = new SqliteCostStore({ path });
    try {
      // Progress cleared — the next scan re-reads every transcript so edges backfill.
      expect(migratedStore.fileProgress().size).toBe(0);
      // Spend SURVIVED — the durable copy is untouched (this is the data-safety point).
      expect(migratedStore.countUsageRows()).toBe(1);
      const survivingRows = migratedStore.readUsageRows();
      expect(survivingRows).toHaveLength(1);
      expect(survivingRows[0]!.rowKey).toBe('msg:migration-durable-row');
      expect(survivingRows[0]!.inputTokens).toBe(100);
      expect(survivingRows[0]!.outputTokens).toBe(1000);
      // Version stamped forward.
      expect(migratedStore.schemaVersion()).toBe(2);
      // The new side table exists and is empty (no throw on read/count).
      expect(migratedStore.countAgentEdges()).toBe(0);
      expect(migratedStore.readAgentEdges()).toEqual([]);
    } finally {
      migratedStore.dispose();
    }
  });

  it('upsertAgentEdges is first-wins idempotent: a re-upsert never rewrites an existing edge', () => {
    const store = new SqliteCostStore({ path: nextMigrationDbPath() });
    try {
      const originalEdge: CostAgentEdge = {
        sessionId: 'session-idem-1',
        childAgentId: 'agent-child-idem',
        parentAgentId: 'agent-parent-original',
      };

      // Same edge twice → count stays at 1.
      store.upsertAgentEdges([originalEdge]);
      store.upsertAgentEdges([originalEdge]);
      expect(store.countAgentEdges()).toBe(1);

      // A DIFFERENT parent for the SAME (sessionId, childAgentId) must NOT overwrite —
      // a child has one spawner; first-wins keeps the original parent.
      store.upsertAgentEdges([
        { sessionId: 'session-idem-1', childAgentId: 'agent-child-idem', parentAgentId: 'agent-parent-IMPOSTER' },
      ]);
      expect(store.countAgentEdges()).toBe(1);
      const storedEdges = store.readAgentEdges();
      expect(storedEdges).toHaveLength(1);
      expect(storedEdges[0]!.parentAgentId).toBe('agent-parent-original');
    } finally {
      store.dispose();
    }
  });

  it('a fresh DB is stamped v2 with no migration and an empty edge table', () => {
    const store = new SqliteCostStore({ path: nextMigrationDbPath() });
    try {
      expect(store.schemaVersion()).toBe(2);
      expect(store.countAgentEdges()).toBe(0);
      expect(store.countUsageRows()).toBe(0);
    } finally {
      store.dispose();
    }
  });
});
