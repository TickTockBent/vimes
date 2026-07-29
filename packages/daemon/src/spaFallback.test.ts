import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SteppingClock, type IdSource } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, shouldServeAppShell, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';

// ─── S8·2 — the SPA fallback that makes a project URL a real URL (D61) ───────
//
// D61 put the PROJECT IN THE PATH: `vimes.wshoffner.dev/infrastructure/johnny/`
// must load the app, in a fresh tab, from a bookmark, with no hash. The daemon is
// the only thing that can answer that request, so the fallback is the unit's one
// daemon-shaped cost — and these cases are what keep it from turning into "serve
// index.html for anything that misses", which would swallow every genuine 404.
//
// THE PURE PREDICATE IS TESTED SEPARATELY FROM THE LISTENER, deliberately: the
// rule is a decision about a path, and a decision that can only be observed
// through a socket is a decision nobody re-reads.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-spa-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const ANY_TOKEN = 'valid-token-stub';
const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
// Rejects a missing/empty token, accepts anything else — the auth.test.ts shape,
// so the I14 case below probes a REAL wall without minting JWTs.
const tokenRequiredVerifier: AccessVerifier = {
  verify: async (token) =>
    token === undefined || token === '' ? { ok: false, reason: 'missing-token' } : { ok: true },
};
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };
const INDEX_HTML = '<!doctype html><title>vimes</title><div id="app"></div>';

let databaseFileCounter = 0;

function buildConfig(staticDir: string): DaemonConfig {
  databaseFileCounter += 1;
  const dbPath = join(temporaryDirectory, `spa-${databaseFileCounter}.db`);
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
    staticDir,
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
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
  };
}

// A static dir shaped like a real `packages/ui/dist`: the shell, one hashed
// asset, one icon.
function buildStaticDirectory(): string {
  const staticDir = mkdtempSync(join(temporaryDirectory, 'static-'));
  mkdirSync(join(staticDir, 'assets'));
  mkdirSync(join(staticDir, 'icons'));
  writeFileSync(join(staticDir, 'index.html'), INDEX_HTML, 'utf8');
  writeFileSync(join(staticDir, 'assets', 'index-a1b2c3d4.js'), 'export const answer = 42;', 'utf8');
  writeFileSync(join(staticDir, 'icons', 'icon-192.v2.png'), 'not-really-a-png', 'utf8');
  return staticDir;
}

async function startDaemon(verifier: AccessVerifier = permissiveVerifier): Promise<Daemon> {
  const daemon = createDaemon({
    config: buildConfig(buildStaticDirectory()),
    clock: new SteppingClock('2026-07-29T12:00:00.000Z', 1000),
    ids: uniqueIdSource,
    verifier,
  });
  await daemon.start();
  return daemon;
}

interface Probe {
  status: number;
  body: string;
  contentType: string | null;
}

async function probe(daemon: Daemon, path: string, method = 'GET'): Promise<Probe> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
  });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
  };
}

describe('shouldServeAppShell — the D61 fallback rule (pure)', () => {
  it('serves the shell for a PROJECT PATH, at any depth, with or without a trailing slash', () => {
    expect(shouldServeAppShell('/')).toBe(true);
    expect(shouldServeAppShell('/infrastructure/johnny/')).toBe(true);
    expect(shouldServeAppShell('/infrastructure/johnny')).toBe(true);
    expect(shouldServeAppShell('/a/b/c/d/e/')).toBe(true);
  });

  it('serves the shell for a project directory whose NAME CONTAINS A DOT', () => {
    // `extname('/infra/my.tool/')` is '.tool', so an extension test alone would
    // make that project the one project unreachable by its own URL. The rule is
    // "does it look like an asset we serve", not "does it have a dot".
    expect(shouldServeAppShell('/infra/my.tool/')).toBe(true);
    expect(shouldServeAppShell('/infra/my.tool')).toBe(true);
  });

  it('NEVER serves the shell under /api', () => {
    // An unknown API path answered with 200 + HTML turns a caller's typo into a
    // JSON parse error three layers away.
    expect(shouldServeAppShell('/api')).toBe(false);
    expect(shouldServeAppShell('/api/nope')).toBe(false);
    expect(shouldServeAppShell('/api/projects/does-not-exist')).toBe(false);
    // Not a prefix match on the STRING: a project literally called `apiary` is a
    // project, not the API.
    expect(shouldServeAppShell('/apiary/')).toBe(true);
  });

  it('NEVER serves the shell for a MISSING ASSET — a broken build must fail loudly', () => {
    expect(shouldServeAppShell('/assets/index-deadbeef.js')).toBe(false);
    expect(shouldServeAppShell('/assets/index-deadbeef.css')).toBe(false);
    expect(shouldServeAppShell('/icons/icon-192.v2.png')).toBe(false);
    expect(shouldServeAppShell('/manifest.webmanifest')).toBe(false);
  });
});

describe('the SPA fallback over HTTP (D61)', () => {
  it('serves index.html for a project path and leaves real assets, /api and non-GET alone', async () => {
    const daemon = await startDaemon();
    try {
      // 1. The D61 URL itself — the whole point of the unit.
      const projectPath = await probe(daemon, '/infrastructure/johnny/');
      expect(projectPath.status).toBe(200);
      expect(projectPath.body).toBe(INDEX_HTML);
      expect(projectPath.contentType).toBe('text/html; charset=utf-8');

      // The no-slash form and a dotted project name land on the same shell.
      expect((await probe(daemon, '/infrastructure/johnny')).body).toBe(INDEX_HTML);
      expect((await probe(daemon, '/infrastructure/my.tool/')).body).toBe(INDEX_HTML);

      // 2. Real static files are UNAFFECTED — the fallback only runs on a miss.
      const asset = await probe(daemon, '/assets/index-a1b2c3d4.js');
      expect(asset.status).toBe(200);
      expect(asset.body).toBe('export const answer = 42;');
      expect((await probe(daemon, '/icons/icon-192.v2.png')).status).toBe(200);

      // 3. A MISSING asset still 404s — never HTML wearing a .js URL.
      const missingAsset = await probe(daemon, '/assets/index-deadbeef.js');
      expect(missingAsset.status).toBe(404);
      expect(missingAsset.body).not.toContain('<div id="app">');

      // 4. A known API route is untouched, and an UNKNOWN one 404s rather than
      //    answering a fetch() with the app shell.
      expect((await probe(daemon, '/api/health')).status).toBe(200);
      const unknownApi = await probe(daemon, '/api/nope');
      expect(unknownApi.status).toBe(404);
      expect(unknownApi.body).not.toContain('<div id="app">');

      // 5. NON-GET is untouched: a POST to an unknown path stays a 404, because
      //    the fallback lives on the GET catch-all and nowhere else.
      const postedUnknown = await probe(daemon, '/infrastructure/johnny/', 'POST');
      expect(postedUnknown.status).toBe(404);
      expect(postedUnknown.body).not.toContain('<div id="app">');
    } finally {
      await daemon.stop();
    }
  });

  it('is behind the SAME auth wall as the static serving (I14)', async () => {
    const daemon = await startDaemon(tokenRequiredVerifier);
    try {
      // No token at all: the fallback must not become the one door that leaks the
      // app shell to an unauthenticated caller.
      const response = await fetch(`http://127.0.0.1:${daemon.port}/infrastructure/johnny/`);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('<div id="app">');
      // And WITH a token it is the shell — so the 401 above is the wall, not a
      // fallback that simply does not work.
      expect((await probe(daemon, '/infrastructure/johnny/')).body).toBe(INDEX_HTML);
    } finally {
      await daemon.stop();
    }
  });
});
