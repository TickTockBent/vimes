import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventRecordSchema, type EventRecord } from '../schemas.js';
import { tasksProjection } from './tasks.js';

// ─── S10·Move-0 (D72) — the migration fixture replay ─────────────────────────
//
// The frozen recorded behaviour of the Gate-2 trial's 'tasks' stream (111
// events, seq 1-111, exported READONLY from the live production store on
// 2026-08-06 — fixtures/migration/README.md has the exact export method).
// This is the fixture every later seam-first migration step (D72, moves 1-3)
// is checked against: "refactors are free, behaviour is the test."
//
// ⚠ THIS FIXTURE IS FROZEN. It is NEVER regenerated to make a test here pass.
// A divergence is a rule-0.1 finding — see slice-10.md's Move-0 kill
// criterion ("the frozen fixture does NOT replay byte-identical through
// today's fold -> the fold is nondeterministic -> rule-0.1 finding, slice
// halts") — not something to patch by re-exporting or re-freezing.
//
// Path depth note: this file lives one directory deeper than
// packages/daemon/src/usageApi.test.ts (which this fixture-loading convention
// mirrors), so it needs FOUR `../` to reach the repo root, not three:
// packages/core/src/projections/ -> packages/core/src/ -> packages/core/ ->
// packages/ -> repo root.

const FIXTURE_EVENTS_PATH = fileURLToPath(
  new URL('../../../../fixtures/migration/tasks-stream.jsonl', import.meta.url),
);
const FIXTURE_STATE_PATH = fileURLToPath(
  new URL('../../../../fixtures/migration/tasks-state.json', import.meta.url),
);

// Parsed and schema-validated the same way any other EventRecord in this
// codebase is constructed — never a blind cast of the raw JSON line.
function loadFixtureEvents(): EventRecord[] {
  const text = readFileSync(FIXTURE_EVENTS_PATH, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => eventRecordSchema.parse(JSON.parse(line)));
}

function foldFixture(events: EventRecord[]): string {
  let state = tasksProjection.init();
  for (const event of events) {
    state = tasksProjection.apply(state, event);
  }
  return tasksProjection.serialize(state);
}

describe('tasks fixture replay — the D72 Move-0 migration fixture', () => {
  it('has exactly 111 events, seq 1..111 contiguous, all on the tasks stream', () => {
    const events = loadFixtureEvents();
    expect(events).toHaveLength(111);
    events.forEach((event, index) => {
      expect(event.seq).toBe(index + 1);
      expect(event.stream).toBe('tasks');
    });
  });

  it('replays byte-identical to the frozen tasks-state.json (a redden here is a rule-0.1 finding — slice-10.md kill criteria)', () => {
    const events = loadFixtureEvents();
    const frozenState = readFileSync(FIXTURE_STATE_PATH, 'utf8');

    const serialized = foldFixture(events);

    // Byte-identical, not deep-equal: the frozen file IS `serialize()`'s
    // canonicalJson output, so a passing test proves the exact bytes match,
    // not merely that they parse to equivalent structures.
    expect(serialized).toBe(frozenState);
  });

  it('folds DETERMINISTICALLY — two independent init+fold runs are byte-identical (the kill-criterion probe)', () => {
    const events = loadFixtureEvents();

    const serializedFirstRun = foldFixture(events);
    const serializedSecondRun = foldFixture(events);

    expect(serializedFirstRun).toBe(serializedSecondRun);
  });
});
