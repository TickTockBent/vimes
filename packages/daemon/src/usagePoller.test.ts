import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SteppingClock, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { UsageHttpFetch } from './usageEndpoint.js';

// ─── Usage poller at the daemon boundary + the Cache-Control fix ─────────────
//
// Both usage seams are injected in EVERY test here: no test reaches the network
// and none reads the real ~/.claude/.credentials.json.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-usage-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';
const FAKE_ACCESS_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-NEVER-REAL-000000';
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

const GOLDEN_BODY = readFileSync(
  fileURLToPath(new URL('../../../fixtures/usage/oauth-usage-2026-07-21.json', import.meta.url)),
  'utf8',
);

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `usage-${databaseFileCounter}.db`);
}

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const dbPath = nextDatabasePath();
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
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
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
    // Worker isolation (slice 6 step 8): OFF in tests, which is also the shipped
    // default — so no test daemon can create a worktree, and this root is never
    // touched. The flip is a human's; see taskDispatcher.ts's isolation block.
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
    ...overrides,
  };
}

function startDaemon(config: DaemonConfig, usageHttpFetch: UsageHttpFetch): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-07-21T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
    usageHttpFetch,
    usageCredentialsReader: async () => FAKE_ACCESS_TOKEN,
  });
  return daemon.start().then(() => daemon);
}

function fetchProjection(daemon: Daemon, projectionId: string): Promise<string> {
  return fetch(`http://127.0.0.1:${daemon.port}/api/projections/${projectionId}`, {
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
  }).then((response) => response.text());
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('usage poller at the daemon boundary', () => {
  it('a successful poll emits one meter_sample per limit into the meters projection', async () => {
    const daemon = await startDaemon(buildConfig(), async () => ({ status: 200, body: GOLDEN_BODY }));
    try {
      await daemon.pollUsageOnce();
      const metersBody = await fetchProjection(daemon, 'meters');
      expect(metersBody).toContain('endpoint:session');
      expect(metersBody).toContain('endpoint:weekly_all');
      expect(metersBody).toContain('endpoint:weekly_scoped:Fable');
      expect(metersBody).toContain('"percent":64');
      expect(metersBody).toContain('"unit":"percent"');
      // D26 at the wire: no absolutes anywhere in what the daemon serves.
      expect(metersBody).not.toContain('"used"');
      expect(metersBody).not.toContain('"limit"');
    } finally {
      await daemon.stop();
    }
  });

  it('a 401 poll emits NOTHING — no placeholder meter reaches the log', async () => {
    const daemon = await startDaemon(buildConfig(), async () => ({ status: 401, body: '{"error":"expired"}' }));
    try {
      const metersBeforePoll = await fetchProjection(daemon, 'meters');
      await daemon.pollUsageOnce();
      const metersAfterPoll = await fetchProjection(daemon, 'meters');
      // Byte-identical: the failed poll wrote nothing at all.
      expect(metersAfterPoll).toBe(metersBeforePoll);
      expect(metersAfterPoll).not.toContain('endpoint:');
      expect(metersAfterPoll).not.toContain('"percent":0');
    } finally {
      await daemon.stop();
    }
  });

  it('a poll that fails after a SUCCESSFUL one never re-emits the old body as current', async () => {
    let currentStatus = 200;
    const daemon = await startDaemon(buildConfig(), async () => ({
      status: currentStatus,
      body: currentStatus === 200 ? GOLDEN_BODY : 'expired',
    }));
    try {
      await daemon.pollUsageOnce();
      const metersAfterSuccess = await fetchProjection(daemon, 'meters');
      currentStatus = 401;
      await daemon.pollUsageOnce();
      await daemon.pollUsageOnce();
      const metersAfterFailures = await fetchProjection(daemon, 'meters');
      // The stored sample keeps its ORIGINAL observedAt; nothing re-stamped it
      // as fresh. Freshness is derived from observedAt, so the meter ages out.
      expect(metersAfterFailures).toBe(metersAfterSuccess);
    } finally {
      await daemon.stop();
    }
  });

  it('an interval of 0 never creates the poller (the endpoint is never called)', async () => {
    let callCount = 0;
    const daemon = await startDaemon(buildConfig({ usagePollIntervalMs: 0 }), async () => {
      callCount += 1;
      return { status: 200, body: GOLDEN_BODY };
    });
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      expect(callCount).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it('a positive interval polls ONCE immediately on start, before the interval ever fires', async () => {
    let callCount = 0;
    // A deliberately long interval: if the immediate poll didn't happen, the
    // interval callback could not possibly fire within this test's short
    // real-time budget, so any observed call must be the immediate one.
    const daemon = await startDaemon(buildConfig({ usagePollIntervalMs: 60_000 }), async () => {
      callCount += 1;
      return { status: 200, body: GOLDEN_BODY };
    });
    try {
      const deadlineMs = Date.now() + 2000;
      while (callCount === 0 && Date.now() < deadlineMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(callCount).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it('a positive interval polls on a timer, and stop() clears it', async () => {
    let callCount = 0;
    const daemon = await startDaemon(buildConfig({ usagePollIntervalMs: 10 }), async () => {
      callCount += 1;
      return { status: 200, body: GOLDEN_BODY };
    });
    try {
      const deadlineMs = Date.now() + 2000;
      while (callCount === 0 && Date.now() < deadlineMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(callCount).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
    const callCountAtStop = callCount;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    expect(callCount).toBe(callCountAtStop);
  });
});

describe('Cache-Control on static files (calibration finding, 2026-07-21)', () => {
  it('sets no-cache on the shell, immutable on hashed assets, and a short default elsewhere', async () => {
    const staticDir = join(temporaryDirectory, 'static');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    mkdirSync(join(staticDir, 'icons'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>vimes</title>');
    writeFileSync(join(staticDir, 'sw.js'), '// service worker');
    writeFileSync(join(staticDir, 'manifest.webmanifest'), '{"name":"VIMES"}');
    writeFileSync(join(staticDir, 'assets', 'index-a1b2c3d4.js'), 'export const answer = 42;');
    writeFileSync(join(staticDir, 'icons', 'icon-512.v2.png'), 'not-really-a-png');

    const daemon = await startDaemon(buildConfig({ staticDir }), async () => ({ status: 200, body: GOLDEN_BODY }));
    try {
      const headerFor = async (requestPath: string): Promise<string | null> => {
        const response = await fetch(`http://127.0.0.1:${daemon.port}${requestPath}`, {
          headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
        });
        expect(response.status).toBe(200);
        return response.headers.get('cache-control');
      };

      // 1. The unhashed app shell must revalidate — this is the class that let
      //    Cloudflare serve a stale shell after a deploy.
      expect(await headerFor('/index.html')).toBe('no-cache');
      expect(await headerFor('/sw.js')).toBe('no-cache');
      expect(await headerFor('/manifest.webmanifest')).toBe('no-cache');
      // The SPA fallback serves index.html, so it is shell-classed too.
      expect(await headerFor('/sessions')).toBe('no-cache');

      // 2. Content-hashed build output: the URL changes when the bytes do.
      expect(await headerFor('/assets/index-a1b2c3d4.js')).toBe('public, max-age=31536000, immutable');

      // 3. Everything else: a short conservative default.
      expect(await headerFor('/icons/icon-512.v2.png')).toBe('public, max-age=300');
    } finally {
      await daemon.stop();
    }
  });
});
