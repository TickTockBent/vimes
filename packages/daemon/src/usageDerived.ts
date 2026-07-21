import {
  burnRatePercentPerHour,
  headroomPercent,
  meterFreshness,
  meterHistory,
  projectedExhaustionWithReason,
  type ExhaustionReason,
  type MeterFreshness,
  type MeterRecord,
  type MetersState,
} from '@vimes/core';

// ─── The derived usage READ MODEL (slice 5 step 4b, deliverable 1) ────────────
//
// WHY THIS IS NOT A PROJECTION. Every field below is a function of *now*, and
// projection state is snapshot/replay byte-identical by construction — the
// nondeterminism gate exists precisely to keep clocks out of core state (rule
// 0.3). So the DAEMON stamps `nowIso` at the boundary and calls the pure,
// already-tested functions in `meterDerivations.ts`. None of this is stored
// (D26); none of it rides `/api/projections/meters`.
//
// THE INVARIANT, restated for this file: **null means UNKNOWN, and nothing here
// may degrade to 0.** A meter we cannot age, cannot rate, cannot project is
// served as null — never as a confident zero, which a caller would read as a
// number.

// ─── staleAfterMs is DERIVED from the poll interval (deliverable 1b) ─────────
//
// The recorded finding (calibration 2026-07-21, "meter freshness is BINARY, and
// the fresh band is wider than the poll interval"): the daemon's poll cadence
// and the UI's stale threshold were two independent ⟨tune⟩ constants living in
// two packages, meaningful only RELATIVE to each other, with nothing enforcing
// the relationship. Result: a single missed poll still rendered as "fresh".
//
// The fix is one number with one owner. The daemon derives the staleness band
// from the cadence it actually polls at and SERVES it; the UI consumes it rather
// than holding a second opinion.

// ⟨tune PREVIEW⟩ — how many poll intervals of silence a reading may survive
// before it is called stale. NOT PINNED (rule 0.2): the orchestrator's lean,
// implemented here for Wes to calibrate, is that missing roughly ONE poll should
// already be visible rather than two (the old 2× relationship is exactly what
// hid the failure). Calibrate against how often a poll legitimately slips.
export const STALE_POLL_INTERVAL_MULTIPLE_PREVIEW = 1;

// ⟨tune PREVIEW⟩ — slack added on top of the multiple so a poll that merely runs
// a few seconds late (timer jitter, a slow endpoint, an event-loop stall) does
// not flip a perfectly healthy meter to stale on every cycle. NOT PINNED
// (rule 0.2). It is deliberately small relative to the interval: its job is to
// absorb jitter, never to widen the band into another missed poll.
export const STALE_BAND_SLACK_MS_PREVIEW = 30_000;

/**
 * The staleness band for a given poll cadence, or **null when there is none**.
 *
 * A poll interval of 0 means the poller is DISABLED: nothing will ever refresh a
 * meter, so there is no cadence to be measured against and no band to be inside
 * of. Returning 0 would read as "instantly stale" and returning a large number
 * would read as "eternally fresh" — both are claims we cannot make. Null is the
 * honest answer, and callers turn it into `unknown` (never into `fresh`).
 */
export function deriveStaleAfterMs(pollIntervalMs: number): number | null {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return null;
  }
  return pollIntervalMs * STALE_POLL_INTERVAL_MULTIPLE_PREVIEW + STALE_BAND_SLACK_MS_PREVIEW;
}

export interface DerivedMeter extends MeterRecord {
  freshness: MeterFreshness;
  // now − observedAt, in milliseconds. Null when `observedAt` is unparseable.
  // A NEGATIVE value is possible (a source clock ahead of ours) and is reported
  // verbatim rather than clamped: clamping to 0 would manufacture "just now" out
  // of clock skew, which is the same class of lie as a stale number rendered
  // confidently.
  ageMs: number | null;
  headroomPercent: number | null;
  burnRatePercentPerHour: number | null;
  projectedExhaustion: string | null;
  projectedExhaustionReason: ExhaustionReason;
}

export interface DerivedUsageBody {
  // The nowIso the daemon stamped. Everything derived below is relative to it,
  // so a client can reason about the response without trusting its own clock.
  observedNow: string;
  // The staleness band, DERIVED from pollIntervalMs. Null = no band exists
  // (poller disabled) — see deriveStaleAfterMs.
  staleAfterMs: number | null;
  // The cadence itself, so the UI can explain honestly how often this can move.
  pollIntervalMs: number;
  meters: DerivedMeter[];
}

// Deterministic ordering so the list never jitters between fetches: the BINDING
// meter (`isActive`) first, then by `meterId`. The UI already relies on this
// rule for the meters strip; it is matched here rather than re-invented.
function compareMeters(left: MeterRecord, right: MeterRecord): number {
  const leftIsBinding = left.isActive === true ? 0 : 1;
  const rightIsBinding = right.isActive === true ? 0 : 1;
  if (leftIsBinding !== rightIsBinding) {
    return leftIsBinding - rightIsBinding;
  }
  return left.meterId < right.meterId ? -1 : left.meterId > right.meterId ? 1 : 0;
}

function parseIsoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMilliseconds = Date.parse(isoTimestamp);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : null;
}

export interface DeriveUsageArgs {
  metersState: MetersState;
  // INJECTED at the boundary (rule 0.3) — this module never reads a clock.
  nowIso: string;
  pollIntervalMs: number;
}

/**
 * Build the derived read model. Pure: `nowIso` and the cadence are arguments.
 *
 * With no meters at all this returns the envelope with an EMPTY array — never a
 * 404, never a synthetic zero meter. "We have no observations" is a real answer
 * and it has to be servable.
 */
export function buildDerivedUsage(args: DeriveUsageArgs): DerivedUsageBody {
  const staleAfterMs = deriveStaleAfterMs(args.pollIntervalMs);
  const nowMs = parseIsoToEpochMs(args.nowIso);
  const orderedMeters = Object.values(args.metersState.meters).sort(compareMeters);

  const derivedMeters = orderedMeters.map((meterRecord): DerivedMeter => {
    const observedAtMs = parseIsoToEpochMs(meterRecord.observedAt);
    const history = meterHistory(args.metersState, meterRecord.meterId);
    const exhaustion = projectedExhaustionWithReason(meterRecord, history, args.nowIso);
    return {
      // Every MeterRecord field, verbatim and unaltered — the derived fields are
      // ADDITIVE. Nothing the source said is rewritten here.
      ...meterRecord,
      // No band → we cannot judge freshness at all, so every meter is 'unknown'.
      // NOT 'fresh': a disabled poller means nothing is refreshing these, which
      // is the opposite of confidence.
      freshness:
        staleAfterMs === null
          ? 'unknown'
          : meterFreshness(meterRecord.observedAt, args.nowIso, staleAfterMs),
      ageMs: observedAtMs === null || nowMs === null ? null : nowMs - observedAtMs,
      headroomPercent: headroomPercent(meterRecord),
      burnRatePercentPerHour: burnRatePercentPerHour(history, args.nowIso),
      projectedExhaustion: exhaustion.at,
      projectedExhaustionReason: exhaustion.reason,
    };
  });

  return {
    observedNow: args.nowIso,
    staleAfterMs,
    pollIntervalMs: args.pollIntervalMs,
    meters: derivedMeters,
  };
}
