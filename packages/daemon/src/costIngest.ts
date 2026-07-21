import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanCostCorpus, type CostCorpusScanStats, type CorpusFileSystem } from './costCorpus.js';
import type { SqliteCostStore } from './sqliteCostStore.js';

// ─── slice 5b step 1 — ingestion: scan → durable store ───────────────────────
//
// Ties the recursive transcript scan to the ledger's own SQLite copy. The store
// applies the max-wins merge in SQL, so this function does not need to dedupe
// in memory first: the upsert IS the global dedupe, across files AND across runs.

export function defaultCostProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

// The ledger lives BESIDE events.db in the data dir, never inside it (step 1
// settled: max-wins is an UPDATE, and events.db carries the I12 ABORT triggers,
// so the ledger must be a SEPARATE database file — see SqliteCostStore's header).
export function defaultCostLedgerPath(dataDir: string): string {
  return join(dataDir, 'cost-ledger.db');
}

export interface CostIngestOptions {
  store: SqliteCostStore;
  projectsRoot?: string;
  projectRoots: readonly string[];
  fileSystem?: CorpusFileSystem;
  // Injected so no clock lives in the ingestion path itself (rule 0.3). Only ever
  // written to the watermark; never used in a comparison that shapes behavior.
  nowIso: () => string;
}

export interface CostIngestResult {
  stats: CostCorpusScanStats;
  rowsUpserted: number;
  storedRowCount: number;
  watermark: string;
}

export async function ingestCostCorpus(options: CostIngestOptions): Promise<CostIngestResult> {
  const projectsRoot = options.projectsRoot ?? defaultCostProjectsRoot();
  const scanResult = await scanCostCorpus({
    projectsRoot,
    projectRoots: options.projectRoots,
    fileSystem: options.fileSystem,
    previousProgress: options.store.fileProgress(),
  });
  options.store.upsertUsageRows(scanResult.rows);
  options.store.recordFileProgress(scanResult.fileProgress);
  const watermark = options.nowIso();
  options.store.setWatermark(watermark);
  return {
    stats: scanResult.stats,
    rowsUpserted: scanResult.rows.length,
    storedRowCount: options.store.countUsageRows(),
    watermark,
  };
}
