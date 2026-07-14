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
import {
  SessionHost,
  type PtySpawnFactory,
  type SdkQueryFactory,
} from './sessionHost.js';
import { JsonlTailer } from './tailer.js';
import type { DaemonConfig } from './config.js';

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
  // Override the transcript projects root + chokidar options (tests).
  projectsRoot?: string;
  tailerWatchOptions?: ConstructorParameters<typeof JsonlTailer>[0]['watchOptions'];
}

export interface Daemon {
  readonly httpServer: Server;
  readonly store: SqliteEventStore;
  readonly router: EventRouter;
  readonly snapshotStore: SqliteSnapshotStore;
  readonly wsHub: WsHub;
  readonly sessionHost: SessionHost;
  readonly authConfigured: boolean;
  readonly port: number;
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
  });
  const tailer = new JsonlTailer({
    router,
    projectsRoot: deps.projectsRoot,
    watchOptions: deps.tailerWatchOptions,
  });
  sessionHost.attachTailer(tailer);

  const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
  const wsHub = new WsHub({
    router,
    store,
    bufferedLimitBytes: config.wsBufferedLimitBytes,
    bufferedAmountOf: deps.wsBufferedAmountOf,
    sessionHost,
    projectRoots: config.projectRoots,
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

  return {
    httpServer,
    store,
    router,
    snapshotStore,
    wsHub,
    sessionHost,
    authConfigured,
    get port(): number {
      const address = httpServer.address();
      return address !== null && typeof address === 'object' ? (address as AddressInfo).port : config.port;
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
      // host_started + boot recovery: any session the log left running/spawning
      // with no live process becomes interrupted (§3.10, D13).
      sessionHost.start();
      snapshotTimer = setInterval(() => {
        try {
          saveAllSnapshots();
        } catch {
          // A transient snapshot-save failure is non-fatal: the log is the truth
          // and the next tick (or graceful shutdown) retries.
        }
      }, config.snapshotIntervalMs);
      snapshotTimer.unref();
    },

    async stop(): Promise<void> {
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      // host_stopped + kill children (they die with the daemon, §3.10) and stop
      // watching transcripts BEFORE the final snapshot, so the log/watchers are
      // quiescent when the db closes.
      sessionHost.stop();
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
    },
  };
}
