import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CountingIdSource,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  gateFired,
  gateFiredPayloadSchema,
  livenessChanged,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionCreated,
  sessionsProjection,
  withNotificationTrigger,
  type EventRecord,
  type SessionRecord,
} from '@vimes/core';
import { readFileSync } from 'node:fs';
import type { DaemonConfig } from './config.js';
import {
  CLAUDE_PTY_CAPABILITIES,
  CLAUDE_SDK_CAPABILITIES,
  SessionHost,
  scrubClaudeEnv,
  truncateGatePrompt,
  type PtyLike,
  type PtySpawnFactory,
  type SdkQueryFactory,
  type SdkQueryOptions,
  type SdkStreamMessage,
  type SdkUserMessage,
} from './sessionHost.js';
import { sessionSettingsPath } from './sessionSettings.js';
import type { PreflightProbe } from './runtimeChecks.js';

// ── harness helpers ──────────────────────────────────────────────────────────

// Per-session settings files land here (config.dataDir). Written on spawn,
// removed on stop — a real writable dir keeps the mechanical side effect off cwd.
const settingsTempDir = mkdtempSync(join(tmpdir(), 'vimes-sessionhost-'));
afterAll(() => rmSync(settingsTempDir, { recursive: true, force: true }));

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: ':memory:',
    dataDir: settingsTempDir,
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    ...overrides,
  };
}

interface Harness {
  host: SessionHost;
  store: MemoryEventStore;
  router: EventRouter;
}

function makeHarness(deps: {
  sdkQueryFactory?: SdkQueryFactory;
  ptySpawnFactory?: PtySpawnFactory;
}): Harness {
  const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
  const ids = new CountingIdSource();
  const store = new MemoryEventStore({ clock, ids });
  const router = new EventRouter(store);
  const host = new SessionHost({
    store,
    router,
    clock,
    ids,
    config: buildConfig(),
    sdkQueryFactory: deps.sdkQueryFactory,
    ptySpawnFactory: deps.ptySpawnFactory,
    projectsRoot: '/fake-projects',
  });
  return { host, store, router };
}

function records(store: MemoryEventStore, stream: string): EventRecord[] {
  return store.read(stream, 1);
}

function types(store: MemoryEventStore, stream: string): string[] {
  return records(store, stream).map((record) => record.type);
}

function sessionOf(store: MemoryEventStore, appSessionId: string): SessionRecord | undefined {
  return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store)).sessions[appSessionId];
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeBarrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// A scripted SDK query factory. The script drives the fake stream and may call
// options.canUseTool. Records the options of every call (spy for I3/I11).
type SdkScript = (context: {
  prompt: AsyncIterable<SdkUserMessage>;
  options: SdkQueryOptions;
}) => AsyncGenerator<SdkStreamMessage>;

function makeSdkFactory(script: SdkScript): { factory: SdkQueryFactory; calls: SdkQueryOptions[] } {
  const calls: SdkQueryOptions[] = [];
  const factory: SdkQueryFactory = ({ prompt, options }) => {
    calls.push(options);
    const generator = script({ prompt, options });
    return Object.assign(generator, {
      close(): void {
        void generator.return(undefined);
      },
    });
  };
  return { factory, calls };
}

// A fake pty with data/exit hooks and captured writes.
function makeFakePty(): {
  factory: PtySpawnFactory;
  writes: string[];
  capturedEnv: () => Record<string, string> | undefined;
  fireData: (data: string) => void;
  fireExit: (exitCode?: number) => void;
  killed: () => boolean;
} {
  const writes: string[] = [];
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((event: { exitCode: number }) => void) | undefined;
  let seenEnv: Record<string, string> | undefined;
  let wasKilled = false;
  const pty: PtyLike = {
    write: (data) => writes.push(data),
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
    factory: (_file, _args, options) => {
      seenEnv = options.env;
      return pty;
    },
    writes,
    capturedEnv: () => seenEnv,
    fireData: (data) => dataCallback?.(data),
    fireExit: (exitCode = 0) => exitCallback?.({ exitCode }),
    killed: () => wasKilled,
  };
}

// ── SDK channel ──────────────────────────────────────────────────────────────

describe('SessionHost — SDK channel', () => {
  it('spawn: session_created (spawning) → running → claude_session_mapped, exact', async () => {
    const barrier = makeBarrier();
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-abc' };
      await barrier.promise;
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/home/wes/dongfu' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';

      await waitFor(() => store.head(appSessionId) >= 3);
      expect(types(store, appSessionId)).toEqual([
        'session_created',
        'liveness_changed',
        'claude_session_mapped',
      ]);

      const created = records(store, appSessionId)[0]!;
      expect((created.payload as { channel: string }).channel).toBe('sdk');
      const runningEvent = records(store, appSessionId)[1]!;
      expect((runningEvent.payload as { to: string }).to).toBe('running');
      const mapping = records(store, appSessionId)[2]!;
      expect(mapping.payload).toEqual({
        appSessionId,
        claudeSessionId: 'claude-abc',
        jsonlPath: '/fake-projects/-home-wes-dongfu/claude-abc.jsonl',
      });
    } finally {
      barrier.release();
      host.stop();
    }
  });

  it('message round trip: a sent turn surfaces as a message (+ usage_block) event', async () => {
    const { factory } = makeSdkFactory(async function* ({ prompt }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      for await (const userMessage of prompt) {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `echo: ${userMessage.message.content}` }],
            usage: { output_tokens: 7 },
          },
        };
      }
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => store.head(appSessionId) >= 3); // created, running, mapped

      host.sendMessage(appSessionId, 'hello');
      await waitFor(() => types(store, appSessionId).includes('usage_block'));

      // The user turn is echoed first (Change 1), then the assistant reply.
      const messageRecords = records(store, appSessionId).filter((record) => record.type === 'message');
      expect((messageRecords[0]!.payload as { role: string; content: unknown }).role).toBe('user');
      expect((messageRecords[0]!.payload as { content: unknown }).content).toBe('hello');
      const messageRecord = messageRecords.find(
        (record) => (record.payload as { role: string }).role === 'assistant',
      )!;
      expect((messageRecord.payload as { content: unknown }).content).toEqual([
        { type: 'text', text: 'echo: hello' },
      ]);
      const usageRecord = records(store, appSessionId).find((record) => record.type === 'usage_block')!;
      expect((usageRecord.payload as { usage: unknown }).usage).toEqual({ output_tokens: 7 });
    } finally {
      host.stop();
    }
  });

  it('gate ALLOW: gate_fired+trigger adjacent, answerGate resolves canUseTool with allow, then attention_cleared', async () => {
    const permissionResults: unknown[] = [];
    const { factory } = makeSdkFactory(async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      const result = await options.canUseTool(
        'Bash',
        { command: 'ls' },
        { requestId: 'req-42', title: 'Claude wants to run ls' },
      );
      permissionResults.push(result);
      yield { type: 'result', subtype: 'success' };
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => types(store, appSessionId).includes('gate_fired'));

      const streamRecords = records(store, appSessionId);
      const gateIndex = streamRecords.findIndex((record) => record.type === 'gate_fired');
      expect(streamRecords[gateIndex + 1]!.type).toBe('notification_trigger');
      expect(streamRecords[gateIndex + 1]!.seq).toBe(streamRecords[gateIndex]!.seq + 1);
      expect(streamRecords[gateIndex]!.payload).toEqual({
        appSessionId,
        prompt: 'Claude wants to run ls',
        requestId: 'req-42',
      });
      // rule 0.7: the widened core schema (packages/core/src/events.ts) must
      // accept the daemon's real wire payload, requestId included.
      const gateSchemaResult = gateFiredPayloadSchema.safeParse(streamRecords[gateIndex]!.payload);
      expect(gateSchemaResult.success).toBe(true);
      expect(gateSchemaResult.success && gateSchemaResult.data.requestId).toBe('req-42');

      const answer = host.answerGate(appSessionId, 'req-42', 'allow');
      expect(answer).toEqual({ ok: true });
      await waitFor(() => permissionResults.length === 1);
      expect(permissionResults[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
      await waitFor(() => types(store, appSessionId).includes('attention_cleared'));
      const cleared = records(store, appSessionId).find((record) => record.type === 'attention_cleared')!;
      expect((cleared.payload as { cause: string }).cause).toBe('gate_answered');
    } finally {
      host.stop();
    }
  });

  it('gate DENY: answerGate deny resolves canUseTool with the deny result', async () => {
    const permissionResults: unknown[] = [];
    const { factory } = makeSdkFactory(async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      const result = await options.canUseTool('Bash', { command: 'rm -rf /' }, { requestId: 'req-9', title: 'danger' });
      permissionResults.push(result);
      yield { type: 'result', subtype: 'success' };
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => types(store, appSessionId).includes('gate_fired'));

      host.answerGate(appSessionId, 'req-9', 'deny');
      await waitFor(() => permissionResults.length === 1);
      expect(permissionResults[0]).toEqual({ behavior: 'deny', message: 'denied from VIMES' });
    } finally {
      host.stop();
    }
  });

  it('completion: result → run_completed+trigger, liveness dormant, no longer live', async () => {
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      yield { type: 'result', subtype: 'success' };
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
    const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
    await waitFor(() => sessionOf(store, appSessionId)?.liveness === 'dormant');

    const streamRecords = records(store, appSessionId);
    const completedIndex = streamRecords.findIndex((record) => record.type === 'run_completed');
    expect(streamRecords[completedIndex + 1]!.type).toBe('notification_trigger');
    expect(host.isLive(appSessionId)).toBe(false);
    expect(sessionOf(store, appSessionId)?.needsAttention?.reason).toBe('completed');
  });

  it('resume dormant (I3): resume carries the last claudeSessionId, same appSessionId, new mapping appended (I1)', async () => {
    const barrier = makeBarrier();
    const { factory, calls } = makeSdkFactory(async function* ({ options }) {
      if (options.resume === undefined) {
        yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
        yield { type: 'result', subtype: 'success' };
      } else {
        // Resume observes a DIFFERENT id → exercises the I1 append path.
        yield { type: 'system', subtype: 'init', session_id: 'claude-2' };
        await barrier.promise;
      }
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/home/wes/dongfu' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => sessionOf(store, appSessionId)?.liveness === 'dormant');

      const resume = host.resumeSession(appSessionId);
      expect(resume).toEqual({ appSessionId });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.resume).toBe('claude-1'); // last mapped id, from recorded cwd
      expect(calls[1]!.cwd).toBe('/home/wes/dongfu');

      await waitFor(() => (sessionOf(store, appSessionId)?.claudeSessionIds.length ?? 0) === 2);
      const session = sessionOf(store, appSessionId)!;
      expect(session.claudeSessionIds.map((entry) => entry.id)).toEqual(['claude-1', 'claude-2']);
      expect(session.liveness).toBe('running');
      // resume path: spawning then running.
      const livenessTos = records(store, appSessionId)
        .filter((record) => record.type === 'liveness_changed')
        .map((record) => (record.payload as { to: string }).to);
      expect(livenessTos).toEqual(['running', 'dormant', 'spawning', 'running']);
    } finally {
      barrier.release();
      host.stop();
    }
  });

  it('concurrent resume refused (I11): transition_rejected, factory not called a second time', async () => {
    const barrier = makeBarrier();
    const { factory, calls } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      await barrier.promise;
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => host.isLive(appSessionId));

      const resume = host.resumeSession(appSessionId);
      expect('refused' in resume && resume.refused).toBe(true);
      expect(calls).toHaveLength(1); // NO second spawn
      const rejected = records(store, appSessionId).find((record) => record.type === 'transition_rejected')!;
      expect(rejected.payload).toEqual({
        appSessionId,
        from: 'running',
        to: 'spawning',
        cause: 'concurrent-resume-refused',
      });
    } finally {
      barrier.release();
      host.stop();
    }
  });
});

// ── send: echo, auto-resume, refusals ────────────────────────────────────────

describe('SessionHost — send: user echo + auto-resume', () => {
  it('echoes the user message into the log BEFORE the SDK stream receives it (Change 1)', async () => {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);

    let appSessionId = '';
    // At the moment the SDK stream pulls the user turn, snapshot the message-event
    // roles already in the log — the echo must be there first.
    const messageRolesAtReceipt: string[][] = [];
    const factory: SdkQueryFactory = ({ prompt }) => {
      const generator = (async function* (): AsyncGenerator<SdkStreamMessage> {
        yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
        for await (const _userMessage of prompt) {
          void _userMessage;
          messageRolesAtReceipt.push(
            store
              .read(appSessionId, 1)
              .filter((record) => record.type === 'message')
              .map((record) => (record.payload as { role: string }).role),
          );
        }
      })();
      return Object.assign(generator, {
        close(): void {
          void generator.return(undefined);
        },
      });
    };
    const host = new SessionHost({ store, router, clock, ids, config: buildConfig(), sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => store.head(appSessionId) >= 2); // created, running

      host.sendMessage(appSessionId, 'hello');
      await waitFor(() => messageRolesAtReceipt.length === 1);
      expect(messageRolesAtReceipt[0]).toEqual(['user']);

      const echo = records(store, appSessionId).find((record) => record.type === 'message')!;
      expect(echo.payload).toEqual({ appSessionId, role: 'user', content: 'hello' });
    } finally {
      host.stop();
    }
  });

  it('send to a dormant session auto-resumes (I3), then resume→running→user-echo→delivery (Change 2)', async () => {
    const barrier = makeBarrier();
    const { factory, calls } = makeSdkFactory(async function* ({ prompt, options }) {
      if (options.resume === undefined) {
        yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
        yield { type: 'result', subtype: 'success' };
      } else {
        yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
        for await (const userMessage of prompt) {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${userMessage.message.content}` }] },
          };
        }
        await barrier.promise;
      }
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/home/wes/dongfu' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => sessionOf(store, appSessionId)?.liveness === 'dormant');

      const result = host.sendMessage(appSessionId, 'next turn');
      expect(result).toEqual({ ok: true });

      // Resumed with the last mapped claudeSessionId from the recorded cwd (I3).
      await waitFor(() => calls.length === 2);
      expect(calls[1]!.resume).toBe('claude-1');
      expect(calls[1]!.cwd).toBe('/home/wes/dongfu');

      await waitFor(() =>
        records(store, appSessionId).some(
          (record) => record.type === 'message' && (record.payload as { role: string }).role === 'assistant',
        ),
      );
      // Full liveness path: initial run→dormant, then resume spawning→running.
      const livenessTos = records(store, appSessionId)
        .filter((record) => record.type === 'liveness_changed')
        .map((record) => (record.payload as { to: string }).to);
      expect(livenessTos).toEqual(['running', 'dormant', 'spawning', 'running']);

      // Echo lands before the assistant reply, and after the resume's running.
      const messageRecords = records(store, appSessionId).filter((record) => record.type === 'message');
      expect((messageRecords[0]!.payload as { role: string; content: unknown })).toMatchObject({
        role: 'user',
        content: 'next turn',
      });
      expect((messageRecords[1]!.payload as { role: string }).role).toBe('assistant');
      const secondRunning = records(store, appSessionId)
        .filter((record) => record.type === 'liveness_changed' && (record.payload as { to: string }).to === 'running')
        .at(-1)!;
      expect(messageRecords[0]!.seq).toBeGreaterThan(secondRunning.seq);
    } finally {
      barrier.release();
      host.stop();
    }
  });

  it('send to a dead session is refused (session-dead); unknown session refused (Change 2)', () => {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);
    router.emit([
      sessionCreated({ appSessionId: 'app-dead', channel: 'sdk', cwd: '/p', name: null, forkedFrom: null, taskRef: null }),
    ]);
    router.emit([livenessChanged({ appSessionId: 'app-dead', to: 'running', cause: 'spawned' })]);
    router.emit([livenessChanged({ appSessionId: 'app-dead', to: 'dead', cause: 'killed' })]);

    const host = new SessionHost({ store, router, clock, ids, config: buildConfig() });
    expect(host.sendMessage('app-dead', 'hi')).toEqual({ refused: true, reason: 'session-dead' });
    expect(host.sendMessage('no-such-session', 'hi')).toEqual({ refused: true, reason: 'unknown-session' });
    // No resume attempted for a dead session: it stays dead.
    expect(sessionOf(store, 'app-dead')?.liveness).toBe('dead');
  });
});

// ── gate prompt (Change 3) ────────────────────────────────────────────────────

describe('SessionHost — gate prompt', () => {
  it('truncateGatePrompt: keeps ≤160 verbatim, truncates longer to 160 with an ellipsis', () => {
    const short = 'Bash: {"command":"ls"}';
    expect(truncateGatePrompt(short)).toBe(short);
    const exactly160 = 'a'.repeat(160);
    expect(truncateGatePrompt(exactly160)).toBe(exactly160);
    const long = 'a'.repeat(500);
    const truncated = truncateGatePrompt(long);
    expect(truncated.length).toBe(160);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.slice(0, 159)).toBe('a'.repeat(159));
  });

  it('gate prompt: short toolName + input JSON is kept verbatim when title absent', async () => {
    const { factory } = makeSdkFactory(async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      void options.canUseTool('Bash', { command: 'ls' }, { requestId: 'req-1' });
      yield { type: 'result', subtype: 'success' };
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => types(store, appSessionId).includes('gate_fired'));
      const gate = records(store, appSessionId).find((record) => record.type === 'gate_fired')!;
      expect((gate.payload as { prompt: string }).prompt).toBe('Bash: {"command":"ls"}');
    } finally {
      host.stop();
    }
  });

  it('gate prompt: long toolName + input JSON is truncated to 160 chars when title absent', async () => {
    const bigContent = 'x'.repeat(500);
    const { factory } = makeSdkFactory(async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      void options.canUseTool('Write', { file_path: '/a.txt', content: bigContent }, { requestId: 'req-1' });
      yield { type: 'result', subtype: 'success' };
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => types(store, appSessionId).includes('gate_fired'));
      const gate = records(store, appSessionId).find((record) => record.type === 'gate_fired')!;
      const prompt = (gate.payload as { prompt: string }).prompt;
      expect(prompt.startsWith('Write: ')).toBe(true);
      expect(prompt.length).toBe(160);
      expect(prompt.endsWith('…')).toBe(true);
    } finally {
      host.stop();
    }
  });
});

// ── PTY channel ──────────────────────────────────────────────────────────────

describe('SessionHost — PTY channel', () => {
  it('env scrub: no CLAUDE* key reaches the pty factory; others survive', () => {
    process.env.CLAUDE_TEST_TOKEN = 'secret';
    process.env.CLAUDECODE = '1';
    process.env.VIMES_KEEP_ME = 'yes';
    const fakePty = makeFakePty();
    const { host } = makeHarness({ ptySpawnFactory: fakePty.factory });
    try {
      host.spawnSession({ channel: 'pty', cwd: '/p' });
      const environment = fakePty.capturedEnv()!;
      expect(Object.keys(environment).some((key) => /^CLAUDE/.test(key))).toBe(false);
      expect(environment.VIMES_KEEP_ME).toBe('yes');
    } finally {
      host.stop();
      delete process.env.CLAUDE_TEST_TOKEN;
      delete process.env.CLAUDECODE;
      delete process.env.VIMES_KEEP_ME;
    }
  });

  it('scrubClaudeEnv is a pure filter over its input', () => {
    const scrubbed = scrubClaudeEnv({ CLAUDE_X: 'a', CLAUDECODE: 'b', PATH: '/usr/bin', EMPTY: undefined });
    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });

  it('keystrokes: sendMessage echoes the user message BEFORE writing text + carriage return', () => {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);

    let appSessionId = '';
    // The pty write records the log's message events AT WRITE TIME — proving the
    // echo landed before the keystrokes.
    const messageRolesAtWriteTime: string[][] = [];
    const writes: string[] = [];
    const factory: PtySpawnFactory = () => ({
      write: (data) => {
        writes.push(data);
        messageRolesAtWriteTime.push(
          store
            .read(appSessionId, 1)
            .filter((record) => record.type === 'message')
            .map((record) => (record.payload as { role: string }).role),
        );
      },
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    });
    const host = new SessionHost({ store, router, clock, ids, config: buildConfig(), ptySpawnFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'pty', cwd: '/p' });
      appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      host.sendMessage(appSessionId, 'ls -la');

      expect(writes).toEqual(['ls -la\r']);
      // At the moment the keystrokes were written, the user echo already existed.
      expect(messageRolesAtWriteTime).toEqual([['user']]);
      const echo = store
        .read(appSessionId, 1)
        .find((record) => record.type === 'message')!;
      expect(echo.payload).toEqual({ appSessionId, role: 'user', content: 'ls -la' });
    } finally {
      host.stop();
    }
  });

  it('raw bytes are counted (rule 0.8 — never parsed) and onExit drives dormant', async () => {
    const fakePty = makeFakePty();
    const { host, store } = makeHarness({ ptySpawnFactory: fakePty.factory });
    const spawn = host.spawnSession({ channel: 'pty', cwd: '/p' });
    const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';

    fakePty.fireData('hello');
    fakePty.fireData('!!'); // 5 + 2 bytes
    expect(host.rawBytesReceived(appSessionId)).toBe(7);

    fakePty.fireExit(0);
    await waitFor(() => sessionOf(store, appSessionId)?.liveness === 'dormant');
    expect(host.isLive(appSessionId)).toBe(false);
  });
});

// ── boot recovery ────────────────────────────────────────────────────────────

describe('SessionHost — boot recovery (§3.10 / D13)', () => {
  it('a session the log left running with no live process becomes interrupted; attention intact', () => {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);

    // Pre-seed: a session left running, with a gate still needing attention.
    router.emit([
      sessionCreated({ appSessionId: 'app-live', channel: 'pty', cwd: '/p', name: null, forkedFrom: null, taskRef: null }),
    ]);
    router.emit([livenessChanged({ appSessionId: 'app-live', to: 'running', cause: 'spawned' })]);
    router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-live', prompt: 'approve?' })));

    const host = new SessionHost({ store, router, clock, ids, config: buildConfig() });
    host.start();

    const session = sessionOf(store, 'app-live')!;
    expect(session.liveness).toBe('interrupted');
    expect(session.needsAttention?.reason).toBe('gate'); // untouched by recovery
    expect(types(store, 'system')).toEqual(['host_started']);
  });

  it('a dormant session is left alone by recovery', () => {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);
    router.emit([
      sessionCreated({ appSessionId: 'app-dormant', channel: 'sdk', cwd: '/p', name: null, forkedFrom: null, taskRef: null }),
    ]);
    router.emit([livenessChanged({ appSessionId: 'app-dormant', to: 'running', cause: 'spawned' })]);
    router.emit([livenessChanged({ appSessionId: 'app-dormant', to: 'dormant', cause: 'done' })]);

    const host = new SessionHost({ store, router, clock, ids, config: buildConfig() });
    host.start();

    expect(sessionOf(store, 'app-dormant')?.liveness).toBe('dormant');
  });
});

// ── D18 adapter capabilities ─────────────────────────────────────────────────

describe('SessionHost — adapter capabilities (D18)', () => {
  it('surfaces the declared capabilities per channel', () => {
    const { host } = makeHarness({});
    try {
      expect(host.capabilitiesFor('sdk')).toEqual({
        resume: true,
        gates: 'runtime',
        settingsIsolation: true,
        structuredStream: true,
      });
      expect(host.capabilitiesFor('pty')).toEqual({
        resume: true,
        gates: 'none',
        settingsIsolation: false,
        structuredStream: false,
      });
      expect(host.capabilitiesFor('sdk')).toEqual(CLAUDE_SDK_CAPABILITIES);
      expect(host.capabilitiesFor('pty')).toEqual(CLAUDE_PTY_CAPABILITIES);
    } finally {
      host.stop();
    }
  });
});

// ── E1 provider + E2 messageId ───────────────────────────────────────────────

describe('SessionHost — provider + messageId riders', () => {
  it('spawn stamps provider claude-code (session_created payload + projected record)', async () => {
    const barrier = makeBarrier();
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      await barrier.promise;
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => sessionOf(store, appSessionId) !== undefined);
      expect(sessionOf(store, appSessionId)!.provider).toBe('claude-code');
      const created = records(store, appSessionId).find((record) => record.type === 'session_created')!;
      expect((created.payload as { provider: string }).provider).toBe('claude-code');
    } finally {
      barrier.release();
      host.stop();
    }
  });

  it('usage_block threads the SDK assistant message.id as messageId (D17)', async () => {
    const { factory } = makeSdkFactory(async function* ({ prompt }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      for await (const _userMessage of prompt) {
        void _userMessage;
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg_0abc',
            content: [{ type: 'text', text: 'hi' }],
            usage: { output_tokens: 3 },
          },
        };
      }
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => store.head(appSessionId) >= 2);
      host.sendMessage(appSessionId, 'hello');
      await waitFor(() => types(store, appSessionId).includes('usage_block'));
      const usage = records(store, appSessionId).find((record) => record.type === 'usage_block')!;
      expect((usage.payload as { messageId?: string }).messageId).toBe('msg_0abc');
    } finally {
      host.stop();
    }
  });

  it('usage_block omits messageId when the SDK message carries no id', async () => {
    const { factory } = makeSdkFactory(async function* ({ prompt }) {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      for await (const _userMessage of prompt) {
        void _userMessage;
        yield { type: 'assistant', message: { role: 'assistant', content: 'hi', usage: { output_tokens: 3 } } };
      }
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => store.head(appSessionId) >= 2);
      host.sendMessage(appSessionId, 'hello');
      await waitFor(() => types(store, appSessionId).includes('usage_block'));
      const usage = records(store, appSessionId).find((record) => record.type === 'usage_block')!;
      expect('messageId' in (usage.payload as Record<string, unknown>)).toBe(false);
    } finally {
      host.stop();
    }
  });
});

// ── E3 preflight ─────────────────────────────────────────────────────────────

describe('SessionHost — spawn preflight (E3)', () => {
  function makeHostWithPreflight(preflightProbe: PreflightProbe): { host: SessionHost; store: MemoryEventStore } {
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);
    const host = new SessionHost({ store, router, clock, ids, config: buildConfig(), preflightProbe });
    return { host, store };
  }

  it('a failing preflight refuses the spawn, creates NO session, and emits a rejection record', () => {
    const { host, store } = makeHostWithPreflight(() => ({ ok: false, reason: 'no-credentials' }));
    try {
      const result = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      expect(result).toEqual({ refused: true, reason: 'preflight-failed' });
      const state = replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));
      expect(Object.keys(state.sessions)).toHaveLength(0);
      expect(host.liveProcessCount()).toBe(0);
      const rejected = readAllStreamsGrouped(store).filter((record) => record.type === 'transition_rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.payload as { cause: string }).cause).toBe('preflight-failed:no-credentials');
    } finally {
      host.stop();
    }
  });

  it('a passing preflight allows the spawn', async () => {
    const barrier = makeBarrier();
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      await barrier.promise;
    });
    const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const store = new MemoryEventStore({ clock, ids });
    const router = new EventRouter(store);
    const host = new SessionHost({
      store,
      router,
      clock,
      ids,
      config: buildConfig(),
      sdkQueryFactory: factory,
      preflightProbe: () => ({ ok: true }),
    });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      expect('appSessionId' in spawn).toBe(true);
    } finally {
      barrier.release();
      host.stop();
    }
  });
});

// ── C settings injection + hook custody + D7 correlation ─────────────────────

describe('SessionHost — settings injection + hook custody (C, D7)', () => {
  it('spawn writes a per-session settings file (five hooks + relay); exit removes it; secret verifies', async () => {
    const fakePty = makeFakePty();
    const { host } = makeHarness({ ptySpawnFactory: fakePty.factory });
    const spawn = host.spawnSession({ channel: 'pty', cwd: '/p' });
    const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
    const path = sessionSettingsPath(settingsTempDir, appSessionId);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'].sort(),
    );
    const relay = parsed.hooks.SessionStart![0]!.hooks[0]!.command;
    expect(relay).toContain(`/hooks/${appSessionId}`);
    const secret = /Bearer ([^"\s]+)/.exec(relay)![1]!;

    // The registered secret authenticates constant-time; wrong / unknown reject.
    expect(host.verifyHookSecret(appSessionId, secret)).toBe('ok');
    expect(host.verifyHookSecret(appSessionId, 'wrong-secret')).toBe('bad-secret');
    expect(host.verifyHookSecret(appSessionId, undefined)).toBe('missing-secret');
    expect(host.verifyHookSecret('no-such-session', secret)).toBe('unknown-session');

    // Exit removes the settings file (best-effort file custody).
    fakePty.fireExit(0);
    await waitFor(() => {
      try {
        readFileSync(path, 'utf8');
        return false;
      } catch {
        return true;
      }
    });
    host.stop();
  });

  it('ingestHook emits the hook event (appSessionId stamped) and dedupes claude_session_mapped across channels (D7)', async () => {
    const barrier = makeBarrier();
    // The SDK init maps 'claude-sdk'; the hook posts map further ids.
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-sdk' };
      await barrier.promise;
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/home/wes/dongfu' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => (sessionOf(store, appSessionId)?.claudeSessionIds.length ?? 0) === 1);

      // A hook SessionStart for a NEW id → new mapping; the event is emitted with
      // appSessionId stamped and the observed transcript_path used verbatim.
      expect(
        host.ingestHook(appSessionId, {
          hook_event_name: 'SessionStart',
          session_id: 'claude-hook',
          transcript_path: '/observed/claude-hook.jsonl',
        }),
      ).toEqual({ status: 'emitted' });
      const hookStart = records(store, appSessionId).find((record) => record.type === 'hook_session_start')!;
      expect((hookStart.payload as { appSessionId: string; session_id: string })).toMatchObject({
        appSessionId,
        session_id: 'claude-hook',
      });

      // Re-posting the SAME id → deduped (hook-path idempotent). And the SDK's own
      // id posted via a hook → deduped (cross-path idempotent).
      host.ingestHook(appSessionId, { hook_event_name: 'SessionStart', session_id: 'claude-hook' });
      host.ingestHook(appSessionId, { hook_event_name: 'SessionStart', session_id: 'claude-sdk' });

      const mappings = records(store, appSessionId).filter((record) => record.type === 'claude_session_mapped');
      expect(mappings.map((record) => (record.payload as { claudeSessionId: string }).claudeSessionId)).toEqual([
        'claude-sdk',
        'claude-hook',
      ]);
      // The hook-path mapping used the observed transcript_path.
      const hookMapping = mappings.find((record) => (record.payload as { claudeSessionId: string }).claudeSessionId === 'claude-hook')!;
      expect((hookMapping.payload as { jsonlPath: string }).jsonlPath).toBe('/observed/claude-hook.jsonl');
    } finally {
      barrier.release();
      host.stop();
    }
  });

  it('ingestHook returns unknown-event for an unrecognized hook_event_name (no crash, no mapping)', async () => {
    const barrier = makeBarrier();
    const { factory } = makeSdkFactory(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' };
      await barrier.promise;
    });
    const { host, store } = makeHarness({ sdkQueryFactory: factory });
    try {
      const spawn = host.spawnSession({ channel: 'sdk', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      await waitFor(() => sessionOf(store, appSessionId) !== undefined);
      expect(host.ingestHook(appSessionId, { hook_event_name: 'NotARealHook' })).toEqual({ status: 'unknown-event' });
    } finally {
      barrier.release();
      host.stop();
    }
  });
});
