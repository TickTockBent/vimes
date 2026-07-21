import type { MeterAlertPayload } from './events.js';
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
//
// The return is WIDENED with `resetBoundaryObserved`: whether the segment starts
// at a drop we actually SAW, or merely at the oldest sample the bounded buffer
// still holds. Those two are not the same fact. History is capped at
// METER_HISTORY_LIMIT samples, so a window older than the retained span produces
// a segment that begins at the buffer edge — absence of evidence of a reset, not
// evidence of one. Callers that need positive evidence (see
// `currentWindowStartIso`) must check this flag; callers that only need "the
// freshest contiguous run" (burn rate, exhaustion) can ignore it, which is why
// this stays ONE detector rather than two that can diverge (principle 9).
interface CurrentWindowSegment {
  samples: UsableSample[];
  resetBoundaryObserved: boolean;
}

function currentWindowSegment(usable: UsableSample[]): CurrentWindowSegment {
  let segmentStartIndex = 0;
  let resetBoundaryObserved = false;
  for (let index = usable.length - 1; index > 0; index -= 1) {
    if (usable[index]!.percent < usable[index - 1]!.percent) {
      segmentStartIndex = index;
      resetBoundaryObserved = true;
      break;
    }
  }
  return { samples: usable.slice(segmentStartIndex), resetBoundaryObserved };
}

export function samplesSinceLastReset(
  history: MeterHistorySample[],
  nowIso: string,
): MeterHistorySample[] {
  const nowMs = parseIsoToEpochMs(nowIso);
  if (nowMs === null) {
    return [];
  }
  return currentWindowSegment(usableSamples(history, nowMs)).samples.map((sample) => ({
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
  const segment = currentWindowSegment(usableSamples(history, nowMs)).samples;
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
  // Behavior-identical by construction: the reasoned sibling below IS the
  // implementation, and this wrapper drops the reason. Existing callers and
  // tests are untouched (rule 0.4).
  return projectedExhaustionWithReason(meter, history, nowIso).at;
}

// WHY a bare null was not enough. `projectedExhaustion` collapses five
// genuinely different situations into one `null`, and a UI cannot tell them
// apart — yet they mean opposite things to a human deciding whether to start
// work. "The window resets before you would run out" is REASSURING; "not enough
// samples yet" is merely uninformative; "already at 100%" is a wall. The
// slice invariant is that unknown never collapses into pass/0/"fine"; this type
// is that invariant applied to the projection itself.
export type ExhaustionReason =
  // `at` is non-null: a real projected instant.
  | 'projected'
  // The meter has never been sampled at all.
  | 'meter-never-observed'
  // Sampled, but the source gave no percentage. Absent is UNKNOWN — not 0, and
  // not 100.
  | 'percent-unobserved'
  // Already at or past the cap; there is nothing left to project toward.
  | 'already-exhausted'
  // The observation (or the arithmetic over it) is malformed — an unparseable
  // `observedAt`, or a projection that lands outside representable time.
  | 'observation-unusable'
  // Fewer than two usable samples in the current window: we cannot see a rate.
  // Not "the rate is zero" — that is a different fact, below.
  | 'burn-rate-unknown'
  // Usage is flat or falling; at this rate the cap is never reached.
  | 'burn-rate-non-positive'
  // The window rolls over before the projection lands: it never exhausts. The
  // reassuring case, and the one a bare null hid most expensively.
  | 'resets-first';

export interface ProjectedExhaustion {
  at: string | null;
  reason: ExhaustionReason;
}

export function projectedExhaustionWithReason(
  meter: Pick<MeterRecord, 'percent' | 'observedAt' | 'resetsAt'> | null | undefined,
  history: MeterHistorySample[],
  nowIso: string,
): ProjectedExhaustion {
  // The check ORDER below is the original function's order, unchanged, so the
  // `.at` values stay byte-identical to what callers already depend on.
  if (meter === null || meter === undefined) {
    return { at: null, reason: 'meter-never-observed' };
  }
  const remainingPercent = headroomPercent(meter);
  if (remainingPercent === null) {
    return { at: null, reason: 'percent-unobserved' };
  }
  if (remainingPercent <= 0) {
    return { at: null, reason: 'already-exhausted' };
  }
  const observedAtMs = parseIsoToEpochMs(meter.observedAt);
  if (observedAtMs === null) {
    return { at: null, reason: 'observation-unusable' };
  }
  const burnRate = burnRatePercentPerHour(history, nowIso);
  if (burnRate === null) {
    return { at: null, reason: 'burn-rate-unknown' };
  }
  if (burnRate <= 0) {
    return { at: null, reason: 'burn-rate-non-positive' };
  }
  const hoursToExhaustion = remainingPercent / burnRate;
  const exhaustionMs = Math.round(observedAtMs + hoursToExhaustion * MILLISECONDS_PER_HOUR);
  if (!Number.isFinite(exhaustionMs)) {
    return { at: null, reason: 'observation-unusable' };
  }
  const resetsAtMs = parseIsoToEpochMs(meter.resetsAt);
  if (resetsAtMs !== null && exhaustionMs > resetsAtMs) {
    return { at: null, reason: 'resets-first' };
  }
  return { at: new Date(exhaustionMs).toISOString(), reason: 'projected' };
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

// ---------------------------------------------------------------------------
// Threshold alerts (slice 5 step 4a) — pure, edge-triggered, reset-aware.
// ---------------------------------------------------------------------------
//
// Pillar 5: attention is the scarce resource. A meter that re-fires on every
// poll while you sit at 85% is not an alert, it is noise, and it costs more than
// it gives. So crossing is EDGE-triggered: the first observation at or above a
// threshold fires, and nothing fires again until the window rolls over.
//
// Everything below is pure (rule 0.3): `nowIso` and `staleAfterMs` are
// parameters, the thresholds are supplied by the caller, and the memory of what
// already fired is passed in — this function holds no state of its own.

// One already-fired alert, as the daemon reconstructs it by folding past
// `meter_alert` events. Deliberately a plain serializable shape with no derived
// fields: it must be DERIVABLE from the log, never separately maintained.
export interface FiredMeterAlert {
  thresholdPercent: number;
  // The window the alert was fired in, copied from the meter at the time.
  resetsAt: string | null;
  // The observation that triggered it.
  observedAt: string;
}

// meterId → the alerts already fired for that meter, in any order.
export type MeterAlertMemory = Record<string, FiredMeterAlert[]>;

// The start of the meter's CURRENT window when — and ONLY when — a reset was
// actually OBSERVED inside the retained history. Null otherwise (UNKNOWN).
//
// Reset detection is NOT reimplemented here: it delegates to the one detector,
// `currentWindowSegment` (principle 9 — one detector, not two that can diverge),
// and reads the `resetBoundaryObserved` flag that detector now reports.
//
// Why the flag is load-bearing (FINDING 2026-07-21): history is bounded at
// METER_HISTORY_LIMIT samples. When no drop appears inside that span the segment
// simply begins at the oldest RETAINED sample — a value that slides forward with
// the buffer rather than marking the window. Treating that as a window start read
// "the buffer ran out" as "the window rolled over", so every alert older than the
// retained span looked re-armed and re-fired, forever, at roughly the buffer's
// span (~5h20m at the default poll cadence — which merely COINCIDES with the
// 5-hour window and is two orders of magnitude wrong for 7-day weekly caps).
//
// So the percent-drop signal ABSTAINS without positive evidence, and `resetsAt`
// (reliable for weekly meters, and it does change on a genuine rollover) decides
// alone. Note this is a fix to the reasoning, not to the buffer: enlarging
// METER_HISTORY_LIMIT would only push the same defect further out.
function currentWindowStartIso(history: MeterHistorySample[], nowIso: string): string | null {
  const nowMs = parseIsoToEpochMs(nowIso);
  if (nowMs === null) {
    return null;
  }
  const windowSegment = currentWindowSegment(usableSamples(history, nowMs));
  if (!windowSegment.resetBoundaryObserved) {
    return null;
  }
  const oldestSampleInWindow = windowSegment.samples[0];
  return oldestSampleInWindow === undefined
    ? null
    : new Date(oldestSampleInWindow.observedAtMs).toISOString();
}

// ⟨tune 60s PREVIEW⟩ — NOT PINNED (rule 0.2), and it carries its assumptions
// with it. How far two `resets_at` readings may differ and still name the SAME
// window.
//
// Why a tolerance exists at all (FINDING 2026-07-21, SHIPPED): the endpoint
// RECOMPUTES `resets_at` on every request, so one window reports many slightly
// different instants. Five real payloads from a single window:
//
//   20:39:59.374302  .418056  .375408  .900385  .746564
//
// Compared by string equality, every poll looked like a new window, so a fired
// alert was re-armed and re-fired every five minutes — 33 notifications for one
// 80% crossing.
//
// THE MEASUREMENT (whole live event log, 2026-07-21, 325 `meter_sample` rows,
// clustered per meter per window; max spread within one window):
//
//   endpoint:session              28 samples   1.212 s   (the 15:20 window)
//   endpoint:session              76 samples   1.877 s   (the 20:40 window)
//   endpoint:weekly_all          110 samples   1.919 s
//   endpoint:weekly_scoped:Fable 110 samples   0.953 s
//
// WHY TRUNCATING TO WHOLE SECONDS IS NOT ENOUGH — the obvious cheap fix, and it
// does not work. The 20:40 cluster spans `20:39:59.085393` … `20:40:00.962453`,
// straddling a second boundary, so second-truncation still yields two distinct
// keys and the alert still re-fires. Neither is a 1 s tolerance sufficient: the
// observed spread already exceeds one second.
//
// WHY 60 s, when the worst observed jitter is 1.919 s. The quantity being
// classified has a four-order-of-magnitude gap in it: source noise is ~2 s, and
// a genuine window change is 5 h (session) or 7 days (weekly caps). A threshold
// should sit in the middle of that gap, not 2.6× above the noise we happen to
// have sampled — the failure we are fixing was caused by sitting BELOW it. At
// 60 s the margin is ~31× the worst observed jitter and still 1/300 of the
// shortest real window.
//
// THE LIMIT THIS IMPOSES, stated plainly: a meter whose real window advanced by
// LESS THAN 60 s would be read as the same window and would not re-arm. No such
// meter exists in VIMES today (5 h and 7 days); if one is ever added, this band
// must be revisited before it is used for that meter.
//
// The null↔non-null transition is NOT subject to this tolerance (see
// `sameWindowIdentity`): at a real rollover the endpoint DROPS the field, and
// that is a hard change, so the live-observed rollover shape keeps re-arming.
export const WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW = 60_000;

// Do two `resets_at` readings name the same window?
//
// Absence is a fact, not a near-value: null↔non-null is always a DIFFERENT
// window (that transition is exactly how a real rollover shows up — the endpoint
// drops `resets_at` when the window is at zero). Unparseable values fall back to
// exact string comparison rather than being treated as equal, because an
// unreadable timestamp is not evidence of sameness.
function sameWindowIdentity(
  firstResetsAt: string | null,
  secondResetsAt: string | null,
): boolean {
  if (firstResetsAt === null || secondResetsAt === null) {
    return firstResetsAt === secondResetsAt;
  }
  if (firstResetsAt === secondResetsAt) {
    return true;
  }
  const firstResetsAtMs = parseIsoToEpochMs(firstResetsAt);
  const secondResetsAtMs = parseIsoToEpochMs(secondResetsAt);
  if (firstResetsAtMs === null || secondResetsAtMs === null) {
    return false;
  }
  return Math.abs(firstResetsAtMs - secondResetsAtMs) <= WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW;
}

// Is a previously-fired alert still binding, or has the window rolled over and
// re-armed it?
//
// Two independent reset signals, and EITHER one re-arms (they are OR'd, so an
// alert stays binding only when BOTH agree it is the same window):
//   1. `resetsAt` changed BEYOND THE JITTER TOLERANCE — the source told us
//      directly. Compared with `sameWindowIdentity`, never by string equality:
//      the source's own sub-second noise is not a window change.
//   2. the alert was observed before the current window's first sample — the
//      percent DROPPED after it, which is a rollover (see currentWindowStartIso).
//      This signal ABSTAINS (windowStartIso === null) whenever no drop was
//      observed inside the bounded history, leaving signal 1 to decide alone.
// Sources that supply neither signal (no resetsAt, no observed drop) simply never
// re-arm, which is the quiet direction: silence beats crying wolf.
function firedAlertIsStillBinding(
  firedAlert: FiredMeterAlert,
  currentResetsAt: string | null,
  windowStartIso: string | null,
): boolean {
  if (!sameWindowIdentity(firedAlert.resetsAt ?? null, currentResetsAt)) {
    return false;
  }
  if (windowStartIso !== null) {
    const firedAtMs = parseIsoToEpochMs(firedAlert.observedAt);
    const windowStartMs = parseIsoToEpochMs(windowStartIso);
    if (firedAtMs !== null && windowStartMs !== null && firedAtMs < windowStartMs) {
      return false;
    }
  }
  return true;
}

// Decide which meter thresholds should alert right now.
//
// `thresholds` is CALLER-SUPPLIED on purpose: the crossing level is a ⟨tune⟩
// band (⟨tune 80% PREVIEW⟩ per slice-5) and rule 0.2 forbids pinning one here.
// Core has no default; the daemon (or a test) names the numbers.
//
// Returns at most ONE payload per meter, per the multi-threshold rule below.
export function evaluateMeterAlerts(
  metersState: MetersState,
  alreadyAlerted: MeterAlertMemory,
  thresholds: number[],
  nowIso: string,
  staleAfterMs: number,
): MeterAlertPayload[] {
  const alerts: MeterAlertPayload[] = [];
  // Sorted so the output order is a function of the input alone, never of
  // object insertion order (determinism, rule 0.3).
  const meterIds = Object.keys(metersState.meters).sort();

  for (const meterId of meterIds) {
    const meter = metersState.meters[meterId];
    if (meter === undefined) {
      continue;
    }

    // NEVER alert on a number we cannot vouch for. Waking a phone over a stale
    // or unknown observation is precisely the lying meter pillar 4 forbids —
    // and it is worse than silence, because the human acts on it.
    if (meterFreshness(meter.observedAt, nowIso, staleAfterMs) !== 'fresh') {
      continue;
    }

    // Absent is UNKNOWN. Not 0 ("plenty of room"), not 100 ("wall") — a number
    // we cannot see is not a number, so there is nothing to cross.
    const observedPercent = meter.percent;
    if (typeof observedPercent !== 'number' || !Number.isFinite(observedPercent)) {
      continue;
    }

    const currentResetsAt = meter.resetsAt ?? null;
    const windowStartIso = currentWindowStartIso(
      metersState.history[meterId] ?? [],
      nowIso,
    );
    const bindingAlerts = (alreadyAlerted[meterId] ?? []).filter((firedAlert) =>
      firedAlertIsStillBinding(firedAlert, currentResetsAt, windowStartIso),
    );
    // A threshold counts as already fired when ANY binding alert in this window
    // was fired at that level OR HIGHER. The dominance rule is what makes the
    // multi-threshold choice below sound, and it is also just true: having
    // already told you that you passed 90, telling you that you passed 80 is
    // strictly noise.
    const highestBindingThreshold = bindingAlerts.reduce(
      (highest, firedAlert) => Math.max(highest, firedAlert.thresholdPercent),
      Number.NEGATIVE_INFINITY,
    );

    // MULTI-THRESHOLD CHOICE (deliberate, per slice-5 step 4a): when one poll
    // jumps across several thresholds at once (70 → 92 with lines at 80 and 90),
    // emit ONLY THE HIGHEST crossed threshold — one poll produces one alert.
    // Two buzzes for one event would be exactly the noise pillar 5 warns about,
    // and the higher number is the one that carries the information. The lower
    // thresholds are nonetheless treated as fired from then on, via the
    // dominance rule above, so none of them can re-fire later in this window.
    let highestCrossedThreshold: number | null = null;
    for (const threshold of thresholds) {
      if (!Number.isFinite(threshold)) {
        continue;
      }
      if (observedPercent < threshold) {
        continue;
      }
      if (threshold <= highestBindingThreshold) {
        continue;
      }
      if (highestCrossedThreshold === null || threshold > highestCrossedThreshold) {
        highestCrossedThreshold = threshold;
      }
    }
    if (highestCrossedThreshold === null) {
      continue;
    }

    alerts.push({
      meterId,
      thresholdPercent: highestCrossedThreshold,
      observedPercent,
      kind: meter.kind,
      scope: meter.scope ?? null,
      resetsAt: currentResetsAt,
      observedAt: meter.observedAt,
      // ALWAYS 'notify' in slice 5. 'hold' is reserved vocabulary for slice 7's
      // brake (rule 0.5); no code path in this package sets it, by design.
      disposition: 'notify',
    });
  }

  return alerts;
}

// Fold a freshly-emitted alert into an alert memory, returning a new memory.
// The daemon rebuilds its memory from the event log instead; this exists so a
// caller evaluating several polls in a row (and every test of edge-triggering)
// uses the SAME folding rule the log implies, rather than a second one.
export function rememberMeterAlert(
  memory: MeterAlertMemory,
  alert: MeterAlertPayload,
): MeterAlertMemory {
  const priorAlerts = memory[alert.meterId] ?? [];
  return {
    ...memory,
    [alert.meterId]: [
      ...priorAlerts,
      {
        thresholdPercent: alert.thresholdPercent,
        resetsAt: alert.resetsAt ?? null,
        observedAt: alert.observedAt,
      },
    ],
  };
}
