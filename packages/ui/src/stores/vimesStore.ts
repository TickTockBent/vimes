import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { parseServerEnvelope, serializeClientEnvelope, type ClientEnvelope, type ServerEnvelope } from '../lib/envelope.js';
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
        return;
      }
      case 'discovered': {
        // A discover scan may have minted new mirrored sessions — refresh the
        // home list so they appear (the resulting session_created events on
        // unsubscribed streams would not otherwise trigger a refresh).
        scheduleSessionsRefresh();
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
    }
  }

  function connect(): void {
    manuallyClosed = false;
    connectionStatus.value = everConnected ? 'reconnecting' : 'connecting';
    const socketInstance = new WebSocket(wsUrl());
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
      void refreshSessions();
    });

    socketInstance.addEventListener('message', (messageEvent) => {
      if (typeof messageEvent.data !== 'string') {
        return; // control envelopes are text frames; binary is out of scope here
      }
      const envelope = parseServerEnvelope(messageEvent.data);
      if (envelope !== null) {
        applyServerEnvelope(envelope);
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

  return {
    sessions,
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
  };
});
