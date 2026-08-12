import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventRecordSchema, type EventRecord } from '../schemas.js';
import { instancesProjection } from './instances.js';

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
// ── S11·U1 (D72 Move 2) — THIS FILE BECAME THE EXIT-GATE CENTREPIECE (S11-A1) ─
//
// The fold under test changed and the frozen bytes did NOT. Through S13·U3 the
// 111 events were replayed through `instancesProjection` and the resulting
// instances state was run back through `legacyTasksViewOf` before the
// comparison against the frozen `tasks-state.json` — the whole round trip in
// one assertion: legacy event -> alias adapter -> generic payload -> instance
// record -> legacy view -> the exact bytes the old reducer produced.
//
// ── S13·U4 (D72 Move 4, q24 close) — THE FIXTURE SUCCESSION (S13-A7) ─────────
//
// This file's own prior comment named its own succession plan: "the day the
// aliases die, this line becomes `instancesProjection.serialize(state)` and
// the frozen file is re-pinned against the instances shape in its own unit."
// That day is this unit. The comparison below no longer runs through
// `legacyTasksViewOf` or against `tasks-state.json` — it pins the INSTANCES
// serialization directly, via `instancesProjection.serialize`, against a NEW
// sibling file: `fixtures/migration/tasks-state-instances.json`.
//
// ⚠ NEITHER EXISTING FROZEN FILE IS TOUCHED. `tasks-stream.jsonl` (the raw
// 111-event export) and `tasks-state.json` (the OLD reducer's pinned output,
// via the legacy view) stay exactly as S10/S11 froze them — this unit adds a
// THIRD file rather than overwriting either. Two reasons, both load-bearing:
// (1) `tasks-state.json` is itself frozen historical truth (S10-A1's own
// record of what the pre-D72 reducer produced), and overwriting it would
// erase that; (2) the new pinned bytes were tried FIRST as an inline literal
// in this file (the S12·U3 precedent — `frozenReferenceOutcome` in
// proposeMove.test.ts, "written out as DATA, frozen at deletion"), and that
// approach reddened S13-A5's grep gate for the dead task-alias route family:
// the fixture's real, historical task content happens to contain that exact
// route-path substring inside a payload field (present in `tasks-state.json`
// too — this is not new, it is the SAME fact that file already carries, just
// now somewhere the grep gate scans). A file under `fixtures/` is outside the
// gate's scanned paths (`packages/daemon/src`, `packages/core/src`), so the
// data-content collision cannot re-trip it there. `tasks-state-instances.json`
// was produced by `foldFixtureToInstances` below, run against a checkout at
// this commit, with its own determinism verified (two independent folds
// byte-identical) before being written.
//
// Path depth note: this file lives one directory deeper than
// packages/daemon/src/usageApi.test.ts (which this fixture-loading convention
// mirrors), so it needs FOUR `../` to reach the repo root, not three:
// packages/core/src/projections/ -> packages/core/src/ -> packages/core/ ->
// packages/ -> repo root.

const FIXTURE_EVENTS_PATH = fileURLToPath(
  new URL('../../../../fixtures/migration/tasks-stream.jsonl', import.meta.url),
);
const FIXTURE_INSTANCES_STATE_PATH = fileURLToPath(
  new URL('../../../../fixtures/migration/tasks-state-instances.json', import.meta.url),
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

// Fold to instances and serialize — `instancesProjection.serialize` IS
// `canonicalJson` of the state (instances.ts's own `serialize`), so this is
// the exact bytes a `GET /api/projections/instances` response body carries.
function foldFixtureToInstances(events: EventRecord[]): string {
  let state = instancesProjection.init();
  for (const event of events) {
    state = instancesProjection.apply(state, event);
  }
  return instancesProjection.serialize(state);
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

  it('replays through the INSTANCES fold byte-identical to the frozen tasks-state-instances.json (S13-A7; a redden here is a rule-0.1 finding)', () => {
    const events = loadFixtureEvents();
    const frozenState = readFileSync(FIXTURE_INSTANCES_STATE_PATH, 'utf8');

    const serialized = foldFixtureToInstances(events);

    // Byte-identical, not deep-equal: the frozen file IS
    // `instancesProjection.serialize`'s output, so a passing test proves the
    // exact bytes match, not merely that they parse to equivalent structures.
    expect(serialized).toBe(frozenState);
  });

  it('folds DETERMINISTICALLY — two independent init+fold runs are byte-identical (S11-A1 "twice", the kill-criterion probe)', () => {
    const events = loadFixtureEvents();

    const serializedFirstRun = foldFixtureToInstances(events);
    const serializedSecondRun = foldFixtureToInstances(events);

    expect(serializedFirstRun).toBe(serializedSecondRun);
  });
});
