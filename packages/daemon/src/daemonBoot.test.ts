import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  SteppingClock,
  gateFired,
  livenessChanged,
  meterSample,
  sessionCreated,
  withNotificationTrigger,
  type IdSource,
  type MeterRecord,
} from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import { DAEMON_API_VERSION, DAEMON_CAPABILITIES } from './apiVersion.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-boot-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';
// S11·U1 through S13·U3: `tasks` stayed in this list on purpose — it was the
// legacy tasks-projection ALIAS route (`legacyTasksViewOf` of the instances
// fold), and the assertion that it booted byte-identically was exactly the
// guarantee the deployed UI depended on across the one deploy of overlap
// (q24). S13·U4 deleted that alias route (instanceApi.ts's header); `tasks`
// is dropped from this list accordingly, leaving `instances` — its generic
// twin — as the sole reader of instance state.
const PROJECTION_IDS = ['sessions', 'meters', 'instances'] as const;

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `boot-${databaseFileCounter}.db`);
}

function buildConfig(dbPath: string): DaemonConfig {
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
  };
}

// Each daemon over the same file must mint globally-unique eventIds — the host
// now appends host_started/host_stopped on every boot, so two boots that shared a
// deterministic counter would collide. Production uses randomUUID for exactly
// this reason; the test mirrors it. (Projection bodies carry no eventId, so the
// byte-identical restart claim is unaffected.)
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

function startDaemon(dbPath: string): Promise<Daemon> {
  const daemon = createDaemon({
    config: buildConfig(dbPath),
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
  });
  return daemon.start().then(() => daemon);
}

function fetchProjection(daemon: Daemon, projectionId: string): Promise<string> {
  return fetch(`http://127.0.0.1:${daemon.port}/api/projections/${projectionId}`, {
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
  }).then((response) => {
    expect(response.status).toBe(200);
    return response.text();
  });
}

async function fetchAllProjections(daemon: Daemon): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const projectionId of PROJECTION_IDS) {
    bodies[projectionId] = await fetchProjection(daemon, projectionId);
  }
  return bodies;
}

function sampleMeter(used: number): MeterRecord {
  return {
    meterId: 'window-5h',
    kind: 'rolling-window',
    scope: 'all-models',
    modelFamily: null,
    used,
    limit: 1000,
    unit: 'tokens',
    resetsAt: null,
    source: 'jsonl',
    observedAt: '2026-01-01T00:00:00.000Z',
    stale: false,
  };
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('daemon boot — snapshot+tail cold start over a real sqlite file', () => {
  it('serves correct projection state via REST, then restarts byte-identical from snapshots', async () => {
    const dbPath = nextDatabasePath();

    // ——— First run: populate the log across all three projections ———
    const firstDaemon = await startDaemon(dbPath);
    let bodiesBeforeRestart: Record<string, string>;
    try {
      firstDaemon.router.emit([
        sessionCreated({ appSessionId: 'app-1', channel: 'sdk', cwd: '/home/wes/dongfu', name: null, forkedFrom: null, taskRef: null }),
      ]);
      firstDaemon.router.emit([livenessChanged({ appSessionId: 'app-1', to: 'running', cause: 'spawned' })]);
      firstDaemon.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-1', prompt: 'approve edit?' })));
      firstDaemon.router.emit([meterSample(sampleMeter(120))]);
      firstDaemon.router.emit([meterSample(sampleMeter(340))]);
      // Drive the session dormant before stop: a session the log left *live* is
      // legitimately marked `interrupted` by boot recovery (§3.10) on the second
      // run, which would (correctly) break the byte-identical restart. A dormant
      // session is the right fixture for the snapshot+tail cold-start claim.
      firstDaemon.router.emit([livenessChanged({ appSessionId: 'app-1', to: 'dormant', cause: 'run-complete' })]);

      bodiesBeforeRestart = await fetchAllProjections(firstDaemon);
      // Sanity: the sessions projection actually reflects the emitted events.
      expect(bodiesBeforeRestart.sessions).toContain('"app-1"');
      expect(bodiesBeforeRestart.sessions).toContain('"liveness":"dormant"');
      expect(bodiesBeforeRestart.meters).toContain('340');
    } finally {
      await firstDaemon.stop();
    }

    // ——— stop() must have written a snapshot row per projection ———
    const rawDatabase = new Database(dbPath, { readonly: true });
    try {
      const snapshotRows = rawDatabase
        .prepare('SELECT projectionId, savedAt FROM snapshots ORDER BY projectionId')
        .all() as Array<{ projectionId: string; savedAt: string }>;
      // The INVENTORY of snapshotted projections — one row per entry in
      // `DAEMON_PROJECTIONS`. It is spelled out rather than derived from the
      // constant on purpose: adding a projection to the daemon is a change that
      // should be visible in a diff somebody reads, not one that silently
      // satisfies its own assertion. `projects` arrived with S8·1 (D42's
      // registry); the other four predate it.
      //
      // ⚠ `instances` is where `tasks` used to be in this list (S11·U1, D72
      // Move 2). The projection id moved with the fold — the STREAM is still
      // 'tasks' (through S13·U3 the legacy tasks-projection alias route also
      // still answered off it, as the legacy view; S13·U4 deleted that route)
      // — so on the real database the old 'tasks' snapshot row survives,
      // orphaned and harmless, and the first boot after the deploy replays
      // the tasks stream from seq 1 under the new id (slice-11.md). This test
      // starts from an empty file, so only the new id appears.
      expect(snapshotRows.map((row) => row.projectionId)).toEqual([
        'cache-observability',
        'instances',
        'meters',
        'projects',
        'sessions',
      ]);
      for (const row of snapshotRows) {
        expect(row.savedAt).toMatch(/^2026-/);
      }
    } finally {
      rawDatabase.close();
    }

    // ——— Second run over the SAME file: boot from snapshot+tail ———
    const secondDaemon = await startDaemon(dbPath);
    try {
      const bodiesAfterRestart = await fetchAllProjections(secondDaemon);
      expect(bodiesAfterRestart).toEqual(bodiesBeforeRestart);
    } finally {
      await secondDaemon.stop();
    }
  });

  it('GET /api/projections/:id returns 404 for an unknown projection id', async () => {
    const daemon = await startDaemon(nextDatabasePath());
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/projections/does-not-exist`, {
        headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
      });
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('{');
    } finally {
      await daemon.stop();
    }
  });

  it('GET /api/health reports ok, schemaVersion, and a numeric uptime', async () => {
    const daemon = await startDaemon(nextDatabasePath());
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/health`, {
        headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
      });
      expect(response.status).toBe(200);
      const health = (await response.json()) as { ok: boolean; schemaVersion: number; uptime: number };
      expect(health.ok).toBe(true);
      expect(health.schemaVersion).toBe(1);
      expect(typeof health.uptime).toBe('number');
    } finally {
      await daemon.stop();
    }
  });

  // S14 U1 (D84): apiVersion + capabilities sit BESIDE schemaVersion — a
  // different fact (event-schema vs served-API version) that must not be
  // conflated with it.
  it('GET /api/health also carries apiVersion and capabilities, distinct from schemaVersion', async () => {
    const daemon = await startDaemon(nextDatabasePath());
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/health`, {
        headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
      });
      expect(response.status).toBe(200);
      const health = (await response.json()) as {
        ok: boolean;
        schemaVersion: number;
        apiVersion: number;
        capabilities: string[];
        uptime: number;
      };
      expect(health.apiVersion).toBe(DAEMON_API_VERSION);
      expect(health.capabilities).toEqual(DAEMON_CAPABILITIES);
      expect(health.schemaVersion).toBe(1);
    } finally {
      await daemon.stop();
    }
  });
});

// ─── S12-A5 (D72 Move 3): a misbuilt daemon refuses to start ─────────────────
//
// The declaration is resolved inside `createDaemon`, BEFORE the store opens and
// long before `start()` binds a port — so a daemon that cannot read its own
// in-build manifest never becomes reachable. That ordering is the assertion:
// nothing is listening, nothing was written, and `main.ts`'s existing top-level
// catch turns the throw into a printed message and a non-zero exit.
describe('daemon boot — S12-A5: an unreadable shipped manifest refuses the boot', () => {
  it('createDaemon THROWS before anything binds, with the path in the message', () => {
    const missingPath = join(temporaryDirectory, 'no-such-manifest', 'vimes-extension.toml');
    expect(() =>
      createDaemon({
        config: buildConfig(nextDatabasePath()),
        clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
        ids: uniqueIdSource,
        verifier: permissiveVerifier,
        shippedManifestPath: missingPath,
      }),
    ).toThrow(missingPath);
  });

  it('createDaemon THROWS with the PARSE ISSUES when the manifest is unparsable', () => {
    const brokenPath = join(temporaryDirectory, 'broken-manifest.toml');
    writeFileSync(brokenPath, 'id = "vimes-tasks"\nnot toml [[[\n', 'utf8');
    expect(() =>
      createDaemon({
        config: buildConfig(nextDatabasePath()),
        clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
        ids: uniqueIdSource,
        verifier: permissiveVerifier,
        shippedManifestPath: brokenPath,
      }),
      // The structured issue CODE, verbatim — "the parse errors in the boot
      // output" is the assertion, not "it failed somehow".
    ).toThrow('toml-parse-error');
  });
});
