import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  TranscriptTail,
  mapTranscriptOutputs,
  sessionCreated,
  sessionsProjection,
  type SessionRecord,
} from '@vimes/core';

function readFixture(name: string): string {
  const fixtureUrl = new URL(`../../../fixtures/transcripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(fixtureUrl), 'utf8');
}

const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JSONL_PATH = '/home/user/.claude/projects/encoded/synthetic.jsonl';

// Drive one fixture through tail + mapper into a fresh world; return the final
// SessionRecord. Both worlds use identical clock/id seeds.
function runWorld(fixtureName: string): SessionRecord {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const router = new EventRouter(store);

  let state = sessionsProjection.init();
  router.subscribe(APP_SESSION_ID, 0, (event) => {
    state = sessionsProjection.apply(state, event);
  });

  // Both worlds are born identically.
  router.emit([
    sessionCreated({
      appSessionId: APP_SESSION_ID,
      channel: 'pty',
      cwd: '/home/user/project',
      name: 'i1 session',
      forkedFrom: null,
      taskRef: null,
    }),
  ]);

  const tail = new TranscriptTail();
  const outputs = tail.push(readFixture(fixtureName));
  const events = mapTranscriptOutputs(APP_SESSION_ID, outputs, JSONL_PATH);
  router.emit(events);

  return state.sessions[APP_SESSION_ID]!;
}

describe('I1 — appSessionId state survives Claude session-ID rotation', () => {
  it('baseline vs rotation differ ONLY in claudeSessionIds', () => {
    const baselineRecord = runWorld('baseline.jsonl');
    const rotationRecord = runWorld('rotation.jsonl');

    // Mapping counts: baseline sees one sessionId, rotation sees two.
    expect(baselineRecord.claudeSessionIds).toHaveLength(1);
    expect(rotationRecord.claudeSessionIds).toHaveLength(2);
    expect(rotationRecord.claudeSessionIds.map((m) => m.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);

    // Everything else is byte-identical (I1: rotation changes only the mapping).
    const baselineWithoutMapping: Partial<SessionRecord> = { ...baselineRecord };
    delete baselineWithoutMapping.claudeSessionIds;
    const rotationWithoutMapping: Partial<SessionRecord> = { ...rotationRecord };
    delete rotationWithoutMapping.claudeSessionIds;

    expect(rotationWithoutMapping).toEqual(baselineWithoutMapping);
  });

  it('the mapping entries carry the passed-in jsonlPath', () => {
    const rotationRecord = runWorld('rotation.jsonl');
    for (const mappingEntry of rotationRecord.claudeSessionIds) {
      expect(mappingEntry.jsonlPath).toBe(JSONL_PATH);
    }
  });
});
