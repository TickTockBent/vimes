import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { EventRecord, EventStore } from '@vimes/core';
import { EventRouter } from '@vimes/core';
import type { SessionHost } from './sessionHost.js';
import { isValidPushSubscription, type PushSubscriptionRecord } from './pushService.js';
import type { SearchService } from './search.js';

// The narrow push-subscription sink the hub needs (PushSubscriptions implements
// it). Keeps the hub decoupled from the sqlite cache class.
export interface PushSubscriptionSink {
  save(subscription: PushSubscriptionRecord): void;
  remove(endpoint: string): void;
}

// The WS layer over EventRouter (slice-1.md protocol v0). One socket multiplexes
// every stream. Reads come via REST; live events and (later) writes ride the WS.
// Control envelopes are zod-validated; hostile input keeps the socket open.

const subscribeEnvelopeSchema = z.object({
  op: z.literal('subscribe'),
  stream: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
});
const unsubscribeEnvelopeSchema = z.object({
  op: z.literal('unsubscribe'),
  stream: z.string().min(1),
});
// send / gate_response / resume shapes land now (rule 0.5) — the session host is
// step 2, so they are accepted, validated, and refused as not-implemented.
const sendEnvelopeSchema = z.object({
  op: z.literal('send'),
  appSessionId: z.string(),
  text: z.string(),
});
const gateResponseEnvelopeSchema = z.object({
  op: z.literal('gate_response'),
  appSessionId: z.string(),
  requestId: z.string(),
  response: z.unknown(),
});
const resumeEnvelopeSchema = z.object({
  op: z.literal('resume'),
  appSessionId: z.string(),
});
// v0.1 (step 2): the UI must be able to create a session.
const spawnEnvelopeSchema = z.object({
  op: z.literal('spawn'),
  channel: z.enum(['sdk', 'pty']),
  cwd: z.string().min(1),
  name: z.string().optional(),
});
// v0.2 (step 2, D9/D10): session ops. seen/clear_attention (attention flow);
// kill/rename (host ops); adopt/discover (custody).
const seenEnvelopeSchema = z.object({ op: z.literal('seen'), appSessionId: z.string() });
const clearAttentionEnvelopeSchema = z.object({
  op: z.literal('clear_attention'),
  appSessionId: z.string(),
});
const killEnvelopeSchema = z.object({ op: z.literal('kill'), appSessionId: z.string() });
const renameEnvelopeSchema = z.object({
  op: z.literal('rename'),
  appSessionId: z.string(),
  // 1–120 chars, non-empty (trimmed) — validated here so the host never sees a
  // malformed name; the host re-checks the bound as a backstop.
  name: z.string().min(1).max(120),
});
const adoptEnvelopeSchema = z.object({ op: z.literal('adopt'), appSessionId: z.string() });
const discoverEnvelopeSchema = z.object({ op: z.literal('discover') });
// v0.3 (step 3): push subscription ops. Validated LOOSE (rule 0.6) — the
// subscription shape is the browser's Push API object; endpoint + keys are
// required, everything else rides through. A subscription that survives the
// envelope is still URL-checked in the handler before it is persisted.
const pushSubscribeEnvelopeSchema = z.object({
  op: z.literal('push_subscribe'),
  subscription: z
    .object({ endpoint: z.string(), keys: z.object({}).passthrough() })
    .passthrough(),
});
const pushUnsubscribeEnvelopeSchema = z.object({
  op: z.literal('push_unsubscribe'),
  endpoint: z.string().min(1),
});
// v0.4 (slice 3 step 1): search + preview-gated replace ops. Flags are LOOSE
// (rule 0.6) — an unknown flag rides through and is ignored by the rg arg builder.
const searchFlagsSchema = z
  .object({
    caseInsensitive: z.boolean().optional(),
    word: z.boolean().optional(),
    regex: z.boolean().optional(),
  })
  .passthrough()
  .optional();
const searchEnvelopeSchema = z.object({
  op: z.literal('search'),
  searchId: z.string().min(1),
  root: z.string().min(1),
  query: z.string().min(1),
  flags: searchFlagsSchema,
});
const searchCancelEnvelopeSchema = z.object({
  op: z.literal('search_cancel'),
  searchId: z.string().min(1),
});
const replacePreviewEnvelopeSchema = z.object({
  op: z.literal('replace_preview'),
  searchId: z.string().min(1),
  root: z.string().min(1),
  query: z.string().min(1),
  replacement: z.string(),
  flags: searchFlagsSchema,
});
const replaceApplyEnvelopeSchema = z.object({
  op: z.literal('replace_apply'),
  previewId: z.string().min(1),
});

const controlEnvelopeSchema = z.discriminatedUnion('op', [
  subscribeEnvelopeSchema,
  unsubscribeEnvelopeSchema,
  sendEnvelopeSchema,
  gateResponseEnvelopeSchema,
  resumeEnvelopeSchema,
  spawnEnvelopeSchema,
  seenEnvelopeSchema,
  clearAttentionEnvelopeSchema,
  killEnvelopeSchema,
  renameEnvelopeSchema,
  adoptEnvelopeSchema,
  discoverEnvelopeSchema,
  pushSubscribeEnvelopeSchema,
  pushUnsubscribeEnvelopeSchema,
  searchEnvelopeSchema,
  searchCancelEnvelopeSchema,
  replacePreviewEnvelopeSchema,
  replaceApplyEnvelopeSchema,
]);

// A resolved cwd must sit within one of the resolved allowlisted roots. Empty
// allowlist = refuse all (path-traversal discipline).
function isWithinProjectRoots(cwd: string, projectRoots: readonly string[]): boolean {
  const candidate = resolve(cwd);
  for (const root of projectRoots) {
    const resolvedRoot = resolve(root);
    if (candidate === resolvedRoot || candidate.startsWith(resolvedRoot + sep)) {
      return true;
    }
  }
  return false;
}

interface HubConnection {
  id: string;
  socket: WebSocket;
  subscriptions: Map<string, () => void>;
  closed: boolean;
}

function rawDataToString(rawData: RawData): string {
  if (typeof rawData === 'string') {
    return rawData;
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString('utf8');
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData.toString('utf8');
  }
  return Buffer.from(new Uint8Array(rawData)).toString('utf8');
}

export interface WsHubDeps {
  router: EventRouter;
  store: EventStore;
  bufferedLimitBytes: number;
  // Test seam (finding E): read a socket's buffered bytes. Overridable so tests
  // can simulate a saturated socket without pushing real megabytes.
  bufferedAmountOf?: (socket: WebSocket) => number;
  // The session host receiving spawn/send/gate_response/resume. Absent → those
  // ops refuse as not-implemented (step-1 posture preserved).
  sessionHost?: SessionHost;
  // Absolute allowlisted roots a spawn cwd must sit within; empty = refuse all.
  projectRoots?: readonly string[];
  // The push subscription cache (step 3). Absent → push_subscribe/unsubscribe
  // refuse as not-implemented.
  pushSubscriptions?: PushSubscriptionSink;
  // Search + replace service (slice 3 step 1). Absent → search/replace ops refuse
  // as not-implemented.
  searchService?: SearchService;
}

export class WsHub {
  private readonly router: EventRouter;
  private readonly store: EventStore;
  private readonly bufferedLimitBytes: number;
  private readonly bufferedAmountOf: (socket: WebSocket) => number;
  private readonly sessionHost: SessionHost | undefined;
  private readonly projectRoots: readonly string[];
  private readonly pushSubscriptions: PushSubscriptionSink | undefined;
  private readonly searchService: SearchService | undefined;
  private readonly webSocketServer: WebSocketServer;
  private readonly connections = new Set<HubConnection>();
  private connectionCounter = 0;

  constructor(deps: WsHubDeps) {
    this.router = deps.router;
    this.store = deps.store;
    this.bufferedLimitBytes = deps.bufferedLimitBytes;
    this.bufferedAmountOf = deps.bufferedAmountOf ?? ((socket) => socket.bufferedAmount);
    this.sessionHost = deps.sessionHost;
    this.projectRoots = deps.projectRoots ?? [];
    this.pushSubscriptions = deps.pushSubscriptions;
    this.searchService = deps.searchService;
    this.webSocketServer = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.registerConnection(webSocket);
    });
  }

  // Total active router subscriptions across all sockets — exposed so tests can
  // assert no leaks after close / backpressure drop.
  activeSubscriptionCount(): number {
    let total = 0;
    for (const connection of this.connections) {
      total += connection.subscriptions.size;
    }
    return total;
  }

  close(): void {
    for (const connection of this.connections) {
      this.tearDownSubscriptions(connection);
      connection.closed = true;
      connection.socket.close(1001, 'server-shutdown');
    }
    this.connections.clear();
    this.webSocketServer.close();
  }

  private registerConnection(socket: WebSocket): void {
    this.connectionCounter += 1;
    const connection: HubConnection = {
      id: `conn-${this.connectionCounter}`,
      socket,
      subscriptions: new Map(),
      closed: false,
    };
    this.connections.add(connection);

    const tearDown = (): void => {
      this.tearDownSubscriptions(connection);
      // Kill any in-flight rg searches this connection owned (no orphaned procs).
      this.searchService?.disposeConnection(connection.id);
      connection.closed = true;
      this.connections.delete(connection);
    };
    socket.on('message', (rawData: RawData) => {
      this.handleMessage(connection, rawData);
    });
    socket.on('close', tearDown);
    // A socket-level error should not crash the daemon; treat like a close.
    socket.on('error', tearDown);
  }

  private tearDownSubscriptions(connection: HubConnection): void {
    for (const unsubscribe of connection.subscriptions.values()) {
      unsubscribe();
    }
    connection.subscriptions.clear();
  }

  private handleMessage(connection: HubConnection, rawData: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(rawData));
    } catch {
      this.sendControl(connection, { op: 'error', reason: 'malformed-json' });
      return;
    }
    const envelope = controlEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      this.sendControl(connection, { op: 'error', reason: 'invalid-envelope' });
      return;
    }
    const control = envelope.data;
    switch (control.op) {
      case 'subscribe':
        this.handleSubscribe(connection, control.stream, control.lastSeq);
        return;
      case 'unsubscribe': {
        const unsubscribe = connection.subscriptions.get(control.stream);
        if (unsubscribe !== undefined) {
          unsubscribe();
          connection.subscriptions.delete(control.stream);
        }
        return;
      }
      case 'spawn':
        this.handleSpawn(connection, control.channel, control.cwd, control.name);
        return;
      case 'send': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'send', 'not-implemented');
          return;
        }
        const result = host.sendMessage(control.appSessionId, control.text);
        if ('refused' in result) {
          this.refuse(connection, 'send', result.reason);
        }
        return;
      }
      case 'gate_response': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'gate_response', 'not-implemented');
          return;
        }
        const result = host.answerGate(control.appSessionId, control.requestId, control.response);
        if ('refused' in result) {
          this.refuse(connection, 'gate_response', result.reason);
        }
        return;
      }
      case 'resume': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'resume', 'not-implemented');
          return;
        }
        const result = host.resumeSession(control.appSessionId);
        if ('refused' in result) {
          this.refuse(connection, 'resume', result.reason);
        }
        return;
      }
      case 'seen': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'seen', 'not-implemented');
          return;
        }
        const result = host.markSeen(control.appSessionId);
        if ('refused' in result) {
          this.refuse(connection, 'seen', result.reason);
        }
        return;
      }
      case 'clear_attention': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'clear_attention', 'not-implemented');
          return;
        }
        const result = host.clearAttention(control.appSessionId);
        if ('refused' in result) {
          this.refuse(connection, 'clear_attention', result.reason);
        }
        return;
      }
      case 'kill': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'kill', 'not-implemented');
          return;
        }
        const result = host.killSession(control.appSessionId);
        if ('refused' in result) {
          this.refuse(connection, 'kill', result.reason);
        }
        return;
      }
      case 'rename': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'rename', 'not-implemented');
          return;
        }
        const result = host.renameSession(control.appSessionId, control.name);
        if ('refused' in result) {
          this.refuse(connection, 'rename', result.reason);
        }
        return;
      }
      case 'adopt': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'adopt', 'not-implemented');
          return;
        }
        const result = host.adoptSession(control.appSessionId);
        if ('refused' in result) {
          this.refuse(connection, 'adopt', result.reason);
        }
        return;
      }
      case 'discover': {
        const host = this.sessionHost;
        if (host === undefined) {
          this.refuse(connection, 'discover', 'not-implemented');
          return;
        }
        const count = host.discoverExternalSessions();
        this.sendControl(connection, { op: 'discovered', count });
        return;
      }
      case 'push_subscribe': {
        const store = this.pushSubscriptions;
        if (store === undefined) {
          this.refuse(connection, 'push_subscribe', 'not-implemented');
          return;
        }
        // Loose URL/keys check beyond the envelope shape (rule 0.6). A bad
        // subscription is refused; the connection survives (hostile-input posture).
        if (!isValidPushSubscription(control.subscription)) {
          this.refuse(connection, 'push_subscribe', 'invalid-subscription');
          return;
        }
        store.save(control.subscription as PushSubscriptionRecord);
        return;
      }
      case 'push_unsubscribe': {
        const store = this.pushSubscriptions;
        if (store === undefined) {
          this.refuse(connection, 'push_unsubscribe', 'not-implemented');
          return;
        }
        store.remove(control.endpoint);
        return;
      }
      case 'search': {
        const search = this.searchService;
        if (search === undefined) {
          this.refuse(connection, 'search', 'not-implemented');
          return;
        }
        search.startSearch(
          connection.id,
          { searchId: control.searchId, root: control.root, query: control.query, flags: control.flags },
          (message) => this.sendControl(connection, message),
        );
        return;
      }
      case 'search_cancel': {
        const search = this.searchService;
        if (search === undefined) {
          this.refuse(connection, 'search_cancel', 'not-implemented');
          return;
        }
        search.cancelSearch(connection.id, { searchId: control.searchId });
        return;
      }
      case 'replace_preview': {
        const search = this.searchService;
        if (search === undefined) {
          this.refuse(connection, 'replace_preview', 'not-implemented');
          return;
        }
        search.replacePreview(
          connection.id,
          {
            searchId: control.searchId,
            root: control.root,
            query: control.query,
            replacement: control.replacement,
            flags: control.flags,
          },
          (message) => this.sendControl(connection, message),
        );
        return;
      }
      case 'replace_apply': {
        const search = this.searchService;
        if (search === undefined) {
          this.refuse(connection, 'replace_apply', 'not-implemented');
          return;
        }
        void search.replaceApply(connection.id, { previewId: control.previewId }, (message) =>
          this.sendControl(connection, message),
        );
        return;
      }
    }
  }

  private handleSpawn(
    connection: HubConnection,
    channel: 'sdk' | 'pty',
    cwd: string,
    name: string | undefined,
  ): void {
    const host = this.sessionHost;
    if (host === undefined) {
      this.refuse(connection, 'spawn', 'not-implemented');
      return;
    }
    // Path-traversal discipline: refuse any cwd outside the configured roots
    // BEFORE a process is asked for (empty allowlist refuses all).
    if (!isWithinProjectRoots(cwd, this.projectRoots)) {
      this.refuse(connection, 'spawn', 'cwd-outside-project-roots');
      return;
    }
    const result = host.spawnSession({ channel, cwd, name });
    if ('refused' in result) {
      this.refuse(connection, 'spawn', result.reason);
      return;
    }
    this.sendControl(connection, { op: 'spawned', appSessionId: result.appSessionId });
  }

  private refuse(connection: HubConnection, refusedOp: string, reason: string): void {
    this.sendControl(connection, { op: 'refused', refusedOp, reason });
  }

  private handleSubscribe(connection: HubConnection, stream: string, lastSeq: number): void {
    const head = this.store.head(stream);
    // Order (documented in the envelope test): `subscribed` BEFORE any replay,
    // then replay (lastSeq+1..head, delivered synchronously by router.subscribe),
    // then live.
    this.sendControl(connection, { op: 'subscribed', stream, head });

    const existing = connection.subscriptions.get(stream);
    if (existing !== undefined) {
      existing();
      connection.subscriptions.delete(stream);
    }
    const unsubscribe = this.router.subscribe(stream, lastSeq, (event) => {
      this.sendEvent(connection, event);
    });
    connection.subscriptions.set(stream, unsubscribe);
  }

  private sendEvent(connection: HubConnection, event: EventRecord): void {
    if (connection.closed) {
      return;
    }
    // Backpressure (finding E): a socket past the buffered ceiling is dropped and
    // its subscriptions released; the client reconnects and resubscribes with
    // lastSeq — the same replay path as any disconnect.
    if (this.bufferedAmountOf(connection.socket) > this.bufferedLimitBytes) {
      this.tearDownSubscriptions(connection);
      connection.closed = true;
      connection.socket.close(1013, 'backpressure');
      return;
    }
    this.sendControl(connection, { op: 'event', event });
  }

  private sendControl(connection: HubConnection, message: unknown): void {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    connection.socket.send(JSON.stringify(message));
  }
}
