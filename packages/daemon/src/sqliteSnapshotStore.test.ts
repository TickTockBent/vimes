import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySnapshotStore, type ProjectionSnapshot, type SnapshotStore } from '@vimes/core';
import { SqliteSnapshotStore } from './sqliteSnapshotStore.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-snapshot-conformance-'));
let databaseFileCounter = 0;

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `snapshot-${databaseFileCounter}.db`);
}

interface DisposableSnapshotStore extends SnapshotStore {
  dispose?: () => void;
}

function snapshot(projectionId: string, used: number): ProjectionSnapshot {
  return {
    projectionId,
    lastAppliedSeq: { alpha: used, beta: used * 2 },
    state: { count: used, nested: { label: `v${used}`, flags: [true, false] } },
    savedAt: `2026-01-01T00:00:${String(used).padStart(2, '0')}.000Z`,
  };
}

// Mirrors MemorySnapshotStore's behavior: run the identical contract against both
// implementations so the sqlite cache is byte-for-byte substitutable.
function registerSnapshotStoreConformance(
  name: string,
  makeStore: () => DisposableSnapshotStore,
): void {
  describe(`SnapshotStore conformance: ${name}`, () => {
    it('round-trips a saved snapshot on load', () => {
      const store = makeStore();
      try {
        const saved = snapshot('sessions', 7);
        store.save(saved);
        expect(store.load('sessions')).toEqual(saved);
      } finally {
        store.dispose?.();
      }
    });

    it('returns null for a projectionId that was never saved', () => {
      const store = makeStore();
      try {
        expect(store.load('never-saved')).toBeNull();
      } finally {
        store.dispose?.();
      }
    });

    it('overwrite replaces the prior snapshot for the same projectionId', () => {
      const store = makeStore();
      try {
        store.save(snapshot('sessions', 1));
        store.save(snapshot('sessions', 42));
        expect(store.load('sessions')).toEqual(snapshot('sessions', 42));
      } finally {
        store.dispose?.();
      }
    });

    it('keeps distinct projectionIds independent', () => {
      const store = makeStore();
      try {
        store.save(snapshot('sessions', 3));
        store.save(snapshot('tasks', 9));
        expect(store.load('sessions')).toEqual(snapshot('sessions', 3));
        expect(store.load('tasks')).toEqual(snapshot('tasks', 9));
      } finally {
        store.dispose?.();
      }
    });
  });
}

registerSnapshotStoreConformance('memory', () => new MemorySnapshotStore());
registerSnapshotStoreConformance('sqlite', () => new SqliteSnapshotStore({ path: nextDatabasePath() }));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});
