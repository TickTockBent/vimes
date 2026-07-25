import { describe, expect, it } from 'vitest';
import { artifactEnvelopeSchema } from './tasks/workOrder.js';
import {
  ArtifactEnvelopeValidationError,
  computeArtifactHash,
  type ArtifactPutMeta,
} from './artifactStore.js';
import { MemoryArtifactStore } from './memoryArtifactStore.js';

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

describe('computeArtifactHash', () => {
  // A fixed string with a known sha256, pinned so the hash algorithm can never
  // silently change out from under content-addressing (verified independently
  // with `python3 -c "import hashlib; print(hashlib.sha256(b'...').hexdigest())"`
  // before any store code existed).
  it('matches the pinned sha256 of a fixed string', () => {
    expect(computeArtifactHash('vimes-artifact-store-fixed-string')).toBe(
      '09840eb6198e7096523c9f8f09a9f51fe9429b7e117c0f134aec6f35202cec4a',
    );
  });

  it('is stable across repeated calls (deterministic)', () => {
    const first = computeArtifactHash('repeat me');
    const second = computeArtifactHash('repeat me');
    expect(first).toBe(second);
  });

  it('gives identical hashes for identical blobs', () => {
    expect(computeArtifactHash('identical content')).toBe(computeArtifactHash('identical content'));
  });

  it('gives a different hash for a one-byte-different blob', () => {
    expect(computeArtifactHash('identical content')).not.toBe(computeArtifactHash('identical contenT'));
  });
});

describe('MemoryArtifactStore', () => {
  it('round-trips: getBlob(put(blob).hash) returns the exact blob', () => {
    const store = new MemoryArtifactStore();
    const blob = 'the plan text';
    const envelope = store.put(blob, sampleMeta());
    expect(store.getBlob(envelope.hash)).toBe(blob);
  });

  it('getBlob returns null for an unknown hash', () => {
    const store = new MemoryArtifactStore();
    expect(store.getBlob('0'.repeat(64))).toBeNull();
  });

  it('returns an envelope that validates artifactEnvelopeSchema and carries meta verbatim', () => {
    const store = new MemoryArtifactStore();
    const meta = sampleMeta({
      kind: 'diff',
      taskRef: { taskId: 'task-9', stage: 'review' },
      rev: 3,
      createdBy: { appSessionId: 'session-xyz' },
      createdAt: '2026-07-24T12:34:56.000Z',
    });
    const envelope = store.put('some diff content', meta);

    expect(() => artifactEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.hash).toBe(computeArtifactHash('some diff content'));
    expect(envelope.kind).toBe(meta.kind);
    expect(envelope.taskRef).toEqual(meta.taskRef);
    expect(envelope.rev).toBe(meta.rev);
    expect(envelope.createdBy).toEqual(meta.createdBy);
    expect(envelope.createdAt).toBe(meta.createdAt);
  });

  it('listByTask returns only that task envelopes, in insertion order', () => {
    const store = new MemoryArtifactStore();
    const first = store.put('blob one', sampleMeta({ taskRef: { taskId: 'task-a', stage: 'plan' } }));
    const second = store.put(
      'blob two',
      sampleMeta({ taskRef: { taskId: 'task-a', stage: 'implement' }, rev: 1 }),
    );
    store.put('blob three', sampleMeta({ taskRef: { taskId: 'task-b', stage: 'plan' } }));

    expect(store.listByTask('task-a')).toEqual([first, second]);
  });

  it('listByTask returns an empty list for a task with no artifacts', () => {
    const store = new MemoryArtifactStore();
    expect(store.listByTask('never-seen-task')).toEqual([]);
  });

  it('two independent stores given the same puts return identical hashes and envelopes', () => {
    const storeOne = new MemoryArtifactStore();
    const storeTwo = new MemoryArtifactStore();
    const meta = sampleMeta();

    const envelopeOne = storeOne.put('shared content', meta);
    const envelopeTwo = storeTwo.put('shared content', meta);

    expect(envelopeOne).toEqual(envelopeTwo);
  });

  it('throws ArtifactEnvelopeValidationError if the built envelope fails artifactEnvelopeSchema', () => {
    const store = new MemoryArtifactStore();
    // rev must be a nonnegative int per artifactEnvelopeSchema; -1 is invalid.
    const invalidMeta = sampleMeta({ rev: -1 });
    expect(() => store.put('will not validate', invalidMeta)).toThrow(ArtifactEnvelopeValidationError);
  });
});
