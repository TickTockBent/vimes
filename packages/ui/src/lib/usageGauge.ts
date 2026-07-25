// Pure model for the ACTIVE USAGE GAUGE (slice 6b, unit 3b) — the first-class
// usage instrument in the top bar: the BINDING constraint always visible, plus a
// click-to-expand pulldown of every window. No Vue, no DOM, no I/O; every branch
// is unit-tested without a browser (the .vue is glue over this).
//
// THIS IS WIRING, NOT NEW LOGIC. Every per-meter figure is produced by
// `deriveMeterRow` — the single authority for a meter's honest rendering, shared
// with the session-list and stream strips (principle 9). This module adds ONLY:
//   1. binding selection (which constraint the gauge leads with), and
//   2. reshaping the daemon-ordered rows into a { binding, constraints } view.
//
// THE HONEST-UNKNOWN RULE (pillar 4) is inherited wholesale from `deriveMeterRow`
// and `meterValueLabel`: a non-fresh or unobserved meter has `displayPercent ===
// null` (rendered as words — "stale" / "usage unknown" — never as 0 or a
// confident bar) and `tone === 'unknown'`. This module never coerces those; it
// only carries them through.
//
// THE CLOCK IS THE SERVER'S. `nowMs` is the server-anchored now (observedNow
// advanced by LOCAL elapsed time since the response landed) that the .vue
// computes exactly as `usageStripModel` does — never `Date.now()`. From it and
// `body.observedNow` this module recovers the same `elapsedSinceResponseMs` the
// strip uses, so the daemon's per-meter `ageMs` measurement is preferred (and
// client clock skew still cancels) rather than mixing a daemon-now with a
// source-stamped observedAt.

import {
  deriveMeterRow,
  meterValueLabel,
  type DerivedMeter,
  type DerivedUsageBody,
  type MeterFreshness,
  type MeterRow,
  type MeterRowContext,
  type MeterTone,
} from './meterDisplay.js';

// One constraint as the gauge renders it. A thin projection of `MeterRow` (which
// already carries every honest figure) plus the pre-rendered value word and the
// gauge's own "is this the binding one" flag.
export interface GaugeMeterVM {
  meterId: string;
  label: string;
  tone: MeterTone;
  freshness: MeterFreshness;
  // THE INTEGRITY RULE: null unless fresh AND finite — the bar must NOT fill (and
  // the number must NOT render) when this is null. The view shows an unknown/
  // stale track and a word instead.
  displayPercent: number | null;
  // meterValueLabel(row): "82%" when confident, else the honest word ("stale" /
  // "usage unknown"). Never a fabricated number.
  valueLabel: string;
  resetLabel: string | null;
  burnRateLabel: string;
  exhaustionLabel: string;
  ageLabel: string;
  // Whether THIS is the constraint the gauge leads with. For an `isActive` meter
  // this equals the source's own flag; for a fallback selection it is set here
  // (and `MeterRow.isBinding` — raw `isActive` — may be false), so the pulldown's
  // "Binding" chip always marks the same row the collapsed gauge shows.
  isBinding: boolean;
}

// How the binding constraint was chosen — surfaced so the view (and tests) can
// tell an authoritative selection from a graceful fallback, and so a fallback can
// be labelled honestly rather than masquerading as the source's own judgement.
export type BindingSelection =
  // The source flagged exactly this meter `isActive` (D26/U1 — its judgement).
  | 'active'
  // No `isActive` anywhere; picked the highest CONFIDENT (fresh) percent.
  | 'fallback-highest'
  // No `isActive` and nothing confident to compare; fell back to the daemon's
  // first meter (the list is already binding-first ordered).
  | 'fallback-first'
  // No meters at all — the gauge shows an honest "usage —" state, not a fake one.
  | 'none';

export interface UsageGaugeModel {
  // The lead constraint, or null when there is nothing to show (empty meters).
  binding: GaugeMeterVM | null;
  // Every constraint, in the daemon's binding-first order (preserved verbatim —
  // one ordering authority, principle 9). Includes the binding one.
  constraints: GaugeMeterVM[];
  // The server-anchored now the countdowns/ages were computed against (echoed
  // for the view; null when it could not be anchored).
  nowMs: number | null;
  bindingSelection: BindingSelection;
  meterCount: number;
}

// Epoch ms for an ISO string, or null — local mirror (parseIsoToEpochMs is module
// -private in meterDisplay). Never throws.
function isoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMs = Date.parse(isoTimestamp);
  return Number.isFinite(epochMs) ? epochMs : null;
}

function toGaugeMeterVM(row: MeterRow): GaugeMeterVM {
  return {
    meterId: row.meterId,
    label: row.label,
    tone: row.tone,
    freshness: row.freshness,
    displayPercent: row.displayPercent,
    valueLabel: meterValueLabel(row),
    resetLabel: row.resetLabel,
    burnRateLabel: row.burnRateLabel,
    exhaustionLabel: row.exhaustionLabel,
    ageLabel: row.ageLabel,
    isBinding: row.isBinding,
  };
}

/**
 * Choose which constraint the gauge leads with, returning its index in
 * `constraints` (or -1 when there is none).
 *
 * Order of preference:
 *   1. the meter the source flagged `isActive` (its own judgement wins — D26/U1),
 *   2. else the highest CONFIDENT (fresh, finite) percent — an honest "worst
 *      known" when the source gives no flag,
 *   3. else the daemon's first meter (already binding-first ordered) — used when
 *      nothing is confident enough to rank.
 */
function selectBindingIndex(rows: MeterRow[]): { index: number; selection: BindingSelection } {
  if (rows.length === 0) {
    return { index: -1, selection: 'none' };
  }
  const activeIndex = rows.findIndex((row) => row.isBinding);
  if (activeIndex !== -1) {
    return { index: activeIndex, selection: 'active' };
  }
  let highestIndex = -1;
  let highestPercent = -1;
  rows.forEach((row, index) => {
    if (row.displayPercent !== null && row.displayPercent > highestPercent) {
      highestPercent = row.displayPercent;
      highestIndex = index;
    }
  });
  if (highestIndex !== -1) {
    return { index: highestIndex, selection: 'fallback-highest' };
  }
  return { index: 0, selection: 'fallback-first' };
}

/**
 * Build the gauge model from a derived usage body and the SERVER-ANCHORED now.
 *
 * `body` may be null (nothing fetched yet) → an empty, honest model. `nowMs` is
 * the anchored now the .vue computed (observedNow + local elapsed); this fn
 * recovers `elapsedSinceResponseMs` from it and `body.observedNow` so it can
 * reuse `deriveMeterRow` unchanged — the same ticking, daemon-anchored ages the
 * rest of the app shows.
 */
export function buildUsageGaugeModel(
  body: DerivedUsageBody | null | undefined,
  nowMs: number | null,
): UsageGaugeModel {
  if (body === null || body === undefined) {
    return { binding: null, constraints: [], nowMs, bindingSelection: 'none', meterCount: 0 };
  }
  const staleAfterMs =
    typeof body.staleAfterMs === 'number' && Number.isFinite(body.staleAfterMs) ? body.staleAfterMs : null;
  const observedNowMs = isoToEpochMs(body.observedNow);
  // Recover the local elapsed the .vue folded into nowMs. Never negative: a
  // reading must not appear to grow younger. When either end is unknown, 0 — the
  // observedAt-fallback branch in deriveMeterRow then anchors the age instead.
  const elapsedSinceResponseMs =
    nowMs !== null && observedNowMs !== null ? Math.max(0, nowMs - observedNowMs) : 0;
  const context: MeterRowContext = { nowMs, staleAfterMs, elapsedSinceResponseMs };
  const meters = Array.isArray(body.meters) ? body.meters : [];
  const rows = meters
    .filter((meter): meter is DerivedMeter => meter !== null && typeof meter === 'object')
    .map((meter) => deriveMeterRow(meter, context));

  const { index: bindingIndex, selection } = selectBindingIndex(rows);
  const constraints = rows.map(toGaugeMeterVM);
  // The gauge's binding flag: true ONLY on the selected row, even for a fallback
  // where the source set no `isActive` — so the collapsed gauge and the pulldown
  // chip never disagree about which one is binding.
  constraints.forEach((vm, index) => {
    vm.isBinding = index === bindingIndex;
  });
  const binding = bindingIndex === -1 ? null : (constraints[bindingIndex] ?? null);

  return { binding, constraints, nowMs, bindingSelection: selection, meterCount: rows.length };
}
