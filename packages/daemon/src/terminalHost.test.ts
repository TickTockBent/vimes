import { describe, expect, it } from 'vitest';
import { CountingIdSource } from '@vimes/core';
import {
  TerminalHost,
  type TerminalPtyFactory,
  type TerminalPtyLike,
  type TerminalSubscriber,
} from './terminalHost.js';
import type { RealpathProbe } from './filePaths.js';

// Identity realpath — treats every path as existing and canonical, so
// resolveWithinRoots does pure lexical containment (no real fs touched in CI).
const identityRealpath: RealpathProbe = (path) => path;

function makeFakePty(): {
  factory: TerminalPtyFactory;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  capturedEnv: () => Record<string, string> | undefined;
  capturedCwd: () => string | undefined;
  capturedFile: () => string | undefined;
  capturedSpawnDimensions: () => { cols: number | undefined; rows: number | undefined } | undefined;
  fireData: (data: string) => void;
  fireExit: (exitCode?: number) => void;
  killed: () => boolean;
} {
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((event: { exitCode: number }) => void) | undefined;
  let seenEnv: Record<string, string> | undefined;
  let seenCwd: string | undefined;
  let seenFile: string | undefined;
  let seenSpawnDimensions: { cols: number | undefined; rows: number | undefined } | undefined;
  let wasKilled = false;
  const pty: TerminalPtyLike = {
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
  return {
    factory: (file, _args, options) => {
      seenFile = file;
      seenEnv = options.env;
      seenCwd = options.cwd;
      seenSpawnDimensions = { cols: options.cols, rows: options.rows };
      return pty;
    },
    writes,
    resizes,
    capturedEnv: () => seenEnv,
    capturedCwd: () => seenCwd,
    capturedFile: () => seenFile,
    capturedSpawnDimensions: () => seenSpawnDimensions,
    fireData: (data) => dataCallback?.(data),
    fireExit: (exitCode = 0) => exitCallback?.({ exitCode }),
    killed: () => wasKilled,
  };
}

function makeHost(
  fakePty: ReturnType<typeof makeFakePty>,
  overrides: Partial<ConstructorParameters<typeof TerminalHost>[0]> = {},
): TerminalHost {
  return new TerminalHost({
    ids: new CountingIdSource(),
    getAllowedRoots: () => ['/work/project'],
    ptyFactory: fakePty.factory,
    realpath: identityRealpath,
    shellResolver: () => '/bin/bash',
    envSource: () => ({ PATH: '/usr/bin', HOME: '/home/wes' }),
    ...overrides,
  });
}

// A recording subscriber (like a wsHub connection+tag pair).
function makeSubscriber(): TerminalSubscriber & {
  received: () => number[];
  lostCount: () => number;
  exitCode: () => number | undefined;
} {
  const bytes: number[] = [];
  let losts = 0;
  let exited: number | undefined;
  return {
    output: (chunk) => {
      for (const byte of chunk) {
        bytes.push(byte);
      }
    },
    lost: () => {
      losts += 1;
    },
    exit: (code) => {
      exited = code;
    },
    received: () => bytes,
    lostCount: () => losts,
    exitCode: () => exited,
  };
}

describe('TerminalHost — open + scoping', () => {
  it('opens a shell rooted inside the allowlist (happy path) with $SHELL', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const result = host.openTerminal({ cwd: '/work/project' });
    expect('terminalId' in result).toBe(true);
    expect(fakePty.capturedFile()).toBe('/bin/bash');
    expect(fakePty.capturedCwd()).toBe('/work/project');
    expect(host.terminalCount()).toBe(1);
  });

  it('spawns the pty at the client-supplied cols/rows (mobile terminal-corruption fix)', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const result = host.openTerminal({ cwd: '/work/project', cols: 42, rows: 18 });
    expect('terminalId' in result).toBe(true);
    expect(fakePty.capturedSpawnDimensions()).toEqual({ cols: 42, rows: 18 });
  });

  it('falls back to the 80x24 default when cols/rows are absent, not throwing', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const result = host.openTerminal({ cwd: '/work/project' });
    expect('terminalId' in result).toBe(true);
    expect(fakePty.capturedSpawnDimensions()).toEqual({ cols: 80, rows: 24 });
  });

  it('falls back to the 80x24 default when cols/rows are invalid (zero, negative, non-integer), not throwing', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    expect(() => host.openTerminal({ cwd: '/work/project', cols: 0, rows: -5 })).not.toThrow();
    expect(fakePty.capturedSpawnDimensions()).toEqual({ cols: 80, rows: 24 });

    const fakePty2 = makeFakePty();
    const host2 = makeHost(fakePty2);
    expect(() => host2.openTerminal({ cwd: '/work/project', cols: 40.5, rows: 20 })).not.toThrow();
    expect(fakePty2.capturedSpawnDimensions()).toEqual({ cols: 80, rows: 20 });
  });

  it('refuses a cwd outside the project roots (the RCE scoping boundary)', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const result = host.openTerminal({ cwd: '/etc' });
    expect(result).toEqual({ refused: true, reason: 'cwd-outside-project-roots' });
    expect(host.terminalCount()).toBe(0);
  });

  it('refuses a traversal cwd that climbs out of every root', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const result = host.openTerminal({ cwd: '/work/project/../../etc/passwd' });
    expect(result).toEqual({ refused: true, reason: 'cwd-outside-project-roots' });
  });

  it('scrubs every CLAUDE* key from the spawned shell env (D15), keeping the rest', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty, {
      envSource: () => ({
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        CLAUDE_SESSION: 'abc',
        PATH: '/usr/bin',
        HOME: '/home/wes',
      }),
    });
    host.openTerminal({ cwd: '/work/project' });
    const env = fakePty.capturedEnv()!;
    for (const key of Object.keys(env)) {
      expect(/^CLAUDE/.test(key)).toBe(false);
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/wes');
  });
});

describe('TerminalHost — input / resize / close', () => {
  it('writes input bytes to the pty verbatim (rule 0.8 — never parsed)', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const opened = host.openTerminal({ cwd: '/work/project' });
    const terminalId = (opened as { terminalId: string }).terminalId;
    // "ls\r" as raw bytes.
    host.writeInput(terminalId, new Uint8Array([0x6c, 0x73, 0x0d]));
    expect(fakePty.writes).toEqual(['ls\r']);
  });

  it('resize forwards dimensions, and refuses nonsense dimensions', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const terminalId = (host.openTerminal({ cwd: '/work/project' }) as { terminalId: string }).terminalId;
    expect(host.resize(terminalId, 120, 40)).toEqual({ ok: true });
    expect(fakePty.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(host.resize(terminalId, 0, 40)).toEqual({ refused: true, reason: 'invalid-dimensions' });
  });

  it('close kills the shell, drops the terminal, and signals exit to subscribers', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const terminalId = (host.openTerminal({ cwd: '/work/project' }) as { terminalId: string }).terminalId;
    const subscriber = makeSubscriber();
    host.subscribe(terminalId, 0, subscriber);
    const result = host.closeTerminal(terminalId);
    expect(result).toEqual({ ok: true });
    expect(fakePty.killed()).toBe(true);
    expect(subscriber.exitCode()).toBe(0);
    expect(host.hasTerminal(terminalId)).toBe(false);
    // A later async pty exit does not double-fire the signal.
    fakePty.fireExit(0);
    expect(subscriber.exitCode()).toBe(0);
  });

  it('a shell exiting on its own signals exit and removes the terminal', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const terminalId = (host.openTerminal({ cwd: '/work/project' }) as { terminalId: string }).terminalId;
    const subscriber = makeSubscriber();
    host.subscribe(terminalId, 0, subscriber);
    fakePty.fireExit(3);
    expect(subscriber.exitCode()).toBe(3);
    expect(host.hasTerminal(terminalId)).toBe(false);
    // Ops on a gone terminal refuse rather than throw.
    expect(host.writeInput(terminalId, new Uint8Array([1]))).toEqual({ refused: true, reason: 'unknown-terminal' });
  });

  it('unknown-terminal ops refuse (no crash)', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    expect(host.writeInput('nope', new Uint8Array([1]))).toEqual({ refused: true, reason: 'unknown-terminal' });
    expect(host.resize('nope', 80, 24)).toEqual({ refused: true, reason: 'unknown-terminal' });
    expect(host.closeTerminal('nope')).toEqual({ refused: true, reason: 'unknown-terminal' });
    const subscriber = makeSubscriber();
    expect(host.subscribe('nope', 0, subscriber)).toEqual({ refused: true, reason: 'unknown-terminal' });
  });
});

describe('TerminalHost — reconnect byte conservation (I9 at the host seam)', () => {
  it('a reconnecting subscriber replays byte-identically to a never-disconnected one', () => {
    const fakePty = makeFakePty();
    const host = makeHost(fakePty);
    const terminalId = (host.openTerminal({ cwd: '/work/project' }) as { terminalId: string }).terminalId;

    // A never-disconnected subscriber from offset 0.
    const live = makeSubscriber();
    host.subscribe(terminalId, 0, live);

    // Output arrives; both the live observer and the ring see it.
    fakePty.fireData('hello '); // 6 bytes
    fakePty.fireData('world'); // 5 bytes → 11 total

    // A second client subscribes late from offset 6 (it had already seen "hello ").
    const late = makeSubscriber();
    const subResult = host.subscribe(terminalId, 6, late);
    expect(subResult).toEqual({ ok: true });

    // More output; both receive it live.
    fakePty.fireData('!'); // 1 byte → 12 total

    const encoder = new TextEncoder();
    const neverDisconnected = Array.from(encoder.encode('hello world!'));
    expect(live.received()).toEqual(neverDisconnected);
    // The late client saw replay("world") + live("!") == the tail from offset 6.
    expect(late.received()).toEqual(neverDisconnected.slice(6));
    expect(late.lostCount()).toBe(0);
  });

  it('a reconnect beyond the ring window fires lost and delivers only the surviving tail', () => {
    const fakePty = makeFakePty();
    // Tiny 4-byte window so a modest gap overflows it.
    const host = makeHost(fakePty, { maxBufferBytes: 4 });
    const terminalId = (host.openTerminal({ cwd: '/work/project' }) as { terminalId: string }).terminalId;

    fakePty.fireData('abcdefgh'); // 8 bytes; window keeps only the last 4: "efgh"

    const reconnect = makeSubscriber();
    host.subscribe(terminalId, 0, reconnect); // offset 0 long evicted
    expect(reconnect.lostCount()).toBe(1);
    expect(reconnect.received()).toEqual(Array.from(new TextEncoder().encode('efgh')));
  });
});
