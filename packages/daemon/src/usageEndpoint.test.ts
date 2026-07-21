import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MeterRecord } from '@vimes/core';
import {
  createUsageEndpointAdapter,
  parseUsageResponse,
  type UsageHttpFetch,
  type UsageHttpResponse,
} from './usageEndpoint.js';

// ─── The usage-endpoint adapter (slice 5 step 2) ─────────────────────────────
//
// Every test here runs against the REAL captured response
// (fixtures/usage/oauth-usage-2026-07-21.json, spike U1) or against injected
// fakes. NO test touches the network, and NO test touches the real
// ~/.claude/.credentials.json — both seams are always injected.

function readGoldenFixture(): string {
  const fixtureUrl = new URL('../../../fixtures/usage/oauth-usage-2026-07-21.json', import.meta.url);
  return readFileSync(fileURLToPath(fixtureUrl), 'utf8');
}

const GOLDEN_BODY = readGoldenFixture();
const OBSERVED_AT = '2026-07-21T12:00:00.000Z';
// A token-shaped string used ONLY to prove it never escapes into a log line.
const FAKE_ACCESS_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-NEVER-REAL-000000';

function meterById(meters: MeterRecord[], meterId: string): MeterRecord {
  const found = meters.find((candidate) => candidate.meterId === meterId);
  expect(found, `expected a meter with id ${meterId}`).toBeDefined();
  return found as MeterRecord;
}

describe('parseUsageResponse against the golden fixture (U1, real captured body)', () => {
  it('maps the three real limits[] entries onto MeterRecords', () => {
    const meters = parseUsageResponse(GOLDEN_BODY, OBSERVED_AT);
    expect(meters).toHaveLength(3);

    const sessionMeter = meterById(meters, 'endpoint:session');
    expect(sessionMeter.kind).toBe('rolling-window');
    expect(sessionMeter.percent).toBe(29);
    expect(sessionMeter.unit).toBe('percent');
    expect(sessionMeter.severity).toBe('normal');
    expect(sessionMeter.isActive).toBe(false);
    expect(sessionMeter.resetsAt).toBe('2026-07-21T15:19:59.702520+00:00');
    expect(sessionMeter.source).toBe('endpoint');
    expect(sessionMeter.observedAt).toBe(OBSERVED_AT);
    expect(sessionMeter.scope).toBeUndefined();

    const weeklyAllMeter = meterById(meters, 'endpoint:weekly_all');
    expect(weeklyAllMeter.kind).toBe('weekly-cap');
    expect(weeklyAllMeter.percent).toBe(52);
    expect(weeklyAllMeter.isActive).toBe(false);
    expect(weeklyAllMeter.scope).toBeUndefined();

    // The scoped weekly cap carries scope.model.display_name and is the
    // currently BINDING limit.
    const weeklyScopedMeter = meterById(meters, 'endpoint:weekly_scoped:Fable');
    expect(weeklyScopedMeter.kind).toBe('weekly-cap');
    expect(weeklyScopedMeter.percent).toBe(64);
    expect(weeklyScopedMeter.scope).toBe('Fable');
    expect(weeklyScopedMeter.isActive).toBe(true);
  });

  it('D26 GUARD: used/limit are ABSENT on every produced record (never invented)', () => {
    const meters = parseUsageResponse(GOLDEN_BODY, OBSERVED_AT);
    expect(meters.length).toBeGreaterThan(0);
    for (const meterRecord of meters) {
      // Not merely undefined — the KEYS are absent. The endpoint reports
      // percentages only; a 29% collapsed into used=29/limit=100 would be an
      // absolute the source never gave us (pillar 4).
      expect(Object.prototype.hasOwnProperty.call(meterRecord, 'used')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(meterRecord, 'limit')).toBe(false);
      expect(meterRecord.unit).toBe('percent');
      expect(typeof meterRecord.percent).toBe('number');
    }
  });

  it('ignores the codenamed top-level buckets by construction (rule 0.6)', () => {
    // The fixture deliberately retains tangelo / iguana_necktie / nimbus_quill /
    // cinder_cove / amber_ladder / seven_day_* as churn evidence. Consuming
    // limits[] only means none of them can ever reach a meter.
    const meters = parseUsageResponse(GOLDEN_BODY, OBSERVED_AT);
    const serializedMeters = JSON.stringify(meters);
    for (const codenamedKey of [
      'tangelo',
      'iguana_necktie',
      'nimbus_quill',
      'cinder_cove',
      'amber_ladder',
      'seven_day_cowork',
      'omelette',
      'five_hour',
      'extra_usage',
      'spend',
    ]) {
      expect(serializedMeters).not.toContain(codenamedKey);
    }
    expect(meters.map((meterRecord) => meterRecord.meterId).sort()).toEqual([
      'endpoint:session',
      'endpoint:weekly_all',
      'endpoint:weekly_scoped:Fable',
    ]);
  });
});

describe('parseUsageResponse degradation (never throws, never guesses)', () => {
  it('skips an UNKNOWN kind rather than throwing or guessing a mapping', () => {
    const bodyWithNewKind = JSON.stringify({
      limits: [
        { kind: 'session', percent: 10, severity: 'normal', resets_at: null, scope: null, is_active: true },
        { kind: 'lunar_fortnight_tangelo', percent: 99, severity: 'severe', scope: null, is_active: true },
      ],
    });
    const meters = parseUsageResponse(bodyWithNewKind, OBSERVED_AT);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.meterId).toBe('endpoint:session');
  });

  it('skips an entry with no usable percent (nothing truthful to say)', () => {
    const bodyWithNullPercent = JSON.stringify({
      limits: [{ kind: 'weekly_all', percent: null, scope: null, is_active: false }],
    });
    expect(parseUsageResponse(bodyWithNullPercent, OBSERVED_AT)).toEqual([]);
  });

  it('returns [] for a malformed or limits-less body, never throwing', () => {
    expect(parseUsageResponse('not json at all', OBSERVED_AT)).toEqual([]);
    expect(parseUsageResponse('{}', OBSERVED_AT)).toEqual([]);
    expect(parseUsageResponse('[]', OBSERVED_AT)).toEqual([]);
    expect(parseUsageResponse('{"limits": "nope"}', OBSERVED_AT)).toEqual([]);
    expect(parseUsageResponse('{"limits": [null, 7, "x"]}', OBSERVED_AT)).toEqual([]);
    expect(parseUsageResponse('', OBSERVED_AT)).toEqual([]);
  });
});

interface FetchRecorder {
  httpFetch: UsageHttpFetch;
  calls: Array<{ url: string; headers: Readonly<Record<string, string>> }>;
}

function recordingFetch(respond: () => Promise<UsageHttpResponse>): FetchRecorder {
  const calls: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  return {
    calls,
    httpFetch: async (url, headers) => {
      calls.push({ url, headers });
      return respond();
    },
  };
}

describe('the usage adapter degrades, never lies', () => {
  it('emits samples on 200 and sends the bearer token to the right URL', async () => {
    const recorder = recordingFetch(async () => ({ status: 200, body: GOLDEN_BODY }));
    const warnings: string[] = [];
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      baseUrl: 'http://usage.invalid',
      warn: (message) => warnings.push(message),
    });

    const result = await adapter.probe(OBSERVED_AT);
    expect(result.ok).toBe(true);
    expect(result.ok && result.meters).toHaveLength(3);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.url).toBe('http://usage.invalid/api/oauth/usage');
    expect(recorder.calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(recorder.calls[0]?.headers.accept).toBe('application/json');
    expect(warnings).toEqual([]);
  });

  it('401 emits ZERO samples, classifies the failure, and never logs the token', async () => {
    // The NORMAL daily failure: the ~6h OAuth token expired and the CLI owns
    // refresh. The one unacceptable outcome would be a placeholder sample.
    const recorder = recordingFetch(async () => ({ status: 401, body: '{"error":"unauthorized"}' }));
    const warnings: string[] = [];
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      baseUrl: 'http://usage.invalid',
      warn: (message) => warnings.push(message),
    });

    const result = await adapter.probe(OBSERVED_AT);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
    // No meters field at all — there is no placeholder, zero, or stale reuse to
    // be found on a failure result.
    expect(Object.prototype.hasOwnProperty.call(result, 'meters')).toBe(false);
    expect(warnings).toHaveLength(1);
    for (const warningLine of warnings) {
      expect(warningLine).not.toContain(FAKE_ACCESS_TOKEN);
      // Not even a truncated prefix of the token may appear.
      expect(warningLine).not.toContain(FAKE_ACCESS_TOKEN.slice(0, 12));
      expect(warningLine).not.toContain('Bearer');
    }
  });

  it('403 is classified as unauthorized too', async () => {
    const recorder = recordingFetch(async () => ({ status: 403, body: '' }));
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      warn: () => {},
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'unauthorized', status: 403 });
  });

  it('a network error emits nothing and classifies as network-error', async () => {
    const adapter = createUsageEndpointAdapter({
      httpFetch: async () => {
        throw new Error('ECONNREFUSED usage.invalid');
      },
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      warn: () => {},
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'network-error', status: null });
  });

  it('a 500 emits nothing and classifies as http-error', async () => {
    const recorder = recordingFetch(async () => ({ status: 500, body: 'upstream exploded' }));
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      warn: () => {},
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'http-error', status: 500 });
  });

  it('a 200 whose shape drifted beyond recognition FAILS LOUDLY rather than succeeding empty', async () => {
    const recorder = recordingFetch(async () => ({ status: 200, body: '<html>login</html>' }));
    const warnings: string[] = [];
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => FAKE_ACCESS_TOKEN,
      warn: (message) => warnings.push(message),
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'unparseable', status: 200 });
    expect(warnings).toHaveLength(1);
  });

  it('with no credentials it never calls out at all', async () => {
    const recorder = recordingFetch(async () => ({ status: 200, body: GOLDEN_BODY }));
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => null,
      warn: () => {},
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'no-credentials', status: null });
    expect(recorder.calls).toHaveLength(0);
  });

  it('a throwing credentials reader degrades to no-credentials, not a crash', async () => {
    const recorder = recordingFetch(async () => ({ status: 200, body: GOLDEN_BODY }));
    const adapter = createUsageEndpointAdapter({
      httpFetch: recorder.httpFetch,
      readCredentials: async () => {
        throw new Error('EACCES');
      },
      warn: () => {},
    });
    expect(await adapter.probe(OBSERVED_AT)).toEqual({ ok: false, reason: 'no-credentials', status: null });
    expect(recorder.calls).toHaveLength(0);
  });
});
