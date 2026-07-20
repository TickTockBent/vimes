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
  metersProjection,
  sessionsProjection,
  tasksProjection,
  SYSTEM_STREAM,
  type Clock,
  type IdSource,
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

  // GET /api/terminals — the live terminal list (terminal-lifecycle backlog
  // item). Behind the same auth wall as everything else on the product port and
  // registered BEFORE the static catch-all. The byte-free listing lets a fresh
  // page load (terminalId is in-memory only) rediscover the shells still running
  // so they can be re-entered. `terminalHost` is created below; the closure only
  // runs per request, long after construction.
  app.get('/api/terminals', (context) => context.json({ terminals: terminalHost.listTerminals() }));

  if (config.staticDir !== undefined) {
    const staticDir = config.staticDir;
    app.get('*', async (context) => {
      const direct = await readStaticFile(staticDir, context.req.path);
      if (direct !== null) {
        return context.body(direct.body, 200, { 'content-type': direct.contentType });
      }
      // SPA fallback: extension-less paths fall back to index.html.
      if (extname(context.req.path) === '') {
        const indexFile = await readStaticFile(staticDir, '/index.html');
        if (indexFile !== null) {
          return context.body(indexFile.body, 200, { 'content-type': indexFile.contentType });
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

  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let terminalReapTimer: ReturnType<typeof setInterval> | null = null;

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
