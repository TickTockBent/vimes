import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  type StageRunnerPlan,
  type TaskRecord,
} from '@vimes/core';
import { composeStageInstruction } from '@vimes/ext-tasks';

// ─── S18-F4: THE STEM COUPLING'S HONEST HOME (docs/slice-18.md §6c) ──────────
//
// ⚠ **THIS FILE EXISTS TO BE THE MACHINE CHECK THE COLD REVIEW FOUND MISSING.**
// It is not a convenience test and it is not a duplicate; deleting it re-opens
// a hole that stays green.
//
// S18·U2's pre-authorized fixture swap (c3 doctrine) froze the briefings inside
// `packages/core/src/sessionIdentity.test.ts` as recorded constants, because
// core may not import a tenant and `composeStageInstruction` had just left for
// `@vimes/ext-tasks`. The swap was signed — but it SEVERED the only machine
// check tying core's dispatch-briefing recognition to the composer's REAL
// output. §6c states the consequence exactly: "a stem reword in ext-tasks now
// lands as a routine golden update while core stays green and D91 title
// derivation silently dies."
//
// The DAEMON is the one package that legally imports both sides (§3.5/§3.6:
// `@vimes/core` and `@vimes/ext-tasks` are both its declared dependencies, and
// the boundary checker's rule 8 permits exactly this root-barrel pair). So the
// coupling lives here, composing REAL briefings through the REAL exported
// composer — never a fixture.
//
// ⚠ **HOW THE COUPLING IS ASSERTED, AND THE ONE DEVIATION FROM THE WORK ORDER.**
// The work order asked for `briefing.startsWith(DISPATCH_BRIEFING_STEM)`, on the
// premise that the constant is importable from `@vimes/core`. It is NOT: the
// constant is declared in `sessionIdentity.ts` but never re-exported by core's
// barrel (`packages/core/src/index.ts`), and core's package.json `exports` map
// publishes only `.` and `./testing`, so no deep import can reach it either.
// Widening core's public surface was outside this unit's touch list, so the
// coupling is asserted through `deriveSessionTitle` — the ONE consumer of that
// constant which core DOES export, and the exact function D91 title derivation
// runs on. `deriveSessionTitle` takes its dispatch branch if and only if the
// text starts with `DISPATCH_BRIEFING_STEM` (sessionIdentity.ts), so:
//
//   composer's opening sentence drifts
//     → the branch is not taken
//     → the whole briefing falls through the ordinary pipeline
//     → the title is the collapsed, capped boilerplate instead of the label
//     → the `derives EXACTLY the task label` cases below RED.
//
// That is a strictly WIDER check than `startsWith`: it fails on a stem reword
// AND on a change to the `Task:` line shape the derivation also depends on. The
// verify-by-breaking cases at the bottom prove the stem is what is being
// measured, rather than something else that happens to be green.
//
// Reported as a finding for the orchestrator: if the literal `startsWith` form
// is preferred, exporting `DISPATCH_BRIEFING_STEM` from core's barrel is the
// one-line change that unblocks it, and this file gains the assertion directly.

const DISPATCH_PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const DISPATCH_TASK_LABEL = 'getMany(ids) — batch the session lookups';

const SPAWN: StageRunnerPlan = { mode: 'spawn' };

// The same population `sessionIdentity.test.ts`'s frozen fixtures were recorded
// from, so a drift shows up here as a red rather than as a silent divergence
// between the two files.
function dispatchedTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-s16-u6-000000000001',
    projectRoot: DISPATCH_PROJECT_ROOT,
    title: DISPATCH_TASK_LABEL,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

// EVERY briefing family `composeStageInstruction` can produce — the same four
// `sessionIdentity.test.ts` froze, each composed LIVE here. The composer has
// exactly four spawn branches (stageInstruction.ts: implementing-rich at the
// `hasScope || …` gate, planning, review, and the generic fall-through), so
// this table is total over its output shapes.
const DISPATCH_BRIEFING_VARIANTS: readonly {
  readonly variant: string;
  readonly compose: (task: TaskRecord) => string;
}[] = [
  {
    variant: 'generic make-progress (a bare implementing task degrades to it)',
    compose: (task) => composeStageInstruction(task, SPAWN),
  },
  {
    variant: 'implementing, rich (a work-order section earns the fuller briefing)',
    compose: (task) =>
      composeStageInstruction(
        { ...task, scope: 'Batch the per-id lookups behind one call.' },
        SPAWN,
      ),
  },
  {
    variant: 'planning',
    compose: (task) => composeStageInstruction({ ...task, stage: 'planning' }, SPAWN),
  },
  {
    variant: 'review',
    compose: (task) =>
      composeStageInstruction(
        {
          ...task,
          stage: 'review',
          acceptanceCriteria: [{ id: 'ac1', text: 'One query, not N.' }],
        },
        SPAWN,
      ),
  },
];

describe('S18-F4: core’s dispatch-briefing recognition vs the tenant composer’s real output', () => {
  it.each(DISPATCH_BRIEFING_VARIANTS.map((v) => [v.variant, v] as const))(
    'the %s briefing derives EXACTLY the task label',
    (_variant, briefingVariant) => {
      expect(deriveSessionTitle(briefingVariant.compose(dispatchedTask()))).toBe(
        DISPATCH_TASK_LABEL,
      );
    },
  );

  // The table must actually cover four DIFFERENT briefings — a composer
  // refactor that collapsed two families onto the same text would otherwise
  // keep every case above green while deleting a variant's coverage.
  it('covers four distinct composed briefings, not the same one four times', () => {
    const composedBriefings = DISPATCH_BRIEFING_VARIANTS.map((v) => v.compose(dispatchedTask()));
    expect(new Set(composedBriefings).size).toBe(4);
  });

  // The title-shape edges the frozen fixtures also carry, composed live: a
  // label that itself opens `Task:` (the FIRST-marker rule) and a label longer
  // than the display cap. Both run through the same stem branch.
  it('a label that itself begins "Task:" survives whole through the dispatch branch', () => {
    const selfReferentialLabel = 'Task: surf the wave';
    const briefing = composeStageInstruction(
      dispatchedTask({ title: selfReferentialLabel }),
      SPAWN,
    );
    expect(deriveSessionTitle(briefing)).toBe(selfReferentialLabel);
  });

  it(`a label longer than the bound truncates at ${SESSION_TITLE_MAX_LENGTH}`, () => {
    const briefing = composeStageInstruction(dispatchedTask({ title: 'q'.repeat(300) }), SPAWN);
    expect(deriveSessionTitle(briefing)).toBe('q'.repeat(SESSION_TITLE_MAX_LENGTH));
  });
});

// ─── verify-by-breaking: the assertions above measure THE STEM ───────────────
//
// A green test can be measuring the wrong thing. These cases sabotage the
// composer's output in the two ways a real drift would, and pin that the checks
// above go RED for them — which is what makes them a coupling rather than a
// coincidence.
describe('S18-F4: the coupling is measuring the opening stem, not something adjacent', () => {
  it.each(DISPATCH_BRIEFING_VARIANTS.map((v) => [v.variant, v] as const))(
    'a REWORDED opening sentence on the %s briefing loses the label',
    (_variant, briefingVariant) => {
      const briefing = briefingVariant.compose(dispatchedTask());
      // Exactly the drift §6c names: the composer's first words change, nothing
      // else does. `You are a worker session that VIMES dispatched` → `You are a
      // worker agent that VIMES dispatched`.
      const rewordedBriefing = briefing.replace(
        'You are a worker session that VIMES',
        'You are a worker agent that VIMES',
      );
      expect(rewordedBriefing).not.toBe(briefing);
      expect(deriveSessionTitle(rewordedBriefing)).not.toBe(DISPATCH_TASK_LABEL);
    },
  );

  it('a leading character before the stem also loses the label (the branch is anchored at byte 0)', () => {
    const briefing = composeStageInstruction(dispatchedTask(), SPAWN);
    expect(deriveSessionTitle(` ${briefing}`)).not.toBe(DISPATCH_TASK_LABEL);
  });
});
