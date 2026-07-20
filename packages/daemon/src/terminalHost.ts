import { createRequire } from 'node:module';
import { TerminalRingBuffer, DEFAULT_TERMINAL_BUFFER_BYTES, type IdSource } from '@vimes/core';
import { resolveWithinRoots, type RealpathProbe, realpathProbe } from './filePaths.js';
import { scrubClaudeEnv } from './sessionHost.js';

// ─── TerminalHost — owns raw shell PTYs (spec §3.4 / §3.11 the RCE-by-design row) ─
//
// SEPARATE from Claude sessions (sessionHost): these are plain interactive shells
// the operator reaches from a browser. The endpoint IS remote code execution by
// design — the SECURITY is (a) the Access + JWT wall in front of the whole WS
// (unchanged here) and (b) the cwd scoping below: a shell may ONLY be rooted
// inside projectRoots ∪ live-session cwds. A shell rooted anywhere else is the
// threat, so openTerminal refuses any cwd that fails resolveWithinRoots.
//
// Bytes are relayed verbatim (rule 0.8): input bytes are written raw to the pty;
// output bytes are appended to a per-terminal ring buffer (the I9 reconnect
// window) and broadcast to subscribers. Nothing here parses PTY bytes for meaning
// and terminal byte CONTENT is never logged.
//
// Every process boundary (the pty spawn) is an injected factory. CI injects a fake
// pty — a real shell / node-pty NEVER runs in the harness (spec §7).

// ── PTY seam (terminal flavour — like sessionHost's PtyLike, plus resize) ────────
export interface TerminalPtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
}

export interface TerminalPtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  name?: string;
  cols?: number;
  rows?: number;
}

export type TerminalPtyFactory = (
  file: string,
  args: string[],
  options: TerminalPtySpawnOptions,
) => TerminalPtyLike;

// A subscriber is a (connection, byte-tag) pair over in the wsHub. It receives raw
// output bytes plus the two honest control signals: `lost` (reconnect fell out of
// the ring window) and `exit` (the shell ended).
export interface TerminalSubscriber {
  output(bytes: Uint8Array): void;
  lost(): void;
  exit(exitCode: number): void;
}

export type OpenTerminalResult = { terminalId: string } | { refused: true; reason: string };
export type SubscribeResult = { ok: true } | { refused: true; reason: string };
export type TerminalOpResult = { ok: true } | { refused: true; reason: string };

interface Terminal {
  terminalId: string;
  cwd: string;
  pty: TerminalPtyLike;
  ring: TerminalRingBuffer;
  subscribers: Set<TerminalSubscriber>;
  exited: boolean;
}

export interface TerminalHostDeps {
  ids: IdSource;
  // The File API/Search allowlist union, read fresh per open (config.projectRoots ∪
  // live-session cwds) — the SAME source the fileApi/search use.
  getAllowedRoots: () => string[];
  // Default: node-pty spawn of $SHELL. CI injects a fake.
  ptyFactory?: TerminalPtyFactory;
  // Per-terminal reconnect window; default the core 2 MB constant. Tests inject a
  // small value to exercise over-window loss.
  maxBufferBytes?: number;
  // Injected realpath probe (fs boundary) — forwarded to resolveWithinRoots so the
  // scoping check is symlink-safe. Tests inject a fake.
  realpath?: RealpathProbe;
  // Default shell resolver — overridable in tests. Prod reads $SHELL.
  shellResolver?: () => string;
  // Env source for the spawned shell (scrubbed of CLAUDE*). Default process.env.
  envSource?: () => NodeJS.ProcessEnv;
}

export class TerminalHost {
  private readonly ids: IdSource;
  private readonly getAllowedRoots: () => string[];
  private readonly ptyFactory: TerminalPtyFactory;
  private readonly maxBufferBytes: number;
  private readonly realpath: RealpathProbe;
  private readonly shellResolver: () => string;
  private readonly envSource: () => NodeJS.ProcessEnv;
  private readonly terminals = new Map<string, Terminal>();

  constructor(deps: TerminalHostDeps) {
    this.ids = deps.ids;
    this.getAllowedRoots = deps.getAllowedRoots;
    this.ptyFactory = deps.ptyFactory ?? defaultTerminalPtyFactory;
    this.maxBufferBytes = deps.maxBufferBytes ?? DEFAULT_TERMINAL_BUFFER_BYTES;
    this.realpath = deps.realpath ?? realpathProbe;
    this.shellResolver = deps.shellResolver ?? (() => process.env.SHELL ?? '/bin/bash');
    this.envSource = deps.envSource ?? (() => process.env);
  }

  // Spawn a shell rooted at `cwd`. cwd MUST land within the allowlist — this is the
  // RCE scoping boundary (spec §3.11). The scrubbed env drops every CLAUDE* key
  // (D15), matching every other process VIMES spawns.
  openTerminal(request: { cwd: string }): OpenTerminalResult {
    const resolved = resolveWithinRoots(request.cwd, this.getAllowedRoots(), this.realpath);
    if (!resolved.ok) {
      // A single classified refusal — never echo the requested path.
      return { refused: true, reason: 'cwd-outside-project-roots' };
    }
    const terminalId = this.ids.uuid();
    const shellFile = this.shellResolver();
    const environment = scrubClaudeEnv(this.envSource());
    const pty = this.ptyFactory(shellFile, [], {
      cwd: resolved.absolute,
      env: environment,
      name: 'xterm-color',
    });
    const terminal: Terminal = {
      terminalId,
      cwd: resolved.absolute,
      pty,
      ring: new TerminalRingBuffer(this.maxBufferBytes),
      subscribers: new Set(),
      exited: false,
    };
    // Output: append to the reconnect ring, then broadcast the same bytes live.
    // Bytes only — never parsed, never logged (rule 0.8).
    pty.onData((data) => {
      const bytes = new Uint8Array(Buffer.from(data, 'utf8'));
      terminal.ring.append(bytes);
      for (const subscriber of terminal.subscribers) {
        subscriber.output(bytes);
      }
    });
    pty.onExit((event) => this.onPtyExit(terminal, event.exitCode));
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  // Subscribe with the client's last byte offset. Replays from the ring, then
  // registers the subscriber for live output. Replay and registration are atomic
  // (synchronous) — a subsequent onData can only fire on a later tick — so no byte
  // is duplicated or skipped across the seam (the host-level I9 property, backed by
  // the pure ring-buffer assertion). A lossy replay fires `lost` FIRST, then the
  // surviving tail, so the UI can show the drop notice before the bytes.
  subscribe(terminalId: string, offset: number, subscriber: TerminalSubscriber): SubscribeResult {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) {
      return { refused: true, reason: 'unknown-terminal' };
    }
    const replay = terminal.ring.replayFrom(offset);
    if (replay.lost) {
      subscriber.lost();
    }
    if (replay.bytes.length > 0) {
      subscriber.output(replay.bytes);
    }
    terminal.subscribers.add(subscriber);
    return { ok: true };
  }

  unsubscribe(terminalId: string, subscriber: TerminalSubscriber): void {
    this.terminals.get(terminalId)?.subscribers.delete(subscriber);
  }

  // Raw input relay (rule 0.8): decode the transport bytes and write them straight
  // to the pty. node-pty's write takes a string; utf8 round-trips ordinary
  // keystrokes losslessly. No interpretation of the bytes.
  writeInput(terminalId: string, bytes: Uint8Array): TerminalOpResult {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.exited) {
      return { refused: true, reason: 'unknown-terminal' };
    }
    terminal.pty.write(Buffer.from(bytes).toString('utf8'));
    return { ok: true };
  }

  resize(terminalId: string, cols: number, rows: number): TerminalOpResult {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.exited) {
      return { refused: true, reason: 'unknown-terminal' };
    }
    // Guard against nonsense dimensions (a shell resize with 0 cols throws).
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      return { refused: true, reason: 'invalid-dimensions' };
    }
    terminal.pty.resize(cols, rows);
    return { ok: true };
  }

  // Explicit close: kill the shell and drop its buffer. Notifies subscribers via
  // the exit path (single source of the exit signal), guarded so the pty's own
  // async onExit cannot double-fire.
  closeTerminal(terminalId: string): TerminalOpResult {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) {
      return { refused: true, reason: 'unknown-terminal' };
    }
    try {
      terminal.pty.kill();
    } catch {
      // A pty already gone is fine — we are tearing it down.
    }
    this.onPtyExit(terminal, 0);
    return { ok: true };
  }

  // Terminals are ephemeral shells; they die with the daemon (§3.10). No boot
  // recovery — there is nothing to recover.
  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      try {
        terminal.pty.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }

  terminalCount(): number {
    return this.terminals.size;
  }

  hasTerminal(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  private onPtyExit(terminal: Terminal, exitCode: number): void {
    if (terminal.exited) {
      return;
    }
    terminal.exited = true;
    for (const subscriber of terminal.subscribers) {
      subscriber.exit(exitCode);
    }
    terminal.subscribers.clear();
    this.terminals.delete(terminal.terminalId);
  }
}

// ── real factory default (determinism-exempt — daemon boundary, rule 0.3) ──────
// node-pty's spawn is synchronous; require it lazily (createRequire — ESM) so CI
// (which injects a fake) never loads the native binary.
const requireFromHere = createRequire(import.meta.url);

const defaultTerminalPtyFactory: TerminalPtyFactory = (file, args, options) => {
  const nodePty = requireFromHere('node-pty') as {
    spawn: (file: string, args: string[], options: Record<string, unknown>) => TerminalPtyLike;
  };
  return nodePty.spawn(file, args, {
    name: options.name ?? 'xterm-color',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env,
  });
};
