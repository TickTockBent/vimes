import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { EventRecord, EventStore } from '@vimes/core';
import { EventRouter } from '@vimes/core';

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

const controlEnvelopeSchema = z.discriminatedUnion('op', [
  subscribeEnvelopeSchema,
  unsubscribeEnvelopeSchema,
  sendEnvelopeSchema,
  gateResponseEnvelopeSchema,
  resumeEnvelopeSchema,
]);

const NOT_IMPLEMENTED_OPS = new Set(['send', 'gate_response', 'resume']);

interface HubConnection {
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
}

export class WsHub {
  private readonly router: EventRouter;
  private readonly store: EventStore;
  private readonly bufferedLimitBytes: number;
  private readonly bufferedAmountOf: (socket: WebSocket) => number;
  private readonly webSocketServer: WebSocketServer;
  private readonly connections = new Set<HubConnection>();

  constructor(deps: WsHubDeps) {
    this.router = deps.router;
    this.store = deps.store;
    this.bufferedLimitBytes = deps.bufferedLimitBytes;
    this.bufferedAmountOf = deps.bufferedAmountOf ?? ((socket) => socket.bufferedAmount);
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
    const connection: HubConnection = { socket, subscriptions: new Map(), closed: false };
    this.connections.add(connection);

    socket.on('message', (rawData: RawData) => {
      this.handleMessage(connection, rawData);
    });
    socket.on('close', () => {
      this.tearDownSubscriptions(connection);
      connection.closed = true;
      this.connections.delete(connection);
    });
    // A socket-level error should not crash the daemon; treat like a close.
    socket.on('error', () => {
      this.tearDownSubscriptions(connection);
      connection.closed = true;
      this.connections.delete(connection);
    });
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
      default:
        // send / gate_response / resume — shapes valid, behavior is step 2.
        if (NOT_IMPLEMENTED_OPS.has(control.op)) {
          this.sendControl(connection, { op: 'refused', refusedOp: control.op, reason: 'not-implemented' });
        }
        return;
    }
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
