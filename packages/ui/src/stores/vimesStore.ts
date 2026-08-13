import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { parseServerEnvelope, serializeClientEnvelope, type ClientEnvelope, type ServerEnvelope } from '../lib/envelope.js';
import { advanceOffset, deframeTerminalOutput, frameTerminalInputText } from '../lib/terminalFraming.js';
import { parseRootsPayload } from '../lib/treeNode.js';
import type { TerminalListItem } from '../lib/terminalList.js';
import type { CacheObservabilityRecord } from '../lib/cacheBadge.js';
import type { DerivedUsageBody, UsageRefreshOutcome, UsageSnapshot } from '../lib/meterDisplay.js';
import type { CostLedgerBody } from '../lib/costDisplay.js';
import {
  nodeEdgesFromDeclaration,
  readWorkflowRefs,
  workflowRefKey,
  type TaskApiAnswer,
} from '../lib/taskBoard.js';
import type { ProjectView } from '../lib/projectContext.js';
import type { WorkOrderBody, WorkOrderFieldDescriptor } from '../lib/workOrderForm.js';
import type { AmendmentBody } from '../lib/correctionDoors.js';
import { sessionToSubscribeAfterDispatch, sessionToSubscribeAfterTransition } from '../lib/dispatchFollow.js';
import { sessionToOpenAfterEnsure } from '../lib/orchestratorEntry.js';
import type { GitStatus, GitFileDiff, GitRepoEntry, GitDiffContext } from '../lib/gitReview.js';
import type { EventRecord, SessionRecord } from '../lib/types.js';
import { derivePushState, type PushUiState } from '../lib/pushState.js';
import { decideReconnectAction, shouldProbeHealth, type HealthProbeOutcome } from '../lib/reconnectDecision.js';
import type { SearchFlags } from '../lib/envelope.js';
import type { SearchResultLine } from '../lib/searchGroup.js';
import {
  isGateResponseRefusal,
  resolveRefusedPending,
  resolveSpawnedPending,
  shouldSearchRefusalError,
  type SpawnPendingState,
} from '../lib/refusalRecovery.js';
import { daemonApiVersionMismatch, daemonSupportsCapability } from '../lib/apiFloor.js';
import { SESSIONS_AFFECTING_TYPES, TREE_AFFECTING_TYPES } from '../lib/sessionTreeRefresh.js';
// D87: payload-contract types come from the engine that serves them, type-only.
// `TreeResponse` is rendered verbatim by TreeView (U8) — the store holds it, it
// does not reshape it.
import type { TreeResponse } from '@vimes/core';

// The single shared WS connection (private-docs/slice-1.md step-3 scope): one socket
// multiplexes every subscribed stream; per-stream lastSeq is tracked so a
// reconnect resubscribes everything from where it left off (the I2 client
// behavior), with exponential backoff 1s..10s.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
const SESSIONS_REFRESH_THROTTLE_MS = 1000;

// The task board's live channel (slice 6 step 9). Every task fact is written to
// this ONE stream, so the board subscribes to it by name exactly as a session
// view subscribes to a session's stream — there is no polling loop.
//
// ⚠ THE TRIGGER IS THE STREAM, NOT A LIST OF EVENT TYPES, and that is deliberate.
// `SESSIONS_AFFECTING_TYPES` below has to enumerate types because session facts
// are spread across many streams; task facts are not. Projections are
// STREAM-LOCAL (architecture.md), so "an event arrived on 'tasks'" is exactly
// the condition under which the tasks projection can have moved — and a task
// event type added to core later cannot silently stop refreshing the board the
// way an out-of-date type list would.
const TASKS_STREAM = 'tasks';

// The wsHub upgrade handler (packages/daemon/src/app.ts) does not filter by
// path at all — confirmed by packages/daemon/src/wsHub.test.ts connecting to
// a bare `ws://host:port` with no path. `/ws` is used here for clarity only;
// any path would work identically against the current daemon.
const WS_PATH = '/ws';

// S15·U2 — the tree read model rides the SAME 1s throttle POLICY the sessions
// refresh has always used ("an event moved a read model, refetch it, at most
// once a second"), but keeps its OWN window: a tree refetch must not reset the
// sessions window or vice versa, or one read model's traffic would silently
// starve the other's. Deliberately spelled as a reference to the sessions
// constant rather than a second `1000` — one policy, one number, two windows.
const TREE_REFRESH_THROTTLE_MS = SESSIONS_REFRESH_THROTTLE_MS;

interface StreamState {
  lastSeq: number;
  events: EventRecord[];
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export const useVimesStore = defineStore('vimes', () => {
  const sessions = ref<Record<string, SessionRecord>>({});
  // The daemon's live allowlist (config.projectRoots ∪ live-session cwds), fetched
  // from GET /api/files/roots. Null until the first fetch lands — views prefer
  // this over deriveRoots(sessions) once populated (see treeNode.ts effectiveRoots).
  const roots = ref<string[] | null>(null);
  // ── the project registry (S8·2) — D42's declared boundaries, as served ──────
  // The decorated list from GET /api/projects (archived records included — the
  // flag is on the record and clients filter, per the route's own contract), the
  // configured roots the picker composes a declare-prefill from, and whether we
  // have looked at all.
  const projects = ref<ProjectView[]>([]);
  const rootsBases = ref<string[]>([]);
  const projectsLoaded = ref(false);
  // The last registry read FAILED (transport, a non-2xx, or a body that is not a
  // registry). Distinct from "not loaded yet" so the picker can say which.
  const projectsUnreachable = ref(false);
  // ── the session tree (S15·U2) — GET /api/tree, held VERBATIM ───────────────
  //
  // The whole forest, as `treeOf` composed it: declared root order, declared
  // sibling order, precomputed severities, rollups, estate-scoped short ids.
  // Nothing here reshapes it and nothing here sorts it (U8) — the client's only
  // contribution is which containers are expanded, which is view state and never
  // leaves the view.
  //
  // THREE STATES, DELIBERATELY DISTINCT (the fetchProjects idiom, doctrine §5):
  //   • `tree` null + `treeLoaded` false → we have not successfully looked yet;
  //   • `tree` non-null + `treeError` true → LAST-KNOWN data plus a staleness
  //     signal, which is what a failing refresh must look like — never a
  //     spinner over an erased readout, never a fabricated empty forest;
  //   • `tree` non-null + `treeError` false → the forest, as of the last fetch.
  const tree = ref<TreeResponse | null>(null);
  // True once ONE fetch has succeeded. Never goes back to false: "we have seen
  // the estate" is a fact about this tab's history, not about the last request.
  const treeLoaded = ref(false);
  // The last tree fetch FAILED (transport, a non-2xx, or a 200 whose body is not
  // a forest). Boolean rather than an error object on purpose — mirrors
  // `projectsUnreachable`, and the view's honest sentence does not vary by cause.
  const treeError = ref(false);
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const catchingUp = ref(false);
  const lastRefusal = ref<{ refusedOp: string; reason: string } | null>(null);

  // ── D84 (S14 U1): the API-version handshake ───────────────────────────────
  // Reset to the "unknown yet" state at the top of every connect() 'open'
  // handler, so each connection is judged on its OWN hello (or lack of one) —
  // never on a previous connection's daemon, which a restart may have replaced.
  const daemonApiVersion = ref<number | null>(null);
  const daemonCapabilities = ref<readonly string[]>([]);
  // Proof-of-life for the CURRENT connection: at least one `subscribed` ack has
  // been received on it. Absence of hello is ambiguous while this is false (the
  // hello frame may simply not have arrived yet); once true, a still-null
  // daemonApiVersion is conclusive — an anchor-frame daemon that predates the
  // hello op entirely, exactly the stale-daemon condition D84 exists for.
  const daemonRespondedThisConnection = ref(false);

  const apiVersionMismatch = computed(() =>
    daemonApiVersionMismatch(daemonApiVersion.value, daemonRespondedThisConnection.value),
  );

  function daemonSupports(capability: string): boolean {
    return daemonSupportsCapability(daemonApiVersion.value, daemonCapabilities.value, capability);
  }

  // requestIds the client has sent a gate_response for but not yet seen
  // cleared — lets the gate card disable its buttons immediately.
  const answeringRequestIds = reactive(new Set<string>());

  const streamsByAppSessionId = reactive<Record<string, StreamState>>({});
  // Push notification bell state (spec §3.8). 'off' until refreshPushState() reads
  // the real browser capability + permission + subscription.
  const pushState = ref<PushUiState>('off');

  // ── Search (slice 3 step 2) — streamed over the same WS ──────────────────
  // One search in flight at a time (the panel starts a new one on submit). The
  // activeSearchId gates late frames from a superseded/cancelled search.
  type SearchStatus = 'idle' | 'running' | 'done' | 'error';
  const searchStatus = ref<SearchStatus>('idle');
  const searchResults = ref<SearchResultLine[]>([]);
  const searchStats = ref<{ matched: number; files: number; elapsedMs: number } | null>(null);
  const searchErrorReason = ref<string | null>(null);
  let activeSearchId: string | null = null;
  let searchCounter = 0;

  // ── Raw terminal (slice 3 step 3) — ONE active terminal (the escape hatch) ──
  // The daemon supports many terminals per connection; the mobile page drives a
  // single one. Byte payloads ride BINARY WS frames, tagged per terminalFraming.ts.
  type TerminalStatus = 'idle' | 'opening' | 'live' | 'exited' | 'error';
  const terminalStatus = ref<TerminalStatus>('idle');
  const terminalExitCode = ref<number | null>(null);
  // The live terminals list (GET /api/terminals) shown on the terminal landing —
  // the visibility that makes persistent shells safe (terminal-lifecycle item).
  // Fetched on the view's mount; terminalId is in-memory on the daemon, so this
  // is how a fresh page load rediscovers shells left running to re-enter.
  const terminals = ref<TerminalListItem[]>([]);
  // ── Cache observability (slice 4 step 4) — badges joining the step-2 pure
  // projection (GET /api/projections/cache-observability) to the session list/
  // stream by appSessionId. Plain REST-into-ref, mirroring fetchTerminals:
  // fetch, credentials same-origin, tolerant of transient failure. Refreshed
  // wherever refreshSessions() already runs (session-list mount, WS reconnect,
  // a session-affecting event, discover) — no separate polling loop.
  const cacheObservability = ref<Record<string, CacheObservabilityRecord>>({});
  // ── Usage meters (slice 5 step 3 → step 4c) — the home-screen "can I afford
  // to start this?" strip. It now reads the DERIVED read model
  // (GET /api/usage/derived) rather than the raw projection, because every
  // field the strip needs beyond the record itself — freshness, age, burn rate,
  // projected exhaustion, and above all the STALENESS BAND — is a function of
  // *now* and is owned by the daemon (rule 0.3; the 2026-07-21 freshness
  // finding). Same plain REST-into-ref shape as cacheObservability, refreshed on
  // the existing refreshSessions() cadence — no new polling loop.
  //
  // The snapshot pairs the body with the LOCAL clock reading at the moment it
  // landed. That pairing is what lets the strip age a reading against the
  // DAEMON's clock while ticking on the browser's: only the local *delta* is
  // ever used, so client clock skew cannot make a stale reading look fresh.
  // A null snapshot means we have observed NOTHING, which the strip renders as
  // "usage unknown", never as zeros (pillar 4).
  const usageSnapshot = ref<UsageSnapshot | null>(null);
  // True while a forced refresh is in flight — the control disables itself so an
  // impatient thumb cannot stack requests against an unofficial endpoint.
  const usageRefreshInFlight = ref(false);
  // The last forced refresh's envelope, or null if none has run this session.
  // Rendered verbatim-ish by refreshNotice(): a throttled or failed refresh is
  // NEVER presented as a successful one.
  const lastUsageRefresh = ref<UsageRefreshOutcome | null>(null);
  // ── Cost ledger (slice 5b step 4b) — the "what did VIMES-hosted work cost"
  // surface (GET /api/cost/ledger). Plain REST-into-ref, same-origin, tolerant of
  // transient failure, mirroring fetchTerminals. Fetched on the cost view's open
  // plus a manual refresh button — NOT on the sessions cadence, because the tree
  // is expensive to rebuild server-side and nobody is staring at it continuously
  // (unlike the usage strip). Null until the first fetch lands: the view renders
  // "loading", never a fabricated $0 tree (pillar 4).
  const costLedger = ref<CostLedgerBody | null>(null);
  // True while a cost-ledger fetch is in flight, so the refresh control can
  // disable itself and the view can show a spinner instead of a stale-vs-fresh
  // ambiguity.
  const costLedgerLoading = ref(false);
  // ── Task board (slice 6 step 9) — the instances projection, read over the
  // SAME endpoint everything else reads (GET /api/projections/instances). There
  // is deliberately no `GET /api/instances`: 4b omitted the list route on
  // purpose (principle 9, one source of record per fact) and that decision
  // stands — instanceApi.ts still says so in its own footer.
  //
  // Held as the RAW body rather than a parsed shape, because every derivation
  // lives in lib/taskBoard.ts and that module is TOTAL over hostile input (I8).
  // Parsing here would put a second, weaker validator in front of it.
  const tasksProjectionBody = ref<unknown>(null);
  // True only while the FIRST fetch is outstanding, so the view can tell "we
  // have not looked yet" from "we looked and the board is empty". An empty board
  // is a fact; a blank screen that means "still loading" is not.
  const tasksLoading = ref(false);
  // ── q25 declaration introspection (S13·U2/U2b, consumed here in S13·U3) ────
  //
  // The RAW declaration body for the workflow this board renders, fetched from
  // GET /api/workflows/:e/:w/:r/declaration. Null until the first fetch lands.
  // Raw for the same reason `tasksProjectionBody` is raw: the derivation
  // (`nodeEdgesFromDeclaration`) is total over hostile input and lives in lib/.
  //
  // ⚠ ONE DECLARATION, NOT A PER-REF MAP, AND THAT IS TODAY'S TRUTH RATHER THAN
  // A SIMPLIFICATION: `GET /api/workflows` lists exactly one ref (the daemon's
  // boot-resolved declaration — see instanceApi.ts's index route). The day it
  // lists more, the board must pick the declaration by each instance's OWN
  // pinned `workflow` ref rather than holding a single one — that is D76's
  // unknown-workflow rendering, its own unit, and this is where it lands.
  const workflowDeclaration = ref<unknown>(null);
  // The legal-edge table the move sheet filters against, DERIVED from the
  // declaration rather than served pre-narrowed. Null until a declaration lands
  // — `moveOptionsFor` treats null as "not loaded yet" and offers nothing (a
  // safe empty, never all-stages). See `nodeEdgesFromDeclaration` for the
  // nine-stage restriction and why it is load-bearing.
  const stageEdges = computed<Record<string, string[]> | null>(() =>
    nodeEdgesFromDeclaration(workflowDeclaration.value),
  );
  // S7·3: the work-order authoring descriptor, fetched from
  // GET /api/workflows/:e/:w/:r/payload-schema. Null until the first fetch lands
  // — the create sheet renders nothing until then (never a hard-coded field
  // list). This is the SERVED shape of the daemon's
  // WORK_ORDER_FIELD_DESCRIPTORS; the value is never re-derived here (the UI
  // cannot import the zod that defines it).
  const workOrderSchema = ref<WorkOrderFieldDescriptor[] | null>(null);
  // The refs whose per-ref responses we have already fetched, keyed by
  // `workflowRefKey`. **THIS IS THE DEDUPE (F3 ⟨signed⟩ rider 2): one fetch per
  // REF, never one per instance.** It is deliberately NOT a cache of the
  // responses — the per-ref responses are served `immutable`, so the BROWSER
  // cache is the persistence layer and building a second one here would be a
  // second authority on freshness for bytes that can never go stale.
  const fetchedWorkflowRefKeys = new Set<string>();
  // ── Git review (slice 4 step 3) — the primary-human-job surface (spec §3.4) ──
  // Plain REST-into-ref, mirroring fetchTerminals: fetch, credentials
  // same-origin, tolerant of transient failure. The daemon's /api/git/* endpoints
  // are behind the Access wall and root-scoped (every path re-resolved against the
  // allowlist server-side). gitStatus holds the last-fetched repo status;
  // gitDiffFiles the last-fetched file diff; gitError a local refusal channel the
  // panel surfaces inline (a clean 4xx { error } from the daemon).
  const gitStatus = ref<{ repoRoot: string; status: GitStatus } | null>(null);
  const gitDiffFiles = ref<GitFileDiff[]>([]);
  const gitError = ref<string | null>(null);
  // The repos DISCOVERED beneath the allowlist (GET /api/git/repos). The
  // configured project root is a container of repos, not a repo — the panel
  // picks from these, not from the roots (2026-07-21 gate finding).
  const gitRepos = ref<GitRepoEntry[]>([]);
  // The last repo root the panel actually loaded, remembered across mounts so a
  // return visit lands where the reviewer left off.
  const lastGitRoot = ref<string>('');
  // The diff the reviewer left behind when tapping Edit (repo root, the REPO-
  // RELATIVE file path, and which side of the worktree/staged toggle was on
  // screen). It lives HERE, not in GitPanel, because the panel unmounts for the
  // editor visit — same reason lastGitRoot lives here. GitPanel consumes it on
  // mount (restore the diff + re-fetch) and clears it; see decideDiffRestore.
  const pendingGitDiffContext = ref<GitDiffContext | null>(null);

  let terminalId: string | null = null;
  let terminalTag: number | null = null;
  let terminalOffset = 0; // bytes consumed — mirrors the daemon's totalBytesSeen (I9)
  let terminalCwd: string | null = null;
  // The view registers sinks so raw bytes stream straight into xterm without a
  // reactive buffer (bytes are never stored in the projection — rule 0.8).
  let terminalOutputSink: ((bytes: Uint8Array) => void) | null = null;
  let terminalLostSink: (() => void) | null = null;
  let terminalExitSink: ((exitCode: number) => void) | null = null;

  let socket: WebSocket | null = null;
  let backoffMs = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manuallyClosed = false;
  let everConnected = false;
  // Consecutive WS connection failures — after RECONNECT_PROBE_THRESHOLD we probe
  // /api/health to tell an Access re-auth bounce from plain network trouble.
  let consecutiveWsFailures = 0;
  const subscribedStreams = new Set<string>();
  const pendingResubscribeAcks = new Set<string>();
  // The single in-flight spawn (see spawnSession / refusalRecovery.ts for the
  // one-spawn-at-a-time simplification and why both terminal envelopes must
  // resolve it).
  let pendingSpawn: SpawnPendingState = null;

  let sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSessionsRefreshAt = 0;
  // The tree's own throttle window — same policy, separate state (see
  // TREE_REFRESH_THROTTLE_MS).
  let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTreeRefreshAt = 0;

  function wsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${WS_PATH}`;
  }

  async function refreshSessions(): Promise<void> {
    lastSessionsRefreshAt = Date.now();
    try {
      const response = await fetch('/api/projections/sessions', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      // The endpoint returns the projection's serialized canonical JSON —
      // ordinary JSON text, parsed like any REST body.
      const text = await response.text();
      const parsed = JSON.parse(text) as { sessions?: Record<string, SessionRecord> };
      sessions.value = parsed.sessions ?? {};
    } catch {
      // Transient network hiccup — the next scheduled refresh (or an event on
      // a subscribed stream) retries; the log is the truth, not this cache.
    }
    // Piggyback the cache-observability badges on every sessions refresh
    // (mount, WS reconnect, a session-affecting event, discover) rather than
    // running a separate polling loop — same cadence as the sessions list.
    void fetchCacheObservability();
    // Same reasoning for the usage meters (slice 5 step 3): they ride the
    // sessions refresh cadence rather than owning a polling loop of their own.
    void fetchDerivedUsage();
  }

  // ── the session tree (S15·U2) ─────────────────────────────────────────────
  //
  // GET /api/tree, NO PARAMETERS. The route accepts `?root=` (S14-A10), and this
  // client deliberately never sends it: the client holds the WHOLE forest and
  // scoping is expand/collapse state in the view. A server round-trip per scope
  // change would make the same fact (which branch am I looking at) exist in two
  // places — the URL and the component — and the day they disagree is the day a
  // collapsed branch hides a live gate.
  //
  // ⚠ **A FAILED FETCH KEEPS THE LAST-KNOWN PAYLOAD** (doctrine §5, A9). The
  // ONLY thing a failure changes is `treeError`; `tree` itself is never cleared,
  // because a stale estate rendered with a staleness notice is strictly more
  // useful than an empty screen that claims the estate is gone. `treeLoaded`
  // likewise never regresses.
  async function refreshTree(): Promise<void> {
    lastTreeRefreshAt = Date.now();
    try {
      const response = await fetch('/api/tree', { credentials: 'same-origin' });
      if (!response.ok) {
        treeError.value = true;
        return;
      }
      const parsed = (await response.json()) as { roots?: unknown };
      if (!Array.isArray(parsed.roots)) {
        // A 200 whose body is not a forest is a failure to READ the forest, not
        // an empty one — the same distinction fetchProjects draws.
        treeError.value = true;
        return;
      }
      tree.value = parsed as TreeResponse;
      treeLoaded.value = true;
      treeError.value = false;
    } catch {
      // Transient network hiccup. The previous forest stays on screen with the
      // staleness treatment; the next event/reconnect/mount retries.
      treeError.value = true;
    }
  }

  // The throttled door every tree trigger goes through — a subscribed stream's
  // TREE_AFFECTING_TYPES event, a WS reconnect, and TreeView's own mount. Same
  // shape as scheduleSessionsRefresh, over the tree's own window.
  function scheduleTreeRefresh(): void {
    const elapsed = Date.now() - lastTreeRefreshAt;
    if (elapsed >= TREE_REFRESH_THROTTLE_MS) {
      void refreshTree();
      return;
    }
    if (treeRefreshTimer === null) {
      treeRefreshTimer = setTimeout(() => {
        treeRefreshTimer = null;
        void refreshTree();
      }, TREE_REFRESH_THROTTLE_MS - elapsed);
    }
  }

  // ── the tree's WRITE surface (S15·U3 — the first client of E2's three routes)
  //
  // Three POSTs, one posture: the daemon's status and body come back VERBATIM in
  // a `TaskApiAnswer` (`postJsonApi`, the same helper the task and project writes
  // use), and the store flattens NOTHING. A 409 carries the engine's own refusal
  // reason and the view renders it through `nodeWriteFailureMessage`
  // (lib/sessionTreeActions.ts) — the store must never turn a refusal into a
  // boolean, because the reason IS the information (rule 0.3, and projectApi's
  // own words at the other end of the wire).
  //
  // ⚠ **NOTHING HERE PATCHES `tree` LOCALLY (U8).** A successful write schedules
  // a REFETCH through the same throttle every other tree trigger goes through, so
  // what the operator sees after a create is the forest `treeOf` composed, not an
  // echo of the request. This is `declareProject`'s idiom (2xx → `fetchProjects`)
  // applied to the tree.
  //
  // ⚠ **WHY THE EXPLICIT REFRESH EXISTS AT ALL.** `TREE_AFFECTING_TYPES` lists
  // the three node events, and the daemon does emit them (`router.emit`), but
  // this client subscribes only to session streams and `'tasks'` — never the
  // `'nodes'` stream — so a node event reaches no browser today. Without the call
  // below, an operator would create a node and watch nothing happen. Reported as
  // a finding (S15·U3 checkpoint) rather than closed here: making node events
  // PUSH to every client is a `subscribe('nodes')` decision about the whole
  // client, not a side effect of the write surface.
  async function createNode(input: {
    projectId: string;
    parentNodeId: string | null;
    name: string;
  }): Promise<TaskApiAnswer> {
    const answer = await postJsonApi('/api/nodes', {
      projectId: input.projectId,
      // Spelled explicitly, including the null: the route reads absent as null
      // anyway, and a top-level node is an ordinary shape rather than an
      // omission.
      parentNodeId: input.parentNodeId,
      name: input.name,
    });
    if (answer.status === 201) {
      scheduleTreeRefresh();
    }
    return answer;
  }

  // POST /api/nodes/:nodeId/close. **IRREVERSIBLE — E2 has no reopen event**, so
  // the confirmation lives at the affordance (TreeView's killConfirm idiom) and
  // this function fires the moment it is called.
  //
  // The route reads NO body (`nodeApi.ts`: "Closing names no parameters"); the
  // empty object is what `postJsonApi` sends when there is nothing to say.
  async function closeNode(nodeId: string): Promise<TaskApiAnswer> {
    const answer = await postJsonApi(`/api/nodes/${encodeURIComponent(nodeId)}/close`, {});
    if (answer.status === 200) {
      scheduleTreeRefresh();
    }
    return answer;
  }

  // POST /api/nodes/:nodeId/sessions — a session joins a node. There is no
  // detach and no re-attach in v1 (a move is `node_moved` wearing another name),
  // so a session already living elsewhere comes back 409 `attached-elsewhere`
  // and the view says so.
  async function attachSessionToNode(nodeId: string, appSessionId: string): Promise<TaskApiAnswer> {
    const answer = await postJsonApi(`/api/nodes/${encodeURIComponent(nodeId)}/sessions`, {
      appSessionId,
    });
    if (answer.status === 200) {
      scheduleTreeRefresh();
    }
    return answer;
  }

  // ── the project registry (S8·2, D42/D61) ──────────────────────────────────
  //
  // GET /api/projects, held as the decorated LIST the daemon serves (each entry
  // carries its read-time `pathSegment`). Plain REST-into-ref, same-origin —
  // the fetchTerminals idiom, with ONE difference that matters: this fetch gates
  // the app's root surface, so a failure cannot be swallowed silently the way a
  // failed terminal list can.
  //
  // THREE STATES, DELIBERATELY DISTINCT (pillar 4 — an empty state is a claim):
  //   • `projectsLoaded` false, `projectsUnreachable` false → we have not looked;
  //   • `projectsUnreachable` true → we looked and could not reach the daemon,
  //     which is NOT "you have no projects";
  //   • `projectsLoaded` true → the array is the registry, empty or not.
  async function fetchProjects(): Promise<void> {
    try {
      const response = await fetch('/api/projects', { credentials: 'same-origin' });
      if (!response.ok) {
        projectsUnreachable.value = true;
        return;
      }
      const parsed = (await response.json()) as {
        projects?: unknown;
        rootsBases?: unknown;
      };
      if (!Array.isArray(parsed.projects)) {
        // A 200 whose body is not a registry is a failure to READ the registry,
        // not an empty one.
        projectsUnreachable.value = true;
        return;
      }
      projects.value = parsed.projects as ProjectView[];
      projectsLoaded.value = true;
      projectsUnreachable.value = false;
      if (Array.isArray(parsed.rootsBases)) {
        rootsBases.value = parsed.rootsBases.filter(
          (base): base is string => typeof base === 'string',
        );
      }
    } catch {
      // The previous list (if any) stays; nothing is fabricated, and the picker
      // offers a retry rather than claiming the registry is empty.
      projectsUnreachable.value = true;
    }
  }

  // POST /api/projects — declare a boundary (D42). The daemon's status and body
  // are returned VERBATIM, exactly as `postJsonApi` does for the task writes and
  // for the same reason (rule 0.3): a 403 is the D60 fence speaking, a 409 names
  // the project that already owns the directory, and the store must not flatten
  // either into a boolean.
  //
  // On a successful declaration the registry is REFETCHED rather than patched
  // locally — the record the picker renders is the one the projection folded, not
  // an echo of what was asked for.
  async function declareProject(input: {
    root: string;
    name?: string;
    description?: string;
  }): Promise<TaskApiAnswer> {
    const answer = await postJsonApi('/api/projects', {
      root: input.root,
      // Absent stays absent all the way to the birth record — a blank box must
      // not become a project named with an empty string (the route refuses `''`
      // anyway; this is the client half of the same discipline).
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    if (answer.status === 200) {
      await fetchProjects();
    }
    return answer;
  }

  // The project this tab is open on, resolved from `location.pathname` by App.vue
  // once the registry has landed (D61). Null means "no project context" — the
  // picker, or a hash view reached without one — and every scoped surface reads
  // THIS ref rather than re-deriving the project from the URL, so there is one
  // answer to "which project am I in" and one place it is set (principle 9).
  const currentProject = ref<ProjectView | null>(null);

  function setCurrentProject(project: ProjectView | null): void {
    currentProject.value = project;
  }

  // Refreshed on load and after a spawn/discover — the only ops that can widen
  // the allowlist (a newly-live session's cwd). A transient failure just leaves
  // the previous roots (or the deriveRoots fallback) in place.
  async function fetchRoots(): Promise<void> {
    try {
      const response = await fetch('/api/files/roots', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const parsed = parseRootsPayload(await response.json());
      if (parsed !== null) {
        roots.value = parsed;
      }
    } catch {
      // Transient network hiccup — effectiveRoots() falls back to
      // deriveRoots(sessions) until a later fetch succeeds.
    }
  }

  // Fetch the live terminals list (byte-free). Called on the terminal view's
  // mount and after actions that change the set (enter/kill/resilient). A
  // transient failure leaves the previous list in place.
  async function fetchTerminals(): Promise<void> {
    try {
      const response = await fetch('/api/terminals', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const parsed = (await response.json()) as { terminals?: TerminalListItem[] };
      terminals.value = Array.isArray(parsed.terminals) ? parsed.terminals : [];
    } catch {
      // Transient network hiccup — the next fetch (view remount) retries.
    }
  }

  // Fetch the cache-observability projection (byte-free — token counts and a
  // TTL classification, never PTY/message bytes). Called wherever
  // refreshSessions() already runs, plus explicitly on the session list's
  // mount (see SessionListView.vue) so the badges are populated before the
  // first session-affecting event. A transient failure leaves the previous
  // map in place.
  async function fetchCacheObservability(): Promise<void> {
    try {
      const response = await fetch('/api/projections/cache-observability', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const parsed = (await response.json()) as { perSession?: Record<string, CacheObservabilityRecord> };
      cacheObservability.value = parsed.perSession ?? {};
    } catch {
      // Transient network hiccup — the next refreshSessions() retries.
    }
  }

  // GET /api/usage/derived — the derived usage read model (slice 5 step 4b).
  // Mirrors fetchCacheObservability exactly: plain same-origin REST into a ref,
  // tolerant of transient failure, no polling loop of its own. A failure leaves
  // the previous SNAPSHOT in place ON PURPOSE — its ages keep counting up from
  // the last real observation, so the strip degrades to stale by itself and
  // says so. Freshness is never faked by the fetch layer, and the arrival of a
  // response is never mistaken for the freshness of the reading inside it.
  async function fetchDerivedUsage(): Promise<void> {
    try {
      const response = await fetch('/api/usage/derived', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as DerivedUsageBody;
      usageSnapshot.value = { body, receivedAtLocalMs: Date.now() };
    } catch {
      // Transient network hiccup — the next refreshSessions() retries.
    }
  }

  // POST /api/usage/refresh — force a REAL poll (slice 5 step 4b/4c). The route
  // always answers 200 and always carries a complete derived body plus a
  // `refresh` envelope saying what actually happened; a throttled refresh is not
  // an error, it just did not poll.
  //
  // The body is adopted in every 200 case, INCLUDING throttled and failed ones:
  // it is the honest current read model (with the meters' real, grown ages), and
  // adopting it is what keeps a failed refresh from freezing the display. What
  // is never adopted is the CLAIM of a refresh — that lives in
  // `lastUsageRefresh` and the view renders it through refreshNotice().
  async function refreshUsage(): Promise<void> {
    if (usageRefreshInFlight.value) {
      return;
    }
    usageRefreshInFlight.value = true;
    try {
      const response = await fetch('/api/usage/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        lastUsageRefresh.value = {
          polled: false,
          throttled: false,
          failureReason: 'request-failed',
          httpStatus: response.status,
          nextForcedPollAt: null,
          retryAfterMs: null,
        };
        return;
      }
      const body = (await response.json()) as DerivedUsageBody & { refresh?: UsageRefreshOutcome };
      usageSnapshot.value = { body, receivedAtLocalMs: Date.now() };
      lastUsageRefresh.value = body.refresh ?? null;
    } catch {
      // The POST itself did not land (offline, Access bounce). Say so; the
      // existing snapshot stays, and its ages keep growing.
      lastUsageRefresh.value = {
        polled: false,
        throttled: false,
        failureReason: 'request-failed',
        httpStatus: null,
        nextForcedPollAt: null,
        retryAfterMs: null,
      };
    } finally {
      usageRefreshInFlight.value = false;
    }
  }

  // GET /api/cost/ledger — the priced project → session → agent tree, spend
  // history and attribution groupings (slice 5b step 4b). Same plain same-origin
  // REST-into-ref shape as fetchDerivedUsage, but driven by the view's open + a
  // manual refresh, never a polling loop. A transient failure leaves the previous
  // body in place (or null if none has landed yet); the arrival of a body is
  // never mistaken for freshness — every dollar carries its own price-table date.
  async function fetchCostLedger(): Promise<void> {
    costLedgerLoading.value = true;
    try {
      const response = await fetch('/api/cost/ledger', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      costLedger.value = (await response.json()) as CostLedgerBody;
    } catch {
      // Transient network hiccup — the view's refresh button retries. The prior
      // body (or null) stays; nothing is fabricated.
    } finally {
      costLedgerLoading.value = false;
    }
  }

  // ── Task board (slice 6 step 9) ────────────────────────────────────────────
  //
  // GET /api/projections/instances — the SAME endpoint every other projection is
  // read through, returning the projection's serialized canonical JSON.
  // Deliberately NOT a list route: 4b omitted one on purpose (principle 9), and
  // a second reader of the same fact is exactly the drift it forbids.
  //
  // Called on the board's open, and again whenever an event lands on the 'tasks'
  // stream (see applyServerEnvelope). NO POLLING LOOP.
  async function fetchTasks(): Promise<void> {
    try {
      const response = await fetch('/api/projections/instances', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      // Parsed as plain JSON and handed on RAW: lib/taskBoard.ts is total over
      // whatever shape arrives, and validating here would only add a second,
      // weaker gate in front of it.
      tasksProjectionBody.value = JSON.parse(await response.text()) as unknown;
    } catch {
      // Transient network hiccup — the next task event (or a re-open) retries.
      // The previous body stays; nothing is fabricated.
    } finally {
      tasksLoading.value = false;
    }
  }

  // ── q25 declaration introspection (S13·U3 consumes S13·U2/U2b) ─────────────
  //
  // THREE ROUTES, IN ONE ORDER, AND THE ORDER IS THE POINT:
  //
  //   1. GET /api/workflows — the DISCOVERY half (U2b). Without it a client with
  //      zero instances holds no ref to key the other two with, and a fresh
  //      client on an EMPTY board could not render its create sheet at all —
  //      a capability regression, which §2 forbids more strongly than it
  //      forbids additions. NOT cacheable: the SET of refs is a fact about this
  //      deploy, so it is re-read on every board open (cheap, one small body).
  //   2. GET /api/workflows/:e/:w/:r/declaration — the full declared table.
  //   3. GET /api/workflows/:e/:w/:r/payload-schema — the authoring descriptor.
  //
  // ⚠ ONE FETCH PER **REF**, NEVER ONE PER INSTANCE (F3 ⟨signed⟩ rider 2).
  // `fetchedWorkflowRefKeys` is the dedupe; the per-ref responses are immutable
  // for their key and the daemon says so in a cache header, so the browser cache
  // is the persistence and NOTHING here builds a second cache layer.
  //
  // Tolerant throughout, mirroring fetchRoots: a transient failure or a
  // malformed body leaves the previous values in place (null before the first
  // success), and `moveOptionsFor` / the create sheet both treat null as "not
  // loaded yet" and render a safe empty rather than a fabricated one. A ref is
  // marked fetched only AFTER both per-ref reads succeed, so a half-failed pair
  // is retried on the next board open instead of being remembered as done.
  async function fetchWorkflowIntrospection(): Promise<void> {
    let refs: ReturnType<typeof readWorkflowRefs>;
    try {
      const response = await fetch('/api/workflows', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      refs = readWorkflowRefs(await response.json());
    } catch {
      // Transient network hiccup — the next board open retries. Nothing is
      // invalidated: whatever declaration we already hold is still true.
      return;
    }

    for (const ref of refs) {
      const key = workflowRefKey(ref);
      if (fetchedWorkflowRefKeys.has(key)) {
        continue;
      }
      const path = `/api/workflows/${encodeURIComponent(ref.extension)}/${encodeURIComponent(
        ref.workflow,
      )}/${encodeURIComponent(ref.rev)}`;
      try {
        const [declarationResponse, schemaResponse] = await Promise.all([
          fetch(`${path}/declaration`, { credentials: 'same-origin' }),
          fetch(`${path}/payload-schema`, { credentials: 'same-origin' }),
        ]);
        if (!declarationResponse.ok || !schemaResponse.ok) {
          continue;
        }
        const declaration = (await declarationResponse.json()) as unknown;
        const parsedSchema = (await schemaResponse.json()) as { fields?: unknown };
        workflowDeclaration.value = declaration;
        if (Array.isArray(parsedSchema.fields)) {
          workOrderSchema.value = parsedSchema.fields as WorkOrderFieldDescriptor[];
        }
        fetchedWorkflowRefKeys.add(key);
      } catch {
        // Same posture as above: leave what we hold, retry on the next open.
      }
    }
  }

  // THE ONE JSON POST every write in this store goes through (the three task
  // writes, and S8·2's project declaration). Plain same-origin POSTs that return
  // the daemon's STATUS AND BODY VERBATIM to the caller — they classify nothing.
  // Renamed from `postTaskApi` when the project registry became its second
  // caller: nothing about it was ever task-specific, and a task-named helper
  // posting to /api/projects would read as a mistake.
  //
  // ⚠ THAT IS THE WHOLE POINT (rule 0.3, principle 10). The daemon's answer is
  // the answer: a 409 carries the adjudicator's refusal reason — engine-owned or
  // declared by the workflow — and the log already records it (I7). The store
  // must not turn it into a boolean, and
  // must not update `tasksProjectionBody` from a response — the PROJECTION is the
  // record, and the board only moves when the projection says it moved. There is
  // no optimistic path here to accidentally take.
  async function postJsonApi(path: string, requestBody: unknown): Promise<TaskApiAnswer> {
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      let parsedBody: unknown = null;
      try {
        parsedBody = await response.json();
      } catch {
        // A body we cannot read is reported as absent; the STATUS still stands
        // and the describe* helpers render it honestly.
        parsedBody = null;
      }
      return { status: response.status, body: parsedBody };
    } catch {
      // Status 0 = "the request never reached the daemon". Deliberately not
      // dressed up as any HTTP status: nothing was proposed, and nothing was
      // written, and the board must not imply otherwise.
      return { status: 0, body: null };
    }
  }

  // S7·3 widened create with the four authored work-order fields. Each is
  // OPTIONAL and spread only when present, the same absent-omit idiom as `title` —
  // an EMPTY scope must NOT be sent as `scope: ''` (the sheet enforces this via
  // `buildWorkOrderBody`, which omits empties before they ever reach here, so an
  // unauthored create is byte-identical to the pre-S7·3 title-only POST).
  // `acceptanceCriteria` is the `{ text }[]` INPUT shape — no id, which the writer
  // mints server-side.
  function createTask(
    input: { projectRoot: string; title?: string } & WorkOrderBody,
  ): Promise<TaskApiAnswer> {
    // S13·U3: `POST /api/instances`, whose body spells the two location fields
    // `project` and `node` (the create door's own zod, instanceApi.ts's
    // `createInstanceBodySchema`). The node is deliberately NOT sent: omitting
    // it is what lets the daemon fill it from the declaration's `initial`
    // (S12·U2) rather than this client naming a starting node it does not own.
    return postJsonApi('/api/instances', {
      project: input.projectRoot,
      createdBy: 'human',
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.explicitlyOut === undefined ? {} : { explicitlyOut: input.explicitlyOut }),
      ...(input.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: input.acceptanceCriteria }),
      ...(input.killCriterion === undefined ? {} : { killCriterion: input.killCriterion }),
    });
  }

  // S7·8 — amend the work order (D46's amend door). Mirrors `createTask`'s
  // plain fetch/parse/answer idiom exactly: `postJsonApi` returns the daemon's
  // status and body VERBATIM, and this adds nothing on top.
  //
  // ⚠ NO SUBSCRIBE GLUE, UNLIKE `proposeTaskTransition`/`dispatchTask` BELOW.
  // Those two glue a spawned session onto the WS subscription because a
  // promotion or a dispatch can mint a live session the client would otherwise
  // never see events for. A payload revision can never spawn anything (D53 — amending
  // changes what the work order SAYS; whether to re-run against the new
  // revision is a later, separate, explicit `dispatchTask` call) — so there is
  // nothing here to subscribe to, and nothing schedules a sessions refresh.
  function amendTask(instanceId: string, body: AmendmentBody): Promise<TaskApiAnswer> {
    return postJsonApi(`/api/instances/${encodeURIComponent(instanceId)}/payload-revisions`, body);
  }

  // PROPOSE a transition. The name is the contract: this does not move anything.
  //
  // S7·7e — mirrors `dispatchTask`'s subscribe glue below, for the SAME reason:
  // D53 made a promotion into an active stage make its own dispatch attempt
  // (instanceApi.ts's moves route), and an accepted promotion carries that
  // attempt's result on a top-level `dispatch` field. A `spawned` result there
  // mints a brand-new session exactly like an explicit dispatch does, and the
  // client still only gets live events for streams it is subscribed to — so
  // without this glue, a promotion's `session_created` would be just as
  // invisible as a bare dispatch's used to be. `sessionToSubscribeAfterTransition`
  // makes the strict spawned+id decision from the `dispatch` rider (its sibling,
  // `sessionToSubscribeAfterDispatch`, reads `dispatchTask`'s `result` field
  // instead — same guard, different envelope shape); this glue only acts on
  // it. The returned `TaskApiAnswer` is UNCHANGED — this adds a side effect,
  // it does not reinterpret what the caller renders.
  async function proposeTaskTransition(instanceId: string, toNode: string): Promise<TaskApiAnswer> {
    const answer = await postJsonApi(`/api/instances/${encodeURIComponent(instanceId)}/moves`, {
      toNode,
      proposedBy: 'human',
    });
    const spawnedSessionId = sessionToSubscribeAfterTransition(answer.status, answer.body);
    if (spawnedSessionId !== null) {
      subscribe(spawnedSessionId);
      scheduleSessionsRefresh();
    }
    return answer;
  }

  // ONE explicit dispatch attempt — no retry, no loop, mirroring the route.
  //
  // A `spawned` outcome mints a BRAND NEW session, and the client only
  // receives live events for streams it is subscribed to — without this, the
  // resulting `session_created` lands on an unsubscribed stream and stays
  // invisible until a manual reload (the same gap the WS `'discovered'`
  // handler closes for scan-mirrored sessions, via `scheduleSessionsRefresh`).
  // `sessionToSubscribeAfterDispatch` makes the strict spawned+id decision;
  // this glue only acts on it. The returned `TaskApiAnswer` is UNCHANGED —
  // this adds a side effect, it does not reinterpret what the caller renders.
  async function dispatchTask(instanceId: string): Promise<TaskApiAnswer> {
    const answer = await postJsonApi(`/api/instances/${encodeURIComponent(instanceId)}/dispatch`, {});
    const spawnedSessionId = sessionToSubscribeAfterDispatch(answer.status, answer.body);
    if (spawnedSessionId !== null) {
      subscribe(spawnedSessionId);
      scheduleSessionsRefresh();
    }
    return answer;
  }

  // S8·5 (D56) — ensure this project's standing orchestrator exists and is
  // live. `POST /api/projects/:projectId/orchestrator` with an empty body, the
  // daemon's ENSURE endpoint verbatim (get-or-create-or-resume, idempotent —
  // see orchestratorApi.ts).
  //
  // ⚠ THE THIRD MINT-PATH. A founded/resumed orchestrator is a session this
  // client has never subscribed to, exactly the gap `dispatchTask` and
  // `proposeTaskTransition` close for a dispatch/promotion — this is their
  // twin, using `sessionToOpenAfterEnsure` (orchestratorEntry.ts) in place of
  // `sessionToSubscribeAfterDispatch`/`sessionToSubscribeAfterTransition`
  // because the envelope shape differs, but the glue is identical: subscribe
  // to the WS stream so the founding/reorientation turn (and everything
  // after) is not invisible, then schedule a sessions refresh so the new
  // record itself lands. The raw answer goes back to the caller VERBATIM —
  // this adds a side effect, it does not reinterpret what App.vue renders.
  async function ensureOrchestrator(projectId: string): Promise<TaskApiAnswer> {
    const answer = await postJsonApi(`/api/projects/${encodeURIComponent(projectId)}/orchestrator`, {});
    const sessionId = sessionToOpenAfterEnsure(answer.status, answer.body);
    if (sessionId !== null) {
      subscribe(sessionId);
      scheduleSessionsRefresh();
    }
    return answer;
  }

  // Subscribe the board to the 'tasks' stream and take a first read. Idempotent:
  // `subscribe` tracks its own set, and a re-open just re-subscribes from the
  // lastSeq it already holds (the I2 client behaviour every other view uses).
  function watchTasks(): void {
    tasksLoading.value = tasksProjectionBody.value === null;
    subscribe(TASKS_STREAM);
    void fetchTasks();
    // S13·U3: ONE call now fetches both the legal-edge table the move sheet
    // filters against AND the work-order authoring descriptor the create sheet
    // renders from, because both are keyed by the SAME workflow ref and the
    // discovery route that yields that ref is fetched once for the pair.
    // Fetched alongside the instances projection rather than gated behind
    // opening a card or the New Task sheet, exactly as its two predecessors
    // were — so both sheets have what they need the first time they open.
    void fetchWorkflowIntrospection();
  }

  // ── Git review fetches (mirror fetchTerminals: plain REST, same-origin creds,
  // tolerant). A clean 4xx from the daemon carries { error, detail? }; we surface
  // the classified reason to gitError so the panel can show it inline. A transient
  // network failure leaves the previous state in place (the log/repo is truth).

  // Read the git error body of a non-ok response into a short reason string.
  async function gitRefusalReason(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      const reason = typeof body.error === 'string' ? body.error : `git request failed (${response.status})`;
      return typeof body.detail === 'string' && body.detail.length > 0 ? `${reason}: ${body.detail}` : reason;
    } catch {
      return `git request failed (${response.status})`;
    }
  }

  // GET /api/git/repos — the repos discovered beneath the allowlist, for the
  // panel's picker. Depth-bounded server-side; every returned path is
  // allowlist-verified there. A transient failure leaves the previous list in
  // place (the free-text path field still reaches any repo regardless).
  async function fetchGitRepos(): Promise<void> {
    try {
      const response = await fetch('/api/git/repos', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const parsed = (await response.json()) as { repos?: GitRepoEntry[] };
      gitRepos.value = Array.isArray(parsed.repos) ? parsed.repos : [];
    } catch {
      // Transient network hiccup — the next panel mount retries.
    }
  }

  // GET /api/git/status?root — the changed-files list + branch for a repo root.
  async function fetchGitStatus(root: string): Promise<void> {
    gitError.value = null;
    try {
      const query = new URLSearchParams({ root });
      const response = await fetch(`/api/git/status?${query.toString()}`, { credentials: 'same-origin' });
      if (!response.ok) {
        gitError.value = await gitRefusalReason(response);
        return;
      }
      const parsed = (await response.json()) as { repoRoot: string; status: GitStatus };
      gitStatus.value = { repoRoot: parsed.repoRoot, status: parsed.status };
    } catch {
      // Transient network hiccup — a later fetch retries; keep the prior status.
    }
  }

  // Clear the loaded diff (leaving the diff screen / switching root) so a stale
  // file's hunks never flash under a different selection.
  function clearGitDiff(): void {
    gitDiffFiles.value = [];
  }

  // GET /api/git/diff?root&path&staged=1 — one file's hunks (worktree or staged).
  async function fetchGitDiff(root: string, path: string, staged: boolean): Promise<void> {
    gitError.value = null;
    try {
      const query = new URLSearchParams({ root, path });
      if (staged) {
        query.set('staged', '1');
      }
      const response = await fetch(`/api/git/diff?${query.toString()}`, { credentials: 'same-origin' });
      if (!response.ok) {
        gitError.value = await gitRefusalReason(response);
        gitDiffFiles.value = [];
        return;
      }
      const parsed = (await response.json()) as { repoRoot: string; files: GitFileDiff[] };
      gitDiffFiles.value = Array.isArray(parsed.files) ? parsed.files : [];
    } catch {
      // Transient network hiccup — leave the previous diff in place.
    }
  }

  // Shared POST helper for stage/unstage/commit: returns ok, surfacing a refusal
  // to gitError so the view can react (re-fetch on success, show the reason on
  // failure). Never throws — a network failure resolves to ok:false.
  async function gitMutate(endpoint: string, payload: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    gitError.value = null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const reason = await gitRefusalReason(response);
        gitError.value = reason;
        return { ok: false, error: reason };
      }
      return { ok: true };
    } catch {
      const reason = 'git request could not be sent';
      gitError.value = reason;
      return { ok: false, error: reason };
    }
  }

  // POST /api/git/stage — file-level stage, then re-fetch status so the buckets
  // (staged/unstaged) reflect the change. HUNK-LEVEL staging is deferred: the
  // step-1 API is path-level only (a future API extension would add hunk patches).
  async function stageGitPath(root: string, path: string): Promise<{ ok: boolean; error?: string }> {
    const result = await gitMutate('/api/git/stage', { root, path });
    if (result.ok) {
      await fetchGitStatus(root);
    }
    return result;
  }

  // POST /api/git/unstage — file-level unstage (git restore --staged), re-fetch.
  async function unstageGitPath(root: string, path: string): Promise<{ ok: boolean; error?: string }> {
    const result = await gitMutate('/api/git/unstage', { root, path });
    if (result.ok) {
      await fetchGitStatus(root);
    }
    return result;
  }

  // POST /api/git/commit — commit the staged index with a message. Returns ok/
  // refusal so the composer can surface an empty-index or empty-message refusal;
  // re-fetches status on success (the committed files leave the staged bucket).
  async function commitGit(root: string, message: string): Promise<{ ok: boolean; error?: string }> {
    const result = await gitMutate('/api/git/commit', { root, message });
    if (result.ok) {
      await fetchGitStatus(root);
    }
    return result;
  }

  function scheduleSessionsRefresh(): void {
    const elapsed = Date.now() - lastSessionsRefreshAt;
    if (elapsed >= SESSIONS_REFRESH_THROTTLE_MS) {
      void refreshSessions();
      return;
    }
    if (sessionsRefreshTimer === null) {
      sessionsRefreshTimer = setTimeout(() => {
        sessionsRefreshTimer = null;
        void refreshSessions();
      }, SESSIONS_REFRESH_THROTTLE_MS - elapsed);
    }
  }

  function sendEnvelope(envelope: ClientEnvelope): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(serializeClientEnvelope(envelope));
    }
    // Offline: the op is dropped. A disconnected client's job is to reconnect
    // and replay via lastSeq (I2) — sends/gate-answers/spawns issued while
    // offline are not queued (out of scope for the minimal page).
  }

  function streamStateFor(streamId: string): StreamState {
    if (streamsByAppSessionId[streamId] === undefined) {
      streamsByAppSessionId[streamId] = { lastSeq: 0, events: [] };
    }
    // Re-read through the reactive proxy rather than returning the object
    // literal above directly, so later mutations (push/lastSeq) are observed.
    return streamsByAppSessionId[streamId]!;
  }

  function applyServerEnvelope(envelope: ServerEnvelope): void {
    switch (envelope.op) {
      case 'hello': {
        daemonApiVersion.value = envelope.apiVersion;
        daemonCapabilities.value = envelope.capabilities;
        return;
      }
      case 'subscribed': {
        daemonRespondedThisConnection.value = true;
        pendingResubscribeAcks.delete(envelope.stream);
        if (pendingResubscribeAcks.size === 0) {
          catchingUp.value = false;
        }
        return;
      }
      case 'event': {
        const state = streamStateFor(envelope.event.stream);
        if (envelope.event.seq <= state.lastSeq) {
          return; // already-seen (defensive dedupe against a duplicate replay)
        }
        state.events.push(envelope.event);
        state.lastSeq = envelope.event.seq;
        if (SESSIONS_AFFECTING_TYPES.has(envelope.event.type)) {
          scheduleSessionsRefresh();
        }
        // S15·U2 — the tree's superset (lib/sessionTreeRefresh.ts): everything
        // that moves the sessions projection PLUS the node events and the
        // project-registry lifecycle that reshape the forest itself. Checked
        // SEPARATELY rather than folded into the test above, so the sessions
        // cadence is byte-identical to what it has always been — the two read
        // models refetch independently even though one set contains the other.
        if (TREE_AFFECTING_TYPES.has(envelope.event.type)) {
          scheduleTreeRefresh();
        }
        // The task board's live channel (step 9). Stream-local rather than
        // type-listed — see TASKS_STREAM. This is what makes a card move WITHOUT
        // an optimistic local edit: a transition the machine accepted becomes a
        // `task_transitioned` on this stream, which re-reads the projection,
        // which is what the board renders.
        if (envelope.event.stream === TASKS_STREAM) {
          void fetchTasks();
        }
        return;
      }
      case 'refused': {
        lastRefusal.value = { refusedOp: envelope.refusedOp, reason: envelope.reason };
        const spawnResolution = resolveRefusedPending(pendingSpawn, envelope.refusedOp, envelope.reason);
        pendingSpawn = spawnResolution.next;
        spawnResolution.fire?.();
        // gate_response and search refusals carry no requestId/searchId to
        // correlate against (wire limitation, see refusalRecovery.ts) — both
        // ops only ever have one thing in flight, so a refusal is resolved
        // against whatever is currently pending rather than left to hang.
        if (isGateResponseRefusal(envelope.refusedOp)) {
          answeringRequestIds.clear();
        }
        if (shouldSearchRefusalError(searchStatus.value, envelope.refusedOp)) {
          searchErrorReason.value = envelope.reason;
          searchStatus.value = 'error';
        }
        return;
      }
      case 'error':
        lastRefusal.value = { refusedOp: '(malformed request)', reason: envelope.reason };
        return;
      case 'spawned': {
        streamStateFor(envelope.appSessionId);
        const spawnResolution = resolveSpawnedPending(pendingSpawn, envelope.appSessionId);
        pendingSpawn = spawnResolution.next;
        spawnResolution.fire?.();
        // A spawn widens the allowlist (the new session's cwd) — refresh roots.
        void fetchRoots();
        return;
      }
      case 'discovered': {
        // A discover scan may have minted new mirrored sessions — refresh the
        // home list so they appear (the resulting session_created events on
        // unsubscribed streams would not otherwise trigger a refresh), and
        // refresh roots (discovery can widen the allowlist the same way a
        // spawn does).
        scheduleSessionsRefresh();
        void fetchRoots();
        return;
      }
      case 'search_result': {
        if (envelope.searchId !== activeSearchId) {
          return; // a late frame from a superseded/cancelled search
        }
        searchResults.value.push({
          file: envelope.file,
          line: envelope.line,
          col: envelope.col,
          submatches: envelope.submatches,
        });
        return;
      }
      case 'search_done': {
        if (envelope.searchId !== activeSearchId) {
          return;
        }
        searchStats.value = envelope.stats;
        searchStatus.value = 'done';
        return;
      }
      case 'search_error': {
        if (envelope.searchId !== activeSearchId) {
          return;
        }
        searchErrorReason.value = envelope.reason;
        searchStatus.value = 'error';
        return;
      }
      case 'term_opened': {
        terminalId = envelope.terminalId;
        terminalOffset = 0;
        // Subscribe immediately from the start so the shell's opening prompt (which
        // may already be buffered) replays in full (I9).
        sendEnvelope({ op: 'term_subscribe', terminalId, offset: terminalOffset });
        return;
      }
      case 'term_subscribed': {
        if (envelope.terminalId !== terminalId) {
          return;
        }
        terminalTag = envelope.tag;
        terminalStatus.value = 'live';
        return;
      }
      case 'term_lost': {
        if (envelope.terminalId !== terminalId) {
          return;
        }
        // Honest signal: output was dropped (a disconnect longer than the ring
        // window). The view shows the notice; live bytes resume after it.
        terminalLostSink?.();
        return;
      }
      case 'term_exit': {
        if (envelope.terminalId !== terminalId) {
          return;
        }
        terminalStatus.value = 'exited';
        terminalExitCode.value = envelope.exitCode;
        terminalExitSink?.(envelope.exitCode);
        terminalId = null;
        terminalTag = null;
        // The shell is gone — refresh the list so it drops off the landing.
        void fetchTerminals();
        return;
      }
    }
  }

  // Route a server binary frame (raw terminal output) to the active terminal.
  function handleTerminalBinary(frame: Uint8Array): void {
    const deframed = deframeTerminalOutput(frame);
    if (deframed === null || terminalTag === null || deframed.tag !== terminalTag) {
      return; // empty / unknown tag — drop
    }
    terminalOffset = advanceOffset(terminalOffset, deframed.payload.length);
    terminalOutputSink?.(deframed.payload);
  }

  function connect(): void {
    manuallyClosed = false;
    connectionStatus.value = everConnected ? 'reconnecting' : 'connecting';
    const socketInstance = new WebSocket(wsUrl());
    // Terminal output rides binary frames; read them as ArrayBuffer synchronously.
    socketInstance.binaryType = 'arraybuffer';
    socket = socketInstance;

    socketInstance.addEventListener('open', () => {
      everConnected = true;
      backoffMs = MIN_BACKOFF_MS;
      consecutiveWsFailures = 0;
      connectionStatus.value = 'open';
      // A new connection may be talking to a different (e.g. just-restarted)
      // daemon — judge IT on its own hello, not a stale verdict carried over.
      daemonApiVersion.value = null;
      daemonCapabilities.value = [];
      daemonRespondedThisConnection.value = false;
      if (subscribedStreams.size > 0) {
        catchingUp.value = true;
        pendingResubscribeAcks.clear();
        for (const streamId of subscribedStreams) {
          pendingResubscribeAcks.add(streamId);
          sendEnvelope({ op: 'subscribe', stream: streamId, lastSeq: streamStateFor(streamId).lastSeq });
        }
      }
      // A live terminal survives a WS reconnect server-side (§3.10): re-subscribe
      // from the byte offset reached so far. The server re-assigns a byte-tag and
      // replays from there — or sends term_lost if the gap exceeded the ring window.
      if (terminalId !== null && (terminalStatus.value === 'live' || terminalStatus.value === 'opening')) {
        sendEnvelope({ op: 'term_subscribe', terminalId, offset: terminalOffset });
      }
      void refreshSessions();
      // The home surface is the tree now: a reconnect may have missed events
      // entirely (the gap the per-stream lastSeq replay covers only for streams
      // this tab subscribes to), so the forest is re-read on every open.
      scheduleTreeRefresh();
    });

    socketInstance.addEventListener('message', (messageEvent) => {
      if (typeof messageEvent.data === 'string') {
        const envelope = parseServerEnvelope(messageEvent.data);
        if (envelope !== null) {
          applyServerEnvelope(envelope);
        }
        return;
      }
      // Binary frame = raw terminal output bytes.
      if (messageEvent.data instanceof ArrayBuffer) {
        handleTerminalBinary(new Uint8Array(messageEvent.data));
      }
    });

    const scheduleReconnect = (): void => {
      if (socket !== socketInstance) {
        return;
      }
      socket = null;
      if (manuallyClosed) {
        return;
      }
      consecutiveWsFailures += 1;
      // Access-expiry bounce: after enough consecutive failures, probe /api/health.
      // If Access is intercepting (redirect/opaque/non-OK), a full-page reload runs
      // the login flow; on return the store resubscribes with per-stream lastSeq.
      void maybeBounceThroughReauth();
      connectionStatus.value = 'reconnecting';
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };
    socketInstance.addEventListener('close', scheduleReconnect);
    socketInstance.addEventListener('error', () => {
      socketInstance.close();
    });
  }

  // ── Access-expiry re-auth bounce ──────────────────────────────────────────
  async function maybeBounceThroughReauth(): Promise<void> {
    if (!shouldProbeHealth(consecutiveWsFailures)) {
      return;
    }
    let outcome: HealthProbeOutcome;
    try {
      const response = await fetch('/api/health', { credentials: 'same-origin' });
      outcome = {
        fetchFailed: false,
        ok: response.ok,
        redirected: response.redirected,
        type: response.type,
        status: response.status,
      };
    } catch {
      outcome = { fetchFailed: true };
    }
    if (decideReconnectAction(outcome) === 'reload') {
      window.location.reload();
    }
  }

  // ── Web push (spec §3.8 — enabling is ALWAYS a deliberate tap, never auto) ──
  function pushSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window
    );
  }

  function currentPermission(): 'default' | 'granted' | 'denied' {
    return 'Notification' in window ? (Notification.permission as 'default' | 'granted' | 'denied') : 'default';
  }

  async function activeSubscription(): Promise<PushSubscription | null> {
    if (!pushSupported()) {
      return null;
    }
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function refreshPushState(): Promise<void> {
    const supported = pushSupported();
    const subscribed = supported ? (await activeSubscription()) !== null : false;
    pushState.value = derivePushState({ supported, permission: currentPermission(), subscribed });
  }

  // Decode the base64url VAPID public key to the applicationServerKey byte array.
  function urlBase64ToUint8Array(base64UrlString: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64UrlString.length % 4)) % 4);
    const base64 = (base64UrlString + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    // Build over an explicit ArrayBuffer so the array is a valid applicationServerKey
    // BufferSource (not a SharedArrayBuffer-backed view).
    const bytes = new Uint8Array(new ArrayBuffer(rawData.length));
    for (let index = 0; index < rawData.length; index += 1) {
      bytes[index] = rawData.charCodeAt(index);
    }
    return bytes;
  }

  async function fetchVapidPublicKey(): Promise<string> {
    const response = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
    const body = (await response.json()) as { publicKey: string };
    return body.publicKey;
  }

  // Deliberate enable: request permission, subscribe via pushManager with the
  // VAPID key, then register the subscription with the daemon.
  async function enablePush(): Promise<void> {
    if (!pushSupported()) {
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      await refreshPushState();
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(await fetchVapidPublicKey()),
      }));
    sendEnvelope({ op: 'push_subscribe', subscription: subscription.toJSON() });
    await refreshPushState();
  }

  async function disablePush(): Promise<void> {
    if (!pushSupported()) {
      return;
    }
    const subscription = await activeSubscription();
    if (subscription !== null) {
      sendEnvelope({ op: 'push_unsubscribe', endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    await refreshPushState();
  }

  // The bell's single action: off → enable, on → disable. Unsupported/denied are
  // inert (the caller checks isBellActionable).
  function togglePush(): void {
    if (pushState.value === 'on') {
      void disablePush();
    } else if (pushState.value === 'off') {
      void enablePush();
    }
  }

  function init(): void {
    if (socket !== null || reconnectTimer !== null) {
      return;
    }
    void refreshPushState();
    void refreshSessions();
    void fetchRoots();
    connect();
  }

  function dispose(): void {
    manuallyClosed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  }

  function subscribe(appSessionId: string): void {
    subscribedStreams.add(appSessionId);
    sendEnvelope({ op: 'subscribe', stream: appSessionId, lastSeq: streamStateFor(appSessionId).lastSeq });
  }

  function eventsFor(appSessionId: string): EventRecord[] {
    return streamStateFor(appSessionId).events;
  }

  function sendMessage(appSessionId: string, text: string): void {
    sendEnvelope({ op: 'send', appSessionId, text });
  }

  function answerGate(
    appSessionId: string,
    requestId: string,
    // D68: an AskUserQuestion gate submits a structured answers map; a permission
    // gate submits 'allow'|'deny'. Body is unchanged — the wire is z.unknown().
    response: 'allow' | 'deny' | { answers: Record<string, string> },
  ): void {
    answeringRequestIds.add(requestId);
    sendEnvelope({ op: 'gate_response', appSessionId, requestId, response });
  }

  function resumeSession(appSessionId: string): void {
    sendEnvelope({ op: 'resume', appSessionId });
  }

  // v0.2 session ops (D9/D10). Fire-and-forget: the resulting events on the
  // subscribed stream (and the throttled sessions refresh) reflect the outcome;
  // a failure surfaces as a `refused` envelope in lastRefusal.
  function markSeen(appSessionId: string): void {
    sendEnvelope({ op: 'seen', appSessionId });
  }

  function clearAttention(appSessionId: string): void {
    sendEnvelope({ op: 'clear_attention', appSessionId });
  }

  function killSession(appSessionId: string): void {
    sendEnvelope({ op: 'kill', appSessionId });
  }

  function renameSession(appSessionId: string, name: string): void {
    sendEnvelope({ op: 'rename', appSessionId, name });
  }

  function adoptSession(appSessionId: string): void {
    sendEnvelope({ op: 'adopt', appSessionId });
  }

  function discover(): void {
    sendEnvelope({ op: 'discover' });
  }

  // Fires `onSpawned` on the next `spawned` envelope, or `onRefused` on a
  // `refused` envelope with refusedOp 'spawn' — whichever terminal envelope
  // arrives first resolves this spawn and clears the pending record (see
  // resolveSpawnedPending/resolveRefusedPending in refusalRecovery.ts). The
  // minimal page only ever has one spawn in flight at a time, so tracking a
  // single pending record (rather than a FIFO of listeners) is sufficient —
  // a documented simplification, not a correctness claim for concurrent
  // spawns. A newer spawnSession call replaces any still-pending record: its
  // caller already presented (and is responsible for) whatever pending UI it
  // showed for the earlier spawn.
  function spawnSession(
    channel: 'sdk' | 'pty',
    cwd: string,
    callbacks: { onSpawned: (appSessionId: string) => void; onRefused?: (reason: string) => void },
  ): void {
    pendingSpawn = { onSpawned: callbacks.onSpawned, onRefused: callbacks.onRefused ?? (() => {}) };
    sendEnvelope({ op: 'spawn', channel, cwd });
  }

  function dismissRefusal(): void {
    lastRefusal.value = null;
  }

  // ── Search actions ────────────────────────────────────────────────────────
  // Start a fresh search: mint a new searchId (which supersedes any prior one),
  // clear the panel, and stream results in via applyServerEnvelope.
  function startSearch(root: string, query: string, flags?: SearchFlags): void {
    searchCounter += 1;
    const searchId = `s${searchCounter}`;
    activeSearchId = searchId;
    searchResults.value = [];
    searchStats.value = null;
    searchErrorReason.value = null;
    searchStatus.value = 'running';
    sendEnvelope({ op: 'search', searchId, root, query, flags });
  }

  function cancelSearch(): void {
    if (activeSearchId !== null && searchStatus.value === 'running') {
      sendEnvelope({ op: 'search_cancel', searchId: activeSearchId });
    }
    searchStatus.value = 'idle';
  }

  function clearSearch(): void {
    activeSearchId = null;
    searchResults.value = [];
    searchStats.value = null;
    searchErrorReason.value = null;
    searchStatus.value = 'idle';
  }

  // ── Terminal actions (slice 3 step 3) ──────────────────────────────────────
  function sendBinaryFrame(frame: Uint8Array): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
    }
    // Offline: dropped (like every other op) — reconnect re-subscribes with the
    // byte offset and replays; unsent keystrokes are not queued.
  }

  // The view registers its xterm sinks here (bytes stream straight through).
  function setTerminalSinks(sinks: {
    onOutput: (bytes: Uint8Array) => void;
    onLost: () => void;
    onExit: (exitCode: number) => void;
  }): void {
    terminalOutputSink = sinks.onOutput;
    terminalLostSink = sinks.onLost;
    terminalExitSink = sinks.onExit;
  }

  function clearTerminalSinks(): void {
    terminalOutputSink = null;
    terminalLostSink = null;
    terminalExitSink = null;
  }

  // Open a shell at cwd (must be within the daemon's project roots / session cwds)
  // and subscribe on term_opened. `dimensions`, when given, is the caller's
  // already-fitted viewport size — it rides WITH term_open so the daemon spawns
  // the pty at the right size before the shell renders (the mobile
  // terminal-corruption fix: a post-hoc resize is too late for a TUI that has
  // already drawn its wide layout at the default 80 cols).
  function openTerminal(cwd: string, dimensions?: { cols: number; rows: number }): void {
    terminalId = null;
    terminalTag = null;
    terminalOffset = 0;
    terminalCwd = cwd;
    terminalExitCode.value = null;
    terminalStatus.value = 'opening';
    sendEnvelope(
      dimensions === undefined
        ? { op: 'term_open', cwd }
        : { op: 'term_open', cwd, cols: dimensions.cols, rows: dimensions.rows },
    );
  }

  function sendTerminalInput(text: string): void {
    if (terminalTag === null) {
      return;
    }
    sendBinaryFrame(frameTerminalInputText(terminalTag, text));
  }

  function resizeTerminal(cols: number, rows: number): void {
    if (terminalId === null) {
      return;
    }
    sendEnvelope({ op: 'term_resize', terminalId, cols, rows });
  }

  function closeTerminal(): void {
    if (terminalId !== null) {
      sendEnvelope({ op: 'term_close', terminalId });
    }
    terminalStatus.value = 'idle';
    terminalId = null;
    terminalTag = null;
  }

  // Re-enter a still-alive shell from the terminals list. Unlike openTerminal this
  // does NOT term_open (the shell exists) — it term_subscribes at offset 0 so the
  // ring replays what it still holds (term_lost fires if the gap exceeded the
  // window). A live-or-dead shell is never "resumed"; re-enter is re-subscribe.
  function enterTerminal(existingTerminalId: string, cwd: string): void {
    terminalId = existingTerminalId;
    terminalTag = null;
    terminalOffset = 0;
    terminalCwd = cwd;
    terminalExitCode.value = null;
    terminalStatus.value = 'opening';
    sendEnvelope({ op: 'term_subscribe', terminalId, offset: terminalOffset });
  }

  // Navigate-away: DETACH the view binding but LEAVE THE SHELL ALIVE (persistence,
  // pillar 2 for terminals). No term_close — the daemon keeps the pty running; a
  // later re-enter re-subscribes. This is the subtractive fix for the bug where
  // leaving the terminal view killed the shell.
  function detachTerminal(): void {
    terminalStatus.value = 'idle';
    terminalId = null;
    terminalTag = null;
    terminalOffset = 0;
  }

  // Toggle a listed terminal's resilient flag (reaper exemption). Optimistically
  // reflect it locally so the checkmark responds immediately; the next
  // fetchTerminals reconciles against the daemon's truth.
  function setTerminalResilient(existingTerminalId: string, resilient: boolean): void {
    sendEnvelope({ op: 'term_set_resilient', terminalId: existingTerminalId, resilient });
    terminals.value = terminals.value.map((terminal) =>
      terminal.terminalId === existingTerminalId ? { ...terminal, resilient } : terminal,
    );
  }

  // One-tap kill from the list: close an arbitrary shell (not necessarily the one
  // in view). If it is the in-view shell, clear the view binding too.
  function killTerminal(existingTerminalId: string): void {
    sendEnvelope({ op: 'term_close', terminalId: existingTerminalId });
    if (existingTerminalId === terminalId) {
      detachTerminal();
    }
    terminals.value = terminals.value.filter((terminal) => terminal.terminalId !== existingTerminalId);
  }

  function currentTerminalCwd(): string | null {
    return terminalCwd;
  }

  return {
    sessions,
    roots,
    // The project registry + the resolved context (S8·2, D42/D61)
    projects,
    rootsBases,
    projectsLoaded,
    projectsUnreachable,
    currentProject,
    setCurrentProject,
    fetchProjects,
    declareProject,
    connectionStatus,
    catchingUp,
    lastRefusal,
    // D84 (S14 U1): the API-version handshake.
    daemonApiVersion,
    daemonApiVersionMismatch: apiVersionMismatch,
    daemonSupports,
    answeringRequestIds,
    init,
    dispose,
    subscribe,
    eventsFor,
    sendMessage,
    answerGate,
    resumeSession,
    spawnSession,
    dismissRefusal,
    markSeen,
    clearAttention,
    killSession,
    renameSession,
    adoptSession,
    discover,
    pushState,
    togglePush,
    refreshPushState,
    // Search (slice 3 step 2)
    searchStatus,
    searchResults,
    searchStats,
    searchErrorReason,
    startSearch,
    cancelSearch,
    clearSearch,
    // Terminal (slice 3 step 3)
    terminalStatus,
    terminalExitCode,
    setTerminalSinks,
    clearTerminalSinks,
    openTerminal,
    sendTerminalInput,
    resizeTerminal,
    closeTerminal,
    currentTerminalCwd,
    // Terminal lifecycle (persistent, reapable, re-enterable)
    terminals,
    fetchTerminals,
    enterTerminal,
    detachTerminal,
    setTerminalResilient,
    killTerminal,
    // The session tree (S15·U2) — the home surface's read model
    tree,
    treeLoaded,
    treeError,
    refreshTree,
    scheduleTreeRefresh,
    // The tree's write surface (S15·U3) — the daemon's answer, verbatim
    createNode,
    closeNode,
    attachSessionToNode,
    // Cache observability (slice 4 step 4)
    cacheObservability,
    fetchCacheObservability,
    // Usage meters (slice 5 step 3 → 4c: the derived read model)
    usageSnapshot,
    usageRefreshInFlight,
    lastUsageRefresh,
    fetchDerivedUsage,
    refreshUsage,
    // Cost ledger (slice 5b step 4b)
    costLedger,
    costLedgerLoading,
    fetchCostLedger,
    // Task board (slice 6 step 9) — read the projection, propose transitions,
    // dispatch. Nothing here writes task state locally.
    tasksProjectionBody,
    tasksLoading,
    workflowDeclaration,
    stageEdges,
    workOrderSchema,
    watchTasks,
    fetchTasks,
    fetchWorkflowIntrospection,
    createTask,
    amendTask,
    proposeTaskTransition,
    dispatchTask,
    // The standing orchestrator (slice 8 step 5, D56)
    ensureOrchestrator,
    // Git review (slice 4 step 3)
    gitStatus,
    gitDiffFiles,
    gitError,
    gitRepos,
    lastGitRoot,
    pendingGitDiffContext,
    fetchGitRepos,
    fetchGitStatus,
    fetchGitDiff,
    clearGitDiff,
    stageGitPath,
    unstageGitPath,
    commitGit,
  };
});
