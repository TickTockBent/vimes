import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { parseServerEnvelope, serializeClientEnvelope, type ClientEnvelope, type ServerEnvelope } from '../lib/envelope.js';
import type { EventRecord, SessionRecord } from '../lib/types.js';

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

  let socket: WebSocket | null = null;
  let backoffMs = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manuallyClosed = false;
  let everConnected = false;
  const subscribedStreams = new Set<string>();
  const pendingResubscribeAcks = new Set<string>();
  const spawnedListeners: Array<(appSessionId: string) => void> = [];

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
      case 'refused':
        lastRefusal.value = { refusedOp: envelope.refusedOp, reason: envelope.reason };
        return;
      case 'error':
        lastRefusal.value = { refusedOp: '(malformed request)', reason: envelope.reason };
        return;
      case 'spawned': {
        streamStateFor(envelope.appSessionId);
        const listeners = spawnedListeners.splice(0);
        for (const listener of listeners) {
          listener(envelope.appSessionId);
        }
        return;
      }
      case 'discovered': {
        // A discover scan may have minted new mirrored sessions — refresh the
        // home list so they appear (the resulting session_created events on
        // unsubscribed streams would not otherwise trigger a refresh).
        scheduleSessionsRefresh();
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

  function init(): void {
    if (socket !== null || reconnectTimer !== null) {
      return;
    }
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

  // Fires `onSpawned` the next time a `spawned` envelope arrives. The minimal
  // page only ever has one spawn in flight at a time, so a simple FIFO queue
  // (drained in full on each `spawned`) is sufficient — a documented
  // simplification, not a correctness claim for concurrent spawns.
  function spawnSession(channel: 'sdk' | 'pty', cwd: string, onSpawned: (appSessionId: string) => void): void {
    spawnedListeners.push(onSpawned);
    sendEnvelope({ op: 'spawn', channel, cwd });
  }

  function dismissRefusal(): void {
    lastRefusal.value = null;
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
  };
});
