import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { WebSocket } from 'ws';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import { createLocalAccessVerifier, createUnconfiguredVerifier, type AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';

// RIDER (calibration.md 2026-07-20 flakiness finding): the I14-matrix tests here
// spin up real servers + JWKS + WS upgrades and time out at the default 5000ms
// under CPU contention. Raise this FILE's per-test timeout to 30s (like the
// slice-0 I2 sweep). Timeout only — no assertion is weakened.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const AUDIENCE = 'vimes-access-app-aud-tag';
const INDEX_HTML_MARKER = '<html>vimes-product-index</html>';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-auth-'));
let databaseFileCounter = 0;

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `auth-${databaseFileCounter}.db`);
}

function buildConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: nextDatabasePath(),
    dataDir: temporaryDirectory,
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
    ...overrides,
  };
}

function startDaemon(config: DaemonConfig, verifier: AccessVerifier | undefined): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier,
  });
  return daemon.start().then(() => daemon);
}

// Token minting over a locally-generated RS256 keypair (kid = KEY_A_KID). A second
// keypair with no JWK in the set stands in for a forged (wrong-key) token.
const KEY_A_KID = 'test-key-a';
let jwksForVerifier: JSONWebKeySet;
let signValidClaims: (claims: Record<string, unknown>, expiresIn: string) => Promise<string>;
let signWrongAudience: () => Promise<string>;
let signWithForeignKey: () => Promise<string>;
let signExpired: () => Promise<string>;

beforeAll(async () => {
  const keyPairA = await generateKeyPair('RS256', { extractable: true });
  const keyPairB = await generateKeyPair('RS256', { extractable: true });
  const publicJwkA = { ...(await exportJWK(keyPairA.publicKey)), kid: KEY_A_KID, alg: 'RS256', use: 'sig' };
  jwksForVerifier = { keys: [publicJwkA] };

  signValidClaims = (claims, expiresIn) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KEY_A_KID })
      .setIssuedAt()
      .setAudience(AUDIENCE)
      .setExpirationTime(expiresIn)
      .sign(keyPairA.privateKey);

  signWrongAudience = () =>
    new SignJWT({ email: 'wes@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_A_KID })
      .setIssuedAt()
      .setAudience('some-other-application')
      .setExpirationTime('2h')
      .sign(keyPairA.privateKey);

  // Signed with key B but presented under key A's kid — signature will not verify.
  signWithForeignKey = () =>
    new SignJWT({ email: 'forger@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_A_KID })
      .setIssuedAt()
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(keyPairB.privateKey);

  signExpired = () =>
    new SignJWT({ email: 'wes@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_A_KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(keyPairA.privateKey);
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

interface HttpProbeResult {
  status: number;
  body: string;
}

function probeHttp(port: number, path: string, token: string | undefined): Promise<HttpProbeResult> {
  const headers = token === undefined ? undefined : { 'cf-access-jwt-assertion': token };
  return fetch(`http://127.0.0.1:${port}${path}`, { headers }).then(async (response) => ({
    status: response.status,
    body: await response.text(),
  }));
}

interface UpgradeProbeResult {
  opened: boolean;
  statusCode: number | undefined;
}

// path defaults to '/ws' — the only pathname the daemon's upgrade handler
// accepts past auth (packages/daemon/src/app.ts). Callers probing the
// auth-first ordering against a different path pass it explicitly.
function probeWsUpgrade(port: number, token: string | undefined, path = '/ws'): Promise<UpgradeProbeResult> {
  return new Promise((resolvePromise) => {
    const headers = token === undefined ? {} : { 'cf-access-jwt-assertion': token };
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socket.on('open', () => {
      socket.close();
      resolvePromise({ opened: true, statusCode: 101 });
    });
    socket.on('unexpected-response', (_request, response) => {
      resolvePromise({ opened: false, statusCode: response.statusCode });
      response.destroy();
    });
    socket.on('error', () => {
      resolvePromise({ opened: false, statusCode: undefined });
    });
  });
}

function authRejectedRecords(daemon: Daemon): Array<{ path: string; reason: string }> {
  return daemon.store
    .read('system', 1)
    .filter((record) => record.type === 'auth_rejected')
    .map((record) => record.payload as { path: string; reason: string });
}

const PRODUCT_MARKERS = ['"ok"', '"schemaVersion"', '"sessions"', INDEX_HTML_MARKER];

function assertZeroProductBytes(body: string): void {
  for (const marker of PRODUCT_MARKERS) {
    expect(body).not.toContain(marker);
  }
}

describe('I14 auth matrix — real verifier over a locally-minted JWKS', () => {
  const HTTP_PATHS = [
    '/api/health',
    '/api/projections/sessions',
    '/api/files/roots',
    '/api/terminals',
    '/api/git/repos',
    '/api/git/status',
    '/api/git/diff',
    '/api/git/branches',
    '/api/git/worktrees',
    '/',
  ];

  interface InvalidCase {
    label: string;
    reason: string;
    makeToken: () => Promise<string | undefined>;
  }

  const invalidCases: InvalidCase[] = [
    { label: 'absent token', reason: 'missing-token', makeToken: async () => undefined },
    { label: 'garbage token', reason: 'malformed', makeToken: async () => 'garbage.token.value' },
    { label: 'wrong-aud token', reason: 'wrong-aud', makeToken: () => signWrongAudience() },
    { label: 'wrong-key token', reason: 'invalid-signature', makeToken: () => signWithForeignKey() },
    { label: 'expired token', reason: 'expired', makeToken: () => signExpired() },
  ];

  it('rejects every invalid probe on every HTTP path: 401 + exact reason evented + zero product bytes', async () => {
    for (const invalidCase of invalidCases) {
      const staticDir = mkdtempSync(join(temporaryDirectory, 'static-'));
      writeFileSync(join(staticDir, 'index.html'), INDEX_HTML_MARKER, 'utf8');
      const daemon = await startDaemon(buildConfig({ staticDir }), createLocalAccessVerifier({ jwks: jwksForVerifier, aud: AUDIENCE }));
      try {
        const token = await invalidCase.makeToken();
        for (const path of HTTP_PATHS) {
          const before = authRejectedRecords(daemon).length;
          const result = await probeHttp(daemon.port, path, token);
          expect(result.status, `${invalidCase.label} @ ${path}`).toBe(401);
          assertZeroProductBytes(result.body);
          const rejected = authRejectedRecords(daemon);
          expect(rejected.length).toBe(before + 1);
          expect(rejected.at(-1)!.reason, `${invalidCase.label} @ ${path}`).toBe(invalidCase.reason);
        }
      } finally {
        await daemon.stop();
      }
    }
  });

  it('rejects every invalid probe on the WS upgrade: 401 + exact reason evented, never opens', async () => {
    for (const invalidCase of invalidCases) {
      const daemon = await startDaemon(buildConfig({}), createLocalAccessVerifier({ jwks: jwksForVerifier, aud: AUDIENCE }));
      try {
        const token = await invalidCase.makeToken();
        const before = authRejectedRecords(daemon).length;
        const result = await probeWsUpgrade(daemon.port, token);
        expect(result.opened, invalidCase.label).toBe(false);
        expect(result.statusCode, invalidCase.label).toBe(401);
        const rejected = authRejectedRecords(daemon);
        expect(rejected.length).toBe(before + 1);
        expect(rejected.at(-1)!.reason, invalidCase.label).toBe(invalidCase.reason);
      } finally {
        await daemon.stop();
      }
    }
  });

  it('unauthed upgrade to a non-/ws path still gets 401, never 404 (auth runs before the path check)', async () => {
    const daemon = await startDaemon(buildConfig({}), createLocalAccessVerifier({ jwks: jwksForVerifier, aud: AUDIENCE }));
    try {
      const before = authRejectedRecords(daemon).length;
      const result = await probeWsUpgrade(daemon.port, undefined, '/notws');
      expect(result.opened).toBe(false);
      expect(result.statusCode).toBe(401);
      const rejected = authRejectedRecords(daemon);
      expect(rejected.length).toBe(before + 1);
      expect(rejected.at(-1)!.reason).toBe('missing-token');
    } finally {
      await daemon.stop();
    }
  });

  it('accepts a valid token: 200 on HTTP, upgrade opens, zero auth_rejected events', async () => {
    const staticDir = mkdtempSync(join(temporaryDirectory, 'static-'));
    writeFileSync(join(staticDir, 'index.html'), INDEX_HTML_MARKER, 'utf8');
    const daemon = await startDaemon(buildConfig({ staticDir }), createLocalAccessVerifier({ jwks: jwksForVerifier, aud: AUDIENCE }));
    try {
      const token = await signValidClaims({ email: 'wes@example.com' }, '2h');

      const health = await probeHttp(daemon.port, '/api/health', token);
      expect(health.status).toBe(200);
      expect(health.body).toContain('"ok":true');

      const projection = await probeHttp(daemon.port, '/api/projections/sessions', token);
      expect(projection.status).toBe(200);
      expect(projection.body).toBe('{"sessions":{}}');

      const staticResponse = await probeHttp(daemon.port, '/', token);
      expect(staticResponse.status).toBe(200);
      expect(staticResponse.body).toBe(INDEX_HTML_MARKER);

      const upgrade = await probeWsUpgrade(daemon.port, token);
      expect(upgrade.opened).toBe(true);

      expect(authRejectedRecords(daemon)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });
});

describe('I14 fail-closed — unconfigured verifier rejects everything with 503', () => {
  it('answers 503 on HTTP and the WS upgrade with reason auth-not-configured', async () => {
    const daemon = await startDaemon(buildConfig({}), createUnconfiguredVerifier());
    try {
      const health = await probeHttp(daemon.port, '/api/health', undefined);
      expect(health.status).toBe(503);
      assertZeroProductBytes(health.body);

      const withToken = await probeHttp(daemon.port, '/api/projections/sessions', 'anything-at-all');
      expect(withToken.status).toBe(503);
      assertZeroProductBytes(withToken.body);

      // Repo DISCOVERY fails closed like every other product-port path — an
      // unconfigured verifier must never leak the shape of the filesystem.
      const repos = await probeHttp(daemon.port, '/api/git/repos', 'anything-at-all');
      expect(repos.status).toBe(503);
      assertZeroProductBytes(repos.body);

      const upgrade = await probeWsUpgrade(daemon.port, undefined);
      expect(upgrade.opened).toBe(false);
      expect(upgrade.statusCode).toBe(503);

      const rejected = authRejectedRecords(daemon);
      expect(rejected.length).toBeGreaterThanOrEqual(3);
      expect(new Set(rejected.map((entry) => entry.reason))).toEqual(new Set(['auth-not-configured']));
    } finally {
      await daemon.stop();
    }
  });

  it('a daemon with no team domain / aud in config resolves to the fail-closed verifier', async () => {
    const daemon = await startDaemon(buildConfig({}), undefined);
    try {
      expect(daemon.authConfigured).toBe(false);
      const health = await probeHttp(daemon.port, '/api/health', undefined);
      expect(health.status).toBe(503);
    } finally {
      await daemon.stop();
    }
  });
});
