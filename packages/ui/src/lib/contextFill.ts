// Pure derivation for the StreamView vitals strip's CONTEXT cell — the observed
// context occupancy of the latest turn. No Vue, no DOM, no I/O, no clock, no
// Intl: every branch is unit-tested without a browser (same posture as
// lib/cacheBadge.ts / lib/meterDisplay.ts).
//
// "Context size" here is the input-side tokens the MOST RECENTLY OBSERVED
// usage_block fed the model — input + cacheRead + cacheCreation. It is an
// OBSERVED proxy, not a percentage: VIMES cannot know the model's context
// LIMIT without a declared-truth model→limit table (a ⟨Wes⟩ call with no
// consumer yet — rule 0.5), so this reports the ABSOLUTE count only. Output is
// deliberately excluded upstream (generated text is not resident context).

import type { CacheObservabilityRecord } from './cacheBadge.js';

/**
 * The observed context occupancy = the input-side tokens of the latest turn
 * (input + cacheRead + cacheCreation).
 *
 * Null when nothing has been observed — no record for this session yet, or a
 * record from an older daemon that predates `latestContextTokens`. The caller
 * shows "unknown" (an em dash), NEVER a fabricated 0 (pillar 4).
 *
 * A genuinely observed zero-token block returns 0, NOT null: a real observed
 * empty is a different fact from "unobserved", and the two must not collapse.
 */
export function contextTokens(record: CacheObservabilityRecord | undefined): number | null {
  if (record === undefined) {
    return null;
  }
  const latest = record.latestContextTokens;
  if (latest === null || latest === undefined) {
    return null;
  }
  return latest.inputTokens + latest.cacheReadTokens + latest.cacheCreationTokens;
}
