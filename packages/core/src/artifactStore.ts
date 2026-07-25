import { createHash } from 'node:crypto';
import { artifactEnvelopeSchema, type ArtifactEnvelope } from './tasks/workOrder.js';

// ─── S7·4 — the content-addressed artifact store (Gate 1, rule 0.5) ──────────
//
// Injected infrastructure with NO live consumer yet: the port below and the
// in-memory fake in memoryArtifactStore.ts are exercised only by this unit's
// own tests until S7·5 (submit_plan) instantiates a store for real — nothing
// in app.ts, no route, no task record, no event names this store. See
// packages/daemon/src/sqliteArtifactStore.ts for the durable adapter; the
// core/daemon split here mirrors EventStore/MemoryEventStore exactly.
//
// WHY CONTENT-ADDRESSED, AND WHY THAT IS NOT THE LOG'S IDENTITY MODEL: the
// hash below is computed over the BLOB BYTES ONLY, never the envelope —
// identical content always yields the identical hash, which is what lets two
// puts of byte-identical content collapse onto one blob row (dedup is a side
// effect of the addressing scheme, not a policy this port enforces — see the
// daemon adapter's `INSERT OR IGNORE` for where that dedup is actually
// realized against a table). This is STRUCTURALLY DISTINCT from the event
// log's identity model (a uuid `eventId`, or a `(stream, seq)` pair): a
// content hash names WHAT was stored, not WHEN or in what order it arrived.
// Confusing the two identity schemes is this unit's named kill criterion.

export interface ArtifactPutMeta {
  // Reserved-open (S7·1's artifactEnvelopeSchema): 'plan' | 'diff' | 'review' |
  // … — this unit does not pin the closed set, matching the schema's own note.
  kind: string;
  taskRef: { taskId: string; stage: string };
  // The workOrderRev the artifact was produced against.
  rev: number;
  // The session that produced it.
  createdBy: { appSessionId: string };
  // Caller-supplied — NO clock lives in the store (rule 0.3).
  createdAt: string;
}

export interface ArtifactStore {
  // Store a blob; compute its content hash; record the envelope. Returns the
  // full envelope, already validated against `artifactEnvelopeSchema` (see
  // `buildArtifactEnvelope`). Idempotent on identical content: same blob →
  // same hash → the blob row is reused (explicit dedup/GC policy beyond that
  // natural reuse is deferred — see the work-order's Explicitly OUT).
  put(blob: string, meta: ArtifactPutMeta): ArtifactEnvelope;
  // Content-addressed fetch. A hash names exactly one content; null if the
  // store has never seen it.
  getBlob(hash: string): string | null;
  // Attach-by-ref query: every envelope recorded for a task, in insertion
  // order. A task with none recorded yet returns an empty list.
  listByTask(taskId: string): readonly ArtifactEnvelope[];
}

// sha256-hex over the raw blob text. Pure and deterministic — same bytes in,
// same hash out, forever (sha256 is not a clock or an rng, so this needs no
// injection under rule 0.3). node:crypto is already a sanctioned core
// dependency (see harness/profiles/budgetWall.ts's use of node:fs/node:url).
export function computeArtifactHash(blob: string): string {
  return createHash('sha256').update(blob, 'utf8').digest('hex');
}

// Thrown if the envelope this store is about to hand back fails its own
// reserved schema. Per rule 0.1 that is a FINDING — something to surface
// loudly, never to coerce or silently patch around.
export class ArtifactEnvelopeValidationError extends Error {
  constructor(zodMessage: string) {
    super(`artifact store built an envelope that failed artifactEnvelopeSchema: ${zodMessage}`);
    this.name = 'ArtifactEnvelopeValidationError';
  }
}

// Shared by every ArtifactStore implementation (the memory fake here, and the
// daemon's SqliteArtifactStore) so the validate-or-throw behavior is defined
// in exactly one place — both stores build and check envelopes identically,
// which is also what the memory/sqlite parity assertion in the work-order
// requires. Computes the hash, assembles the envelope from the caller's meta
// verbatim, and asserts it parses before handing it back.
export function buildArtifactEnvelope(blob: string, meta: ArtifactPutMeta): ArtifactEnvelope {
  const candidateEnvelope = {
    hash: computeArtifactHash(blob),
    kind: meta.kind,
    taskRef: meta.taskRef,
    rev: meta.rev,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
  };
  const parseResult = artifactEnvelopeSchema.safeParse(candidateEnvelope);
  if (!parseResult.success) {
    throw new ArtifactEnvelopeValidationError(parseResult.error.message);
  }
  return parseResult.data;
}
