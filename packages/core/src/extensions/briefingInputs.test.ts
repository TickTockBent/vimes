import { describe, expect, it } from 'vitest';
import { taskRecordSchema, type TaskRecord } from '../schemas.js';
import {
  ASSEMBLABLE_BRIEFING_INPUT_ROWS,
  EXCLUDED_INSTANCE_RECORD_FIELDS,
  INSTANCE_RECORD_ROW,
  LAST_COMPLETION_ROW,
  LAST_REVIEW_ROW,
  PLAN_ARTIFACT_ROW,
  PROJECTED_INSTANCE_RECORD_FIELDS,
  assembleBriefingInputs,
  briefingInputRefusalReasonSchema,
  projectInstanceRecord,
  type BriefingInputReads,
} from './briefingInputs.js';

// ─── S19·U1 (slice-19 §3.2) — the projection and the assembly ────────────────
//
// Two claims live here, and they are the executable halves of A3:
//
//   • THE PROJECTION EXCLUDES EXACTLY THREE FIELDS AND KEEPS EVERY OTHER ONE,
//     enumerated against the LIVE `taskRecordSchema` rather than against a
//     hand-copied list — so a schema widening reddens HERE (beside the
//     compile-time guard in the module) instead of silently passing a new
//     field through to a composer.
//   • THE ASSEMBLY READS ONLY DECLARED ROWS. Asserted with spy reads that
//     record their own invocation: "the undeclared kind is missing from the
//     set" is the WEAK claim and would pass for a read-then-filter
//     implementation; "the undeclared read was NEVER CALLED" is the claim
//     §3.2 actually makes.

const REVIEW_PAYLOAD = {
  taskId: 'task-briefing-inputs-0001',
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  criteria: [
    { criterionId: 'ac-1', verdict: 'fail', note: 'the widget still does not work' },
    { criterionId: 'ac-2', verdict: 'pass' },
  ],
} satisfies NonNullable<TaskRecord['lastReview']>;

const COMPLETION_PAYLOAD = {
  taskId: 'task-briefing-inputs-0001',
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  worklog: {
    decisionsMade: ['used the existing adapter'],
    pathsRejected: ['a second projection'],
  },
} satisfies NonNullable<TaskRecord['lastCompletion']>;

const PLAN_TEXT = 'Step 1. Do the thing.\nStep 2. Verify.';

/** A record with EVERY field present, excluded ones included. */
function fullTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-briefing-inputs-0001',
    projectRoot: '/home/foo',
    title: 'Fix the widget',
    scope: 'Make the widget do the thing.',
    explicitlyOut: ['Do not touch the gadget.'],
    acceptanceCriteria: [{ id: 'ac-1', text: 'The widget works.' }],
    killCriterion: 'the build cannot be made green without a schema change.',
    workOrderRev: 1,
    planArtifactHash: 'sha256:deadbeef',
    lastReview: REVIEW_PAYLOAD,
    lastCompletion: COMPLETION_PAYLOAD,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [{ stage: 'implementing', appSessionId: 'app-1' }],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

/** A minimal record — every OPTIONAL field absent. */
function bareTaskRecord(): TaskRecord {
  return {
    taskId: 'task-briefing-inputs-0002',
    projectRoot: '/home/foo',
    stage: 'planning',
    manualReviewRequired: false,
    isolation: 'shared-dir',
    gates: {},
    sessionRefs: [],
    createdBy: 'orchestrator',
    lastHeartbeatAt: null,
    staleRetries: 0,
  };
}

interface SpiedReads extends BriefingInputReads {
  readonly calls: string[];
}

/** Reads that record their own invocation — the instrument for the ONLY-declared claim. */
function spiedReads(
  overrides: Partial<{
    record: TaskRecord;
    planText: string | undefined;
    lastReview: TaskRecord['lastReview'];
    lastCompletion: TaskRecord['lastCompletion'];
  }> = {},
): SpiedReads {
  const calls: string[] = [];
  return {
    calls,
    readInstanceRecord: () => {
      calls.push('readInstanceRecord');
      return overrides.record ?? fullTaskRecord();
    },
    readPlanText: () => {
      calls.push('readPlanText');
      return 'planText' in overrides ? overrides.planText : PLAN_TEXT;
    },
    readLastReview: () => {
      calls.push('readLastReview');
      return 'lastReview' in overrides ? overrides.lastReview : REVIEW_PAYLOAD;
    },
    readLastCompletion: () => {
      calls.push('readLastCompletion');
      return 'lastCompletion' in overrides ? overrides.lastCompletion : COMPLETION_PAYLOAD;
    },
  };
}

describe('the projection table (slice-19 §3.2) — signed data', () => {
  it('classifies EVERY live `taskRecordSchema` field exactly once', () => {
    const schemaFields = Object.keys(taskRecordSchema.shape).sort();
    const classified = [
      ...PROJECTED_INSTANCE_RECORD_FIELDS,
      ...EXCLUDED_INSTANCE_RECORD_FIELDS,
    ].sort();
    // Enumerated against the LIVE schema: a widening that nobody classified
    // reddens here, and the compile-time guard in the module reddens too.
    expect(classified).toEqual(schemaFields);
    // No field is on both lists, and none is listed twice.
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('excludes EXACTLY the three fields that are other input kinds content', () => {
    expect([...EXCLUDED_INSTANCE_RECORD_FIELDS].sort()).toEqual([
      'lastCompletion',
      'lastReview',
      'planArtifactHash',
    ]);
  });

  it('keeps sixteen fields — the count is pinned so a silent add cannot pass', () => {
    expect(PROJECTED_INSTANCE_RECORD_FIELDS).toHaveLength(16);
    expect(EXCLUDED_INSTANCE_RECORD_FIELDS).toHaveLength(3);
    expect(Object.keys(taskRecordSchema.shape)).toHaveLength(19);
  });
});

describe('projectInstanceRecord — the disjointness guarantee (A3)', () => {
  it('drops exactly the three excluded fields and keeps every other one', () => {
    const projected = projectInstanceRecord(fullTaskRecord());
    const keptKeys = Object.keys(projected).sort();
    const expectedKeys = Object.keys(taskRecordSchema.shape)
      .filter((key) => !(EXCLUDED_INSTANCE_RECORD_FIELDS as readonly string[]).includes(key))
      .sort();
    expect(keptKeys).toEqual(expectedKeys);
  });

  it('the three excluded fields are ABSENT, not undefined — `in` is false', () => {
    // The projection is what A3 asserts on, so the check is `in` rather than a
    // value comparison: a present-but-undefined key would still be a key a
    // composer could see, and would still change the serialized bytes.
    const projected = projectInstanceRecord(fullTaskRecord());
    for (const excluded of EXCLUDED_INSTANCE_RECORD_FIELDS) {
      expect(excluded in projected).toBe(false);
    }
    // …and nothing carrying their CONTENT survived under another name.
    expect(JSON.stringify(projected)).not.toContain('sha256:deadbeef');
    expect(JSON.stringify(projected)).not.toContain('the widget still does not work');
    expect(JSON.stringify(projected)).not.toContain('a second projection');
  });

  it('copies every kept field by value, verbatim', () => {
    const task = fullTaskRecord();
    const projected = projectInstanceRecord(task);
    for (const kept of PROJECTED_INSTANCE_RECORD_FIELDS) {
      expect(projected[kept]).toEqual(task[kept]);
    }
  });

  it('ABSENT STAYS ABSENT: an optional field the record lacks is not written back', () => {
    const projected = projectInstanceRecord(bareTaskRecord());
    for (const optional of [
      'title',
      'scope',
      'explicitlyOut',
      'acceptanceCriteria',
      'killCriterion',
      'workOrderRev',
    ]) {
      expect(optional in projected).toBe(false);
    }
    // The ten required fields are all there.
    expect(Object.keys(projected).sort()).toEqual(
      [
        'createdBy',
        'gates',
        'isolation',
        'lastHeartbeatAt',
        'manualReviewRequired',
        'projectRoot',
        'sessionRefs',
        'stage',
        'staleRetries',
        'taskId',
      ].sort(),
    );
  });

  it('an EMPTY-STRING title is kept as a chosen title, never dropped', () => {
    const projected = projectInstanceRecord(fullTaskRecord({ title: '' }));
    expect('title' in projected).toBe(true);
    expect(projected.title).toBe('');
  });

  it('is PURE and TOTAL: same record in, deeply-equal projection out; input untouched', () => {
    const task = fullTaskRecord();
    const snapshot = JSON.stringify(task);
    expect(projectInstanceRecord(task)).toEqual(projectInstanceRecord(task));
    expect(JSON.stringify(task)).toBe(snapshot);
  });
});

describe('assembleBriefingInputs — ONLY declared rows are read (A3)', () => {
  it('reads nothing at all for an EMPTY declaration', () => {
    const reads = spiedReads();
    const assembly = assembleBriefingInputs([], reads);
    expect(assembly).toEqual({ assembled: true, inputs: {} });
    expect(reads.calls).toEqual([]);
  });

  it('the planning shape (record only) NEVER calls the plan or report reads', () => {
    const reads = spiedReads();
    const assembly = assembleBriefingInputs([INSTANCE_RECORD_ROW], reads);
    if (!assembly.assembled) throw new Error('expected an assembly');
    expect(reads.calls).toEqual(['readInstanceRecord']);
    expect(assembly.inputs.record).toEqual(projectInstanceRecord(fullTaskRecord()));
    expect('planText' in assembly.inputs).toBe(false);
    expect('lastReview' in assembly.inputs).toBe(false);
    expect('lastCompletion' in assembly.inputs).toBe(false);
  });

  it('the implementing shape declares all four and reads all four, once each', () => {
    const reads = spiedReads();
    const assembly = assembleBriefingInputs(
      [INSTANCE_RECORD_ROW, PLAN_ARTIFACT_ROW, LAST_REVIEW_ROW, LAST_COMPLETION_ROW],
      reads,
    );
    if (!assembly.assembled) throw new Error('expected an assembly');
    expect(reads.calls.sort()).toEqual(
      ['readInstanceRecord', 'readLastCompletion', 'readLastReview', 'readPlanText'].sort(),
    );
    expect(assembly.inputs.planText).toBe(PLAN_TEXT);
    expect(assembly.inputs.lastReview).toEqual(REVIEW_PAYLOAD);
    expect(assembly.inputs.lastCompletion).toEqual(COMPLETION_PAYLOAD);
  });

  it('a row declared TWICE is one fact, not two reads', () => {
    const reads = spiedReads();
    assembleBriefingInputs([PLAN_ARTIFACT_ROW, PLAN_ARTIFACT_ROW], reads);
    expect(reads.calls).toEqual(['readPlanText']);
  });

  it('declaration ORDER does not change the set', () => {
    const forwards = assembleBriefingInputs(
      [INSTANCE_RECORD_ROW, PLAN_ARTIFACT_ROW, LAST_REVIEW_ROW],
      spiedReads(),
    );
    const backwards = assembleBriefingInputs(
      [LAST_REVIEW_ROW, PLAN_ARTIFACT_ROW, INSTANCE_RECORD_ROW],
      spiedReads(),
    );
    expect(forwards).toEqual(backwards);
  });

  it('the record in the set is the PROJECTION, never the raw record', () => {
    const reads = spiedReads();
    const assembly = assembleBriefingInputs([INSTANCE_RECORD_ROW], reads);
    if (!assembly.assembled) throw new Error('expected an assembly');
    const record = assembly.inputs.record;
    expect(record).toBeDefined();
    for (const excluded of EXCLUDED_INSTANCE_RECORD_FIELDS) {
      expect(excluded in (record as object)).toBe(false);
    }
  });
});

describe('assembleBriefingInputs — declared-but-absent degrades to ABSENT', () => {
  it('an undelivered plan leaves NO `planText` key (not an empty string)', () => {
    const reads = spiedReads({ planText: undefined });
    const assembly = assembleBriefingInputs([PLAN_ARTIFACT_ROW], reads);
    if (!assembly.assembled) throw new Error('expected an assembly');
    // The read HAPPENED — declared rows are always read — and returned nothing.
    expect(reads.calls).toEqual(['readPlanText']);
    expect('planText' in assembly.inputs).toBe(false);
    expect(assembly.inputs).toEqual({});
  });

  it('a first pass — declared fix-seed, nothing stored yet — assembles to an empty set', () => {
    const reads = spiedReads({ lastReview: undefined, lastCompletion: undefined });
    const assembly = assembleBriefingInputs([LAST_REVIEW_ROW, LAST_COMPLETION_ROW], reads);
    if (!assembly.assembled) throw new Error('expected an assembly');
    expect(reads.calls).toEqual(['readLastReview', 'readLastCompletion']);
    expect(assembly.inputs).toEqual({});
    expect('lastReview' in assembly.inputs).toBe(false);
    expect('lastCompletion' in assembly.inputs).toBe(false);
  });

  it('half a fix-seed composes: feedback present, worklog absent', () => {
    const reads = spiedReads({ lastCompletion: undefined });
    const assembly = assembleBriefingInputs([LAST_REVIEW_ROW, LAST_COMPLETION_ROW], reads);
    if (!assembly.assembled) throw new Error('expected an assembly');
    expect(assembly.inputs.lastReview).toEqual(REVIEW_PAYLOAD);
    expect('lastCompletion' in assembly.inputs).toBe(false);
  });
});

describe('assembleBriefingInputs — the CLOSED vocabulary refuses, fail-closed', () => {
  it('names the four rows it can assemble, and nothing else', () => {
    expect([...ASSEMBLABLE_BRIEFING_INPUT_ROWS].sort()).toEqual(
      ['artifact:plan', 'instance.record', 'report:last-completion', 'report:last-review'].sort(),
    );
  });

  it('refuses an `artifact:` row this engine does not fetch', () => {
    const reads = spiedReads();
    const assembly = assembleBriefingInputs([INSTANCE_RECORD_ROW, 'artifact:diagram'], reads);
    expect(assembly).toEqual({
      assembled: false,
      reason: 'unknown-artifact-id',
      row: 'artifact:diagram',
    });
  });

  it('refuses a `report:` row this engine does not fold', () => {
    const assembly = assembleBriefingInputs(['report:last-audit'], spiedReads());
    expect(assembly).toEqual({
      assembled: false,
      reason: 'unknown-report-kind',
      row: 'report:last-audit',
    });
  });

  it('refuses a manifest-legal row with no engine assembler (a path, a capture)', () => {
    // Both of these PARSE cleanly (node-kit §1.8.1's vocabulary is wider than
    // the engine's assembler set) — which is exactly why the refusal has to
    // exist here rather than being assumed away at parse time.
    expect(assembleBriefingInputs(['doctrine/implementing.md'], spiedReads())).toEqual({
      assembled: false,
      reason: 'unknown-input-kind',
      row: 'doctrine/implementing.md',
    });
    expect(assembleBriefingInputs(['capture:plan'], spiedReads())).toEqual({
      assembled: false,
      reason: 'unknown-input-kind',
      row: 'capture:plan',
    });
  });

  it('READS NOTHING when any row is unassemblable — fail-closed, both orders', () => {
    const rowFirst = spiedReads();
    assembleBriefingInputs(['artifact:diagram', INSTANCE_RECORD_ROW], rowFirst);
    expect(rowFirst.calls).toEqual([]);
    // …and the refusal still precedes every read when the bad row is LAST: the
    // classification pass completes before any read happens.
    const rowLast = spiedReads();
    assembleBriefingInputs([INSTANCE_RECORD_ROW, PLAN_ARTIFACT_ROW, 'artifact:diagram'], rowLast);
    expect(rowLast.calls).toEqual([]);
  });

  it('names the FIRST unassemblable row in declaration order — a stable refusal', () => {
    const assembly = assembleBriefingInputs(['capture:plan', 'artifact:diagram'], spiedReads());
    if (assembly.assembled) throw new Error('expected a refusal');
    expect(assembly.row).toBe('capture:plan');
  });

  it('the refusal channel is CLOSED and its membership is assertable', () => {
    expect(briefingInputRefusalReasonSchema.options).toEqual([
      'unknown-artifact-id',
      'unknown-report-kind',
      'unknown-input-kind',
    ]);
  });

  it('every refusal reason is a member of the closed schema', () => {
    for (const row of ['artifact:x', 'report:x', 'nope', 'capture:plan', '']) {
      const assembly = assembleBriefingInputs([row], spiedReads());
      if (assembly.assembled) throw new Error(`expected a refusal for "${row}"`);
      expect(briefingInputRefusalReasonSchema.safeParse(assembly.reason).success).toBe(true);
    }
  });
});
