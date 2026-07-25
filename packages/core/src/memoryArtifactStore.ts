import { buildArtifactEnvelope, type ArtifactPutMeta, type ArtifactStore } from './artifactStore.js';
import type { ArtifactEnvelope } from './tasks/workOrder.js';

// The in-memory fake — same role as MemoryEventStore relative to EventStore.
// Two backing maps: hash → blob (the content-addressed table), and
// taskId → ordered envelope list (the attach-by-ref index). Fully
// deterministic; no clock, no id generator, nothing injected — every
// deterministic input is the caller's (blob, meta) pair.
export class MemoryArtifactStore implements ArtifactStore {
  private readonly blobsByHash = new Map<string, string>();
  private readonly envelopesByTaskId = new Map<string, ArtifactEnvelope[]>();

  put(blob: string, meta: ArtifactPutMeta): ArtifactEnvelope {
    const envelope = buildArtifactEnvelope(blob, meta);

    // Natural blob dedup: a hash already present names byte-identical content
    // by construction, so the first blob stored under it is kept as-is.
    // Explicit dedup/GC policy beyond this reuse is deferred (work-order OUT).
    if (!this.blobsByHash.has(envelope.hash)) {
      this.blobsByHash.set(envelope.hash, blob);
    }

    // Envelopes are NEVER deduped — two puts (even of identical content, even
    // for the same task) are two distinct occurrences and each gets its own
    // queryable record.
    const envelopesForTask = this.envelopesByTaskId.get(envelope.taskRef.taskId) ?? [];
    envelopesForTask.push(envelope);
    this.envelopesByTaskId.set(envelope.taskRef.taskId, envelopesForTask);

    return envelope;
  }

  getBlob(hash: string): string | null {
    return this.blobsByHash.get(hash) ?? null;
  }

  listByTask(taskId: string): readonly ArtifactEnvelope[] {
    return this.envelopesByTaskId.get(taskId) ?? [];
  }
}
