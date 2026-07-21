import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { PtyLike, PtySpawnFactory } from './sessionHost.js';
import type { TerminalPtyFactory, TerminalPtyLike } from './terminalHost.js';

// Raw-terminal WS integration: binary byte frames + term control ops over a live
// daemon, with a FAKE shell pty (no real shell in CI — spec §7).

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-termws-'));
let databaseFileCounter = 0;
const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `termws-${databaseFileCounter}.db`);
}

// The claude-session pty seam is unused here but createDaemon wants a factory.
const fakeClaudePtyFactory: PtySpawnFactory = (): PtyLike => ({
  write: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
});

interface FakeTerminal {
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  spawnDimensions: { cols: number | undefined; rows: number | undefined };
  fireData: (data: string) => void;
  fireExit: (exitCode?: number) => void;
  killed: () => boolean;
}

function makeTerminalPtyFactory(): { factory: TerminalPtyFactory; created: FakeTerminal[] } {
  const created: FakeTerminal[] = [];
  const factory: TerminalPtyFactory = (_file, _args, options): TerminalPtyLike => {
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    let dataCallback: ((data: string) => void) | undefined;
    let exitCallback: ((event: { exitCode: number }) => void) | undefined;
    let wasKilled = false;
    created.push({
      writes,
      resizes,
      spawnDimensions: { cols: options.cols, rows: options.rows },
      fireData: (data) => dataCallback?.(data),
      fireExit: (exitCode = 0) => exitCallback?.({ exitCode }),
      killed: () => wasKilled,
    });
    return {
      write: (data) => writes.push(data),
      resize: (cols, rows) => resizes.push({ cols, rows }),
      kill: () => {
        wasKilled = true;
      },
      onData: (callback) => {
        dataCallback = callback;
      },
      onExit: (callback) => {
        exitCallback = callback;
      },
    };
  };
  return { factory, created };
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

function startDaemon(
  config: DaemonConfig,
  terminalPtyFactory: TerminalPtyFactory,
): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier: permissiveVerifier,
    ptySpawnFactory: fakeClaudePtyFactory,
    terminalPtyFactory,
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
    await delay(5);
  }
}

interface ControlMessage {
  op: string;
  [key: string]: unknown;
}

class TermClient {
  readonly socket: WebSocket;
  readonly control: ControlMessage[] = [];
  readonly binary: Buffer[] = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
    });
    this.socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.binary.push(Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer));
      } else {
        this.control.push(JSON.parse(rawData.toString()) as ControlMessage);
      }
    });
  }

  opened(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket.once('open', () => resolvePromise());
      this.socket.once('error', rejectPromise);
    });
  }

  sendControl(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(buffer: Buffer): void {
    this.socket.send(buffer, { binary: true });
  }

  waitForControl(count: number): Promise<void> {
    return waitUntil(() => this.control.length >= count);
  }

  waitForBinary(count: number): Promise<void> {
    return waitUntil(() => this.binary.length >= count);
  }

  lastControl(): ControlMessage {
    return this.control[this.control.length - 1]!;
  }

  close(): void {
    this.socket.close();
  }
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Raw terminal over WS — control + binary frames', () => {
  it('open → subscribe → output bytes → input bytes → resize → close (full happy path)', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();

      // Open a shell rooted in the project dir.
      client.sendControl({ op: 'term_open', cwd: projectDir });
      await client.waitForControl(1);
      const opened = client.lastControl();
      expect(opened.op).toBe('term_opened');
      const terminalId = opened.terminalId as string;
      expect(typeof terminalId).toBe('string');
      expect(terminals.created).toHaveLength(1);

      // Subscribe from offset 0 → server assigns byte-tag 0.
      client.sendControl({ op: 'term_subscribe', terminalId, offset: 0 });
      await client.waitForControl(2);
      expect(client.lastControl()).toEqual({ op: 'term_subscribed', terminalId, tag: 0 });

      // Output bytes from the shell arrive as a binary frame [tag=0][...bytes].
      terminals.created[0]!.fireData('hi>');
      await client.waitForBinary(1);
      const outFrame = client.binary[0]!;
      expect(outFrame[0]).toBe(0); // tag
      expect(outFrame.subarray(1).toString('utf8')).toBe('hi>');

      // Input bytes: client sends [tag=0]['ls\r'] → pty gets the verbatim string.
      const input = Buffer.concat([Buffer.from([0]), Buffer.from('ls\r', 'utf8')]);
      client.sendBinary(input);
      await waitUntil(() => terminals.created[0]!.writes.length >= 1);
      expect(terminals.created[0]!.writes).toEqual(['ls\r']);

      // Resize forwards to the pty.
      client.sendControl({ op: 'term_resize', terminalId, cols: 120, rows: 40 });
      await waitUntil(() => terminals.created[0]!.resizes.length >= 1);
      expect(terminals.created[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);

      // Close kills the shell and signals term_exit.
      client.sendControl({ op: 'term_close', terminalId });
      await waitUntil(() => client.control.some((message) => message.op === 'term_exit'));
      expect(terminals.created[0]!.killed()).toBe(true);
      const exitMessage = client.control.find((message) => message.op === 'term_exit')!;
      expect(exitMessage.terminalId).toBe(terminalId);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('term_open with a cwd outside the project roots is refused (RCE scoping)', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      client.sendControl({ op: 'term_open', cwd: '/etc' });
      await client.waitForControl(1);
      expect(client.lastControl()).toEqual({
        op: 'refused',
        refusedOp: 'term_open',
        reason: 'cwd-outside-project-roots',
      });
      expect(terminals.created).toHaveLength(0);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('term_open with cols/rows spawns the pty at the client-fitted size (mobile terminal-corruption fix)', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      client.sendControl({ op: 'term_open', cwd: projectDir, cols: 42, rows: 18 });
      await client.waitForControl(1);
      expect(client.lastControl().op).toBe('term_opened');
      expect(terminals.created).toHaveLength(1);
      expect(terminals.created[0]!.spawnDimensions).toEqual({ cols: 42, rows: 18 });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('term_open without cols/rows still spawns (falls back to the terminal host default)', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      client.sendControl({ op: 'term_open', cwd: projectDir });
      await client.waitForControl(1);
      expect(client.lastControl().op).toBe('term_opened');
      expect(terminals.created[0]!.spawnDimensions).toEqual({ cols: 80, rows: 24 });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('a binary frame with an unknown tag is dropped — no crash, connection survives', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      // No terminal subscribed yet: a binary frame for tag 9 must be dropped.
      client.sendBinary(Buffer.concat([Buffer.from([9]), Buffer.from('rm -rf /', 'utf8')]));
      // The connection is still alive: an ordinary control op still answers.
      client.sendControl({ op: 'term_open', cwd: projectDir });
      await client.waitForControl(1);
      expect(client.lastControl().op).toBe('term_opened');
      // Nothing was written to any pty (the stray bytes went nowhere).
      expect(terminals.created[0]!.writes).toEqual([]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('a malformed term control frame → error envelope; the connection survives', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      // term_resize missing cols/rows → invalid-envelope, socket stays open.
      client.sendControl({ op: 'term_resize', terminalId: 'x' });
      await client.waitForControl(1);
      expect(client.lastControl()).toEqual({ op: 'error', reason: 'invalid-envelope' });

      client.sendControl({ op: 'term_open', cwd: projectDir });
      await client.waitForControl(2);
      expect(client.lastControl().op).toBe('term_opened');
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('term_subscribe / term_resize on an unknown terminal is refused', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      client.sendControl({ op: 'term_subscribe', terminalId: 'nope', offset: 0 });
      client.sendControl({ op: 'term_resize', terminalId: 'nope', cols: 80, rows: 24 });
      await client.waitForControl(2);
      expect(client.control).toEqual([
        { op: 'refused', refusedOp: 'term_subscribe', reason: 'unknown-terminal' },
        { op: 'refused', refusedOp: 'term_resize', reason: 'unknown-terminal' },
      ]);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('GET /api/terminals lists live shells (byte-free) and term_set_resilient flips the flag', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const client = new TermClient(daemon.port);
    try {
      await client.opened();
      client.sendControl({ op: 'term_open', cwd: projectDir });
      await client.waitForControl(1);
      const terminalId = client.lastControl().terminalId as string;

      const fetchList = async (): Promise<Array<Record<string, unknown>>> => {
        const response = await fetch(`http://127.0.0.1:${daemon.port}/api/terminals`, {
          headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { terminals: Array<Record<string, unknown>> }).terminals;
      };

      const listed = await fetchList();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.terminalId).toBe(terminalId);
      expect(listed[0]!.cwd).toBe(projectDir);
      expect(listed[0]!.resilient).toBe(false);
      expect(typeof listed[0]!.lastActivityAt).toBe('string');
      // Byte-free: no pty handle, no buffered bytes leak into the listing.
      expect(Object.keys(listed[0]!).sort()).toEqual(
        ['cwd', 'lastActivityAt', 'resilient', 'subscriberCount', 'terminalId'],
      );

      // Mark it resilient over the WS; the endpoint reflects the flip.
      client.sendControl({ op: 'term_set_resilient', terminalId, resilient: true });
      let becameResilient = false;
      for (let attempt = 0; attempt < 100 && !becameResilient; attempt += 1) {
        becameResilient = (await fetchList())[0]!.resilient === true;
        if (!becameResilient) {
          await delay(5);
        }
      }
      expect(becameResilient).toBe(true);

      // An unknown terminal is refused (reuses the shared refused envelope).
      const controlBefore = client.control.length;
      client.sendControl({ op: 'term_set_resilient', terminalId: 'nope', resilient: true });
      await client.waitForControl(controlBefore + 1);
      expect(client.lastControl()).toEqual({
        op: 'refused',
        refusedOp: 'term_set_resilient',
        reason: 'unknown-terminal',
      });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('a second connection re-subscribing at an offset replays the exact tail (byte conservation across reconnect)', async () => {
    const projectDir = mkdtempSync(join(temporaryDirectory, 'proj-'));
    const terminals = makeTerminalPtyFactory();
    const daemon = await startDaemon(buildConfig({ projectRoots: [projectDir] }), terminals.factory);
    const first = new TermClient(daemon.port);
    try {
      await first.opened();
      first.sendControl({ op: 'term_open', cwd: projectDir });
      await first.waitForControl(1);
      const terminalId = first.lastControl().terminalId as string;
      first.sendControl({ op: 'term_subscribe', terminalId, offset: 0 });
      await first.waitForControl(2);

      terminals.created[0]!.fireData('ABCDE'); // 5 bytes, offsets 0..4
      await first.waitForBinary(1);

      // The first connection drops (its offset reached 5). The shell PERSISTS.
      first.close();
      await waitUntil(() => first.socket.readyState === WebSocket.CLOSED);
      expect(daemon.terminalHost.hasTerminal(terminalId)).toBe(true);

      // A reconnecting client subscribes from offset 2 → replays 'CDE' (offsets 2..4).
      const second = new TermClient(daemon.port);
      await second.opened();
      second.sendControl({ op: 'term_subscribe', terminalId, offset: 2 });
      await second.waitForBinary(1);
      const replayFrame = second.binary[0]!;
      expect(replayFrame[0]).toBe(0); // tag
      expect(replayFrame.subarray(1).toString('utf8')).toBe('CDE');

      // And it continues live from there.
      terminals.created[0]!.fireData('FG');
      await second.waitForBinary(2);
      expect(second.binary[1]!.subarray(1).toString('utf8')).toBe('FG');
      second.close();
    } finally {
      await daemon.stop();
    }
  });
});
