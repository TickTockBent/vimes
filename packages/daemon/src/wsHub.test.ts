import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { CountingIdSource, SteppingClock, canonicalJson, type EventRecord } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { PtyLike, PtySpawnFactory } from './sessionHost.js';

// A fake PTY that satisfies the seam without spawning anything real (no Claude in
// CI). Its transcript would come only from the tailer, unused here.
function makeFakePty(): PtyLike {
  return { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} };
}
const fakePtySpawnFactory: PtySpawnFactory = () => makeFakePty();

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-wshub-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `wshub-${databaseFileCounter}.db`);
}

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: nextDatabasePath(),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    ...overrides,
  };
}

function startDaemon(overrides: Partial<Parameters<typeof createDaemon>[0]> = {}): Promise<Daemon> {
  const daemon = createDaemon({
    config: buildConfig(),
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier: permissiveVerifier,
    ...overrides,
  });
  return daemon.start().then(() => daemon);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await delay(10);
  }
}

interface OutboundMessage {
  op: string;
  [key: string]: unknown;
}

class WsTestClient {
  readonly socket: WebSocket;
  readonly messages: OutboundMessage[] = [];
  closeCode: number | undefined;

  constructor(port: number, token: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'cf-access-jwt-assertion': token },
    });
    this.socket.on('message', (rawData: RawData) => {
      this.messages.push(JSON.parse(rawData.toString()) as OutboundMessage);
    });
    this.socket.on('close', (code: number) => {
      this.closeCode = code;
    });
  }

  opened(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket.once('open', () => resolvePromise());
      this.socket.once('error', rejectPromise);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(rawText: string): void {
    this.socket.send(rawText);
  }

  waitForMessageCount(count: number): Promise<void> {
    return waitUntil(() => this.messages.length >= count);
  }

  waitForClose(): Promise<number> {
    return waitUntil(() => this.closeCode !== undefined).then(() => this.closeCode!);
  }

  close(): void {
    this.socket.close();
  }
}

interface RawUpgradeProbeResult {
  opened: boolean;
  statusCode: number | undefined;
}

// A bare upgrade probe (no protocol client behavior) — used to observe the
// raw HTTP status of a rejected upgrade rather than a live WS connection.
function probeRawUpgrade(port: number, path: string, token: string): Promise<RawUpgradeProbeResult> {
  return new Promise((resolvePromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { 'cf-access-jwt-assertion': token },
    });
    socket.on('open', () => {
      socket.close();
      resolvePromise({ opened: true, statusCode: 101 });
    });
    socket.on('unexpected-response', (_request, response) => {
      resolvePromise({ opened: false, statusCode: response.statusCode });
      response.destroy();
    });
    socket.on('error', () => {
      resolvePromise({ opened: false, statusCode: undefined });
    });
  });
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('WsHub protocol v0 over a live daemon', () => {
  it('subscribe(lastSeq 0): subscribed BEFORE replay, then live — byte-exact events vs the store', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      daemon.router.emit([
        { stream: 's1', type: 'x', payload: { n: 1 } },
        { stream: 's1', type: 'x', payload: { n: 2 } },
        { stream: 's1', type: 'x', payload: { n: 3 } },
      ]);
      await client.opened();
      client.send({ op: 'subscribe', stream: 's1', lastSeq: 0 });

      // subscribed + 3 replay.
      await client.waitForMessageCount(4);
      expect(client.messages[0]).toEqual({ op: 'subscribed', stream: 's1', head: 3 });

      const storeRecords = daemon.store.read('s1', 1, 3);
      for (let index = 0; index < 3; index += 1) {
        const outbound = client.messages[index + 1]!;
        expect(outbound.op).toBe('event');
        expect(canonicalJson(outbound.event)).toBe(canonicalJson(storeRecords[index]));
      }

      // Live event arrives after replay, same byte-exact framing.
      const [liveRecord] = daemon.router.emit([{ stream: 's1', type: 'x', payload: { n: 4 } }]);
      await client.waitForMessageCount(5);
      const liveOutbound = client.messages[4]!;
      expect(liveOutbound.op).toBe('event');
      expect(canonicalJson(liveOutbound.event)).toBe(canonicalJson(liveRecord));
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('reconnect with lastSeq=n replays exactly n+1..head and nothing more (I2 over the wire)', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      daemon.router.emit(
        Array.from({ length: 5 }, (_unused, index) => ({ stream: 's1', type: 'x', payload: { n: index + 1 } })),
      );
      await client.opened();
      client.send({ op: 'subscribe', stream: 's1', lastSeq: 2 });

      await client.waitForMessageCount(4); // subscribed + events 3,4,5
      await delay(50); // give any (erroneous) extra frames a chance to arrive

      expect(client.messages[0]).toEqual({ op: 'subscribed', stream: 's1', head: 5 });
      const deliveredSeqs = client.messages
        .slice(1)
        .map((message) => (message.event as EventRecord).seq);
      expect(deliveredSeqs).toEqual([3, 4, 5]);
      expect(client.messages.length).toBe(4);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('malformed JSON and unknown ops yield error envelopes; the connection survives', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();

      client.sendRaw('this is not json');
      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({ op: 'error', reason: 'malformed-json' });

      client.send({ op: 'bogus-op', whatever: true });
      await client.waitForMessageCount(2);
      expect(client.messages[1]).toEqual({ op: 'error', reason: 'invalid-envelope' });

      // Still alive: a valid subscribe is answered.
      client.send({ op: 'subscribe', stream: 'empty', lastSeq: 0 });
      await client.waitForMessageCount(3);
      expect(client.messages[2]).toEqual({ op: 'subscribed', stream: 'empty', head: 0 });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('send / gate_response / resume against an unknown session are refused with a reason (host wired, step 2)', async () => {
    // The host is now wired in createDaemon, so these ops are IMPLEMENTED. Against
    // a session that does not exist they refuse cleanly (never spawn anything).
    const daemon = await startDaemon({ projectsRoot: temporaryDirectory });
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();

      client.send({ op: 'send', appSessionId: 'app-unknown', text: 'hello' });
      client.send({ op: 'gate_response', appSessionId: 'app-unknown', requestId: 'req-1', response: 'allow' });
      client.send({ op: 'resume', appSessionId: 'app-unknown' });

      await client.waitForMessageCount(3);
      expect(client.messages).toEqual([
        // send now shares resume's truthful reason for a session that does not
        // exist (send to a dormant/interrupted session auto-resumes, so the
        // distinct refusals are unknown-session / session-dead / spawning-in-flight).
        { op: 'refused', refusedOp: 'send', reason: 'unknown-session' },
        { op: 'refused', refusedOp: 'gate_response', reason: 'unknown-gate' },
        { op: 'refused', refusedOp: 'resume', reason: 'unknown-session' },
      ]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('spawn: a cwd within the project roots creates a session and replies { op: spawned }', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ projectRoots: [temporaryDirectory] }),
      ptySpawnFactory: fakePtySpawnFactory,
      projectsRoot: temporaryDirectory,
    });
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'spawn', channel: 'pty', cwd: temporaryDirectory, name: 'via-ws' });

      await client.waitForMessageCount(1);
      const reply = client.messages[0]!;
      expect(reply.op).toBe('spawned');
      expect(typeof reply.appSessionId).toBe('string');
      expect(daemon.sessionHost.isLive(reply.appSessionId as string)).toBe(true);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('spawn: a cwd outside the project roots is refused (path-traversal discipline)', async () => {
    const daemon = await startDaemon({
      config: buildConfig({ projectRoots: [temporaryDirectory] }),
      ptySpawnFactory: fakePtySpawnFactory,
      projectsRoot: temporaryDirectory,
    });
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'spawn', channel: 'pty', cwd: '/etc', name: 'nope' });

      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({
        op: 'refused',
        refusedOp: 'spawn',
        reason: 'cwd-outside-project-roots',
      });
      expect(daemon.sessionHost.liveProcessCount()).toBe(0);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('backpressure: a saturated socket is closed 1013 and leaves no router subscriptions', async () => {
    const daemon = await startDaemon({ wsBufferedAmountOf: () => 1_000_000_000 });
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'subscribe', stream: 's1', lastSeq: 0 }); // head 0, no replay
      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({ op: 'subscribed', stream: 's1', head: 0 });
      expect(daemon.wsHub.activeSubscriptionCount()).toBe(1);

      // The next event send trips the buffered-bytes ceiling.
      daemon.router.emit([{ stream: 's1', type: 'x', payload: { n: 1 } }]);
      const closeCode = await client.waitForClose();
      expect(closeCode).toBe(1013);
      await waitUntil(() => daemon.wsHub.activeSubscriptionCount() === 0);
    } finally {
      await daemon.stop();
    }
  });

  it('closing a socket releases every router subscription it held', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'subscribe', stream: 's1', lastSeq: 0 });
      client.send({ op: 'subscribe', stream: 's2', lastSeq: 0 });
      await client.waitForMessageCount(2);
      expect(daemon.wsHub.activeSubscriptionCount()).toBe(2);

      client.close();
      await waitUntil(() => daemon.wsHub.activeSubscriptionCount() === 0);
    } finally {
      await daemon.stop();
    }
  });

  it('authed upgrade to any path other than /ws is rejected 404 and never reaches the hub', async () => {
    const daemon = await startDaemon();
    try {
      const result = await probeRawUpgrade(daemon.port, '/notws', ANY_TOKEN);
      expect(result.opened).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(daemon.wsHub.activeSubscriptionCount()).toBe(0);
    } finally {
      await daemon.stop();
    }
  });
});

// ── protocol v0.2 session ops (D9/D10) over the wire ──────────────────────────
describe('WsHub protocol v0.2 session ops', () => {
  it('discover replies {op:"discovered", count} (empty project roots → 0)', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'discover' });
      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({ op: 'discovered', count: 0 });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('kill / seen / clear_attention / adopt on an unknown session refuse (routed to the host)', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'kill', appSessionId: 'nope' });
      client.send({ op: 'seen', appSessionId: 'nope' });
      client.send({ op: 'clear_attention', appSessionId: 'nope' });
      client.send({ op: 'adopt', appSessionId: 'nope' });
      await client.waitForMessageCount(4);
      expect(client.messages).toEqual([
        { op: 'refused', refusedOp: 'kill', reason: 'unknown-session' },
        { op: 'refused', refusedOp: 'seen', reason: 'unknown-session' },
        { op: 'refused', refusedOp: 'clear_attention', reason: 'unknown-session' },
        { op: 'refused', refusedOp: 'adopt', reason: 'unknown-session' },
      ]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('rename with an empty name is rejected at the envelope boundary (zod min length)', async () => {
    const daemon = await startDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'rename', appSessionId: 'x', name: '' });
      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({ op: 'error', reason: 'invalid-envelope' });
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});
