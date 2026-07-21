import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { parseServerEnvelope, serializeClientEnvelope, type ClientEnvelope, type ServerEnvelope } from '../lib/envelope.js';
import { advanceOffset, deframeTerminalOutput, frameTerminalInputText } from '../lib/terminalFraming.js';
import { parseRootsPayload } from '../lib/treeNode.js';
import type { TerminalListItem } from '../lib/terminalList.js';
import type { CacheObservabilityRecord } from '../lib/cacheBadge.js';
import type { MeterRecord } from '../lib/meterDisplay.js';
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

// The single shared WS connection (docs/slice-1.md step-3 scope): one socket
// multiplexes every subscribed stream; per-stream lastSeq is tracked so a
// reconnect resubscribes everything from where it left off (the I2 client
// behavior), with exponential backoff 1s..10s.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
const SESSIONS_REFRESH_THROTTLE_MS = 1000;

// The wsHub upgrade handler (packages/daemon/src/app.ts) does not filter by
// path at all — confirmed by packages/daemon/src/wsHub.test.ts connecting to
// a bare `ws://host:port` with no path. `/ws` is used here for clarity only;
// any path would work identically against the current daemon.
const WS_PATH = '/ws';

// Event types that can move the sessions projection (liveness/attention
// badges on the home list) — seen on a subscribed stream, they schedule a
// throttled REST re-fetch rather than trying to patch the projection locally
// (scope: "keep it simple ... correctness first").
const SESSIONS_AFFECTING_TYPES = new Set([
  'session_created',
  'liveness_changed',
  'gate_fired',
  'question_asked',
  'run_completed',
  'watchdog_stale',
  'task_quarantined',
  'seen',
  'attention_cleared',
  // v0.2 (D10): custody/name transitions move the home list too.
  'session_adopted',
  'session_renamed',
]);

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
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const catchingUp = ref(false);
  const lastRefusal = ref<{ refusedOp: string; reason: string } | null>(null);
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
  // ── Usage meters (slice 5 step 3) — the home-screen "can I afford to start
  // this?" strip, reading the step-1 meters projection
  // (GET /api/projections/meters). Same plain REST-into-ref shape as
  // cacheObservability, refreshed on the existing refreshSessions() cadence —
  // no new polling loop. An empty map means we have observed NOTHING, which the
  // strip renders as "usage unknown", never as zeros (pillar 4).
  const meters = ref<Record<string, MeterRecord>>({});
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
    void fetchMeters();
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

  // GET /api/projections/meters — the usage-meters projection (slice 5 step 3).
  // Mirrors fetchCacheObservability exactly: plain same-origin REST into a ref,
  // tolerant of transient failure, no polling loop of its own. A failure leaves
  // the previous records in place ON PURPOSE — they carry their own observedAt,
  // so meterDisplay derives them as stale and the strip stops showing figures
  // by itself. Freshness is never faked by the fetch layer.
  async function fetchMeters(): Promise<void> {
    try {
      const response = await fetch('/api/projections/meters', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }
      const parsed = (await response.json()) as { meters?: Record<string, MeterRecord> };
      meters.value = parsed.meters ?? {};
    } catch {
      // Transient network hiccup — the next refreshSessions() retries.
    }
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
      case 'subscribed': {
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

  function answerGate(appSessionId: string, requestId: string, response: 'allow' | 'deny'): void {
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
    connectionStatus,
    catchingUp,
    lastRefusal,
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
    // Cache observability (slice 4 step 4)
    cacheObservability,
    fetchCacheObservability,
    // Usage meters (slice 5 step 3)
    meters,
    fetchMeters,
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
