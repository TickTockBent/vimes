import { createRequire } from 'node:module';
import {
  EventRouter,
  INITIAL_LIVENESS,
  HOOK_EVENT_CONSTRUCTORS,
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
  resyncMarker,
  runCompleted,
  seen as seenEvent,
  sessionAdopted,
  sessionCreated,
  sessionRenamed,
  sessionsProjection,
  transitionRejected,
  usageBlock,
  withNotificationTrigger,
  type Clock,
  type EventInput,
  type EventStore,
  type IdSource,
  type Liveness,
  type SessionRecord,
} from '@vimes/core';
import type { DaemonConfig } from './config.js';
import { defaultProjectsRoot, transcriptFileFor } from './transcriptPaths.js';
import {
  buildSessionSettings,
  mintSpawnSecret,
  removeSessionSettings,
  secretMatchesDigest,
  writeSessionSettings,
} from './sessionSettings.js';
import type { HookAuthResult, HookHost, HookIngestResult } from './hookIngress.js';
import type { PreflightProbe, PreflightResult } from './runtimeChecks.js';
import { scanForExternalTranscripts } from './discovery.js';

// ─── The session host: owns every Claude process (rule 0.3) ──────────────────
//
// Deterministic control logic; every I/O boundary (the SDK query, the pty spawn,
// the settings-file write, the preflight probe) is an injected factory/seam. CI
// ALWAYS injects fakes — real Claude never runs in the harness (spec §7). PTY
// structure comes ONLY from the tailer (rule 0.8): raw bytes here are counted,
// never parsed.
//
// D18: the two channels are formalized as capabilities-declared `SessionAdapter`
// implementations (ClaudeSdkAdapter, ClaudePtyAdapter). The host owns
// orchestration (registry, liveness, attention, correlation, hook custody); the
// adapters own the channel-specific process I/O and the gate resolution contract.

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
  message?: { role?: unknown; content?: unknown; usage?: unknown; id?: unknown };
  [key: string]: unknown;
}

export interface SdkQueryOptions {
  cwd: string;
  resume?: string;
  // Per-session settings file path (C). Passed to Options.settings so the SDK
  // loads the injected hook relays alongside the project tier (D14 MERGE).
  settings?: string;
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
  // D10: mirror a KNOWN external transcript file from its current EOF (live-only;
  // no history backfill). Idempotent — a file already mirrored is a no-op.
  mirrorExternalFile(mirror: { appSessionId: string; jsonlPath: string }): void;
}

// ── Results ──────────────────────────────────────────────────────────────────
export type SpawnResult = { appSessionId: string } | { refused: true; reason: string };
export type ResumeResult = { appSessionId: string } | { refused: true; reason: string };
export type SendResult = { ok: true } | { refused: true; reason: string };
export type AnswerResult = { ok: true } | { refused: true; reason: string };
export type KillResult = { ok: true } | { refused: true; reason: string };
export type AdoptResult = { ok: true } | { refused: true; reason: string };
export type RenameResult = { ok: true } | { refused: true; reason: string };
export type SeenResult = { ok: true } | { refused: true; reason: string };
export type ClearAttentionResult = { ok: true } | { refused: true; reason: string };

// ── Adapter interface (D18) ──────────────────────────────────────────────────
export interface AdapterCapabilities {
  resume: boolean;
  gates: 'runtime' | 'none';
  settingsIsolation: boolean;
  structuredStream: boolean;
}

export const CLAUDE_SDK_CAPABILITIES: AdapterCapabilities = {
  resume: true,
  gates: 'runtime',
  settingsIsolation: true,
  structuredStream: true,
};

export const CLAUDE_PTY_CAPABILITIES: AdapterCapabilities = {
  resume: true,
  gates: 'none',
  settingsIsolation: false,
  structuredStream: false,
};

// The provider hosting every MVP session (D18 boundary rule: named ONLY here, at
// the composition point — nothing downstream names a provider's concepts).
const CLAUDE_PROVIDER = 'claude-code';

interface AdapterSpawnContext {
  appSessionId: string;
  cwd: string;
  resume: string | undefined;
  settingsPath: string | undefined;
}

export type InteractionAck = { ok: true; appSessionId: string } | { refused: true; reason: string };

export interface SessionAdapter {
  readonly capabilities: AdapterCapabilities;
  // Create the process and wire its callbacks; return the live record. The host
  // registers it and emits `running` BEFORE calling activate() (stream/tailer
  // start), preserving the observed emission order.
  spawn(context: AdapterSpawnContext): LiveProcess;
  activate(live: LiveProcess): void;
  deliver(live: LiveProcess, text: string): void;
  // The gate contract: resolve the pending interaction on the adapter's ack.
  respondInteraction(requestId: string, answer: unknown): InteractionAck;
  interrupt?(live: LiveProcess): void;
  kill(live: LiveProcess): void;
}

// Services the host exposes to its adapters (emission, tailer, registry, byte
// accounting, correlation, dormancy) — the inward boundary keeping domain logic
// host-owned while the adapters own channel I/O.
interface AdapterServices {
  emit(events: EventInput[]): void;
  readonly config: DaemonConfig;
  readonly projectsRoot: string;
  getTailer(): SessionTailer | undefined;
  markSdkJsonl(jsonlPath: string): void;
  countRawBytes(appSessionId: string, byteLength: number): void;
  emitMappingIfNew(appSessionId: string, claudeSessionId: string, jsonlPath: string): void;
  driveToDormant(appSessionId: string, cause: string): void;
  releaseLiveProcess(live: LiveProcess): void;
  isStopping(): boolean;
}

interface LiveProcess {
  appSessionId: string;
  channel: 'sdk' | 'pty';
  cwd: string;
  adapter: SessionAdapter;
  // Per-spawn settings file, removed on process exit (C).
  settingsPath?: string;
  // sdk-specific
  sdkInput?: AsyncMessageQueue<SdkUserMessage>;
  sdkHandle?: SdkQueryHandle;
  sawResult?: boolean;
  // pty-specific
  pty?: PtyLike;
}

interface PendingGate {
  appSessionId: string;
  input: Record<string, unknown>;
  resolve: (result: SdkPermissionResult) => void;
}

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
  // Spawn preflight (E3). Default is a permissive no-op — the REAL credential
  // probe is injected at composition (app.ts), like the process factories, so
  // CI (which never authenticates) is unaffected. Synchronous by contract:
  // spawnSession/resumeSession are synchronous.
  preflightProbe?: PreflightProbe;
  // Step 3: invoked with the appSessionId right after each session_created emit
  // (spawn + discovery). The push pipeline uses it to register a per-stream
  // subscription for the new session (the router fans out per stream). A pure
  // notification seam — the host owns nothing of the pipeline.
  onSessionCreated?: (appSessionId: string) => void;
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

// Cap a gate prompt at 160 chars. Over the cap, keep the first 159 and append a
// single-char ellipsis so the total is exactly 160 (truncation only — no
// content-aware scrubbing).
const GATE_PROMPT_MAX = 160;
export function truncateGatePrompt(text: string): string {
  if (text.length <= GATE_PROMPT_MAX) {
    return text;
  }
  return `${text.slice(0, GATE_PROMPT_MAX - 1)}…`;
}

// The gate headline's target: pull the human-meaningful subject of a tool call
// out of the SDK's structured tool INPUT object (rule 0.8 — structured data, we
// never parse screen bytes or the prompt string). Mapping is per known tool; the
// field must actually be a string or we return undefined (guard the type — the
// input is an untyped SDK payload). An unknown tool has no meaningful single
// target, so it also returns undefined and the card falls back to the prompt.
export function extractGateTarget(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  let candidateField: unknown;
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
    case 'NotebookEdit':
      candidateField = input.file_path;
      break;
    case 'Bash':
      candidateField = input.command;
      break;
    case 'Glob':
    case 'Grep':
      candidateField = input.pattern;
      break;
    default:
      return undefined;
  }
  return typeof candidateField === 'string' ? candidateField : undefined;
}

// Preflight cache TTL — a spawn burst re-uses one probe result (E3). Short, so a
// credential change is picked up promptly.
const PREFLIGHT_CACHE_TTL_MS = 5_000;

// ── ClaudeSdkAdapter ─────────────────────────────────────────────────────────
class ClaudeSdkAdapter implements SessionAdapter {
  readonly capabilities = CLAUDE_SDK_CAPABILITIES;
  private readonly pendingGates = new Map<string, PendingGate>();

  constructor(
    private readonly factory: SdkQueryFactory,
    private readonly services: AdapterServices,
  ) {}

  spawn(context: AdapterSpawnContext): LiveProcess {
    const input = new AsyncMessageQueue<SdkUserMessage>();
    const handle = this.factory({
      prompt: input,
      options: {
        cwd: context.cwd,
        resume: context.resume,
        settings: context.settingsPath,
        settingSources: this.services.config.sdkSettingSources,
        canUseTool: (toolName, toolInput, options) =>
          this.handleGate(context.appSessionId, toolName, toolInput, options),
      },
    });
    return {
      appSessionId: context.appSessionId,
      channel: 'sdk',
      cwd: context.cwd,
      adapter: this,
      sdkInput: input,
      sdkHandle: handle,
      sawResult: false,
    };
  }

  activate(live: LiveProcess): void {
    void this.consumeSdk(live);
  }

  deliver(live: LiveProcess, text: string): void {
    live.sdkInput?.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  respondInteraction(requestId: string, answer: unknown): InteractionAck {
    const pending = this.pendingGates.get(requestId);
    if (pending === undefined) {
      return { refused: true, reason: 'unknown-gate' };
    }
    this.pendingGates.delete(requestId);
    // Fail-closed: anything other than the explicit 'allow' string denies.
    const result: SdkPermissionResult =
      answer === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'denied from VIMES' };
    pending.resolve(result);
    return { ok: true, appSessionId: pending.appSessionId };
  }

  kill(live: LiveProcess): void {
    live.sdkInput?.close();
    try {
      live.sdkHandle?.close?.();
    } catch {
      // A query already gone is fine — we are tearing everything down.
    }
  }

  // Clear any unresolved gate promises (daemon shutdown).
  reset(): void {
    this.pendingGates.clear();
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
      this.windDown(live);
    }
  }

  private handleSdkMessage(live: LiveProcess, sdkMessage: SdkStreamMessage): boolean {
    const appSessionId = live.appSessionId;

    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
      const claudeSessionId = typeof sdkMessage.session_id === 'string' ? sdkMessage.session_id : undefined;
      if (claudeSessionId !== undefined) {
        const jsonlPath = transcriptFileFor(this.services.projectsRoot, live.cwd, claudeSessionId);
        // I1 + D7 dedupe: emit a mapping ONLY for an id not already known (the
        // hook SessionStart path also emits mappings; the shared known-set makes
        // both idempotent). Always mark the SDK jsonl so the tailer skips it.
        this.services.emitMappingIfNew(appSessionId, claudeSessionId, jsonlPath);
        this.services.markSdkJsonl(jsonlPath);
      }
      return false;
    }

    if (sdkMessage.type === 'assistant' || sdkMessage.type === 'user') {
      const body = sdkMessage.message;
      if (body !== undefined && body !== null) {
        const role = typeof body.role === 'string' ? body.role : sdkMessage.type;
        // Content stored INLINE (D12).
        this.services.emit([messageEvent({ appSessionId, role, content: body.content ?? null })]);
        if (body.usage !== null && typeof body.usage === 'object') {
          // D17 (E2): thread the assistant message id so a later consumer can
          // dedupe the several identical usage snapshots one turn emits.
          const messageId = typeof body.id === 'string' ? body.id : undefined;
          this.services.emit([
            usageBlock(
              messageId === undefined
                ? { appSessionId, usage: body.usage as Record<string, unknown> }
                : { appSessionId, usage: body.usage as Record<string, unknown>, messageId },
            ),
          ]);
        }
      }
      return false;
    }

    if (sdkMessage.type === 'result') {
      live.sawResult = true;
      this.services.emit(withNotificationTrigger(runCompleted({ appSessionId })));
      this.services.driveToDormant(appSessionId, 'run-complete');
      return true;
    }

    return false;
  }

  private windDown(live: LiveProcess): void {
    this.services.releaseLiveProcess(live);
    if (!this.services.isStopping() && live.sawResult !== true) {
      // Stream ended without a result — reconcile liveness to dormant.
      this.services.driveToDormant(live.appSessionId, 'sdk-stream-ended');
    }
    live.sdkInput?.close();
    try {
      live.sdkHandle?.close?.();
    } catch {
      // ignore
    }
  }

  private handleGate(
    appSessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { requestId: string; title?: string },
  ): Promise<SdkPermissionResult> {
    const requestId = options.requestId;
    // Richer gate prompt: prefer the SDK-provided title; when absent fall back to
    // the tool name plus its input JSON, truncated to 160 chars with an ellipsis.
    const prompt =
      typeof options.title === 'string' && options.title.length > 0
        ? options.title
        : truncateGatePrompt(`${toolName}: ${JSON.stringify(input)}`);
    // Surface toolName + a structured target (from the tool INPUT, never the
    // prompt string) so the phone can headline WHAT is being gated. `prompt`
    // stays exactly as above — it remains the fallback/detail line.
    const target = extractGateTarget(toolName, input);
    const gateEvent = gateFired({ appSessionId, prompt, requestId, toolName, target });
    this.services.emit(withNotificationTrigger(gateEvent));
    return new Promise<SdkPermissionResult>((resolve) => {
      this.pendingGates.set(requestId, { appSessionId, input, resolve });
    });
  }
}

// ── ClaudePtyAdapter ─────────────────────────────────────────────────────────
class ClaudePtyAdapter implements SessionAdapter {
  readonly capabilities = CLAUDE_PTY_CAPABILITIES;

  constructor(
    private readonly factory: PtySpawnFactory,
    private readonly services: AdapterServices,
  ) {}

  spawn(context: AdapterSpawnContext): LiveProcess {
    // D15: the PTY child spawns with a scrubbed env (no CLAUDE* keys).
    const environment = scrubClaudeEnv(process.env);
    const args: string[] = [];
    if (context.settingsPath !== undefined) {
      args.push('--settings', context.settingsPath);
    }
    if (context.resume !== undefined) {
      args.push('--resume', context.resume);
    }
    const handle = this.factory('claude', args, {
      cwd: context.cwd,
      env: environment,
      name: context.appSessionId,
    });
    const live: LiveProcess = {
      appSessionId: context.appSessionId,
      channel: 'pty',
      cwd: context.cwd,
      adapter: this,
      pty: handle,
    };
    handle.onData((data) => this.services.countRawBytes(context.appSessionId, Buffer.byteLength(data, 'utf8')));
    handle.onExit(() => this.onExit(live));
    return live;
  }

  activate(live: LiveProcess): void {
    // The tailer is the ONLY structured channel for PTY (rule 0.8).
    this.services.getTailer()?.watchSession({ appSessionId: live.appSessionId, cwd: live.cwd });
  }

  deliver(live: LiveProcess, text: string): void {
    // PTY keystrokes: the text plus a carriage return (rule 0.8 — a raw write,
    // never a parse).
    live.pty?.write(`${text}\r`);
  }

  respondInteraction(): InteractionAck {
    // gates: 'none' — the PTY channel has no runtime gate surface.
    return { refused: true, reason: 'no-runtime-gates' };
  }

  kill(live: LiveProcess): void {
    try {
      live.pty?.kill();
    } catch {
      // A pty already gone is fine.
    }
  }

  private onExit(live: LiveProcess): void {
    this.services.releaseLiveProcess(live);
    this.services.getTailer()?.unwatchSession(live.appSessionId);
    if (!this.services.isStopping()) {
      this.services.driveToDormant(live.appSessionId, 'pty-exit');
    }
  }
}

export class SessionHost implements HookHost {
  private readonly store: EventStore;
  private readonly router: EventRouter;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly config: DaemonConfig;
  private readonly projectsRoot: string;
  private readonly preflightProbe: PreflightProbe;
  private readonly onSessionCreated: ((appSessionId: string) => void) | undefined;

  private readonly sdkAdapter: ClaudeSdkAdapter;
  private readonly ptyAdapter: ClaudePtyAdapter;

  private readonly liveProcesses = new Map<string, LiveProcess>();
  private readonly rawByteCounts = new Map<string, number>();
  // Per-spawn hook secret digests, keyed by appSessionId. Deliberately OUTLIVES
  // the live-process record (survives to re-spawn / shutdown): a SessionEnd hook
  // fires as the process tears down, after the live record is gone, and D10
  // adoption depends on it authenticating. The settings FILE is still removed on
  // exit (C); only the secret's acceptance window lingers.
  private readonly spawnSecrets = new Map<string, Buffer>();
  private preflightCache: { result: PreflightResult; atMs: number } | undefined;
  private tailer: SessionTailer | undefined;
  private stopping = false;
  // D10 attention-guard cache: appSessionIds currently in external custody. The
  // projection is the source of truth for custody; this in-memory set is an O(1)
  // lookup the tailer consults to strip attention setters. Populated at boot from
  // the projection + on discovery; an entry is dropped on adoption.
  private readonly externalSessions = new Set<string>();

  constructor(deps: SessionHostDeps) {
    this.store = deps.store;
    this.router = deps.router;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.config = deps.config;
    this.projectsRoot = deps.projectsRoot ?? defaultProjectsRoot();
    this.preflightProbe = deps.preflightProbe ?? (() => ({ ok: true }));
    this.onSessionCreated = deps.onSessionCreated;

    const services: AdapterServices = {
      emit: (events) => this.router.emit(events),
      config: this.config,
      projectsRoot: this.projectsRoot,
      getTailer: () => this.tailer,
      markSdkJsonl: (jsonlPath) => this.tailer?.markSdkJsonl(jsonlPath),
      countRawBytes: (appSessionId, byteLength) =>
        this.rawByteCounts.set(appSessionId, this.rawBytesReceived(appSessionId) + byteLength),
      emitMappingIfNew: (appSessionId, claudeSessionId, jsonlPath) =>
        this.emitMappingIfNew(appSessionId, claudeSessionId, jsonlPath),
      driveToDormant: (appSessionId, cause) => this.driveToDormant(appSessionId, cause),
      releaseLiveProcess: (live) => this.releaseLiveProcess(live),
      isStopping: () => this.stopping,
    };
    this.sdkAdapter = new ClaudeSdkAdapter(deps.sdkQueryFactory ?? defaultSdkQueryFactory, services);
    this.ptyAdapter = new ClaudePtyAdapter(deps.ptySpawnFactory ?? defaultPtySpawnFactory, services);
  }

  attachTailer(tailer: SessionTailer): void {
    this.tailer = tailer;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(): void {
    this.stopping = false;
    this.router.emit([hostStarted()]);
    this.runRecovery();
    // D10: rebuild the external-custody set from the log and re-mirror those
    // transcripts (a mirror is live-only state, lost across restart), THEN scan
    // for any new terminal-started transcripts (spec §3.2).
    this.rehydrateExternalCustody();
    this.discoverExternalSessions();
  }

  stop(): void {
    this.stopping = true;
    for (const live of this.liveProcesses.values()) {
      live.adapter.kill(live);
      if (live.settingsPath !== undefined) {
        removeSessionSettings(live.settingsPath);
      }
    }
    this.liveProcesses.clear();
    this.spawnSecrets.clear();
    this.sdkAdapter.reset();
    this.router.emit([hostStopped()]);
  }

  // ── observation seams (tests / dispatcher) ──────────────────────────────────
  isLive(appSessionId: string): boolean {
    return this.liveProcesses.has(appSessionId);
  }

  liveProcessCount(): number {
    return this.liveProcesses.size;
  }

  // The cwds of every currently-live process — the File API/Search allowlist is
  // `config.projectRoots ∪ these` (spec §3.4). Returned as a plain array so the
  // composition point (createDaemon) owns the union; nothing reaches into the
  // registry directly.
  liveSessionCwds(): string[] {
    const cwds = new Set<string>();
    for (const live of this.liveProcesses.values()) {
      cwds.add(live.cwd);
    }
    return [...cwds];
  }

  rawBytesReceived(appSessionId: string): number {
    return this.rawByteCounts.get(appSessionId) ?? 0;
  }

  // D10: whether a session is mirrored (external custody). The tailer consults
  // this to strip attention setters from an external stream (the emitter-side
  // guard). O(1) — see the externalSessions field.
  isExternalCustody(appSessionId: string): boolean {
    return this.externalSessions.has(appSessionId);
  }

  // Declared adapter capabilities per channel (D18 — surfaced for the UI/tests).
  capabilitiesFor(channel: 'sdk' | 'pty'): AdapterCapabilities {
    return channel === 'sdk' ? this.sdkAdapter.capabilities : this.ptyAdapter.capabilities;
  }

  // ── spawn ────────────────────────────────────────────────────────────────
  spawnSession(options: { channel: 'sdk' | 'pty'; cwd: string; name?: string }): SpawnResult {
    const appSessionId = this.ids.uuid();
    const preflight = this.checkPreflight();
    if (!preflight.ok) {
      // Refuse before any session is created; a transition_rejected-style record
      // marks the refusal (the projection ignores it — the session never exists).
      this.router.emit([
        transitionRejected({
          appSessionId,
          from: INITIAL_LIVENESS,
          to: 'running',
          cause: `preflight-failed:${preflight.reason}`,
        }),
      ]);
      return { refused: true, reason: 'preflight-failed' };
    }
    this.router.emit([
      sessionCreated({
        appSessionId,
        channel: options.channel,
        cwd: options.cwd,
        name: options.name ?? null,
        forkedFrom: null,
        taskRef: null,
        provider: CLAUDE_PROVIDER,
      }),
    ]);
    this.onSessionCreated?.(appSessionId);
    this.startProcess(appSessionId, options.channel, options.cwd, undefined);
    return { appSessionId };
  }

  // ── send a turn ──────────────────────────────────────────────────────────
  sendMessage(appSessionId: string, text: string): SendResult {
    // D10: the host NEVER writes to a mirrored session. Refuse before the
    // auto-resume path (which would otherwise adopt + resume it) — a mirror is
    // adopted only by explicit action or the resume op, never by a stray send.
    if (this.currentSessions()[appSessionId]?.custody === 'external') {
      return { refused: true, reason: 'external-custody' };
    }
    let live = this.liveProcesses.get(appSessionId);
    if (live === undefined) {
      // No live process: a dormant or interrupted session auto-resumes before
      // the turn is delivered (Wes: clicking resume to send is annoying). The
      // explicit `resume` op still exists for resuming without sending.
      const session = this.currentSessions()[appSessionId];
      if (session === undefined) {
        return { refused: true, reason: 'unknown-session' };
      }
      const liveness = session.liveness;
      if (liveness === 'dead') {
        return { refused: true, reason: 'session-dead' };
      }
      if (liveness === 'spawning') {
        // A spawn/resume is already in flight — no live process yet to accept
        // the turn. Truthful, distinct refusal (do not silently resume again).
        return { refused: true, reason: 'spawning-in-flight' };
      }
      if (liveness !== 'dormant' && liveness !== 'interrupted') {
        // 'running' with no live process is an inconsistent state we do not
        // resume from; report it truthfully rather than double-spawning.
        return { refused: true, reason: 'no-live-process' };
      }
      // dormant | interrupted -> resume (same path as resumeSession).
      const resumeResult = this.resumeSession(appSessionId);
      if ('refused' in resumeResult) {
        return { refused: true, reason: resumeResult.reason };
      }
      live = this.liveProcesses.get(appSessionId);
      if (live === undefined) {
        return { refused: true, reason: 'no-live-process' };
      }
    }
    this.deliverMessage(live, text);
    return { ok: true };
  }

  // Echo the user's turn into the event log as a message(role:'user') BEFORE it
  // reaches the SDK stream / PTY (D12 wants human turns inline).
  private deliverMessage(live: LiveProcess, text: string): void {
    this.router.emit([messageEvent({ appSessionId: live.appSessionId, role: 'user', content: text })]);
    live.adapter.deliver(live, text);
  }

  // ── answer a gate ──────────────────────────────────────────────────────────
  // Wired through the adapter's respondInteraction (D18 gate contract). Attention
  // is a host/projection concern, so the host emits attention_cleared on the ack.
  answerGate(appSessionId: string, requestId: string, response: unknown): AnswerResult {
    // D10: a mirrored session has no host-owned gate surface — refuse (defensive:
    // an external session never has a pending gate anyway).
    if (this.currentSessions()[appSessionId]?.custody === 'external') {
      return { refused: true, reason: 'external-custody' };
    }
    const ack = this.sdkAdapter.respondInteraction(requestId, response);
    if ('refused' in ack) {
      return { refused: true, reason: ack.reason };
    }
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
    // D10: resuming a mirrored session adopts it FIRST (via:'resume'), then falls
    // through to the normal I3 resume path — custody flips to host before any
    // process starts, so the session is now VIMES-owned.
    if (session.custody === 'external') {
      this.emitAdopted(appSessionId, 'resume');
    }
    const preflight = this.checkPreflight();
    if (!preflight.ok) {
      this.router.emit([
        transitionRejected({
          appSessionId,
          from: session.liveness,
          to: 'spawning',
          cause: `preflight-failed:${preflight.reason}`,
        }),
      ]);
      return { refused: true, reason: 'preflight-failed' };
    }
    // dormant | interrupted -> spawning (via the machine), then startProcess
    // drives spawning -> running. I3: resume from the RECORDED cwd + last mapped
    // claudeSessionId; no new appSessionId, no fork.
    this.emitGuardedLiveness(appSessionId, 'spawning', 'resume');
    const lastClaudeSessionId = session.claudeSessionIds.at(-1)?.id;
    this.startProcess(appSessionId, session.channel, session.cwd, lastClaudeSessionId);
    return { appSessionId };
  }

  // ── kill (protocol v0.2) ────────────────────────────────────────────────────
  // Software kills a process only on explicit human command (the codor stall-flag
  // stance). Terminates the owned live process; liveness follows to dormant.
  killSession(appSessionId: string): KillResult {
    const session = this.currentSessions()[appSessionId];
    if (session === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    if (session.custody === 'external') {
      // We do not own the process — refuse (D10).
      return { refused: true, reason: 'external-custody' };
    }
    const live = this.liveProcesses.get(appSessionId);
    if (live === undefined) {
      return { refused: true, reason: 'no-live-process' };
    }
    live.adapter.kill(live); // SIGTERM the child (pty.kill) / close the SDK query.
    this.releaseLiveProcess(live);
    // Drive liveness to dormant explicitly (deterministic; the adapter's own exit
    // path would also reach dormant, but its cause would be channel-specific).
    this.driveToDormant(appSessionId, 'killed');
    return { ok: true };
  }

  // ── adopt (protocol v0.2, D10) ──────────────────────────────────────────────
  // Explicit custody transfer of a mirrored session to the host (now
  // resumable/killable). Liveness is untouched — the session stays where it is.
  adoptSession(appSessionId: string): AdoptResult {
    const session = this.currentSessions()[appSessionId];
    if (session === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    if (session.custody !== 'external') {
      return { refused: true, reason: 'not-external' };
    }
    this.emitAdopted(appSessionId, 'explicit');
    return { ok: true };
  }

  // ── rename (protocol v0.2) ──────────────────────────────────────────────────
  // Any custody — renaming a mirror is fine. The name is validated 1–120 chars at
  // the WS boundary (zod); the host re-checks the bound so a direct caller cannot
  // slip an empty/oversized name past.
  renameSession(appSessionId: string, name: string): RenameResult {
    if (this.currentSessions()[appSessionId] === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    if (name.length === 0 || name.length > 120) {
      return { refused: true, reason: 'invalid-name' };
    }
    this.router.emit([sessionRenamed({ appSessionId, name })]);
    return { ok: true };
  }

  // ── seen (protocol v0.2, D9) ────────────────────────────────────────────────
  // Viewing a session acks its notification (sets seenAt; never clears attention).
  // Any custody — you can see a mirror.
  markSeen(appSessionId: string): SeenResult {
    if (this.currentSessions()[appSessionId] === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    this.router.emit([seenEvent({ appSessionId })]);
    return { ok: true };
  }

  // ── clear attention (protocol v0.2, D9) ─────────────────────────────────────
  // An explicit dismiss — the only clear path besides a gate answer / resume.
  clearAttention(appSessionId: string): ClearAttentionResult {
    if (this.currentSessions()[appSessionId] === undefined) {
      return { refused: true, reason: 'unknown-session' };
    }
    this.router.emit([attentionCleared({ appSessionId, cause: 'dismissed' })]);
    return { ok: true };
  }

  // ── discovery (protocol v0.2, D10, spec §3.2) ───────────────────────────────
  // On-demand scan of the configured project roots' transcript dirs. Each foreign
  // transcript mints a mirrored external session (session_created custody:external
  // → liveness interrupted → claude_session_mapped → resync_marker) and registers
  // the file with the tailer from current EOF. Idempotent: a file already mapped
  // to a known session is skipped, so a re-scan never duplicates a session.
  discoverExternalSessions(): number {
    const sessions = this.currentSessions();
    const knownJsonlPaths = new Set<string>();
    const knownClaudeSessionIds = new Set<string>();
    for (const session of Object.values(sessions)) {
      for (const mapping of session.claudeSessionIds) {
        knownJsonlPaths.add(mapping.jsonlPath);
        knownClaudeSessionIds.add(mapping.id);
      }
    }
    const discovered = scanForExternalTranscripts({
      projectRoots: this.config.projectRoots,
      projectsRoot: this.projectsRoot,
      knownJsonlPaths,
      knownClaudeSessionIds,
    });
    for (const transcript of discovered) {
      const appSessionId = this.ids.uuid();
      // spawning → interrupted is a legal edge; interrupted is the resumable
      // no-live-process state (mirrors boot recovery). spawning → dormant is NOT
      // a legal edge, so the mirrored session lands in 'interrupted'.
      this.router.emit([
        sessionCreated({
          appSessionId,
          channel: 'pty',
          cwd: transcript.cwd,
          name: null,
          forkedFrom: null,
          taskRef: null,
          provider: CLAUDE_PROVIDER,
          custody: 'external',
        }),
        livenessChanged({ appSessionId, to: 'interrupted', cause: 'discovered-external' }),
        claudeSessionMapped({
          appSessionId,
          claudeSessionId: transcript.claudeSessionId,
          jsonlPath: transcript.jsonlPath,
        }),
        resyncMarker({ appSessionId, reason: 'pre-adoption-history' }),
      ]);
      this.externalSessions.add(appSessionId);
      this.onSessionCreated?.(appSessionId);
      this.tailer?.mirrorExternalFile({ appSessionId, jsonlPath: transcript.jsonlPath });
    }
    return discovered.length;
  }

  // ── hook ingress surface (HookHost) ─────────────────────────────────────────
  verifyHookSecret(appSessionId: string, presentedSecret: string | undefined): HookAuthResult {
    const digest = this.spawnSecrets.get(appSessionId);
    if (digest === undefined) {
      return 'unknown-session';
    }
    if (presentedSecret === undefined || presentedSecret.length === 0) {
      return 'missing-secret';
    }
    return secretMatchesDigest(presentedSecret, digest) ? 'ok' : 'bad-secret';
  }

  ingestHook(appSessionId: string, body: Record<string, unknown>): HookIngestResult {
    const hookEventName = typeof body.hook_event_name === 'string' ? body.hook_event_name : undefined;
    const construct = hookEventName !== undefined ? HOOK_EVENT_CONSTRUCTORS[hookEventName] : undefined;
    if (construct === undefined) {
      return { status: 'unknown-event' };
    }
    // Stamp appSessionId from the URL onto the (loose) body; emit the hook event.
    this.router.emit([construct({ ...body, appSessionId })]);
    if (hookEventName === 'SessionStart') {
      this.correlateFromHook(appSessionId, body);
    }
    return { status: 'emitted' };
  }

  // ── internals ────────────────────────────────────────────────────────────
  private startProcess(
    appSessionId: string,
    channel: 'sdk' | 'pty',
    cwd: string,
    resume: string | undefined,
  ): void {
    const adapter: SessionAdapter = channel === 'sdk' ? this.sdkAdapter : this.ptyAdapter;
    const settingsPath = this.prepareHookChannel(appSessionId);
    const cause = resume === undefined ? 'spawn' : 'resume';
    const live = adapter.spawn({ appSessionId, cwd, resume, settingsPath });
    live.settingsPath = settingsPath;
    this.liveProcesses.set(appSessionId, live);
    this.emitGuardedLiveness(appSessionId, 'running', cause);
    adapter.activate(live);
  }

  // Mint a per-spawn secret, write the per-session settings file registering the
  // five hook relays (C), and register the secret digest for the ingress. Best
  // effort: an fs failure degrades to no injected settings (SDK-init correlation
  // still works) rather than failing the spawn.
  private prepareHookChannel(appSessionId: string): string | undefined {
    try {
      const { secret, digest } = mintSpawnSecret();
      const content = buildSessionSettings({ appSessionId, hookPort: this.config.hookPort, secret });
      const settingsPath = writeSessionSettings(this.config.dataDir, appSessionId, content);
      this.spawnSecrets.set(appSessionId, digest);
      return settingsPath;
    } catch {
      // No settings file — the session still spawns; the hook relay is simply
      // absent for it. Never logs the secret.
      return undefined;
    }
  }

  private checkPreflight(): PreflightResult {
    const nowMs = Date.parse(this.clock.now());
    if (this.preflightCache !== undefined && nowMs - this.preflightCache.atMs < PREFLIGHT_CACHE_TTL_MS) {
      return this.preflightCache.result;
    }
    const result = this.preflightProbe();
    this.preflightCache = { result, atMs: nowMs };
    return result;
  }

  private correlateFromHook(appSessionId: string, body: Record<string, unknown>): void {
    const claudeSessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
    if (claudeSessionId === undefined) {
      return;
    }
    const session = this.currentSessions()[appSessionId];
    if (session === undefined) {
      return;
    }
    // Prefer the hook's own transcript_path (observed truth, rule 0.7); fall back
    // to the encoded path if it is absent.
    const transcriptPath =
      typeof body.transcript_path === 'string' && body.transcript_path.length > 0
        ? body.transcript_path
        : transcriptFileFor(this.projectsRoot, session.cwd, claudeSessionId);
    this.emitMappingIfNew(appSessionId, claudeSessionId, transcriptPath);
  }

  // Emit claude_session_mapped ONLY for a claudeSessionId not already mapped for
  // this session (D7 dedupe — the SDK-init and hook-SessionStart paths both call
  // here; the known-set is seeded from the log, so both are idempotent).
  private emitMappingIfNew(appSessionId: string, claudeSessionId: string, jsonlPath: string): void {
    const session = this.currentSessions()[appSessionId];
    const known = new Set((session?.claudeSessionIds ?? []).map((entry) => entry.id));
    if (known.has(claudeSessionId)) {
      return;
    }
    this.router.emit([claudeSessionMapped({ appSessionId, claudeSessionId, jsonlPath })]);
  }

  // Registry cleanup on process exit: drop the live record (identity-guarded so a
  // re-spawn is never clobbered) and remove the per-session settings file. The
  // spawn secret is deliberately NOT cleared here (see spawnSecrets).
  private releaseLiveProcess(live: LiveProcess): void {
    if (this.liveProcesses.get(live.appSessionId) === live) {
      this.liveProcesses.delete(live.appSessionId);
    }
    if (live.settingsPath !== undefined) {
      removeSessionSettings(live.settingsPath);
      live.settingsPath = undefined;
    }
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

  // D10: emit session_adopted and drop the external-custody guard entry. The
  // projection flips custody→host on the event; the set mirrors that for the
  // tailer's O(1) attention guard.
  private emitAdopted(appSessionId: string, via: 'explicit' | 'resume'): void {
    this.router.emit([sessionAdopted({ appSessionId, via })]);
    this.externalSessions.delete(appSessionId);
  }

  // D10: at boot, rebuild the external-custody set from the log (custody survives
  // restart; the in-memory set does not) and re-establish each mirror from EOF (a
  // mirror is live-only tailer state, also lost across restart).
  private rehydrateExternalCustody(): void {
    const sessions = this.currentSessions();
    for (const [appSessionId, session] of Object.entries(sessions)) {
      if (session.custody !== 'external') {
        continue;
      }
      this.externalSessions.add(appSessionId);
      const lastMapping = session.claudeSessionIds.at(-1);
      if (lastMapping !== undefined) {
        this.tailer?.mirrorExternalFile({ appSessionId, jsonlPath: lastMapping.jsonlPath });
      }
    }
  }

  // Read current session facts by folding the log (source of truth, I13).
  private currentSessions(): Record<string, SessionRecord> {
    return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(this.store)).sessions;
  }

  // Guarded liveness emission (rule 0.3): legal edge → liveness_changed, else
  // transition_rejected.
  private emitGuardedLiveness(appSessionId: string, to: Liveness, cause: string): void {
    const from: Liveness = this.currentSessions()[appSessionId]?.liveness ?? INITIAL_LIVENESS;
    if (canTransition(from, to)) {
      this.router.emit([livenessChanged({ appSessionId, to, cause })]);
    } else {
      this.router.emit([transitionRejected({ appSessionId, from, to, cause })]);
    }
  }

  // running -> dormant is the only legal path here; anything else is left alone.
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
        settings: options.settings,
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
