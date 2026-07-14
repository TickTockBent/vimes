import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  gateFired,
  livenessChanged,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionCreated,
  sessionsProjection,
  withNotificationTrigger,
  type EventRecord,
  type SessionRecord,
} from '@vimes/core';
import type { DaemonConfig } from './config.js';
import {
  SessionHost,
  scrubClaudeEnv,
  type PtyLike,
  type PtySpawnFactory,
  type SdkQueryFactory,
  type SdkQueryOptions,
  type SdkStreamMessage,
  type SdkUserMessage,
} from './sessionHost.js';

// ── harness helpers ──────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    dbPath: ':memory:',
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

      const messageRecord = records(store, appSessionId).find((record) => record.type === 'message')!;
      expect((messageRecord.payload as { role: string }).role).toBe('assistant');
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

  it('keystrokes: sendMessage writes text + carriage return to the pty', () => {
    const fakePty = makeFakePty();
    const { host } = makeHarness({ ptySpawnFactory: fakePty.factory });
    try {
      const spawn = host.spawnSession({ channel: 'pty', cwd: '/p' });
      const appSessionId = 'appSessionId' in spawn ? spawn.appSessionId : '';
      host.sendMessage(appSessionId, 'ls -la');
      expect(fakePty.writes).toEqual(['ls -la\r']);
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
