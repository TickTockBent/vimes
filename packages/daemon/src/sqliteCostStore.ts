import Database from 'better-sqlite3';
import type { CostSourceKind, CostCorpusFileProgress, CostUsageRow } from './costCorpus.js';

// ─── slice 5b step 1 — the durable cost store ────────────────────────────────
//
// WHY A SEPARATE DATABASE FILE, not a table in events.db:
//  1. events.db is APPEND-ONLY BY CONSTRUCTION — I12 installs BEFORE UPDATE and
//     BEFORE DELETE triggers that RAISE(ABORT). Max-wins dedupe is an UPDATE by
//     definition (a later, more settled snapshot must raise an existing row), so
//     the ledger cannot live under those triggers without weakening them for the
//     event log too.
//  2. The event log records what VIMES WITNESSED; this store records what
//     ANTHROPIC BILLED, re-derivable from transcripts at any time. Different
//     authority, different lifetime, different rebuild story.
//  3. A 43k-row bulk ingest should not churn the live event log's WAL, and the
//     two want different vacuum/retention treatment.
// Raw SQL below a narrow interface is the sanctioned pattern (I12), matching
// sqliteEventStore.ts / sqliteSnapshotStore.ts.
//
// This store exists at all because TRANSCRIPTS ARE PRUNED. `cleanupPeriodDays:
// 365` was set as a mitigation on 2026-07-21, but a setting can be changed back
// and a default can move (rule 0.6). The ledger must own its copy.

const COST_SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_usage_rows (
  rowKey TEXT PRIMARY KEY,
  messageId TEXT,
  undedupable INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  model TEXT NOT NULL,
  projectSlug TEXT NOT NULL,
  projectCwd TEXT,
  insideProjectRoots INTEGER NOT NULL,
  sessionId TEXT,
  agentId TEXT,
  attributionAgent TEXT,
  attributionSkill TEXT,
  isSidechain INTEGER,
  requestId TEXT,
  toolUseResultAgentId TEXT,
  sourcePath TEXT NOT NULL,
  sourceKind TEXT NOT NULL,
  speed TEXT,
  serviceTier TEXT,
  inferenceGeo TEXT,
  inputTokens INTEGER NOT NULL,
  outputTokens INTEGER NOT NULL,
  cacheReadInputTokens INTEGER NOT NULL,
  cacheCreationInputTokens INTEGER NOT NULL,
  cacheCreation5mInputTokens INTEGER NOT NULL,
  cacheCreation1hInputTokens INTEGER NOT NULL,
  settledScore INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_usage_rows_project ON cost_usage_rows (projectSlug);
CREATE INDEX IF NOT EXISTS cost_usage_rows_session ON cost_usage_rows (sessionId);
CREATE INDEX IF NOT EXISTS cost_usage_rows_timestamp ON cost_usage_rows (timestamp);

CREATE TABLE IF NOT EXISTS cost_ingest_files (
  path TEXT PRIMARY KEY,
  observedSizeBytes INTEGER NOT NULL,
  observedMtimeMs REAL NOT NULL,
  consumedBytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const COST_SCHEMA_VERSION = '1';
const INGESTION_WATERMARK_KEY = 'ingestion_watermark';

// The insert half. Every column is named so the upsert below can reference
// `excluded.<column>` for each one.
const UPSERT_USAGE_ROW = `
INSERT INTO cost_usage_rows (
  rowKey, messageId, undedupable, timestamp, model, projectSlug, projectCwd,
  insideProjectRoots, sessionId, agentId, attributionAgent, attributionSkill,
  isSidechain, requestId, toolUseResultAgentId, sourcePath, sourceKind,
  speed, serviceTier, inferenceGeo,
  inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
  cacheCreation5mInputTokens, cacheCreation1hInputTokens, settledScore
) VALUES (
  @rowKey, @messageId, @undedupable, @timestamp, @model, @projectSlug, @projectCwd,
  @insideProjectRoots, @sessionId, @agentId, @attributionAgent, @attributionSkill,
  @isSidechain, @requestId, @toolUseResultAgentId, @sourcePath, @sourceKind,
  @speed, @serviceTier, @inferenceGeo,
  @inputTokens, @outputTokens, @cacheReadInputTokens, @cacheCreationInputTokens,
  @cacheCreation5mInputTokens, @cacheCreation1hInputTokens, @settledScore
)
ON CONFLICT(rowKey) DO UPDATE SET
  -- ⚠ RULE 1, IN SQL: elementwise MAX, never first-wins, never sum. A repeated
  -- message.id is a PROGRESSIVE PARTIAL SNAPSHOT (output_tokens 5 → 5 → 455), so
  -- a second ingest of the settled record must RAISE the stored figure. This is
  -- also what makes re-ingestion idempotent WITHOUT losing the max-wins result.
  inputTokens = MAX(cost_usage_rows.inputTokens, excluded.inputTokens),
  outputTokens = MAX(cost_usage_rows.outputTokens, excluded.outputTokens),
  cacheReadInputTokens = MAX(cost_usage_rows.cacheReadInputTokens, excluded.cacheReadInputTokens),
  cacheCreationInputTokens =
    MAX(cost_usage_rows.cacheCreationInputTokens, excluded.cacheCreationInputTokens),
  cacheCreation5mInputTokens =
    MAX(cost_usage_rows.cacheCreation5mInputTokens, excluded.cacheCreation5mInputTokens),
  cacheCreation1hInputTokens =
    MAX(cost_usage_rows.cacheCreation1hInputTokens, excluded.cacheCreation1hInputTokens),
  -- Descriptive fields follow the STRICTLY more settled snapshot; a tie keeps the
  -- incumbent. Every SET expression sees the pre-update row, so comparing against
  -- cost_usage_rows.settledScore here is safe even though it is assigned below.
  timestamp = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.timestamp ELSE cost_usage_rows.timestamp END,
  model = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.model ELSE cost_usage_rows.model END,
  projectSlug = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.projectSlug ELSE cost_usage_rows.projectSlug END,
  projectCwd = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.projectCwd ELSE cost_usage_rows.projectCwd END,
  insideProjectRoots = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.insideProjectRoots ELSE cost_usage_rows.insideProjectRoots END,
  sessionId = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.sessionId ELSE cost_usage_rows.sessionId END,
  agentId = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.agentId ELSE cost_usage_rows.agentId END,
  attributionAgent = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.attributionAgent ELSE cost_usage_rows.attributionAgent END,
  attributionSkill = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.attributionSkill ELSE cost_usage_rows.attributionSkill END,
  isSidechain = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.isSidechain ELSE cost_usage_rows.isSidechain END,
  requestId = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.requestId ELSE cost_usage_rows.requestId END,
  toolUseResultAgentId = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.toolUseResultAgentId ELSE cost_usage_rows.toolUseResultAgentId END,
  sourcePath = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.sourcePath ELSE cost_usage_rows.sourcePath END,
  sourceKind = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.sourceKind ELSE cost_usage_rows.sourceKind END,
  -- ⚠ RULE 8: speed / serviceTier / inferenceGeo carry ABSENT through as NULL.
  -- They are never coalesced to 'standard' — defaulting one silently misprices.
  speed = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.speed ELSE cost_usage_rows.speed END,
  serviceTier = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.serviceTier ELSE cost_usage_rows.serviceTier END,
  inferenceGeo = CASE WHEN excluded.settledScore > cost_usage_rows.settledScore
    THEN excluded.inferenceGeo ELSE cost_usage_rows.inferenceGeo END,
  settledScore = MAX(cost_usage_rows.settledScore, excluded.settledScore)
`;

const USAGE_ROW_COLUMNS = `
  rowKey, messageId, undedupable, timestamp, model, projectSlug, projectCwd,
  insideProjectRoots, sessionId, agentId, attributionAgent, attributionSkill,
  isSidechain, requestId, toolUseResultAgentId, sourcePath, sourceKind,
  speed, serviceTier, inferenceGeo,
  inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
  cacheCreation5mInputTokens, cacheCreation1hInputTokens, settledScore
`;

interface UsageRowRecord {
  rowKey: string;
  messageId: string | null;
  undedupable: number;
  timestamp: string;
  model: string;
  projectSlug: string;
  projectCwd: string | null;
  insideProjectRoots: number;
  sessionId: string | null;
  agentId: string | null;
  attributionAgent: string | null;
  attributionSkill: string | null;
  isSidechain: number | null;
  requestId: string | null;
  toolUseResultAgentId: string | null;
  sourcePath: string;
  sourceKind: string;
  speed: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  settledScore: number;
}

function toDatabaseParameters(row: CostUsageRow): Record<string, string | number | null> {
  return {
    rowKey: row.rowKey,
    messageId: row.messageId,
    undedupable: row.undedupable ? 1 : 0,
    timestamp: row.timestamp,
    model: row.model,
    projectSlug: row.projectSlug,
    projectCwd: row.projectCwd,
    insideProjectRoots: row.insideProjectRoots ? 1 : 0,
    sessionId: row.sessionId,
    agentId: row.agentId,
    attributionAgent: row.attributionAgent,
    attributionSkill: row.attributionSkill,
    isSidechain: row.isSidechain === null ? null : row.isSidechain ? 1 : 0,
    requestId: row.requestId,
    toolUseResultAgentId: row.toolUseResultAgentId,
    sourcePath: row.sourcePath,
    sourceKind: row.sourceKind,
    speed: row.speed,
    serviceTier: row.serviceTier,
    inferenceGeo: row.inferenceGeo,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheCreation5mInputTokens: row.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: row.cacheCreation1hInputTokens,
    settledScore: row.settledScore,
  };
}

function toCostUsageRow(record: UsageRowRecord): CostUsageRow {
  return {
    rowKey: record.rowKey,
    messageId: record.messageId,
    undedupable: record.undedupable === 1,
    timestamp: record.timestamp,
    model: record.model,
    projectSlug: record.projectSlug,
    projectCwd: record.projectCwd,
    insideProjectRoots: record.insideProjectRoots === 1,
    sessionId: record.sessionId,
    agentId: record.agentId,
    attributionAgent: record.attributionAgent,
    attributionSkill: record.attributionSkill,
    isSidechain: record.isSidechain === null ? null : record.isSidechain === 1,
    requestId: record.requestId,
    toolUseResultAgentId: record.toolUseResultAgentId,
    sourcePath: record.sourcePath,
    sourceKind: record.sourceKind as CostSourceKind,
    speed: record.speed,
    serviceTier: record.serviceTier,
    inferenceGeo: record.inferenceGeo,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    cacheCreation5mInputTokens: record.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: record.cacheCreation1hInputTokens,
    settledScore: record.settledScore,
  };
}

export class SqliteCostStore {
  private readonly database: Database.Database;
  private readonly upsertRowStatement: Database.Statement;
  private readonly upsertFileProgressStatement: Database.Statement;
  private readonly readFileProgressStatement: Database.Statement;
  private readonly readRowsStatement: Database.Statement;
  private readonly countRowsStatement: Database.Statement;
  private readonly readMetaStatement: Database.Statement;
  private readonly writeMetaStatement: Database.Statement;
  private readonly upsertRowsTransaction: (rows: readonly CostUsageRow[]) => void;
  private readonly upsertFileProgressTransaction: (
    entries: readonly CostCorpusFileProgress[],
  ) => void;

  constructor(options: { path: string }) {
    this.database = new Database(options.path);
    if (options.path !== ':memory:') {
      this.database.pragma('journal_mode = WAL');
    }
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(COST_SCHEMA);
    this.database
      .prepare("INSERT OR IGNORE INTO cost_meta (key, value) VALUES ('schema_version', ?)")
      .run(COST_SCHEMA_VERSION);

    this.upsertRowStatement = this.database.prepare(UPSERT_USAGE_ROW);
    this.upsertFileProgressStatement = this.database.prepare(
      `INSERT INTO cost_ingest_files (path, observedSizeBytes, observedMtimeMs, consumedBytes)
       VALUES (@path, @observedSizeBytes, @observedMtimeMs, @consumedBytes)
       ON CONFLICT(path) DO UPDATE SET
         observedSizeBytes = excluded.observedSizeBytes,
         observedMtimeMs = excluded.observedMtimeMs,
         consumedBytes = excluded.consumedBytes`,
    );
    this.readFileProgressStatement = this.database.prepare(
      'SELECT path, observedSizeBytes, observedMtimeMs, consumedBytes FROM cost_ingest_files',
    );
    this.readRowsStatement = this.database.prepare(
      `SELECT ${USAGE_ROW_COLUMNS} FROM cost_usage_rows ORDER BY rowKey ASC`,
    );
    this.countRowsStatement = this.database.prepare(
      'SELECT COUNT(*) AS rowCount FROM cost_usage_rows',
    );
    this.readMetaStatement = this.database.prepare('SELECT value FROM cost_meta WHERE key = ?');
    this.writeMetaStatement = this.database.prepare(
      `INSERT INTO cost_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );

    this.upsertRowsTransaction = this.database.transaction((rows: readonly CostUsageRow[]) => {
      for (const row of rows) {
        this.upsertRowStatement.run(toDatabaseParameters(row));
      }
    });
    this.upsertFileProgressTransaction = this.database.transaction(
      (entries: readonly CostCorpusFileProgress[]) => {
        for (const entry of entries) {
          this.upsertFileProgressStatement.run({
            path: entry.path,
            observedSizeBytes: entry.observedSizeBytes,
            observedMtimeMs: entry.observedMtimeMs,
            consumedBytes: entry.consumedBytes,
          });
        }
      },
    );
  }

  // Rows may arrive raw and undeduped — the upsert IS the global dedupe, and it
  // spans runs as well as files.
  upsertUsageRows(rows: readonly CostUsageRow[]): void {
    this.upsertRowsTransaction(rows);
  }

  readUsageRows(): CostUsageRow[] {
    const records = this.readRowsStatement.all() as UsageRowRecord[];
    return records.map(toCostUsageRow);
  }

  countUsageRows(): number {
    const record = this.countRowsStatement.get() as { rowCount: number };
    return record.rowCount;
  }

  fileProgress(): Map<string, CostCorpusFileProgress> {
    const records = this.readFileProgressStatement.all() as CostCorpusFileProgress[];
    return new Map(records.map((record) => [record.path, record]));
  }

  recordFileProgress(entries: readonly CostCorpusFileProgress[]): void {
    this.upsertFileProgressTransaction(entries);
  }

  // The ingestion watermark — an ISO timestamp supplied by the caller's clock (no
  // clock lives in here). A later run reads it to report how stale the copy is.
  watermark(): string | null {
    const record = this.readMetaStatement.get(INGESTION_WATERMARK_KEY) as
      | { value: string | null }
      | undefined;
    return record?.value ?? null;
  }

  setWatermark(isoTimestamp: string): void {
    this.writeMetaStatement.run(INGESTION_WATERMARK_KEY, isoTimestamp);
  }

  schemaVersion(): number {
    const record = this.readMetaStatement.get('schema_version') as { value: string } | undefined;
    return record === undefined ? Number(COST_SCHEMA_VERSION) : Number(record.value);
  }

  dispose(): void {
    this.database.close();
  }
}
