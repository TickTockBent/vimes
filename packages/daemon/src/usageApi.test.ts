import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SteppingClock, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { UsageHttpFetch } from './usageEndpoint.js';
import type { DerivedUsageBody } from './usageDerived.js';

// ─── GET /api/usage/derived + POST /api/usage/refresh (slice 5 step 4b) ──────
//
// Both usage seams and the observation-log path are injected in EVERY test: no
// test reaches the network, reads the real credentials file, or writes into the
// real data dir.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-usage-api-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';
const FAKE_ACCESS_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-NEVER-REAL-000000';
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

const GOLDEN_BODY = readFileSync(
  fileURLToPath(new URL('../../../fixtures/usage/oauth-usage-2026-07-21.json', import.meta.url)),
  'utf8',
);

interface RefreshEnvelope {
  polled: boolean;
  throttled: boolean;
  failureReason: string | null;
  httpStatus: number | null;
  nextForcedPollAt: string | null;
  retryAfterMs: number | null;
}
type RefreshBody = DerivedUsageBody & { refresh: RefreshEnvelope };

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `usage-api-${databaseFileCounter}.db`);
}

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const dbPath = nextDatabasePath();
  return {
    port: 0,
    hookPort: 0,
    dbPath,
    dataDir: dirname(dbPath),
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    // 0 keeps the background poller from ever firing; the tests that need a
    // staleness band set an explicit positive interval.
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    ...overrides,
  };
}

interface ApiHarness {
  daemon: Daemon;
  observationLogPath: string;
  fetchCallCount(): number;
}

function startDaemon(config: DaemonConfig, usageHttpFetch: UsageHttpFetch): Promise<ApiHarness> {
  const observationLogPath = join(temporaryDirectory, `observations-${databaseFileCounter}.jsonl`);
  let fetchCallCount = 0;
  const countingFetch: UsageHttpFetch = async (url, headers) => {
    fetchCallCount += 1;
    return usageHttpFetch(url, headers);
  };
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
    usageHttpFetch: countingFetch,
    usageCredentialsReader: async () => FAKE_ACCESS_TOKEN,
    usageObservationLogPath: observationLogPath,
  });
  return daemon.start().then(async () => {
    // A positive poll interval makes start() fire ONE immediate poll
    // (fire-and-forget). Wait for it to land so every assertion below counts
    // from a settled baseline rather than racing the timer.
    if (config.usagePollIntervalMs > 0) {
      const deadlineMs = Date.now() + 2000;
      while (fetchCallCount === 0 && Date.now() < deadlineMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      // Let the emit that follows the fetch settle too.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    return { daemon, observationLogPath, fetchCallCount: () => fetchCallCount };
  });
}

function getDerived(daemon: Daemon): Promise<DerivedUsageBody> {
  return fetch(`http://127.0.0.1:${daemon.port}/api/usage/derived`, {
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
  }).then((response) => {
    expect(response.status).toBe(200);
    return response.json() as Promise<DerivedUsageBody>;
  });
}

function postRefresh(daemon: Daemon): Promise<RefreshBody> {
  return fetch(`http://127.0.0.1:${daemon.port}/api/usage/refresh`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
  }).then((response) => {
    expect(response.status).toBe(200);
    return response.json() as Promise<RefreshBody>;
  });
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('GET /api/usage/derived', () => {
  it('serves the envelope with an EMPTY meters array when nothing was ever observed', async () => {
    // A permanently-401 endpoint: the poller runs and emits NOTHING, so the
    // meters read model has genuinely never seen anything.
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: 401,
      body: '{"error":"expired"}',
    }));
    try {
      const body = await getDerived(harness.daemon);
      expect(body.meters).toEqual([]);
      expect(typeof body.observedNow).toBe('string');
      expect(body.pollIntervalMs).toBe(300_000);
      expect(body.staleAfterMs).not.toBeNull();
    } finally {
      await harness.daemon.stop();
    }
  });

  it('derives freshness, ages and headroom over the golden fixture, binding meter first', async () => {
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: 200,
      body: GOLDEN_BODY,
    }));
    try {
      // Exactly ONE sample so far (start()'s immediate poll, awaited above).
      const body = await getDerived(harness.daemon);
      expect(body.meters.map((meter) => meter.meterId)).toEqual([
        // `weekly_scoped:Fable` is the is_active limit in the fixture.
        'endpoint:weekly_scoped:Fable',
        'endpoint:session',
        'endpoint:weekly_all',
      ]);
      const bindingMeter = body.meters[0]!;
      expect(bindingMeter.isActive).toBe(true);
      expect(bindingMeter.percent).toBe(64);
      expect(bindingMeter.headroomPercent).toBe(36);
      expect(bindingMeter.freshness).toBe('fresh');
      expect(typeof bindingMeter.ageMs).toBe('number');
      // One sample is not a rate: unknown, and unknown is null (never 0).
      expect(bindingMeter.burnRatePercentPerHour).toBeNull();
      expect(bindingMeter.projectedExhaustion).toBeNull();
      expect(bindingMeter.projectedExhaustionReason).toBe('burn-rate-unknown');
      // D26 at the wire: no invented absolutes.
      expect(bindingMeter.used).toBeUndefined();
      expect(bindingMeter.limit).toBeUndefined();
    } finally {
      await harness.daemon.stop();
    }
  });

  it('with the poller DISABLED every meter is unknown and there is no band', async () => {
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 0 }), async () => ({
      status: 200,
      body: GOLDEN_BODY,
    }));
    try {
      await harness.daemon.pollUsageOnce();
      const body = await getDerived(harness.daemon);
      expect(body.staleAfterMs).toBeNull();
      expect(body.meters).toHaveLength(3);
      expect(body.meters.every((meter) => meter.freshness === 'unknown')).toBe(true);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('does NOT add derived fields to /api/projections/meters (rule 0.3)', async () => {
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: 200,
      body: GOLDEN_BODY,
    }));
    try {
      await harness.daemon.pollUsageOnce();
      const projectionBody = await fetch(
        `http://127.0.0.1:${harness.daemon.port}/api/projections/meters`,
        { headers: { 'cf-access-jwt-assertion': ANY_TOKEN } },
      ).then((response) => response.text());
      expect(projectionBody).not.toContain('freshness');
      expect(projectionBody).not.toContain('ageMs');
      expect(projectionBody).not.toContain('headroomPercent');
      expect(projectionBody).not.toContain('projectedExhaustion');
    } finally {
      await harness.daemon.stop();
    }
  });
});

describe('POST /api/usage/refresh', () => {
  it('forces an ACTUAL poll and returns the freshly derived body in one round trip', async () => {
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: 200,
      body: GOLDEN_BODY,
    }));
    try {
      const callsBeforeRefresh = harness.fetchCallCount();
      const body = await postRefresh(harness.daemon);
      // It POLLED — it did not re-serve the last sample more confidently.
      expect(harness.fetchCallCount()).toBe(callsBeforeRefresh + 1);
      expect(body.refresh.polled).toBe(true);
      expect(body.refresh.throttled).toBe(false);
      expect(body.refresh.failureReason).toBeNull();
      expect(body.meters).toHaveLength(3);
      expect(body.meters[0]!.freshness).toBe('fresh');
    } finally {
      await harness.daemon.stop();
    }
  });

  it('DOES NOT poll inside the debounce window, and says so', async () => {
    const harness = await startDaemon(
      buildConfig({ usagePollIntervalMs: 300_000, usageForcedRefreshMinIntervalMs: 600_000 }),
      async () => ({ status: 200, body: GOLDEN_BODY }),
    );
    try {
      const callsBeforeRefresh = harness.fetchCallCount();
      const firstBody = await postRefresh(harness.daemon);
      expect(firstBody.refresh.polled).toBe(true);
      expect(harness.fetchCallCount()).toBe(callsBeforeRefresh + 1);

      const secondBody = await postRefresh(harness.daemon);
      // The endpoint was NOT hit a second time.
      expect(harness.fetchCallCount()).toBe(callsBeforeRefresh + 1);
      expect(secondBody.refresh.polled).toBe(false);
      expect(secondBody.refresh.throttled).toBe(true);
      expect(secondBody.refresh.nextForcedPollAt).not.toBeNull();
      expect(secondBody.refresh.retryAfterMs).toBeGreaterThan(0);
      // It never claims a refresh happened, and the data is still complete.
      expect(secondBody.meters).toHaveLength(3);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('polls again once the debounce window has elapsed', async () => {
    // The stepping clock advances well past the tiny debounce between requests.
    const harness = await startDaemon(
      buildConfig({ usagePollIntervalMs: 300_000, usageForcedRefreshMinIntervalMs: 1 }),
      async () => ({ status: 200, body: GOLDEN_BODY }),
    );
    try {
      const callsBeforeRefresh = harness.fetchCallCount();
      await postRefresh(harness.daemon);
      const secondBody = await postRefresh(harness.daemon);
      expect(secondBody.refresh.polled).toBe(true);
      expect(secondBody.refresh.throttled).toBe(false);
      expect(harness.fetchCallCount()).toBe(callsBeforeRefresh + 2);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('on adapter FAILURE it is honest: unchanged ages, no fresher observedAt, failure reported', async () => {
    let currentStatus = 200;
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: currentStatus,
      body: currentStatus === 200 ? GOLDEN_BODY : '{"error":"expired"}',
    }));
    try {
      const successBody = await postRefresh(harness.daemon);
      const observedAtBefore = successBody.meters.map((meter) => meter.observedAt);
      const agesBefore = successBody.meters.map((meter) => meter.ageMs!);

      currentStatus = 401;
      const failureBody = await postRefresh(harness.daemon);
      expect(failureBody.refresh.polled).toBe(true);
      expect(failureBody.refresh.failureReason).toBe('unauthorized');
      expect(failureBody.refresh.httpStatus).toBe(401);
      // Not one observedAt was re-stamped by the failed refresh.
      expect(failureBody.meters.map((meter) => meter.observedAt)).toEqual(observedAtBefore);
      // And the ages only GREW — the reading got older, as it truly is.
      failureBody.meters.forEach((meter, meterIndex) => {
        expect(meter.ageMs!).toBeGreaterThan(agesBefore[meterIndex]!);
      });
    } finally {
      await harness.daemon.stop();
    }
  });
});

describe('the observation log records what the poller does (rule 0.6)', () => {
  it('writes a line per attempt — success and failure alike — and never the token', async () => {
    let currentStatus = 200;
    const harness = await startDaemon(buildConfig({ usagePollIntervalMs: 300_000 }), async () => ({
      status: currentStatus,
      // The hostile case: the endpoint echoes the bearer back in its error.
      body:
        currentStatus === 200
          ? GOLDEN_BODY
          : JSON.stringify({ error: { message: `token ${FAKE_ACCESS_TOKEN} expired` } }),
    }));
    try {
      // start()'s immediate poll already wrote line 0 (outcome 'ok').
      currentStatus = 401;
      await harness.daemon.pollUsageOnce();
      currentStatus = 200;
      await harness.daemon.pollUsageOnce();

      const lines = harness.daemon.usageObservationLog.readLines();
      expect(lines.map((line) => line.outcome)).toEqual(['ok', 'unauthorized', 'ok']);
      expect(lines[1]!.httpStatus).toBe(401);
      // First sighting of the golden shape captured a body; the repeat did not.
      expect(lines[0]!.body).toBeDefined();
      expect(lines[2]!.body).toBeUndefined();
      expect(lines[2]!.fingerprint).toBe(lines[0]!.fingerprint);

      const fileContents = readFileSync(harness.observationLogPath, 'utf8');
      expect(fileContents).not.toContain(FAKE_ACCESS_TOKEN);
      expect(fileContents).not.toContain('sk-ant-oat01');
    } finally {
      await harness.daemon.stop();
    }
  });
});
