// Pure derivation for the mid-run correction indicator (slice 6, step 6b) —
// turns `SessionRecord.pendingCorrectionAt` into what the composer's ambient
// status line renders. No Vue, no DOM, no clock read: `nowMs` is injected by
// the caller so this module stays unit-testable and deterministic (rule 0.3).
//
// THE BINDING CONSTRAINT (design-principles.md pillar 4 — "a meter that lies
// is worse than no meter", sharpened by D5's own words: delivery is bounded
// by the NEXT MODEL CALL, not by generation, and the worst case is
// UNBOUNDED — a correction parked behind a long build or test suite has no
// upper bound on how long it sits queued). This module therefore NEVER
// computes, stores, or exposes anything that could read as an ETA. It reports
// exactly two measured facts: that a correction is queued, and how long it has
// been queued. Nothing here projects forward.
//
// Mirrors packages/core/src/schemas.ts `sessionRecordSchema.pendingCorrectionAt`
// (D5/D30) — same narrow-mirroring idiom as every other lib/ module in this
// package (@vimes/core is not a sanctioned dependency, see types.ts header).

import type { SessionRecord } from './types.js';

export type CorrectionStatus =
  | { readonly kind: 'none' }
  | { readonly kind: 'queued'; readonly queuedAtIso: string; readonly elapsedMs: number };

// Epoch ms for an ISO timestamp, or null when absent/unparseable. Never
// throws — mirrors the same helper's shape in meterDisplay.ts/gitReview.ts.
function parseIsoToEpochMs(isoTimestamp: string): number | null {
  const epochMs = Date.parse(isoTimestamp);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * `session.pendingCorrectionAt` → what the indicator renders.
 *
 * - Absent session, absent field, or `null` → `'none'`: nothing is queued (or
 *   we cannot tell, which must never be presented as "queued").
 * - Unparseable timestamp → `'none'`, NOT a queued state with a garbage
 *   elapsed. THE PILLAR-4 CASE: if we cannot measure the wait, we do not
 *   display a wait — a `NaN` or bogus duration would be exactly the lying
 *   meter this module exists to refuse.
 * - Otherwise `'queued'` with `elapsedMs` measured against the injected
 *   `nowMs`, clamped to 0 when `pendingCorrectionAt` is in the future (clock
 *   skew between the daemon, which stamps the event, and the browser) — a
 *   negative duration is never shown.
 */
export function deriveCorrectionStatus(
  session: Pick<SessionRecord, 'pendingCorrectionAt'> | undefined,
  nowMs: number,
): CorrectionStatus {
  const pendingCorrectionAt = session?.pendingCorrectionAt;
  if (pendingCorrectionAt === undefined || pendingCorrectionAt === null) {
    return { kind: 'none' };
  }
  const queuedAtMs = parseIsoToEpochMs(pendingCorrectionAt);
  if (queuedAtMs === null || !Number.isFinite(nowMs)) {
    return { kind: 'none' };
  }
  const elapsedMs = Math.max(0, nowMs - queuedAtMs);
  return { kind: 'queued', queuedAtIso: pendingCorrectionAt, elapsedMs };
}

// Deterministic, LOCALE-FREE duration rendering for the queued-for label —
// same reasoning as meterDisplay.ts's formatDuration: no Intl/toLocaleString,
// which vary by environment, and the harness needs a byte-identical answer
// every run. Seconds through minutes only: a correction sitting queued for an
// hour is itself the finding this slice exists to surface, not a formatting
// case to make pretty.
export function formatQueuedFor(elapsedMs: number): string {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  return `${minutes}m ${String(remainderSeconds).padStart(2, '0')}s`;
}
