import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SteppingClock, usageBlock, type EventRecord, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon, type DaemonDeps } from './app.js';
import type { DaemonConfig } from './config.js';
import { standingNotesPathFor } from './orchestratorApi.js';
import { HOOK_SECRET_ENV_VAR, sessionSettingsPath } from './sessionSettings.js';
import type { SdkQueryFactory, SdkQueryOptions, SdkStreamMessage } from './sessionHost.js';

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
//
// The options of the most recent spawn are recorded so a case can read the
// per-spawn hook secret out of the child's ENVIRONMENT — the only place it
// exists now that it is out of the relay command line.
let lastSdkOptions: SdkQueryOptions | undefined;
function takeLastSdkOptions(): SdkQueryOptions {
  if (lastSdkOptions === undefined) {
    throw new Error('no SDK spawn was recorded');
  }
  const options = lastSdkOptions;
  lastSdkOptions = undefined;
  return options;
}
const fakeSdkFactory: SdkQueryFactory = ({ options }) => {
  lastSdkOptions = options;
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
    cliVersionFloor: undefined,
    cliVersionLastVerified: undefined,
    sdkCliVersionFloor: undefined,
    sdkCliVersionLastVerified: undefined,
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
    usageBackoffMaxIntervalMs: 1_800_000,
    usageBackoffMultiplier: 2,
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

// Spawn a session and lift its per-spawn secret out of the environment the
// daemon handed the child — the settings file only names `$VIMES_HOOK_SECRET`,
// so this mirrors what a real hook's shell expands at run time. Also asserts
// the settings file startProcess wrote is the one the spawn was pointed at.
function spawnAndSecret(daemon: Daemon, dataDir: string): { appSessionId: string; secret: string } {
  const spawn = daemon.sessionHost.spawnSession({ channel: 'sdk', cwd: projectRoot });
  const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
  const options = takeLastSdkOptions();
  expect(options.settings).toBe(sessionSettingsPath(dataDir, appSessionId));
  const secret = options.env![HOOK_SECRET_ENV_VAR]!;
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

// ─── D73 (S16·U1): the boot version check is a FLOOR plus a LAST-VERIFIED mark ─
//
// ⚠ **THIS SUITE WAS RE-PINNED, NOT EXTENDED.** It used to assert EXACT EQUALITY
// against `expectedCliVersion`, which is gone: that guard fired on every forward
// auto-update (five consecutive uninformative boot warnings against one unmoved
// pin) and a guard that always fires trains its reader to ignore it. D73 replaced
// the comparison, so the cases that pinned the old one are replaced too.
//
// What the daemon owes at boot, per channel, and what is asserted below:
//   • observed BELOW the floor            → warn (the one real warning) + event
//   • observed AT or ABOVE the floor      → SILENT; the info line carries the
//                                           distance from evidence
//   • observed null (the blind auto-start path, 2026-08-10) → its OWN warn,
//                                           never a silent pass (rider (b))
//   • observed unparseable                → same family; unparseable ≠ ok
//   • no floor pinned                     → report-only, exactly today's SDK posture
//
// Both channels run the SAME code (rider (a)); the production asymmetry is DATA —
// the SDK pins stay unset — and the unset-floor case below is what proves that
// posture survives.
describe('runtime version drift (E4, warn-only) — D73 floor + last-verified', () => {
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

  // The pin the calibrated production floor is shaped like, and a last-verified
  // marker sitting on it. Named rather than inlined so a case reads as "below the
  // floor" instead of "below 2.1.224".
  const FLOOR_VERSION = '2.1.224';
  const LAST_VERIFIED_VERSION = '2.1.224';
  const SDK_BINARY_PATH = '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

  // ⚠ THE NUMERIC-COMPARISON TRAP, as data: '2.1.9' is BELOW '2.1.224' by number
  // and ABOVE it as a string. A lexicographic comparator passes every other case
  // in this file and fails only this one.
  const BELOW_FLOOR_VERSION = '2.1.9';
  const ABOVE_FLOOR_VERSION = '2.1.232';

  // Every line the daemon writes to stdout starts with this; anything else that
  // arrives while the capture is installed belongs to the test reporter and is
  // passed straight through rather than swallowed.
  const DAEMON_STDOUT_PREFIX = 'vimes-daemon:';

  interface BootObservation {
    daemon: Daemon;
    // console.warn lines — the operator-visible half, and the half the journald
    // grep contract is written against.
    warnings: string[];
    // process.stdout lines — the report half, owed in every state.
    bootLines: string[];
  }

  async function bootAndCaptureOutput(overrides: Partial<DaemonDeps>): Promise<BootObservation> {
    const warnings: string[] = [];
    const bootLines: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map((part) => String(part)).join(' '));
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.startsWith(DAEMON_STDOUT_PREFIX)) {
        bootLines.push(text.trimEnd());
        return true;
      }
      return (originalStdoutWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as unknown as typeof process.stdout.write);
    try {
      const daemon = await startDaemon(overrides);
      return { daemon, warnings, bootLines };
    } finally {
      warnSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  }

  function bootLineFor(observation: BootObservation, channel: 'pty' | 'sdk'): string {
    const line = observation.bootLines.find((candidate) => candidate.includes(`${channel} running`));
    if (line === undefined) {
      throw new Error(`no boot info line for the ${channel} channel in: ${observation.bootLines.join(' | ')}`);
    }
    return line;
  }

  // ─── The one real warning: older than the evidence ──────────────────────────

  it('an observed version BELOW the floor warns, numerically — 2.1.9 is below 2.1.224', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => BELOW_FLOOR_VERSION,
    });
    try {
      expect(observation.warnings).toHaveLength(1);
      // The journald grep contract: the deploy procedure looks for this exact
      // phrase, so it survives the comparison change verbatim.
      expect(observation.warnings[0]!).toContain('CLI runtime drift');
      expect(observation.warnings[0]!).toContain(`observed ${BELOW_FLOOR_VERSION} is BELOW the verified floor`);
      expect(observation.warnings[0]!).toContain(FLOOR_VERSION);
      // The payload carries THE FLOOR in `expected` — the core schema is unchanged,
      // so the field name still says "expected" while the fact behind it is D73's.
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: BELOW_FLOOR_VERSION, channel: 'pty' },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  // ─── The noise D73 removed: a forward auto-update is SILENT ─────────────────

  it('an observed version ABOVE the floor is SILENT, and the info line counts the distance from evidence', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => ABOVE_FLOOR_VERSION,
    });
    try {
      // The whole point of the decision: this is the case that fired five times in
      // a row under exact equality and told the operator nothing.
      expect(observation.warnings).toEqual([]);
      const infoLine = bootLineFor(observation, 'pty');
      expect(infoLine).toContain(`pty running ${ABOVE_FLOOR_VERSION}`);
      expect(infoLine).toContain(`floor ${FLOOR_VERSION}`);
      expect(infoLine).toContain(`last verified ${LAST_VERIFIED_VERSION}`);
      // 2.1.232 − 2.1.224 = 8, and INFO is the only class this number ever has.
      expect(infoLine).toContain('(+8 patch releases ahead of evidence)');
      expect(infoLine).not.toContain('CLI runtime drift');
      // Silent to the operator is NOT silent to the log: the observation is still
      // recorded, because that payload is evidence rather than decoration.
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: ABOVE_FLOOR_VERSION, channel: 'pty' },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  it('observed EXACTLY at the last-verified marker is the quiet steady state — no warn, no event, no ahead-clause', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => LAST_VERIFIED_VERSION,
    });
    try {
      expect(observation.warnings).toEqual([]);
      expect(driftEvents(observation.daemon)).toEqual([]);
      // Never "+0 patch releases ahead of evidence" — a zero is not news.
      expect(bootLineFor(observation, 'pty')).not.toContain('ahead of evidence');
    } finally {
      await observation.daemon.stop();
    }
  });

  it('an ahead-clause is NEVER computed across a minor boundary — 2.2.0 is not "N patches" ahead of 2.1.224', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => '2.2.0',
    });
    try {
      expect(observation.warnings).toEqual([]);
      // A subtracted patch number here would be a fabricated statistic on a boot
      // line. The clause is omitted instead; the raw versions still both appear.
      expect(bootLineFor(observation, 'pty')).not.toContain('ahead of evidence');
      expect(bootLineFor(observation, 'pty')).toContain('pty running 2.2.0');
    } finally {
      await observation.daemon.stop();
    }
  });

  // ─── Rider (b): UNKNOWN IS ITS OWN STATE, never a silent pass ───────────────

  it('a probe that answers NOTHING warns as UNKNOWN — the 2026-08-10 blind-auto-start hole, closed', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => null,
    });
    try {
      expect(observation.warnings).toHaveLength(1);
      // Same grep phrase as the below-floor path, so one journald search finds both.
      expect(observation.warnings[0]!).toContain('CLI runtime drift');
      expect(observation.warnings[0]!).toContain('CLI version UNKNOWN, the probe answered nothing');
      expect(observation.warnings[0]!).toContain(`floor ${FLOOR_VERSION} NOT CHECKED`);
      expect(bootLineFor(observation, 'pty')).toContain('pty running (unknown)');
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: null, channel: 'pty' },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  it('a version that will not PARSE warns too — unparseable is not the same as ok', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => '2.1.x-nightly',
    });
    try {
      expect(observation.warnings).toHaveLength(1);
      expect(observation.warnings[0]!).toContain('CLI runtime drift');
      expect(observation.warnings[0]!).toContain('CLI version UNPARSEABLE (observed "2.1.x-nightly")');
      expect(observation.warnings[0]!).toContain(`floor ${FLOOR_VERSION} NOT CHECKED`);
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: '2.1.x-nightly', channel: 'pty' },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  // ─── An unpinned floor is REPORT-ONLY, in every state ───────────────────────

  it('NO floor pinned → never warns, not even for an unknown observation, and reports expected: null', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: undefined, cliVersionLastVerified: undefined }),
      cliVersionProbe: async () => null,
    });
    try {
      // There is nothing to be below, so there is nothing to warn about. This is
      // the branch that preserves the SDK channel's shipped posture while its pins
      // stay unset (rule 0.2).
      expect(observation.warnings).toEqual([]);
      expect(bootLineFor(observation, 'pty')).toContain('floor (unset), last verified (unset)');
      expect(driftEvents(observation.daemon)).toEqual([{ expected: null, observed: null, channel: 'pty' }]);
    } finally {
      await observation.daemon.stop();
    }
  });

  // ─── The two channels are watched independently (drift-checker fix) ─────────
  // The PATH `claude` (pty) and the SDK-vendored binary run different versions by
  // design, so each is judged against its OWN floor and neither can raise drift
  // for the other. D73 rider (a): the SEMANTICS are shared; the PINS are not.

  it('an sdk observation below the SDK floor warns the sdk channel ONLY, with the binary named', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({
        cliVersionFloor: FLOOR_VERSION,
        cliVersionLastVerified: LAST_VERIFIED_VERSION,
        sdkCliVersionFloor: '2.1.207',
        sdkCliVersionLastVerified: '2.1.207',
      }),
      cliVersionProbe: async () => ABOVE_FLOOR_VERSION,
      sdkCliVersionProbe: async () => ({ version: '2.1.100', binaryPath: SDK_BINARY_PATH }),
    });
    try {
      expect(observation.warnings).toHaveLength(1);
      expect(observation.warnings[0]!).toContain('CLI runtime drift (sdk)');
      expect(observation.warnings[0]!).toContain('observed 2.1.100 is BELOW the verified floor 2.1.207');
      // An SDK-channel surprise is usually the vendored CLI moving under us, so the
      // resolved path rides along.
      expect(observation.warnings[0]!).toContain(`binary=${SDK_BINARY_PATH}`);
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: ABOVE_FLOOR_VERSION, channel: 'pty' },
        { expected: '2.1.207', observed: '2.1.100', channel: 'sdk', binaryPath: SDK_BINARY_PATH },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  it('an UNPINNED sdk channel never warns, even though it sits far below the PTY floor', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ cliVersionFloor: FLOOR_VERSION, cliVersionLastVerified: LAST_VERIFIED_VERSION }),
      cliVersionProbe: async () => ABOVE_FLOOR_VERSION,
      sdkCliVersionProbe: async () => ({ version: '2.1.207', binaryPath: SDK_BINARY_PATH }),
    });
    try {
      // The false-drift trap: the pty floor is NEVER asserted against the sdk
      // channel. 2.1.207 is below 2.1.224 and says nothing, because the pin that
      // would judge it does not exist.
      expect(observation.warnings).toEqual([]);
      expect(bootLineFor(observation, 'sdk')).toContain('floor (unset), last verified (unset)');
      // ⚠ RE-PIN vs the pre-D73 suite: the unpinned sdk channel used to emit NO
      // event at all, while the unpinned PTY channel emitted one with
      // `expected: null`. Rider (a) dissolves that asymmetry — the code treats both
      // channels identically, so an unpinned channel is now OBSERVED (evidence)
      // while remaining unasserted (no warning).
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: FLOOR_VERSION, observed: ABOVE_FLOOR_VERSION, channel: 'pty' },
        { expected: null, observed: '2.1.207', channel: 'sdk', binaryPath: SDK_BINARY_PATH },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });

  it('an unresolvable sdk binary is reported honestly and still raises the UNKNOWN warning against a floor', async () => {
    const observation = await bootAndCaptureOutput({
      config: buildConfig({ sdkCliVersionFloor: '2.1.207', sdkCliVersionLastVerified: '2.1.207' }),
      sdkCliVersionProbe: async () => ({ version: null, binaryPath: null }),
    });
    try {
      expect(observation.warnings).toHaveLength(1);
      expect(observation.warnings[0]!).toContain('CLI runtime drift (sdk)');
      expect(observation.warnings[0]!).toContain('CLI version UNKNOWN, the probe answered nothing');
      expect(observation.warnings[0]!).toContain('binary=(unresolved)');
      expect(driftEvents(observation.daemon)).toEqual([
        { expected: '2.1.207', observed: null, channel: 'sdk', binaryPath: null },
      ]);
    } finally {
      await observation.daemon.stop();
    }
  });
});

// ─── S8·4 (D64): the two hooks the ingress ANSWERS ───────────────────────────
//
// Everything below runs against a REAL daemon over a REAL HTTP round trip, so
// the thing under test is the wire shape the injected relay will actually read —
// a bare `hold`/`allow` word for PreCompact, and the CLI's `additionalContext`
// envelope for a post-compaction SessionStart.
describe('hook ingress — the S8·4 answer paths', () => {
  // ⟨tune⟩ V0_COMPACTION_STEWARD_CONFIG's real thresholds are 250k nudge / 300k
  // hold. These are NOT assertions about those numbers (Gate-D, rule 0.2) — they
  // are a fill comfortably past both, chosen so the door's arming is unambiguous.
  const FILL_PAST_THE_DOOR = 400_000;

  function spawnOrchestratorAndSecret(
    daemon: Daemon,
    dataDir: string,
    projectId: string,
  ): { appSessionId: string; secret: string } {
    const spawn = daemon.sessionHost.spawnSession({
      channel: 'sdk',
      cwd: projectRoot,
      orchestratorForProjectId: projectId,
    });
    const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
    const options = takeLastSdkOptions();
    expect(options.settings).toBe(sessionSettingsPath(dataDir, appSessionId));
    return { appSessionId, secret: options.env![HOOK_SECRET_ENV_VAR]! };
  }

  // Drive the fill past the thresholds through the SAME signal production uses —
  // a `usage_block` on the session's own stream — so the steward's watcher fires
  // exactly as it will in the daemon, nudge and all.
  function driveFillPastTheDoor(daemon: Daemon, appSessionId: string): void {
    daemon.router.emit([
      usageBlock({
        appSessionId,
        messageId: 'msg-fill-1',
        usage: { input_tokens: FILL_PAST_THE_DOOR },
      }),
    ]);
  }

  function preCompactBody(): string {
    // The verbatim PreCompact stdin shape SP8·1 OBSERVED (rule 0.7).
    return JSON.stringify({
      session_id: 'claude-sdk',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      custom_instructions: null,
    });
  }

  it('an ORDINARY session always gets `allow`, and no compaction_held is written', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnAndSecret(daemon, config.dataDir);
      driveFillPastTheDoor(daemon, appSessionId);

      const response = await postHook(daemon.hookPort, appSessionId, secret, preCompactBody());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('allow');
      expect(streamRecords(daemon, appSessionId).map((r) => r.type)).not.toContain('compaction_held');
      // The fire itself is still recorded — answering never replaces witnessing.
      expect(streamRecords(daemon, appSessionId).map((r) => r.type)).toContain('hook_pre_compact');
    } finally {
      await daemon.stop();
    }
  });

  it('an UNBANKED orchestrator past the threshold gets `hold`, and the veto is evented', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnOrchestratorAndSecret(daemon, config.dataDir, 'proj-hold');
      // Arms the door: the fill fires the first nudge, which is what gives
      // `decideCompactionGate` a start-of-asking mark to compare the (absent)
      // notes file against.
      driveFillPastTheDoor(daemon, appSessionId);
      expect(streamRecords(daemon, appSessionId).map((r) => r.type)).toContain('compaction_nudge_sent');

      const response = await postHook(daemon.hookPort, appSessionId, secret, preCompactBody());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hold');
      const held = streamRecords(daemon, appSessionId).filter((r) => r.type === 'compaction_held');
      expect(held).toHaveLength(1);
      expect((held[0]!.payload as { contextTokens: number }).contextTokens).toBe(FILL_PAST_THE_DOOR);
    } finally {
      await daemon.stop();
    }
  });

  it('the SAME orchestrator gets `allow` once its standing notes are written', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const projectId = 'proj-banked';
      const { appSessionId, secret } = spawnOrchestratorAndSecret(daemon, config.dataDir, projectId);
      driveFillPastTheDoor(daemon, appSessionId);
      expect(await (await postHook(daemon.hookPort, appSessionId, secret, preCompactBody())).text()).toBe('hold');

      // The orchestrator banks — the same file the founding briefing reads back.
      const notesPath = standingNotesPathFor(join(config.dataDir, 'orchestrator-notes'), projectId);
      mkdirSync(dirname(notesPath), { recursive: true });
      writeFileSync(notesPath, '# banked\n', 'utf8');

      const response = await postHook(daemon.hookPort, appSessionId, secret, preCompactBody());
      expect(await response.text()).toBe('allow');
      // Still exactly the ONE hold from before the bank — an allow events nothing.
      expect(streamRecords(daemon, appSessionId).filter((r) => r.type === 'compaction_held')).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it('an orchestrator that was NEVER nudged gets `allow` — the door needs an ask first', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const { appSessionId, secret } = spawnOrchestratorAndSecret(daemon, config.dataDir, 'proj-unnudged');
      // No usage_block at all: no fill observed, so no nudge and no hold.
      const response = await postHook(daemon.hookPort, appSessionId, secret, preCompactBody());
      expect(await response.text()).toBe('allow');
    } finally {
      await daemon.stop();
    }
  });

  it('a compacted ORCHESTRATOR SessionStart answers with the additionalContext envelope', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const projectId = 'proj-resume';
      const { appSessionId, secret } = spawnOrchestratorAndSecret(daemon, config.dataDir, projectId);
      const response = await postHook(
        daemon.hookPort,
        appSessionId,
        secret,
        // `source: "compact"` is the CLI's own post-compaction SessionStart
        // marker (OBSERVED, SP8·1).
        JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'claude-sdk' }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(body.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(body.hookSpecificOutput.additionalContext).toContain(
        standingNotesPathFor(join(config.dataDir, 'orchestrator-notes'), projectId),
      );
    } finally {
      await daemon.stop();
    }
  });

  it('every OTHER case keeps today\'s byte-identical `ok` body', async () => {
    const config = buildConfig();
    const daemon = await startDaemon({ config });
    try {
      const orchestrator = spawnOrchestratorAndSecret(daemon, config.dataDir, 'proj-ok');
      const ordinary = spawnAndSecret(daemon, config.dataDir);

      // An ORDINARY session's post-compaction SessionStart: not our business.
      const ordinaryCompact = await postHook(
        daemon.hookPort,
        ordinary.appSessionId,
        ordinary.secret,
        JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'claude-sdk' }),
      );
      expect(await ordinaryCompact.text()).toBe('ok');

      // The ORCHESTRATOR's ordinary (non-compact) SessionStart sources.
      for (const source of ['startup', 'resume', 'clear']) {
        const response = await postHook(
          daemon.hookPort,
          orchestrator.appSessionId,
          orchestrator.secret,
          JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: 'claude-sdk' }),
        );
        expect(await response.text()).toBe('ok');
      }

      // ...and every non-answered hook, on the orchestrator itself.
      for (const hookEventName of ['Stop', 'StopFailure', 'PreToolUse', 'SessionEnd']) {
        const response = await postHook(
          daemon.hookPort,
          orchestrator.appSessionId,
          orchestrator.secret,
          JSON.stringify({ hook_event_name: hookEventName, session_id: 'claude-sdk' }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
      }
    } finally {
      await daemon.stop();
    }
  });
});
