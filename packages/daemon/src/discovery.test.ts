import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTENTION_SETTER_TYPES,
  CountingIdSource,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionsProjection,
  type EventRecord,
  type SessionRecord,
} from '@vimes/core';
import { SessionHost } from './sessionHost.js';
import { JsonlTailer } from './tailer.js';
import { scanForExternalTranscripts } from './discovery.js';
import { transcriptDirFor, transcriptFileFor } from './transcriptPaths.js';
import type { DaemonConfig } from './config.js';

// Discovery + custody run against a mkdtemp fake `~/.claude/projects` — NEVER the
// real one (injected projectsRoot + projectRoots). A real JsonlTailer with a fast
// poll makes EOF-tailing deterministic.

const FAST_POLL_MS = 25;
const activeCleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (activeCleanups.length > 0) {
    await activeCleanups.pop()!();
  }
});

function messageLine(role: string, content: string): string {
  return `${JSON.stringify({ message: { role, content } })}\n`;
}

function buildConfig(projectRoots: string[]): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'vimes-discovery-data-')),
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots,
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
  };
}

interface Rig {
  host: SessionHost;
  store: MemoryEventStore;
  projectsRoot: string;
  cwd: string;
  transcriptDir: string;
}

function makeRig(cwd = '/home/wes/extproj'): Rig {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'vimes-discovery-projects-'));
  const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
  const ids = new CountingIdSource();
  const store = new MemoryEventStore({ clock, ids });
  const router = new EventRouter(store);
  const host = new SessionHost({
    store,
    router,
    clock,
    ids,
    config: buildConfig([cwd]),
    projectsRoot,
  });
  const tailer = new JsonlTailer({
    router,
    projectsRoot,
    pollIntervalMs: FAST_POLL_MS,
    isExternalCustody: (appSessionId) => host.isExternalCustody(appSessionId),
  });
  host.attachTailer(tailer);
  const transcriptDir = transcriptDirFor(projectsRoot, cwd);
  mkdirSync(transcriptDir, { recursive: true });
  activeCleanups.push(async () => {
    host.stop();
    await tailer.close();
    rmSync(projectsRoot, { recursive: true, force: true });
  });
  return { host, store, projectsRoot, cwd, transcriptDir };
}

function externalSessionRecords(store: MemoryEventStore): SessionRecord[] {
  const state = replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));
  return Object.values(state.sessions).filter((session) => session.custody === 'external');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── the pure scan ─────────────────────────────────────────────────────────────

describe('scanForExternalTranscripts (pure)', () => {
  it('lists *.jsonl in each root\'s ENCODED dir; skips already-known files/ids', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'vimes-scan-'));
    activeCleanups.push(() => rmSync(projectsRoot, { recursive: true, force: true }));
    const cwd = '/home/wes/scanproj';
    const dir = transcriptDirFor(projectsRoot, cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-a.jsonl'), '');
    writeFileSync(join(dir, 'sess-b.jsonl'), '');
    writeFileSync(join(dir, 'not-a-transcript.txt'), ''); // ignored

    // Uses the transcriptPaths encoding module (fragile-adapter boundary).
    const all = scanForExternalTranscripts({
      projectRoots: [cwd],
      projectsRoot,
      knownJsonlPaths: new Set(),
      knownClaudeSessionIds: new Set(),
    });
    expect(all.map((entry) => entry.claudeSessionId).sort()).toEqual(['sess-a', 'sess-b']);
    expect(all[0]!.jsonlPath).toBe(transcriptFileFor(projectsRoot, cwd, all[0]!.claudeSessionId));
    expect(all.every((entry) => entry.cwd === cwd)).toBe(true);

    // Known-path guard (idempotency): sess-a already mapped → only sess-b returns.
    const byPath = scanForExternalTranscripts({
      projectRoots: [cwd],
      projectsRoot,
      knownJsonlPaths: new Set([transcriptFileFor(projectsRoot, cwd, 'sess-a')]),
      knownClaudeSessionIds: new Set(),
    });
    expect(byPath.map((entry) => entry.claudeSessionId)).toEqual(['sess-b']);

    // Known-id guard: sess-b id known → only sess-a returns.
    const byId = scanForExternalTranscripts({
      projectRoots: [cwd],
      projectsRoot,
      knownJsonlPaths: new Set(),
      knownClaudeSessionIds: new Set(['sess-b']),
    });
    expect(byId.map((entry) => entry.claudeSessionId)).toEqual(['sess-a']);
  });

  it('a missing transcript dir yields nothing (no throw)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'vimes-scan-empty-'));
    activeCleanups.push(() => rmSync(projectsRoot, { recursive: true, force: true }));
    expect(
      scanForExternalTranscripts({
        projectRoots: ['/home/wes/never-existed'],
        projectsRoot,
        knownJsonlPaths: new Set(),
        knownClaudeSessionIds: new Set(),
      }),
    ).toEqual([]);
  });
});

// ── host discovery + custody + EOF-tailing ─────────────────────────────────────

describe('SessionHost.discoverExternalSessions (D10)', () => {
  it('mints a mirrored session: created(external) → interrupted → mapped → resync_marker', () => {
    const rig = makeRig();
    writeFileSync(join(rig.transcriptDir, 'ext-sess.jsonl'), messageLine('user', 'pre-adoption history'));

    const count = rig.host.discoverExternalSessions();
    expect(count).toBe(1);

    const external = externalSessionRecords(rig.store);
    expect(external).toHaveLength(1);
    const appSessionId = external[0]!.appSessionId;
    expect(external[0]!.custody).toBe('external');
    expect(external[0]!.liveness).toBe('interrupted');
    expect(external[0]!.channel).toBe('pty');
    expect(external[0]!.cwd).toBe(rig.cwd);
    expect(external[0]!.claudeSessionIds.map((mapping) => mapping.id)).toEqual(['ext-sess']);
    // The mapping used the encoded transcript path (encoding module).
    expect(external[0]!.claudeSessionIds[0]!.jsonlPath).toBe(
      transcriptFileFor(rig.projectsRoot, rig.cwd, 'ext-sess'),
    );

    const streamTypes = rig.store.read(appSessionId, 1).map((record: EventRecord) => record.type);
    expect(streamTypes).toEqual([
      'session_created',
      'liveness_changed',
      'claude_session_mapped',
      'resync_marker',
    ]);
    const resync = rig.store.read(appSessionId, 1).find((record) => record.type === 'resync_marker')!;
    expect((resync.payload as { reason: string }).reason).toBe('pre-adoption-history');
  });

  it('is idempotent: a second scan mints nothing for an already-mapped transcript', () => {
    const rig = makeRig();
    writeFileSync(join(rig.transcriptDir, 'ext-sess.jsonl'), messageLine('user', 'x'));
    expect(rig.host.discoverExternalSessions()).toBe(1);
    expect(rig.host.discoverExternalSessions()).toBe(0);
    expect(externalSessionRecords(rig.store)).toHaveLength(1);
  });

  it('EOF-tailing: pre-discovery history is NOT replayed; appends AFTER discovery surface live', async () => {
    const rig = makeRig();
    const file = join(rig.transcriptDir, 'ext-sess.jsonl');
    // History predating discovery — must NOT be emitted (the resync marker is the
    // honest signal; the file is mirrored from EOF).
    writeFileSync(file, messageLine('user', 'ancient history'));

    rig.host.discoverExternalSessions();
    const appSessionId = externalSessionRecords(rig.store)[0]!.appSessionId;

    // A live append after discovery surfaces as a message on the external stream.
    appendFileSync(file, messageLine('assistant', 'live reply'));
    await waitFor(() =>
      rig.store.read(appSessionId, 1).some((record) => record.type === 'message'),
    );

    const messages = rig.store
      .read(appSessionId, 1)
      .filter((record) => record.type === 'message')
      .map((record) => (record.payload as { content: unknown }).content);
    // ONLY the live append — the ancient history was never read.
    expect(messages).toEqual(['live reply']);
  });

  it('attention guard: zero attention-setter events ever land on an external-custody stream', async () => {
    const rig = makeRig();
    const file = join(rig.transcriptDir, 'ext-sess.jsonl');
    writeFileSync(file, messageLine('user', 'seed'));
    rig.host.discoverExternalSessions();
    const appSessionId = externalSessionRecords(rig.store)[0]!.appSessionId;

    appendFileSync(file, messageLine('assistant', 'reply one'));
    appendFileSync(file, messageLine('assistant', 'reply two'));
    await waitFor(
      () =>
        rig.store.read(appSessionId, 1).filter((record) => record.type === 'message').length >= 2,
    );

    const setterEvents = rig.store
      .read(appSessionId, 1)
      .filter((record) => ATTENTION_SETTER_TYPES.has(record.type));
    expect(setterEvents).toEqual([]);
  });

  it('boot start() rehydrates external custody from the log AND re-mirrors from EOF', async () => {
    const rig = makeRig();
    const file = join(rig.transcriptDir, 'ext-sess.jsonl');
    writeFileSync(file, messageLine('user', 'seed'));
    // First discovery mints the mirror; then a NEW host over the same store must
    // re-arm the guard set + re-mirror at boot (custody survives; mirrors do not).
    rig.host.discoverExternalSessions();
    const appSessionId = externalSessionRecords(rig.store)[0]!.appSessionId;

    // Build a second host+tailer over the SAME store and start it (boot).
    const clock = new SteppingClock('2026-02-01T00:00:00.000Z', 1000);
    const ids = new CountingIdSource();
    const router2 = new EventRouter(rig.store);
    const host2 = new SessionHost({
      store: rig.store,
      router: router2,
      clock,
      ids,
      config: buildConfig([rig.cwd]),
      projectsRoot: rig.projectsRoot,
    });
    const tailer2 = new JsonlTailer({
      router: router2,
      projectsRoot: rig.projectsRoot,
      pollIntervalMs: FAST_POLL_MS,
      isExternalCustody: (id) => host2.isExternalCustody(id),
    });
    host2.attachTailer(tailer2);
    activeCleanups.push(async () => {
      host2.stop();
      await tailer2.close();
    });
    host2.start();
    expect(host2.isExternalCustody(appSessionId)).toBe(true);

    // A live append is picked up by the re-established mirror.
    appendFileSync(file, messageLine('assistant', 'post-boot reply'));
    await waitFor(() =>
      rig.store.read(appSessionId, 1).some(
        (record) => record.type === 'message' && (record.payload as { content: unknown }).content === 'post-boot reply',
      ),
    );
  });
});
