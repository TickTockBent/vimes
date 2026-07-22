import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SteppingClock, type EventRecord, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon, type DaemonDeps } from './app.js';
import type { DaemonConfig } from './config.js';
import { sessionSettingsPath } from './sessionSettings.js';
import type { SdkQueryFactory, SdkStreamMessage } from './sessionHost.js';

const HOOK_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'hooks');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-hookingress-'));
const projectRoot = mkdtempSync(join(temporaryDirectory, 'proj-'));
let databaseFileCounter = 0;

// Access verifier that rejects a missing token (so the "4600 does not serve
// /hooks — but auth still runs first" claim is testable).
const tokenRequiredVerifier: AccessVerifier = {
  verify: async (token) => (token === undefined || token === '' ? { ok: false, reason: 'missing-token' } : { ok: true }),
};

// Unique eventIds across daemons over distinct files (host appends host_started
// each boot; a shared deterministic counter would collide).
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

// A fake SDK query: yield the init frame (mapping 'claude-sdk'), then end. The
// session goes dormant, but the spawn secret lingers (D10) so hook posts still
// authenticate, and the session record still exists for correlation.
const fakeSdkFactory: SdkQueryFactory = () => {
  const generator = (async function* (): AsyncGenerator<SdkStreamMessage> {
    yield { type: 'system', subtype: 'init', session_id: 'claude-sdk' };
  })();
  return Object.assign(generator, { close: () => void generator.return(undefined) });
};

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  databaseFileCounter += 1;
  return {
    port: 0,
    hookPort: 0,
    dbPath: join(temporaryDirectory, `hooks-${databaseFileCounter}.db`),
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
    projectRoots: [projectRoot],
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

function startDaemon(overrides: Partial<DaemonDeps> = {}): Promise<Daemon> {
  const daemon = createDaemon({
    config: overrides.config ?? buildConfig(),
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: tokenRequiredVerifier,
    sdkQueryFactory: fakeSdkFactory,
    projectsRoot: projectRoot,
    ...overrides,
  });
  return daemon.start().then(() => daemon);
}

// Spawn a session and lift its per-spawn secret out of the settings file that
// startProcess wrote synchronously (read before the async stream tears it down).
function spawnAndSecret(daemon: Daemon, dataDir: string): { appSessionId: string; secret: string } {
  const spawn = daemon.sessionHost.spawnSession({ channel: 'sdk', cwd: projectRoot });
  const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
  const settings = JSON.parse(readFileSync(sessionSettingsPath(dataDir, appSessionId), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const relay = settings.hooks.SessionStart![0]!.hooks[0]!.command;
  const secret = /Bearer ([^"\s]+)/.exec(relay)![1]!;
  return { appSessionId, secret };
}

function postHook(
  hookPort: number,
  appSessionId: string,
  secret: string | undefined,
  body: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== undefined) {
    headers.authorization = `Bearer ${secret}`;
  }
  return fetch(`http://127.0.0.1:${hookPort}/hooks/${appSessionId}`, { method: 'POST', headers, body });
}

function streamRecords(daemon: Daemon, stream: string): EventRecord[] {
  return daemon.store.read(stream, 1);
}

function authRejected(daemon: Daemon): Array<{ path: string; reason: string }> {
  return streamRecords(daemon, 'system')
    .filter((record) => record.type === 'auth_rejected')
    .map((record) => record.payload as { path: string; reason: string });
}

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('hook ingress — auth matrix (I14 extends to the separate listener)', () => {
  it('accepts a valid secret for a known session (200), rejects the four invalid cases (401 + reason)', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);
      const validBody = JSON.stringify({ hook_event_name: 'Stop', session_id: 'claude-sdk' });

      // valid
      const ok = await postHook(daemon.hookPort, appSessionId, secret, validBody);
      expect(ok.status).toBe(200);

      // missing secret
      const before1 = authRejected(daemon).length;
      const missing = await postHook(daemon.hookPort, appSessionId, undefined, validBody);
      expect(missing.status).toBe(401);
      expect(authRejected(daemon).at(-1)!.reason).toBe('missing-secret');
      expect(authRejected(daemon).length).toBe(before1 + 1);

      // wrong secret
      const wrong = await postHook(daemon.hookPort, appSessionId, 'not-the-secret', validBody);
      expect(wrong.status).toBe(401);
      expect(authRejected(daemon).at(-1)!.reason).toBe('bad-secret');

      // unknown session
      const unknown = await postHook(daemon.hookPort, 'no-such-session', secret, validBody);
      expect(unknown.status).toBe(401);
      expect(authRejected(daemon).at(-1)!.reason).toBe('unknown-session');

      // the auth_rejected events never carry the secret or the payload body
      for (const record of streamRecords(daemon, 'system').filter((r) => r.type === 'auth_rejected')) {
        expect(JSON.stringify(record.payload)).not.toContain(secret);
        expect(Object.keys(record.payload as object).sort()).toEqual(['path', 'reason']);
      }
    } finally {
      await daemon.stop();
    }
  });

  it('the MAIN product server does NOT serve /hooks: 404 with a valid JWT, 401 without (auth first)', async () => {
    const daemon = await startDaemon();
    try {
      const withToken = await fetch(`http://127.0.0.1:${daemon.port}/hooks/whatever`, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': 'any-token', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(withToken.status).toBe(404);

      const withoutToken = await fetch(`http://127.0.0.1:${daemon.port}/hooks/whatever`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(withoutToken.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('the hook ingress 404s any path/method other than POST /hooks/:id', async () => {
    const daemon = await startDaemon();
    try {
      const getHooks = await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/x`);
      expect(getHooks.status).toBe(404);
      const other = await fetch(`http://127.0.0.1:${daemon.hookPort}/api/health`);
      expect(other.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});

describe('hook ingress — golden fixtures → hook_* events (rule 0.6, CLI 2.1.215)', () => {
  const fixtureCases: Array<{ file: string; eventType: string }> = [
    { file: 'session-start.json', eventType: 'hook_session_start' },
    { file: 'stop.json', eventType: 'hook_stop' },
    { file: 'session-end.json', eventType: 'hook_session_end' },
    { file: 'pre-tool-use.json', eventType: 'hook_pre_tool_use' },
  ];

  it('each golden fixture posts to the correct hook_* event with appSessionId stamped and body preserved', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);
      for (const fixtureCase of fixtureCases) {
        const raw = readFileSync(join(HOOK_FIXTURES_DIR, fixtureCase.file), 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const response = await postHook(daemon.hookPort, appSessionId, secret, raw);
        expect(response.status, fixtureCase.file).toBe(200);
        const event = streamRecords(daemon, appSessionId)
          .filter((record) => record.type === fixtureCase.eventType)
          .at(-1)!;
        expect(event, fixtureCase.file).toBeDefined();
        const payload = event.payload as Record<string, unknown>;
        expect(payload.appSessionId).toBe(appSessionId);
        // Loose passthrough kept the observed fields verbatim.
        expect(payload.hook_event_name).toBe(parsed.hook_event_name);
        expect(payload.session_id).toBe(parsed.session_id);
      }
    } finally {
      await daemon.stop();
    }
  });

  it('StopFailure (no golden fixture yet — synthetic) still routes to hook_stop_failure', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);
      const body = JSON.stringify({
        hook_event_name: 'StopFailure',
        session_id: 'claude-sdk',
        reason: 'rate-limit',
        resetsAt: '2026-07-19T12:00:00Z',
      });
      const response = await postHook(daemon.hookPort, appSessionId, secret, body);
      expect(response.status).toBe(200);
      const event = streamRecords(daemon, appSessionId).find((record) => record.type === 'hook_stop_failure')!;
      expect((event.payload as { reason: string; appSessionId: string })).toMatchObject({
        appSessionId,
        reason: 'rate-limit',
      });
    } finally {
      await daemon.stop();
    }
  });
});

describe('hook ingress — hostile input (rule 0.6, I8)', () => {
  it('malformed JSON is quarantined (400) and the listener survives to accept the next post', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);

      const malformed = await postHook(daemon.hookPort, appSessionId, secret, 'this is not json{{{');
      expect(malformed.status).toBe(400);
      const quarantined = streamRecords(daemon, appSessionId).find((record) => record.type === 'line_quarantined')!;
      expect((quarantined.payload as { reason: string }).reason).toBe('hook-malformed');

      // Listener survived: a well-formed post immediately after still works.
      const ok = await postHook(
        daemon.hookPort,
        appSessionId,
        secret,
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'claude-sdk' }),
      );
      expect(ok.status).toBe(200);
      expect(streamRecords(daemon, appSessionId).some((record) => record.type === 'hook_stop')).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('an authed but unrecognized hook_event_name is quarantined (200, no crash)', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);
      const response = await postHook(
        daemon.hookPort,
        appSessionId,
        secret,
        JSON.stringify({ hook_event_name: 'AlienHook', session_id: 'x' }),
      );
      expect(response.status).toBe(200);
      const quarantined = streamRecords(daemon, appSessionId).find(
        (record) => record.type === 'line_quarantined' && (record.payload as { reason: string }).reason === 'hook-unknown-event',
      );
      expect(quarantined).toBeDefined();
    } finally {
      await daemon.stop();
    }
  });
});

describe('runtime version drift (E4, warn-only)', () => {
  interface DriftPayload {
    expected: string | null;
    observed: string | null;
    channel?: 'pty' | 'sdk';
    binaryPath?: string | null;
  }

  function driftEvents(daemon: Daemon): DriftPayload[] {
    return streamRecords(daemon, 'system')
      .filter((record) => record.type === 'runtime_drift_observed')
      .map((record) => record.payload as DriftPayload);
  }

  it('emits runtime_drift_observed on a version mismatch', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '1.0.0' }),
      cliVersionProbe: async () => '9.9.9',
    });
    try {
      expect(driftEvents(daemon)).toEqual([{ expected: '1.0.0', observed: '9.9.9', channel: 'pty' }]);
    } finally {
      await daemon.stop();
    }
  });

  it('emits runtime_drift_observed when the expectation is unpinned (expected: null)', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: undefined }),
      cliVersionProbe: async () => '2.1.215',
    });
    try {
      expect(driftEvents(daemon)).toEqual([{ expected: null, observed: '2.1.215', channel: 'pty' }]);
    } finally {
      await daemon.stop();
    }
  });

  it('emits NO drift when the observed version matches the pin', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '2.1.215' }),
      cliVersionProbe: async () => '2.1.215',
    });
    try {
      expect(driftEvents(daemon)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  // ─── The two channels are watched independently (drift-checker fix) ─────────
  // The PATH `claude` (pty) and the SDK-vendored binary run different versions by
  // design, so each is judged against its OWN pin and neither can raise drift for
  // the other.
  const SDK_BINARY_PATH = '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

  it('a mismatching sdk pin drifts the sdk channel ONLY, with the binary named', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '2.1.217', expectedSdkCliVersion: '2.1.999' }),
      cliVersionProbe: async () => '2.1.217',
      sdkCliVersionProbe: async () => ({ version: '2.1.207', binaryPath: SDK_BINARY_PATH }),
    });
    try {
      expect(driftEvents(daemon)).toEqual([
        { expected: '2.1.999', observed: '2.1.207', channel: 'sdk', binaryPath: SDK_BINARY_PATH },
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it('a mismatching pty pin drifts the pty channel ONLY while the sdk pin matches', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '1.0.0', expectedSdkCliVersion: '2.1.207' }),
      cliVersionProbe: async () => '2.1.217',
      sdkCliVersionProbe: async () => ({ version: '2.1.207', binaryPath: SDK_BINARY_PATH }),
    });
    try {
      expect(driftEvents(daemon)).toEqual([{ expected: '1.0.0', observed: '2.1.217', channel: 'pty' }]);
    } finally {
      await daemon.stop();
    }
  });

  it('an UNPINNED sdk channel emits no drift, even though it differs from the pty pin', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '2.1.217', expectedSdkCliVersion: undefined }),
      cliVersionProbe: async () => '2.1.217',
      sdkCliVersionProbe: async () => ({ version: '2.1.207', binaryPath: SDK_BINARY_PATH }),
    });
    try {
      // The false-drift trap: the pty pin is NEVER asserted against the sdk
      // channel — an unpinned channel is reported at boot and nothing else.
      expect(driftEvents(daemon)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it('an unresolvable sdk binary is reported honestly and still raises drift against a pin', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ expectedCliVersion: '2.1.217', expectedSdkCliVersion: '2.1.207' }),
      cliVersionProbe: async () => '2.1.217',
      sdkCliVersionProbe: async () => ({ version: null, binaryPath: null }),
    });
    try {
      expect(driftEvents(daemon)).toEqual([
        { expected: '2.1.207', observed: null, channel: 'sdk', binaryPath: null },
      ]);
    } finally {
      await daemon.stop();
    }
  });
});
