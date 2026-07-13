import { canonicalJson } from '../canonicalJson.js';
import type { EventInput, EventRecord, MeterRecord } from '../schemas.js';
import { meterRecordSchema } from '../schemas.js';
import type { Projection } from './projection.js';

// STUB (slice 5 is the meter system). Schema over machinery: it holds a
// MeterRecord map and honors exactly one honest event — `meter_sample` on the
// 'usage' stream, upserting by meterId. Everything else is a no-op.

export const METER_SAMPLE_TYPE = 'meter_sample';
export const USAGE_STREAM = 'usage';

export interface MetersState {
  meters: Record<string, MeterRecord>;
}

export const metersProjection: Projection<MetersState> = {
  id: 'meters',

  init(): MetersState {
    return { meters: {} };
  },

  apply(state: MetersState, event: EventRecord): MetersState {
    if (event.type !== METER_SAMPLE_TYPE) {
      return state;
    }
    const parsed = meterRecordSchema.safeParse(event.payload);
    if (!parsed.success) {
      return state;
    }
    return { meters: { ...state.meters, [parsed.data.meterId]: parsed.data } };
  },

  serialize(state: MetersState): string {
    return canonicalJson(state);
  },
};

export function meterSample(meter: MeterRecord): EventInput {
  return { stream: USAGE_STREAM, type: METER_SAMPLE_TYPE, payload: meter };
}
