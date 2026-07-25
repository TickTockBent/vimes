import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { computeArtifactHash, type ArtifactPutMeta } from '@vimes/core';
import { SqliteArtifactStore } from './sqliteArtifactStore.js';

// In-memory better-sqlite3, the way sqliteEventStore.test.ts / the cost store
// tests construct theirs — no temp files needed since this store takes an
// already-open Database rather than a path.

function sampleMeta(overrides: Partial<ArtifactPutMeta> = {}): ArtifactPutMeta {
  return {
    kind: 'plan',
    taskRef: { taskId: 'task-1', stage: 'plan' },
    rev: 0,
    createdBy: { appSessionId: 'session-abc' },
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteArtifactStore', () => {
  it('round-trips: getBlob(put(blob).hash) returns the exact blob', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);
    const blob = 'the plan text';
    const envelope = store.put(blob, sampleMeta());
    expect(store.getBlob(envelope.hash)).toBe(blob);
    database.close();
  });

  it('getBlob returns null for an unknown hash', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);
    expect(store.getBlob('0'.repeat(64))).toBeNull();
    database.close();
  });

  it('content-addressing: identical blobs hash identically, a one-byte-different blob hashes differently', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);
    const envelopeA = store.put('identical content', sampleMeta({ taskRef: { taskId: 't-a', stage: 'plan' } }));
    const envelopeB = store.put('identical content', sampleMeta({ taskRef: { taskId: 't-b', stage: 'plan' } }));
    const envelopeC = store.put('identical contenT', sampleMeta({ taskRef: { taskId: 't-c', stage: 'plan' } }));

    expect(envelopeA.hash).toBe(envelopeB.hash);
    expect(envelopeA.hash).not.toBe(envelopeC.hash);
    database.close();
  });

  it('listByTask returns only that task envelopes, in insertion order', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);
    const first = store.put('blob one', sampleMeta({ taskRef: { taskId: 'task-a', stage: 'plan' } }));
    const second = store.put(
      'blob two',
      sampleMeta({ taskRef: { taskId: 'task-a', stage: 'implement' }, rev: 1 }),
    );
    store.put('blob three', sampleMeta({ taskRef: { taskId: 'task-b', stage: 'plan' } }));

    expect(store.listByTask('task-a')).toEqual([first, second]);
    database.close();
  });

  it('listByTask returns an empty list for a task with no artifacts', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);
    expect(store.listByTask('never-seen-task')).toEqual([]);
    database.close();
  });

  it('parity: the sqlite store and the memory fake produce identical hashes and envelopes for the same puts', async () => {
    const { MemoryArtifactStore } = await import('@vimes/core');
    const database = new Database(':memory:');
    const sqliteStore = new SqliteArtifactStore(database);
    const memoryStore = new MemoryArtifactStore();
    const meta = sampleMeta();

    const sqliteEnvelope = sqliteStore.put('shared content', meta);
    const memoryEnvelope = memoryStore.put('shared content', meta);

    expect(sqliteEnvelope).toEqual(memoryEnvelope);
    expect(sqliteEnvelope.hash).toBe(computeArtifactHash('shared content'));
    database.close();
  });

  it('dedups blob rows but NOT envelope rows for identical content put twice', () => {
    const database = new Database(':memory:');
    const store = new SqliteArtifactStore(database);

    store.put('same content', sampleMeta({ taskRef: { taskId: 'task-a', stage: 'plan' } }));
    store.put('same content', sampleMeta({ taskRef: { taskId: 'task-b', stage: 'plan' } }));

    const blobRowCount = database
      .prepare('SELECT COUNT(*) AS blobRowCount FROM artifact_blobs')
      .get() as { blobRowCount: number };
    const artifactRowCount = database
      .prepare('SELECT COUNT(*) AS artifactRowCount FROM artifacts')
      .get() as { artifactRowCount: number };

    // ONE artifact_blobs row (dedup — see the INSERT OR IGNORE verify-by-breaking
    // note in the checkpoint), TWO artifacts rows (envelopes are never deduped:
    // two different tasks each get their own queryable record).
    expect(blobRowCount.blobRowCount).toBe(1);
    expect(artifactRowCount.artifactRowCount).toBe(2);
    database.close();
  });

  it('a blob survives a store re-open on the same Database (persistence)', () => {
    const database = new Database(':memory:');
    const firstOpen = new SqliteArtifactStore(database);
    const envelope = firstOpen.put('persisted content', sampleMeta());

    // Re-open against the SAME Database handle (an in-memory db only persists
    // for the life of its handle, so this is the in-process analog of a file
    // store surviving a restart — the constructor's `CREATE TABLE IF NOT
    // EXISTS` must be a no-op against the already-populated tables).
    const secondOpen = new SqliteArtifactStore(database);
    expect(secondOpen.getBlob(envelope.hash)).toBe('persisted content');
    expect(secondOpen.listByTask(envelope.taskRef.taskId)).toEqual([envelope]);

    database.close();
  });
});
