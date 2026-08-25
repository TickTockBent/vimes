import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, readFile, stat } from 'node:fs/promises';
// Synchronous, because the PreCompact answer path it serves is synchronous all
// the way down (the gate decides inside one request, with no awaits between the
// hook's POST and its exit code).
import { statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
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
  nodesProjection,
  projectsProjection,
  sessionsProjection,
  instancesProjection,
  legacyTasksViewOf,
  SYSTEM_STREAM,
  // B1 — the usage-poller auth-failure backoff DECISION. Pure reducer; this
  // boundary owns the actual setTimeout that drives it (rule 0.3).
  nextUsageBackoff,
  initialUsageBackoffState,
  type Clock,
  type IdSource,
  type MetersState,
  type Projection,
  type UsageBackoffConfig,
  type UsageBackoffState,
} from '@vimes/core';
// S18·U2 (Move 4) — the dispatcher's instruction seam is TENANT policy and lives
// in the task extension now; the engine still owns WHETHER and WHO. Root barrel
// only: the boundary checker refuses a deep import into an ext-* package.
import { composeStageInstruction, briefingComposers } from '@vimes/ext-tasks';
import Database from 'better-sqlite3';
import { SqliteEventStore } from './sqliteEventStore.js';
import { SqliteSnapshotStore } from './sqliteSnapshotStore.js';
import { SqliteArtifactStore } from './sqliteArtifactStore.js';
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
import { DAEMON_API_VERSION, DAEMON_CAPABILITIES } from './apiVersion.js';
import { registerCheckoutApi } from './checkoutApi.js';
import { registerFileApi } from './fileApi.js';
import { registerGitApi } from './gitApi.js';
import { registerInstanceApi, resolveInitialNode } from './instanceApi.js';
import { registerNodeApi } from './nodeApi.js';
import { registerProjectApi } from './projectApi.js';
import { registerOrchestratorApi, standingNotesPathFor } from './orchestratorApi.js';
import { buildCreateTaskSpec } from './createTaskTool.js';
import { CompactionSteward } from './compactionSteward.js';
import { InstanceWriter } from './instanceWriter.js';
import { loadShippedWorkflow } from './shippedManifest.js';
import { NodeWriter } from './nodeWriter.js';
import { ProjectWriter } from './projectWriter.js';
import { TaskDispatcher } from './taskDispatcher.js';
// S19·U2 (slice-19 §3.5): the declaration path's preflight. Wired below as an
// injected dep the dispatcher does NOT call yet — U3 is the flip.
import { preflightBriefing } from './briefingPreflight.js';
import { TaskWatchdog } from './taskWatchdog.js';
import { GitAdapter, defaultGitRunner, type GitRunner } from './gitAdapter.js';
import { CheckoutCoordinator } from './checkoutCoordinator.js';
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
import type { CliVersionProbe, PreflightProbe, SdkCliVersionProbe } from './runtimeChecks.js';
import { reportCliVersionCheck } from './versionCompare.js';
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
import { currentCostLedger, type CostLedgerBody } from './costLedgerApi.js';
import {
  UsageObservationLog,
  defaultUsageObservationLogPath,
} from './usageObservationLog.js';
import { MeterAlertLedger, sendMeterAlertPush } from './meterAlerts.js';
import { SqliteCostStore } from './sqliteCostStore.js';
import { ingestCostCorpus, defaultCostLedgerPath } from './costIngest.js';
import { nodeCorpusFileSystem, type CorpusFileSystem } from './costCorpus.js';

// How often the inactivity reaper wakes to check for idle terminals. This is the
// detection CADENCE, not the tuned window: config.terminalIdleReapMs is the
// behavior-shaping knob (how long idle before reaping). A fixed 60s cadence
// bounds reap latency to at most a minute past the window — cheap and not a
// calibrated band. Disabled entirely when the window is 0.
const TERMINAL_REAP_CHECK_INTERVAL_MS = 60_000;

// The METER staleness band handed to the dispatcher when the usage poller is
// DISABLED — i.e. when `deriveStaleAfterMs(config.usagePollIntervalMs)` is null.
//
// The poller is off, so NO meter observation can be vouched for as current. This
// is NOT a ⟨tune⟩ pin (rule 0.2) — it is the DEGENERATE BAND meaning "nothing
// counts as fresh", which is the literal truth when nothing is being observed.
// The alternatives were both worse: fabricating a plausible band would pin a
// number nobody calibrated, and disabling dispatch entirely would make the
// daemon's whole task system depend on an unrelated feature being switched on.
//
// The consequence, stated so it is a choice and not a surprise: a task with a
// `requireHeadroom` gate refuses `headroom-unknown` (pillar 4 — never spawn
// against a number we cannot see, and never call it "insufficient" when the truth
// is "invisible"). UNGATED work is completely unaffected, so the blast radius is
// opt-in: only tasks that asked to be gated are held.
//
// GAP CLOSED (D33, decisions.md, signed off 2026-07-22). `meterFreshness`
// classifies with `age > staleAfterMs` — a STRICT `>` — so at a band of 0 an
// observation whose age was EXACTLY 0 ms still read 'fresh': the name overstated
// its own guarantee by one millisecond. `-1` is not arbitrary: because the
// comparison is strict, `-1` is the LARGEST band for which every non-negative
// age (i.e. every age that can actually occur — `meterFreshness` already treats
// a future-dated observation as fresh, never stale) reads 'stale'. That is
// exactly the guarantee the name makes, so `-1` is the unique value that makes
// the name true rather than a nearby approximation of it.
//
// ⚠ `-1` as a duration reads oddly ON PURPOSE. It is not a timeout — nothing
// waits `-1` ms for anything — it is the SENTINEL that makes "nothing is fresh"
// literally true under a strict `>` comparison. A future reader who "fixes" this
// back to `0` because a negative duration looks like a bug re-opens D33.
export const NO_OBSERVATION_IS_FRESH_STALE_BAND_MS = -1;

const DAEMON_PROJECTIONS: ReadonlyArray<Projection<unknown>> = [
  sessionsProjection as Projection<unknown>,
  metersProjection as Projection<unknown>,
  // S11·U1 (D72 Move 2): the INSTANCE store, registered under its own id
  // ('instances'). The old 'tasks' snapshot rows are dead but harmless — noted,
  // not cleaned (slice-11.md) — and the first boot after this deploy replays the
  // 'tasks' STREAM (a few hundred events) from seq 1 under the new projection id.
  instancesProjection as Projection<unknown>,
  cacheObservabilityProjection as Projection<unknown>,
  // S8·1 D42 — the project registry. Registered like its siblings so it is
  // snapshotted on the same cadence: the writer and the API both read it FRESH
  // per request through `bootFromSnapshot`, and a projection with no snapshots
  // would replay the whole log on every one of those reads.
  projectsProjection as Projection<unknown>,
  // S14·U3 (E2) — the session FOREST. Registered now that something finally
  // writes its stream (`nodeWriter.ts` is the first emitter, slice-14.md §0
  // item 1): it is snapshotted on the same cadence as its siblings, because the
  // writer and `GET /api/tree` both read it FRESH per request through
  // `bootFromSnapshot`, and a projection with no snapshots would replay the
  // whole log on every one of those reads. Registration is also what makes
  // `GET /api/projections/nodes` serve it like every sibling.
  nodesProjection as Projection<unknown>,
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
  // Runtime version probes (E4), one per channel. Absent → that channel's boot
  // check is SKIPPED (so integration tests never invoke a real CLI); main.ts
  // injects the real ones. Present → drift is observed at boot, warn-only.
  // `cliVersionProbe` watches the PATH `claude` (PTY channel);
  // `sdkCliVersionProbe` watches the binary the Agent SDK vendors and actually
  // runs for SDK sessions (the D4 default channel). The two are evaluated
  // INDEPENDENTLY against their own pins — their versions legitimately differ.
  cliVersionProbe?: CliVersionProbe;
  sdkCliVersionProbe?: SdkCliVersionProbe;
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
  // Cost-ledger seams (slice 5b). Absent → the real ledger db beside events.db
  // and the real fs corpus reader over ~/.claude/projects. INJECTED by tests: a
  // fake CorpusFileSystem + a :memory: or temp store path, so no test reads
  // ~/.claude or writes a real ledger db.
  costLedgerPath?: string;
  costCorpusFileSystem?: CorpusFileSystem;
  // Test seam: inject a store that fails its writes, so the daemon's non-fatal
  // ingest guard can be exercised — absent in prod.
  costLedgerStore?: SqliteCostStore;
  // ── S12·U2 (D72 Move 3): where the SHIPPED declaration is read from ─────────
  //
  // **TEST INJECTION ONLY.** Absent → `loadShippedWorkflow`'s own default, which
  // resolves the in-build asset relative to its own module (never the cwd — see
  // shippedManifest.ts). Production passes nothing; the parameter exists so the
  // boot-refusal path (S12-A5) is assertable without moving files inside a live
  // package.
  shippedManifestPath?: string;
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
  // One cost-ledger ingest scan, awaited. The ingester's timer calls exactly
  // this; tests call it directly so a scan is deterministic rather than
  // clock-raced (mirrors pollUsageOnce). A no-op when ingestion is disabled.
  ingestCostOnce(): Promise<void>;
  // The derived usage read model as GET /api/usage/derived would serve it, with
  // `nowIso` stamped from the injected clock. Exposed so tests can assert the
  // shape without a round trip.
  derivedUsage(): DerivedUsageBody;
  // The cost-ledger read model as GET /api/cost/ledger would serve it. Exposed so
  // tests can assert the body (and the disabled-ingestion envelope) without a
  // round trip. Throws the reconciliation finding if the built tree does not
  // reconcile — the route turns that into a 500.
  costLedger(): CostLedgerBody;
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

// ─── the SPA fallback rule (D61) ─────────────────────────────────────────────
//
// D61 made the PATH the project identity — `/infrastructure/johnny/` is a real,
// bookmarkable, new-tab-able URL that the daemon must answer with the app shell,
// because only the client knows what to do with it. This predicate is the whole
// rule, extracted so it is assertable without a listener.
//
// GET ONLY — the caller is the `app.get('*')` arm, so a POST to an unknown path
// never reaches here and stays a 404 (a stray POST must not be answered with a
// 200 page).
//
// TWO EXCLUSIONS, both load-bearing:
//
//   1. **`/api/...` NEVER falls back.** An unknown API path is a caller's
//      mistake, and answering it with 200 + HTML turns a typo into a JSON parse
//      error three layers away. ⚠ This is the ONE behaviour change this unit
//      makes to an existing surface: before D61 an extension-less `/api/nope`
//      fell through to the shell. It was always wrong; D61 (which makes every
//      unmatched path meaningful) is what makes it worth fixing.
//   2. **Anything that LOOKS LIKE AN ASSET never falls back** — a missing
//      `/assets/index-abc.js` must 404 loudly, not return HTML that the browser
//      then fails to execute. "Looks like an asset" is `STATIC_CONTENT_TYPES`
//      membership, deliberately NOT "has any extension at all": a project
//      directory may legitimately contain a dot (`~/projects/my.tool`), and
//      `extname('/my.tool/')` is `.tool`, so an extension test alone would make
//      that project the one project unreachable by its own URL.
//
// `/hooks/*` needs no exclusion: hook ingress is a SEPARATE listener on
// `config.hookPort` (createHookIngress, 127.0.0.1 only) and this Hono app
// registers no `/hooks` route at all.
export function shouldServeAppShell(requestPath: string): boolean {
  if (requestPath === '/api' || requestPath.startsWith('/api/')) {
    return false;
  }
  const extension = extname(requestPath);
  return extension === '' || STATIC_CONTENT_TYPES[extension] === undefined;
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
  // ─── S12·U2 (D72 Move 3): the shipped declaration, resolved FIRST ───────────
  //
  // Before the store opens, before a route registers and long before anything
  // binds a port: a daemon that cannot read its own in-build declaration is
  // MISBUILT, not degraded, so this THROWS and `main.ts`'s top-level catch prints
  // it and exits non-zero (S12-A5). Resolved exactly once, here, and injected
  // everywhere it is needed — the writer adjudicates against it, the instance API
  // defaults its create doors' starting node from it and serves its edge table,
  // and the `create_task` tool lands authored work on its `initial`.
  const shippedWorkflow = loadShippedWorkflow(deps.shippedManifestPath);
  // The declaration's starting node, narrowed ONCE to the record vocabulary by
  // the same helper the HTTP create doors use — imported rather than re-derived,
  // so the `create_task` grant and the two HTTP doors cannot disagree about where
  // an instance begins (principle 9). Throws here, at boot, if a declaration ever
  // names a node the record schema cannot hold.
  const authoredInstanceInitialNode = resolveInitialNode(shippedWorkflow.workflow);
  const store = new SqliteEventStore({ path: config.dbPath, clock, ids });
  const snapshotStore = new SqliteSnapshotStore({ path: config.dbPath });
  // S7·5b-i: the artifact store the dispatcher writes captured plans into (D48).
  // Unlike the stores above it takes an ALREADY-OPEN Database rather than a `{ path }`
  // (see sqliteArtifactStore.ts's constructor-style note); we resolve that here by
  // opening a DEDICATED connection to the same `config.dbPath` — better-sqlite3 opens
  // several connections to one file routinely, and this keeps the artifact tables in
  // the daemon's single database without refactoring the other stores' ownership of
  // their own connections. No live caller yet (recordPlan's trigger is 5b-ii).
  const artifactStore = new SqliteArtifactStore(new Database(config.dbPath));
  const router = new EventRouter(store);
  const { verifier, configured: authConfigured } = resolveVerifier(config, deps.verifier);

  const emitAuthRejected: EmitAuthRejected = (info) => {
    // Never the token or headers — only path + classified reason (email omitted).
    router.emit([
      { stream: SYSTEM_STREAM, type: AUTH_REJECTED_EVENT_TYPE, payload: { path: info.path, reason: info.reason } },
    ]);
  };

  // S11·U1: read the instance store the way every task-shaped consumer in this
  // file still wants it — as the legacy narrowing. ONE derivation.
  //
  // ⚠ SURVIVES S13·U4 (alias death) — NOT DEAD CODE. Through S13·U3 this fed
  // BOTH the legacy tasks-projection alias route and the four `readTasks`
  // callbacks below; S13·U4 deleted the alias branch in `serializeProjection`
  // (below) and the app.ts caller count on this function dropped from 5 to 4,
  // but it did NOT reach zero. `InstanceWriter`, `TaskDispatcher`,
  // `registerOrchestratorApi` and `TaskWatchdog` still take the legacy
  // `TaskRecord` narrowing (instanceWriter.ts's own note: "the ADJUDICATION no
  // longer takes the narrowing `legacyTasksViewOf` produces" is about the
  // MOVE-adjudication path specifically, not this read) — that dependency is
  // Move 4 territory (`packages/ext-tasks/`), explicitly out of this unit. See
  // `packages/core/src/projections/legacyTasksView.ts`'s header, updated to
  // name this as its one remaining consumer.
  const readTasksAsLegacyView = (): ReturnType<typeof legacyTasksViewOf> =>
    legacyTasksViewOf(bootFromSnapshot(instancesProjection, snapshotStore, store));

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
      // schemaVersion is the EVENT-SCHEMA version (store.schemaVersion()) — a
      // different fact from apiVersion (D84, apiVersion.ts) and never conflated
      // with it: schemaVersion is what was persisted, apiVersion is what this
      // daemon SERVES over REST/WS right now.
      schemaVersion: store.schemaVersion(),
      apiVersion: DAEMON_API_VERSION,
      capabilities: DAEMON_CAPABILITIES,
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
    // S17·U4 (§3.7): the worktrees read route also reports this repository's
    // ORPHAN checkouts, and `CheckoutCoordinator.listOrphans` is their only
    // source. Wrapped in a thunk because `checkoutCoordinator` is constructed
    // FURTHER DOWN — the same deferral `sessionHost` above already relies on;
    // the arrow only runs per request.
    listOrphans: () => checkoutCoordinator.listOrphans(),
  });

  // ─── the task API (slice 6 step 4b) ────────────────────────────────────────
  //
  // Behind the same auth wall (`app.use('*', ...)` above — I14 needs no per-route
  // work here) and before the static catch-all, in the same region as the other
  // registerXApi calls. This is the dispatcher's FIRST CALLER: steps 1–4a built
  // the decisions and the executor, and nothing invoked them outside a test.
  //
  // ⚠ ONE WRITER. `InstanceWriter` is constructed here and is the ONLY thing in
  // the daemon that writes `instance_created` / `instance_moved` /
  // `instance_move_rejected` / `instance_payload_revised` (S11·U2 re-homed it from
  // `TaskWriter`, spelling included). Step 5's watchdog takes this same instance
  // rather than growing a second path (principle 10).
  const instanceWriter = new InstanceWriter({
    emit: (events) => router.emit(events),
    readTasks: () => readTasksAsLegacyView(),
    ids,
    // S12·U2 (D72 Move 3): the boot-resolved declaration and its pinned ref,
    // handed to the writer rather than read by it (rule 0.3 — the writer does no
    // I/O). `shippedWorkflow` is resolved ONCE above and shared with the API
    // surface below, so adjudication, the create doors' starting node and the
    // served legality table are three readings of ONE declaration.
    workflow: shippedWorkflow.workflow,
    workflowRef: shippedWorkflow.ref,
  });

  // ─── worker isolation (slice 6 step 8, re-engined by S17·U3) — STILL OFF ───
  //
  // ⚠ `const worktreeManager = new WorktreeManager({...})` STOOD HERE and is GONE:
  // S17·U3 deleted the class. The dispatcher now takes `checkoutCoordinator`
  // (constructed further down) and `nodeWriter`, wired at the bottom of its deps
  // below. The FLAG is untouched — `config.worktreeIsolation` still defaults to
  // `off`, so on this machine today the coordinator is reachable from the
  // dispatcher and never reached by it. See taskDispatcher.ts's isolation block
  // for why the flip is a human's.

  const taskDispatcher = new TaskDispatcher({
    // `sessionHost` is constructed further down; these thunks only run per
    // dispatch request, long after construction — the same deferral
    // registerFileApi already relies on for `liveSessionCwds()`.
    sessionHost: {
      spawnSession: (options) => sessionHost.spawnSession(options),
      isLive: (appSessionId) => sessionHost.isLive(appSessionId),
      // ⚠ S7·7b (D46): `resumeSession` was wired here for step 7's fix loop and is
      // GONE — the dispatcher no longer accepts it. The host still HAS the method,
      // and wsHub.ts still calls it for the human's own resume (rider 2); this
      // composition simply no longer hands it to the dispatcher.
      // `sendMessage` is the instruction path — same instance, same live registry,
      // no second session authority.
      sendMessage: (appSessionId, text) => sessionHost.sendMessage(appSessionId, text),
    },
    // The minimal, stage-generic instruction Wes signed off 2026-07-24 (see
    // packages/ext-tasks/src/stageInstruction.ts) — a dispatched worker is now
    // told what task/stage/directory it's in and how to behave mid-run, instead
    // of nothing. Per-stage specialisation (planning/implementing/review wording)
    // is deliberately deferred — D43/D44, slice 7.
    composeStageInstruction,
    // ─── S19·U2 (slice-19 §3.5/§3.6/§3.7): the DECLARATION path, wired BESIDE ──
    //
    // ⚠ **NOTHING CALLS THIS YET, SO THIS WIRING CHANGES NO BEHAVIOUR.** The
    // dispatcher takes `preflightBriefing` as an optional dep and never invokes
    // it in this unit; the compiled path above (`composeStageInstruction`,
    // composed POST-spawn in `deliverStageInstruction`) is still the whole of
    // production. U3 flips the call site, and it can be a one-line flip because
    // the composition is already standing here.
    //
    // THREE injections, and each is the SAME object something else already uses:
    //
    //   • `workflow` — the boot-resolved declaration (§3.3's one-declaration
    //     law, Move 3's signed F2). Literally the same `shippedWorkflow.workflow`
    //     the `InstanceWriter` adjudicates against and the instance API serves
    //     its edge table from. Dispatch becomes the THIRD reading of ONE
    //     declaration, never a fourth resolution of its own.
    //   • `composers` — the tenant's Tier-1 composer table (§3.1), through the
    //     root barrel like every other `@vimes/ext-tasks` import here.
    //   • `artifactStore` — the same store the dispatcher writes captured plans
    //     into, so the `artifact:plan` row fetches from one place.
    preflightBriefing: (task) =>
      preflightBriefing(task, {
        workflow: shippedWorkflow.workflow,
        composers: briefingComposers,
        artifactStore,
      }),
    emit: (events) => router.emit(events),
    readTasks: () => readTasksAsLegacyView(),
    readMeters: () => currentMetersState(),
    // S17·U3: the D42 registry, for the projectRoot → projectId join §3.2 leans
    // on. The SAME `bootFromSnapshot` thunk every other service takes, so nothing
    // here holds a cached copy of anything.
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    // The INJECTED clock, stamped HERE at the boundary and nowhere deeper
    // (rule 0.3). Never `Date.now()`.
    nowIso: () => clock.now(),
    // Null (poller disabled) → the degenerate band; see the constant's own note.
    staleAfterMs: deriveStaleAfterMs(config.usagePollIntervalMs) ?? NO_OBSERVATION_IS_FRESH_STALE_BAND_MS,
    // ⚠ **OFF BY DEFAULT.** `VIMES_WORKTREE_ISOLATION` is `off` unless an operator
    // sets it, so this is `false` on this machine today and every task resolves to
    // `task.projectRoot` exactly as it did before step 8 — no git command is issued
    // on any dispatch path. Flipping it changes WHERE REAL WORK EXECUTES on a real
    // disk, which is Wes's call to make deliberately (rule 0).
    worktreeIsolationEnabled: config.worktreeIsolation === 'on',
    // S17·U3: the checkout maker, narrowed to `create` (the dispatcher may not
    // `open` or `remove` — those are U4's propose routes). Wrapped in a thunk
    // rather than passed by value because `checkoutCoordinator` is constructed
    // FURTHER DOWN, beside the node writer it shares; the arrow only runs per
    // dispatch, long after construction — the same deferral `sessionHost` above
    // already relies on.
    checkoutCoordinator: {
      create: (request, inLockFollowUp) => checkoutCoordinator.create(request, inLockFollowUp),
    },
    // S17·U3: §3.2's `session_attached_to_node`, through the SOLE writer of the
    // nodes stream — the SAME instance the node API and the coordinator use, never
    // a second path (principle 10). Deferred for the same reason as above.
    nodeWriter: {
      attachSession: (input) => nodeWriter.attachSession(input),
    },
    // S7·5b-i: the state-owning half of native plan capture (D48). The dispatcher
    // writes captured plans into `artifactStore` and proposes planning→plan-ready
    // through `instanceWriter` (I7's choke point — the SAME one-writer instance the
    // task API uses, never a second one). Nothing calls `recordPlan` yet; the
    // trigger is 5b-ii, so wiring these two changes no live behaviour.
    artifactStore,
    instanceWriter,
  });

  // S11·U3 (D72 Move 2): the generic instance routes ARE the contract. Through
  // S13·U3 every deprecated task-alias path they replaced was registered
  // beside them for exactly one deploy of overlap (q24 — the inventory was in
  // instanceApi.ts's header, together with the legacy tasks-projection row
  // above); S13·U4 deleted the alias set once the UI unit switched every call
  // site to the generic routes, closing q24.
  registerInstanceApi(app, {
    instanceWriter,
    // ONE explicit attempt per request. No loop, no timer, no scheduling — step
    // 4a's boundary, unchanged. The promise is step 8's async ripple and nothing
    // more; the envelope the route returns is byte-identical.
    dispatchTask: (taskId) => taskDispatcher.dispatchTask(taskId),
    // The SAME allowlist union the file/git APIs use, verbatim, read fresh per
    // request. An instance's project root is a durable instruction to spawn a
    // process in a directory, so it is walled by exactly the same allowlist a
    // file read is.
    getAllowedRoots: () => [...config.projectRoots, ...sessionHost.liveSessionCwds()],
    // The INSTANCE fold, read fresh per response — the generic routes' envelopes
    // carry the record as the projection folded it (I12). Deliberately NOT
    // `readTasksAsLegacyView` above: that narrowing exists for the writers
    // (Move 4 territory), and handing it to the generic surface would make the
    // new contract a view of the old one.
    readInstances: () => bootFromSnapshot(instancesProjection, snapshotStore, store),
    // S12·U2 (D72 Move 3): the SAME boot-resolved declaration object the writer
    // adjudicates against. The create doors default their starting node from
    // its `initial`, and the q25 declaration route derives its edge table
    // from its edges — one declaration, three readings.
    workflow: shippedWorkflow.workflow,
    // S13·U2 (q25): the SAME pinned ref the writer stamps on every birth
    // record (`instanceWriter` above), so the declaration-introspection
    // routes key on the identity instances are actually recorded against.
    workflowRef: shippedWorkflow.ref,
  });

  // ─── the project registry (S8·1, D42) ──────────────────────────────────────
  //
  // Behind the same auth wall and before the static catch-all, in the same region
  // as the other registerXApi calls.
  //
  // ⚠ ONE WRITER, exactly as `InstanceWriter` is for tasks: this instance is the ONLY
  // thing in the daemon that writes `project_created` / `project_updated` /
  // `project_archived`, and any later caller (the picker's own bookkeeping, an
  // onboarding workflow) takes THIS instance rather than growing a second path.
  const projectWriter = new ProjectWriter({
    emit: (events) => router.emit(events),
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    ids,
  });

  registerProjectApi(app, {
    projectWriter,
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    // ⚠ **THE STATIC CONFIG ROOTS — NOT the `config.projectRoots ∪
    // liveSessionCwds()` union every other registerXApi above is handed.** D60:
    // declaring a project may not widen D21's fence, and a session's transient
    // cwd is not a declarable boundary. This asymmetry is deliberate and is the
    // whole security content of the unit; see `ProjectApiDeps`.
    getConfiguredProjectRoots: () => config.projectRoots,
  });

  // ─── the session tree (S14·U3, E2) ─────────────────────────────────────────
  //
  // Behind the same auth wall and beside the registry whose boundaries its
  // virtual roots are composed from (F1: a project root is NEVER an event —
  // project identity has one source of record, and it is the registry above).
  //
  // ⚠ ONE WRITER, exactly as `ProjectWriter` and `InstanceWriter` are for their
  // own state: this instance is the ONLY thing in the daemon that writes
  // `node_created` / `node_closed` / `session_attached_to_node`, and any later
  // caller (a spawn-into-a-node flow, a TUI command) takes THIS instance rather
  // than growing a second path.
  //
  // Three projection reads because the writer's rules span three folds — see
  // `NodeWriterDeps`. All of them are the SAME `bootFromSnapshot` thunks the
  // other registrations use, so nothing here holds a cached copy of anything.
  const nodeWriter = new NodeWriter({
    emit: (events) => router.emit(events),
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    readNodes: () => bootFromSnapshot(nodesProjection, snapshotStore, store),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    ids,
  });

  registerNodeApi(app, {
    nodeWriter,
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    readNodes: () => bootFromSnapshot(nodesProjection, snapshotStore, store),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
  });

  // ─── the checkout coordinator (S17·U2, E2-c) ───────────────────────────────
  //
  // ⚠ **THE ONLY MAKER OF CHECKOUTS IN THIS DAEMON** since S17·U3 deleted
  // `WorktreeManager` (slice-17.md §3.11 — the two-writer window the signed
  // transition safety opened for exactly one unit is closed). Two callers today:
  // the orphan scan in `start()` below, and `taskDispatcher` above, which reaches
  // it through the deferred thunk in its deps. The propose routes arrive in U4.
  //
  // It shares the SAME injected git runner every other git caller uses
  // (`deps.gitRunner`, defaulting to the real one): ONE subprocess seam for git
  // in the whole daemon, so a test that fakes git fakes all of it.
  //
  // The three projection reads are the SAME `bootFromSnapshot` thunks every
  // other service takes, so nothing here holds a cached copy of anything — and
  // §3.3's remove gate re-reads sessions through this thunk INSIDE the lock,
  // which is the whole reason it is a thunk and not a value.
  const checkoutCoordinator = new CheckoutCoordinator({
    adapter: new GitAdapter({ runner: deps.gitRunner ?? defaultGitRunner }),
    // The SOLE writer of the nodes stream's S9·1 events, shared rather than
    // duplicated: `node_created` WITH provenance goes through the same instance
    // the node API uses (principle 10 — one writer, never a second path).
    nodeWriter,
    emit: (events) => router.emit(events),
    ids,
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    readNodes: () => bootFromSnapshot(nodesProjection, snapshotStore, store),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    // The SAME config field the retired manager read — one directory, one
    // operator-facing env var (`VIMES_WORKTREE_ROOT`).
    worktreeRoot: config.worktreeRoot,
    // §3.10's `checkout-unrecorded-mismatch` row is the only consumer. `access`
    // rather than `existsSync` so the probe is async like everything around it,
    // and a rejection means "not there" — the only thing this question needs.
    pathExists: async (candidatePath) => {
      try {
        await access(candidatePath);
        return true;
      } catch {
        return false;
      }
    },
    logWarn: (message) => {
      console.warn(message);
    },
  });

  // ─── the checkout propose-routes (S17·U4, §3.4/§3.5) ───────────────────────
  //
  // Behind the same auth wall (`app.use('*', ...)` above — I14 needs no per-route
  // work here) and before the static catch-all, in the same region as the other
  // registerXApi calls. Registered HERE rather than beside the git API so it sits
  // beside the coordinator it proposes to, which is also the only place the
  // instance is in scope by value.
  //
  // ⚠ The coordinator is narrowed to three ONE-ARGUMENT verbs: an HTTP caller may
  // not supply an `inLockFollowUp` (§3.3 — the in-lock hook is the dispatcher's
  // alone, and above it takes `create` narrowed the other way, to the one verb a
  // dispatch may perform). Two callers, two narrowings, one coordinator.
  registerCheckoutApi(app, {
    checkoutCoordinator: {
      create: (request) => checkoutCoordinator.create(request),
      open: (request) => checkoutCoordinator.open(request),
      remove: (request) => checkoutCoordinator.remove(request),
    },
  });

  // ─── the standing orchestrator (S8·3, D56) ─────────────────────────────────
  //
  // Behind the same auth wall, beside the registry it binds to. ONE endpoint —
  // ensure — and no boot hook: maintenance is LAZY by decision, so nothing here
  // runs until somebody asks a project for its orchestrator. See
  // orchestratorApi.ts's header for why that is the whole of "daemon-maintained".
  //
  // `sessionHost` is constructed further down; these thunks only run per request,
  // the same deferral `registerFileApi` above already relies on.
  registerOrchestratorApi(app, {
    readProjects: () => bootFromSnapshot(projectsProjection, snapshotStore, store),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    readTasks: () => readTasksAsLegacyView(),
    sessionHost: {
      spawnSession: (options) => sessionHost.spawnSession(options),
      // The EXISTING resume op, the same instance wsHub drives for a human's own
      // resume — never a second resume path (the dispatcher's `sessionHost`
      // composition above draws the same line for its own methods).
      resumeSession: (appSessionId) => sessionHost.resumeSession(appSessionId),
      sendMessage: (appSessionId, text) => sessionHost.sendMessage(appSessionId, text),
    },
    // Under the SAME `~/.vimes` home the daemon already owns (`config.dataDir` —
    // the events.db's directory unless `VIMES_DATA_DIR` says otherwise), so the
    // orchestrator's durable anchor lives beside the log it re-anchors from. The
    // orchestrator WRITES this file with its own file tools (D56, Phase B: no new
    // tool surface); the daemon only reads it back into a founding briefing.
    standingNotesDir: join(config.dataDir, 'orchestrator-notes'),
  });

  // ─── the stage-run watchdog (slice 6 step 5b) ──────────────────────────────
  //
  // Constructed here beside the dispatcher; its TIMER is installed in start()
  // below, with the reaper/poller lifecycle. Reads both projections fresh on
  // every check, writes through the same router, and stamps the INJECTED clock
  // at this boundary and nowhere deeper (rule 0.3).
  //
  // ⚠ IT DETECTS AND REPORTS. It never quarantines and never retries — see
  // taskWatchdog.ts for why the destructive half is still waiting on a Gate-D
  // sign-off, and note that a `watchdog_stale` raises attention and therefore
  // PUSHES A NOTIFICATION to a real phone.
  const taskWatchdog = new TaskWatchdog({
    readTasks: () => readTasksAsLegacyView(),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    emit: (events) => router.emit(events),
    nowIso: () => clock.now(),
    policy: {
      // D30's PINNED band (15 min by default; see config.ts).
      staleAfterMs: config.watchdogStaleAfterMs,
      // ⟨tune⟩ UNPINNED. The field is named `maxStaleRetries` by the step-5a
      // decision's shape; the config knob is named for what it actually counts
      // (EPISODES), because nothing retries. Neither number drives a
      // destructive action — the only thing they change is the
      // `wouldQuarantine` calibration flag on a record.
      maxStaleRetries: config.watchdogMaxStaleEpisodes,
      retryBackoffMs: config.watchdogRetryBackoffMs,
    },
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

  // ─── the cost-ledger read model (slice 5b step 4a) ─────────────────────────
  //
  // Registered here, before the static catch-all and behind the same auth wall.
  // Reads the durable ledger, then prices + trees + histories it in pure core
  // (buildCostLedgerReadModel). One endpoint carries the whole body (tree +
  // history); the corpus prices in milliseconds.
  //
  // Ingestion disabled (costLedgerStore null) → an envelope that SAYS so, never
  // a crash and never a fabricated zero-ledger. A tree that fails to reconcile
  // is a rule-0.1 finding: the builder throws and we return HTTP 500 with the
  // finding message — never a wrong 200.
  app.get('/api/cost/ledger', (context) => {
    try {
      return context.json(currentCostLedgerBody());
    } catch (error) {
      const findingMessage = error instanceof Error ? error.message : String(error);
      return context.text(`cost ledger unavailable: ${findingMessage}`, 500);
    }
  });

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
      // SPA fallback (D61): the PATH carries the project, so
      // `/infrastructure/johnny/` has to serve the app shell — which carries the
      // shell's no-cache directive. `shouldServeAppShell` owns the rule.
      if (shouldServeAppShell(context.req.path)) {
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

  // ─── the compaction steward (S8·4, D57/D64) ────────────────────────────────
  //
  // Capture-then-compact for the standing orchestrator: it NUDGES as the
  // transcript fills (so the state is banked voluntarily) and HOLDS the
  // PreCompact door while it is not. `sessionHost` is constructed just below;
  // the `sendMessage` thunk only runs per nudge, long after — the same deferral
  // `registerOrchestratorApi` above already relies on.
  //
  // ⟨tune⟩ thresholds come from core's `V0_COMPACTION_STEWARD_CONFIG` and are
  // DELIBERATELY not a config knob yet: D64 signed the mechanism and left the
  // numbers as design bands, so there is nothing calibrated to expose in
  // `/etc/vimes/env`. When the calibration pass earns them (Gate-D), a knob is
  // the natural landing place.
  // ⚠ The type annotation is load-bearing, not decoration: this steward and the
  // session host below reference each other (the steward sends turns THROUGH the
  // host; the host asks the steward for hook answers), and without a declared
  // type on one side TypeScript cannot break the inference cycle.
  const compactionSteward: CompactionSteward = new CompactionSteward({
    store,
    router,
    emit: (events) => router.emit(events),
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    readCacheObservability: () => bootFromSnapshot(cacheObservabilityProjection, snapshotStore, store),
    sendMessage: (appSessionId, text) => sessionHost.sendMessage(appSessionId, text),
    // The SAME notes location the founding briefing reads and the orchestrator
    // writes (orchestratorApi.ts) — one owner for the path, never a second
    // derivation that could drift from it.
    standingNotesPathFor: (projectId) =>
      standingNotesPathFor(join(config.dataDir, 'orchestrator-notes'), projectId),
    statNotesMtimeMs: (notesPath) => {
      // The fs boundary (rule 0.3, determinism-exempt). EVERY failure is null —
      // ENOENT is the ORDINARY case (an orchestrator that has never banked), and
      // a permission problem or a directory-where-a-file-should-be tells us the
      // same thing the gate needs to know: we have no evidence the notes were
      // written. Never throws; a stat must not be able to break a hook.
      try {
        return statSync(notesPath).mtimeMs;
      } catch {
        return null;
      }
    },
  });

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
    // Register each new session's stream with the push pipeline (per-stream
    // fanout) and, for an ORCHESTRATOR session only, with the compaction steward
    // (S8·4 — `watch` is a no-op for every other session, so this line costs an
    // ordinary spawn one projection read and nothing else).
    onSessionCreated: (appSessionId) => {
      pushPipeline.watch(appSessionId);
      compactionSteward.watch(appSessionId);
    },
    // S8·4 (D64): the PreCompact door + the post-compaction pointer. The host
    // delegates both answers here; it owns none of the policy.
    compactionSteward,
    // D48 native plan capture (S7·5b-ii): the SDK adapter intercepts a plan-mode
    // planner's ExitPlanMode and hands the plan here; the dispatcher owns task
    // state and records it (S7·5b-i's `recordPlan`). `taskDispatcher` is
    // constructed above; this thunk only runs per interception, long after.
    onPlanCaptured: (appSessionId, planText) => taskDispatcher.recordPlan(appSessionId, planText),
    // S7·6b review capture (I10): the SDK adapter observes a dispatched review
    // session's `report_review` tool call and hands the reported criteria here; the
    // dispatcher owns task state and records it (S7·6b's `recordReview` — emit
    // report_filed (reportKind 'review') + propose the review→done/implementing
    // move via I7).
    // Same wiring shape as onPlanCaptured above.
    onReviewReported: (appSessionId, criteria) => taskDispatcher.recordReview(appSessionId, criteria),
    // S7·7b completion capture (I10): the SDK adapter observes a dispatched
    // implementing session's `report_completion` tool call and hands the worklog
    // here; the dispatcher owns task state and records it (`recordCompletion` —
    // emit report_filed (reportKind 'completion') + propose the implementing→review
    // OUTCOME via I7,
    // D53). Same wiring shape as the two above.
    onCompletionReported: (appSessionId, worklog) =>
      taskDispatcher.recordCompletion(appSessionId, worklog),
    // ─── S8·6: the AUTHOR GRANT (D56's first verb, D65's `vimes_board`) ───────
    //
    // The one place the orchestrator's board verbs are composed. The host cannot
    // build this itself — `create_task` needs the task writer and the project
    // registry, and the session host is not a reader of task state (D18) — so the
    // capability is assembled here, where every other cross-module wire is made.
    //
    // ⚠ **ONE VERB, AND THE LIST IS THE GRANT.** D56: verbs arrive one at a time,
    // each individually revertible. Reverting the author grant is deleting this
    // array's one entry; there is no flag, no config and no other switch, and the
    // orchestrator's options go byte-identical back to pre-S8·6 when it is empty.
    //
    // ⚠ THE SAME `instanceWriter` INSTANCE the HTTP create door uses — one writer,
    // two callers (principle 10) — but handed in as a SINGLE destructured
    // capability, so the tool handler can create and can do nothing else. See
    // createTaskTool.ts's I7 note before widening this.
    orchestratorReportTools: (projectId) => [
      buildCreateTaskSpec({
        createTask: (input) => instanceWriter.createInstance(input),
        // FRESH per call, never captured at spawn: the registry read happens when
        // the model authors, so an edited root binds the task where the project
        // actually is now and a project that has left the registry refuses.
        resolveProjectRoot: () =>
          bootFromSnapshot(projectsProjection, snapshotStore, store).projects[projectId]?.root,
        // S12·U2: the boot declaration's starting node, the SAME value the HTTP
        // create doors default to — the author grant lands work where the
        // declaration says instances begin, not where this module once said.
        initialNode: authoredInstanceInitialNode,
      }),
    ],
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
    // D35: the SAME projection read the watchdog above uses, read FRESH per
    // `send` op — the hub asks "was a turn already in flight?" and emits
    // `correction_queued` only then. Wiring it here is what stops an opening
    // prompt to an idle session from being recorded as a course-correction.
    readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
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

  // ─── cost-ledger ingester (slice 5b) ──────────────────────────────────────
  // Pure daemon I/O wiring (rule 0.3): the scan + the durable store already
  // exist and are correct; this only SCHEDULES the scan and owns its lifecycle.
  // Gated symmetrically with the usage poller — a costIngestIntervalMs of 0
  // disables the whole feature, so no store is opened and no db file is created.
  // The ledger is its own SQLite file BESIDE events.db (max-wins is an UPDATE;
  // events.db carries ABORT triggers), injectable so tests never write a real
  // db. The corpus reader is injectable too so tests never read ~/.claude.
  const costLedgerStore =
    config.costIngestIntervalMs > 0
      ? (deps.costLedgerStore ??
        new SqliteCostStore({
          path: deps.costLedgerPath ?? defaultCostLedgerPath(config.dataDir),
        }))
      : null;
  const costCorpusFileSystem = deps.costCorpusFileSystem ?? nodeCorpusFileSystem;

  // The cost-ledger read model (slice 5b step 4a) — reads the store and hands it
  // to pure core. Referenced by the /api/cost/ledger route registered above; the
  // route only calls it per request, long after this store is initialized.
  const currentCostLedgerBody = (): CostLedgerBody =>
    currentCostLedger({
      costLedgerStore,
      projectRoots: config.projectRoots,
      // D37: the same projection the watchdog and the hub read, read FRESH per
      // request. This is what turns a session leaf from a bare uuid into the name
      // the human gave it; the ledger endpoint is manual-refresh only, so the
      // extra projection boot rides no polling cadence.
      readSessions: () => bootFromSnapshot(sessionsProjection, snapshotStore, store),
    });

  // One ingest scan. NEVER throws outward: a dead or unreadable corpus, or any
  // store/IO failure, is swallowed and logged as a single line (never a payload
  // dump), exactly like a failed usage poll. A bad scan must never take the
  // daemon down — the next tick retries. A no-op when ingestion is disabled.
  const ingestCostOnce = async (): Promise<void> => {
    if (costLedgerStore === null) {
      return;
    }
    try {
      await ingestCostCorpus({
        store: costLedgerStore,
        projectRoots: config.projectRoots,
        fileSystem: costCorpusFileSystem,
        // clock.now() returns an ISO string; stamped only onto the watermark.
        nowIso: () => clock.now(),
      });
    } catch (error) {
      // A failed ingest pass is non-fatal — the next tick retries, so the daemon
      // must not die here. There is no event for a missed pass, which makes
      // stderr the only place the operator would ever learn of it; journald
      // (vimes.service) captures it. Message only, never the stack or the paths.
      console.warn(
        'vimes-daemon: cost ingest failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
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
  // B1 — the usage poller is now a SELF-RESCHEDULING setTimeout (not a fixed
  // setInterval): each poll's outcome decides how long the next one waits, via
  // the pure `nextUsageBackoff` reducer below. `ReturnType<typeof setTimeout>`
  // replaces the old `setInterval` handle type accordingly.
  let usagePollTimer: ReturnType<typeof setTimeout> | null = null;
  let costIngestTimer: ReturnType<typeof setInterval> | null = null;
  let taskWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // B1 — backoff state for the usage poller, folded across polls exactly like
  // `lastForcedPollAtMs` above: mutable daemon-boundary state feeding a pure
  // core reducer (rule 0.3). Starts at zero consecutive failures; the config's
  // three ⟨tune⟩ values are read once here rather than per-poll since none of
  // them can change without a daemon restart.
  let usageBackoffState: UsageBackoffState = initialUsageBackoffState;
  const usageBackoffConfig: UsageBackoffConfig = {
    baseIntervalMs: config.usagePollIntervalMs,
    maxIntervalMs: config.usageBackoffMaxIntervalMs,
    multiplier: config.usageBackoffMultiplier,
  };
  // The reschedule-after-stop guard (NEW hazard introduced by moving off
  // setInterval — see the wiring below). `setInterval` only ever needed
  // clearing once; a SELF-rescheduling `setTimeout` can resurrect itself if a
  // poll is in flight when `stop()` runs, because the callback that was
  // awaiting the poll reaches its `setTimeout(...)` call AFTER `stop()` has
  // already cleared the handle it knew about. Set `true` at the very top of
  // `stop()`, checked here before ever scheduling another timeout.
  let usagePollStopped = false;

  // One poll cycle THEN one reschedule (B1) — the self-rescheduling
  // replacement for the old `setInterval(pollUsageOnce, usagePollIntervalMs)`.
  // `runUsagePoll` / `pollUsageOnce` themselves are UNCHANGED (the existing
  // meterAlerts tests call `pollUsageOnce()` directly and must stay green);
  // this only wraps the call and decides the NEXT delay.
  //
  // Any thrown error is treated as a failed poll — same "never fatal, next
  // cycle retries" contract every other timer callback in this file already
  // has — so the reschedule loop itself can never die.
  const runPollAndReschedule = async (): Promise<void> => {
    let succeeded: boolean;
    try {
      const probeResult = await runUsagePoll();
      succeeded = probeResult.ok;
    } catch {
      succeeded = false;
    }
    // The reschedule-after-stop guard: a poll that was already in flight when
    // stop() ran must not resurrect the timer. Checked AFTER the poll (which
    // may legitimately still be finishing after shutdown began) and BEFORE
    // scheduling anything — the one place a `setInterval` never needed a
    // check like this, because it was cleared once and never re-armed itself.
    if (usagePollStopped) {
      return;
    }
    const { delayMs, state } = nextUsageBackoff(usageBackoffState, succeeded, usageBackoffConfig);
    usageBackoffState = state;
    usagePollTimer = setTimeout(() => {
      void runPollAndReschedule().catch(() => {
        // Same belt-and-braces as the initial boot-poll call below.
      });
    }, delayMs);
    usagePollTimer.unref();
  };

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
    ingestCostOnce,
    derivedUsage: currentDerivedUsage,
    costLedger: currentCostLedgerBody,
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
      // The I/O half of the D73 check, shared by both channels so neither can
      // drift into its own dialect of "older" or its own boot wording.
      const emitAndReportCliVersion = (channelInput: {
        channel: 'pty' | 'sdk';
        observedVersion: string | null;
        floorVersion: string | undefined;
        lastVerifiedVersion: string | undefined;
        binaryPath?: string | null;
      }): void => {
        const versionReport = reportCliVersionCheck(channelInput);
        // ⚠ `expected` NOW CARRIES THE FLOOR (or null when no floor is pinned) —
        // the core event schema is UNCHANGED, so the field name still says
        // "expected" while the fact behind it is D73's floor. Recorded here rather
        // than renamed there because renaming a payload field rewrites the meaning
        // of every `runtime_drift_observed` already in the log.
        //
        // Emitted whenever the observation differs from the last-verified marker,
        // whenever the probe answered nothing, and whenever the floor check warns —
        // deliberately WIDER than the warning, because D73 says that payload is
        // evidence, not decoration, and the evidence stream must stay at least as
        // rich as the equality check's was.
        const observationDiffersFromEvidence =
          channelInput.observedVersion !== (channelInput.lastVerifiedVersion ?? null);
        if (
          observationDiffersFromEvidence ||
          channelInput.observedVersion === null ||
          versionReport.warning !== null
        ) {
          router.emit([
            runtimeDriftObserved({
              expected: channelInput.floorVersion ?? null,
              observed: channelInput.observedVersion,
              channel: channelInput.channel,
              ...(channelInput.binaryPath === undefined ? {} : { binaryPath: channelInput.binaryPath }),
            }),
          ]);
        }
        if (versionReport.warning !== null) {
          // E4 drift is warn-only, never fatal: the event above is the durable
          // record, and this stderr line is the half a human actually sees. The
          // deploy procedure greps the boot output in journald for `CLI runtime
          // drift`, which every warning carries, so it is written unconditionally
          // rather than behind a level.
          console.warn(versionReport.warning);
        }
        // The report half, owed in EVERY state including the unknown one. SEPARATE
        // from the `vimes-daemon listening on …` line in main.ts, which the deploy
        // procedure also greps and which nothing here touches.
        process.stdout.write(`${versionReport.infoLine}\n`);
      };
      // Runtime version check (E4), warn-only, never gates. Two INDEPENDENT
      // channels, each against its own pin — the PATH `claude` (PTY escape hatch)
      // and the binary the Agent SDK vendors and runs for SDK sessions (the D4
      // default). Their versions legitimately differ, so one pin is never
      // asserted against the other channel. Each check runs only when its probe
      // is injected (main.ts in prod) — integration tests never invoke a CLI.
      //
      // ⚠ **D73 (S16·U1) REPLACED EXACT EQUALITY WITH A FLOOR + A LAST-VERIFIED
      // MARKER.** Every WORD of both the warning and the info line is decided by
      // `reportCliVersionCheck` in versionCompare.ts — a pure function with unit
      // tests over each state (rule 0.3). This block is the I/O half only: probe,
      // ask, emit, write. No comparison happens here, on purpose; a second place
      // that decides what "older" means is a second authority.
      if (deps.cliVersionProbe !== undefined) {
        emitAndReportCliVersion({
          channel: 'pty',
          observedVersion: await deps.cliVersionProbe(),
          floorVersion: config.cliVersionFloor,
          lastVerifiedVersion: config.cliVersionLastVerified,
        });
      }
      if (deps.sdkCliVersionProbe !== undefined) {
        const sdkObservation = await deps.sdkCliVersionProbe();
        emitAndReportCliVersion({
          channel: 'sdk',
          observedVersion: sdkObservation.version,
          floorVersion: config.sdkCliVersionFloor,
          lastVerifiedVersion: config.sdkCliVersionLastVerified,
          // Named on every SDK line: an SDK-channel surprise is usually the
          // vendored CLI moving under us rather than a deliberate pin change.
          binaryPath: sdkObservation.binaryPath,
        });
      }
      // host_started + boot recovery: any session the log left running/spawning
      // with no live process becomes interrupted (§3.10, D13).
      sessionHost.start();
      // Push pipeline: subscribe to every session stream now in the log (survives
      // restart; a later resume→gate on one of them will push). New sessions
      // register via the host's onSessionCreated callback.
      pushPipeline.start();
      // Compaction steward (S8·4): subscribe to every ORCHESTRATOR stream already
      // in the log, so a restart resumes nudging the standing entity it left
      // running. Its escalation memory is re-derived from the log, so a boot can
      // neither re-send a level nor forget one.
      compactionSteward.start();
      // ─── S17·U2 — the orphan scan (slice-17.md §3.7) ───────────────────────
      //
      // §3.7's recovery contract is DISCOVERY, NOT ADOPTION: a checkout under
      // `worktreeRoot` that no node's provenance claims is what process death
      // mid-sequence leaves behind, and v1's honest answer is to SAY SO once, at
      // boot, and let a human decide. Nothing here removes anything, adopts
      // anything or writes an event — a boot diagnostic that mutates the disk
      // would be a reaper, and the reaper is a decision nobody has made.
      //
      // Fire-and-forget and never awaited: it runs `git worktree list` once per
      // live project, and a boot must not wait on (or die from) a repository
      // that has moved. Every failure is already a warn inside `listOrphans`;
      // the catch here is the belt to that braces.
      void checkoutCoordinator
        .listOrphans()
        .then((orphans) => {
          for (const orphan of orphans) {
            console.warn(
              `orphan checkout (claimed by no node): ${orphan.path} branch=${orphan.branch ?? '(detached)'} project=${orphan.projectId}`,
            );
          }
        })
        .catch(() => {
          // Discovery is a diagnostic. It never fails a boot.
        });
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
      // Usage-endpoint poller (slice 5 step 2; SELF-RESCHEDULING since B1). The
      // DAEMON boundary owns the timer, exactly like the reaper above (rule
      // 0.3) — the adapter and the parser stay pure/injected, and the DELAY
      // between polls is now decided by the pure `nextUsageBackoff` reducer
      // (packages/core/src/usageBackoff.ts) rather than a fixed interval. An
      // interval of 0 disables polling entirely, same as before: the first
      // cycle is never fired and no timer is ever created.
      if (config.usagePollIntervalMs > 0) {
        // Fire the first cycle immediately (fire-and-forget, never awaited) so
        // meters populate promptly after boot instead of sitting at unknown for
        // a full interval — this IS the boot poll (it replaces the old
        // immediate `pollUsageOnce()` call) and it also performs the first
        // reschedule, so there is no separate interval-creation step below.
        void runPollAndReschedule().catch(() => {
          // Belt-and-braces: runPollAndReschedule already swallows every poll
          // failure into the backoff reducer and never rejects, but an
          // unexpected throw here must never become an unhandled rejection.
        });
      }
      // Cost-ledger ingester (slice 5b). The DAEMON boundary owns the periodic
      // timer, exactly like the poller above (rule 0.3) — the scan and the store
      // stay pure/injected. An interval of 0 disables ingestion entirely: no
      // store was opened and the timer is never created. unref'd so it never
      // keeps the process alive, and cleared on stop() so no handle leaks.
      if (config.costIngestIntervalMs > 0) {
        // Fire one scan immediately (fire-and-forget, NEVER awaited): the first
        // full scan is ~320 MB and must not block boot. Never fatal — a failed
        // scan is swallowed inside ingestCostOnce and the interval retries.
        void ingestCostOnce().catch(() => {
          // Belt-and-braces: ingestCostOnce never rejects, but an unexpected
          // throw must never become an unhandled rejection.
        });
        costIngestTimer = setInterval(() => {
          void ingestCostOnce().catch(() => {
            // See above: never fatal, the next tick retries.
          });
        }, config.costIngestIntervalMs);
        costIngestTimer.unref();
      }
      // Stage-run watchdog (slice 6 step 5b) — SLICE 6'S FIRST TIMER. The DAEMON
      // boundary owns the periodic wake, exactly like the reaper, the poller and
      // the ingester above (rule 0.3): the decision and the runner stay
      // clock-injected and timer-free, so every test drives `checkOnce()` by
      // hand. An interval of 0 DISABLES the watchdog entirely: the timer is
      // never created. unref'd so it never keeps the process alive, and cleared
      // on stop() so no handle leaks.
      //
      // ⚠ The interval is a SAMPLING CADENCE, NOT A THRESHOLD. It bounds
      // detection LATENCY — a wedged run is noticed at most one interval after
      // it crosses the band — and never correctness, because staleness is
      // measured from event timestamps rather than from how often we look.
      // Changing it can make a report arrive sooner or later; it can never make
      // a healthy run stale. NO IMMEDIATE FIRST CHECK, deliberately: unlike the
      // poller (which fills empty meters) and the ingester (which warms a
      // ledger), this one WRITES ATTENTION AND PUSHES NOTIFICATIONS, and the
      // moment right after a restart is when the projections are freshest but
      // the runs are least settled. One interval of patience costs nothing.
      if (config.watchdogCheckIntervalMs > 0) {
        taskWatchdogTimer = setInterval(() => {
          try {
            taskWatchdog.checkOnce();
          } catch {
            // A transient check failure is non-fatal: the next tick retries. The
            // runner is total and should never throw, but a watchdog that dies
            // on one bad record is a watchdog that has silently stopped watching.
          }
        }, config.watchdogCheckIntervalMs);
        taskWatchdogTimer.unref();
      }
    },

    async stop(): Promise<void> {
      // B1 — set FIRST, before anything is cleared: this is the reschedule-
      // after-stop guard. A poll already in flight when stop() is called will
      // still finish and reach `runPollAndReschedule`'s check AFTER this flag
      // is set, so it returns instead of arming a new `setTimeout` — the
      // clearTimeout below only protects an ALREADY-scheduled timer, not a
      // poll that hasn't reached its reschedule point yet.
      usagePollStopped = true;
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      if (terminalReapTimer !== null) {
        clearInterval(terminalReapTimer);
        terminalReapTimer = null;
      }
      if (usagePollTimer !== null) {
        // clearTimeout, not clearInterval — the poller became a self-
        // rescheduling setTimeout in B1 (see runPollAndReschedule above).
        clearTimeout(usagePollTimer);
        usagePollTimer = null;
      }
      // Clear the ingest timer BEFORE the store is disposed below, so no in-flight
      // interval callback can touch a closed store.
      if (costIngestTimer !== null) {
        clearInterval(costIngestTimer);
        costIngestTimer = null;
      }
      // Same reason, same place: the watchdog reads both projections and writes
      // through the router, so its timer must be dead before the db closes.
      if (taskWatchdogTimer !== null) {
        clearInterval(taskWatchdogTimer);
        taskWatchdogTimer = null;
      }
      // host_stopped + kill children (they die with the daemon, §3.10) and stop
      // watching transcripts BEFORE the final snapshot, so the log/watchers are
      // quiescent when the db closes. The hook ingress closes first so no late
      // POST can emit after shutdown begins.
      await hookIngress.stop();
      pushPipeline.stop();
      compactionSteward.stop();
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
      // Close the cost ledger in the same shutdown phase the other stores close.
      // Null when ingestion is disabled (no store was ever opened). stop() is
      // idempotent: dispose() on an already-closed better-sqlite3 handle is a
      // no-op, and a second stop() sees costIngestTimer already null.
      costLedgerStore?.dispose();
    },
  };
}
