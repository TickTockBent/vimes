import { describe, expect, it } from 'vitest';
import {
  DISPATCHABLE_TASK_STAGES,
  NON_DISPATCHABLE_TASK_STAGES,
  decideDispatch,
  dispatchDeferReasonSchema,
  dispatchRefuseReasonSchema,
  isDispatchableStage,
  type DispatchDecision,
  type DispatchInput,
} from './dispatchDecision.js';
import { TASK_STAGES, type TaskStage } from './taskStateMachine.js';
import { evaluateHeadroomGate } from '../meterDerivations.js';
import type { MetersState } from '../projections/meters.js';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  dispatchRefused,
  dispatchRefusedPayloadSchema,
} from '../events.js';
import type { MeterRecord, TaskRecord } from '../schemas.js';

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Every clock in this file is a LITERAL. `nowIso` is a parameter of the function
// under test (rule 0.3), so no test here may read a clock either — a test that
// did would be asserting against a moving target and would also trip the
// ci-gate's nondeterminism grep over packages/core/src.

const NOW_ISO = '2026-07-22T12:00:00.000Z';
const LATER_ISO = '2026-07-22T18:00:00.000Z';
// The staleness window is supplied by the caller everywhere (rule 0.2 — core
// pins no band). 15 min happens to be D30's pinned value; it is named here as a
// test input, not imported as a default, because there is no default to import.
const STALE_AFTER_MS = 15 * 60 * 1000;

function taskAtStage(stage: TaskStage, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    projectRoot: '/home/wes/projects/vimes',
    stage,
    manualReviewRequired: false,
    // D32: the pinned default. Named explicitly so no fixture implies one.
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

function meterRecord(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'endpoint:session',
    kind: 'rolling-window',
    percent: 10,
    source: 'endpoint',
    observedAt: NOW_ISO,
    resetsAt: null,
    ...overrides,
  };
}

function metersStateWith(...records: MeterRecord[]): MetersState {
  const meters: Record<string, MeterRecord> = {};
  for (const record of records) {
    meters[record.meterId] = record;
  }
  return { meters, history: {} };
}

const EMPTY_METERS: MetersState = { meters: {}, history: {} };

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    task: taskAtStage('implementing'),
    meters: EMPTY_METERS,
    nowIso: NOW_ISO,
    staleAfterMs: STALE_AFTER_MS,
    hasLiveRun: false,
    ...overrides,
  };
}

// Freeze an object graph so a mutation anywhere inside the input THROWS rather
// than passing silently (vitest runs in strict mode, where writing to a frozen
// property is a TypeError).
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nestedValue);
  }
  return Object.freeze(value);
}

// ─── 1. the dispatchable / non-dispatchable partition ────────────────────────
//
// Both sides are ENUMERATED from the exported data — the dispatchable set and
// its complement against `TASK_STAGES` (itself derived from `taskRecordSchema`).
// There is deliberately no hand-copied stage list in this file: a set plus a
// transcribed test list is two sources of one truth, and they drift.

describe('the dispatchable partition', () => {
  it('partitions TASK_STAGES exactly — every stage is on exactly one side', () => {
    const dispatchable = [...DISPATCHABLE_TASK_STAGES];
    const union = [...dispatchable, ...NON_DISPATCHABLE_TASK_STAGES].sort();
    expect(union).toEqual([...TASK_STAGES].sort());
    // No overlap, no stage counted twice.
    expect(new Set(union).size).toBe(TASK_STAGES.length);
    for (const stage of dispatchable) {
      expect(TASK_STAGES).toContain(stage);
      expect(NON_DISPATCHABLE_TASK_STAGES).not.toContain(stage);
    }
  });

  it('names the three worker-running stages and nothing else', () => {
    // The one place the design intent is spelled out as a value. If a stage is
    // added to the schema it lands in the complement by construction, and this
    // assertion is where a DELIBERATE change to the dispatchable side is made.
    expect([...DISPATCHABLE_TASK_STAGES].sort()).toEqual(['implementing', 'planning', 'review']);
  });

  it('every dispatchable stage spawns on a clean, ungated task', () => {
    for (const stage of DISPATCHABLE_TASK_STAGES) {
      const decision = decideDispatch(dispatchInput({ task: taskAtStage(stage) }));
      expect(decision).toEqual({ action: 'spawn', stage, isolation: 'worktree' });
    }
  });

  it('every non-dispatchable stage refuses stage-not-dispatchable', () => {
    expect(NON_DISPATCHABLE_TASK_STAGES.length).toBeGreaterThan(0);
    for (const stage of NON_DISPATCHABLE_TASK_STAGES) {
      const decision = decideDispatch(dispatchInput({ task: taskAtStage(stage) }));
      expect(decision).toEqual({ action: 'refuse', reason: 'stage-not-dispatchable' });
    }
  });

  it('a stage outside the schema enum is fail-closed, not a crash', () => {
    // Callers cross an API boundary; TypeScript's guarantee stops there.
    const malformedTask = { ...taskAtStage('implementing'), stage: 'wat' } as unknown as TaskRecord;
    expect(isDispatchableStage('wat')).toBe(false);
    expect(decideDispatch(dispatchInput({ task: malformedTask }))).toEqual({
      action: 'refuse',
      reason: 'stage-not-dispatchable',
    });
  });

  it('carries the record isolation through untouched — it is never re-defaulted', () => {
    for (const isolation of ['worktree', 'shared-dir'] as const) {
      const decision = decideDispatch(
        dispatchInput({ task: taskAtStage('planning', { isolation }) }),
      );
      expect(decision).toEqual({ action: 'spawn', stage: 'planning', isolation });
    }
  });
});

// ─── 2. hasLiveRun ───────────────────────────────────────────────────────────

describe('hasLiveRun refuses already-running', () => {
  it('refuses a task that would OTHERWISE spawn', () => {
    const spawnable = dispatchInput({ task: taskAtStage('implementing') });
    expect(decideDispatch(spawnable)).toEqual({
      action: 'spawn',
      stage: 'implementing',
      isolation: 'worktree',
    });
    expect(decideDispatch({ ...spawnable, hasLiveRun: true })).toEqual({
      action: 'refuse',
      reason: 'already-running',
    });
  });

  it('refuses for every dispatchable stage', () => {
    for (const stage of DISPATCHABLE_TASK_STAGES) {
      expect(decideDispatch(dispatchInput({ task: taskAtStage(stage), hasLiveRun: true }))).toEqual({
        action: 'refuse',
        reason: 'already-running',
      });
    }
  });

  it('beats BOTH gate checks (order proof)', () => {
    // A live run, a defer gate that would defer, and a headroom gate that would
    // fail — all at once. `already-running` wins.
    const decision = decideDispatch(
      dispatchInput({
        task: taskAtStage('review', {
          gates: {
            deferUntilReset: 'endpoint:session',
            requireHeadroom: { meterId: 'endpoint:session', pct: 90 },
          },
        }),
        meters: metersStateWith(meterRecord({ percent: 95, resetsAt: LATER_ISO })),
        hasLiveRun: true,
      }),
    );
    expect(decision).toEqual({ action: 'refuse', reason: 'already-running' });
  });
});

// ─── 3 + 4 + 5. the headroom gate — I10 ──────────────────────────────────────

describe('I10 — the requireHeadroom gate', () => {
  const headroomGate = { meterId: 'endpoint:session', pct: 30 };

  it('a FAILING gate refuses headroom-insufficient and carries the evaluator result', () => {
    // 95% used → 5 points of headroom, against a 30-point requirement.
    const meters = metersStateWith(meterRecord({ percent: 95 }));
    const decision = decideDispatch(
      dispatchInput({
        task: taskAtStage('implementing', { gates: { requireHeadroom: headroomGate } }),
        meters,
      }),
    );
    expect(decision.action).toBe('refuse');
    expect(decision).toEqual({
      action: 'refuse',
      reason: 'headroom-insufficient',
      // The evaluator's own result, unmodified — so the refusal explains itself.
      gate: evaluateHeadroomGate(headroomGate, meters, NOW_ISO, STALE_AFTER_MS),
    });
    expect(decision.action === 'refuse' && decision.gate?.verdict).toBe('fail');
    expect(decision.action === 'refuse' && decision.gate?.headroomPercent).toBe(5);
  });

  it('a PASSING gate spawns', () => {
    const meters = metersStateWith(meterRecord({ percent: 10 }));
    expect(
      decideDispatch(
        dispatchInput({
          task: taskAtStage('implementing', { gates: { requireHeadroom: headroomGate } }),
          meters,
        }),
      ),
    ).toEqual({ action: 'spawn', stage: 'implementing', isolation: 'worktree' });
    expect(evaluateHeadroomGate(headroomGate, meters, NOW_ISO, STALE_AFTER_MS).verdict).toBe('pass');
  });

  it('spawns exactly at the boundary and refuses one point below it', () => {
    // pct: 30 means "at least 30 points of headroom" — 70% used is exactly 30.
    const atBoundary = metersStateWith(meterRecord({ percent: 70 }));
    const belowBoundary = metersStateWith(meterRecord({ percent: 70.5 }));
    const gatedTask = taskAtStage('implementing', { gates: { requireHeadroom: headroomGate } });
    expect(decideDispatch(dispatchInput({ task: gatedTask, meters: atBoundary })).action).toBe(
      'spawn',
    );
    expect(decideDispatch(dispatchInput({ task: gatedTask, meters: belowBoundary }))).toMatchObject({
      action: 'refuse',
      reason: 'headroom-insufficient',
    });
  });

  // THE PILLAR-4 PIN. Every way `evaluateHeadroomGate` can return 'unknown',
  // enumerated from its own reason vocabulary — each must refuse, each must
  // refuse with 'headroom-unknown', and NONE may report 'headroom-insufficient'.
  const unknownHeadroomCases: Array<{
    readonly label: string;
    readonly gateReason: string;
    readonly meters: MetersState;
    readonly nowIso: string;
  }> = [
    {
      label: 'meter never observed (not in the projection at all)',
      gateReason: 'meter-never-observed',
      meters: EMPTY_METERS,
      nowIso: NOW_ISO,
    },
    {
      label: 'observation stale (older than staleAfterMs)',
      gateReason: 'observation-stale',
      meters: metersStateWith(
        meterRecord({ percent: 5, observedAt: '2026-07-22T11:00:00.000Z' }),
      ),
      nowIso: NOW_ISO,
    },
    {
      label: 'observation unparseable (freshness itself is unknown)',
      gateReason: 'observation-stale',
      meters: metersStateWith(meterRecord({ percent: 5, observedAt: 'not-a-timestamp' })),
      nowIso: NOW_ISO,
    },
    {
      label: 'nowIso unparseable (we cannot place the observation in time)',
      gateReason: 'observation-stale',
      meters: metersStateWith(meterRecord({ percent: 5 })),
      nowIso: 'not-a-timestamp',
    },
    {
      label: 'percent unobserved (null)',
      gateReason: 'percent-unobserved',
      meters: metersStateWith(meterRecord({ percent: null })),
      nowIso: NOW_ISO,
    },
    {
      label: 'percent absent from the record entirely',
      gateReason: 'percent-unobserved',
      meters: metersStateWith({
        meterId: 'endpoint:session',
        kind: 'rolling-window',
        source: 'endpoint',
        observedAt: NOW_ISO,
      }),
      nowIso: NOW_ISO,
    },
  ];

  it.each(unknownHeadroomCases)(
    'UNKNOWN headroom refuses headroom-unknown, NOT headroom-insufficient — $label',
    ({ gateReason, meters, nowIso }) => {
      const gateResult = evaluateHeadroomGate(headroomGate, meters, nowIso, STALE_AFTER_MS);
      // The case really does exercise the unknown path, for the stated reason.
      expect(gateResult.verdict).toBe('unknown');
      expect(gateResult.reason).toBe(gateReason);
      // UNKNOWN must never carry a headroom number a careless caller could read
      // as current (slice 5's own rule) — restated here because THIS module is
      // the consumer that would have acted on it.
      expect(gateResult.headroomPercent).toBeNull();

      const decision = decideDispatch(
        dispatchInput({
          task: taskAtStage('implementing', { gates: { requireHeadroom: headroomGate } }),
          meters,
          nowIso,
        }),
      );
      expect(decision.action).toBe('refuse');
      expect(decision).toEqual({ action: 'refuse', reason: 'headroom-unknown', gate: gateResult });
      expect(decision.action === 'refuse' && decision.reason).not.toBe('headroom-insufficient');
    },
  );

  it('covers every unknown reason evaluateHeadroomGate can produce', () => {
    // Enumerated, not sampled: the three unknown reasons in slice 5's vocabulary
    // each appear above. If the evaluator grows a fourth, this assertion is the
    // one that reddens.
    const coveredReasons = new Set(unknownHeadroomCases.map((testCase) => testCase.gateReason));
    expect([...coveredReasons].sort()).toEqual([
      'meter-never-observed',
      'observation-stale',
      'percent-unobserved',
    ]);
  });

  it('a task with NO requireHeadroom gate is unaffected by a dead meter surface', () => {
    // The blast radius is opt-in: an unobservable usage endpoint must not halt
    // ungated work.
    expect(
      decideDispatch(dispatchInput({ task: taskAtStage('review'), meters: EMPTY_METERS })),
    ).toEqual({ action: 'spawn', stage: 'review', isolation: 'worktree' });
  });
});

// ─── 6. deferUntilReset ──────────────────────────────────────────────────────

describe('deferUntilReset', () => {
  const deferGates = { deferUntilReset: 'endpoint:weekly_all' };

  function taskDeferredOn(extraGates: Partial<TaskRecord['gates']> = {}): TaskRecord {
    return taskAtStage('implementing', { gates: { ...deferGates, ...extraGates } });
  }

  it('defers awaiting-meter-reset while resetsAt is still in the future', () => {
    const decision = decideDispatch(
      dispatchInput({
        task: taskDeferredOn(),
        meters: metersStateWith(meterRecord({ meterId: 'endpoint:weekly_all', resetsAt: LATER_ISO })),
      }),
    );
    expect(decision).toEqual({
      action: 'defer',
      reason: 'awaiting-meter-reset',
      meterId: 'endpoint:weekly_all',
    });
  });

  it('does NOT defer once resetsAt is in the past — it falls through to the later checks', () => {
    const meters = metersStateWith(
      meterRecord({ meterId: 'endpoint:weekly_all', resetsAt: '2026-07-22T06:00:00.000Z' }),
    );
    // Falls through to spawn when nothing else objects…
    expect(decideDispatch(dispatchInput({ task: taskDeferredOn(), meters }))).toEqual({
      action: 'spawn',
      stage: 'implementing',
      isolation: 'worktree',
    });
    // …and falls through INTO the headroom gate, which still gets its say. A
    // satisfied defer gate is not an approval.
    const failingHeadroom = decideDispatch(
      dispatchInput({
        // The meter sits at 10% used → 90 points of headroom, against a
        // 95-point requirement, so the headroom gate fails.
        task: taskDeferredOn({ requireHeadroom: { meterId: 'endpoint:weekly_all', pct: 95 } }),
        meters,
      }),
    );
    expect(failingHeadroom).toMatchObject({ action: 'refuse', reason: 'headroom-insufficient' });
  });

  it('treats resetsAt exactly equal to now as already reset (not future)', () => {
    const meters = metersStateWith(
      meterRecord({ meterId: 'endpoint:weekly_all', resetsAt: NOW_ISO }),
    );
    expect(decideDispatch(dispatchInput({ task: taskDeferredOn(), meters })).action).toBe('spawn');
  });

  it('defers reset-time-unknown when the meter was never observed', () => {
    expect(
      decideDispatch(dispatchInput({ task: taskDeferredOn(), meters: EMPTY_METERS })),
    ).toEqual({ action: 'defer', reason: 'reset-time-unknown', meterId: 'endpoint:weekly_all' });
  });

  it.each([
    { label: 'resetsAt is null', resetsAt: null },
    { label: 'resetsAt is absent', resetsAt: undefined },
    { label: 'resetsAt is unparseable', resetsAt: 'whenever' },
  ])('defers reset-time-unknown when $label', ({ resetsAt }) => {
    const meters = metersStateWith(meterRecord({ meterId: 'endpoint:weekly_all', resetsAt }));
    expect(decideDispatch(dispatchInput({ task: taskDeferredOn(), meters }))).toEqual({
      action: 'defer',
      reason: 'reset-time-unknown',
      meterId: 'endpoint:weekly_all',
    });
  });

  it('defers reset-time-unknown when nowIso itself is unparseable', () => {
    const meters = metersStateWith(
      meterRecord({ meterId: 'endpoint:weekly_all', resetsAt: LATER_ISO }),
    );
    expect(
      decideDispatch(dispatchInput({ task: taskDeferredOn(), meters, nowIso: 'not-a-timestamp' })),
    ).toEqual({ action: 'defer', reason: 'reset-time-unknown', meterId: 'endpoint:weekly_all' });
  });

  it('an unknown reset time DEFERS while unknown headroom REFUSES (the documented contrast)', () => {
    const unknownReset = decideDispatch(
      dispatchInput({ task: taskDeferredOn(), meters: EMPTY_METERS }),
    );
    const unknownHeadroom = decideDispatch(
      dispatchInput({
        task: taskAtStage('implementing', {
          gates: { requireHeadroom: { meterId: 'endpoint:weekly_all', pct: 30 } },
        }),
        meters: EMPTY_METERS,
      }),
    );
    // Same missing meter, same instant, two different decisions — on purpose.
    expect(unknownReset.action).toBe('defer');
    expect(unknownHeadroom.action).toBe('refuse');
  });
});

// ─── 7. check order, with conditions STACKED ─────────────────────────────────

describe('check order — the FIRST reason in the documented order wins', () => {
  // Every case below violates SEVERAL conditions at once; only the stacking
  // makes the order assertable (a case with one violation would pass under any
  // ordering).
  const staleMeter = meterRecord({ percent: 99, observedAt: '2026-07-22T09:00:00.000Z' });
  const exhaustedMeter = meterRecord({ percent: 99, resetsAt: LATER_ISO });
  const allGates = {
    deferUntilReset: 'endpoint:session',
    requireHeadroom: { meterId: 'endpoint:session', pct: 50 },
  };

  it('non-dispatchable stage + live run + future reset + failing headroom → stage-not-dispatchable', () => {
    for (const stage of NON_DISPATCHABLE_TASK_STAGES) {
      expect(
        decideDispatch(
          dispatchInput({
            task: taskAtStage(stage, { gates: allGates }),
            meters: metersStateWith(exhaustedMeter),
            hasLiveRun: true,
          }),
        ),
      ).toEqual({ action: 'refuse', reason: 'stage-not-dispatchable' });
    }
  });

  it('live run + future reset + failing headroom → already-running', () => {
    expect(
      decideDispatch(
        dispatchInput({
          task: taskAtStage('planning', { gates: allGates }),
          meters: metersStateWith(exhaustedMeter),
          hasLiveRun: true,
        }),
      ),
    ).toEqual({ action: 'refuse', reason: 'already-running' });
  });

  it('future reset + failing headroom → awaiting-meter-reset (defer beats the headroom refusal)', () => {
    expect(
      decideDispatch(
        dispatchInput({
          task: taskAtStage('planning', { gates: allGates }),
          meters: metersStateWith(exhaustedMeter),
        }),
      ),
    ).toEqual({ action: 'defer', reason: 'awaiting-meter-reset', meterId: 'endpoint:session' });
  });

  it('unknown reset time + unknown headroom → reset-time-unknown (defer beats the refusal)', () => {
    expect(
      decideDispatch(
        dispatchInput({ task: taskAtStage('planning', { gates: allGates }), meters: EMPTY_METERS }),
      ),
    ).toEqual({ action: 'defer', reason: 'reset-time-unknown', meterId: 'endpoint:session' });
  });

  it('reset satisfied + stale meter → headroom-unknown (the last check finally speaks)', () => {
    expect(
      decideDispatch(
        dispatchInput({
          task: taskAtStage('planning', { gates: allGates }),
          meters: metersStateWith({ ...staleMeter, resetsAt: '2026-07-22T06:00:00.000Z' }),
        }),
      ),
    ).toMatchObject({ action: 'refuse', reason: 'headroom-unknown' });
  });
});

// ─── the I10 EXHAUSTIVE MATRIX ───────────────────────────────────────────────
//
// The load-bearing assertion, and the reason this file enumerates rather than
// samples. Every combination of (stage × liveness × defer gate × meter shape ×
// clock) is run, and for EVERY one of them:
//
//   • if a requireHeadroom gate is present and `evaluateHeadroomGate` does not
//     return 'pass', the decision is NEVER 'spawn'; and
//   • whenever the decision IS 'spawn', either there was no gate or the gate
//     verdict was exactly 'pass'.
//
// The second half is the stronger statement: it is I10 read backwards, and it
// holds over the whole matrix rather than over the cases we thought to name.

describe('I10 — no input can produce spawn when the headroom gate does not pass', () => {
  const gatedMeterId = 'endpoint:session';
  const headroomGate = { meterId: gatedMeterId, pct: 40 };

  // Meter shapes chosen so the gate verdict spans pass / fail / all three
  // unknown reasons, plus the boundary on either side.
  const meterShapes: Array<{ label: string; meters: MetersState }> = [
    { label: 'absent', meters: EMPTY_METERS },
    { label: 'fresh 0%', meters: metersStateWith(meterRecord({ percent: 0 })) },
    { label: 'fresh 59% (just above the bar)', meters: metersStateWith(meterRecord({ percent: 59 })) },
    { label: 'fresh 60% (exactly the bar)', meters: metersStateWith(meterRecord({ percent: 60 })) },
    { label: 'fresh 61% (just below the bar)', meters: metersStateWith(meterRecord({ percent: 61 })) },
    { label: 'fresh 100%', meters: metersStateWith(meterRecord({ percent: 100 })) },
    { label: 'fresh 130% (over the cap)', meters: metersStateWith(meterRecord({ percent: 130 })) },
    { label: 'percent null', meters: metersStateWith(meterRecord({ percent: null })) },
    {
      label: 'stale',
      meters: metersStateWith(meterRecord({ percent: 1, observedAt: '2026-07-22T08:00:00.000Z' })),
    },
    {
      label: 'unparseable observedAt',
      meters: metersStateWith(meterRecord({ percent: 1, observedAt: '' })),
    },
    {
      label: 'fresh 0% with a future reset',
      meters: metersStateWith(meterRecord({ percent: 0, resetsAt: LATER_ISO })),
    },
    {
      label: 'fresh 99% with a past reset',
      meters: metersStateWith(meterRecord({ percent: 99, resetsAt: '2026-07-22T06:00:00.000Z' })),
    },
  ];

  const deferGateChoices = [undefined, gatedMeterId, 'meter-that-was-never-observed'];
  const clockChoices = [NOW_ISO, LATER_ISO, 'not-a-timestamp'];

  function everyDecision(): Array<{
    label: string;
    decision: DispatchDecision;
    input: DispatchInput;
    hasHeadroomGate: boolean;
  }> {
    const rows: Array<{
      label: string;
      decision: DispatchDecision;
      input: DispatchInput;
      hasHeadroomGate: boolean;
    }> = [];
    for (const stage of TASK_STAGES) {
      for (const hasLiveRun of [false, true]) {
        for (const deferUntilReset of deferGateChoices) {
          for (const hasHeadroomGate of [false, true]) {
            for (const meterShape of meterShapes) {
              for (const nowIso of clockChoices) {
                const input = dispatchInput({
                  task: taskAtStage(stage, {
                    gates: {
                      ...(deferUntilReset === undefined ? {} : { deferUntilReset }),
                      ...(hasHeadroomGate ? { requireHeadroom: headroomGate } : {}),
                    },
                  }),
                  meters: meterShape.meters,
                  nowIso,
                  hasLiveRun,
                });
                rows.push({
                  label: `${stage} live=${hasLiveRun} defer=${String(deferUntilReset)} gate=${hasHeadroomGate} meter=${meterShape.label} now=${nowIso}`,
                  decision: decideDispatch(input),
                  input,
                  hasHeadroomGate,
                });
              }
            }
          }
        }
      }
    }
    return rows;
  }

  const allRows = everyDecision();

  it('the matrix is non-vacuous — it actually reaches spawn, defer and every refusal', () => {
    const actions = new Set(allRows.map((row) => row.decision.action));
    expect([...actions].sort()).toEqual(['defer', 'refuse', 'spawn']);
    const refuseReasons = new Set(
      allRows.flatMap((row) => (row.decision.action === 'refuse' ? [row.decision.reason] : [])),
    );
    const deferReasons = new Set(
      allRows.flatMap((row) => (row.decision.action === 'defer' ? [row.decision.reason] : [])),
    );
    // Every reason in the exported vocabulary is exercised by the matrix.
    expect([...refuseReasons].sort()).toEqual([...dispatchRefuseReasonSchema.options].sort());
    expect([...deferReasons].sort()).toEqual([...dispatchDeferReasonSchema.options].sort());
    // And it is a real cross product, not a handful of cases.
    expect(allRows.length).toBe(
      TASK_STAGES.length * 2 * deferGateChoices.length * 2 * meterShapes.length * clockChoices.length,
    );
  });

  it('NEVER spawns when a present headroom gate does not evaluate to pass', () => {
    let gateNotPassRows = 0;
    for (const row of allRows) {
      if (!row.hasHeadroomGate) {
        continue;
      }
      const verdict = evaluateHeadroomGate(
        headroomGate,
        row.input.meters,
        row.input.nowIso,
        row.input.staleAfterMs,
      ).verdict;
      if (verdict === 'pass') {
        continue;
      }
      gateNotPassRows += 1;
      expect(row.decision.action, `spawned against a non-passing gate: ${row.label}`).not.toBe(
        'spawn',
      );
    }
    // Guard against the assertion above passing vacuously.
    expect(gateNotPassRows).toBeGreaterThan(0);
  });

  it('READ BACKWARDS: every spawn in the matrix had no gate, or a passing gate', () => {
    let spawnRows = 0;
    for (const row of allRows) {
      if (row.decision.action !== 'spawn') {
        continue;
      }
      spawnRows += 1;
      if (!row.hasHeadroomGate) {
        continue;
      }
      const gateResult = evaluateHeadroomGate(
        headroomGate,
        row.input.meters,
        row.input.nowIso,
        row.input.staleAfterMs,
      );
      expect(gateResult.verdict, `spawned on verdict ${gateResult.verdict}: ${row.label}`).toBe(
        'pass',
      );
    }
    expect(spawnRows).toBeGreaterThan(0);
  });

  it('a gated task never spawns on ANY meter percent below the bar (0..100 sweep)', () => {
    // The gate asks for 40 points of headroom, so anything above 60% used must
    // refuse — swept rather than sampled at the boundary.
    for (let observedPercent = 0; observedPercent <= 100; observedPercent += 1) {
      const decision = decideDispatch(
        dispatchInput({
          task: taskAtStage('implementing', { gates: { requireHeadroom: headroomGate } }),
          meters: metersStateWith(meterRecord({ percent: observedPercent })),
        }),
      );
      if (observedPercent <= 60) {
        expect(decision, `expected spawn at ${observedPercent}%`).toEqual({
          action: 'spawn',
          stage: 'implementing',
          isolation: 'worktree',
        });
      } else {
        expect(decision, `expected refusal at ${observedPercent}%`).toMatchObject({
          action: 'refuse',
          reason: 'headroom-insufficient',
        });
      }
    }
  });
});

// ─── 8. purity / determinism / no clock ──────────────────────────────────────

describe('purity and determinism', () => {
  const gatedTask = taskAtStage('implementing', {
    gates: {
      deferUntilReset: 'endpoint:session',
      requireHeadroom: { meterId: 'endpoint:session', pct: 30 },
    },
  });
  const meters = metersStateWith(meterRecord({ percent: 20, resetsAt: LATER_ISO }));

  it('does not mutate a deep-frozen input', () => {
    const frozenInput = deepFreeze(dispatchInput({ task: gatedTask, meters }));
    const snapshotBefore = JSON.stringify(frozenInput);
    expect(() => decideDispatch(frozenInput)).not.toThrow();
    expect(JSON.stringify(frozenInput)).toBe(snapshotBefore);
  });

  it('is deterministic — the same inputs always produce the same decision', () => {
    const input = dispatchInput({ task: gatedTask, meters });
    const decisions = [
      decideDispatch(input),
      decideDispatch(input),
      // A structurally-equal but distinct input object decides identically:
      // nothing is keyed on object identity or insertion order.
      decideDispatch(dispatchInput({ task: { ...gatedTask }, meters: { ...meters } })),
    ];
    for (const decision of decisions) {
      expect(decision).toEqual(decisions[0]);
    }
  });

  it('reads no clock — only the injected nowIso moves a time-dependent outcome', () => {
    // Ungated: the decision is clock-INDEPENDENT, so both instants agree.
    const ungated = taskAtStage('review');
    expect(decideDispatch(dispatchInput({ task: ungated, nowIso: NOW_ISO }))).toEqual(
      decideDispatch(dispatchInput({ task: ungated, nowIso: LATER_ISO })),
    );

    // Gated on a reset at 18:00: deferred at 12:00, satisfied at 18:00 —
    // the ONLY thing that changed is the parameter.
    const deferTask = taskAtStage('review', { gates: { deferUntilReset: 'endpoint:session' } });
    const deferMeters = metersStateWith(meterRecord({ resetsAt: LATER_ISO, observedAt: NOW_ISO }));
    expect(
      decideDispatch(dispatchInput({ task: deferTask, meters: deferMeters, nowIso: NOW_ISO })),
    ).toMatchObject({ action: 'defer', reason: 'awaiting-meter-reset' });
    expect(
      decideDispatch(dispatchInput({ task: deferTask, meters: deferMeters, nowIso: LATER_ISO })),
    ).toMatchObject({ action: 'spawn' });

    // Headroom gate: fresh (spawn) at 12:00, stale (refuse) six hours later.
    const headroomTask = taskAtStage('review', {
      gates: { requireHeadroom: { meterId: 'endpoint:session', pct: 30 } },
    });
    const headroomMeters = metersStateWith(meterRecord({ percent: 10, observedAt: NOW_ISO }));
    expect(
      decideDispatch(
        dispatchInput({ task: headroomTask, meters: headroomMeters, nowIso: NOW_ISO }),
      ),
    ).toMatchObject({ action: 'spawn' });
    expect(
      decideDispatch(
        dispatchInput({ task: headroomTask, meters: headroomMeters, nowIso: LATER_ISO }),
      ),
    ).toMatchObject({ action: 'refuse', reason: 'headroom-unknown' });
  });

  it('staleAfterMs is a required caller-supplied band, and it changes the verdict', () => {
    const headroomTask = taskAtStage('review', {
      gates: { requireHeadroom: { meterId: 'endpoint:session', pct: 30 } },
    });
    const meters30MinOld = metersStateWith(
      meterRecord({ percent: 10, observedAt: '2026-07-22T11:30:00.000Z' }),
    );
    expect(
      decideDispatch(
        dispatchInput({ task: headroomTask, meters: meters30MinOld, staleAfterMs: STALE_AFTER_MS }),
      ),
    ).toMatchObject({ action: 'refuse', reason: 'headroom-unknown' });
    expect(
      decideDispatch(
        dispatchInput({
          task: headroomTask,
          meters: meters30MinOld,
          staleAfterMs: 60 * 60 * 1000,
        }),
      ),
    ).toMatchObject({ action: 'spawn' });
  });
});

// ─── 9. the refusal is representable in the EXISTING dispatch_refused event ──

describe('refusals are recordable as dispatch_refused (I10 evidence)', () => {
  it('every refuse reason validates in the reserved payload, via a REAL refusal', () => {
    const realRefusals: DispatchDecision[] = [
      decideDispatch(dispatchInput({ task: taskAtStage('done') })),
      decideDispatch(dispatchInput({ task: taskAtStage('implementing'), hasLiveRun: true })),
      decideDispatch(
        dispatchInput({
          task: taskAtStage('implementing', {
            gates: { requireHeadroom: { meterId: 'endpoint:session', pct: 30 } },
          }),
          meters: metersStateWith(meterRecord({ percent: 95 })),
        }),
      ),
      decideDispatch(
        dispatchInput({
          task: taskAtStage('implementing', {
            gates: { requireHeadroom: { meterId: 'endpoint:session', pct: 30 } },
          }),
          meters: EMPTY_METERS,
        }),
      ),
    ];

    const observedReasons: string[] = [];
    for (const decision of realRefusals) {
      expect(decision.action).toBe('refuse');
      if (decision.action !== 'refuse') {
        continue;
      }
      observedReasons.push(decision.reason);
      const event = dispatchRefused({ taskId: 'task-1', reason: decision.reason });
      expect(event.stream).toBe('tasks');
      expect(event.type).toBe(EVENT_TYPES.dispatchRefused);
      expect(dispatchRefusedPayloadSchema.safeParse(event.payload).success).toBe(true);
      expect(
        EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.dispatchRefused].safeParse(event.payload).success,
      ).toBe(true);
    }
    // All four reasons, produced by real decisions rather than typed in.
    expect(observedReasons.sort()).toEqual([...dispatchRefuseReasonSchema.options].sort());
  });

  it('the reserved event shape is untouched by this step', () => {
    expect(EVENT_TYPES.dispatchRefused).toBe('dispatch_refused');
    expect(
      dispatchRefusedPayloadSchema.safeParse({ taskId: 'task-1', reason: 'headroom-unknown' })
        .success,
    ).toBe(true);
  });
});
