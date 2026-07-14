import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CountingIdSource,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  type EventRecord,
} from '@vimes/core';
import { JsonlTailer } from './tailer.js';
import { transcriptDirFor } from './transcriptPaths.js';

// Real fs + real chokidar. The tailer's internal size-poll (set fast here) makes
// append delivery deterministic — chokidar alone drops the trailing append of a
// rapid burst on this box (see the FINDING in tailer.ts), so the test exercises
// the backstop that production relies on.

const FAST_POLL_MS = 25;

interface Rig {
  tailer: JsonlTailer;
  store: MemoryEventStore;
  events: EventRecord[];
  projectsRoot: string;
  cleanup: () => Promise<void>;
}

const activeCleanups: Array<() => Promise<void>> = [];

function makeRig(cwd: string, appSessionId: string): Rig & { transcriptDir: string; transcriptFile: string } {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'vimes-tailer-'));
  const clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
  const ids = new CountingIdSource();
  const store = new MemoryEventStore({ clock, ids });
  const router = new EventRouter(store);
  const events: EventRecord[] = [];
  router.subscribe(appSessionId, 0, (event) => events.push(event));

  const tailer = new JsonlTailer({ router, projectsRoot, pollIntervalMs: FAST_POLL_MS });
  const transcriptDir = transcriptDirFor(projectsRoot, cwd);
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptFile = join(transcriptDir, 'session-abc.jsonl');

  const cleanup = async (): Promise<void> => {
    await tailer.close();
    rmSync(projectsRoot, { recursive: true, force: true });
  };
  activeCleanups.push(cleanup);
  return { tailer, store, events, projectsRoot, cleanup, transcriptDir, transcriptFile };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageRecord(role: string, content: string, usage?: Record<string, unknown>): string {
  return `${JSON.stringify({ message: { role, content, ...(usage ? { usage } : {}) } })}\n`;
}

afterEach(async () => {
  while (activeCleanups.length > 0) {
    await activeCleanups.pop()!();
  }
});

describe('JsonlTailer — PTY structured channel', () => {
  it('appended lines (incl. one split mid-line across writes) map to message events in order', async () => {
    const appSessionId = 'app-pty-1';
    const rig = makeRig('/home/wes/proj', appSessionId);
    rig.tailer.watchSession({ appSessionId, cwd: '/home/wes/proj' });

    appendFileSync(rig.transcriptFile, messageRecord('user', 'first'));
    await waitFor(() => rig.events.filter((event) => event.type === 'message').length >= 1);

    // Second complete line + the first HALF of a third line in one write.
    const thirdLine = messageRecord('user', 'third');
    const splitAt = 12;
    appendFileSync(
      rig.transcriptFile,
      messageRecord('assistant', 'second', { output_tokens: 2 }) + thirdLine.slice(0, splitAt),
    );
    await waitFor(() => rig.events.filter((event) => event.type === 'message').length >= 2);

    // The rest of the third line completes it.
    appendFileSync(rig.transcriptFile, thirdLine.slice(splitAt));
    await waitFor(() => rig.events.filter((event) => event.type === 'message').length >= 3);

    const messageRoles = rig.events
      .filter((event) => event.type === 'message')
      .map((event) => (event.payload as { role: string }).role);
    expect(messageRoles).toEqual(['user', 'assistant', 'user']);
    // The assistant record carried usage → a usage_block rode alongside it.
    expect(rig.events.some((event) => event.type === 'usage_block')).toBe(true);
    // Mapper stamps the actual file path on events derived from it.
    const firstMessage = rig.events.find((event) => event.type === 'message')!;
    expect(firstMessage.stream).toBe(appSessionId);
  });

  it('a hostile (non-JSON) line is quarantined, not fatal', async () => {
    const appSessionId = 'app-pty-2';
    const rig = makeRig('/home/wes/proj', appSessionId);
    rig.tailer.watchSession({ appSessionId, cwd: '/home/wes/proj' });

    appendFileSync(rig.transcriptFile, 'this is { not ] json\n');
    appendFileSync(rig.transcriptFile, messageRecord('assistant', 'recovered'));

    await waitFor(() => rig.events.some((event) => event.type === 'message'));
    const quarantine = rig.events.find((event) => event.type === 'line_quarantined');
    expect(quarantine).toBeDefined();
    expect((quarantine!.payload as { reason: string }).reason).toBe('malformed-json');
  });

  it('truncation resets the offset defensively and re-reads the shrunk file', async () => {
    const appSessionId = 'app-pty-3';
    const rig = makeRig('/home/wes/proj', appSessionId);
    rig.tailer.watchSession({ appSessionId, cwd: '/home/wes/proj' });

    appendFileSync(rig.transcriptFile, messageRecord('user', 'one'));
    appendFileSync(rig.transcriptFile, messageRecord('assistant', 'two'));
    await waitFor(() => rig.events.filter((event) => event.type === 'message').length >= 2);

    // Truncate: rewrite with a single, shorter line (size < prior offset).
    writeFileSync(rig.transcriptFile, messageRecord('system', 'reset'));
    await waitFor(() =>
      rig.events.some(
        (event) => event.type === 'message' && (event.payload as { role: string }).role === 'system',
      ),
    );
  });

  it('a file mapped to an SDK-channel session is skipped (single source per session, dedupe)', async () => {
    const appSessionId = 'app-pty-4';
    const rig = makeRig('/home/wes/proj', appSessionId);
    rig.tailer.watchSession({ appSessionId, cwd: '/home/wes/proj' });

    const sdkFile = join(rig.transcriptDir, 'sdk-owned.jsonl');
    rig.tailer.markSdkJsonl(sdkFile);

    writeFileSync(sdkFile, messageRecord('assistant', 'from-sdk-stream'));
    // Also write a genuine PTY file so we have a positive signal the watcher is live.
    appendFileSync(rig.transcriptFile, messageRecord('user', 'from-pty'));

    await waitFor(() => rig.events.some((event) => event.type === 'message'));
    // Exactly one message — the PTY one; the SDK-marked file produced nothing.
    const messageContents = rig.events
      .filter((event) => event.type === 'message')
      .map((event) => (event.payload as { content: string }).content);
    expect(messageContents).toEqual(['from-pty']);
  });
});
