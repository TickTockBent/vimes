// Pure derivation for the home-screen usage-meters strip (slice 5 step 3) —
// turns the meters projection (GET /api/projections/meters) into display rows.
// No Vue, no DOM, no I/O: every branch is unit-tested without a browser.
//
// THE INTEGRITY RULE (pillar 4 — "a meter that lies is worse than no meter",
// and the slice-5 kill criterion made concrete): a non-fresh observation is
// NEVER rendered as a current number, and an unobserved percentage is NEVER
// rendered as 0 or as "fine". Both collapse into `displayPercent === null`,
// which the view must render as words ("stale" / "usage unknown"), never as a
// figure. This is the point of the unit, not a detail.
//
// D26 (binding): the authoritative source reports PERCENTAGES ONLY. `used` /
// `limit` are usually absent, so nothing here ever renders a token or dollar
// figure — see the deliberate absence of any absolute in `MeterRow`.
//
// @vimes/core is deliberately NOT a dependency of packages/ui (see the header
// of lib/types.ts), so the shapes below are mirrored narrowly here exactly as
// lib/cacheBadge.ts and lib/gitReview.ts mirror theirs. Freshness deliberately
// re-implements the core rule (packages/core/src/meterDerivations.ts) in the
// same shape rather than importing it.

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
  resetsAt?: string | null;
  source?: string;
  // Required on every sample so freshness is always derivable.
  observedAt: string;
}

// Mirrors packages/core/src/projections/meters.ts `MetersState`. Only `meters`
// is read here; `history` (burn rate / projected exhaustion) is explicitly out
// of this unit — those derivations live in core and the UI may not import it.
export interface MetersState {
  meters?: Record<string, MeterRecord> | null;
}

// ── Display shapes ──────────────────────────────────────────────────────────

export type MeterFreshness = 'fresh' | 'stale' | 'unknown';

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
// ⟨tune 10min PREVIEW⟩ — how old an observation may be before the strip calls
// it stale. Unpinned: the staleness window is explicitly an uncalibrated band
// in core too (`meterFreshness` refuses a default `staleAfterMs`), so this is
// the UI's preview value and callers may override it.
export const METER_STALE_AFTER_MS_PREVIEW = 10 * 60 * 1000;

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

// ── Freshness ───────────────────────────────────────────────────────────────

// Freshness is DERIVED, never stored (D26) — a stored flag lets a stale record
// masquerade as fresh. Three states, and the third is not a synonym for either
// of the others: with no parseable observation we know nothing, which is
// 'unknown'. Mirrors packages/core/src/meterDerivations.ts `meterFreshness`,
// including the rule that a future-dated observation (source/daemon clock skew)
// is fresh, not stale.
export function meterFreshness(
  observedAt: string | null | undefined,
  nowMs: number,
  staleAfterMs: number,
): MeterFreshness {
  const observedAtMs = parseIsoToEpochMs(observedAt);
  if (observedAtMs === null || !Number.isFinite(nowMs)) {
    return 'unknown';
  }
  const observationAgeMs = nowMs - observedAtMs;
  return observationAgeMs > staleAfterMs ? 'stale' : 'fresh';
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

// ── Countdown ───────────────────────────────────────────────────────────────

// Deterministic, LOCALE-FREE reset countdown — no Intl/toLocaleString, which
// vary by environment (rule 0.3 determinism carries into the UI's pure
// derivations too). null when `resetsAt` is absent or unparseable: the strip
// then shows no countdown at all rather than a fabricated one.
export function formatResetCountdown(resetsAt: string | null | undefined, nowMs: number): string | null {
  const resetsAtMs = parseIsoToEpochMs(resetsAt);
  if (resetsAtMs === null || !Number.isFinite(nowMs)) {
    return null;
  }
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= 0) {
    // Already past: the window has rolled over but we have not observed the
    // post-reset sample yet, so we say so instead of claiming a duration.
    return 'resetting…';
  }
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) {
    return 'resets in <1m';
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;
  if (totalHours < 1) {
    return `resets in ${totalMinutes}m`;
  }
  const totalDays = Math.floor(totalHours / 24);
  const remainderHours = totalHours % 24;
  if (totalDays < 1) {
    return `resets in ${totalHours}h ${remainderMinutes}m`;
  }
  return `resets in ${totalDays}d ${remainderHours}h`;
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

// One display row. THE INTEGRITY RULE lives in `displayPercent`: it is null
// unless the observation is FRESH and the record carries a FINITE percent. A
// stale record holding a real percent therefore yields null — the last known
// figure is never shown as if it were now.
export function deriveMeterRow(record: MeterRecord, nowMs: number, staleAfterMs: number): MeterRow {
  const freshness = meterFreshness(record.observedAt, nowMs, staleAfterMs);
  const observedPercent = typeof record.percent === 'number' && Number.isFinite(record.percent) ? record.percent : null;
  const displayPercent = freshness === 'fresh' && observedPercent !== null ? clampPercent(observedPercent) : null;
  const severity = typeof record.severity === 'string' && record.severity.length > 0 ? record.severity : null;
  return {
    meterId: record.meterId,
    label: meterLabel(record),
    displayPercent,
    freshness,
    isBinding: record.isActive === true,
    severity,
    resetLabel: formatResetCountdown(record.resetsAt, nowMs),
    tone: meterTone(severity, displayPercent),
  };
}

// Defensive 0..100 clamp on an already-finite percent — a meter never renders a
// nonsensical figure, and rounding keeps the bar and the text agreeing.
function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

// All rows, BINDING FIRST (the source tells us which limit currently binds —
// that is the one answering "can I afford this?"), then by meterId so the list
// never jitters between fetches (a re-sorting strip reads as noise).
export function deriveMeterRows(
  metersState: MetersState | null | undefined,
  nowMs: number,
  staleAfterMs: number,
): MeterRow[] {
  const meters = metersState?.meters;
  if (meters === null || meters === undefined) {
    return [];
  }
  const rows = Object.values(meters)
    .filter((record): record is MeterRecord => record !== null && typeof record === 'object')
    .map((record) => deriveMeterRow(record, nowMs, staleAfterMs));
  return rows.sort((leftRow, rightRow) => {
    if (leftRow.isBinding !== rightRow.isBinding) {
      return leftRow.isBinding ? -1 : 1;
    }
    return leftRow.meterId < rightRow.meterId ? -1 : leftRow.meterId > rightRow.meterId ? 1 : 0;
  });
}
