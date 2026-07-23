import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { EventRecord, EventStore } from '@vimes/core';
import { EventRouter, correctionQueued } from '@vimes/core';
import type { SessionHost } from './sessionHost.js';
import { isValidPushSubscription, type PushSubscriptionRecord } from './pushService.js';
import type { SearchService } from './search.js';
import type { TerminalHost, TerminalSubscriber } from './terminalHost.js';

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
// v0.5 (slice 3 step 3): raw terminal control ops. Byte PAYLOADS ride BINARY WS
// frames (never JSON, never zod — rule 0.8); ONLY these control envelopes are
// validated. term_open mints a shell PTY (cwd scoped in the terminal host);
// term_subscribe attaches this connection at a byte offset; term_resize / term_close
// operate an existing terminal.
const termOpenEnvelopeSchema = z.object({
  op: z.literal('term_open'),
  cwd: z.string().min(1),
  // Optional initial pty size (mobile terminal-corruption fix): when the
  // client has already fitted its viewport, it sizes the shell BEFORE the
  // first byte renders instead of resizing after the fact. Absent/invalid →
  // the terminal host's own 80x24 default.
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
const termSubscribeEnvelopeSchema = z.object({
  op: z.literal('term_subscribe'),
  terminalId: z.string().min(1),
  offset: z.number().int().nonnegative(),
});
const termResizeEnvelopeSchema = z.object({
  op: z.literal('term_resize'),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
const termCloseEnvelopeSchema = z.object({
  op: z.literal('term_close'),
  terminalId: z.string().min(1),
});
// Terminal-lifecycle backlog item: flip a shell's resilient flag (exempt it from
// the inactivity reaper). A keeper the operator marks from the terminals list.
const termSetResilientEnvelopeSchema = z.object({
  op: z.literal('term_set_resilient'),
  terminalId: z.string().min(1),
  resilient: z.boolean(),
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
  termOpenEnvelopeSchema,
  termSubscribeEnvelopeSchema,
  termResizeEnvelopeSchema,
  termCloseEnvelopeSchema,
  termSetResilientEnvelopeSchema,
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

// Per-connection terminal attachment: a compact byte-tag maps to a terminalId so
// binary frames stay tiny (`[uint8 tag][...payload]`). The subscriber is the
// terminal host's live-output sink for this (connection, tag).
interface TerminalAttachment {
  tag: number;
  terminalId: string;
  subscriber: TerminalSubscriber;
}

interface HubConnection {
  id: string;
  socket: WebSocket;
  subscriptions: Map<string, () => void>;
  // Terminal byte-tag maps for this connection (both directions) + the tag counter.
  terminalByTag: Map<number, TerminalAttachment>;
  tagByTerminalId: Map<string, number>;
  nextTerminalTag: number;
  closed: boolean;
}

function rawDataToBuffer(rawData: RawData): Buffer {
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData);
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }
  return Buffer.from(rawData as ArrayBuffer);
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
  // Raw terminal host (slice 3 step 3). Absent → term_* ops refuse as
  // not-implemented and binary frames are dropped.
  terminalHost?: TerminalHost;
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
  private readonly terminalHost: TerminalHost | undefined;
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
    this.terminalHost = deps.terminalHost;
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
      terminalByTag: new Map(),
      tagByTerminalId: new Map(),
      nextTerminalTag: 0,
      closed: false,
    };
    this.connections.add(connection);

    const tearDown = (): void => {
      this.tearDownSubscriptions(connection);
      // Detach this connection from every terminal it was watching. The shells
      // OUTLIVE the connection (a phone reconnect re-subscribes with its offset);
      // a terminal dies only on explicit term_close or daemon exit.
      this.detachAllTerminals(connection);
      // Kill any in-flight rg searches this connection owned (no orphaned procs).
      this.searchService?.disposeConnection(connection.id);
      connection.closed = true;
      this.connections.delete(connection);
    };
    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Byte payloads for a terminal — never parsed, never validated (rule 0.8).
        this.handleBinaryFrame(connection, rawData);
        return;
      }
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
          // ⚠ A REFUSED SEND EMITS NOTHING. Nothing was queued, so there is no
          // correction to record — and a `correction_queued` for a send the host
          // rejected would make the watchdog protect a run nobody is steering,
          // i.e. switch the staleness guard off on a run that can then wedge
          // silently forever.
          this.refuse(connection, 'send', result.reason);
          return;
        }
        // ⚠ THE EMIT SITS AFTER THE HOST HAS SAID IT SUCCEEDED, never before.
        // This is the boundary that KNOWS: `sendMessage` returns `{ok:true}`
        // only once the text has actually reached the live process's
        // streaming-input queue (D5 — steer = inject). Emitting optimistically
        // ahead of that would record a queued correction for a send that could
        // still refuse (external custody, dead session, resume failure).
        //
        // D5: this is the correction's ONLY entry point. The WS `send` op is the
        // existing path and the mechanism already ships; a second route (an HTTP
        // correction endpoint) would be a second writer of the same fact.
        this.router.emit([
          correctionQueued({ appSessionId: control.appSessionId, text: control.text }),
        ]);
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
      case 'term_open': {
        const host = this.terminalHost;
        if (host === undefined) {
          this.refuse(connection, 'term_open', 'not-implemented');
          return;
        }
        // The cwd scoping (resolveWithinRoots against projectRoots ∪ session cwds)
        // lives in the terminal host — the single RCE boundary (spec §3.11).
        const result = host.openTerminal({ cwd: control.cwd, cols: control.cols, rows: control.rows });
        if ('refused' in result) {
          this.refuse(connection, 'term_open', result.reason);
          return;
        }
        this.sendControl(connection, { op: 'term_opened', terminalId: result.terminalId });
        return;
      }
      case 'term_subscribe': {
        this.handleTermSubscribe(connection, control.terminalId, control.offset);
        return;
      }
      case 'term_resize': {
        const host = this.terminalHost;
        if (host === undefined) {
          this.refuse(connection, 'term_resize', 'not-implemented');
          return;
        }
        const result = host.resize(control.terminalId, control.cols, control.rows);
        if ('refused' in result) {
          this.refuse(connection, 'term_resize', result.reason);
        }
        return;
      }
      case 'term_close': {
        const host = this.terminalHost;
        if (host === undefined) {
          this.refuse(connection, 'term_close', 'not-implemented');
          return;
        }
        const result = host.closeTerminal(control.terminalId);
        if ('refused' in result) {
          this.refuse(connection, 'term_close', result.reason);
        }
        // The terminal host's exit signal (via the subscriber) tears down this
        // connection's tag mapping — no extra cleanup needed here.
        return;
      }
      case 'term_set_resilient': {
        const host = this.terminalHost;
        if (host === undefined) {
          this.refuse(connection, 'term_set_resilient', 'not-implemented');
          return;
        }
        const result = host.setResilient(control.terminalId, control.resilient);
        if ('refused' in result) {
          this.refuse(connection, 'term_set_resilient', result.reason);
        }
        return;
      }
    }
  }

  // ── raw terminal (binary frames + subscribe) ────────────────────────────────
  private handleTermSubscribe(connection: HubConnection, terminalId: string, offset: number): void {
    const host = this.terminalHost;
    if (host === undefined) {
      this.refuse(connection, 'term_subscribe', 'not-implemented');
      return;
    }
    // Assign (or reuse) this connection's compact byte-tag for the terminal, then
    // build the live-output subscriber that frames bytes as `[tag][...payload]`.
    let tag = connection.tagByTerminalId.get(terminalId);
    if (tag === undefined) {
      if (connection.nextTerminalTag > 255) {
        // 256 concurrent terminals on ONE socket is far past the escape-hatch use;
        // refuse rather than overflow the 1-byte tag.
        this.refuse(connection, 'term_subscribe', 'too-many-terminals');
        return;
      }
      tag = connection.nextTerminalTag;
      connection.nextTerminalTag += 1;
    }
    const byteTag = tag;
    const subscriber: TerminalSubscriber = {
      output: (bytes) => this.sendTerminalBytes(connection, byteTag, bytes),
      lost: () => this.sendControl(connection, { op: 'term_lost', terminalId }),
      exit: (exitCode) => {
        this.sendControl(connection, { op: 'term_exit', terminalId, exitCode });
        this.detachTerminal(connection, terminalId);
      },
    };
    const result = host.subscribe(terminalId, offset, subscriber);
    if ('refused' in result) {
      this.refuse(connection, 'term_subscribe', result.reason);
      return;
    }
    connection.tagByTerminalId.set(terminalId, byteTag);
    connection.terminalByTag.set(byteTag, { tag: byteTag, terminalId, subscriber });
    // Tell the client which tag carries this terminal's bytes (both directions).
    this.sendControl(connection, { op: 'term_subscribed', terminalId, tag: byteTag });
  }

  private handleBinaryFrame(connection: HubConnection, rawData: RawData): void {
    const host = this.terminalHost;
    if (host === undefined) {
      return; // no terminal surface — drop
    }
    const frame = rawDataToBuffer(rawData);
    if (frame.length < 1) {
      return; // empty frame — drop (no crash)
    }
    const tag = frame[0]!;
    const attachment = connection.terminalByTag.get(tag);
    if (attachment === undefined) {
      return; // unknown/unsubscribed tag — drop, never crash
    }
    // Raw input relay: everything past the tag byte is written verbatim (rule 0.8).
    host.writeInput(attachment.terminalId, new Uint8Array(frame.subarray(1)));
  }

  private sendTerminalBytes(connection: HubConnection, tag: number, bytes: Uint8Array): void {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = Buffer.allocUnsafe(bytes.length + 1);
    frame[0] = tag & 0xff;
    Buffer.from(bytes).copy(frame, 1);
    connection.socket.send(frame, { binary: true });
  }

  // Detach one terminal's tag mapping from a connection (without touching the
  // shell) — used on term_exit and per-terminal cleanup.
  private detachTerminal(connection: HubConnection, terminalId: string): void {
    const tag = connection.tagByTerminalId.get(terminalId);
    if (tag !== undefined) {
      connection.terminalByTag.delete(tag);
      connection.tagByTerminalId.delete(terminalId);
    }
  }

  // On socket close: unsubscribe from every attached terminal so the host stops
  // broadcasting to a dead socket. The shells survive (reconnect re-subscribes).
  private detachAllTerminals(connection: HubConnection): void {
    const host = this.terminalHost;
    for (const attachment of connection.terminalByTag.values()) {
      host?.unsubscribe(attachment.terminalId, attachment.subscriber);
    }
    connection.terminalByTag.clear();
    connection.tagByTerminalId.clear();
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
