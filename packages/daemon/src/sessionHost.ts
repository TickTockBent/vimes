import { createRequire } from 'node:module';
import {
  EventRouter,
  INITIAL_LIVENESS,
  attentionCleared,
  canTransition,
  claudeSessionMapped,
  gateFired,
  hostStarted,
  hostStopped,
  livenessChanged,
  message as messageEvent,
  readAllStreamsGrouped,
  replayFromEmpty,
  runCompleted,
  sessionCreated,
  sessionsProjection,
  transitionRejected,
  usageBlock,
  withNotificationTrigger,
  type Clock,
  type EventStore,
  type IdSource,
  type Liveness,
  type SessionRecord,
} from '@vimes/core';
import type { DaemonConfig } from './config.js';
import { defaultProjectsRoot, transcriptFileFor } from './transcriptPaths.js';

// ─── The session host: owns every Claude process (rule 0.3) ──────────────────
//
// Deterministic control logic; every I/O boundary (the SDK query and the pty
// spawn) is an injected factory. CI ALWAYS injects fakes — real Claude never
// runs in the harness (spec §7). PTY structure comes ONLY from the tailer
// (rule 0.8): raw bytes here are counted, never parsed.

// ── SDK seam (fragile-adapter boundary, rule 0.6) ────────────────────────────
export type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { requestId: string; title?: string; [key: string]: unknown },
) => Promise<SdkPermissionResult>;

export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
}

// Loose by design — the persisted/stream shape drifts (rule 0.6).
export interface SdkStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { role?: unknown; content?: unknown; usage?: unknown };
  [key: string]: unknown;
}

export interface SdkQueryOptions {
  cwd: string;
  resume?: string;
  settingSources: string[];
  canUseTool: SdkCanUseTool;
}

export interface SdkQueryHandle extends AsyncIterable<SdkStreamMessage> {
  close?(): void;
}

export type SdkQueryFactory = (args: {
  prompt: AsyncIterable<SdkUserMessage>;
  options: SdkQueryOptions;
}) => SdkQueryHandle;

// ── PTY seam ─────────────────────────────────────────────────────────────────
export interface PtyLike {
  write(data: string): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  name?: string;
  cols?: number;
  rows?: number;
}

export type PtySpawnFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

// ── Tailer seam (host tells the tailer which dirs/files matter) ──────────────
export interface SessionTailer {
  watchSession(session: { appSessionId: string; cwd: string }): void;
  markSdkJsonl(jsonlPath: string): void;
  unwatchSession(appSessionId: string): void;
}

// ── Results ──────────────────────────────────────────────────────────────────
export type SpawnResult = { appSessionId: string } | { refused: true; reason: string };
export type ResumeResult = { appSessionId: string } | { refused: true; reason: string };
export type SendResult = { ok: true } | { refused: true; reason: string };
export type AnswerResult = { ok: true } | { refused: true; reason: string };

export interface SessionHostDeps {
  store: EventStore;
  router: EventRouter;
  clock: Clock;
  ids: IdSource;
  config: DaemonConfig;
  sdkQueryFactory?: SdkQueryFactory;
  ptySpawnFactory?: PtySpawnFactory;
  // Where Claude Code writes transcripts; overridable for tests. Prod default
  // is ~/.claude/projects.
  projectsRoot?: string;
}

interface LiveProcess {
  appSessionId: string;
  channel: 'sdk' | 'pty';
  cwd: string;
  sdkInput?: AsyncMessageQueue<SdkUserMessage>;
  sdkHandle?: SdkQueryHandle;
  sawResult?: boolean;
  lastMappedClaudeSessionId?: string;
  pty?: PtyLike;
}

interface PendingGate {
  appSessionId: string;
  input: Record<string, unknown>;
  resolve: (result: SdkPermissionResult) => void;
}

// Delete every CLAUDE* key (covers CLAUDECODE) from a copy of the parent env; keep
// the rest untouched (D15: the PTY child must not inherit the nesting session's
// CLAUDE* vars). Nothing else is pinned yet.
export function scrubClaudeEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    if (/^CLAUDE/.test(key)) {
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}

export class SessionHost {
  private readonly store: EventStore;
  private readonly router: EventRouter;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly config: DaemonConfig;
  private readonly sdkQueryFactory: SdkQueryFactory;
  private readonly ptySpawnFactory: PtySpawnFactory;
  private readonly projectsRoot: string;

  private readonly liveProcesses = new Map<string, LiveProcess>();
  private readonly pendingGates = new Map<string, PendingGate>();
  private readonly rawByteCounts = new Map<string, number>();
  private tailer: SessionTailer | undefined;
  private stopping = false;

  constructor(deps: SessionHostDeps) {
    this.store = deps.store;
    this.router = deps.router;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.config = deps.config;
    this.sdkQueryFactory = deps.sdkQueryFactory ?? defaultSdkQueryFactory;
    this.ptySpawnFactory = deps.ptySpawnFactory ?? defaultPtySpawnFactory;
    this.projectsRoot = deps.projectsRoot ?? defaultProjectsRoot();
  }

  attachTailer(tailer: SessionTailer): void {
    this.tailer = tailer;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(): void {
    this.stopping = false;
    this.router.emit([hostStarted()]);
    this.runRecovery();
  }

  stop(): void {
    this.stopping = true;
    for (const live of this.liveProcesses.values()) {
      if (live.channel === 'pty') {
        try {
          live.pty?.kill();
        } catch {
          // A pty already gone is fine — we are tearing everything down.
        }
      } else {
        live.sdkInput?.close();
        try {
          live.sdkHandle?.close?.();
        } catch {
          // ditto
        }
      }
    }
    this.liveProcesses.clear();
    this.pendingGates.clear();
    this.router.emit([hostStopped()]);
  }

  // ── observation seams (tests / dispatcher) ──────────────────────────────────
  isLive(appSessionId: string): boolean {
    return this.liveProcesses.has(appSessionId);
  }

  liveProcessCount(): number {
    return this.liveProcesses.size;
  }

  rawBytesReceived(appSessionId: string): number {
    return this.rawByteCounts.get(appSessionId) ?? 0;
  }

  // ── spawn ────────────────────────────────────────────────────────────────
  spawnSession(options: { channel: 'sdk' | 'pty'; cwd: string; name?: string }): SpawnResult {
    const appSessionId = this.ids.uuid();
    this.router.emit([
      sessionCreated({
        appSessionId,
        channel: options.channel,
        cwd: options.cwd,
        name: options.name ?? null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    this.startProcess(appSessionId, options.channel, options.cwd, undefined);
    return { appSessionId };
  }

  // ── send a turn ──────────────────────────────────────────────────────────
  sendMessage(appSessionId: string, text: string): SendResult {
    const live = this.liveProcesses.get(appSessionId);
    if (live === undefined) {
      return { refused: true, reason: 'no-live-process' };
    }
    if (live.channel === 'sdk') {
      live.sdkInput?.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    } else {
      // PTY keystrokes: the text plus a carriage return (rule 0.8 — a raw write,
      // never a parse).
      live.pty?.write(`${text}\r`);
    }
    return { ok: true };
  }

  // ── answer a gate ──────────────────────────────────────────────────────────
  answerGate(appSessionId: string, requestId: string, response: unknown): AnswerResult {
    const pending = this.pendingGates.get(requestId);
    if (pending === undefined) {
      return { refused: true, reason: 'unknown-gate' };
    }
    this.pendingGates.delete(requestId);
    // Fail-closed: anything other than the explicit 'allow' string denies.
    const result: SdkPermissionResult =
      response === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'denied from VIMES' };
    pending.resolve(result);
    this.router.emit([attentionCleared({ appSessionId, cause: 'gate_answered' })]);
    return { ok: true };
  }

  // ── resume ─────────────────────────────────────────────────────────────────
  resumeSession(appSessionId: string): ResumeResult {
    // I11: a live session is never re-spawned. Refuse at the registry before any
    // process starts, and event the refusal.
    if (this.liveProcesses.has(appSessionId)) {
      const from = this.currentSessions()[appSessionId]?.liveness ?? 'running';
      this.router.emit([
        transitionRejected({ appSessionId, from, to: 'spawning', cause: 'concurrent-resume-refused' }),
      ]);
      return { refused: true, reason: 'session already has a live process' };
    }
    const session = this.currentSessions()[appSessionId];
    if (session === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    // dormant | interrupted -> spawning (via the machine), then startProcess
    // drives spawning -> running. I3: resume from the RECORDED cwd + last mapped
    // claudeSessionId; no new appSessionId, no fork.
    this.emitGuardedLiveness(appSessionId, 'spawning', 'resume');
    const lastClaudeSessionId = session.claudeSessionIds.at(-1)?.id;
    this.startProcess(appSessionId, session.channel, session.cwd, lastClaudeSessionId);
    return { appSessionId };
  }

  // ── internals ────────────────────────────────────────────────────────────
  private startProcess(
    appSessionId: string,
    channel: 'sdk' | 'pty',
    cwd: string,
    resume: string | undefined,
  ): void {
    const cause = resume === undefined ? 'spawn' : 'resume';
    if (channel === 'sdk') {
      const input = new AsyncMessageQueue<SdkUserMessage>();
      const handle = this.sdkQueryFactory({
        prompt: input,
        options: {
          cwd,
          resume,
          settingSources: this.config.sdkSettingSources,
          canUseTool: (toolName, toolInput, options) =>
            this.handleGate(appSessionId, toolName, toolInput, options),
        },
      });
      const live: LiveProcess = { appSessionId, channel: 'sdk', cwd, sdkInput: input, sdkHandle: handle, sawResult: false };
      this.liveProcesses.set(appSessionId, live);
      this.emitGuardedLiveness(appSessionId, 'running', cause);
      void this.consumeSdk(live);
    } else {
      const environment = scrubClaudeEnv(process.env);
      const args = resume === undefined ? [] : ['--resume', resume];
      const handle = this.ptySpawnFactory('claude', args, { cwd, env: environment, name: appSessionId });
      const live: LiveProcess = { appSessionId, channel: 'pty', cwd, pty: handle };
      this.liveProcesses.set(appSessionId, live);
      handle.onData((data) => {
        this.rawByteCounts.set(appSessionId, this.rawBytesReceived(appSessionId) + Buffer.byteLength(data, 'utf8'));
      });
      handle.onExit(() => this.onPtyExit(appSessionId));
      this.emitGuardedLiveness(appSessionId, 'running', cause);
      // The tailer is the ONLY structured channel for PTY (rule 0.8).
      this.tailer?.watchSession({ appSessionId, cwd });
    }
  }

  private async consumeSdk(live: LiveProcess): Promise<void> {
    try {
      for await (const rawMessage of live.sdkHandle as SdkQueryHandle) {
        if (this.handleSdkMessage(live, rawMessage)) {
          break;
        }
      }
    } catch {
      // Stream error → fall through to wind-down (the finally block).
    } finally {
      this.windDownSdk(live);
    }
  }

  private handleSdkMessage(live: LiveProcess, sdkMessage: SdkStreamMessage): boolean {
    const appSessionId = live.appSessionId;

    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
      const claudeSessionId = typeof sdkMessage.session_id === 'string' ? sdkMessage.session_id : undefined;
      // I1: append a mapping ONLY when a NEW claudeSessionId is observed. A resume
      // that lands the same id (the verified no-fork case) appends nothing.
      if (claudeSessionId !== undefined && claudeSessionId !== live.lastMappedClaudeSessionId) {
        const jsonlPath = transcriptFileFor(this.projectsRoot, live.cwd, claudeSessionId);
        live.lastMappedClaudeSessionId = claudeSessionId;
        this.router.emit([claudeSessionMapped({ appSessionId, claudeSessionId, jsonlPath })]);
        // Dedupe: this SDK-channel file is served by the SDK stream — the tailer
        // must skip it if it sits in a watched dir.
        this.tailer?.markSdkJsonl(jsonlPath);
      }
      return false;
    }

    if (sdkMessage.type === 'assistant' || sdkMessage.type === 'user') {
      const body = sdkMessage.message;
      if (body !== undefined && body !== null) {
        const role = typeof body.role === 'string' ? body.role : sdkMessage.type;
        // Content stored INLINE (D12).
        this.router.emit([messageEvent({ appSessionId, role, content: body.content ?? null })]);
        if (body.usage !== null && typeof body.usage === 'object') {
          this.router.emit([usageBlock({ appSessionId, usage: body.usage as Record<string, unknown> })]);
        }
      }
      return false;
    }

    if (sdkMessage.type === 'result') {
      live.sawResult = true;
      this.router.emit(withNotificationTrigger(runCompleted({ appSessionId })));
      this.driveToDormant(appSessionId, 'run-complete');
      return true;
    }

    return false;
  }

  private windDownSdk(live: LiveProcess): void {
    if (this.liveProcesses.get(live.appSessionId) === live) {
      this.liveProcesses.delete(live.appSessionId);
    }
    if (!this.stopping && live.sawResult !== true) {
      // Stream ended without a result — reconcile liveness to dormant.
      this.driveToDormant(live.appSessionId, 'sdk-stream-ended');
    }
    live.sdkInput?.close();
    try {
      live.sdkHandle?.close?.();
    } catch {
      // ignore
    }
  }

  private onPtyExit(appSessionId: string): void {
    if (this.liveProcesses.get(appSessionId)?.channel === 'pty') {
      this.liveProcesses.delete(appSessionId);
    }
    this.tailer?.unwatchSession(appSessionId);
    if (!this.stopping) {
      this.driveToDormant(appSessionId, 'pty-exit');
    }
  }

  private handleGate(
    appSessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { requestId: string; title?: string },
  ): Promise<SdkPermissionResult> {
    const requestId = options.requestId;
    const prompt = typeof options.title === 'string' && options.title.length > 0 ? options.title : toolName;
    // gate_fired carries requestId in its payload (widened schema, rule 0.7):
    // the raw event delivered over WS keeps it — the phone needs it to answer
    // this exact gate. The sessions projection ignores requestId (correct).
    const gateEvent = gateFired({ appSessionId, prompt, requestId });
    this.router.emit(withNotificationTrigger(gateEvent));
    return new Promise<SdkPermissionResult>((resolve) => {
      this.pendingGates.set(requestId, { appSessionId, input, resolve });
    });
  }

  private runRecovery(): void {
    const sessions = this.currentSessions();
    for (const appSessionId of Object.keys(sessions).sort()) {
      const liveness = sessions[appSessionId]!.liveness;
      // D13: a session the log left running OR spawning, with no live process,
      // becomes interrupted (attention untouched — only liveness is emitted).
      if ((liveness === 'running' || liveness === 'spawning') && !this.liveProcesses.has(appSessionId)) {
        this.emitGuardedLiveness(appSessionId, 'interrupted', 'recovery-no-process');
      }
    }
  }

  // Read current session facts by folding the log (source of truth, I13). Slice-1
  // scale (n=1) makes an on-demand replay comfortably cheap.
  private currentSessions(): Record<string, SessionRecord> {
    return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(this.store)).sessions;
  }

  // Guarded liveness emission (rule 0.3): legal edge → liveness_changed, else
  // transition_rejected. Mirrors core's harness emitter against the live log.
  private emitGuardedLiveness(appSessionId: string, to: Liveness, cause: string): void {
    const from: Liveness = this.currentSessions()[appSessionId]?.liveness ?? INITIAL_LIVENESS;
    if (canTransition(from, to)) {
      this.router.emit([livenessChanged({ appSessionId, to, cause })]);
    } else {
      this.router.emit([transitionRejected({ appSessionId, from, to, cause })]);
    }
  }

  // running -> dormant is the only legal path here; anything else is left alone
  // (avoids emitting a spurious transition_rejected on an already-terminal state).
  private driveToDormant(appSessionId: string, cause: string): void {
    if (this.currentSessions()[appSessionId]?.liveness === 'running') {
      this.router.emit([livenessChanged({ appSessionId, to: 'dormant', cause })]);
    }
  }
}

// Push-fed async iterable — the SDK streaming-input prompt. sendMessage() pushes;
// the query consumes. close() ends iteration.
class AsyncMessageQueue<ItemType> implements AsyncIterable<ItemType> {
  private readonly queued: ItemType[] = [];
  private readonly waiting: Array<(result: IteratorResult<ItemType>) => void> = [];
  private closed = false;

  push(item: ItemType): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
    } else {
      this.queued.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    let waiter = this.waiting.shift();
    while (waiter !== undefined) {
      waiter({ value: undefined as unknown as ItemType, done: true });
      waiter = this.waiting.shift();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ItemType> {
    for (;;) {
      const next = this.queued.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<ItemType>>((resolve) => this.waiting.push(resolve));
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

// ── real factory defaults (determinism-exempt — daemon boundary, rule 0.3) ──
// Lazy dynamic imports so CI (which injects fakes) never loads the SDK or the
// node-pty native binary.

const defaultSdkQueryFactory: SdkQueryFactory = ({ prompt, options }) => {
  let activeQuery: { close?: () => void } | undefined;
  async function* run(): AsyncGenerator<SdkStreamMessage> {
    // determinism-exempt: real Agent SDK.
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => AsyncIterable<SdkStreamMessage> & { close?: () => void };
    };
    const query = sdk.query({
      prompt,
      options: {
        cwd: options.cwd,
        resume: options.resume,
        settingSources: options.settingSources,
        canUseTool: options.canUseTool,
        // Spike (b): canUseTool only fires under permissionMode 'default'.
        permissionMode: 'default',
      },
    });
    activeQuery = query;
    for await (const streamMessage of query) {
      yield streamMessage;
    }
  }
  const generator = run();
  return Object.assign(generator, {
    close(): void {
      try {
        activeQuery?.close?.();
      } catch {
        // ignore
      }
      void generator.return(undefined);
    },
  });
};

const requireFromHere = createRequire(import.meta.url);

const defaultPtySpawnFactory: PtySpawnFactory = (file, args, options) => {
  // node-pty's spawn is synchronous; require it lazily (createRequire — this is
  // an ESM module) so CI never loads the native binary. determinism-exempt: real
  // process spawn.
  const nodePty = requireFromHere('node-pty') as {
    spawn: (file: string, args: string[], options: Record<string, unknown>) => PtyLike;
  };
  return nodePty.spawn(file, args, {
    name: options.name ?? 'xterm-color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    cwd: options.cwd,
    env: options.env,
  });
};
