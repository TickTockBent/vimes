import type { MeterHistorySample, MetersState } from './projections/meters.js';
import type { MeterRecord } from './schemas.js';

// Pure derivations over the meters read model (slice 5 step 1).
//
// Rule 0.3: nothing here reads a clock, a random source, or any I/O — every
// "now" arrives as the `nowIso` parameter, and every staleness threshold arrives
// as an explicit argument. Nothing derived here is ever STORED (D26): a stored
// freshness flag would let a stale record masquerade as fresh, which is the
// exact failure pillar 4 forbids.
//
// The invariant that governs every function below: **UNKNOWN NEVER COLLAPSES
// INTO PASS OR 0.** Headroom that cannot be observed is `null` / `'unknown'`,
// never 0 and never permission to proceed. A scheduler that cannot see headroom
// must not be told it has some.

export type MeterFreshness = 'fresh' | 'stale' | 'unknown';

export type HeadroomGateVerdict = 'pass' | 'fail' | 'unknown';

export interface HeadroomGate {
  meterId: string;
  // The minimum headroom (in percentage points, 0..100) the caller requires.
  pct: number;
}

export type HeadroomGateReason =
  | 'meter-never-observed'
  | 'observation-stale'
  | 'percent-unobserved'
  | 'headroom-sufficient'
  | 'headroom-insufficient';

export interface HeadroomGateResult {
  verdict: HeadroomGateVerdict;
  reason: HeadroomGateReason;
  headroomPercent: number | null;
  freshness: MeterFreshness;
}

const MILLISECONDS_PER_HOUR = 3_600_000;

// Parse an ISO timestamp to epoch milliseconds, or null when it is absent or
// unparseable. Date.parse is a pure string→number function (no clock read), so
// it is permitted under rule 0.3.
function parseIsoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMilliseconds = Date.parse(isoTimestamp);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : null;
}

// Freshness is DERIVED, never stored (D26). Three states, and the third is not
// a synonym for either of the others: with no parseable observation at all we
// know nothing, which is 'unknown' — not 'fresh' and not 'stale'.
//
// `staleAfterMs` is deliberately a REQUIRED parameter: the staleness window is a
// ⟨tune⟩ band that slice 5 has not calibrated yet, and rule 0.2 forbids pinning
// one here as a silent default.
export function meterFreshness(
  observedAt: string | null | undefined,
  nowIso: string,
  staleAfterMs: number,
): MeterFreshness {
  const observedAtMs = parseIsoToEpochMs(observedAt);
  const nowMs = parseIsoToEpochMs(nowIso);
  if (observedAtMs === null || nowMs === null) {
    return 'unknown';
  }
  const observationAgeMs = nowMs - observedAtMs;
  // A future-dated observation (clock skew between the daemon and a source) is
  // not stale; only elapsed age past the threshold is.
  return observationAgeMs > staleAfterMs ? 'stale' : 'fresh';
}

// Remaining headroom in percentage points, or null when the meter carries no
// observed percentage. NULL MEANS UNKNOWN and must stay distinguishable from 0
// ("no headroom left") at every call site — the two lead to opposite decisions.
//
// `used`/`limit` are deliberately NOT used as a fallback: D26 keeps absolutes
// and percentages separate, and a source that gave neither a percent nor a limit
// has told us nothing about headroom.
export function headroomPercent(
  meter: Pick<MeterRecord, 'percent'> | null | undefined,
): number | null {
  if (meter === null || meter === undefined) {
    return null;
  }
  const observedPercent = meter.percent;
  if (typeof observedPercent !== 'number' || !Number.isFinite(observedPercent)) {
    return null;
  }
  const remaining = 100 - observedPercent;
  // A source reporting over 100% (already past the cap) has zero headroom, not
  // negative headroom.
  return remaining < 0 ? 0 : remaining;
}

interface UsableSample {
  observedAtMs: number;
  percent: number;
}

// Samples that can carry a rate: parseable timestamp, finite percent, and not
// observed after `nowIso` (an out-of-order or skewed future sample cannot
// describe burn up to now). Sorted oldest-first so the segment walk below is
// order-independent of how the history was appended.
function usableSamples(history: MeterHistorySample[], nowMs: number): UsableSample[] {
  const usable: UsableSample[] = [];
  for (const sample of history) {
    const observedAtMs = parseIsoToEpochMs(sample.observedAt);
    if (observedAtMs === null || observedAtMs > nowMs) {
      continue;
    }
    if (typeof sample.percent !== 'number' || !Number.isFinite(sample.percent)) {
      continue;
    }
    usable.push({ observedAtMs, percent: sample.percent });
  }
  usable.sort((left, right) => left.observedAtMs - right.observedAtMs);
  return usable;
}

// The samples since the most recent RESET boundary.
//
// A usage window resetting makes `percent` DROP, so a naive slope across a reset
// yields a negative (garbage) rate — "your 5-hour window is emptying" when it in
// fact just rolled over. The boundary is detected by walking the sorted samples
// from the newest backwards and stopping at the first place where the percentage
// DECREASED: that decrease is the rollover, and everything at or after it is the
// current window. (The history carries only `{observedAt, percent}`; when a
// future source also carries `resetsAt` per sample, a change in it is the second
// signal to add here.)
function currentWindowSegment(usable: UsableSample[]): UsableSample[] {
  let segmentStartIndex = 0;
  for (let index = usable.length - 1; index > 0; index -= 1) {
    if (usable[index]!.percent < usable[index - 1]!.percent) {
      segmentStartIndex = index;
      break;
    }
  }
  return usable.slice(segmentStartIndex);
}

export function samplesSinceLastReset(
  history: MeterHistorySample[],
  nowIso: string,
): MeterHistorySample[] {
  const nowMs = parseIsoToEpochMs(nowIso);
  if (nowMs === null) {
    return [];
  }
  return currentWindowSegment(usableSamples(history, nowMs)).map((sample) => ({
    observedAt: new Date(sample.observedAtMs).toISOString(),
    percent: sample.percent,
  }));
}

// Percentage points consumed per hour over the CURRENT window only (reset-aware,
// see samplesSinceLastReset). Fewer than two usable samples in the segment, or a
// segment spanning no elapsed time, is UNKNOWN → null. Never 0: "we cannot see a
// rate" and "the rate is genuinely zero" are different facts, and only the
// second one is a number.
export function burnRatePercentPerHour(
  history: MeterHistorySample[],
  nowIso: string,
): number | null {
  const nowMs = parseIsoToEpochMs(nowIso);
  if (nowMs === null) {
    return null;
  }
  const segment = currentWindowSegment(usableSamples(history, nowMs));
  if (segment.length < 2) {
    return null;
  }
  const oldestSample = segment[0]!;
  const newestSample = segment[segment.length - 1]!;
  const elapsedMs = newestSample.observedAtMs - oldestSample.observedAtMs;
  if (elapsedMs <= 0) {
    return null;
  }
  const percentDelta = newestSample.percent - oldestSample.percent;
  return percentDelta / (elapsedMs / MILLISECONDS_PER_HOUR);
}

// The ISO instant at which this meter would reach 100% at its current burn rate,
// projected forward from the observation the percentage belongs to.
//
// Null (UNKNOWN) when: the percentage was never observed, the meter is already
// at or past 100, the burn rate is unknown, the burn rate is non-positive
// (usage is flat or falling — it never reaches the cap), or the window RESETS
// before the projection lands. That last case matters most: a window that resets
// first never exhausts, and saying so honestly beats inventing a time.
export function projectedExhaustion(
  meter: Pick<MeterRecord, 'percent' | 'observedAt' | 'resetsAt'> | null | undefined,
  history: MeterHistorySample[],
  nowIso: string,
): string | null {
  if (meter === null || meter === undefined) {
    return null;
  }
  const remainingPercent = headroomPercent(meter);
  if (remainingPercent === null || remainingPercent <= 0) {
    return null;
  }
  const observedAtMs = parseIsoToEpochMs(meter.observedAt);
  if (observedAtMs === null) {
    return null;
  }
  const burnRate = burnRatePercentPerHour(history, nowIso);
  if (burnRate === null || burnRate <= 0) {
    return null;
  }
  const hoursToExhaustion = remainingPercent / burnRate;
  const exhaustionMs = Math.round(observedAtMs + hoursToExhaustion * MILLISECONDS_PER_HOUR);
  if (!Number.isFinite(exhaustionMs)) {
    return null;
  }
  const resetsAtMs = parseIsoToEpochMs(meter.resetsAt);
  if (resetsAtMs !== null && exhaustionMs > resetsAtMs) {
    // The window rolls over before the projection lands: it never exhausts.
    return null;
  }
  return new Date(exhaustionMs).toISOString();
}

// I10 GROUNDWORK (slice 6 owns enforcement): does `gate.meterId` currently show
// at least `gate.pct` headroom?
//
// Three states, and 'unknown' IS NOT 'pass'. A meter that was never observed,
// whose observation has gone stale, or that carries no percentage, yields
// 'unknown' — the caller must decide what to do with not-knowing, and must never
// read it as permission. This is the structural expression of the slice's whole
// premise: meters that lie are worse than meters that don't exist.
export function evaluateHeadroomGate(
  gate: HeadroomGate,
  metersState: MetersState,
  nowIso: string,
  staleAfterMs: number,
): HeadroomGateResult {
  const meter = metersState.meters[gate.meterId];
  if (meter === undefined) {
    return {
      verdict: 'unknown',
      reason: 'meter-never-observed',
      headroomPercent: null,
      freshness: 'unknown',
    };
  }
  const freshness = meterFreshness(meter.observedAt, nowIso, staleAfterMs);
  const observedHeadroom = headroomPercent(meter);
  if (freshness !== 'fresh') {
    // A stale number is NEVER served as current — not even to say "fail", and
    // not even as an advisory field a careless caller could read as current.
    return {
      verdict: 'unknown',
      reason: 'observation-stale',
      headroomPercent: null,
      freshness,
    };
  }
  if (observedHeadroom === null) {
    return {
      verdict: 'unknown',
      reason: 'percent-unobserved',
      headroomPercent: null,
      freshness,
    };
  }
  return observedHeadroom >= gate.pct
    ? {
        verdict: 'pass',
        reason: 'headroom-sufficient',
        headroomPercent: observedHeadroom,
        freshness,
      }
    : {
        verdict: 'fail',
        reason: 'headroom-insufficient',
        headroomPercent: observedHeadroom,
        freshness,
      };
}
