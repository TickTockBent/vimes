import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import {
  EventRouter,
  bootFromSnapshot,
  readAllStreamsGrouped,
  runtimeDriftObserved,
  snapshotAfter,
  cacheObservabilityProjection,
  evaluateMeterAlerts,
  meterAlert,
  meterSample,
  metersProjection,
  sessionsProjection,
  tasksProjection,
  SYSTEM_STREAM,
  type Clock,
  type IdSource,
  type MetersState,
  type Projection,
} from '@vimes/core';
import { SqliteEventStore } from './sqliteEventStore.js';
import { SqliteSnapshotStore } from './sqliteSnapshotStore.js';
import {
  AUTH_REJECTED_EVENT_TYPE,
  createAccessAuthMiddleware,
  createCloudflareAccessVerifier,
  createUnconfiguredVerifier,
  readAccessTokenFromRequest,
  writeUpgradeAuthFailure,
  type AccessVerifier,
  type EmitAuthRejected,
} from './auth.js';
import { WsHub, type WsHubDeps } from './wsHub.js';
import { registerFileApi } from './fileApi.js';
import { registerGitApi } from './gitApi.js';
import type { GitRunner } from './gitAdapter.js';
import {
  SearchService,
  createRipgrepPreflight,
  type RipgrepSpawner,
  type RipgrepPreflight,
} from './search.js';
import {
  SessionHost,
  type PtySpawnFactory,
  type SdkQueryFactory,
} from './sessionHost.js';
import { TerminalHost, type TerminalPtyFactory } from './terminalHost.js';
import { JsonlTailer } from './tailer.js';
import { createHookIngress, type HookIngress } from './hookIngress.js';
import type { CliVersionProbe, PreflightProbe } from './runtimeChecks.js';
import type { DaemonConfig } from './config.js';
import { PushSubscriptions } from './pushSubscriptions.js';
import { PushPipeline } from './pushPipeline.js';
import { createWebPushSender, loadOrCreateVapidKeys, type PushSender } from './pushService.js';
import {
  createCredentialsReader,
  createUsageEndpointAdapter,
  defaultUsageHttpFetch,
  type CredentialsReader,
  type UsageFailureReason,
  type UsageHttpFetch,
  type UsageProbeResult,
} from './usageEndpoint.js';
import {
  buildDerivedUsage,
  deriveStaleAfterMs,
  type DerivedUsageBody,
} from './usageDerived.js';
import {
  UsageObservationLog,
  defaultUsageObservationLogPath,
} from './usageObservationLog.js';
import { MeterAlertLedger, sendMeterAlertPush } from './meterAlerts.js';

// How often the inactivity reaper wakes to check for idle terminals. This is the
// detection CADENCE, not the tuned window: config.terminalIdleReapMs is the
// behavior-shaping knob (how long idle before reaping). A fixed 60s cadence
// bounds reap latency to at most a minute past the window — cheap and not a
// calibrated band. Disabled entirely when the window is 0.
const TERMINAL_REAP_CHECK_INTERVAL_MS = 60_000;

const DAEMON_PROJECTIONS: ReadonlyArray<Projection<unknown>> = [
  sessionsProjection as Projection<unknown>,
  metersProjection as Projection<unknown>,
  tasksProjection as Projection<unknown>,
  cacheObservabilityProjection as Projection<unknown>,
];
const PROJECTION_BY_ID = new Map<string, Projection<unknown>>(
  DAEMON_PROJECTIONS.map((projection) => [projection.id, projection]),
);

export interface DaemonDeps {
  config: DaemonConfig;
  clock: Clock;
  ids: IdSource;
  // Injected in CI (the locally-minted-JWKS verifier). Absent in prod, where the
  // verifier is derived from config — real if configured, fail-closed if not.
  verifier?: AccessVerifier;
  // Test seam (finding E): override how a socket's buffered byte count is read so
  // the backpressure drop can be exercised without pushing real megabytes.
  wsBufferedAmountOf?: WsHubDeps['bufferedAmountOf'];
  // Session-host process factories — injected in CI (real Claude never runs in
  // the harness); default to the real SDK query / node-pty spawn in production.
  sdkQueryFactory?: SdkQueryFactory;
  ptySpawnFactory?: PtySpawnFactory;
  // Raw-terminal shell PTY factory (slice 3 step 3). Absent → the real node-pty
  // spawn of $SHELL; CI injects a fake — a real shell NEVER runs in the harness.
  terminalPtyFactory?: TerminalPtyFactory;
  // Override the transcript projects root + chokidar options (tests).
  projectsRoot?: string;
  tailerWatchOptions?: ConstructorParameters<typeof JsonlTailer>[0]['watchOptions'];
  // Spawn preflight (E3). Absent → the SessionHost's permissive default (CI never
  // authenticates); main.ts injects the real credential probe.
  preflightProbe?: PreflightProbe;
  // Runtime version probe (E4). Absent → the boot version check is SKIPPED (so
  // integration tests never invoke the real CLI); main.ts injects the real
  // `claude --version` probe. Present → drift is observed at boot, warn-only.
  cliVersionProbe?: CliVersionProbe;
  // Push sender (step 3). Absent → the real web-push sender (VAPID keys from the
  // data dir). CI injects a fake recorder — a real push service NEVER runs in the
  // harness. VAPID keys are still generated/loaded either way (local crypto), so
  // the public-key endpoint works in tests.
  pushSender?: PushSender;
  // Ripgrep seams (slice 3 step 1). Absent → the real `rg` spawner + a
  // spawn-`rg --version` preflight. CI injects a fake spawner and a preflight it
  // controls — a real `rg` binary is not guaranteed present (observed: the box's
  // `rg` is a Claude Code shell shim, not a spawnable binary).
  ripgrepSpawner?: RipgrepSpawner;
  ripgrepPreflight?: RipgrepPreflight;
  // Git runner seam (slice 4 step 1). Absent → the real execFile('git', …)
  // runner (ARRAY args, never a shell — the injection-safety boundary). CI injects
  // a fake returning canned output; the hermetic integration test uses the real
  // runner over a scratch repo.
  gitRunner?: GitRunner;
  // Usage-endpoint seams (slice 5 step 2). Absent → the real HTTPS fetch and the
  // real `~/.claude/.credentials.json` reader. CI injects fakes for BOTH: no
  // test may touch the network or the real credentials file. The token they
  // carry is never logged or evented anywhere.
  usageHttpFetch?: UsageHttpFetch;
  usageCredentialsReader?: CredentialsReader;
  // Where the usage OBSERVATION LOG is written (slice 5 step 4b). Absent → beside
  // the event DB in the data dir. INJECTED by every test so none of them ever
  // writes into the real data dir.
  usageObservationLogPath?: string;
}

export interface Daemon {
  readonly httpServer: Server;
  readonly store: SqliteEventStore;
  readonly router: EventRouter;
  readonly snapshotStore: SqliteSnapshotStore;
  readonly wsHub: WsHub;
  readonly sessionHost: SessionHost;
  readonly terminalHost: TerminalHost;
  readonly hookIngress: HookIngress;
  readonly pushPipeline: PushPipeline;
  readonly pushSubscriptions: PushSubscriptions;
  readonly authConfigured: boolean;
  readonly port: number;
  readonly hookPort: number;
  serializeProjection(projectionId: string): string | null;
  // One usage-endpoint poll, awaited. The poller's timer calls exactly this;
  // tests call it directly so a poll is deterministic rather than clock-raced.
  pollUsageOnce(): Promise<void>;
  // The derived usage read model as GET /api/usage/derived would serve it, with
  // `nowIso` stamped from the injected clock. Exposed so tests can assert the
  // shape without a round trip.
  derivedUsage(): DerivedUsageBody;
  // The append-only diagnostic observation log (rule 0.6 drift detection).
  usageObservationLog: UsageObservationLog;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function resolveVerifier(config: DaemonConfig, injected: AccessVerifier | undefined): {
  verifier: AccessVerifier;
  configured: boolean;
} {
  if (injected !== undefined) {
    return { verifier: injected, configured: true };
  }
  if (config.accessTeamDomain !== undefined && config.accessAud !== undefined) {
    return {
      verifier: createCloudflareAccessVerifier({
        teamDomain: config.accessTeamDomain,
        aud: config.accessAud,
      }),
      configured: true,
    };
  }
  return { verifier: createUnconfiguredVerifier(), configured: false };
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

// ─── Cache-Control on static files (calibration finding, 2026-07-21) ─────────
//
// The handler used to set ONLY content-type. With no cache directives,
// Cloudflare edge-caches by extension under the Standard cache level and can
// serve a STALE APP SHELL after a deploy — a deploy that "didn't land" with no
// obvious cause. Three classes, deliberately small and obvious:
//   * the unhashed shell (index.html / sw.js / manifest.webmanifest) → must
//     revalidate on every request;
//   * Vite's content-hashed build output (/assets/*) → the URL changes whenever
//     the bytes do, so it is safe to cache forever;
//   * everything else → a short conservative default.
const SHELL_NO_CACHE = 'no-cache';
const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';
const DEFAULT_STATIC_CACHE = 'public, max-age=300';
const ALWAYS_REVALIDATE_FILES: ReadonlySet<string> = new Set([
  '/index.html',
  '/sw.js',
  '/manifest.webmanifest',
]);

export function cacheControlForStaticPath(servedPath: string): string {
  const normalizedPath = servedPath.startsWith('/') ? servedPath : `/${servedPath}`;
  if (ALWAYS_REVALIDATE_FILES.has(normalizedPath)) {
    return SHELL_NO_CACHE;
  }
  if (normalizedPath.startsWith('/assets/')) {
    return HASHED_ASSET_CACHE;
  }
  return DEFAULT_STATIC_CACHE;
}

// Read a file within staticRoot, denying path traversal at the boundary. Returns
// null when the resolved path escapes the root or is not a readable file.
async function readStaticFile(staticRoot: string, requestPath: string): Promise<StaticFile | null> {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedRelative = normalize(decodedPath).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  const rootAbsolute = resolve(staticRoot);
  const candidate = resolve(rootAbsolute, normalizedRelative);
  if (candidate !== rootAbsolute && !candidate.startsWith(rootAbsolute + sep)) {
    return null;
  }
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return null;
    }
    const contentType = STATIC_CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream';
    return { body: Uint8Array.from(await readFile(candidate)), contentType };
  } catch {
    return null;
  }
}

export function createDaemon(deps: DaemonDeps): Daemon {
  const { config, clock, ids } = deps;
  const store = new SqliteEventStore({ path: config.dbPath, clock, ids });
  const snapshotStore = new SqliteSnapshotStore({ path: config.dbPath });
  const router = new EventRouter(store);
  const { verifier, configured: authConfigured } = resolveVerifier(config, deps.verifier);

  const emitAuthRejected: EmitAuthRejected = (info) => {
    // Never the token or headers — only path + classified reason (email omitted).
    router.emit([
      { stream: SYSTEM_STREAM, type: AUTH_REJECTED_EVENT_TYPE, payload: { path: info.path, reason: info.reason } },
    ]);
  };

  const serializeProjection = (projectionId: string): string | null => {
    const projection = PROJECTION_BY_ID.get(projectionId);
    if (projection === undefined) {
      return null;
    }
    // Derive from the store (source of truth, I13): snapshot + live tail. Always
    // current, no dependence on a dynamic per-stream live subscription.
    return projection.serialize(bootFromSnapshot(projection, snapshotStore, store));
  };

  const app = new Hono();
  // I14: auth in front of EVERYTHING, including static and unknown routes.
  app.use('*', createAccessAuthMiddleware({ verifier, emitAuthRejected }));

  let startedAtMs: number | null = null;
  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      schemaVersion: store.schemaVersion(),
      uptime: startedAtMs === null ? 0 : Date.now() - startedAtMs,
    }),
  );

  app.get('/api/projections/:id', (context) => {
    const serialized = serializeProjection(context.req.param('id'));
    if (serialized === null) {
      return context.text('not found', 404);
    }
    return context.body(serialized, 200, { 'content-type': 'application/json; charset=utf-8' });
  });

  // The VAPID public key the PWA needs to subscribe. Behind the same auth wall as
  // everything on the product port; it is public-by-design (only the private key,
  // held mode-600 in the data dir, is a secret).
  app.get('/api/push/vapid-public-key', (context) => context.json({ publicKey: vapidKeys.publicKey }));

  // File API (slice 3 step 1) — behind the same auth wall, before the static
  // catch-all. The allowlist is read fresh per request: config.projectRoots plus
  // the cwds of currently-live sessions (spec §3.4). `sessionHost` is created
  // below; the closure only runs per request, long after construction.
  registerFileApi(app, {
    getAllowedRoots: () => [...config.projectRoots, ...sessionHost.liveSessionCwds()],
    maxEditBytes: config.maxEditBytes,
  });

  // Git API (slice 4 step 1) — the review-panel service (spec §3.4). Behind the
  // same auth wall, before the static catch-all, and scoped to the SAME allowlist
  // union the file API/search/terminal use (config.projectRoots ∪ live-session
  // cwds), read fresh per request. Every requested root, the discovered repo
  // toplevel, and every path pass through resolveWithinRoots — a git op reachable
  // outside the allowlist would be a halting finding, so the toplevel is checked
  // too. `sessionHost` is created below; the closure only runs per request.
  registerGitApi(app, {
    getAllowedRoots: () => [...config.projectRoots, ...sessionHost.liveSessionCwds()],
    runner: deps.gitRunner,
  });

  // GET /api/terminals — the live terminal list (terminal-lifecycle backlog
  // item). Behind the same auth wall as everything else on the product port and
  // registered BEFORE the static catch-all. The byte-free listing lets a fresh
  // page load (terminalId is in-memory only) rediscover the shells still running
  // so they can be re-entered. `terminalHost` is created below; the closure only
  // runs per request, long after construction.
  app.get('/api/terminals', (context) => context.json({ terminals: terminalHost.listTerminals() }));

  // ─── the derived usage read model (slice 5 step 4b) ────────────────────────
  //
  // Registered here, before the static catch-all and behind the same auth wall.
  // It is deliberately NOT `/api/projections/meters`: every field it adds is a
  // function of *now*, and projection state must stay snapshot/replay
  // byte-identical (rule 0.3). The daemon stamps the clock at this boundary.
  //
  // No meters at all → the envelope with an EMPTY array. Never a 404 (which
  // would read as "this feature is missing" rather than "nothing observed yet"),
  // and never a synthetic zero meter.
  app.get('/api/usage/derived', (context) => context.json(currentDerivedUsage()));

  // ─── forced refresh (slice 5 step 4b) ─────────────────────────────────────
  //
  // Forces an ACTUAL poll. Re-serving the last sample would re-render the same
  // stale number more confidently, which is the exact failure this route exists
  // to fix. Returns the same derived body (freshly derived) so the UI needs ONE
  // round trip, not two, plus a `refresh` envelope describing what happened.
  //
  // CONVENTION CHOSEN: always HTTP 200 with an envelope field, never 429. A
  // throttled refresh is not an error — the client still receives a complete,
  // honest read model, and a 429 would push callers toward retry/backoff
  // machinery for what is really "here is the data, the endpoint was just
  // polled a moment ago".
  app.post('/api/usage/refresh', async (context) => context.json(await forceUsageRefresh()));

  if (config.staticDir !== undefined) {
    const staticDir = config.staticDir;
    app.get('*', async (context) => {
      const direct = await readStaticFile(staticDir, context.req.path);
      if (direct !== null) {
        return context.body(direct.body, 200, {
          'content-type': direct.contentType,
          'cache-control': cacheControlForStaticPath(context.req.path),
        });
      }
      // SPA fallback: extension-less paths fall back to index.html — which is
      // the app shell, so it carries the shell's no-cache directive.
      if (extname(context.req.path) === '') {
        const indexFile = await readStaticFile(staticDir, '/index.html');
        if (indexFile !== null) {
          return context.body(indexFile.body, 200, {
            'content-type': indexFile.contentType,
            'cache-control': cacheControlForStaticPath('/index.html'),
          });
        }
      }
      return context.text('not found', 404);
    });
  }

  app.notFound((context) => context.text('not found', 404));

  // Push (step 3). VAPID keys are generated once and reused from the data dir
  // (local crypto — safe in CI); the sender defaults to real web-push, CI injects
  // a fake. The pipeline turns notification_trigger events into deliveries.
  const vapidKeys = loadOrCreateVapidKeys(config.dataDir);
  const pushSubscriptions = new PushSubscriptions({ path: config.dbPath, clock });
  const pushSender: PushSender =
    deps.pushSender ?? createWebPushSender({ vapid: vapidKeys, subject: config.pushSubject });
  const pushPipeline = new PushPipeline({ router, store, sender: pushSender, subscriptions: pushSubscriptions });

  // Session host + JSONL tailer own every Claude process (rule 0.3). Factories
  // default to the real SDK/node-pty; CI injects fakes.
  const sessionHost = new SessionHost({
    store,
    router,
    clock,
    ids,
    config,
    sdkQueryFactory: deps.sdkQueryFactory,
    ptySpawnFactory: deps.ptySpawnFactory,
    projectsRoot: deps.projectsRoot,
    preflightProbe: deps.preflightProbe,
    // Register each new session's stream with the push pipeline (per-stream fanout).
    onSessionCreated: (appSessionId) => pushPipeline.watch(appSessionId),
  });
  const tailer = new JsonlTailer({
    router,
    projectsRoot: deps.projectsRoot,
    watchOptions: deps.tailerWatchOptions,
    // D10 attention guard: an external-custody stream never carries attention
    // setters — the tailer strips them at the emitter using the host's custody set.
    isExternalCustody: (appSessionId) => sessionHost.isExternalCustody(appSessionId),
  });
  sessionHost.attachTailer(tailer);

  // Hook ingress: a SEPARATE listener on config.hookPort (127.0.0.1 only). The
  // tunnel routes ONLY to config.port, so this is structurally unreachable from
  // outside — the designed I14 exemption (deliverable A). Its auth is the
  // per-spawn secret custody the session host owns.
  const hookIngress = createHookIngress({
    host: sessionHost,
    router,
    hookPort: config.hookPort,
    bindHost: config.bindHost,
  });

  // Search + preview-gated replace (slice 3 step 1). The allowlist is the same
  // union the File API uses (config roots ∪ live-session cwds), read per request.
  // ripgrep preflight is resolved once here (cached inside the probe).
  const ripgrepPreflight = deps.ripgrepPreflight ?? createRipgrepPreflight();
  const searchService = new SearchService({
    getAllowedRoots: () => [...config.projectRoots, ...sessionHost.liveSessionCwds()],
    spawner: deps.ripgrepSpawner,
    preflight: ripgrepPreflight,
    ids,
  });

  // Raw terminal host (slice 3 step 3, spec §3.4/§3.11). Its cwd allowlist is the
  // SAME union the File API/Search use (config roots ∪ live-session cwds), read per
  // open. The shell PTY factory defaults to the real node-pty; CI injects a fake.
  const terminalHost = new TerminalHost({
    ids,
    clock,
    getAllowedRoots: () => [...config.projectRoots, ...sessionHost.liveSessionCwds()],
    ptyFactory: deps.terminalPtyFactory,
  });

  const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
  const wsHub = new WsHub({
    router,
    store,
    bufferedLimitBytes: config.wsBufferedLimitBytes,
    bufferedAmountOf: deps.wsBufferedAmountOf,
    sessionHost,
    projectRoots: config.projectRoots,
    pushSubscriptions,
    searchService,
    terminalHost,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    void (async () => {
      // I14: auth verification stays FIRST — zero bytes without a valid JWT,
      // regardless of the requested path.
      const token = readAccessTokenFromRequest(request);
      const result = await verifier.verify(token);
      if (!result.ok) {
        emitAuthRejected({ path: request.url ?? '', reason: result.reason });
        writeUpgradeAuthFailure(socket, result.reason);
        return;
      }
      // Only the exact `/ws` pathname (query string ignored) proceeds to the
      // WS hub; anything else gets a minimal raw 404 and the socket is torn
      // down. This runs AFTER auth so unauthed probes never learn the shape
      // of the routing (they always see 401/503, never 404).
      const pathname = new URL(request.url ?? '', 'http://localhost').pathname;
      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wsHub.handleUpgrade(request, socket, head);
    })();
  });

  const saveAllSnapshots = (): void => {
    const records = readAllStreamsGrouped(store);
    for (const projection of DAEMON_PROJECTIONS) {
      snapshotStore.save(snapshotAfter(projection, records, clock));
    }
  };

  // The usage OBSERVATION LOG (slice 5 step 4b, rule 0.6) — append-only JSONL
  // beside the event DB, NEVER inside the event spine. One line per poll
  // attempt, success or classified failure, so a 401 at token roll and a shape
  // drift both leave evidence instead of vanishing. The path is injectable so no
  // test writes to the real data dir; the OAuth token never reaches it.
  const usageObservationLog = new UsageObservationLog({
    path: deps.usageObservationLogPath ?? defaultUsageObservationLogPath(config.dataDir),
  });

  // The usage-endpoint adapter (slice 5 step 2) — the SOLE headroom authority.
  // Both seams default to the real ones; CI injects fakes for both.
  const usageEndpointAdapter = createUsageEndpointAdapter({
    httpFetch: deps.usageHttpFetch ?? defaultUsageHttpFetch,
    readCredentials: deps.usageCredentialsReader ?? createCredentialsReader(),
    baseUrl: config.usageBaseUrl,
    // Diagnostics only; the observation carries a RESPONSE body and status, and
    // never a request header (where the bearer lives).
    observe: (observation) => {
      usageObservationLog.record(clock.now(), {
        outcome: observation.outcome,
        httpStatus: observation.httpStatus,
        body: observation.body,
        limitsParsed: observation.limitsParsed,
      });
    },
  });

  // The alert memory, folded from the log (slice 5 step 4b, deliverable 4).
  const meterAlertLedger = new MeterAlertLedger(store);

  const currentMetersState = (): MetersState =>
    bootFromSnapshot(metersProjection, snapshotStore, store);

  const currentDerivedUsage = (): DerivedUsageBody =>
    buildDerivedUsage({
      metersState: currentMetersState(),
      // The clock is stamped HERE, at the boundary, and nowhere deeper (rule 0.3).
      nowIso: clock.now(),
      pollIntervalMs: config.usagePollIntervalMs,
    });

  // Evaluate 4a's PURE evaluator against the freshly-sampled meters, persist any
  // crossings as `meter_alert` events, and push one notification per alert.
  //
  // Two explicit disable paths, both silent by design:
  //   * NO THRESHOLDS configured → alerting is off entirely (no evaluation, no
  //     events, no push).
  //   * NO STALENESS BAND (the poller is disabled, so `deriveStaleAfterMs` is
  //     null) → nothing can be judged `fresh`, and 4a refuses to alert on a
  //     number it cannot vouch for. Waking a phone over an observation of
  //     unknown age is precisely the lying meter pillar 4 forbids.
  const dispatchMeterAlerts = (): void => {
    const alertThresholds = config.usageAlertPercents;
    if (alertThresholds.length === 0) {
      return;
    }
    const staleAfterMs = deriveStaleAfterMs(config.usagePollIntervalMs);
    if (staleAfterMs === null) {
      return;
    }
    const nowIso = clock.now();
    // `.current()` is read BEFORE the new alerts are emitted, so this evaluation
    // sees exactly the history that existed at the crossing.
    const firedAlerts = evaluateMeterAlerts(
      currentMetersState(),
      meterAlertLedger.current(),
      alertThresholds,
      nowIso,
      staleAfterMs,
    );
    if (firedAlerts.length === 0) {
      return;
    }
    router.emit(firedAlerts.map((alertPayload) => meterAlert(alertPayload)));
    for (const alertPayload of firedAlerts) {
      // Fire-and-forget: a push failure is LOGGED inside, never thrown, and can
      // never be fatal to the poll that produced it.
      void sendMeterAlertPush(alertPayload, nowIso, {
        sender: pushSender,
        subscriptions: pushSubscriptions,
        // D29: the delivery outcome rides the 'usage' stream (meter has no
        // session), never the session-scoped push_sent/push_failed.
        emit: (events) => router.emit(events),
      }).catch(() => {
        // sendMeterAlertPush does not reject; this is belt-and-braces so an
        // unexpected throw can never become an unhandled rejection.
      });
    }
  };

  // One poll. On success, one meter_sample per returned record through the
  // normal event path (I13 persist-before-broadcast is the store's job), then
  // threshold evaluation. On ANY failure: emit NOTHING — no placeholder, no
  // zero, no reuse of a previous body. The meters then age out via observedAt
  // and the pure derivations report stale/unknown themselves (pillar 4: a meter
  // that lies is worse than no meter). The attempt is recorded in the
  // observation log either way, by the adapter's observe seam.
  const runUsagePoll = async (): Promise<UsageProbeResult> => {
    const probeResult = await usageEndpointAdapter.probe(clock.now());
    if (!probeResult.ok) {
      return probeResult;
    }
    router.emit(probeResult.meters.map((meterRecord) => meterSample(meterRecord)));
    dispatchMeterAlerts();
    return probeResult;
  };

  const pollUsageOnce = async (): Promise<void> => {
    await runUsagePoll();
  };

  // ─── forced refresh, debounced ────────────────────────────────────────────
  interface UsageRefreshOutcome {
    // Did this request actually hit the endpoint?
    polled: boolean;
    // Was it refused by the debounce?
    throttled: boolean;
    // The adapter's classified failure when the poll ran and failed. Null when
    // the poll succeeded OR when no poll ran — `polled` disambiguates, and a
    // throttled response NEVER claims a refresh succeeded.
    failureReason: UsageFailureReason | null;
    httpStatus: number | null;
    // When the next forced poll becomes available. Non-null only when throttled.
    nextForcedPollAt: string | null;
    retryAfterMs: number | null;
  }
  type UsageRefreshBody = DerivedUsageBody & { refresh: UsageRefreshOutcome };

  // Epoch-ms of the last forced poll ATTEMPT (successful or not — a failed
  // attempt still hit the endpoint, and the debounce is about endpoint
  // citizenship, not about outcomes).
  let lastForcedPollAtMs: number | null = null;

  const forceUsageRefresh = async (): Promise<UsageRefreshBody> => {
    const requestedAtMs = Date.parse(clock.now());
    const debounceMs = config.usageForcedRefreshMinIntervalMs;
    const earliestNextPollMs =
      lastForcedPollAtMs === null ? null : lastForcedPollAtMs + debounceMs;
    if (
      debounceMs > 0 &&
      earliestNextPollMs !== null &&
      Number.isFinite(requestedAtMs) &&
      requestedAtMs < earliestNextPollMs
    ) {
      // Inside the window: do NOT poll. The body is still complete and honest —
      // the meters carry their real ages — it simply does not claim a refresh.
      return {
        ...currentDerivedUsage(),
        refresh: {
          polled: false,
          throttled: true,
          failureReason: null,
          httpStatus: null,
          nextForcedPollAt: new Date(earliestNextPollMs).toISOString(),
          retryAfterMs: earliestNextPollMs - requestedAtMs,
        },
      };
    }
    lastForcedPollAtMs = Number.isFinite(requestedAtMs) ? requestedAtMs : lastForcedPollAtMs;
    const probeResult = await runUsagePoll();
    // On failure the derived body is rebuilt from the UNCHANGED meters: their
    // real observedAt, their real ages, no fresher stamp anywhere. The failure
    // is reported instead of hidden.
    return {
      ...currentDerivedUsage(),
      refresh: {
        polled: true,
        throttled: false,
        failureReason: probeResult.ok ? null : probeResult.reason,
        httpStatus: probeResult.ok ? null : probeResult.status,
        nextForcedPollAt: null,
        retryAfterMs: null,
      },
    };
  };

  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let terminalReapTimer: ReturnType<typeof setInterval> | null = null;
  let usagePollTimer: ReturnType<typeof setInterval> | null = null;

  return {
    httpServer,
    store,
    router,
    snapshotStore,
    wsHub,
    sessionHost,
    terminalHost,
    hookIngress,
    pushPipeline,
    pushSubscriptions,
    authConfigured,
    get port(): number {
      const address = httpServer.address();
      return address !== null && typeof address === 'object' ? (address as AddressInfo).port : config.port;
    },
    get hookPort(): number {
      return hookIngress.port;
    },
    serializeProjection,
    pollUsageOnce,
    derivedUsage: currentDerivedUsage,
    usageObservationLog,

    async start(): Promise<void> {
      await new Promise<void>((resolveStart, rejectStart) => {
        const onListenError = (error: Error): void => rejectStart(error);
        httpServer.once('error', onListenError);
        httpServer.listen(config.port, config.bindHost, () => {
          httpServer.removeListener('error', onListenError);
          startedAtMs = Date.now();
          resolveStart();
        });
      });
      await hookIngress.start();
      // Runtime version check (E4), warn-only, never gates. Only when a probe is
      // injected (main.ts in prod) — integration tests never invoke the CLI.
      if (deps.cliVersionProbe !== undefined) {
        const observed = await deps.cliVersionProbe();
        const expected = config.expectedCliVersion ?? null;
        if (expected === null || observed !== expected) {
          router.emit([runtimeDriftObserved({ expected, observed })]);
          // eslint-disable-next-line no-console
          console.warn(
            `vimes-daemon: CLI runtime drift — expected=${expected ?? '(unpinned)'} observed=${observed ?? '(unknown)'}`,
          );
        }
      }
      // host_started + boot recovery: any session the log left running/spawning
      // with no live process becomes interrupted (§3.10, D13).
      sessionHost.start();
      // Push pipeline: subscribe to every session stream now in the log (survives
      // restart; a later resume→gate on one of them will push). New sessions
      // register via the host's onSessionCreated callback.
      pushPipeline.start();
      snapshotTimer = setInterval(() => {
        try {
          saveAllSnapshots();
        } catch {
          // A transient snapshot-save failure is non-fatal: the log is the truth
          // and the next tick (or graceful shutdown) retries.
        }
      }, config.snapshotIntervalMs);
      snapshotTimer.unref();
      // Inactivity reaper (terminal-lifecycle backlog item). The DAEMON boundary
      // owns the periodic timer (rule 0.3: not in the host's pure logic); it feeds
      // the production clock + the configured window into terminalHost.reapIdle.
      // A window of 0 disables reaping — the timer is never created. unref'd so it
      // never keeps the process alive, and cleared on stop() so no handle leaks.
      if (config.terminalIdleReapMs > 0) {
        terminalReapTimer = setInterval(() => {
          try {
            terminalHost.reapIdle(clock.now(), config.terminalIdleReapMs);
          } catch {
            // A transient reap failure is non-fatal: the next tick retries.
          }
        }, TERMINAL_REAP_CHECK_INTERVAL_MS);
        terminalReapTimer.unref();
      }
      // Usage-endpoint poller (slice 5 step 2). The DAEMON boundary owns the
      // periodic timer, exactly like the reaper above (rule 0.3) — the adapter
      // and the parser stay pure/injected. An interval of 0 disables polling
      // entirely: the timer is never created. unref'd so it never keeps the
      // process alive, and cleared on stop() so no handle leaks.
      if (config.usagePollIntervalMs > 0) {
        // Fire one poll immediately (fire-and-forget, never awaited) so meters
        // populate promptly after boot instead of sitting at unknown for a
        // full interval — setInterval alone doesn't fire until the first
        // tick elapses. Never fatal, same as the interval callback below: a
        // failed poll emits nothing and the interval retries on schedule.
        void pollUsageOnce().catch(() => {
          // A failed poll emits nothing and is never fatal: the next tick
          // retries, and the meters degrade to stale in the meantime.
        });
        usagePollTimer = setInterval(() => {
          void pollUsageOnce().catch(() => {
            // A failed poll emits nothing and is never fatal: the next tick
            // retries, and the meters degrade to stale in the meantime.
          });
        }, config.usagePollIntervalMs);
        usagePollTimer.unref();
      }
    },

    async stop(): Promise<void> {
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      if (terminalReapTimer !== null) {
        clearInterval(terminalReapTimer);
        terminalReapTimer = null;
      }
      if (usagePollTimer !== null) {
        clearInterval(usagePollTimer);
        usagePollTimer = null;
      }
      // host_stopped + kill children (they die with the daemon, §3.10) and stop
      // watching transcripts BEFORE the final snapshot, so the log/watchers are
      // quiescent when the db closes. The hook ingress closes first so no late
      // POST can emit after shutdown begins.
      await hookIngress.stop();
      pushPipeline.stop();
      sessionHost.stop();
      // Terminals are ephemeral shells; they die with the daemon (§3.10).
      terminalHost.closeAll();
      await tailer.close();
      // Order (graceful shutdown): save snapshots → close WS clients → close db.
      try {
        saveAllSnapshots();
      } catch {
        // ignore — see start()'s rationale.
      }
      wsHub.close();
      await new Promise<void>((resolveStop) => {
        httpServer.close(() => resolveStop());
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
      });
      store.dispose();
      snapshotStore.dispose();
      pushSubscriptions.dispose();
    },
  };
}
