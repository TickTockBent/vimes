import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventRecordSchema, type EventRecord } from '../schemas.js';
import { instancesProjection } from './instances.js';
import { legacyTasksViewOf } from './legacyTasksView.js';
import { canonicalJson } from '../canonicalJson.js';

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
// ── S11·U1 (D72 Move 2) — THIS FILE IS NOW THE EXIT-GATE CENTREPIECE (S11-A1) ─
//
// The fold under test changed and the frozen bytes did NOT. The 111 events are
// replayed through `instancesProjection` — every one of them a RETIRED kind,
// resolved through the alias table — and the resulting instances state is run
// back through `legacyTasksViewOf` before the comparison. What that pins is the
// whole round trip in one assertion: legacy event -> alias adapter -> generic
// payload -> instance record -> legacy view -> the exact bytes the old reducer
// produced. If the core/payload split had lost one fact q13's field list was
// supposed to carry, this is where it would show, and slice-11.md's first kill
// criterion is that a redden here is a finding about the SIGNED abstraction —
// not a licence to adjust either side until they agree.
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

// Fold to instances, then narrow back to the legacy shape. `canonicalJson` is
// called on the VIEW rather than `instancesProjection.serialize` on the state,
// because the view is a derivation and not a projection — it has no serializer
// of its own, and it must not grow one: the day the aliases die, this line
// becomes `instancesProjection.serialize(state)` and the frozen file is
// re-pinned against the instances shape in its own unit.
function foldFixtureToLegacyView(events: EventRecord[]): string {
  let state = instancesProjection.init();
  for (const event of events) {
    state = instancesProjection.apply(state, event);
  }
  return canonicalJson(legacyTasksViewOf(state));
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

  it('replays through the INSTANCES fold + legacy view byte-identical to the frozen tasks-state.json (S11-A1; a redden here is a rule-0.1 finding — slice-11.md kill criteria)', () => {
    const events = loadFixtureEvents();
    const frozenState = readFileSync(FIXTURE_STATE_PATH, 'utf8');

    const serialized = foldFixtureToLegacyView(events);

    // Byte-identical, not deep-equal: the frozen file IS the old `serialize()`'s
    // canonicalJson output, so a passing test proves the exact bytes match, not
    // merely that they parse to equivalent structures.
    expect(serialized).toBe(frozenState);
  });

  it('folds DETERMINISTICALLY — two independent init+fold runs are byte-identical (S11-A1 "twice", the kill-criterion probe)', () => {
    const events = loadFixtureEvents();

    const serializedFirstRun = foldFixtureToLegacyView(events);
    const serializedSecondRun = foldFixtureToLegacyView(events);

    expect(serializedFirstRun).toBe(serializedSecondRun);
  });

  it('serializes the INSTANCES state itself deterministically too — the shape the fixture is re-pinned against when the aliases die', () => {
    // Not a byte contract yet (there is no frozen instances fixture, and
    // inventing one now would freeze a shape Move 3 still changes), but the
    // determinism it will rest on is asserted here rather than assumed later.
    const events = loadFixtureEvents();
    const foldOnce = (): string => {
      let state = instancesProjection.init();
      for (const event of events) {
        state = instancesProjection.apply(state, event);
      }
      return instancesProjection.serialize(state);
    };

    expect(foldOnce()).toBe(foldOnce());
  });
});
