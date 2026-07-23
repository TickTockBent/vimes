// Pure derivation for the usage-meters strip (slice 5, step 3 → step 4c) —
// turns the DERIVED usage read model (GET /api/usage/derived) into display rows.
// No Vue, no DOM, no I/O: every branch is unit-tested without a browser.
//
// THE INTEGRITY RULE (pillar 4 — "a meter that lies is worse than no meter",
// and the slice-5 kill criterion made concrete): a non-fresh observation is
// NEVER rendered as a current number, and an unobserved percentage is NEVER
// rendered as 0 or as "fine". Both collapse into `displayPercent === null`,
// which the view must render as words ("stale" / "usage unknown"), never as a
// figure.
//
// THE SHARPENED INVARIANT (step 4c, from the 2026-07-21 finding "meter
// freshness is BINARY, and the fresh band is wider than the poll interval"):
// **a reading's AGE is always visible; freshness is a gradient the user can
// see, not a binary the code decides for them.** A three-second-old reading and
// a nine-minute-old reading used to render identically as a bare confident
// number; every row now carries an `ageLabel` that counts up on screen.
//
// AND THE CLOCK IT COUNTS AGAINST IS THE SERVER'S, NOT THE BROWSER'S. The
// daemon stamps `observedNow` and a per-meter `ageMs` measured against its own
// clock; this module advances that baseline only by LOCAL ELAPSED TIME since
// the response landed. A client whose clock is wrong by an hour therefore still
// sees the true age: the local clock contributes a *difference* of two of its
// own readings, never an absolute. A "3 seconds ago" that actually means "we
// re-fetched a six-hour-old 401-blocked reading three seconds ago" is precisely
// the lie this slice exists to prevent.
//
// D26 (binding): the authoritative source reports PERCENTAGES ONLY. `used` /
// `limit` are usually absent, so nothing here ever renders a token or dollar
// figure — see the deliberate absence of any absolute in `MeterRow`.
//
// @vimes/core is deliberately NOT a dependency of packages/ui (see the header
// of lib/types.ts), so the shapes below are mirrored narrowly here exactly as
// lib/cacheBadge.ts and lib/gitReview.ts mirror theirs. Every derivation this
// strip needs is now computed server-side (packages/daemon/src/usageDerived.ts)
// — that is the point of the derived endpoint.

import { formatDuration } from './duration.js';

// ── Mirrored wire shapes ────────────────────────────────────────────────────

export type MeterKind = 'rolling-window' | 'weekly-cap' | 'monthly-credit';

// Mirrors packages/core/src/schemas.ts `meterRecordSchema` (D26), narrowed to
// the fields this strip reads. Unknown keys are tolerated and ignored (rule
// 0.6 — the source's schema visibly churns; spike U1).
export interface MeterRecord {
  meterId: string;
  // A free string on the wire; an unrecognized kind must never throw.
  kind: MeterKind | string;
  scope?: string | null;
  // 0..100, or absent when never observed. ABSENT MEANS UNKNOWN, never 0.
  percent?: number | null;
  // The server's own judgement (U1) — preferred over any local threshold.
  severity?: string | null;
  // Whether this is the currently BINDING limit, per the source (U1).
  isActive?: boolean | null;
  // Absent is NORMAL, not an error: at rollover the endpoint drops `resets_at`
  // for a window sitting at 0% (observed live 2026-07-21).
  resetsAt?: string | null;
  source?: string;
  // Required on every sample so freshness is always derivable.
  observedAt: string;
}

// Mirrors packages/daemon/src/usageDerived.ts `DerivedMeter`: every MeterRecord
// field verbatim, plus the daemon's additive derivations. Each addition is
// optional here because the UI must survive an older daemon without inventing
// values — an absent derivation reads as UNKNOWN, never as 0.
export type MeterFreshness = 'fresh' | 'stale' | 'unknown';

// Mirrors packages/core/src/meterDerivations.ts `ExhaustionReason`. Typed as a
// union widened with `string` on purpose (rule 0.6): a reason word we have
// never seen must degrade to a generic phrase, never crash and never be
// rendered raw at the user.
export type ExhaustionReason =
  | 'projected'
  | 'meter-never-observed'
  | 'percent-unobserved'
  | 'already-exhausted'
  | 'observation-unusable'
  | 'burn-rate-unknown'
  | 'burn-rate-non-positive'
  | 'resets-first'
  | (string & {});

export interface DerivedMeter extends MeterRecord {
  freshness?: MeterFreshness | string | null;
  // now − observedAt as the DAEMON measured it. May be NEGATIVE when the
  // source's clock runs ahead of the daemon's; that is reported verbatim rather
  // than clamped, and this module renders it as "just now" (never as a negative
  // duration, and never as a reason to call something falsely fresh).
  ageMs?: number | null;
  headroomPercent?: number | null;
  burnRatePercentPerHour?: number | null;
  projectedExhaustion?: string | null;
  projectedExhaustionReason?: ExhaustionReason | null;
}

// Mirrors packages/daemon/src/usageDerived.ts `DerivedUsageBody`.
export interface DerivedUsageBody {
  observedNow?: string | null;
  // THE SINGLE AUTHORITY for the staleness band (see the deleted local
  // constant, below). `null` = the daemon says the poller is DISABLED and there
  // is no meaningful freshness band at all.
  staleAfterMs?: number | null;
  pollIntervalMs?: number | null;
  // Already ordered by the daemon (binding first, then meterId). PRESERVED
  // here, never re-sorted — one ordering authority (principle 9).
  meters?: DerivedMeter[] | null;
}

// Mirrors the `refresh` envelope of POST /api/usage/refresh. That route always
// returns 200: a throttled refresh still hands back a complete honest read
// model, so it is not an error.
export interface UsageRefreshOutcome {
  polled: boolean;
  throttled: boolean;
  failureReason: string | null;
  httpStatus: number | null;
  nextForcedPollAt: string | null;
  retryAfterMs: number | null;
}

/**
 * A fetched derived body plus the LOCAL clock reading at the moment it landed.
 *
 * The pairing is the whole trick: `body` is anchored to the daemon's clock and
 * `receivedAtLocalMs` is only ever subtracted from another reading of the same
 * local clock, so client skew cancels out instead of leaking into an age.
 */
export interface UsageSnapshot {
  body: DerivedUsageBody;
  receivedAtLocalMs: number;
}

// ── Display shapes ──────────────────────────────────────────────────────────

// Semantic tone key only — the template maps this to a color class; this lib
// never touches Tailwind/CSS (same split as cacheBadge.ts).
export type MeterTone = 'normal' | 'elevated' | 'high' | 'unknown';

export interface MeterRow {
  meterId: string;
  label: string;
  // THE INTEGRITY RULE: null unless the observation is fresh AND a finite
  // percent exists. Null is rendered as words, never as a number.
  displayPercent: number | null;
  freshness: MeterFreshness;
  isBinding: boolean;
  // Raw server severity passthrough, or null when the source gave none.
  severity: string | null;
  resetLabel: string | null;
  tone: MeterTone;
  // The reading's age RIGHT NOW (server-anchored baseline + local elapsed).
  // Null when the daemon could not age the observation at all.
  ageMs: number | null;
  // Always present — a meter that hides how old it is overstates its precision.
  ageLabel: string;
  // Never a fabricated 0: absent burn rate says so in words.
  burnRateLabel: string;
  // Never the raw enum: `resets-first` becomes reassurance, `burn-rate-unknown`
  // becomes "not enough samples yet".
  exhaustionLabel: string;
}

// The whole strip's model — rows plus the band that produced their freshness,
// so the view can explain WHY everything reads unknown when the poller is off.
export interface UsageStripModel {
  rows: MeterRow[];
  // The server-anchored "now" the countdowns and ages were computed against.
  nowMs: number | null;
  // Echoed from the response: null = no band exists (poller disabled).
  staleAfterMs: number | null;
  pollIntervalMs: number | null;
  // True when there is no freshness band, i.e. every row is 'unknown' by
  // construction and the view should say so rather than imply a dead poller is
  // a transient hiccup.
  freshnessBandMissing: boolean;
}

// ── ⟨tune PREVIEW⟩ bands — NOT PINNED (rule 0.2) ────────────────────────────
// These shape only colour, never a verdict or a number, and they are used ONLY
// when the source supplies no `severity` of its own (U1: it usually does, and
// the server's judgement beats anything invented locally). They are named
// constants carrying their ⟨tune⟩ marker precisely so calibration can pin them
// later with evidence + sign-off; nothing downstream may treat them as settled.

// ⟨tune 60% PREVIEW⟩ — percent at or above which an unclassified meter reads
// "elevated". Unpinned.
export const ELEVATED_PERCENT_PREVIEW = 60;
// ⟨tune 80% PREVIEW⟩ — percent at or above which an unclassified meter reads
// "high". Unpinned; mirrors the slice-5 notification threshold's preview value
// so the two calibrate together rather than drifting apart.
export const HIGH_PERCENT_PREVIEW = 80;

// DELIBERATELY ABSENT: `METER_STALE_AFTER_MS_PREVIEW`. It was a SECOND COPY of
// a number the daemon owns and derives from its own poll interval, and that
// duplication was the root cause of the 2026-07-21 freshness finding (principle
// 9 violated on a derived RELATIONSHIP rather than on a fact). The band now
// arrives as `staleAfterMs` in the response and there is exactly one authority.
// A response that carries no band at all is not an excuse to invent one: it
// means UNKNOWN.

// Known server severity strings (U1 observed `normal`) mapped onto tones. An
// unrecognized severity falls through to percent banding rather than being
// guessed at — the source may add words we have never seen (rule 0.6).
const SEVERITY_TONE: Readonly<Record<string, MeterTone>> = {
  normal: 'normal',
  ok: 'normal',
  low: 'normal',
  elevated: 'elevated',
  warn: 'elevated',
  warning: 'elevated',
  moderate: 'elevated',
  high: 'high',
  critical: 'high',
  severe: 'high',
  exceeded: 'high',
};

const KIND_LABEL: Readonly<Record<MeterKind, string>> = {
  'rolling-window': '5-hour session',
  'weekly-cap': 'Weekly',
  'monthly-credit': 'Monthly credit',
};

// ── Parsing helpers ─────────────────────────────────────────────────────────

// Epoch ms for an ISO timestamp, or null when absent/unparseable. Never throws.
function parseIsoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMs = Date.parse(isoTimestamp);
  return Number.isFinite(epochMs) ? epochMs : null;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── Freshness ───────────────────────────────────────────────────────────────

/**
 * Freshness from an AGE and a band. Derived, never stored (D26) — a stored flag
 * lets a stale record masquerade as fresh.
 *
 * `staleAfterMs === null` means the daemon told us there is NO band (the poller
 * is disabled), and the honest answer is `unknown` for every meter: not `fresh`
 * (nothing is refreshing these, which is the opposite of confidence) and not a
 * band of 0 (which would read as instantly stale). An unknowable age is
 * likewise `unknown`.
 *
 * A NEGATIVE age (source clock ahead of ours) is fresh, not stale — but note it
 * can only ever make a reading look *newer than zero seconds old*, which the
 * label renders as "just now"; it can never flip a genuinely old reading fresh,
 * because the age it is compared against is the daemon's own measurement.
 */
export function freshnessFromAge(
  ageMs: number | null,
  staleAfterMs: number | null,
): MeterFreshness {
  if (staleAfterMs === null || !Number.isFinite(staleAfterMs) || ageMs === null) {
    return 'unknown';
  }
  return ageMs > staleAfterMs ? 'stale' : 'fresh';
}

/**
 * Freshness for a raw `observedAt` against an injected now. Retained for the
 * fallback path where the daemon supplied no `ageMs` — `nowMs` must still be
 * the SERVER-ANCHORED now (see `usageStripModel`), never `Date.now()`.
 */
export function meterFreshness(
  observedAt: string | null | undefined,
  nowMs: number | null,
  staleAfterMs: number | null,
): MeterFreshness {
  const observedAtMs = parseIsoToEpochMs(observedAt);
  if (observedAtMs === null || nowMs === null || !Number.isFinite(nowMs)) {
    return 'unknown';
  }
  return freshnessFromAge(nowMs - observedAtMs, staleAfterMs);
}

// ── Labels ──────────────────────────────────────────────────────────────────

// Human label from kind + scope. Never throws on an unrecognized kind — the
// source's meter set is presumed to drift (rule 0.6), so an unknown kind falls
// back to something derived from the meterId rather than blowing up the strip.
export function meterLabel(record: MeterRecord): string {
  const scopeLabel = typeof record.scope === 'string' && record.scope.trim().length > 0 ? record.scope.trim() : null;
  if (record.kind === 'weekly-cap') {
    return scopeLabel === null ? 'Weekly (all models)' : `Weekly (${scopeLabel})`;
  }
  const knownKindLabel = KIND_LABEL[record.kind as MeterKind];
  if (knownKindLabel !== undefined) {
    return scopeLabel === null ? knownKindLabel : `${knownKindLabel} (${scopeLabel})`;
  }
  return fallbackLabelFromMeterId(record.meterId, scopeLabel);
}

// "endpoint:weekly_all" → "Weekly all"; an empty/absent id → "Usage".
function fallbackLabelFromMeterId(meterId: string, scopeLabel: string | null): string {
  const idTail = typeof meterId === 'string' ? (meterId.split(':').pop() ?? '') : '';
  const words = idTail.replace(/[_-]+/g, ' ').trim();
  if (words.length === 0) {
    return scopeLabel === null ? 'Usage' : `Usage (${scopeLabel})`;
  }
  const sentenceCased = words.charAt(0).toUpperCase() + words.slice(1);
  return scopeLabel === null ? sentenceCased : `${sentenceCased} (${scopeLabel})`;
}

// ── Durations ───────────────────────────────────────────────────────────────

// `formatDuration` (the deterministic, LOCALE-FREE elapsed-span formatter) now
// lives in ./duration.ts so the cache-warmth badge renders "26m" the SAME way
// this strip does — one age formatter, not two (principle 9).

/**
 * The age line. This is the user-facing half of the sharpened invariant, so it
 * is never allowed to be absent or flattering:
 *
 * - `null` age → "age unknown" (we could not age it — say so, do not omit it).
 * - NEGATIVE age (a source clock ahead of the daemon's) → "just now". Rendering
 *   "-4s ago" would be nonsense, and clamping it into a *fresher* claim than
 *   zero is impossible because zero is already the freshest claim there is.
 * - otherwise a plain elapsed span, seconds through days.
 */
export function formatObservationAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) {
    return 'age unknown';
  }
  if (ageMs < 1000) {
    // Includes the negative (clock-skew) case.
    return 'updated just now';
  }
  return `updated ${formatDuration(ageMs)} ago`;
}

// Deterministic, LOCALE-FREE reset countdown. null when `resetsAt` is absent or
// unparseable: the strip then shows no countdown at all rather than a
// fabricated one. Absent `resetsAt` is NORMAL for a freshly-rolled window
// sitting at 0% (observed live 2026-07-21) — the view says so calmly.
export function formatResetCountdown(resetsAt: string | null | undefined, nowMs: number | null): string | null {
  const resetsAtMs = parseIsoToEpochMs(resetsAt);
  if (resetsAtMs === null || nowMs === null || !Number.isFinite(nowMs)) {
    return null;
  }
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= 0) {
    // Already past: the window has rolled over but we have not observed the
    // post-reset sample yet, so we say so instead of claiming a duration.
    return 'resetting…';
  }
  if (remainingMs < 60_000) {
    return 'resets in <1m';
  }
  return `resets in ${formatDuration(remainingMs)}`;
}

// ── Burn rate and projected exhaustion (deliverable 5) ──────────────────────

/**
 * Burn rate in percent per hour. **Null is UNKNOWN, never 0** — "we cannot see
 * a rate" and "you are burning nothing" are opposite facts to someone deciding
 * whether to start work.
 */
export function formatBurnRate(burnRatePercentPerHour: number | null | undefined): string {
  const burnRate = finiteNumberOrNull(burnRatePercentPerHour);
  if (burnRate === null) {
    return 'burn rate unknown';
  }
  if (burnRate <= 0) {
    // A real, observed non-positive rate — distinct from "unknown" above.
    return 'not rising';
  }
  const rounded = burnRate >= 10 ? Math.round(burnRate) : Math.round(burnRate * 10) / 10;
  return `${rounded}%/h`;
}

// The reason enum turned into something a human can act on. The raw enum string
// is NEVER rendered: `resets-first` is reassuring ("the window rolls over before
// you'd run out") while `burn-rate-unknown` is merely uninformative, and a user
// cannot tell those apart from the identifier. An unrecognized reason (rule 0.6
// — the vocabulary may grow) degrades to a generic honest phrase.
const EXHAUSTION_REASON_LABEL: Readonly<Record<string, string>> = {
  'resets-first': 'resets before you run out',
  'burn-rate-unknown': 'not enough samples to project yet',
  'burn-rate-non-positive': 'usage is flat — no exhaustion in sight',
  'already-exhausted': 'no headroom left',
  'percent-unobserved': 'usage not observed — cannot project',
  'meter-never-observed': 'never observed — cannot project',
  'observation-unusable': 'observation unusable — cannot project',
};

/**
 * The projected-exhaustion line. `projectedExhaustion` non-null wins; otherwise
 * the REASON is translated, because a bare "unknown" throws away the difference
 * between reassurance and ignorance.
 */
export function formatProjectedExhaustion(
  projectedExhaustion: string | null | undefined,
  projectedExhaustionReason: ExhaustionReason | null | undefined,
  nowMs: number | null,
): string {
  const exhaustionAtMs = parseIsoToEpochMs(projectedExhaustion);
  if (exhaustionAtMs !== null && nowMs !== null && Number.isFinite(nowMs)) {
    const remainingMs = exhaustionAtMs - nowMs;
    if (remainingMs <= 0) {
      return 'projected to run out now';
    }
    return `projected to run out in ${formatDuration(remainingMs)}`;
  }
  const reasonLabel =
    typeof projectedExhaustionReason === 'string'
      ? EXHAUSTION_REASON_LABEL[projectedExhaustionReason]
      : undefined;
  return reasonLabel ?? 'no exhaustion projection';
}

// ── Tone ────────────────────────────────────────────────────────────────────

// Prefer the server's severity (U1: it ships one, and its judgement beats a
// locally invented threshold — D26). Fall back to the unpinned ⟨tune PREVIEW⟩
// bands only when severity is absent or unrecognized.
function meterTone(severity: string | null, displayPercent: number | null): MeterTone {
  if (displayPercent === null) {
    // Nothing renderable: 'unknown' is its own tone, never 'normal' — an
    // unknown meter must not read as "fine".
    return 'unknown';
  }
  if (severity !== null) {
    const severityTone = SEVERITY_TONE[severity.trim().toLowerCase()];
    if (severityTone !== undefined) {
      return severityTone;
    }
  }
  if (displayPercent >= HIGH_PERCENT_PREVIEW) {
    return 'high';
  }
  if (displayPercent >= ELEVATED_PERCENT_PREVIEW) {
    return 'elevated';
  }
  return 'normal';
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface MeterRowContext {
  // The SERVER-ANCHORED now (observedNow advanced by local elapsed time).
  nowMs: number | null;
  // The band from the response. Null = no band exists → every row 'unknown'.
  staleAfterMs: number | null;
  // Local ms elapsed since the response landed, added to each baseline age.
  elapsedSinceResponseMs: number;
}

/**
 * One display row. THE INTEGRITY RULE lives in `displayPercent`: it is null
 * unless the observation is FRESH and the record carries a FINITE percent. A
 * stale record holding a real percent therefore yields null — the last known
 * figure is never shown as if it were now.
 */
export function deriveMeterRow(meter: DerivedMeter, context: MeterRowContext): MeterRow {
  const baselineAgeMs = finiteNumberOrNull(meter.ageMs);
  const observedAtMs = parseIsoToEpochMs(meter.observedAt);
  // Prefer the daemon's own measurement; fall back to the server-anchored now
  // minus observedAt. Both are measured against the DAEMON's clock — the local
  // clock only ever contributes `elapsedSinceResponseMs`, a difference of two
  // readings of the same clock, so client skew cancels instead of accumulating.
  const currentAgeMs =
    baselineAgeMs !== null
      ? baselineAgeMs + context.elapsedSinceResponseMs
      : observedAtMs !== null && context.nowMs !== null
        ? context.nowMs - observedAtMs
        : null;
  // Freshness is RE-DERIVED locally against the ticking age, not taken from the
  // response's `freshness` field: that field was true when the response was
  // built, and a reading must be able to go stale on screen between fetches.
  // The band is still the server's.
  const freshness = freshnessFromAge(currentAgeMs, context.staleAfterMs);
  const observedPercent = finiteNumberOrNull(meter.percent);
  const displayPercent = freshness === 'fresh' && observedPercent !== null ? clampPercent(observedPercent) : null;
  const severity = typeof meter.severity === 'string' && meter.severity.length > 0 ? meter.severity : null;
  return {
    meterId: meter.meterId,
    label: meterLabel(meter),
    displayPercent,
    freshness,
    isBinding: meter.isActive === true,
    severity,
    resetLabel: formatResetCountdown(meter.resetsAt, context.nowMs),
    tone: meterTone(severity, displayPercent),
    ageMs: currentAgeMs,
    ageLabel: formatObservationAge(currentAgeMs),
    burnRateLabel: formatBurnRate(meter.burnRatePercentPerHour),
    exhaustionLabel: formatProjectedExhaustion(
      meter.projectedExhaustion,
      meter.projectedExhaustionReason,
      context.nowMs,
    ),
  };
}

// Defensive 0..100 clamp on an already-finite percent — a meter never renders a
// nonsensical figure, and rounding keeps the bar and the text agreeing.
function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * The whole strip, from a fetched snapshot and the CURRENT local clock reading.
 *
 * Ordering is the daemon's (binding first, then meterId) and is preserved
 * verbatim — re-sorting here would make two authorities out of one and let the
 * list jitter between fetches.
 */
export function usageStripModel(
  snapshot: UsageSnapshot | null | undefined,
  localNowMs: number,
): UsageStripModel {
  if (snapshot === null || snapshot === undefined) {
    return { rows: [], nowMs: null, staleAfterMs: null, pollIntervalMs: null, freshnessBandMissing: true };
  }
  const staleAfterMs = finiteNumberOrNull(snapshot.body.staleAfterMs);
  const observedNowMs = parseIsoToEpochMs(snapshot.body.observedNow);
  // Local elapsed time only. Never negative: a clock that jumps backwards must
  // not make a reading appear to grow younger.
  const elapsedSinceResponseMs =
    Number.isFinite(localNowMs) && Number.isFinite(snapshot.receivedAtLocalMs)
      ? Math.max(0, localNowMs - snapshot.receivedAtLocalMs)
      : 0;
  const nowMs = observedNowMs === null ? null : observedNowMs + elapsedSinceResponseMs;
  const context: MeterRowContext = { nowMs, staleAfterMs, elapsedSinceResponseMs };
  const meters = Array.isArray(snapshot.body.meters) ? snapshot.body.meters : [];
  const rows = meters
    .filter((meter): meter is DerivedMeter => meter !== null && typeof meter === 'object')
    .map((meter) => deriveMeterRow(meter, context));
  return {
    rows,
    nowMs,
    staleAfterMs,
    pollIntervalMs: finiteNumberOrNull(snapshot.body.pollIntervalMs),
    freshnessBandMissing: staleAfterMs === null,
  };
}

// ── The refresh control's message (deliverable 3) ───────────────────────────

export type RefreshNoticeTone = 'success' | 'throttled' | 'failed';

export interface RefreshNotice {
  tone: RefreshNoticeTone;
  message: string;
}

// Failure reasons the daemon classifies (packages/daemon/src/usageEndpoint.ts).
// `request-failed` is the CLIENT's own word for "the POST itself did not land",
// which is a different fact from any server-side classification.
const REFRESH_FAILURE_LABEL: Readonly<Record<string, string>> = {
  'no-credentials': 'no usage credentials available',
  unauthorized: 'the usage token was rejected (it refreshes about every 6h)',
  'http-error': 'the usage endpoint returned an error',
  'network-error': 'the usage endpoint could not be reached',
  unparseable: 'the usage endpoint returned something unreadable',
  'request-failed': 'the request did not reach VIMES',
};

/**
 * Turn a refresh envelope into one honest line.
 *
 * The three cases are kept genuinely distinct, because presenting a throttled
 * or failed refresh as a successful one is the same class of lie as a stale
 * number rendered confidently:
 * - throttled → we did NOT poll; say when the next forced poll is available.
 * - failure   → we polled and it failed; the ages below are UNCHANGED (and have
 *   grown), which is the truth and is left on screen.
 * - success   → a real poll landed.
 */
export function refreshNotice(outcome: UsageRefreshOutcome | null | undefined): RefreshNotice | null {
  if (outcome === null || outcome === undefined) {
    return null;
  }
  if (outcome.throttled) {
    const retryAfterMs = finiteNumberOrNull(outcome.retryAfterMs);
    const waitLabel = retryAfterMs !== null && retryAfterMs > 0 ? ` — try again in ${formatDuration(retryAfterMs)}` : '';
    return { tone: 'throttled', message: `Not refreshed: polled a moment ago${waitLabel}.` };
  }
  if (outcome.failureReason !== null && outcome.failureReason !== undefined) {
    const reasonLabel = REFRESH_FAILURE_LABEL[outcome.failureReason] ?? 'the refresh failed';
    const statusLabel = finiteNumberOrNull(outcome.httpStatus) !== null ? ` (HTTP ${String(outcome.httpStatus)})` : '';
    return {
      tone: 'failed',
      message: `Refresh failed: ${reasonLabel}${statusLabel}. Ages below are unchanged.`,
    };
  }
  if (outcome.polled) {
    return { tone: 'success', message: 'Refreshed from the usage endpoint.' };
  }
  // Neither polled, nor throttled, nor failed: nothing we can honestly claim.
  return { tone: 'failed', message: 'Refresh did not run.' };
}
