import { createRequire } from 'node:module';
import { z } from 'zod';
import {
  EventRouter,
  INITIAL_LIVENESS,
  HOOK_EVENT_CONSTRUCTORS,
  attentionCleared,
  canTransition,
  claudeSessionMapped,
  compactionObserved,
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
  type CompactionGateDecision,
  type EventInput,
  type EventStore,
  type IdSource,
  type Liveness,
  type ReportCompletionPayload,
  type ReportReviewPayload,
  type SessionRecord,
  type TaskStage,
} from '@vimes/core';
import type { DaemonConfig } from './config.js';
import { defaultProjectsRoot, transcriptFileFor } from './transcriptPaths.js';
import {
  envWithHookSecret,
  mintHookChannel,
  removeSessionSettings,
  secretMatchesDigest,
  type HookChannel,
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

// ── S7·6b: the SDK-agnostic report-tool spec (the SDK-boundary rule) ─────────
//
// The adapter (this file, the testable core) builds a PLAIN spec — a name, a
// description, a zod raw shape, and an async handler — and NEVER imports the SDK.
// The `defaultSdkQueryFactory` (the determinism-exempt boundary) is the ONLY code
// that wraps these into `createSdkMcpServer` + `tool()` and mounts them on the
// query's `mcpServers`. So `createSdkMcpServer`/`tool` stay out of CI (rule 0.3 /
// D18), exactly as they did for `query` itself. See `buildReportMcpServers`.
//
// `inputSchema` is a zod RAW SHAPE (the object-of-schemas the SDK's `tool()` takes
// as its 3rd arg — sdk.d.ts:6745), not a wrapped `z.object`, so the factory hands
// it straight through. The handler's `{ ok }` return is wrapped into the SDK's
// `CallToolResult` by the factory (the handler here is SDK-agnostic).
export interface SdkReportToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  // ⚠ S8·6 ADDED THE OPTIONAL `acknowledgement`, ADDITIVELY. A handler that sets
  // it has the factory return THAT string instead of the spec's static
  // `recorded`/`notRecorded` below; a handler that does not (both report tools —
  // and they were not touched) produces byte-identical model-facing text. The
  // reason it exists is that `create_task`'s answer cannot be a constant: it names
  // the MINTED taskId, and on the malformed path it names the field that failed
  // validation. A per-CALL fact cannot live on a per-SPEC constant.
  handler: (input: unknown) => Promise<{ ok: boolean; acknowledgement?: string }>;
  // ⚠ S7·7b ADDED THIS, and the reason is that there are now TWO tools on one
  // server. The factory's wrap-up `CallToolResult` used to hard-code "Review
  // verdict recorded." — correct while `report_review` was the only customer, and
  // a LIE to the model the moment `report_completion` rides the same wrapper. The
  // acknowledgement therefore belongs to the SPEC, not to the factory. Both
  // strings are stated per-tool so a reader can see exactly what each tool says
  // back; `report_review`'s two are its pre-S7·7b strings VERBATIM, so the review
  // path's model-facing bytes are unchanged (the review path is out of scope for
  // S7·7b — this is an additive field, not a behaviour change).
  acknowledgement: {
    // Returned when `handler` resolved `{ ok: true }` WITHOUT its own
    // acknowledgement. S8·6 note: still REQUIRED rather than optional, so every
    // spec states in one place what it says back on each outcome even when its
    // handler usually overrides it — a spec whose only answer lived inside a
    // closure would be a tool nobody can read the words of.
    readonly recorded: string;
    // Returned when it resolved `{ ok: false }` without its own acknowledgement.
    // The two report handlers never produce that; the string exists because the
    // `{ ok: boolean }` contract permits it and a silent success message on a
    // failure would be the worst possible answer.
    readonly notRecorded: string;
  };
  // ── D65 (S8·6): WHICH in-process MCP server this tool mounts under ───────────
  //
  // MCP tool names compose as `mcp__<server>__<tool>`, so the server IS the
  // model-facing prefix, and the convention is one server per VERB FAMILY:
  // `vimes_report` (stage-run report tools) and `vimes_board` (the orchestrator's
  // board verbs). ABSENT = `vimes_report`, which is what both report specs leave
  // it as — so their mount, their server name and their wire names are unchanged
  // to the byte.
  //
  // The family split is not cosmetic: it mirrors the exposure matrix. A doctrine
  // that does not grant board verbs simply never mounts `vimes_board`, so there is
  // no per-tool filtering anywhere and no way to half-grant a family.
  server?: string;
}

export interface SdkQueryOptions {
  cwd: string;
  resume?: string;
  // Per-session settings file path (C). Passed to Options.settings so the SDK
  // loads the injected hook relays alongside the project tier (D14 MERGE).
  settings?: string;
  // Environment for the Claude child, carrying VIMES_HOOK_SECRET so the injected
  // relays can expand it. Set together with `settings` or not at all.
  // FRAGILE-ADAPTER (rule 0.6): the SDK's Options.env REPLACES the child
  // environment rather than merging, so this is a FULL env (process.env spread
  // in) — never just the one variable.
  env?: Record<string, string | undefined>;
  settingSources: string[];
  canUseTool: SdkCanUseTool;
  // D48 native plan capture: the planning stage spawns write-blocked in plan
  // mode. Absent (the common case) leaves the SDK on its default mode exactly as
  // before; only a plan-capture spawn sets it. See ClaudeSdkAdapter.spawn.
  // 'plan' = plan-capture (D48); 'auto' = dispatched classifier footing (spike
  // 2026-07-26); absent = SDK default, unchanged.
  permissionMode?: 'plan' | 'auto';
  // D50: the closed tool allowlist for a dispatched session (SDK `tools` option).
  // Absent = the SDK's default tool set, byte-identical to a non-dispatched spawn.
  tools?: string[];
  // D50: named sub-agent spawn surfaces removed from context (SDK `disallowedTools`
  // belt). Set together with `tools` on a dispatched spawn, or absent entirely.
  disallowedTools?: string[];
  // S7·6b: in-process report tools exposed to this session — as of S7·7d SCOPED
  // TO THE DISPATCHED STAGE (`report_completion` for implementing, `report_review`
  // for review, NEITHER for planning; see `reportToolsOptionFor`). The factory
  // wraps them into ONE `mcpServers` entry. Absent (the common case, and every
  // planning spawn) = no custom tools, options byte-identical to before S7·6b.
  reportTools?: SdkReportToolSpec[];
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

// D50: the closed tool allowlist for every DISPATCHED task session. Passed as the
// SDK `tools` option (a closed allowlist — everything not listed is removed from
// the model's context). Spike-proven (spike-path1-findings round 3/4): with all
// spawn surfaces omitted, a dispatched session spawns ZERO sub-agents by any route
// AND the model adapts to inline work. Wes-approved set (2026-07-26).
const DISPATCHED_SESSION_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'ExitPlanMode', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite',
] as const;

// D50 belt (defense-in-depth, rule 0.6 drift resistance): also name-deny every
// known sub-agent spawn surface via `disallowedTools`. Redundant with the closed
// `tools` allowlist today, but survives a future SDK reinterpretation of `tools`.
// Round-2 spike proved Workflow escapes an [Agent,Task]-only denylist — hence all four.
const SUBAGENT_SPAWN_TOOLS = ['Agent', 'Task', 'Workflow', 'ScheduleWakeup'] as const;

interface AdapterSpawnContext {
  appSessionId: string;
  cwd: string;
  resume: string | undefined;
  // The settings file AND the secret env travel as one value on purpose — an
  // adapter cannot register the hook relays without also being handed the
  // variable that makes them authenticate (see mintHookChannel). `undefined`
  // means no relays at all for this spawn, not unauthenticated relays.
  hookChannel: HookChannel | undefined;
  // D48: 'plan' spawns the SDK session write-blocked for native plan capture;
  // absent = today's behaviour exactly. The PTY adapter ignores it (plan mode is
  // an SDK concern).
  // 'plan' = plan-capture (D48); 'auto' = dispatched classifier footing (spike
  // 2026-07-26); absent = SDK default, unchanged.
  permissionMode?: 'plan' | 'auto';
  // D50: `true` marks a session VIMES dispatched unattended — the SDK adapter then
  // clamps it to the closed tool allowlist + spawn-family denylist so it cannot fan
  // out sub-agents. Absent/false = today's behaviour. The PTY adapter ignores it.
  dispatched?: boolean;
  // S7·7d: the task stage this dispatched session is running. Set by the
  // dispatcher on dispatched spawns; selects which report tools the session is
  // OFFERED (see `reportToolsOptionFor`). Absent on interactive spawns — and on a
  // dispatched spawn that somehow omits it, which falls back to the pre-S7·7d
  // both-tools exposure. The PTY adapter ignores it.
  stage?: TaskStage;
  // S8·6 (D56/D65): the project this session is the STANDING ORCHESTRATOR for.
  //
  // ⚠ **DERIVED FROM THE SESSION RECORD, NEVER FROM THE CALL** — see
  // `startProcess`, which is the one place it is read. Absent for every other
  // session, which is today's behaviour exactly. The PTY adapter ignores it.
  //
  // Present means: mount the board family (`vimes_board`), and NOT the report
  // family. It does NOT mean `dispatched` — an orchestrator carries no `tools`
  // clamp and no `stage`, because it is a conversation partner, not a run.
  orchestratorForProjectId?: string;
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
  // D48 native plan capture (I10): the SDK adapter OBSERVES a plan-mode planner's
  // ExitPlanMode and PROPOSES the plan text back through here; the host forwards it
  // to the dispatcher, which owns task state. The adapter never touches task state
  // or the artifact store itself.
  onPlanCaptured(appSessionId: string, planText: string): void;
  // S7·6b review capture (I10): the SDK adapter OBSERVES a dispatched review
  // session's `report_review` tool call (in the tool HANDLER — canUseTool is
  // bypassed under `auto`, spike 2026-07-26) and PROPOSES the reported criteria
  // back through here; the host forwards it to the dispatcher's `recordReview`,
  // which owns task state. The adapter never touches task state itself. Mirrors
  // `onPlanCaptured` exactly.
  onReviewReported(appSessionId: string, criteria: ReportReviewPayload['criteria']): void;
  // S7·7b completion capture (I10): the mirror of `onReviewReported` for the OTHER
  // half of the loop. The SDK adapter OBSERVES a dispatched implementing session's
  // `report_completion` tool call (same handler-not-canUseTool reasoning) and
  // PROPOSES the worklog back through here; the host forwards it to the
  // dispatcher's `recordCompletion`, which owns task state and — D53 — proposes the
  // `implementing → review` OUTCOME transition. The adapter never touches task
  // state itself.
  onCompletionReported(appSessionId: string, worklog: ReportCompletionPayload['worklog']): void;
  // S8·6 (D56's author grant): the board-verb specs a STANDING ORCHESTRATOR for
  // this project is granted. Injected rather than built here for the reason
  // createTaskTool.ts's header spells out — `create_task` needs the task writer
  // and the project registry, and the session host is not allowed to read task
  // state (D18). Returns `[]` when no grant is composed (the default), which mounts
  // NOTHING and leaves the spawn options byte-identical to a pre-S8·6 one.
  orchestratorReportTools(projectId: string): SdkReportToolSpec[];
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

// The narrow slice of the daemon's `CompactionSteward` the host actually calls
// (S8·4). Declared as an interface rather than imported as the class so the host
// keeps no dependency on the steward's construction — the same posture the
// `HookHost` surface takes towards the ingress, in the other direction.
export interface CompactionStewardSurface {
  decideGate(appSessionId: string): CompactionGateDecision;
  resumeContextForCompactedSession(appSessionId: string): string | null;
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
  // D48 native plan capture (I10): invoked when a plan-capture session's
  // ExitPlanMode is intercepted, carrying the captured plan text. app.ts wires it
  // to `taskDispatcher.recordPlan` (the state-owning half, S7·5b-i). Unset = no-op:
  // the interception still denies cleanly and the plan is simply not recorded.
  onPlanCaptured?: (appSessionId: string, planText: string) => void;
  // S7·6b review capture (I10): invoked when a dispatched review session calls the
  // `report_review` tool, carrying the reviewer's reported criteria. app.ts wires it
  // to `taskDispatcher.recordReview` (the state-owning half). Unset = no-op: the tool
  // handler still returns cleanly and the verdict is simply not recorded.
  onReviewReported?: (appSessionId: string, criteria: ReportReviewPayload['criteria']) => void;
  // S7·7b completion capture (I10): invoked when a dispatched implementing session
  // calls the `report_completion` tool, carrying the author's worklog. app.ts wires
  // it to `taskDispatcher.recordCompletion` (the state-owning half). Unset = no-op:
  // the tool handler still returns cleanly and the completion is simply not
  // recorded — which also means the `implementing → review` outcome does not fire.
  onCompletionReported?: (
    appSessionId: string,
    worklog: ReportCompletionPayload['worklog'],
  ) => void;
  // S8·4 (D64): the compaction door + the post-compaction pointer. Injected
  // rather than built here because the policy needs facts the host does not own
  // (the project registry, the standing-notes directory, the nudge ledger folded
  // from the log). UNSET = no opinion: every PreCompact answers `allow` and every
  // SessionStart gets today's plain ack, i.e. exactly the pre-S8·4 behavior.
  compactionSteward?: CompactionStewardSurface;
  // S8·6 (D56's author grant, D65): the board-verb specs a standing orchestrator
  // is granted, by project. app.ts composes `create_task` here off the daemon's
  // single `TaskWriter` and the project registry (see createTaskTool.ts for why
  // the host cannot build it itself). UNSET = no grant at all: an orchestrator
  // spawns with no VIMES tools and the query options are byte-identical to the
  // pre-S8·6 ones — which is exactly what every test that does not care about the
  // grant gets, and what a composition that deliberately revoked it would get.
  orchestratorReportTools?: (projectId: string) => SdkReportToolSpec[];
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

// ── S8·4a compaction-metadata guards (fragile-adapter boundary, rule 0.6) ────
// Mirrors mapper.ts's `isObject`/`optionalNonnegativeInt` exactly (this file
// stays free-standing rather than importing a transcript-path helper for one
// small guard). A malformed or missing `compact_metadata` body degrades
// field-by-field — see handleSdkMessage's `system`/`compact_boundary` branch.
function isRecordLike(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}
function optionalNonnegativeInt(candidate: unknown): number | undefined {
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

// Preflight cache TTL — a spawn burst re-uses one probe result (E3). Short, so a
// credential change is picked up promptly.
const PREFLIGHT_CACHE_TTL_MS = 5_000;

// ── S7·6b: the `report_review` tool's input shape ────────────────────────────
//
// ⚠ FINDING (2026-07-26), surfaced rather than quietly patched (rule 0.1): the
// work-order specified DERIVING this schema from core as
// `z.object({ criteria: reportReviewPayloadSchema.shape.criteria })`. That does NOT
// work here. `packages/core` validates with zod **v3** (`_def`, no `_zod`); the
// daemon tree + the Agent SDK use zod **v4** — the exact split taskApi.ts:92-97
// documents. Reusing core's schema OBJECT throws at construction
// ("Invalid element … expected a Zod schema"), and passing it as a raw shape
// converts to a broken JSON schema at query time (the SDK reads `_zod.toJSONSchema()`,
// which a v3 schema lacks). So the shape is RESTATED with the daemon's v4 zod, and
// BOUND to core at the TYPE level below — the same drift-guard discipline taskApi.ts
// applies to its boundary vocabularies (a drift in core reddens THIS build, not a
// live session). `criterionId`/`text` mirror `acceptanceCriterionSchema` (both
// `z.string()`); `verdict`/`note` mirror `reportReviewPayloadSchema.criteria`.
const reviewCriteriaSchema = z.array(
  z.object({
    criterionId: z.string(),
    verdict: z.enum(['pass', 'fail']),
    note: z.string().optional(),
  }),
);
const REVIEW_REPORT_INPUT_SHAPE = { criteria: reviewCriteriaSchema } satisfies z.ZodRawShape;
type ReviewReportCriteria = z.infer<typeof reviewCriteriaSchema>;
// Drift bind (both directions = structural equivalence with core): if
// `reportReviewPayloadSchema.criteria` gains/loses/renames a field, one of these
// stops compiling and the build fails — the derivation-without-reuse guarantee.
const _reviewCriteriaMatchesCore = [] as ReviewReportCriteria satisfies ReportReviewPayload['criteria'];
const _coreMatchesReviewCriteria = [] as ReportReviewPayload['criteria'] satisfies ReviewReportCriteria;
void _reviewCriteriaMatchesCore;
void _coreMatchesReviewCriteria;

const REVIEW_TOOL_DESCRIPTION =
  'Report your independent review verdict: one entry per acceptance criterion ' +
  '(its id, pass or fail, an optional note).';

// ── S7·7b: the `report_completion` tool's input shape ────────────────────────
//
// The exact mirror of the review shape above, and it carries the SAME zod v3/v4
// FINDING verbatim — `reportCompletionPayloadSchema` is core's zod v3 object and
// cannot be reused here, so the shape is RESTATED in the daemon's v4 zod and BOUND
// to core at the TYPE level below. Do not "simplify" this into an import; that is
// the failure the S7·6b finding recorded (D52).
//
// WORKLOG-ONLY, exactly as review is criteria-only: `taskId` / `stage` / `attempt`
// / `workOrderRev` are VIMES's to supply (`recordCompletion` derives them from the
// task record), never the session's to assert. A session that could name its own
// taskId could report a completion against a task it never ran.
//
// Both arrays are REQUIRED and may be EMPTY — `reportCompletionPayloadSchema.worklog`
// makes them `z.array(z.string())` with no `.optional()`, and matching that exactly
// is what the two-way bind below enforces. An attempt that genuinely rejected no
// paths reports `pathsRejected: []` rather than omitting the key, which keeps the
// stored payload one shape instead of two.
const completionWorklogSchema = z.object({
  decisionsMade: z.array(z.string()),
  pathsRejected: z.array(z.string()),
});
const COMPLETION_REPORT_INPUT_SHAPE = { worklog: completionWorklogSchema } satisfies z.ZodRawShape;
type CompletionReportWorklog = z.infer<typeof completionWorklogSchema>;
// Drift bind (both directions = structural equivalence with core), the same
// guarantee the review pair above gives: if `reportCompletionPayloadSchema.worklog`
// gains, loses or renames a field, ONE of these two stops compiling and the build
// fails. Verified by breaking (rename a field in the restated shape → both red).
const _completionWorklogMatchesCore =
  {} as CompletionReportWorklog satisfies ReportCompletionPayload['worklog'];
const _coreMatchesCompletionWorklog =
  {} as ReportCompletionPayload['worklog'] satisfies CompletionReportWorklog;
void _completionWorklogMatchesCore;
void _coreMatchesCompletionWorklog;

// ⚠ LOAD-BEARING PROSE, and it must AGREE WITH THE BRIEFING. The implementing
// briefing's closing (core `IMPLEMENTING_BRIEFING_CLOSING`, S7·7b) names this tool
// and these two field names verbatim; if either drifts, the model is told to call
// something that is not here. The field names are the tool's own input keys.
const COMPLETION_TOOL_DESCRIPTION =
  'Report your completed work: a worklog of decisionsMade (calls you made and why) ' +
  'and pathsRejected (dead ends tried or considered and abandoned).';

// ── ClaudeSdkAdapter ─────────────────────────────────────────────────────────
class ClaudeSdkAdapter implements SessionAdapter {
  readonly capabilities = CLAUDE_SDK_CAPABILITIES;
  private readonly pendingGates = new Map<string, PendingGate>();
  // D48: appSessionIds spawned in plan mode. handleGate consults this to know
  // WHICH sessions capture their ExitPlanMode (interception is gated on the marker
  // AND the tool name, never the tool name alone). An entry is added on a plan-mode
  // spawn and removed on process exit (windDown) — mirroring how pendingGates is
  // cleared, per-session state that must not outlive the process.
  private readonly planCaptureSessions = new Set<string>();
  // D50: appSessionIds VIMES dispatched unattended. handleGate consults this to
  // auto-deny AskUserQuestion (no human to answer it). Added on a dispatched spawn,
  // removed on process exit (windDown) — same lifecycle as planCaptureSessions.
  private readonly dispatchedSessions = new Set<string>();

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
        settings: context.hookChannel?.settingsPath,
        // The SDK's Options.env REPLACES the child environment, so spread the
        // daemon's own env in; the hook secret is merged on top. When there is
        // no hook channel we leave env unset so the child inherits process.env
        // exactly as before.
        env:
          context.hookChannel === undefined
            ? undefined
            : envWithHookSecret(process.env, context.hookChannel),
        settingSources: this.services.config.sdkSettingSources,
        canUseTool: (toolName, toolInput, options) =>
          this.handleGate(context.appSessionId, toolName, toolInput, options),
        // D48: set the key ONLY for a plan-capture spawn. Absent leaves the
        // no-plan-mode options object byte-identical to before this unit.
        ...(context.permissionMode === undefined
          ? {}
          : { permissionMode: context.permissionMode }),
        // D50: set the closed allowlist + spawn-family denylist ONLY for a
        // dispatched spawn. Absent leaves a non-dispatched options object
        // byte-identical to before this unit (same spread idiom as permissionMode).
        ...(context.dispatched === true
          ? { tools: [...DISPATCHED_SESSION_TOOLS], disallowedTools: [...SUBAGENT_SPAWN_TOOLS] }
          : {}),
        // S7·6b/S7·7b/S7·7d: expose the in-process report tools to a dispatched
        // session, SCOPED TO THE STAGE THAT CAN HONESTLY USE ONE (the spike proved
        // `mcpServers` is orthogonal to the D50 `tools` clamp — no allowlist entry
        // needed, no spawn hole; D52). The handlers close over this session's id +
        // the services callbacks and only OBSERVE + PROPOSE (I10) — they never touch
        // task state. Set via the same spread idiom, so a non-dispatched spawn stays
        // byte-identical.
        //
        // ⚠ S7·7d NARROWED THIS FROM BOTH-TOOLS-ON-EVERY-DISPATCHED-SESSION, a
        // recorded reversal. The old comment argued the wide exposure was deliberate
        // rather than lazy because the guard lives in the DISPATCHER, where the task
        // record is. That half is STILL TRUE and the guards STAY as defense in depth:
        // `recordReview` no-ops without a `review` sessionRef and `recordCompletion`
        // without an `implementing` one, both adjudicated against real state, and
        // neither moved in this unit. What the argument missed is that EXPOSURE IS
        // NOT FREE. Under D48 the planning stage runs `permissionMode: 'plan'`, and
        // in plan mode the SDK routes MCP tool calls through `canUseTool` — so an
        // offered tool is a tool the model may call, and a call is a PERMISSION GATE.
        // Observed 2026-07-28 (task 25f9c558, planning session f35a77dd): the planner
        // finished capturing its plan, called `report_completion`, and fired a gate.
        // Wes happened to be attending and approved it; the dispatcher guard then
        // correctly no-opped it. UNATTENDED that gate is a STALL — the fleet's planner
        // sits waiting on an approval nobody will give. So the guard stays where it
        // is, and the OFFER moves to where it is true.
        //
        // ⚠ S8·6 ADDED THE OTHER BRANCH, AND THE `? :` IS THE POINT. A session is
        // a dispatched RUN or a standing ORCHESTRATOR, never both, so the two
        // exposures cannot compose: a dispatched spawn is offered its stage's
        // report tool and can never see `vimes_board`; an orchestrator is offered
        // the board family and never a report tool, because it does not report —
        // it authors, and nothing dispatched it to finish. D50's clamp is
        // untouched on both sides (see the orchestrator branch's own note).
        ...(context.dispatched === true
          ? this.reportToolsOptionFor(context.appSessionId, context.stage)
          : this.orchestratorToolsOptionFor(context.orchestratorForProjectId)),
      },
    });
    if (context.permissionMode === 'plan') {
      this.planCaptureSessions.add(context.appSessionId);
    }
    if (context.dispatched === true) {
      this.dispatchedSessions.add(context.appSessionId);
    }
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

  // S7·7d: WHICH report tools a dispatched session is offered, by stage. Returns
  // the OPTION FRAGMENT rather than an array so the planning case can be the
  // ABSENCE of the `reportTools` key rather than an empty array — the spread idiom
  // this file uses everywhere else for "this key does not apply to this spawn".
  //
  // The map is exhaustive over `DISPATCHABLE_TASK_STAGES` (planning, implementing,
  // review — the only three stages the dispatcher ever spawns for):
  //   • planning     → NOTHING. The planner's deliverable travels via the
  //                    ExitPlanMode interception (D48); it has nothing to report,
  //                    and under plan mode an offered tool is a gate (see spawn()).
  //   • implementing → `report_completion` only. It authors; it never reviews.
  //   • review       → `report_review` only. It judges; it never claims authorship.
  //   • anything else (stage absent, or a stage outside the dispatchable three) →
  //     BOTH, the pre-S7·7d exposure. Fail-open-to-guarded, deliberately: an
  //     unrecognized stage is a plumbing bug, and the failure mode we want from a
  //     plumbing bug is "the session can still report and the dispatcher guard
  //     adjudicates it", not "the loop silently loses its only way to finish".
  //     Unreachable from `dispatchTask` today, which always passes its decision's
  //     stage; it exists so that stops being load-bearing.
  private reportToolsOptionFor(
    appSessionId: string,
    stage: TaskStage | undefined,
  ): { reportTools?: SdkReportToolSpec[] } {
    switch (stage) {
      case 'planning':
        return {};
      case 'implementing':
        return { reportTools: [this.buildCompletionSpec(appSessionId)] };
      case 'review':
        return { reportTools: [this.buildReviewSpec(appSessionId)] };
      default:
        return {
          reportTools: [this.buildReviewSpec(appSessionId), this.buildCompletionSpec(appSessionId)],
        };
    }
  }

  // ── S8·6: WHICH tools a STANDING ORCHESTRATOR is offered (D56's author grant) ─
  //
  // The other half of the exposure matrix, and its counterpart above is the
  // reason it is a separate method rather than another case in that switch: the
  // two answer DIFFERENT questions under different doctrines. `reportToolsOptionFor`
  // asks "which stage is this run finishing?"; this one asks "which board verbs
  // has this standing entity been granted?" — and D56's answer is that verbs are
  // grants added ONE AT A TIME, each individually revertible. Today the grant is
  // `create_task` and nothing else.
  //
  // ⚠ **D50'S CLAMP IS NOT WEAKENED HERE, AND THIS IS THE SEAM THE SLICE'S KILL
  // CRITERION NAMES.** An orchestrator spawn sets NO `tools` and NO
  // `disallowedTools` — it is not a dispatched run, so the closed allowlist and
  // the sub-agent denylist that clamp those never come into it, and nothing about
  // this grant edits either list. The grant is the MOUNT (`mcpServers`), which
  // D52's spike proved ORTHOGONAL to the `tools` clamp: an MCP tool needs no
  // allowlist entry and opens no spawn hole. So dispatched runs keep exactly the
  // clamp they had, and one exposure mechanism is not being asked to serve two
  // doctrines — it is being asked to mount two different FAMILIES (D65), which is
  // what a per-family server name is for.
  //
  // Absent projectId (every ordinary session) → `{}`, the absence idiom this file
  // uses everywhere: the `reportTools` key is not set at all. An EMPTY grant is
  // the same absence, so a composition that wired no grant — or deliberately
  // revoked one — produces byte-identical options rather than an empty array.
  private orchestratorToolsOptionFor(
    orchestratorForProjectId: string | undefined,
  ): { reportTools?: SdkReportToolSpec[] } {
    if (orchestratorForProjectId === undefined) {
      return {};
    }
    const grantedTools = this.services.orchestratorReportTools(orchestratorForProjectId);
    return grantedTools.length === 0 ? {} : { reportTools: grantedTools };
  }

  // S7·6b: the SDK-agnostic `report_review` spec for this session. The handler
  // closes over `appSessionId` + `this.services` and forwards the reviewer's
  // reported criteria to the dispatcher via `onReviewReported` (observe + propose
  // only — I10). Returning `{ ok: true }` is wrapped into a success CallToolResult
  // by the factory, which the spike showed stops the session cleanly.
  private buildReviewSpec(appSessionId: string): SdkReportToolSpec {
    return {
      name: 'report_review',
      description: REVIEW_TOOL_DESCRIPTION,
      inputSchema: REVIEW_REPORT_INPUT_SHAPE,
      handler: async (input) => {
        const criteria = (input as { criteria?: ReportReviewPayload['criteria'] }).criteria ?? [];
        this.services.onReviewReported(appSessionId, criteria);
        return { ok: true };
      },
      acknowledgement: {
        // ⚠ PRE-S7·7b STRINGS, VERBATIM. They used to be hard-coded in the factory's
        // wrap; moving them here changed no model-facing byte. Do not reword.
        recorded: 'Review verdict recorded.',
        notRecorded: 'Review verdict not recorded.',
      },
    };
  }

  // S7·7b: the SDK-agnostic `report_completion` spec for this session — the exact
  // mirror of `buildReviewSpec`. The handler closes over `appSessionId` +
  // `this.services` and forwards the author's worklog to the dispatcher via
  // `onCompletionReported` (observe + propose only — I10). The dispatcher, not this
  // handler, decides that the completion means `implementing → review` (D53).
  private buildCompletionSpec(appSessionId: string): SdkReportToolSpec {
    return {
      name: 'report_completion',
      description: COMPLETION_TOOL_DESCRIPTION,
      inputSchema: COMPLETION_REPORT_INPUT_SHAPE,
      handler: async (input) => {
        // TOTAL, like the review handler: a missing/`undefined` worklog degrades to
        // the EMPTY worklog rather than throwing out of an SDK tool call. The empty
        // shape is a real, valid `ReportCompletionPayload['worklog']` — not a
        // sentinel — so nothing downstream has to special-case it.
        const worklog = (input as { worklog?: ReportCompletionPayload['worklog'] }).worklog ?? {
          decisionsMade: [],
          pathsRejected: [],
        };
        this.services.onCompletionReported(appSessionId, worklog);
        return { ok: true };
      },
      acknowledgement: {
        // The briefing tells the implementer that this report IS how it finishes and
        // that VIMES moves the task to review — so the acknowledgement says the same
        // thing back rather than a bare "recorded", closing the loop the words opened.
        recorded: 'Completion recorded. The task has been moved to review.',
        notRecorded: 'Completion not recorded.',
      },
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

  // Clear any unresolved gate promises + plan-capture markers (daemon shutdown).
  reset(): void {
    this.pendingGates.clear();
    this.planCaptureSessions.clear();
    this.dispatchedSessions.clear();
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

    // S8·4a: the SDK stream's OWN compaction-boundary message, alongside
    // `init` above. Verbatim shape observed in SP8·1's
    // scratchpad/sp8-1-evidence/logs/q1b-stream.jsonl line 11 —
    // `type:"system", subtype:"compact_boundary"`, metadata SNAKE_CASE
    // (`compact_metadata`/`pre_tokens`/`post_tokens`/`duration_ms`; CONTRAST
    // mapper.ts's camelCase for the same fact off the transcript).
    //
    // ⚠ NO DOUBLE-INGEST (principle 9, one source of record): this session's
    // transcript jsonl was marked via `markSdkJsonl()` in the `init` branch
    // above, and tailer.ts's `skipPaths` (`onFileEvent`) skips any marked path
    // outright — so mapper.ts's OWN `compact_boundary` recognizer never sees
    // this same boundary for an SDK-spawned session. Exactly one
    // `compaction_observed` per compaction, from whichever path actually reads
    // this session (SDK sessions read HERE; PTY sessions read the transcript).
    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'compact_boundary') {
      const metadata = isRecordLike(sdkMessage.compact_metadata) ? sdkMessage.compact_metadata : {};
      this.services.emit([
        compactionObserved({
          appSessionId,
          // A missing/non-string trigger degrades to '' rather than dropping
          // the event — see mapper.ts's compactionObservedFromRecord for the
          // identical reasoning.
          trigger: typeof metadata.trigger === 'string' ? metadata.trigger : '',
          preTokens: optionalNonnegativeInt(metadata.pre_tokens),
          postTokens: optionalNonnegativeInt(metadata.post_tokens),
          durationMs: optionalNonnegativeInt(metadata.duration_ms),
        }),
      ]);
      return false;
    }

    if (sdkMessage.type === 'assistant' || sdkMessage.type === 'user') {
      const body = sdkMessage.message;
      if (body !== undefined && body !== null) {
        const role = typeof body.role === 'string' ? body.role : sdkMessage.type;
        // ⚠ S8·4a OBSERVED-ABSENCE NOTE: the compaction SUMMARY message DOES
        // arrive here as an ordinary `type:"user"` stream message
        // (q1b-stream.jsonl line 12) — but it carries NO `isCompactSummary`
        // key at all; it carries `isSynthetic:true`/`isReplay:false` instead.
        // Rule 0.7 — never build for an unobserved shape — so this branch is
        // deliberately NOT widened to set `isCompactSummary`. Only the
        // transcript path (mapper.ts, off the real `isCompactSummary:true`
        // key) populates it. See messagePayloadSchema's note in events.ts.
        //
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
    // D48: drop the plan-capture marker as the process exits (the single exit
    // choke point — kill() closes the handle, which ends consumeSdk and lands
    // here via its finally). No-op for a non-plan-capture session.
    this.planCaptureSessions.delete(live.appSessionId);
    // D50: drop the dispatched marker on the same exit choke point. No-op for a
    // non-dispatched session.
    this.dispatchedSessions.delete(live.appSessionId);
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
    // ── FRAGILE-ADAPTER (rule 0.6): native plan capture (D48, S7·5b-ii) ────────
    // A plan-capture session (spawned permissionMode:'plan') that reaches
    // ExitPlanMode has produced its plan. Intercept HERE, before the generic gate:
    // hand the plan text to the dispatcher (observe + propose only — I10; the
    // adapter never touches task state or the artifact store) and DENY, which stops
    // the run cleanly (the S7·0 spike observed deny → result:success, no hang) with
    // NO pending gate registered and NO gate_fired emitted. Every other tool, and
    // every non-plan-capture session, falls through to the gate logic unchanged.
    //
    // The ExitPlanMode input shape is pinned by fixtures/plan-mode/exitplanmode.jsonl;
    // consume `input.plan` ONLY — `planFilePath` is a machine-local path we never
    // read or propagate (R-b).
    if (this.planCaptureSessions.has(appSessionId) && toolName === 'ExitPlanMode') {
      const planText = typeof input.plan === 'string' ? input.plan : '';
      this.services.onPlanCaptured(appSessionId, planText);
      return Promise.resolve({ behavior: 'deny', message: 'VIMES stops at the plan boundary' });
    }
    // D50: a dispatched (unattended) session has no human to answer an
    // AskUserQuestion — plan mode injects it even under the `tools` restriction
    // (spike round 4), and left to the generic gate it would register a pending
    // gate and STALL the headless turn. Auto-deny with proceed-headless guidance,
    // exactly like the ExitPlanMode branch: no gate registered, no gate_fired.
    if (this.dispatchedSessions.has(appSessionId) && toolName === 'AskUserQuestion') {
      return Promise.resolve({
        behavior: 'deny',
        message:
          'No human is available — this is an unattended VIMES task session. Do not ask; ' +
          'proceed using your best judgment and record the question and the assumption you made in your output.',
      });
    }
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
    // D15: the PTY child spawns with a scrubbed env (no CLAUDE* keys), then the
    // hook secret is merged on top — after the scrub, so it survives it.
    const environment = envWithHookSecret(scrubClaudeEnv(process.env), context.hookChannel);
    const args: string[] = [];
    if (context.hookChannel !== undefined) {
      args.push('--settings', context.hookChannel.settingsPath);
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
  private readonly onPlanCaptured: ((appSessionId: string, planText: string) => void) | undefined;
  private readonly onReviewReported:
    | ((appSessionId: string, criteria: ReportReviewPayload['criteria']) => void)
    | undefined;
  private readonly onCompletionReported:
    | ((appSessionId: string, worklog: ReportCompletionPayload['worklog']) => void)
    | undefined;
  private readonly compactionSteward: CompactionStewardSurface | undefined;
  private readonly orchestratorReportTools:
    | ((projectId: string) => SdkReportToolSpec[])
    | undefined;

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
    this.onPlanCaptured = deps.onPlanCaptured;
    this.onReviewReported = deps.onReviewReported;
    this.onCompletionReported = deps.onCompletionReported;
    this.compactionSteward = deps.compactionSteward;
    this.orchestratorReportTools = deps.orchestratorReportTools;

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
      // Injected callback (no-op when unset) — the host owns none of recordPlan's
      // logic; it only forwards the adapter's observation to the dispatcher.
      onPlanCaptured: (appSessionId, planText) => this.onPlanCaptured?.(appSessionId, planText),
      // Injected callback (no-op when unset) — the host forwards the adapter's
      // observation to the dispatcher's recordReview; it owns none of that logic.
      onReviewReported: (appSessionId, criteria) => this.onReviewReported?.(appSessionId, criteria),
      // Same shape again for the completion half (S7·7b) — forwarded to the
      // dispatcher's recordCompletion, no logic owned here.
      onCompletionReported: (appSessionId, worklog) =>
        this.onCompletionReported?.(appSessionId, worklog),
      // S8·6: the author grant, forwarded. Unset → `[]` → no tools are mounted
      // and the orchestrator's options stay byte-identical to a pre-grant spawn
      // (see `orchestratorToolsOptionFor`). Never a throw: an ungranted daemon is
      // a daemon whose orchestrator has no verbs yet, which is a supported state.
      orchestratorReportTools: (projectId) => this.orchestratorReportTools?.(projectId) ?? [],
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
  spawnSession(options: {
    channel: 'sdk' | 'pty';
    cwd: string;
    name?: string;
    // D48: the dispatcher passes 'plan' for the planning stage only; absent
    // everywhere else, which is today's behaviour exactly.
    // 'plan' = plan-capture (D48); 'auto' = dispatched classifier footing (spike
    // 2026-07-26); absent = SDK default, unchanged.
    permissionMode?: 'plan' | 'auto';
    // D50: the dispatcher passes `true` for every dispatched task session; absent
    // for interactive spawns, which is today's behaviour exactly.
    dispatched?: boolean;
    // S7·7d: set by the dispatcher on dispatched spawns; selects which report tools
    // the session is offered. Absent for interactive spawns — today's behaviour
    // exactly (same absence idiom as `permissionMode` and `dispatched`).
    stage?: TaskStage;
    // S8·3 (D56): set ONLY by the orchestrator ensure path, which founds the
    // standing entity for one project. It rides into `session_created` and is
    // never read back by the host — the marking exists so the ENSURE path can
    // find this session again after a restart, and so the record says what this
    // session IS. Absent everywhere else, which is today's behaviour exactly.
    //
    // ⚠ It does NOT imply `dispatched`, a `stage`, or a permission mode: the
    // orchestrator is an INTERACTIVE session (D56 — a conversation partner, not
    // an unattended run), so it takes the SDK default footing like a human's own
    // spawn does.
    orchestratorForProjectId?: string;
  }): SpawnResult {
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
        // S8·3: spread rather than set — an ordinary spawn's birth record is
        // byte-identical to the pre-S8·3 one, and the projection reads ABSENCE to
        // mean "not an orchestrator" (a present-but-undefined key is a different
        // fact from an absent one).
        ...(options.orchestratorForProjectId === undefined
          ? {}
          : { orchestratorForProjectId: options.orchestratorForProjectId }),
      }),
    ]);
    this.onSessionCreated?.(appSessionId);
    // No `resume` key — a fresh spawn has nothing to resume into, and the absence
    // is what makes the liveness cause `spawn`.
    this.startProcess({
      appSessionId,
      channel: options.channel,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      dispatched: options.dispatched,
      stage: options.stage,
    });
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
    // No `permissionMode`, no `dispatched`, no `stage` — the three deliberate
    // absences the parameter comments spell out, now visible as omissions rather
    // than as trailing arguments nobody wrote.
    this.startProcess({
      appSessionId,
      channel: session.channel,
      cwd: session.cwd,
      resume: lastClaudeSessionId,
    });
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

  // ── the S8·4 answer paths (D64) ─────────────────────────────────────────────
  //
  // Pure DELEGATION. The host owns process custody and the hook vocabulary; it
  // owns none of the compaction policy, which needs facts it does not have (the
  // project registry, the standing-notes directory, the nudge ledger). Both
  // methods degrade to "no opinion" when the steward is not wired: the door is
  // open and a compacted session gets today's plain ack, which is exactly the
  // pre-S8·4 behavior. That is what keeps every existing test — and any
  // composition that never wanted a steward — unchanged.
  decideCompactionGateFor(appSessionId: string): CompactionGateDecision {
    return this.compactionSteward?.decideGate(appSessionId) ?? 'allow';
  }

  compactResumeContextFor(appSessionId: string): string | null {
    return this.compactionSteward?.resumeContextForCompactedSession(appSessionId) ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────
  //
  // ⚠ **ONE OPTIONS OBJECT, NOT A POSITIONAL LIST** (the QUEUE'd finding, taken at
  // the top of S8·3 because the spawn path grows again here). This signature had
  // reached SEVEN positional params — three of them optional and adjacent — so a
  // new spawn fact could only be added by appending yet another trailing slot, and
  // every call site had to spell `undefined` for the ones it did not care about
  // (`this.startProcess(id, channel, cwd, undefined, mode, …)`). Named keys make
  // the resume path's deliberate ABSENCES readable at the call site rather than
  // countable, and adding a fact is a key rather than a position.
  //
  // The conversion is BEHAVIOR-NEUTRAL: the same values reach `adapter.spawn` in
  // the same shape, and both call sites below carry the same facts they always did.
  private startProcess(options: {
    appSessionId: string;
    channel: 'sdk' | 'pty';
    cwd: string;
    // Absent = a FRESH spawn; present = the Claude session id to resume into. The
    // `cause` on the liveness event is derived from this and nothing else.
    resume?: string;
    // D48: only the planning-stage spawn passes 'plan'; resume never does (a
    // resumed session keeps its recorded mode, and planning never resumes).
    // 'plan' = plan-capture (D48); 'auto' = dispatched classifier footing (spike
    // 2026-07-26); absent = SDK default, unchanged.
    permissionMode?: 'plan' | 'auto';
    // D50: only a fresh dispatched spawn passes `true`; resume never does (the
    // marker is per-live-process state that a resumed session re-establishes only
    // if the dispatcher re-dispatches — resume today never sets it).
    dispatched?: boolean;
    // S7·7d: only a fresh dispatched spawn passes a stage; resume never does, for
    // the same reason `dispatched` does not — a resumed session re-establishes its
    // dispatch context only through a re-dispatch.
    stage?: TaskStage;
  }): void {
    const { appSessionId, channel, cwd, resume, permissionMode, dispatched, stage } = options;
    const adapter: SessionAdapter = channel === 'sdk' ? this.sdkAdapter : this.ptyAdapter;
    const hookChannel = this.prepareHookChannel(appSessionId);
    const cause = resume === undefined ? 'spawn' : 'resume';

    // ── S8·6 (D56/D58/D65): the STANDING ORCHESTRATOR's footing ────────────────
    //
    // ⚠ **READ OFF THE SESSION RECORD, NOT OFF THE CALL, AND THAT IS THE WHOLE
    // MECHANISM.** D56 says the verbs are grants on the standing ENTITY, and the
    // entity is the record (`orchestratorForProjectId`, S8·3's marking — presence
    // IS the kind). So the grant is re-derived at every process start, from the
    // only fact that outlives a process.
    //
    // The alternative — options threaded from the ensure endpoint's spawn and
    // resume calls — was the work-order's sketch and it LEAKS, because
    // `startProcess` has a third caller nobody passes options through:
    // `sendMessage` auto-resumes a dormant/interrupted session in-process (see it
    // call `resumeSession` below), and EVERY SDK turn ends dormant
    // (`driveToDormant('run-complete')`). So the first turn typed at an
    // orchestrator whose query has ended would re-found it WITHOUT its tools and
    // WITHOUT 'auto' — a silent capability loss, in the one place a model is most
    // likely to then confabulate. Deriving here covers spawn, explicit resume and
    // auto-resume with one rule.
    //
    // Safe at spawn time: `spawnSession` emits `session_created` — carrying the
    // marking — BEFORE it calls this, so the record is already there to read.
    const orchestratorForProjectId = this.currentSessions()[appSessionId]?.orchestratorForProjectId;

    const live = adapter.spawn({
      appSessionId,
      cwd,
      resume,
      hookChannel,
      // D58 (DECIDED 2026-08-04): an orchestrator runs `'auto'`. Its proposals flow
      // gate-free because the board PROMOTION is already the human approval —
      // gating the proposal too is approving twice — and because D55's observed
      // evidence says MCP tools bypass `canUseTool` regardless, so an interactive
      // mode would gate the built-in tools while the VIMES verbs flowed free.
      // Nothing runs until Wes promotes. `??` and not an override: no caller ever
      // passes a mode for an orchestrator, and if one ever did, the explicit
      // request wins over the derived default.
      permissionMode: permissionMode ?? (orchestratorForProjectId === undefined ? undefined : 'auto'),
      dispatched,
      stage,
      orchestratorForProjectId,
    });
    live.settingsPath = hookChannel?.settingsPath;
    this.liveProcesses.set(appSessionId, live);
    this.emitGuardedLiveness(appSessionId, 'running', cause);
    adapter.activate(live);
  }

  // Mint the whole hook channel for this spawn — secret, settings file
  // registering the relays (C), and the env fragment carrying the secret —
  // then register the digest for the ingress. Returning the channel whole is
  // what keeps the settings file and the secret env inseparable at the call
  // site. Best effort: an fs failure degrades to NO channel (no settings file,
  // so no relays are registered at all — SDK-init correlation still works)
  // rather than failing the spawn or, worse, registering relays with nothing to
  // authenticate with.
  private prepareHookChannel(appSessionId: string): HookChannel | undefined {
    try {
      const hookChannel = mintHookChannel({
        dataDir: this.config.dataDir,
        appSessionId,
        hookPort: this.config.hookPort,
      });
      this.spawnSecrets.set(appSessionId, hookChannel.digest);
      return hookChannel;
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

// A success `CallToolResult` (sdk.d.ts:3880 → @modelcontextprotocol/sdk/types.js:4).
// The single-text-content success shape the spike observed stopping a session
// cleanly. Kept SDK-import-free (a structural type) so this stays in the testable
// core; the real SDK's `CallToolResult` is structurally compatible with it.
interface CallToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
}

// The minimal SDK surface the factory needs to mount report tools — `tool()`
// (sdk.d.ts:6745) and `createSdkMcpServer()` (:467). Injectable so a test can drive
// `buildReportMcpServers` with a fake and CI never loads the real SDK (rule 0.3).
interface SdkReportToolSurface {
  tool: (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (args: unknown, extra: unknown) => Promise<CallToolResultLike>,
  ) => unknown;
  createSdkMcpServer: (options: {
    name: string;
    version?: string;
    tools: unknown[];
    alwaysLoad?: boolean;
  }) => unknown;
}

// The server a spec mounts under when it names none — see `SdkReportToolSpec.server`.
// Named here rather than spelled twice, because "absent means vimes_report" is the
// byte-identity promise the two report tools rely on (D65).
const DEFAULT_TOOL_SERVER = 'vimes_report';

// S7·6b: map the SDK-agnostic report-tool specs onto the SDK's `mcpServers` value —
// or `undefined` when there are none, so the query options stay byte-identical for a
// non-dispatched spawn (the spread idiom at the call site drops an undefined key).
// This is the ONLY place the SDK's `tool`/`createSdkMcpServer` are touched
// (sdk.d.ts:467/:6745), keeping them out of the testable adapter (D18 / the
// SDK-boundary rule). Exported for the unit test, which injects a fake surface.
//
// ⚠ S8·6 (D65) MADE THIS GROUP BY SERVER, and the shape of the change is what
// keeps it safe: specs are bucketed by `spec.server ?? 'vimes_report'` IN ORDER,
// and a call whose specs all leave `server` absent produces exactly one
// `vimes_report` entry holding exactly the same tools in exactly the same order as
// before — the pre-S8·6 return value, to the byte. Only a spec that NAMES another
// family (today: `create_task` → `vimes_board`) adds a second entry.
export function buildReportMcpServers(
  reportTools: SdkReportToolSpec[] | undefined,
  sdk: SdkReportToolSurface,
): Record<string, unknown> | undefined {
  if (reportTools === undefined || reportTools.length === 0) {
    return undefined;
  }
  // Insertion-ordered: a Map preserves first-seen server order, so the resulting
  // object's key order follows the specs rather than an alphabetical accident.
  const specsByServer = new Map<string, SdkReportToolSpec[]>();
  for (const spec of reportTools) {
    const serverName = spec.server ?? DEFAULT_TOOL_SERVER;
    const bucket = specsByServer.get(serverName);
    if (bucket === undefined) {
      specsByServer.set(serverName, [spec]);
    } else {
      bucket.push(spec);
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [serverName, specs] of specsByServer) {
    mcpServers[serverName] = sdk.createSdkMcpServer({
      name: serverName,
      version: '0.0.1',
      // alwaysLoad: the tools ride in the prompt and are never deferred behind tool
      // search (sdk.d.ts:480-487) — the spike relied on this to keep report_review
      // reachable under the D50 clamp.
      alwaysLoad: true,
      // ⚠ ONE SERVER, N TOOLS — S7·7b is the first caller to pass more than one
      // (`report_review` + `report_completion`), and this `.map` already handled it:
      // `createSdkMcpServer`'s `tools` is an ARRAY (sdk.d.ts:467), so the two tools
      // mount side by side under the single `vimes_report` name and the model sees
      // `mcp__vimes_report__report_review` and `mcp__vimes_report__report_completion`.
      // Nothing here is per-tool except the spec's own fields.
      tools: specs.map((spec) =>
        sdk.tool(spec.name, spec.description, spec.inputSchema, async (args) => {
          // Wrap the SDK-agnostic `{ ok }` return into a success CallToolResult. The
          // observation (onReviewReported / onCompletionReported) already happened
          // inside spec.handler, BEFORE this wrap-up result is returned to the model.
          //
          // ⚠ The acknowledgement text comes FROM THE SPEC as of S7·7b. It used to be
          // the hard-coded "Review verdict recorded." here, which was true while
          // review was the only tool and became a lie the moment a second one shared
          // this wrapper. This function is now tool-agnostic, which is what lets a
          // third report tool land without touching it.
          //
          // ⚠ S8·6: a HANDLER-SUPPLIED acknowledgement wins over the spec's static
          // pair. `??` and not a truthiness check, deliberately — a handler that
          // deliberately answers with the empty string is answering, and coercing
          // that back to the static text would be this wrapper overruling it.
          const result = await spec.handler(args);
          return {
            content: [
              {
                type: 'text',
                text:
                  result.acknowledgement ??
                  (result.ok ? spec.acknowledgement.recorded : spec.acknowledgement.notRecorded),
              },
            ],
          };
        }),
      ),
    });
  }
  return mcpServers;
}

const defaultSdkQueryFactory: SdkQueryFactory = ({ prompt, options }) => {
  let activeQuery: { close?: () => void } | undefined;
  async function* run(): AsyncGenerator<SdkStreamMessage> {
    // determinism-exempt: real Agent SDK.
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => AsyncIterable<SdkStreamMessage> & { close?: () => void };
    } & SdkReportToolSurface;
    // S7·6b: build the in-process MCP server(s) from the SDK-agnostic specs. Absent
    // → undefined → the mcpServers key is not set (byte-identical non-dispatched).
    const mcpServers = buildReportMcpServers(options.reportTools, sdk);
    const query = sdk.query({
      prompt,
      options: {
        cwd: options.cwd,
        resume: options.resume,
        settings: options.settings,
        // Carries VIMES_HOOK_SECRET to the Claude child (and from there to its
        // hook subprocesses). Undefined → the SDK leaves the child inheriting
        // process.env, which is the pre-hook-channel behavior.
        env: options.env,
        settingSources: options.settingSources,
        canUseTool: options.canUseTool,
        // Observed truth (rule 0.7, D48 / the S7·0 spike): canUseTool DOES fire for
        // ExitPlanMode under permissionMode 'plan' — that is the whole native plan
        // capture mechanism. Default remains 'default'; a plan-capture spawn threads
        // 'plan' through SdkQueryOptions.permissionMode.
        permissionMode: options.permissionMode ?? 'default',
        // D50: pass the closed allowlist + spawn-family denylist through to the SDK
        // ONLY when set (a dispatched spawn). Absent → the SDK's default tool set,
        // keeping a non-dispatched query byte-identical to before this unit.
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
        // S7·6b: mount the report tool(s) ONLY when present. Absent → the key is not
        // set, keeping a non-dispatched query byte-identical to before this unit.
        ...(mcpServers === undefined ? {} : { mcpServers }),
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
