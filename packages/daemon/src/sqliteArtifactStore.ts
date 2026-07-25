import type Database from 'better-sqlite3';
import { buildArtifactEnvelope } from '@vimes/core';
import type { ArtifactEnvelope, ArtifactPutMeta, ArtifactStore } from '@vimes/core';

// ─── S7·4 — the durable artifact store (Gate 1, rule 0.5) ────────────────────
//
// NOT YET INSTANTIATED IN app.ts. This adapter lands as injected
// infrastructure ahead of its first consumer — S7·5's submit_plan is the unit
// that constructs one for real — matching the reserved-schema pattern already
// used for artifactEnvelopeSchema itself (S7·1). Until that unit lands: no
// route reads this store, no task record points at it, no event names it.
//
// ⚠ CONSTRUCTOR STYLE — DELIBERATE, TO BE SETTLED AT S7·5 WIRING. Unlike
// SqliteEventStore/SqliteCostStore/SqliteSnapshotStore (each of which takes
// `{ path: string }` and opens its OWN connection to config.dbPath), this store
// takes an ALREADY-OPEN `better-sqlite3` `Database`. The upside is real —
// straight dependency injection (rule 0.3 spirit) and clean `:memory:` tests
// with no temp-file plumbing. The downside is that it is the one store
// constructed differently from the other three. Which wins is a WIRING decision
// that only bites when S7·5 first instantiates this store in app.ts: if a shared
// connection is wanted it passes the events Database (a refactor, since app.ts
// currently gives every store its own path); if not, it opens one Database here
// and passes it, or this flips to `{ path }` to match the others. Left injected
// for now because nothing is wired yet and the tests are cleaner this way.
// Raw SQL below a narrow interface is the sanctioned pattern (I12), matching
// sqliteEventStore.ts / sqliteCostStore.ts.
//
// Two tables, deliberately split:
//  - artifact_blobs: hash → blob, ONE row per DISTINCT content. `INSERT OR
//    IGNORE` is the dedup mechanism — a second put of byte-identical content
//    is a no-op against this table, because the content hash already names
//    the row (explicit GC/retention beyond this natural reuse is deferred).
//  - artifacts: one row per `put`, NEVER deduped — two different tasks (or
//    two revs of the same task) may legitimately store identical content,
//    and each occurrence needs its own queryable-by-task envelope record.
const ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_blobs (
  hash TEXT PRIMARY KEY,
  blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  rev INTEGER NOT NULL,
  created_by_session TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task_id ON artifacts (task_id);
`;

const INSERT_BLOB = `
INSERT OR IGNORE INTO artifact_blobs (hash, blob) VALUES (@hash, @blob)
`;

const SELECT_BLOB = `
SELECT blob FROM artifact_blobs WHERE hash = ?
`;

const INSERT_ARTIFACT = `
INSERT INTO artifacts (hash, kind, task_id, stage, rev, created_by_session, created_at)
VALUES (@hash, @kind, @taskId, @stage, @rev, @createdBySession, @createdAt)
`;

// Ordered by `id` (the rowid alias, so insertion order) — this is what makes
// listByTask return envelopes in the order they were put, not hash or
// alphabetical order.
const SELECT_ARTIFACTS_BY_TASK = `
SELECT hash, kind, task_id AS taskId, stage, rev,
       created_by_session AS createdBySession, created_at AS createdAt
FROM artifacts
WHERE task_id = ?
ORDER BY id ASC
`;

interface ArtifactRow {
  hash: string;
  kind: string;
  taskId: string;
  stage: string;
  rev: number;
  createdBySession: string;
  createdAt: string;
}

function rowToEnvelope(row: ArtifactRow): ArtifactEnvelope {
  return {
    hash: row.hash,
    kind: row.kind,
    taskRef: { taskId: row.taskId, stage: row.stage },
    rev: row.rev,
    createdBy: { appSessionId: row.createdBySession },
    createdAt: row.createdAt,
  };
}

export class SqliteArtifactStore implements ArtifactStore {
  private readonly database: Database.Database;
  private readonly insertBlobStatement: Database.Statement;
  private readonly selectBlobStatement: Database.Statement;
  private readonly insertArtifactStatement: Database.Statement;
  private readonly selectArtifactsByTaskStatement: Database.Statement;

  constructor(database: Database.Database) {
    this.database = database;
    this.database.exec(ARTIFACT_SCHEMA);

    this.insertBlobStatement = this.database.prepare(INSERT_BLOB);
    this.selectBlobStatement = this.database.prepare(SELECT_BLOB);
    this.insertArtifactStatement = this.database.prepare(INSERT_ARTIFACT);
    this.selectArtifactsByTaskStatement = this.database.prepare(SELECT_ARTIFACTS_BY_TASK);
  }

  put(blob: string, meta: ArtifactPutMeta): ArtifactEnvelope {
    // Validate-and-build BEFORE touching the database, exactly like
    // MemoryArtifactStore — the two implementations share this helper so an
    // envelope that fails artifactEnvelopeSchema is a thrown finding (rule
    // 0.1), never a row written and returned anyway.
    const envelope = buildArtifactEnvelope(blob, meta);

    this.insertBlobStatement.run({ hash: envelope.hash, blob });
    this.insertArtifactStatement.run({
      hash: envelope.hash,
      kind: envelope.kind,
      taskId: envelope.taskRef.taskId,
      stage: envelope.taskRef.stage,
      rev: envelope.rev,
      createdBySession: envelope.createdBy.appSessionId,
      createdAt: envelope.createdAt,
    });

    return envelope;
  }

  getBlob(hash: string): string | null {
    const row = this.selectBlobStatement.get(hash) as { blob: string } | undefined;
    return row?.blob ?? null;
  }

  listByTask(taskId: string): readonly ArtifactEnvelope[] {
    const rows = this.selectArtifactsByTaskStatement.all(taskId) as ArtifactRow[];
    return rows.map(rowToEnvelope);
  }
}
