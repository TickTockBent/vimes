import { canonicalJson } from '../canonicalJson.js';
import type { EventInput, EventRecord, MeterRecord } from '../schemas.js';
import { meterRecordSchema } from '../schemas.js';
import type { Projection } from './projection.js';

// The meters read model (slice 5 step 1). It honors exactly one honest event —
// `meter_sample` on the 'usage' stream — and keeps two things per meterId:
//   1. the LATEST MeterRecord (upsert by meterId, as the slice-0 stub did), and
//   2. a bounded history of `{ observedAt, percent }` samples, so burn rate and
//      projected exhaustion are computable from the projection alone.
// Everything else is a no-op. Freshness / burn rate / headroom are DERIVED by
// the pure functions in ../meterDerivations.ts with the clock injected (rule
// 0.3) — none of them are stored here, so a stale record can never masquerade
// as fresh (D26).

export const METER_SAMPLE_TYPE = 'meter_sample';
export const USAGE_STREAM = 'usage';

// How many samples per meter the projection retains, oldest dropped first.
// This is a PLAIN CONSTANT, not a ⟨tune⟩ band (rule 0.2): it shapes only
// snapshot size, never a behavioral verdict. Burn rate reads the tail since the
// most recent window reset, and every real source samples on the order of
// minutes, so any bound comfortably covering one window yields the identical
// rate. The number exists so snapshots stay flat under an unbounded event log,
// nothing more — there is no calibration to pin.
export const METER_HISTORY_LIMIT = 64;

export interface MeterHistorySample {
  observedAt: string;
  // 0..100, or null when the sample carried no observed percentage. Null means
  // UNKNOWN and is never coerced to 0 — and a percentage is never manufactured
  // out of used/limit here (D26).
  percent: number | null;
}

export interface MetersState {
  meters: Record<string, MeterRecord>;
  history: Record<string, MeterHistorySample[]>;
}

export const metersProjection: Projection<MetersState> = {
  id: 'meters',

  init(): MetersState {
    return { meters: {}, history: {} };
  },

  apply(state: MetersState, event: EventRecord): MetersState {
    if (event.type !== METER_SAMPLE_TYPE) {
      return state;
    }
    const parsed = meterRecordSchema.safeParse(event.payload);
    if (!parsed.success) {
      return state;
    }
    const meterRecord = parsed.data;
    const priorSamples = state.history[meterRecord.meterId] ?? [];
    // Never mutate `state` — snapshots share references — so every write builds
    // fresh arrays and objects.
    const appendedSamples: MeterHistorySample[] = [
      ...priorSamples,
      { observedAt: meterRecord.observedAt, percent: meterRecord.percent ?? null },
    ];
    const boundedSamples =
      appendedSamples.length > METER_HISTORY_LIMIT
        ? appendedSamples.slice(appendedSamples.length - METER_HISTORY_LIMIT)
        : appendedSamples;
    return {
      meters: { ...state.meters, [meterRecord.meterId]: meterRecord },
      history: { ...state.history, [meterRecord.meterId]: boundedSamples },
    };
  },

  serialize(state: MetersState): string {
    return canonicalJson(state);
  },
};

export function meterSample(meter: MeterRecord): EventInput {
  return { stream: USAGE_STREAM, type: METER_SAMPLE_TYPE, payload: meter };
}

// The retained sample history for one meter, oldest first. Empty when the meter
// has never been observed — an empty history is UNKNOWN, not zero burn.
export function meterHistory(state: MetersState, meterId: string): MeterHistorySample[] {
  return state.history[meterId] ?? [];
}
