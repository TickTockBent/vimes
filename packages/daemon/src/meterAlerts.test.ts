import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EVENT_TYPES, SteppingClock, USAGE_STREAM, type EventRecord, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { PushSender, PushSendOptions, PushSubscriptionRecord } from './pushService.js';
import { DEFAULT_PUSH_TTL_SECONDS } from './pushService.js';
import type { UsageHttpFetch } from './usageEndpoint.js';
import { buildMeterAlertPushPayload, resetCountdownText, ttlSecondsUntilReset } from './meterAlerts.js';

// ─── Meter alert emission + push (slice 5 step 4b, deliverable 4) ────────────
//
// No test here starts the daemon's HTTP listener or its poll timer: each drives
// `pollUsageOnce()` directly so a poll is deterministic rather than clock-raced.
// Both usage seams and the push sender are injected in every test — no network,
// no real credentials file, no real data dir.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-meter-alerts-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const FAKE_ACCESS_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-NEVER-REAL-000000';
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

// A poll cadence long enough that the derived staleness band comfortably covers
// a whole test, so freshness is never the thing under test here.
const LONG_POLL_INTERVAL_MS = 3_600_000;

const SUBSCRIPTION: PushSubscriptionRecord = {
  endpoint: 'https://push.example.com/meter-ep-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

class FakePushSender implements PushSender {
  readonly sends: Array<{ endpoint: string; payloadJson: string; options?: PushSendOptions }> = [];
  outcomeFor: (endpoint: string) => { ok: boolean; statusCode?: number } = () => ({ ok: true, statusCode: 201 });

  async send(
    subscription: PushSubscriptionRecord,
    payloadJson: string,
    options?: PushSendOptions,
  ): Promise<{ ok: boolean; statusCode?: number }> {
    this.sends.push({ endpoint: subscription.endpoint, payloadJson, options });
    return this.outcomeFor(subscription.endpoint);
  }
}

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `alerts-${databaseFileCounter}.db`);
}

function buildConfig(dbPath: string, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath,
    dataDir: dirname(dbPath),
    expectedCliVersion: undefined,
    expectedSdkCliVersion: undefined,
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
    usagePollIntervalMs: LONG_POLL_INTERVAL_MS,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [80],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    // The stage-run watchdog (slice 6 step 5b): DISABLED in tests — 0 means the
    // daemon never creates the timer, so no test daemon can wake up and write
    // attention/notifications behind a case's back. The policy values are inert
    // while the interval is 0.
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    ...overrides,
  };
}

// A minimal usage body in the endpoint's observed shape (spike U1).
function usageBody(percent: number, resetsAt = '2026-07-21T15:19:59.000Z'): string {
  return JSON.stringify({
    limits: [{ kind: 'session', group: 'session', percent, resets_at: resetsAt, is_active: true }],
  });
}

interface Harness {
  daemon: Daemon;
  sender: FakePushSender;
  setBody(body: string): void;
}

function createHarness(dbPath: string, overrides: Partial<DaemonConfig> = {}): Harness {
  let currentBody = usageBody(10);
  const sender = new FakePushSender();
  const usageHttpFetch: UsageHttpFetch = async () => ({ status: 200, body: currentBody });
  const daemon = createDaemon({
    config: buildConfig(dbPath, overrides),
    // A 1-second step keeps every observation comfortably inside the band.
    clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
    pushSender: sender,
    usageHttpFetch,
    usageCredentialsReader: async () => FAKE_ACCESS_TOKEN,
    usageObservationLogPath: join(temporaryDirectory, `observations-${databaseFileCounter}.jsonl`),
  });
  return {
    daemon,
    sender,
    setBody(body: string): void {
      currentBody = body;
    },
  };
}

function meterAlertEvents(daemon: Daemon): EventRecord[] {
  return daemon.store.read(USAGE_STREAM, 1).filter((record) => record.type === EVENT_TYPES.meterAlert);
}

function meterPushOutcomeEvents(daemon: Daemon): EventRecord[] {
  return daemon.store.read(USAGE_STREAM, 1).filter((record) => record.type === EVENT_TYPES.meterPushOutcome);
}

function flushSends(): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('meter alert push payload', () => {
  it('names the METER and deep-links to the meters view, not a session', () => {
    const payload = buildMeterAlertPushPayload(
      {
        meterId: 'endpoint:weekly_scoped:Fable',
        thresholdPercent: 80,
        observedPercent: 84,
        kind: 'weekly-cap',
        scope: 'Fable',
        resetsAt: '2026-07-21T14:30:00.000Z',
        observedAt: '2026-07-21T12:00:00.000Z',
        disposition: 'notify',
      },
      '2026-07-21T12:00:00.000Z',
    );
    expect(payload.title).toBe('Weekly cap (Fable) at 84%');
    expect(payload.body).toContain('Crossed 80%');
    expect(payload.body).toContain('Resets in 2h 30m');
    expect(payload.url).toBe('/#/meters');
    // Deliberately NOT the session-attention wording.
    expect(payload.body).not.toContain('Needs your attention');
  });

  it('omits the countdown entirely when resetsAt is unknown — never "0m"', () => {
    const payload = buildMeterAlertPushPayload(
      {
        meterId: 'endpoint:session',
        thresholdPercent: 80,
        observedPercent: 81,
        kind: 'rolling-window',
        scope: null,
        resetsAt: null,
        observedAt: '2026-07-21T12:00:00.000Z',
        disposition: 'notify',
      },
      '2026-07-21T12:00:00.000Z',
    );
    expect(payload.body).not.toContain('Resets in');
    expect(payload.title).toBe('Rolling window at 81%');
  });

  it('resetCountdownText is null for absent, unparseable and already-past resets', () => {
    expect(resetCountdownText(null, '2026-07-21T12:00:00.000Z')).toBeNull();
    expect(resetCountdownText('soonish', '2026-07-21T12:00:00.000Z')).toBeNull();
    expect(resetCountdownText('2026-07-21T11:00:00.000Z', '2026-07-21T12:00:00.000Z')).toBeNull();
    expect(resetCountdownText('2026-07-24T12:00:00.000Z', '2026-07-21T12:00:00.000Z')).toBe('3d 0h');
  });

  it('ttlSecondsUntilReset derives seconds-to-reset, falls back with no deadline, and expires a past reset (D29)', () => {
    // Natural value: the seconds remaining to the window reset.
    expect(ttlSecondsUntilReset('2026-07-21T15:00:00.000Z', '2026-07-21T12:00:00.000Z')).toBe(3 * 3600);
    // No natural deadline (absent / unparseable) → a sane bounded default.
    expect(ttlSecondsUntilReset(null, '2026-07-21T12:00:00.000Z')).toBe(DEFAULT_PUSH_TTL_SECONDS);
    expect(ttlSecondsUntilReset('soonish', '2026-07-21T12:00:00.000Z')).toBe(DEFAULT_PUSH_TTL_SECONDS);
    // The window already reset → 0, so an undeliverable stale alert drops rather
    // than arriving late.
    expect(ttlSecondsUntilReset('2026-07-21T11:00:00.000Z', '2026-07-21T12:00:00.000Z')).toBe(0);
    // The fallback is caller-overridable.
    expect(ttlSecondsUntilReset(undefined, '2026-07-21T12:00:00.000Z', 42)).toBe(42);
  });
});

describe('meter alerts at the daemon boundary', () => {
  it('fires ONCE on crossing, and does not re-fire while still above', async () => {
    const harness = createHarness(nextDatabasePath());
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(50));
      await harness.daemon.pollUsageOnce();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(0);

      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);
      expect(harness.sender.sends).toHaveLength(1);

      // Still above, and climbing — edge-triggered means silence (pillar 5).
      harness.setBody(usageBody(91));
      await harness.daemon.pollUsageOnce();
      harness.setBody(usageBody(95));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);
      expect(harness.sender.sends).toHaveLength(1);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('sends at HIGH urgency with a resetsAt-derived TTL, and events a SENT outcome (D29)', async () => {
    const harness = createHarness(nextDatabasePath());
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();

      // Threshold alerts are time-sensitive → HIGH (wakes a dozing device).
      expect(harness.sender.sends).toHaveLength(1);
      expect(harness.sender.sends[0]!.options?.urgency).toBe('high');
      // TTL is DERIVED from resetsAt (12:00 → 15:19:59 ≈ 11999s), NOT the
      // four-week / 24h fallback: bounded, and well under the default.
      const ttl = harness.sender.sends[0]!.options?.ttlSeconds;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl!).toBeLessThanOrEqual(3 * 3600 + 20 * 60);
      expect(ttl!).toBeLessThan(DEFAULT_PUSH_TTL_SECONDS);

      // The delivery outcome is evented on the 'usage' stream (no session).
      const outcomes = meterPushOutcomeEvents(harness.daemon);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.payload).toMatchObject({ attempted: true, outcome: 'sent', statusCode: 201 });
      expect(typeof (outcomes[0]!.payload as { meterId: unknown }).meterId).toBe('string');
    } finally {
      await harness.daemon.stop();
    }
  });

  it('events a FAILED outcome with the 410 status on the prune path (D29)', async () => {
    const harness = createHarness(nextDatabasePath());
    harness.sender.outcomeFor = () => ({ ok: false, statusCode: 410 });
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();

      const outcomes = meterPushOutcomeEvents(harness.daemon);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.payload).toMatchObject({ attempted: true, outcome: 'failed', statusCode: 410 });
      // The dead subscription is pruned, exactly as before.
      expect(harness.daemon.pushSubscriptions.count()).toBe(0);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('events attempted:false when a crossing has NO subscription to reach', async () => {
    const harness = createHarness(nextDatabasePath());
    try {
      // No subscription saved — the crossing still fires an alert, but there is
      // nobody to push to. The log must still say a send was NOT attempted.
      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();

      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);
      expect(harness.sender.sends).toHaveLength(0);
      const outcomes = meterPushOutcomeEvents(harness.daemon);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.payload).toMatchObject({ attempted: false });
      expect((outcomes[0]!.payload as { outcome?: unknown }).outcome).toBeUndefined();
    } finally {
      await harness.daemon.stop();
    }
  });

  it('re-arms after the window RESETS (resets_at moves), and fires again', async () => {
    const harness = createHarness(nextDatabasePath());
    try {
      harness.setBody(usageBody(84, '2026-07-21T15:00:00.000Z'));
      await harness.daemon.pollUsageOnce();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);

      // A genuine rollover: the percentage dropped AND resets_at moved.
      harness.setBody(usageBody(5, '2026-07-21T20:00:00.000Z'));
      await harness.daemon.pollUsageOnce();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);

      harness.setBody(usageBody(88, '2026-07-21T20:00:00.000Z'));
      await harness.daemon.pollUsageOnce();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(2);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('NO RE-ALERT ACROSS A DAEMON RESTART — the memory is folded from the log', async () => {
    // The hazard this guards: a restart that forgot what already fired would
    // buzz the phone again for a threshold crossed before the reboot. The
    // memory is derived from the `meter_alert` events, so it survives.
    const sharedDatabasePath = nextDatabasePath();
    const firstHarness = createHarness(sharedDatabasePath);
    try {
      firstHarness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      firstHarness.setBody(usageBody(84));
      await firstHarness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(firstHarness.daemon)).toHaveLength(1);
      expect(firstHarness.sender.sends).toHaveLength(1);
    } finally {
      await firstHarness.daemon.stop();
    }

    const secondHarness = createHarness(sharedDatabasePath);
    try {
      // Same window (same resets_at), still above the line, freshly polled.
      secondHarness.setBody(usageBody(86));
      await secondHarness.daemon.pollUsageOnce();
      await secondHarness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(secondHarness.daemon)).toHaveLength(1);
      // And nothing was pushed by the rebooted daemon.
      expect(secondHarness.sender.sends).toHaveLength(0);
    } finally {
      await secondHarness.daemon.stop();
    }
  });

  it('an EMPTY threshold config disables alerting entirely', async () => {
    const harness = createHarness(nextDatabasePath(), { usageAlertPercents: [] });
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(99));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(0);
      expect(harness.sender.sends).toHaveLength(0);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('a DISABLED poller (no staleness band) never alerts — no band, no vouching', async () => {
    const harness = createHarness(nextDatabasePath(), { usagePollIntervalMs: 0 });
    try {
      harness.setBody(usageBody(99));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(0);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('a STALE observation never alerts, even when it is far above the line', async () => {
    // The clock steps 10 minutes per read while the band is ~2.5 minutes, so by
    // the time the alert evaluation stamps `now` the sample it would alert on is
    // already outside the band.
    const dbPath = nextDatabasePath();
    let currentBody = usageBody(97);
    const sender = new FakePushSender();
    const daemon = createDaemon({
      config: buildConfig(dbPath, { usagePollIntervalMs: 120_000 }),
      clock: new SteppingClock('2026-07-21T12:00:00.000Z', 600_000),
      ids: uniqueIdSource,
      verifier: permissiveVerifier,
      pushSender: sender,
      usageHttpFetch: async () => ({ status: 200, body: currentBody }),
      usageCredentialsReader: async () => FAKE_ACCESS_TOKEN,
      usageObservationLogPath: join(temporaryDirectory, `observations-stale-${databaseFileCounter}.jsonl`),
    });
    try {
      daemon.pushSubscriptions.save(SUBSCRIPTION);
      currentBody = usageBody(97);
      await daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(daemon)).toHaveLength(0);
      expect(sender.sends).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });

  it('a FAILING push does not break the poll — the sample and the alert still land', async () => {
    const harness = createHarness(nextDatabasePath());
    harness.sender.outcomeFor = () => ({ ok: false, statusCode: 500 });
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(84));
      await expect(harness.daemon.pollUsageOnce()).resolves.toBeUndefined();
      await flushSends();
      expect(meterAlertEvents(harness.daemon)).toHaveLength(1);
      expect(harness.sender.sends).toHaveLength(1);
      // A 500 is transient — the subscription stays.
      expect(harness.daemon.pushSubscriptions.count()).toBe(1);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('a 410 GONE prunes the dead subscription, exactly as the push pipeline does', async () => {
    const harness = createHarness(nextDatabasePath());
    harness.sender.outcomeFor = () => ({ ok: false, statusCode: 410 });
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(harness.daemon.pushSubscriptions.count()).toBe(0);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('a 404 GONE prunes the dead subscription too', async () => {
    const harness = createHarness(nextDatabasePath());
    harness.sender.outcomeFor = () => ({ ok: false, statusCode: 404 });
    try {
      harness.daemon.pushSubscriptions.save(SUBSCRIPTION);
      harness.setBody(usageBody(84));
      await harness.daemon.pollUsageOnce();
      await flushSends();
      expect(harness.daemon.pushSubscriptions.count()).toBe(0);
    } finally {
      await harness.daemon.stop();
    }
  });

  it('a FAILED poll emits no alert at all — a failure is never a crossing', async () => {
    const dbPath = nextDatabasePath();
    const sender = new FakePushSender();
    const daemon = createDaemon({
      config: buildConfig(dbPath),
      clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
      ids: uniqueIdSource,
      verifier: permissiveVerifier,
      pushSender: sender,
      usageHttpFetch: async () => ({ status: 401, body: '{"error":"expired"}' }),
      usageCredentialsReader: async () => FAKE_ACCESS_TOKEN,
      usageObservationLogPath: join(temporaryDirectory, `observations-401-${databaseFileCounter}.jsonl`),
    });
    try {
      daemon.pushSubscriptions.save(SUBSCRIPTION);
      await daemon.pollUsageOnce();
      await flushSends();
      expect(meterAlertEvents(daemon)).toHaveLength(0);
      expect(sender.sends).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });
});
