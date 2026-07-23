import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import {
  CountingIdSource,
  SteppingClock,
  canonicalJson,
  readAllStreamsGrouped,
  replayFromEmpty,
  runCompleted,
  sessionsProjection,
  withNotificationTrigger,
  type EventRecord,
  type SessionRecord,
} from '@vimes/core';
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
    expectedSdkCliVersion: undefined,
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
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    // The stage-run watchdog (slice 6 step 5b): DISABLED in tests — 0 means the
    // daemon never creates the timer, so no test daemon can wake up and write
    // attention/notifications behind a case's back. The policy values are inert
    // while the interval is 0.
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    // Worker isolation (slice 6 step 8): OFF in tests, which is also the shipped
    // default — so no test daemon can create a worktree, and this root is never
    // touched. The flip is a human's; see taskDispatcher.ts's isolation block.
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
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

// ─── slice 6 — the send boundary evented (D5), GATED ON AN IN-FLIGHT TURN (D35)
//
// ⚠ NO REAL CLAUDE. The session is a PTY session backed by `fakePtySpawnFactory`,
// so `sendMessage` reaches a live process that writes nowhere. Nothing here
// touches the live daemon, its sessions or its terminals.
//
// ⚠ **WHAT CHANGED, AND WHY THESE CASES INVERTED.** Step 6a emitted
// `correction_queued` on EVERY accepted send, and this block asserted exactly
// that. A real operator then sent a FIRST prompt to a freshly spawned session
// and was told "Correction queued" for a correction he had not made — and it
// never cleared, because on the SDK channel nothing can observe delivery. D35
// halted the slice over it: **a correction is a steer of an IN-FLIGHT TURN.** So
// the opening prompt now emits nothing, and the cases below pin the phantom
// rather than the behaviour that produced it.
describe('WsHub — correction_queued is emitted only for a steer of an in-flight turn (D35)', () => {
  function sessionEventTypesOn(daemon: Daemon, appSessionId: string): string[] {
    return daemon.store
      .read(appSessionId, 1, daemon.store.head(appSessionId))
      .map((event) => event.type);
  }

  function correctionQueuedEventsOn(daemon: Daemon, appSessionId: string): EventRecord[] {
    return daemon.store
      .read(appSessionId, 1, daemon.store.head(appSessionId))
      .filter((event) => event.type === 'correction_queued');
  }

  // The projection as the daemon itself folds it — never a hand-stubbed record.
  function sessionRecordOn(daemon: Daemon, appSessionId: string): SessionRecord | undefined {
    return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(daemon.store)).sessions[
      appSessionId
    ];
  }

  async function spawnPtySession(
    daemon: Daemon,
    client: WsTestClient,
    name: string,
  ): Promise<string> {
    client.send({ op: 'spawn', channel: 'pty', cwd: temporaryDirectory, name });
    await client.waitForMessageCount(1);
    return client.messages[0]!.appSessionId as string;
  }

  function startSteerableDaemon(): Promise<Daemon> {
    return startDaemon({
      config: buildConfig({ projectRoots: [temporaryDirectory] }),
      ptySpawnFactory: fakePtySpawnFactory,
      projectsRoot: temporaryDirectory,
    });
  }

  // ASSERTION 8 — THE PHANTOM, PINNED.
  it('a FIRST prompt to an idle session emits the message and NO correction_queued', async () => {
    const daemon = await startSteerableDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      const appSessionId = await spawnPtySession(daemon, client, 'freshly-spawned');

      client.send({ op: 'send', appSessionId, text: 'synthetic opening prompt' });
      // Wait on the echo the host writes for the turn, then prove what did NOT
      // follow it. (Waiting on an absence needs a positive event to wait for.)
      await waitUntil(() => sessionEventTypesOn(daemon, appSessionId).includes('message'));
      await delay(50);

      // ⚠ THE EVENT LIST, not a count: a correction hiding anywhere in the
      // session's stream fails this, and the list also shows the echo DID happen
      // so the case cannot pass by the send having quietly done nothing.
      expect(sessionEventTypesOn(daemon, appSessionId)).not.toContain('correction_queued');
      expect(sessionEventTypesOn(daemon, appSessionId)).toContain('message');
      expect(client.messages.filter((m) => m.op === 'refused')).toEqual([]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  // ASSERTION 10 — THE ORDERING HAZARD, PINNED.
  it('the decision uses the PRE-SEND flag: the turn flips to in-flight DURING the send, and still no correction', async () => {
    // ⚠ THIS IS THE CASE THAT MUST REDDEN IF SOMEONE MOVES THE READ AFTER
    // `sendMessage`. The host echoes the operator's turn as
    // `message(role:'user')` BEFORE the text reaches the process (D12), and
    // `message` is exactly what sets `turnInFlight` — so by the time
    // `sendMessage` returns, the flag is TRUE. The two expectations below are
    // therefore contradictory unless the flag was captured beforehand: the
    // session IS mid-turn now, and no correction was recorded.
    const daemon = await startSteerableDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      const appSessionId = await spawnPtySession(daemon, client, 'ordering-hazard');

      // Before the send: no turn in flight (the process is live — liveness is
      // NOT the same fact, which is the other half of D35).
      expect(sessionRecordOn(daemon, appSessionId)!.turnInFlight).toBeUndefined();
      expect(sessionRecordOn(daemon, appSessionId)!.liveness).toBe('running');

      client.send({ op: 'send', appSessionId, text: 'synthetic opening prompt' });
      await waitUntil(() => sessionRecordOn(daemon, appSessionId)?.turnInFlight === true);
      await delay(50);

      // The flag DID flip during the send...
      expect(sessionRecordOn(daemon, appSessionId)!.turnInFlight).toBe(true);
      // ...and the decision still used the value from before it.
      expect(correctionQueuedEventsOn(daemon, appSessionId)).toEqual([]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  // ASSERTION 9 — the genuine steer still works, exactly as it did.
  it('a send while a turn IS in flight emits EXACTLY ONE correction_queued carrying the operator text', async () => {
    const daemon = await startSteerableDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      const appSessionId = await spawnPtySession(daemon, client, 'steered');

      // The turn that starts the run — no correction for this one.
      client.send({ op: 'send', appSessionId, text: 'synthetic opening prompt' });
      await waitUntil(() => sessionRecordOn(daemon, appSessionId)?.turnInFlight === true);

      // The steer, mid-turn.
      client.send({ op: 'send', appSessionId, text: 'synthetic steer: prefer the smaller change' });
      await waitUntil(() => correctionQueuedEventsOn(daemon, appSessionId).length > 0);
      await delay(50);

      const corrections = correctionQueuedEventsOn(daemon, appSessionId);
      expect(corrections).toHaveLength(1);
      expect(corrections[0]!.payload).toEqual({
        appSessionId,
        text: 'synthetic steer: prefer the smaller change',
      });
      expect(client.messages.filter((m) => m.op === 'refused')).toEqual([]);
      // ⚠ ORDERING: the event lands AFTER the host's own `message(role:'user')`
      // echo of the same turn. That order is what makes the watchdog's
      // protection work — `correctionQueuedAt` must be at or after the last
      // heartbeat, and the echo IS a heartbeat.
      const sessionEvents = daemon.store.read(appSessionId, 1, daemon.store.head(appSessionId));
      const correctionIndex = sessionEvents.findIndex(
        (event) => event.type === 'correction_queued',
      );
      const echoIndex = sessionEvents.findLastIndex((event) => event.type === 'message');
      expect(echoIndex).toBeGreaterThanOrEqual(0);
      expect(correctionIndex).toBeGreaterThan(echoIndex);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('three sends into a running turn emit exactly two — one per STEER, never one per send', async () => {
    const daemon = await startSteerableDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      const appSessionId = await spawnPtySession(daemon, client, 'steered-thrice');

      // Sends are handled in order on one socket, so the first is the opening
      // prompt and the other two are steers of the turn it started.
      for (const text of ['synthetic opening prompt', 'synthetic steer two', 'synthetic steer three']) {
        client.send({ op: 'send', appSessionId, text });
      }
      await waitUntil(() => correctionQueuedEventsOn(daemon, appSessionId).length >= 2);
      await delay(50);

      const corrections = correctionQueuedEventsOn(daemon, appSessionId);
      expect(corrections.map((event) => (event.payload as { text: string }).text)).toEqual([
        'synthetic steer two',
        'synthetic steer three',
      ]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  // The D35 TRACE, END TO END — assertions 8–11 composed into the sequence the
  // operator actually ran: spawn, first prompt, mid-run steer, the turn ends,
  // and a prompt into the now-idle session.
  it('replays the D35 trace: spawn → prompt → steer → run_completed → prompt', async () => {
    const daemon = await startSteerableDaemon();
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      const appSessionId = await spawnPtySession(daemon, client, 'the-d35-trace');

      // 1. The opening prompt — NOT a correction.
      client.send({ op: 'send', appSessionId, text: 'synthetic opening prompt' });
      await waitUntil(() => sessionRecordOn(daemon, appSessionId)?.turnInFlight === true);
      expect(correctionQueuedEventsOn(daemon, appSessionId)).toEqual([]);

      // 2. A steer of that in-flight turn — a correction.
      client.send({ op: 'send', appSessionId, text: 'synthetic steer: mid-run' });
      await waitUntil(() => correctionQueuedEventsOn(daemon, appSessionId).length === 1);
      expect(sessionRecordOn(daemon, appSessionId)!.pendingCorrectionAt).not.toBeNull();

      // 3. The turn ends. THE LOAD-BEARING CLEAR: no `correction_delivered` will
      // ever arrive for this steer (on the SDK channel none can), so if
      // `run_completed` did not clear it, the indicator would stick forever —
      // which is the bug as reported.
      daemon.router.emit(withNotificationTrigger(runCompleted({ appSessionId })));
      await waitUntil(() => sessionRecordOn(daemon, appSessionId)?.turnInFlight === false);
      const afterCompletion = sessionRecordOn(daemon, appSessionId)!;
      expect(afterCompletion.pendingCorrectionAt).toBeNull();
      expect(afterCompletion.turnInFlight).toBe(false);
      expect(
        sessionEventTypesOn(daemon, appSessionId).includes('correction_delivered'),
        'no delivery was ever observed — run_completed is what cleared it',
      ).toBe(false);

      // 4. A prompt into the now-idle session — NOT a correction, even though
      // the session has been steered before and the process is still live.
      client.send({ op: 'send', appSessionId, text: 'synthetic second opening prompt' });
      await waitUntil(() => sessionRecordOn(daemon, appSessionId)?.turnInFlight === true);
      await delay(50);
      expect(correctionQueuedEventsOn(daemon, appSessionId)).toHaveLength(1);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  // ASSERTION 11.
  it('a REFUSED send emits NOTHING — nothing was queued', async () => {
    // ⚠ THE HALF THAT MATTERS MOST. A `correction_queued` for a send the host
    // rejected would set `pendingCorrectionAt` on a run nobody is steering — and
    // that switches the staleness guard OFF on a run that can then wedge
    // silently forever. The refusal path must write nothing at all.
    const daemon = await startDaemon({ projectsRoot: temporaryDirectory });
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();
      client.send({ op: 'send', appSessionId: 'app-unknown', text: 'synthetic steer at a ghost' });
      await client.waitForMessageCount(1);
      expect(client.messages[0]).toEqual({
        op: 'refused',
        refusedOp: 'send',
        reason: 'unknown-session',
      });
      // Give the emit path a chance to have fired, then prove it did not.
      await delay(50);
      expect(correctionQueuedEventsOn(daemon, 'app-unknown')).toEqual([]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});
