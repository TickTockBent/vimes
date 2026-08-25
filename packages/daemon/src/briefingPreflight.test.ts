import { describe, expect, it } from 'vitest';
import {
  DISPATCHABLE_TASK_STAGES,
  MemoryArtifactStore,
  resolveStageRunner,
  type ArtifactStore,
  type EventInput,
  type MetersState,
  type ParsedWorkflow,
  type StageRunnerPlan,
  type TaskRecord,
  type TaskStage,
  type TasksState,
} from '@vimes/core';
import {
  briefingComposers,
  composeStageInstruction,
  type BriefingComposer,
  type BriefingInputs,
  type StageInstructionContext,
} from '@vimes/ext-tasks';

import { loadShippedWorkflow } from './shippedManifest.js';
import {
  TaskDispatcher,
  type DispatchAttemptResult,
  type TaskDispatcherDeps,
} from './taskDispatcher.js';
import {
  BRIEFING_PREFLIGHT_SUB_REASONS,
  briefingUnresolvableReason,
  preflightBriefing,
  taskBriefingInputReads,
  type BriefingPreflightResult,
  type BriefingPreflightSubReason,
} from './briefingPreflight.js';
import { ENGINE_REPORT_TOOL_SERVER } from './briefingDeclarations.js';

// ─── S19·U3 — THE DIFFERENTIAL UNIT, FROZEN AND FLIPPED (slice-19 §3.5/§3.6/§3.7, A2–A5) ─
//
// ⚠ **WHAT THIS FILE IS FOR, IN ONE SENTENCE.** slice-19 replaces three compiled
// switches — the dispatcher's `plan`/`auto` selection, the session host's
// stage→report-tools derivation, and its mode-keyed plan-capture arming — with
// readings of a TENANT DECLARATION. Move 3's choreography: differential BESIDE
// (S19·U2) → FREEZE it → flip → delete. U3 did all three of the last steps, in
// that order, and the freeze happened FIRST, before either compiled switch was
// touched (see the FROZEN IMAGES section below for the evidence and the
// provenance).
//
// The four differential dimensions (A2), each asserted per DISPATCHABLE stage:
//
//   briefing bytes  ·  tool ids  ·  permission footing  ·  capture arming
//
// **Briefing bytes stay LIVE** — `compiledBriefingFor` below calls
// `composeStageInstruction` DIRECTLY (the prose module survives S19·U3 whole;
// only the compiled switches AROUND it are deleted), so this dimension is still
// a real two-path comparison and not a frozen literal.
//
// **Tool ids, permission footing and capture arming are FROZEN.** All three were
// derived from code THIS UNIT deletes — the dispatcher's `stage === 'planning'`
// switch and the session host's stage→ids switch / mode-keyed arming — so
// deriving them live is no longer possible once the flip lands. Move 3's
// precedent (S12·U3, `FROZEN_COMPILED_EDGE_SET` in core's `manifest.test.ts`)
// is the idiom: capture the compiled image ONE LAST TIME, freeze it as a
// literal with its provenance, and let the guard survive its reference's death.
// A red against a frozen image is a finding about the DECLARED path, never
// license to "update the freeze to match".

const SHIPPED = loadShippedWorkflow().workflow;
const DISPATCHABLE: readonly TaskStage[] = [...DISPATCHABLE_TASK_STAGES];

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const TASK_ID = 'task-s19-u2-000000000001';
const SPAWNED_SESSION_ID = 'cccccccc-0000-4000-8000-00000000000a';
const FIXED_NOW = '2026-08-25T12:00:00.000Z';
const PLAN_HASH = 'b'.repeat(64);
const PLAN_TEXT = 'Step 1. Read the declaration.\nStep 2. Compose from it.';

// ── task fixtures ────────────────────────────────────────────────────────────
//
// FOUR populations per stage, and the last three exist because the first one
// cannot fail: a bare task carries no plan and no seed, so the projection has
// nothing to remove and the declared/compiled input sets are trivially the same.
// The plan-bearing and fix-seed variants are where §3.2's projection and §3.5's
// assembly actually do work — and where planning/review's `inputs =
// ["instance.record"]` diverges from the compiled path's unconditional context.

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    title: 'Teach dispatch to read the declaration',
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'shared-dir',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

const REVIEW_PAYLOAD: NonNullable<TaskRecord['lastReview']> = {
  taskId: TASK_ID,
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  criteria: [
    { criterionId: 'ac-1', verdict: 'fail', note: 'the declaration is still not read' },
    { criterionId: 'ac-2', verdict: 'pass' },
  ],
};

const COMPLETION_PAYLOAD: NonNullable<TaskRecord['lastCompletion']> = {
  taskId: TASK_ID,
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  worklog: {
    decisionsMade: ['read the boot declaration, not the manifest file'],
    pathsRejected: ['a second parse at dispatch time'],
  },
};

const WORK_ORDER: Partial<TaskRecord> = {
  scope: 'Make dispatch read the briefing declaration.',
  explicitlyOut: ['Do not flip anything in U2.'],
  acceptanceCriteria: [
    { id: 'ac-1', text: 'The declared path composes the same bytes.' },
    { id: 'ac-2', text: 'Nothing spawns on a refusal.' },
  ],
  killCriterion: 'a declared node cannot reproduce compiled behaviour byte-exactly.',
  workOrderRev: 1,
};

interface Population {
  readonly name: string;
  readonly overrides: Partial<TaskRecord>;
}

const POPULATIONS: readonly Population[] = [
  { name: 'bare (no work order, no plan, no seed)', overrides: {} },
  { name: 'work-order only', overrides: { ...WORK_ORDER } },
  {
    name: 'plan-bearing (the approved plan is in the store)',
    overrides: { ...WORK_ORDER, planArtifactHash: PLAN_HASH },
  },
  {
    name: 'fix-seed (a failed review AND the prior attempt’s worklog)',
    overrides: { ...WORK_ORDER, lastReview: REVIEW_PAYLOAD, lastCompletion: COMPLETION_PAYLOAD },
  },
  {
    name: 'fully populated (plan AND fix-seed — every excluded field present)',
    overrides: {
      ...WORK_ORDER,
      planArtifactHash: PLAN_HASH,
      lastReview: REVIEW_PAYLOAD,
      lastCompletion: COMPLETION_PAYLOAD,
    },
  },
];

/** A store holding the one plan blob every plan-bearing fixture points at. */
function planStore(): ArtifactStore {
  const store = new MemoryArtifactStore();
  store.put(PLAN_TEXT, {
    kind: 'plan',
    taskRef: { taskId: TASK_ID, stage: 'planning' },
    rev: 1,
    createdBy: { appSessionId: SPAWNED_SESSION_ID },
    createdAt: FIXED_NOW,
  });
  // The fixtures name a FIXED hash rather than the content hash the store
  // computed, so the lookup is pinned to one blob regardless of the prose.
  const realGetBlob = store.getBlob.bind(store);
  store.getBlob = (hash: string) => (hash === PLAN_HASH ? PLAN_TEXT : realGetBlob(hash));
  return store;
}
// ── the shape a spawn recorded, still needed by A4/A7's real dispatchers ──────

interface RecordedSpawn {
  channel: 'sdk' | 'pty';
  cwd: string;
  name?: string;
  permissionMode?: 'plan' | 'auto';
  dispatched?: boolean;
  stage?: TaskStage;
  reportToolIds?: readonly string[];
  planCaptureArmed?: boolean;
}

// ── the COMPILED briefing BYTES, derived LIVE from the surviving prose module ─
//
// ⚠ **PART A OF THE FLIP, DONE FIRST: THIS IS WHAT "MAY STAY DERIVED FROM
// `composeStageInstruction`" MEANS IN CODE.** Through S19·U2 this file's
// "compiled" comparison ran a REAL `TaskDispatcher`, which composed
// POST-spawn inside `deliverStageInstruction` — fetching the plan blob,
// threading the fix-seed, calling `composeStageInstruction`. S19·U3 deletes
// ALL of that from the dispatcher (composition moved to the preflight, which is
// what this file's `declaredRun` already exercises), so there is no dispatcher
// call left that can reproduce these bytes. This helper is the "compiled" half
// of the comparison NOW: it transcribes `deliverStageInstruction`'s pre-flip
// context-assembly VERBATIM (same degrade rules — absent hash → no fetch; null
// blob → absent; throwing store → absent; fix-seed read straight off the
// record, no I/O) and calls the SAME `composeStageInstruction` the declared
// path's composer wrappers call — so the differential stays a REAL two-path
// proof: two different roads to the one surviving prose module, not one road
// compared against a frozen echo of itself.
function compiledBriefingFor(task: TaskRecord, artifactStore: ArtifactStore): string {
  let planBlobText: string | undefined;
  if (task.planArtifactHash !== undefined) {
    try {
      const planBlob = artifactStore.getBlob(task.planArtifactHash);
      planBlobText = planBlob === null ? undefined : planBlob;
    } catch {
      planBlobText = undefined;
    }
  }
  const reviewFeedback = task.lastReview?.criteria;
  const worklog = task.lastCompletion?.worklog;
  const instructionContext: StageInstructionContext = {
    ...(planBlobText === undefined ? {} : { plan: planBlobText }),
    ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
    ...(worklog === undefined ? {} : { worklog }),
  };
  const planContext: StageInstructionContext | undefined =
    Object.keys(instructionContext).length === 0 ? undefined : instructionContext;
  const plan: StageRunnerPlan = resolveStageRunner(task);
  return composeStageInstruction(task, plan, planContext) ?? '';
}

// ── FROZEN IMAGES — the three dimensions derived from the DELETED code ────────
//
// ⚠ **CAPTURED 2026-08-25, BEFORE ANY DELETION, AGAINST `taskDispatcher.ts` +
// `sessionHost.ts` @ COMMIT `105b5ea`** (S19·U2 HEAD — the last commit where
// the dispatcher's `stage === 'planning'` switch and the session host's
// stage→ids switch / mode-keyed capture arming still existed and ran in
// production). Derivation method, run ONE LAST TIME before the flip: a REAL
// `TaskDispatcher` (the compiled path — `composeStageInstruction` wired, NO
// `preflightBriefing`) dispatched one task per dispatchable stage; the recorded
// `spawnOptions.permissionMode` is the footing image; `spawnOptions.permissionMode
// === 'plan'` is the capture-arming image — recon fact 9's coupling, captured
// exactly as it stood; the tool ids were EXTRACTED by spawning those SAME
// `spawnOptions` into a REAL `SessionHost` and reading `SdkQueryOptions.reportTools`
// back through the exported `buildReportMcpServers` (S19·U2's own extraction
// method, run one final time — see U2's checkpoint for the harness). The three
// JSON lines this produced, transcribed verbatim as this file's new source of
// truth:
//
//   {"stage":"planning","permissionMode":"plan","toolIds":[],"planCaptureArmed":true}
//   {"stage":"implementing","permissionMode":"auto","toolIds":["vimes_report.report_completion"],"planCaptureArmed":false}
//   {"stage":"review","permissionMode":"auto","toolIds":["vimes_report.report_review"],"planCaptureArmed":false}
//
// ⚠ **NOTHING HERE MAY BE "UPDATED TO MATCH" A DECLARATION CHANGE.** A red
// against one of these three maps is a finding about the DECLARED path (or a
// real, deliberate, signed change to what the engine footings/mounts/arms) —
// never license to edit the freeze until it passes.
const FROZEN_PERMISSION_FOOTING_BY_STAGE: Partial<Record<TaskStage, 'plan' | 'auto'>> = {
  planning: 'plan',
  implementing: 'auto',
  review: 'auto',
};
const FROZEN_TOOL_IDS_BY_STAGE: Partial<Record<TaskStage, readonly string[]>> = {
  planning: [],
  implementing: ['vimes_report.report_completion'],
  review: ['vimes_report.report_review'],
};
const FROZEN_PLAN_CAPTURE_ARMED_BY_STAGE: Partial<Record<TaskStage, boolean>> = {
  planning: true,
  implementing: false,
  review: false,
};

function declaredRun(
  task: TaskRecord,
  artifactStore: ArtifactStore,
  overrides: {
    workflow?: ParsedWorkflow;
    composers?: Readonly<Record<string, BriefingComposer>>;
  } = {},
): BriefingPreflightResult {
  return preflightBriefing(task, {
    workflow: overrides.workflow ?? SHIPPED,
    composers: overrides.composers ?? briefingComposers,
    artifactStore,
  });
}

// ── test-local declarations (§3.7's perturbation cells, A4's refusals) ───────
//
// ⚠ **PERTURBED IN MEMORY, NEVER IN THE SHIPPED MANIFEST.** The shipped file is
// the daemon's boot asset and is out of this unit's touch list; every cell below
// is a copy of the boot-resolved workflow with ONE node's declaration bent. That
// also keeps the perturbations honest: they are built from the real declaration,
// so a cell cannot accidentally test a workflow that no longer resembles the one
// production boots on.

type DeclaredNode = ParsedWorkflow['nodes'][number];
type DeclaredBriefing = NonNullable<DeclaredNode['briefing']>;

function perturbed(
  nodeId: string,
  patch: {
    readonly briefing?: Partial<DeclaredBriefing>;
    readonly dropBriefing?: true;
    readonly permissionMode?: DeclaredNode['properties']['permissionMode'];
  },
): ParsedWorkflow {
  return {
    ...SHIPPED,
    nodes: SHIPPED.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const { briefing, ...withoutBriefing } = node;
      const properties =
        patch.permissionMode === undefined
          ? node.properties
          : { ...node.properties, permissionMode: patch.permissionMode };
      if (patch.dropBriefing === true) {
        return { ...withoutBriefing, properties };
      }
      const base: DeclaredBriefing = briefing ?? {
        composer: 'briefings/generic',
        inputs: [],
        tools: [],
        capture: [],
      };
      return { ...withoutBriefing, properties, briefing: { ...base, ...patch.briefing } };
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PART C — A2: the differential, per dispatchable stage
// ═════════════════════════════════════════════════════════════════════════════

describe('S19-A2 — declared ≡ compiled, over the DISPATCHABLE domain', () => {
  it('the domain is read from DISPATCHABLE_TASK_STAGES, not copied', () => {
    // If a fourth stage becomes dispatchable, every cell below multiplies with
    // it automatically — and this assertion is what says so out loud.
    expect(DISPATCHABLE).toHaveLength(3);
    expect([...DISPATCHABLE].sort()).toEqual(['implementing', 'planning', 'review']);
  });

  const CELLS = DISPATCHABLE.flatMap((stage) =>
    POPULATIONS.map((population) => ({ stage, population })),
  );

  it.each(CELLS.map((cell) => [`${cell.stage} · ${cell.population.name}`, cell] as const))(
    'BRIEFING BYTES are identical — %s',
    (_label, cell) => {
      const task = taskRecord({ stage: cell.stage, ...cell.population.overrides });
      // LIVE, not frozen — see `compiledBriefingFor`'s own note.
      const compiled = compiledBriefingFor(task, planStore());
      const declared = declaredRun(task, planStore());

      expect(declared.ok).toBe(true);
      if (!declared.ok) return;
      // BYTE-IDENTICAL, asserted on the string itself. Not `toMatch`, not a
      // prefix, not a normalised comparison — the whole claim is that the
      // declaration path can replace the compiled one without the model seeing
      // a single different character (cache discipline included).
      expect(declared.composed).toBe(compiled);
      expect(declared.composed.length).toBeGreaterThan(0);
    },
  );

  // The four fixtures must actually produce DIFFERENT briefings for at least one
  // stage, or the cells above would be five copies of one comparison. This is
  // the same guard `dispatchBriefingStem.test.ts` keeps over its variant table.
  it('the populations really do compose differently (the cells are not five copies)', () => {
    const composed = POPULATIONS.map((population) =>
      compiledBriefingFor(taskRecord({ stage: 'implementing', ...population.overrides }), planStore()),
    );
    expect(new Set(composed).size).toBe(POPULATIONS.length);
  });

  it.each([...DISPATCHABLE])('TOOL IDS are identical — %s', (stage) => {
    const task = taskRecord({ stage, ...WORK_ORDER });
    const declared = declaredRun(task, planStore());

    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    // FROZEN, not live — see the FROZEN IMAGES section's provenance. The
    // stage→ids switch this used to extract from a real `SessionHost` is gone.
    expect([...declared.toolIds]).toEqual(FROZEN_TOOL_IDS_BY_STAGE[stage]);
    // …and the ids really are server-qualified, which is what §3.6 puts across
    // the seam. A bare tool name would compare equal to nothing here.
    for (const toolId of declared.toolIds) {
      expect(toolId.startsWith(`${ENGINE_REPORT_TOOL_SERVER}.`)).toBe(true);
    }
  });

  // Verify-by-breaking for the tool dimension: the three stages must not all
  // mount the same thing, or "identical" above would be satisfied by a constant.
  it('the three stages really do mount three different tool sets', () => {
    const perStage = DISPATCHABLE.map(
      (stage) => (FROZEN_TOOL_IDS_BY_STAGE[stage] ?? []).join('|'),
    );
    expect(new Set(perStage).size).toBe(3);
  });

  it.each([...DISPATCHABLE])('PERMISSION FOOTING is identical — %s', (stage) => {
    const task = taskRecord({ stage, ...WORK_ORDER });
    const declared = declaredRun(task, planStore());

    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    // FROZEN: the compiled footing was whatever the dispatcher's own
    // `plan`/`auto` switch put on the spawn options — that switch is deleted;
    // this is its last recorded image (see FROZEN IMAGES).
    expect(declared.permissionFooting).toBe(FROZEN_PERMISSION_FOOTING_BY_STAGE[stage]);
  });

  it.each([...DISPATCHABLE])('CAPTURE ARMING is identical — %s', (stage) => {
    const task = taskRecord({ stage, ...WORK_ORDER });
    const declared = declaredRun(task, planStore());

    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    // FROZEN: TODAY the two agreed on every shipped node, because the shipped
    // manifest correlates `permission_mode = "plan"` with `capture = ["plan"]`
    // — recon fact 9's trap, frozen exactly as observed, and why the A5 cells
    // below exist: this assertion alone proves the flip was SAFE, not that the
    // mechanism changed.
    expect(declared.planCaptureArmed).toBe(FROZEN_PLAN_CAPTURE_ARMED_BY_STAGE[stage]);
  });

  it('the footing/capture dimensions are not constants either', () => {
    const footings = DISPATCHABLE.map((stage) => FROZEN_PERMISSION_FOOTING_BY_STAGE[stage]);
    expect(new Set(footings)).toEqual(new Set(['plan', 'auto']));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — A3: disjointness + the allow-list, observed at the composer
// ═════════════════════════════════════════════════════════════════════════════

describe('S19-A3 — a spy composer receives EXACTLY the declared kinds', () => {
  /** A composer table whose entries record what they were handed and return a marker. */
  function spyTable(): {
    readonly composers: Record<string, BriefingComposer>;
    readonly handed: BriefingInputs[];
  } {
    const handed: BriefingInputs[] = [];
    const composers: Record<string, BriefingComposer> = {};
    for (const entryPoint of Object.keys(briefingComposers)) {
      composers[entryPoint] = (inputs) => {
        handed.push(inputs);
        return `SPY:${entryPoint}`;
      };
    }
    return { composers, handed };
  }

  /**
   * A task whose three EXCLUDED fields are accessor properties that COUNT their
   * reads. §3.2's claim is about the READ, not about the field list — "an
   * undeclared kind is not merely dropped from the set, its read is never
   * invoked" — so counting the property access is the only assertion that
   * actually measures it. A record built with plain values could not tell an
   * unread field from an unhanded one.
   */
  function countingTask(stage: TaskStage): {
    readonly task: TaskRecord;
    readonly reads: () => Record<'planArtifactHash' | 'lastReview' | 'lastCompletion', number>;
  } {
    const counts = { planArtifactHash: 0, lastReview: 0, lastCompletion: 0 };
    const base = taskRecord({ stage, ...WORK_ORDER });
    const task = Object.defineProperties({ ...base }, {
      planArtifactHash: {
        enumerable: true,
        get: () => {
          counts.planArtifactHash += 1;
          return PLAN_HASH;
        },
      },
      lastReview: {
        enumerable: true,
        get: () => {
          counts.lastReview += 1;
          return REVIEW_PAYLOAD;
        },
      },
      lastCompletion: {
        enumerable: true,
        get: () => {
          counts.lastCompletion += 1;
          return COMPLETION_PAYLOAD;
        },
      },
    }) as TaskRecord;
    return { task, reads: () => ({ ...counts }) };
  }

  it.each([...DISPATCHABLE])('%s: the handed set is exactly the declared rows', (stage) => {
    const { composers, handed } = spyTable();
    const { task } = countingTask(stage);
    const result = declaredRun(task, planStore(), { composers });

    expect(result.ok).toBe(true);
    expect(handed).toHaveLength(1);
    const inputs = handed[0]!;
    // `instance.record` is declared on all three nodes; the other three rows are
    // declared ONLY by `implementing` (recon fact 1 + the shipped manifest).
    const declaresReports = stage === 'implementing';
    expect('record' in inputs).toBe(true);
    expect('planText' in inputs).toBe(declaresReports);
    expect('lastReview' in inputs).toBe(declaresReports);
    expect('lastCompletion' in inputs).toBe(declaresReports);
  });

  it.each([...DISPATCHABLE])(
    '%s: the PROJECTED record excludes the three §3b fields — asserted on the VALUE',
    (stage) => {
      const { composers, handed } = spyTable();
      const { task } = countingTask(stage);
      declaredRun(task, planStore(), { composers });

      const record = handed[0]?.record;
      expect(record).toBeDefined();
      if (record === undefined) return;
      // ⚠ `in` on the handed OBJECT, not `toBeUndefined()` on a property: an
      // "absent" field that is present-and-undefined is a different fact and
      // different bytes, and rev 1's security claim was false precisely because
      // it was asserted at the wrong level.
      expect('lastReview' in record).toBe(false);
      expect('lastCompletion' in record).toBe(false);
      expect('planArtifactHash' in record).toBe(false);
      // …while the kept half really did arrive, so the projection is a
      // projection and not an emptying.
      expect(record.taskId).toBe(TASK_ID);
      expect(record.projectRoot).toBe(PROJECT_ROOT);
      expect(record.stage).toBe(stage);
      expect(record.scope).toBe(WORK_ORDER.scope);
    },
  );

  it.each(['planning', 'review'] as const)(
    '%s: the UNDECLARED reads are NEVER CALLED (the read, not the field list)',
    (stage) => {
      const { composers } = spyTable();
      const { task, reads } = countingTask(stage);
      const store = planStore();
      const blobReads: string[] = [];
      const realGetBlob = store.getBlob.bind(store);
      store.getBlob = (hash: string) => {
        blobReads.push(hash);
        return realGetBlob(hash);
      };

      declaredRun(task, store, { composers });

      // Neither report row is declared on these nodes, so neither folded field is
      // touched — and the artifact store is never consulted at all, because
      // `artifact:plan` is undeclared too.
      expect(reads()).toEqual({ planArtifactHash: 0, lastReview: 0, lastCompletion: 0 });
      expect(blobReads).toEqual([]);
    },
  );

  it('implementing: the DECLARED reads DO happen, exactly once each', () => {
    const { composers } = spyTable();
    const { task, reads } = countingTask('implementing');
    const store = planStore();
    const blobReads: string[] = [];
    const realGetBlob = store.getBlob.bind(store);
    store.getBlob = (hash: string) => {
      blobReads.push(hash);
      return realGetBlob(hash);
    };

    declaredRun(task, store, { composers });

    // The counter is what makes the two 'planning'/'review' zeros above mean
    // something: the same instrument, on the node that DOES declare the rows,
    // reads each one — so a zero is evidence of gating rather than of a broken
    // spy. `planArtifactHash` is read once by the guard and once by the fetch.
    const counts = reads();
    expect(counts.lastReview).toBe(1);
    expect(counts.lastCompletion).toBe(1);
    expect(counts.planArtifactHash).toBeGreaterThan(0);
    expect(blobReads).toEqual([PLAN_HASH]);
  });

  it('the real tenant composers are the ones production would resolve', () => {
    // The spy table above is keyed off `briefingComposers`, so this asserts the
    // spy's domain is the real domain rather than a hand-listed subset.
    expect(Object.keys(briefingComposers).sort()).toEqual([
      'briefings/generic',
      'briefings/implementing',
      'briefings/planning',
      'briefings/review',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — A4: every preflight refusal, and the three seams it must not touch
// ═════════════════════════════════════════════════════════════════════════════

describe('S19-A4 — preflight refusals: named, wire-stable, and side-effect-free', () => {
  interface RefusalCell {
    readonly reason: BriefingPreflightSubReason;
    readonly what: string;
    readonly workflow: ParsedWorkflow;
    readonly stage: TaskStage;
    readonly composers?: Readonly<Record<string, BriefingComposer>>;
  }

  const THROWING_TABLE: Readonly<Record<string, BriefingComposer>> = {
    'briefings/implementing': () => {
      throw new Error('the tenant composer refused the job');
    },
  };

  const CELLS: readonly RefusalCell[] = [
    {
      reason: 'composer-unresolvable',
      what: 'the declared entry point is not in the tenant table',
      workflow: perturbed('implementing', { briefing: { composer: 'briefings/nonexistent' } }),
      stage: 'implementing',
    },
    {
      reason: 'composer-unresolvable',
      what: 'the node declares NO briefing table at all',
      workflow: perturbed('implementing', { dropBriefing: true }),
      stage: 'implementing',
    },
    {
      reason: 'unknown-tool-id',
      what: 'a declared tool this engine cannot mount',
      workflow: perturbed('implementing', {
        briefing: { tools: ['vimes_report.report_completion', 'vimes_report.rm_rf'] },
      }),
      stage: 'implementing',
    },
    {
      reason: 'unknown-tool-id',
      what: 'a tool from ANOTHER family (the board verbs are not a stage-run grant)',
      workflow: perturbed('implementing', { briefing: { tools: ['vimes_board.create_task'] } }),
      stage: 'implementing',
    },
    {
      reason: 'invalid-capture-combo',
      what: 'capture declared WITHOUT plan mode',
      workflow: perturbed('implementing', { briefing: { capture: ['plan'] } }),
      stage: 'implementing',
    },
    {
      reason: 'unknown-artifact-id',
      what: 'an `artifact:` row this engine does not fetch',
      workflow: perturbed('review', {
        briefing: { inputs: ['instance.record', 'artifact:architecture-diagram'] },
      }),
      stage: 'review',
    },
    {
      reason: 'unknown-report-kind',
      what: 'a `report:` row this engine does not fold',
      workflow: perturbed('review', {
        briefing: { inputs: ['instance.record', 'report:last-lunch'] },
      }),
      stage: 'review',
    },
    {
      reason: 'unknown-input-kind',
      what: 'a manifest-legal `capture:` row with no engine assembler',
      workflow: perturbed('review', { briefing: { inputs: ['instance.record', 'capture:plan'] } }),
      stage: 'review',
    },
    {
      reason: 'compose-threw',
      what: 'the tenant composer threw',
      workflow: SHIPPED,
      stage: 'implementing',
      composers: THROWING_TABLE,
    },
  ];

  it('the cells cover EVERY member of the closed sub-reason vocabulary', () => {
    // Totality asserted against the exported list, so a seventh sub-reason
    // cannot land without a cell.
    expect(new Set(CELLS.map((cell) => cell.reason))).toEqual(
      new Set(BRIEFING_PREFLIGHT_SUB_REASONS),
    );
  });

  it.each(CELLS.map((cell) => [`${cell.reason} — ${cell.what}`, cell] as const))(
    'refuses with %s',
    (_label, cell) => {
      const task = taskRecord({ stage: cell.stage, ...WORK_ORDER, planArtifactHash: PLAN_HASH });
      const result = declaredRun(task, planStore(), {
        workflow: cell.workflow,
        ...(cell.composers === undefined ? {} : { composers: cell.composers }),
      });
      expect(result).toMatchObject({ ok: false, reason: cell.reason });
      // S19·U3 (briefingPreflight.ts signature adjustment): `compose-threw` is
      // the ONE reason that carries a logging-only `detail` — see the field's
      // own doc. Every other refusal reason carries none; the check IS its own
      // whole explanation.
      if (cell.reason === 'compose-threw') {
        expect(result).toMatchObject({ detail: 'the tenant composer refused the job' });
      } else {
        expect(result).not.toHaveProperty('detail');
      }
    },
  );

  // ═══ S19·U3 — Part B/D: THE END-TO-END REFUSAL CELL, THROUGH A REAL dispatchTask ═
  //
  // ⚠ **THROUGH S19·U2 THIS RAN `declaredRun` DIRECTLY AND `void`-DISCARDED THE
  // WIRED DISPATCHER** ("untouched" meant untouched on an object built for the
  // assertion but never actually driven). U3 is the flip: `dispatchTask` now
  // calls `preflightBriefing` itself, BEFORE `spawnStageRun`, so this is the
  // real thing — every refusal cell proven END-TO-END, through the SAME class
  // production drives, with NO worktree, NO spawn and NO event on any of them.
  it.each(CELLS.map((cell) => [`${cell.reason} — ${cell.what}`, cell] as const))(
    'refuses pre-worktree, end-to-end, through a REAL dispatchTask — %s',
    async (_label, cell) => {
      const emitted: EventInput[] = [];
      const spawnCalls: RecordedSpawn[] = [];
      const checkoutCreateCalls: unknown[] = [];
      const task = taskRecord({ stage: cell.stage, ...WORK_ORDER, planArtifactHash: PLAN_HASH });
      const store = planStore();
      const tasksState: TasksState = { tasks: { [task.taskId]: task } };

      const dispatcher = new TaskDispatcher({
        sessionHost: {
          spawnSession: (options) => {
            spawnCalls.push(options);
            return { appSessionId: SPAWNED_SESSION_ID };
          },
          isLive: () => false,
          sendMessage: () => ({ ok: true }),
        },
        composeStageInstruction,
        preflightBriefing: (candidate) =>
          declaredRun(candidate, store, {
            workflow: cell.workflow,
            ...(cell.composers === undefined ? {} : { composers: cell.composers }),
          }),
        emit: (events) => emitted.push(...events),
        readTasks: () => tasksState,
        readMeters: () => ({ meters: {}, history: {} }),
        nowIso: () => FIXED_NOW,
        staleAfterMs: 90_000,
        artifactStore: store,
        instanceWriter: { proposeMove: (taskId) => ({ outcome: 'unknown-task', taskId }) },
        checkoutCoordinator: {
          create: (request) => {
            checkoutCreateCalls.push(request);
            return Promise.resolve({
              outcome: 'refused',
              reason: 'the coordinator must never be reached by a preflight',
            } as never);
          },
        },
      });

      const result = await dispatcher.dispatchTask(task.taskId);

      // §3.5's wire-stable spelling — the EXISTING `spawn-failed` outcome, the
      // sub-reason carrying the precision. No new union member; the routes
      // serialize this verbatim (see the "surfaces as the EXISTING spawn-failed
      // outcome" case below for the compile-time half of the same proof).
      expect(result).toEqual({
        outcome: 'spawn-failed',
        taskId: task.taskId,
        reason: briefingUnresolvableReason(cell.reason),
      });
      expect(emitted).toEqual([]);
      expect(spawnCalls).toEqual([]);
      expect(checkoutCreateCalls).toEqual([]);
    },
  );

  it.each([...BRIEFING_PREFLIGHT_SUB_REASONS])(
    '%s surfaces as the EXISTING spawn-failed outcome — the union does not grow',
    (subReason) => {
      // ⚠ THE TYPE ANNOTATION IS THE ASSERTION. `DispatchAttemptResult` is what
      // the dispatch routes serialize verbatim (§3.5/§2), and this line only
      // compiles because a preflight refusal is expressible as a member that
      // ALREADY EXISTS. A new outcome for briefings would have to be added to the
      // union to make this file build — which is precisely the wire change slice
      // 19 forbids, caught at compile time rather than in review.
      const surfaced: DispatchAttemptResult = {
        outcome: 'spawn-failed',
        taskId: TASK_ID,
        reason: briefingUnresolvableReason(subReason),
      };
      expect(surfaced.outcome).toBe('spawn-failed');
      expect(surfaced).toMatchObject({ reason: `briefing-unresolvable:${subReason}` });
    },
  );

  it('the reason spelling is one prefix and one sub-reason, nothing more', () => {
    expect(briefingUnresolvableReason('compose-threw')).toBe(
      'briefing-unresolvable:compose-threw',
    );
    // No thrown message rides the WIRE: §3.5 pins the vocabulary, and a
    // tenant's exception text is neither a sub-reason nor switchable by any
    // consumer. It DOES ride as far as `detail` (S19·U3's logging-only field,
    // consumed only by the daemon's own log at the taskDispatcher.ts call
    // site) — this result IS the whole vocabulary, `detail` included.
    const threw = declaredRun(taskRecord({ stage: 'implementing', ...WORK_ORDER }), planStore(), {
      composers: THROWING_TABLE,
    });
    expect(threw).toEqual({
      ok: false,
      reason: 'compose-threw',
      detail: 'the tenant composer refused the job',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — A5: the §3.7 perturbation cells (where declaration and mode part)
// ═════════════════════════════════════════════════════════════════════════════

describe('S19-A5 — capture follows the DECLARATION, independently', () => {
  it('the SHIPPED corner: plan mode AND capture — armed', () => {
    const result = declaredRun(taskRecord({ stage: 'planning', ...WORK_ORDER }), planStore());
    expect(result).toMatchObject({
      ok: true,
      permissionFooting: 'plan',
      capture: ['plan'],
      planCaptureArmed: true,
    });
  });

  it('plan mode WITHOUT capture: the planner runs write-blocked and NOTHING is harvested', () => {
    // ⚠ THE CELL THE SHIPPED MANIFEST CANNOT REACH. Today's arming keys off
    // `permissionMode === 'plan'` (sessionHost.ts:754), so the compiled engine
    // WOULD arm here. The preflight says otherwise — and U3 is what makes the
    // engine agree with it.
    const workflow = perturbed('planning', { briefing: { capture: [] } });
    const result = declaredRun(taskRecord({ stage: 'planning', ...WORK_ORDER }), planStore(), {
      workflow,
    });
    expect(result).toMatchObject({
      ok: true,
      permissionFooting: 'plan',
      capture: [],
      planCaptureArmed: false,
    });
  });

  it('capture WITHOUT plan mode: REFUSED preflight, not silently ignored', () => {
    // The harvest mechanism exists only at the ExitPlanMode boundary, so a node
    // asking for capture under `auto` is asking for an interception that cannot
    // fire. Fail-closed (§3.5's vocabulary), never a quiet no-op.
    const workflow = perturbed('planning', {
      permissionMode: 'default',
      briefing: { capture: ['plan'] },
    });
    expect(
      declaredRun(taskRecord({ stage: 'planning', ...WORK_ORDER }), planStore(), { workflow }),
    ).toEqual({ ok: false, reason: 'invalid-capture-combo' });
  });

  it('neither plan mode NOR capture: legal, and nothing is armed', () => {
    const workflow = perturbed('planning', {
      permissionMode: 'default',
      briefing: { capture: [] },
    });
    const result = declaredRun(taskRecord({ stage: 'planning', ...WORK_ORDER }), planStore(), {
      workflow,
    });
    expect(result).toMatchObject({
      ok: true,
      permissionFooting: 'auto',
      capture: [],
      planCaptureArmed: false,
    });
  });

  it('arming keys off the capture NAME, not off "the list is non-empty"', () => {
    // The catalogue is closed at one entry today, so this cell can only be built
    // by hand — and it is built deliberately, because "non-empty" would arm plan
    // harvesting for whatever the catalogue's SECOND entry turns out to be.
    const workflow = perturbed('planning', { briefing: { capture: ['some-future-capture'] } });
    const result = declaredRun(taskRecord({ stage: 'planning', ...WORK_ORDER }), planStore(), {
      workflow,
    });
    expect(result).toMatchObject({ ok: true, planCaptureArmed: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B — the preflight is the ONLY path (S19·U3: the flip, proven positively)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ **THIS DESCRIBE STOOD HERE AS "…IS WIRED AND DELIBERATELY UNCALLED" AND WAS
// DELETED BY S19·U3 (a recorded reversal, not a quiet edit).** Its case spawned
// a dispatcher with a THROWING `preflightBriefing` and asserted the dispatch
// still SUCCEEDED — proof-by-verify-by-breaking that nothing called the dep
// yet. That premise is now FALSE BY DESIGN: the flip's entire point is that
// `dispatchTask` calls `preflightBriefing` on every spawn attempt, so a
// throwing preflight now correctly FAILS the dispatch (A4 proves exactly that,
// end-to-end, above). What replaces it is the positive-path mirror: a
// SUCCEEDING preflight's `composed` string is what actually gets sent, through
// a REAL `dispatchTask`, with no compiled fallback anywhere left to fall to.
describe('S19·U3 — the preflight governs a REAL spawn, end-to-end', () => {
  it('a dispatch sends the DECLARED path’s composed bytes — no compiled fallback exists any more', async () => {
    const task = taskRecord({ stage: 'implementing', ...WORK_ORDER });
    const store = planStore();
    const spawnCalls: RecordedSpawn[] = [];
    const sendCalls: Array<{ appSessionId: string; text: string }> = [];
    const tasksState: TasksState = { tasks: { [task.taskId]: task } };

    const dispatcher = new TaskDispatcher({
      sessionHost: {
        spawnSession: (options) => {
          spawnCalls.push(options);
          return { appSessionId: SPAWNED_SESSION_ID };
        },
        isLive: () => false,
        sendMessage: (appSessionId, text) => {
          sendCalls.push({ appSessionId, text });
          return { ok: true };
        },
      },
      preflightBriefing: (candidate) => declaredRun(candidate, store),
      emit: () => {},
      readTasks: () => tasksState,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: 90_000,
      artifactStore: store,
      instanceWriter: { proposeMove: (taskId) => ({ outcome: 'unknown-task', taskId }) },
    });

    const result = await dispatcher.dispatchTask(task.taskId);

    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
    expect(spawnCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
    // …and the sent bytes are EXACTLY the declared path's `composed` string —
    // the same one the A2 differential proves byte-identical to the (now
    // LIVE-derived, not frozen) `compiledBriefingFor`.
    const declared = declaredRun(task, planStore());
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(sendCalls[0]!.text).toBe(declared.composed);
    // §3.4/§3.6/§3.7: the spawn options carry the declaration's footing and
    // tool ids too — not just the words.
    expect(spawnCalls[0]).toMatchObject({
      permissionMode: FROZEN_PERMISSION_FOOTING_BY_STAGE.implementing,
      reportToolIds: FROZEN_TOOL_IDS_BY_STAGE.implementing,
    });
  });
});

describe('S19·U2 — the reads adapter carries today’s degrade semantics', () => {
  it('an ABSENT hash does not consult the store at all', () => {
    const consulted: string[] = [];
    const reads = taskBriefingInputReads(taskRecord(), {
      getBlob: (hash) => {
        consulted.push(hash);
        return null;
      },
    });
    expect(reads.readPlanText()).toBeUndefined();
    expect(consulted).toEqual([]);
  });

  it('a NULL blob degrades to absent', () => {
    const reads = taskBriefingInputReads(taskRecord({ planArtifactHash: PLAN_HASH }), {
      getBlob: () => null,
    });
    expect(reads.readPlanText()).toBeUndefined();
  });

  it('a THROWING store degrades to absent rather than failing the dispatch', () => {
    const reads = taskBriefingInputReads(taskRecord({ planArtifactHash: PLAN_HASH }), {
      getBlob: () => {
        throw new Error('the store is on fire');
      },
    });
    expect(reads.readPlanText()).toBeUndefined();
  });

  it('the fix-seed is read straight off the record — NO I/O', () => {
    const consulted: string[] = [];
    const reads = taskBriefingInputReads(
      taskRecord({ lastReview: REVIEW_PAYLOAD, lastCompletion: COMPLETION_PAYLOAD }),
      {
        getBlob: (hash) => {
          consulted.push(hash);
          return null;
        },
      },
    );
    expect(reads.readLastReview()).toBe(REVIEW_PAYLOAD);
    expect(reads.readLastCompletion()).toBe(COMPLETION_PAYLOAD);
    expect(consulted).toEqual([]);
  });

  // The degrade is not decoration: a plan-bearing task whose store THROWS must
  // still compose byte-identically on both paths — which is what "mirror
  // `deliverStageInstruction`'s exact behaviour" buys, and where a differently
  // shaped degrade would show up.
  it('a throwing store still composes declared ≡ compiled', () => {
    const task = taskRecord({ stage: 'implementing', ...WORK_ORDER, planArtifactHash: PLAN_HASH });
    const angryStore = (): ArtifactStore => {
      const store = new MemoryArtifactStore();
      store.getBlob = () => {
        throw new Error('the store is on fire');
      };
      return store;
    };
    const compiled = compiledBriefingFor(task, angryStore());
    const declared = declaredRun(task, angryStore());
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.composed).toBe(compiled);
  });
});

describe('S19-A7 — the domain claim cannot rot silently', () => {
  it('a non-dispatchable stage never reaches the preflight, because dispatch refuses it upstream', async () => {
    const task = taskRecord({ stage: 'backlog' });
    const tasksState: TasksState = { tasks: { [task.taskId]: task } };
    const spawnCalls: RecordedSpawn[] = [];
    const dispatcher = new TaskDispatcher({
      sessionHost: {
        spawnSession: (options) => {
          spawnCalls.push(options);
          return { appSessionId: SPAWNED_SESSION_ID };
        },
        isLive: () => false,
        sendMessage: () => ({ ok: true }),
      },
      emit: () => {},
      readTasks: () => tasksState,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: 90_000,
      artifactStore: new MemoryArtifactStore(),
      instanceWriter: { proposeMove: (taskId) => ({ outcome: 'unknown-task', taskId }) },
    });

    expect(await dispatcher.dispatchTask(task.taskId)).toEqual({
      outcome: 'refused',
      taskId: TASK_ID,
      reason: 'stage-not-dispatchable',
    });
    expect(spawnCalls).toEqual([]);
    // …and the declaration agrees: that node carries no briefing at all, so the
    // preflight would refuse it too. The two halves cannot drift apart silently.
    expect(declaredRun(task, planStore())).toEqual({
      ok: false,
      reason: 'composer-unresolvable',
    });
  });
});
