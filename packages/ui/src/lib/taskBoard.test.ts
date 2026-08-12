import { describe, expect, it } from 'vitest';
import type { SessionRecord } from './types.js';
import {
  EXCEPTION_STAGES,
  FLOW_STAGES,
  KNOWN_STAGES,
  describeCreateResponse,
  describeDispatchResponse,
  describeMoveResponse,
  describeRejectionReason,
  deriveTaskCard,
  findTaskCard,
  groupTasksForBoard,
  moveOptionsFor,
  nodeEdgesFromDeclaration,
  readWorkflowRefs,
  sessionTrailOf,
  shortTaskId,
  stageKind,
  stageLabel,
  workflowRefKey,
} from './taskBoard.js';

// ─── slice 6 step 9 — the task board's pure derivations ──────────────────────
//
// House rule: the `.vue` is untested; everything that DECIDES anything lives
// here and is tested here. The two assertions worth naming up front, because
// they are the ones that exist to stop a future "helpful" edit:
//
//   • the grouping output is LAYOUT-AGNOSTIC — a desktop board must be able to
//     arrange it horizontally from the identical value (assertion 6), and
//   • the move sheet IS filtered by the SERVED edge table, never a copy of it
//     (assertion 8, reversed 2026-07-24 — see moveOptionsFor's own note).

// A fixture standing in for the derived legal-target table (what
// `nodeEdgesFromDeclaration` hands `moveOptionsFor` at runtime) — transcribed
// here as test data ONLY, exactly like every other mirrored wire shape in this
// file. This is not a second copy of the legality DECISION.
const STAGE_EDGES_FIXTURE: Record<string, readonly string[]> = {
  backlog: ['planning', 'blocked-external'],
  planning: ['plan-ready', 'blocked-external', 'quarantined', 'backlog'],
  'plan-ready': ['implementing', 'planning', 'blocked-external', 'backlog'],
  implementing: ['review', 'blocked-external', 'quarantined'],
  review: ['done', 'implementing', 'blocked-external', 'quarantined'],
  'blocked-external': ['backlog', 'planning', 'plan-ready', 'implementing', 'review'],
  quarantined: ['backlog', 'planning', 'implementing', 'blocked-external'],
  done: [],
};

const TASK_ONE = 'aaaaaaaa-1111-4000-8000-000000000001';
const TASK_TWO = 'bbbbbbbb-2222-4000-8000-000000000002';
const TASK_THREE = 'eeeeeeee-4444-4000-8000-000000000004';
const SESSION_ONE = 'cccccccc-3333-4000-8000-000000000003';

// One record in the INSTANCES shape (S13·U3) — `instanceId`/`project`/
// `currentNode`/`attachedSessions`, with the authored fields under the opaque
// `payload` key. `payload` overrides merge into the payload bag; every other
// override sits on the core record, so a test can reach either half.
function taskRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { payload, ...core } = overrides;
  return {
    instanceId: TASK_ONE,
    project: '/home/user/projects/vimes',
    workflow: { extension: 'vimes-tasks', workflow: 'task', rev: '1.0.0' },
    currentNode: 'backlog',
    nodeHistory: [],
    edgeTraversalCounts: {},
    attemptsPerNode: {},
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    attachedSessions: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...core,
    payload: { ...(payload as Record<string, unknown> | undefined) },
  };
}

function projectionBody(...instances: Record<string, unknown>[]): unknown {
  const byId: Record<string, unknown> = {};
  for (const instance of instances) {
    byId[instance.instanceId as string] = instance;
  }
  return { instances: byId };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    appSessionId: SESSION_ONE,
    channel: 'sdk',
    cwd: '/home/user/projects/vimes',
    liveness: 'running',
    needsAttention: null,
    name: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

// ── ASSERTION 6: grouping, and its layout-agnosticism ───────────────────────

describe('groupTasksForBoard — stages, kinds, and the layout-agnostic contract', () => {
  it('puts each task under its own stage', () => {
    const board = groupTasksForBoard(
      projectionBody(
        taskRecord({ instanceId: TASK_ONE, currentNode: 'review' }),
        taskRecord({ instanceId: TASK_TWO, currentNode: 'implementing' }),
      ),
    );
    const review = board.flow.find((group) => group.stage === 'review')!;
    const implementing = board.flow.find((group) => group.stage === 'implementing')!;
    expect(review.tasks.map((card) => card.taskId)).toEqual([TASK_ONE]);
    expect(implementing.tasks.map((card) => card.taskId)).toEqual([TASK_TWO]);
    expect(review.count).toBe(1);
    expect(board.totalTasks).toBe(2);
  });

  it('carries all six flow stages IN PIPELINE ORDER even when every one is empty', () => {
    // An empty stage still renders its header and its count: "nothing in
    // review" is information, not an absence. So the groups must exist at zero.
    const board = groupTasksForBoard({ instances: {} });
    expect(board.flow.map((group) => group.stage)).toEqual([
      'backlog',
      'planning',
      'plan-ready',
      'implementing',
      'review',
      'done',
    ]);
    expect(board.flow.every((group) => group.count === 0)).toBe(true);
    expect(board.flow.every((group) => group.kind === 'flow')).toBe(true);
  });

  it('classifies quarantined and blocked-external as EXCEPTION, never in the flow', () => {
    // These two are not pipeline positions — the edge table makes them reachable
    // from nearly every stage and they lead back out — so rendering them inline
    // with the flow would draw them as steps of a pipeline they are not part of.
    const board = groupTasksForBoard(
      projectionBody(
        taskRecord({ instanceId: TASK_ONE, currentNode: 'quarantined' }),
        taskRecord({ instanceId: TASK_TWO, currentNode: 'blocked-external' }),
      ),
    );
    expect(board.exceptions.map((group) => group.stage)).toEqual([...EXCEPTION_STAGES]);
    expect(board.exceptions.every((group) => group.kind === 'exception')).toBe(true);
    expect(
      board.exceptions.find((group) => group.stage === 'quarantined')?.count,
    ).toBe(1);
    expect(
      board.exceptions.find((group) => group.stage === 'blocked-external')?.count,
    ).toBe(1);
    expect(board.exceptions.find((group) => group.stage === 'cancelled')?.count).toBe(0);

    // ...and NOT in the flow, at any count.
    const flowStages = board.flow.map((group) => group.stage);
    expect(flowStages).not.toContain('quarantined');
    expect(flowStages).not.toContain('blocked-external');
    expect(board.flow.every((group) => group.count === 0)).toBe(true);
  });

  it('classifies cancelled (S11) as EXCEPTION too, never unknown', () => {
    // The mirrored vocabulary must grow WITH core's enum, or a cancelled task
    // renders as `unknown` instead of the exception group it belongs in.
    expect(stageKind('cancelled')).toBe('exception');
    expect(stageLabel('cancelled')).toBe('Cancelled');
    expect(EXCEPTION_STAGES).toContain('cancelled');

    const board = groupTasksForBoard(
      projectionBody(taskRecord({ instanceId: TASK_ONE, currentNode: 'cancelled' })),
    );
    const cancelledGroup = board.exceptions.find((group) => group.stage === 'cancelled');
    expect(cancelledGroup).toBeDefined();
    expect(cancelledGroup?.kind).toBe('exception');
    expect(cancelledGroup?.tasks.map((card) => card.taskId)).toEqual([TASK_ONE]);
    expect(board.unknown).toHaveLength(0);

    // ...and NOT in the flow.
    expect(board.flow.map((group) => group.stage)).not.toContain('cancelled');
  });

  it('renders a ZERO-count tray — "no blocked work" is a fact worth showing', () => {
    const board = groupTasksForBoard(projectionBody(taskRecord({ currentNode: 'backlog' })));
    expect(board.exceptions).toHaveLength(EXCEPTION_STAGES.length);
    expect(board.exceptions.map((group) => group.count)).toEqual(EXCEPTION_STAGES.map(() => 0));
  });

  it('is LAYOUT-AGNOSTIC: every stage carries its kind, and nothing is presentational', () => {
    // ASSERTION 6's real content. Step 9 ships the MOBILE board; the desktop
    // board is a separate unit that must consume this IDENTICAL value and
    // arrange it horizontally with zero changes to lib/.
    //
    // Two things are checked, and the second is the one that rots first:
    //   1. the value is complete — every group carries stage + kind + count +
    //      tasks, so a caller can arrange it in ANY direction from this alone;
    //   2. the value carries NOTHING presentational — no CSS class, no width, no
    //      colour, no icon, no ordinal that only makes sense stacked.
    const board = groupTasksForBoard(
      projectionBody(taskRecord({ currentNode: 'planning' }), taskRecord({ instanceId: TASK_TWO, currentNode: 'quarantined' })),
    );

    for (const group of board.groups) {
      expect(Object.keys(group).sort()).toEqual(['count', 'kind', 'label', 'stage', 'tasks']);
      expect(['flow', 'exception', 'unknown']).toContain(group.kind);
    }

    // A caller can rebuild the phone's stacked reading AND a desktop's
    // side-by-side reading from the same value, with no extra information.
    const asVerticalStack = board.flow.map((group) => group.stage);
    const asHorizontalColumns = board.groups
      .filter((group) => group.kind === 'flow')
      .map((group) => group.stage);
    expect(asHorizontalColumns).toEqual(asVerticalStack);

    // The exception tray is separable, so a desktop can dock it anywhere.
    expect(board.groups.filter((group) => group.kind === 'exception')).toEqual(board.exceptions);

    // No presentational token has leaked into the payload anywhere.
    const serialized = JSON.stringify(board);
    for (const presentationalToken of ['class', 'Class', 'color', 'colour', 'width', 'icon', 'px', 'rem']) {
      expect(serialized, `presentational token "${presentationalToken}" leaked into lib/ output`).not.toContain(
        presentationalToken,
      );
    }
  });

  it('exposes the vocabulary but NOT an edge table', () => {
    // The mirrored vocabulary is a wire shape (lib/types.ts sanctions that
    // narrowly). A legality table would be a copied DECISION — see assertion 8.
    expect(KNOWN_STAGES).toEqual([...FLOW_STAGES, ...EXCEPTION_STAGES]);
    expect(KNOWN_STAGES).toHaveLength(9);
    expect(stageKind('done')).toBe('flow');
    expect(stageKind('quarantined')).toBe('exception');
    expect(stageKind('cancelled')).toBe('exception');
    expect(stageKind('teleported')).toBe('unknown');
  });
});

// ── ASSERTION 7: card labelling ─────────────────────────────────────────────

describe('deriveTaskCard — labelling, and never a fabricated field', () => {
  it('uses the TITLE when the record carries one', () => {
    const card = deriveTaskCard(taskRecord({ payload: { title: 'add a card title to the board' } }) as never);
    expect(card.label).toBe('add a card title to the board');
    expect(card.labelIsFallback).toBe(false);
  });

  it('falls back to a SHORT taskId when the title is absent — never a blank card', () => {
    const card = deriveTaskCard(taskRecord() as never);
    expect(card.label).toBe(shortTaskId(TASK_ONE));
    expect(card.label.length).toBeGreaterThan(0);
    expect(card.labelIsFallback).toBe(true);
  });

  it('falls back for an EMPTY or WHITESPACE-ONLY title too', () => {
    // The daemon records `''` verbatim (it bounds length, it does not
    // editorialise). "Never a blank card" is decided in exactly one place, and
    // that place is here.
    for (const blankTitle of ['', '   ', '\t\n ']) {
      const card = deriveTaskCard(taskRecord({ payload: { title: blankTitle } }) as never);
      expect(card.label, JSON.stringify(blankTitle)).toBe(shortTaskId(TASK_ONE));
      expect(card.labelIsFallback).toBe(true);
    }
  });

  it('trims a padded title rather than rendering the padding', () => {
    const card = deriveTaskCard(taskRecord({ payload: { title: '  ship the board  ' } }) as never);
    expect(card.label).toBe('ship the board');
    expect(card.labelIsFallback).toBe(false);
  });

  it('carries only what the record has: project basename, createdBy, isolation, review flag', () => {
    const card = deriveTaskCard(
      taskRecord({
        project: '/home/user/projects/vimes',
        createdBy: 'orchestrator',
        isolation: 'worktree',
        manualReviewRequired: true,
      }) as never,
    );
    expect(card.projectName).toBe('vimes');
    // S8·2 — the FULL root rides alongside the basename: the basename is what a
    // card renders, the root is what project scoping matches on.
    expect(card.projectRoot).toBe('/home/user/projects/vimes');
    expect(card.createdBy).toBe('orchestrator');
    expect(card.isolatedInWorktree).toBe(true);
    expect(card.manualReviewRequired).toBe(true);
  });

  // ── S8·6: the provenance chip, both directions ──────────────────────────────
  //
  // The Gate-2 pivot criterion (how often authored work-orders need a human
  // rewrite) is unanswerable from a board that renders authored and hand-made
  // cards identically. These pin the derivation; the chip's markup reads it.
  it('marks a task the ORCHESTRATOR authored', () => {
    expect(deriveTaskCard(taskRecord({ createdBy: 'orchestrator' }) as never).authoredByOrchestrator).toBe(true);
  });

  it.each([
    ['human', 'human'],
    ['a value nobody has minted', 'dispatcher'],
    ['the empty string', ''],
    ['a near-miss with different case', 'Orchestrator'],
    ['a non-string', 42],
    ['an object', { name: 'orchestrator' }],
    ['null', null],
  ])('renders NO chip for %s — hand-made is the unmarked default', (_label, createdBy) => {
    expect(deriveTaskCard(taskRecord({ createdBy }) as never).authoredByOrchestrator).toBe(false);
  });

  it('renders NO chip when the record carries no createdBy at all', () => {
    // ⚠ THE FAIL-TO-NO-CHIP DIRECTION. A chip claiming the orchestrator wrote
    // something it did not would corrupt the measurement the chip exists to make.
    expect(deriveTaskCard({ instanceId: TASK_ONE }).authoredByOrchestrator).toBe(false);
  });

  it('shows NO worktree marker for a shared-dir task — a badge nobody asked for is noise', () => {
    const card = deriveTaskCard(taskRecord({ isolation: 'shared-dir' }) as never);
    expect(card.isolatedInWorktree).toBe(false);
  });

  it('never fabricates a field the record does not have', () => {
    // The pillar-4 posture: absent is null, and null is a thing the view must
    // render as absence — never as "unknown", never as a plausible default.
    const card = deriveTaskCard({ instanceId: TASK_ONE });
    expect(card.projectName).toBeNull();
    expect(card.projectRoot).toBeNull();
    expect(card.createdBy).toBeNull();
    expect(card.latestSession).toBeNull();
    expect(card.isolatedInWorktree).toBe(false);
    expect(card.manualReviewRequired).toBe(false);
    expect(card.label).toBe(shortTaskId(TASK_ONE));
  });

  it('reports the liveness of the MOST RECENT attached session', () => {
    const card = deriveTaskCard(
      taskRecord({
        attachedSessions: [
          { node: 'planning', appSessionId: 'dddddddd-0000-4000-8000-000000000009' },
          { node: 'implementing', appSessionId: SESSION_ONE },
        ],
      }) as never,
      { [SESSION_ONE]: sessionRecord({ liveness: 'interrupted' }) },
    );
    expect(card.latestSession).toEqual({
      appSessionId: SESSION_ONE,
      stage: 'implementing',
      liveness: 'interrupted',
    });
  });

  it('reports liveness NULL — not "dead" — for a ref whose session we cannot see', () => {
    // A known unknown. Rendering it as dead would be a lie about a session that
    // may well be running.
    const card = deriveTaskCard(
      taskRecord({ attachedSessions: [{ node: 'review', appSessionId: SESSION_ONE }] }) as never,
      {},
    );
    expect(card.latestSession).toEqual({ appSessionId: SESSION_ONE, stage: 'review', liveness: null });
  });
});

describe('groupTasksForBoard — the PROJECT SCOPE (S8·2, D42)', () => {
  const VIMES_ROOT = '/home/w/projects/infrastructure/vimes';
  const scopedBody = {
    instances: {
      [TASK_ONE]: taskRecord({ instanceId: TASK_ONE, currentNode: 'backlog', project: VIMES_ROOT }),
      [TASK_TWO]: taskRecord({
        instanceId: TASK_TWO,
        currentNode: 'backlog',
        project: `${VIMES_ROOT}/packages/ui`,
      }),
      [TASK_THREE]: taskRecord({
        instanceId: TASK_THREE,
        currentNode: 'backlog',
        // ⚠ THE TRAP, one level up: a SIBLING project whose root shares a string
        // prefix with vimes. A bare startsWith would put this card on vimes's
        // board, which is exactly what the boundary guard exists to prevent.
        project: `${VIMES_ROOT}-2`,
      }),
    },
  };

  it('keeps the project root and everything beneath it, and NOTHING from a sibling', () => {
    const scoped = groupTasksForBoard(scopedBody, {}, VIMES_ROOT);
    const taskIds = scoped.groups.flatMap((group) => group.tasks.map((card) => card.taskId));
    expect(taskIds).toContain(TASK_ONE);
    expect(taskIds).toContain(TASK_TWO);
    expect(taskIds).not.toContain(TASK_THREE);
  });

  it('scopes the COUNTS too — a header over cards nobody can see is a meter that lies', () => {
    const scoped = groupTasksForBoard(scopedBody, {}, VIMES_ROOT);
    expect(scoped.totalTasks).toBe(2);
    expect(scoped.flow.find((group) => group.stage === 'backlog')!.count).toBe(2);
  });

  it('with NO scope, the board is byte-for-byte what it always was', () => {
    // The unscoped path must stay untouched: every task, including the sibling.
    const unscoped = groupTasksForBoard(scopedBody, {});
    expect(unscoped.totalTasks).toBe(3);
    expect(groupTasksForBoard(scopedBody, {}, null)).toEqual(unscoped);
  });

  it('EXCLUDES a task with no usable projectRoot from a scoped board, keeps it unscoped', () => {
    // A boundary is proved, never assumed (D42) — a task that cannot be shown to
    // belong here does not appear here. Unscoped, it is still a task that exists.
    const body = { instances: { [TASK_ONE]: { instanceId: TASK_ONE, currentNode: 'backlog' } } };
    expect(groupTasksForBoard(body, {}, VIMES_ROOT).totalTasks).toBe(0);
    expect(groupTasksForBoard(body, {}).totalTasks).toBe(1);
  });
});

// ── S13·U3: q25 declaration introspection, read client-side ─────────────────

describe('readWorkflowRefs / workflowRefKey — the discovery half (U2b)', () => {
  const BOOT_REF = { extension: 'vimes-tasks', workflow: 'task', rev: '1.0.0' };

  it('reads the refs the index lists, in index order', () => {
    expect(readWorkflowRefs({ workflows: [{ ref: BOOT_REF }] })).toEqual([BOOT_REF]);
  });

  it('DEDUPES by ref — one fetch per ref is the whole point (F3 rider 2)', () => {
    const refs = readWorkflowRefs({
      workflows: [{ ref: BOOT_REF }, { ref: { ...BOOT_REF } }, { ref: { ...BOOT_REF, rev: '2.0.0' } }],
    });
    expect(refs).toHaveLength(2);
    expect(refs.map(workflowRefKey)).toEqual(['vimes-tasks/task/1.0.0', 'vimes-tasks/task/2.0.0']);
  });

  it('is TOTAL over hostile bodies — an unreadable index is [], never a throw', () => {
    for (const body of [
      null,
      undefined,
      7,
      'workflows',
      [],
      {},
      { workflows: null },
      { workflows: 'nope' },
      { workflows: [null, 7, 'x'] },
      { workflows: [{}] },
      { workflows: [{ ref: null }] },
      { workflows: [{ ref: { extension: 'e', workflow: 'w' } }] },
      { workflows: [{ ref: { extension: 'e', workflow: 'w', rev: 3 } }] },
    ]) {
      expect(readWorkflowRefs(body), JSON.stringify(body)).toEqual([]);
    }
  });

  it('keeps the usable entries and drops only the malformed siblings', () => {
    expect(readWorkflowRefs({ workflows: [null, { ref: BOOT_REF }, { ref: { extension: 'e' } }] })).toEqual([
      BOOT_REF,
    ]);
  });
});

describe('nodeEdgesFromDeclaration — the FULL declared table, narrowed to the board', () => {
  // A declaration body in the wire shape `GET /api/workflows/:e/:w/:r/declaration`
  // serves. ⚠ IT INCLUDES `manual-review` ROWS ON PURPOSE: the q25 route serves
  // the full declared table (unlike the retired stage-edges alias, which was
  // pre-narrowed daemon-side), so the narrowing is what this function is for.
  function declaration(edges: readonly Record<string, unknown>[]): unknown {
    return {
      ref: { extension: 'vimes-tasks', workflow: 'task', rev: '1.0.0' },
      workflow: {
        id: 'task',
        title: 'Task',
        initial: 'backlog',
        nodes: [],
        edges,
        forbidden: [{ from: 'quarantined', to: 'done', reason: 'quarantined-cannot-complete' }],
      },
    };
  }

  it('reads a node’s declared out-edges, in DECLARATION order', () => {
    const edges = nodeEdgesFromDeclaration(
      declaration([
        { from: 'review', to: 'done' },
        { from: 'review', to: 'quarantined' },
        { from: 'review', to: 'blocked-external' },
      ]),
    );
    // Declaration order, NOT the frozen wire order the retired alias imposed —
    // an accepted cosmetic delta (orchestrator ruling 2026-08-12).
    expect(edges!.review).toEqual(['done', 'quarantined', 'blocked-external']);
  });

  it('⚠ DROPS every row touching a node outside the nine the board knows', () => {
    // The manual-review rows are the reason this narrowing exists. Offering
    // `manual-review` in the move sheet would be a NEW capability (slice-13 §2)
    // AND a proposal to a node the record's own enum cannot hold.
    const edges = nodeEdgesFromDeclaration(
      declaration([
        { from: 'review', to: 'done' },
        { from: 'review', to: 'manual-review' },
        { from: 'manual-review', to: 'done' },
        { from: 'manual-review', to: 'implementing' },
      ]),
    )!;
    expect(edges.review).toEqual(['done']);
    expect(Object.keys(edges)).not.toContain('manual-review');
    for (const targets of Object.values(edges)) {
      expect(targets).not.toContain('manual-review');
    }
  });

  it('gives EVERY known stage a key, including a terminal one with no out-edges', () => {
    const edges = nodeEdgesFromDeclaration(declaration([{ from: 'backlog', to: 'planning' }]))!;
    expect(Object.keys(edges).sort()).toEqual([...KNOWN_STAGES].sort());
    expect(edges.done).toEqual([]);
    // ...and a terminal stage's empty set means the sheet offers nothing.
    expect(moveOptionsFor('done', edges)).toEqual([]);
  });

  it('dedupes a pair the expanded table lists twice — never two identical buttons', () => {
    const edges = nodeEdgesFromDeclaration(
      declaration([
        { from: 'backlog', to: 'planning' },
        { from: 'backlog', to: 'planning' },
      ]),
    )!;
    expect(edges.backlog).toEqual(['planning']);
  });

  it('is TOTAL over hostile bodies — null (a safe empty), never a throw', () => {
    for (const body of [
      null,
      undefined,
      7,
      'declaration',
      {},
      { workflow: null },
      { workflow: 'nope' },
      { workflow: {} },
      { workflow: { edges: null } },
      { workflow: { edges: 'nope' } },
    ]) {
      expect(nodeEdgesFromDeclaration(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('skips a malformed edge row without losing its well-formed siblings', () => {
    const edges = nodeEdgesFromDeclaration(
      declaration([
        { from: 'backlog', to: 'planning' },
        null as unknown as Record<string, unknown>,
        { from: 42, to: 'planning' },
        { from: 'backlog', to: null },
        { from: 'backlog' },
        { from: 'backlog', to: 'blocked-external' },
      ]),
    )!;
    expect(edges.backlog).toEqual(['planning', 'blocked-external']);
  });

  it('feeds moveOptionsFor exactly as the served table used to', () => {
    const edges = nodeEdgesFromDeclaration(
      declaration([
        { from: 'planning', to: 'plan-ready' },
        { from: 'planning', to: 'quarantined' },
        { from: 'planning', to: 'manual-review' },
      ]),
    );
    const offered = moveOptionsFor('planning', edges).map((option) => option.stage);
    expect(offered).toEqual(['plan-ready', 'quarantined']);
  });
});

// ── ASSERTION 8: the move sheet offers ONLY the LEGAL next stages (S8) ──────

describe('moveOptionsFor — the UI reflects the served edge table, the machine still decides', () => {
  it('offers exactly the SERVED legal targets for each stage — nothing more, nothing less', () => {
    for (const currentStage of Object.keys(STAGE_EDGES_FIXTURE)) {
      const offered = moveOptionsFor(currentStage, STAGE_EDGES_FIXTURE).map(
        (option) => option.stage,
      );
      expect(new Set(offered), currentStage).toEqual(
        new Set(STAGE_EDGES_FIXTURE[currentStage]),
      );
    }
  });

  it('ONLY-LEGAL-SHOWN — an edge the machine refuses is never offered', () => {
    // ⚠ THIS IS THE ASSERTION THAT STOPS A REGRESSION BACK TO "SURFACE EVERY
    // STAGE". Each case below is an edge core's state machine REFUSES, and none
    // of them may be offered from that stage.
    const illegalEdgesTheMachineRefuses: readonly (readonly [string, string])[] = [
      // `backlog` only reaches planning / blocked-external.
      ['backlog', 'done'],
      ['backlog', 'implementing'],
      ['backlog', 'review'],
      ['backlog', 'quarantined'],
      // `done` is TERMINAL — its allowed set is empty.
      ['done', 'backlog'],
      ['done', 'implementing'],
      ['done', 'review'],
      // The NAMED safety refusal: a quarantined run may not complete.
      ['quarantined', 'done'],
      // `blocked-external` is permissive but does NOT reach done.
      ['blocked-external', 'done'],
      // `implementing` does not skip review.
      ['implementing', 'done'],
      ['implementing', 'plan-ready'],
    ];
    for (const [fromStage, toStage] of illegalEdgesTheMachineRefuses) {
      const offered = moveOptionsFor(fromStage, STAGE_EDGES_FIXTURE).map((option) => option.stage);
      expect(offered, `${fromStage} → ${toStage} must NOT be offered`).not.toContain(toStage);
    }
  });

  it('null stageEdges (not loaded yet) → a safe empty, never all-stages', () => {
    for (const currentStage of KNOWN_STAGES) {
      expect(moveOptionsFor(currentStage, null), currentStage).toEqual([]);
    }
  });

  it('a stage with no entry in the served table → empty (never falls back to "everything")', () => {
    expect(moveOptionsFor('teleported', STAGE_EDGES_FIXTURE)).toEqual([]);
  });

  it("done -> [] : the terminal stage's served empty set means no options", () => {
    expect(moveOptionsFor('done', STAGE_EDGES_FIXTURE)).toEqual([]);
  });

  it('labels each option and carries its kind, so a sheet can group flow vs exception', () => {
    const options = moveOptionsFor('planning', STAGE_EDGES_FIXTURE);
    expect(options.find((option) => option.stage === 'plan-ready')?.label).toBe('Plan ready');
    expect(options.find((option) => option.stage === 'quarantined')?.kind).toBe('exception');
    expect(options.find((option) => option.stage === 'backlog')?.kind).toBe('flow');
  });
});

// ── The move sheet follows the LIVE task, not a snapshot taken at open ───────

describe('findTaskCard + moveOptionsFor — the sheet follows the LIVE task, not a snapshot', () => {
  it('re-derives destinations when the task moves stage under an open sheet', () => {
    // The sheet opens over the task while it is in `implementing`.
    const boardBefore = groupTasksForBoard(
      projectionBody(taskRecord({ instanceId: TASK_ONE, currentNode: 'implementing' })),
    );
    const snapshot = findTaskCard(boardBefore, TASK_ONE)!; // what openSheet captured
    const optionsAtOpen = moveOptionsFor(snapshot.stage, STAGE_EDGES_FIXTURE).map((option) => option.stage);
    expect(new Set(optionsAtOpen)).toEqual(new Set(STAGE_EDGES_FIXTURE.implementing));

    // The transition streams back: the projection now has the task in `review`.
    const boardAfter = groupTasksForBoard(
      projectionBody(taskRecord({ instanceId: TASK_ONE, currentNode: 'review' })),
    );

    // OLD (snapshot) behavior would keep offering `implementing`'s destinations.
    // The fix re-reads the LIVE card by id, so the options are `review`'s.
    const liveCard = findTaskCard(boardAfter, TASK_ONE)!;
    const optionsAfterMove = moveOptionsFor(liveCard.stage, STAGE_EDGES_FIXTURE).map((option) => option.stage);
    expect(liveCard.stage).toBe('review');
    expect(new Set(optionsAfterMove)).toEqual(new Set(STAGE_EDGES_FIXTURE.review));
    expect(new Set(optionsAfterMove)).not.toEqual(new Set(optionsAtOpen)); // the bug this fixes
  });

  it('returns null when the taskId is not in the board (sheet closes over a gone task)', () => {
    const board = groupTasksForBoard(projectionBody(taskRecord({ instanceId: TASK_ONE, currentNode: 'backlog' })));
    expect(findTaskCard(board, 'no-such-id')).toBeNull();
  });
});

// ── ASSERTION 9: every rejection reason gets its own honest sentence ────────

describe('describeRejectionReason / describeMoveResponse — the 409 is the feature', () => {
  // ── S13-A9: BOTH SPELLING FAMILIES, and both must render ──────────────────
  //
  // The engine's refusal reasons were respelled node-generic in S13·U1. The
  // stage-spelled ones did NOT go away: they are what every refusal recorded
  // before that unit says, forever (q21 — history is never rewritten), so the
  // sentence map keeps them as a permanent read-side alias. `illegal-edge`
  // (engine, never named a node) and `quarantined-cannot-complete` (tenant
  // content declared in the manifest's forbidden row, F2) are unchanged and
  // appear in both lists.
  const NODE_SPELLED_REASONS = [
    'illegal-edge',
    'terminal-node',
    'same-node',
    'quarantined-cannot-complete',
    'unknown-node',
  ] as const;
  const LEGACY_STAGE_SPELLED_REASONS = [
    'illegal-edge',
    'terminal-stage',
    'same-stage',
    'quarantined-cannot-complete',
    'unknown-stage',
  ] as const;

  it.each([
    ['node-spelled (the engine\'s vocabulary from S13·U1)', NODE_SPELLED_REASONS],
    ['legacy stage-spelled (what the log already holds)', LEGACY_STAGE_SPELLED_REASONS],
  ])('maps every %s reason to a DISTINCT, non-empty human sentence', (_family, reasons) => {
    const sentences = reasons.map((reason) => describeRejectionReason(reason));
    for (const [index, sentence] of sentences.entries()) {
      expect(sentence.length, reasons[index]).toBeGreaterThan(20);
      // Not the reason code echoed back at the operator as if it were English.
      expect(sentence, reasons[index]).not.toBe(reasons[index]);
      // ...and not the "no plain-words description yet" fallback either — that
      // is the whole point of having a row for it.
      expect(sentence, reasons[index]).not.toContain('no plain-words description');
    }
    expect(new Set(sentences).size, 'two reasons share a sentence').toBe(reasons.length);
  });

  it('the two spellings of one engine reason SHARE their sentence — same fact, new word', () => {
    // Deliberate, and the reason the distinctness check above is per-family:
    // `same-node` and `same-stage` are the same refusal in two vocabularies, so
    // an operator reading a historical refusal gets the identical explanation.
    expect(describeRejectionReason('same-node')).toBe(describeRejectionReason('same-stage'));
    expect(describeRejectionReason('terminal-node')).toBe(describeRejectionReason('terminal-stage'));
    expect(describeRejectionReason('unknown-node')).toBe(describeRejectionReason('unknown-stage'));
  });

  it('⚠ S13-A9 — DELETING THE LEGACY ROWS IS A REGRESSION, NOT A CLEANUP', () => {
    // This test exists to fail loudly if somebody "tidies up" the stage-spelled
    // rows out of the sentence map. Old spellings persist in the log and may
    // surface through any historical read; these rows are their permanent
    // read-side alias.
    for (const legacyReason of LEGACY_STAGE_SPELLED_REASONS) {
      const sentence = describeRejectionReason(legacyReason);
      expect(sentence, legacyReason).not.toContain('no plain-words description');
      expect(sentence, legacyReason).not.toContain(legacyReason);
    }
  });

  it('an UNRECOGNISED reason still renders something honest, never blank (rule 0.6)', () => {
    // A reason added to core after this board shipped must NOT produce an empty
    // error. It is echoed verbatim inside a sentence that says plainly that this
    // client has no words for it yet.
    const sentence = describeRejectionReason('budget-exhausted-in-a-later-slice');
    expect(sentence).toContain('budget-exhausted-in-a-later-slice');
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toBe('');
  });

  it('a MISSING or non-string reason still renders something honest', () => {
    for (const notAReason of [undefined, null, 42, {}, []]) {
      const sentence = describeRejectionReason(notAReason);
      expect(sentence.length, JSON.stringify(notAReason)).toBeGreaterThan(20);
    }
  });

  it('409 is surfaced as a REJECTION with its reason — never swallowed, never generic', () => {
    const outcome = describeMoveResponse(409, { accepted: false, reason: 'quarantined-cannot-complete' });
    expect(outcome.kind).toBe('rejected');
    expect(outcome).toMatchObject({ reason: 'quarantined-cannot-complete' });
    expect(outcome.sentence).toBe(describeRejectionReason('quarantined-cannot-complete'));
    expect(outcome.sentence).not.toContain('failed');
  });

  it('200 reports acceptance and says the board has to catch up (no optimistic move)', () => {
    const outcome = describeMoveResponse(200, { accepted: true, instance: { currentNode: 'review' } });
    expect(outcome.kind).toBe('accepted');
    expect(outcome).toMatchObject({ stage: 'review' });
    // The sentence must not claim the card has moved — the projection decides that.
    expect(outcome.sentence.toLowerCase()).toContain('catch up');
  });

  it('400 / 403 / 404 are three DISTINCT honest messages, and none says "rejected"', () => {
    const four00 = describeMoveResponse(400, { error: 'bad request' });
    const four03 = describeMoveResponse(403, { error: 'forbidden' });
    const four04 = describeMoveResponse(404, { error: 'not found' });
    for (const outcome of [four00, four03, four04]) {
      expect(outcome.kind).toBe('error');
      expect(outcome.sentence.length).toBeGreaterThan(20);
    }
    expect(new Set([four00.sentence, four03.sentence, four04.sentence]).size).toBe(3);
    // Each says nothing was written — because on all three paths nothing was.
    expect(four00.sentence.toLowerCase()).toContain('nothing was written');
    expect(four03.sentence.toLowerCase()).toContain('nothing was written');
    expect(four04.sentence.toLowerCase()).toContain('nothing was written');
  });

  it('an unexpected status renders honestly rather than guessing', () => {
    const outcome = describeMoveResponse(500, null);
    expect(outcome.kind).toBe('error');
    expect(outcome.sentence).toContain('500');
  });

  it('a request that never reached the daemon says so, and claims no refusal', () => {
    const outcome = describeMoveResponse(0, null);
    expect(outcome.kind).toBe('error');
    expect(outcome.sentence.toLowerCase()).toContain('never reached the daemon');
    expect(outcome.sentence.toLowerCase()).toContain('nothing was refused');
  });
});

describe('describeCreateResponse — creation, without mirroring the daemon’s cap', () => {
  it('201 reports creation and does NOT claim the board has updated', () => {
    const outcome = describeCreateResponse(201, { instance: { instanceId: TASK_ONE } });
    expect(outcome).toMatchObject({ kind: 'created', taskId: TASK_ONE });
    expect(outcome.sentence.toLowerCase()).toContain('catch up');
  });

  it('400 names the likely cause WITHOUT asserting a cap number', () => {
    // The cap is the daemon's policy and may change without this client
    // changing — a copy here would eventually be a confident lie. Same reasoning
    // that keeps the legality table out of the UI.
    const outcome = describeCreateResponse(400, { error: 'bad request' });
    expect(outcome.kind).toBe('error');
    expect(outcome.sentence.toLowerCase()).toContain('title');
    expect(outcome.sentence).not.toMatch(/\d{2,}/);
  });

  it('403 and a dead request are distinct, and both say nothing was written', () => {
    const forbidden = describeCreateResponse(403, { error: 'forbidden' });
    const neverSent = describeCreateResponse(0, null);
    expect(forbidden.sentence).not.toBe(neverSent.sentence);
    expect(forbidden.sentence.toLowerCase()).toContain('nothing was written');
    expect(neverSent.sentence.toLowerCase()).toContain('nothing was written');
  });
});

// ── ASSERTION 10: dispatch outcomes render distinctly ───────────────────────

describe('describeDispatchResponse — every honest outcome, distinctly', () => {
  function dispatch(result: Record<string, unknown>, status = 200) {
    return describeDispatchResponse(status, { result });
  }

  it('renders each outcome with its OWN headline and tone', () => {
    const reports = [
      dispatch({ outcome: 'spawned', appSessionId: SESSION_ONE, cwd: '/home/user/projects/vimes' }),
      dispatch({ outcome: 'deferred', reason: 'awaiting-meter-reset', meterId: 'window-5h' }),
      dispatch({ outcome: 'refused', reason: 'already-running' }),
      dispatch({ outcome: 'spawn-failed', reason: 'the host said no' }),
      dispatch({ outcome: 'worktree-failed', reason: 'worktree-create-failed: fatal: ...' }),
      dispatch({ outcome: 'in-flight' }),
    ];
    const headlines = reports.map((report) => report.headline);
    expect(new Set(headlines).size, 'two outcomes share a headline').toBe(headlines.length);
    for (const report of reports) {
      expect(report.headline.length).toBeGreaterThan(0);
    }
  });

  it('DEFERRED does not read as a failure — its own tone, its own words', () => {
    // A defer is the gate doing its job. Dressing it in failure styling would
    // train an operator to fear a healthy state.
    const report = dispatch({ outcome: 'deferred', reason: 'awaiting-meter-reset', meterId: 'window-5h' });
    expect(report.tone).toBe('waiting');
    expect(report.tone).not.toBe('failed');
    expect(report.headline.toLowerCase()).not.toContain('fail');
    expect(report.detail?.toLowerCase()).toContain('nothing has failed');
    expect(report.detail).toContain('window-5h');
  });

  it('both defer reasons are distinct, and neither is a failure', () => {
    const awaiting = dispatch({ outcome: 'deferred', reason: 'awaiting-meter-reset', meterId: 'm' });
    const unknownReset = dispatch({ outcome: 'deferred', reason: 'reset-time-unknown', meterId: 'm' });
    expect(awaiting.detail).not.toBe(unknownReset.detail);
    expect(awaiting.tone).toBe('waiting');
    expect(unknownReset.tone).toBe('waiting');
  });

  it('REFUSED carries the decision reason in plain words, one per reason', () => {
    const reasons = [
      'stage-not-dispatchable',
      'already-running',
      'headroom-insufficient',
      'headroom-unknown',
    ];
    const details = reasons.map((reason) => dispatch({ outcome: 'refused', reason }).detail);
    expect(new Set(details).size).toBe(reasons.length);
    for (const detail of details) {
      expect(detail).not.toBeNull();
      expect(detail!.length).toBeGreaterThan(20);
    }
    // headroom-unknown is NOT a synonym for headroom-insufficient, and the
    // sentence has to say so — that distinction is the whole of pillar 4 here.
    expect(dispatch({ outcome: 'refused', reason: 'headroom-unknown' }).detail).toContain(
      'NOT the same',
    );
  });

  it('an unrecognised REFUSE reason still renders honestly (rule 0.6)', () => {
    const report = dispatch({ outcome: 'refused', reason: 'brake-engaged-in-slice-7' });
    expect(report.detail).toContain('brake-engaged-in-slice-7');
    expect(report.tone).toBe('refused');
  });

  it('WORKTREE-FAILED carries git’s own words verbatim', () => {
    const gitSaid =
      "worktree-create-failed: fatal: '/home/user/projects/vimes/.claude/worktrees/x' already exists";
    const report = dispatch({ outcome: 'worktree-failed', reason: gitSaid });
    expect(report.detail).toBe(gitSaid);
    expect(report.tone).toBe('failed');
    // The safety fact the operator must not miss: nothing ran, and it did NOT
    // fall back to projectRoot.
    expect(report.headline.toLowerCase()).toContain('nothing ran');
  });

  it('SPAWN-FAILED carries the host’s own reason verbatim', () => {
    const report = dispatch({ outcome: 'spawn-failed', reason: 'sdk refused: too many sessions' });
    expect(report.detail).toBe('sdk refused: too many sessions');
    expect(report.tone).toBe('failed');
  });

  it('IN-FLIGHT (D54\'s per-task lock) reads as waiting, not refused or failed', () => {
    // A losing attempt was never judged — nothing was denied and nothing
    // failed, the concurrent winner's own result is the record. Exactly the
    // same tone rationale as `deferred`.
    const report = dispatch({ outcome: 'in-flight' });
    expect(report.tone).toBe('waiting');
    expect(report.headline.toLowerCase()).toContain('already in flight');
    expect(report.detail?.toLowerCase()).toContain('nothing was attempted');
    expect(report.idleNote).toBeNull();
  });

  it('SPAWNED says plainly that the session was told NOTHING (step 7’s open seam)', () => {
    // `composeStageInstruction` defaults to sending nothing, so a dispatched
    // session spawns and sits idle. Saying so is the difference between "this is
    // how it works today" and "it hung".
    const report = dispatch({ outcome: 'spawned', appSessionId: SESSION_ONE, cwd: '/x' });
    expect(report.tone).toBe('ok');
    expect(report.idleNote).not.toBeNull();
    expect(report.idleNote!.toLowerCase()).toContain('told nothing');
    expect(report.idleNote!.toLowerCase()).toContain('not a hang');
  });

  it('...and stops saying it once an instruction is actually delivered', () => {
    const report = dispatch({
      outcome: 'spawned',
      appSessionId: SESSION_ONE,
      cwd: '/x',
      instructionDelivery: { status: 'sent' },
    });
    expect(report.idleNote).toBeNull();
  });

  it('an UNDELIVERED instruction is its own third state, not silence', () => {
    const report = dispatch({
      outcome: 'spawned',
      appSessionId: SESSION_ONE,
      cwd: '/x',
      instructionDelivery: { status: 'not-delivered', reason: 'session busy' },
    });
    expect(report.idleNote).toContain('NOT delivered');
    expect(report.idleNote).toContain('session busy');
  });

  it('404 is its own report — nothing was attempted', () => {
    const report = describeDispatchResponse(404, { error: 'not found' });
    expect(report.outcome).toBe('unknown-task');
    expect(report.detail).toContain('nothing was attempted');
  });

  it('a request that never reached the daemon is its own report, never "spawned"', () => {
    const report = describeDispatchResponse(0, null);
    expect(report.outcome).toBe('not-sent');
    expect(report.tone).toBe('failed');
    expect(report.idleNote).toBeNull();
  });

  it('an unrecognised or missing outcome renders honestly, never as success', () => {
    for (const body of [null, {}, { result: null }, { result: { outcome: 'teleported' } }]) {
      const report = describeDispatchResponse(200, body);
      expect(report.tone, JSON.stringify(body)).toBe('unknown');
      expect(report.headline.length).toBeGreaterThan(0);
      expect(report.detail).not.toBeNull();
    }
    expect(describeDispatchResponse(200, { result: { outcome: 'teleported' } }).headline).toContain(
      'teleported',
    );
  });

  it('S7·7e — the RETIRED `resumed` / `resume-failed` vocabulary pins the honest degrade', () => {
    // D46 removed the daemon's resume path months before this unit landed, and
    // this unit deleted the two switch cases that used to read these strings
    // (taskDispatcher.ts's union variants went with them). Neither string can
    // arrive from the daemon any more, but IF one somehow did — an old client,
    // a hand-crafted request — it must fall to the SAME honest "unrecognised"
    // default any other unknown string gets, never quietly rendered as a live
    // outcome again.
    for (const outcome of ['resumed', 'resume-failed']) {
      const report = dispatch({ outcome, appSessionId: SESSION_ONE });
      expect(report.tone, outcome).toBe('unknown');
      expect(report.headline, outcome).toContain(outcome);
    }
  });
});

// ── ASSERTION 11: hostile and degenerate projection bodies ──────────────────

describe('groupTasksForBoard — hostile input never throws and never drops a task (I8)', () => {
  const degenerateBodies: readonly (readonly [string, unknown])[] = [
    ['null body', null],
    ['undefined body', undefined],
    ['a string body', 'instances'],
    ['a number body', 7],
    ['an array body', []],
    ['no instances key', { sessions: {} }],
    ['instances is null', { instances: null }],
    ['instances is an array', { instances: [] }],
    ['instances is a string', { instances: 'nope' }],
  ];

  for (const [caseName, body] of degenerateBodies) {
    it(`${caseName} → an empty but COMPLETE board, no throw`, () => {
      const board = groupTasksForBoard(body);
      expect(board.flow).toHaveLength(FLOW_STAGES.length);
      expect(board.exceptions).toHaveLength(EXCEPTION_STAGES.length);
      expect(board.unknown).toHaveLength(0);
      expect(board.totalTasks).toBe(0);
    });
  }

  it('a task with an UNKNOWN stage is VISIBLE, not vanished', () => {
    // ⚠ The one that matters. A stage core added and this UI has not learned
    // yet, or a corrupt record, must show up SOMEWHERE — a board that quietly
    // hides a task it does not understand leaves the operator no way to learn
    // the task exists at all.
    const board = groupTasksForBoard(
      projectionBody(
        taskRecord({ instanceId: TASK_ONE, currentNode: 'teleported' }),
        taskRecord({ instanceId: TASK_TWO, currentNode: 'backlog' }),
      ),
    );
    expect(board.totalTasks).toBe(2);
    expect(board.unknown).toHaveLength(1);
    expect(board.unknown[0]!.stage).toBe('teleported');
    expect(board.unknown[0]!.kind).toBe('unknown');
    expect(board.unknown[0]!.tasks.map((card) => card.taskId)).toEqual([TASK_ONE]);
    // ...and it is in `groups`, so a view that renders `groups` cannot miss it.
    expect(board.groups.map((group) => group.stage)).toContain('teleported');
    // The stage is echoed verbatim rather than replaced with "unknown" — the
    // operator needs to see what the record actually says.
    expect(board.unknown[0]!.label).toBe('teleported');
  });

  it('a task with NO stage, or a non-string stage, is still visible', () => {
    const board = groupTasksForBoard({
      instances: {
        [TASK_ONE]: { instanceId: TASK_ONE, project: '/a' },
        [TASK_TWO]: { instanceId: TASK_TWO, currentNode: 42 },
      },
    });
    expect(board.totalTasks).toBe(2);
    expect(board.unknown).toHaveLength(1);
    expect(board.unknown[0]!.stage).toBe('');
    expect(board.unknown[0]!.count).toBe(2);
    expect(board.unknown[0]!.label).toBe('(no stage recorded)');
  });

  it('a NULL task value is kept under its map key, not dropped', () => {
    const board = groupTasksForBoard({ instances: { [TASK_ONE]: null, [TASK_TWO]: 'nope' } });
    expect(board.totalTasks).toBe(2);
    const visibleIds = board.groups.flatMap((group) => group.tasks.map((card) => card.taskId));
    expect(visibleIds.sort()).toEqual([TASK_ONE, TASK_TWO].sort());
  });

  it('a record whose taskId disagrees with its map key is filed under the KEY', () => {
    // The key is the addressable one — it is what every route takes as :taskId.
    const board = groupTasksForBoard({
      instances: { [TASK_ONE]: { instanceId: 42, currentNode: 'backlog' } },
    });
    const backlog = board.flow.find((group) => group.stage === 'backlog')!;
    expect(backlog.tasks.map((card) => card.taskId)).toEqual([TASK_ONE]);
  });

  it('a record with malformed attachedSessions never throws and never guesses', () => {
    for (const malformedRefs of [null, 'nope', 42, [null], [{ appSessionId: 42 }], [{}]]) {
      const board = groupTasksForBoard(
        projectionBody(taskRecord({ attachedSessions: malformedRefs })),
      );
      const backlog = board.flow.find((group) => group.stage === 'backlog')!;
      expect(backlog.tasks, JSON.stringify(malformedRefs)).toHaveLength(1);
      expect(backlog.tasks[0]!.latestSession).toBeNull();
    }
  });

  it('walks attachedSessions BACKWARDS past a malformed tail to the last usable ref', () => {
    const board = groupTasksForBoard(
      projectionBody(
        taskRecord({
          attachedSessions: [{ node: 'planning', appSessionId: SESSION_ONE }, null, { appSessionId: 7 }],
        }),
      ),
      { [SESSION_ONE]: sessionRecord({ liveness: 'dormant' }) },
    );
    const backlog = board.flow.find((group) => group.stage === 'backlog')!;
    expect(backlog.tasks[0]!.latestSession).toEqual({
      appSessionId: SESSION_ONE,
      stage: 'planning',
      liveness: 'dormant',
    });
  });

  it('a projection body carrying EVERY hostile shape at once still boards cleanly', () => {
    const board = groupTasksForBoard({
      instances: {
        'id-null': null,
        'id-empty': {},
        'id-unknown-stage': { currentNode: 'teleported' },
        'id-bad-stage': { currentNode: [] },
        'id-good': taskRecord({ instanceId: 'id-good', currentNode: 'review', payload: { title: 'real' } }),
      },
    });
    expect(board.totalTasks).toBe(5);
    const visibleIds = board.groups.flatMap((group) => group.tasks.map((card) => card.taskId));
    expect(visibleIds.sort()).toEqual(
      ['id-null', 'id-empty', 'id-unknown-stage', 'id-bad-stage', 'id-good'].sort(),
    );
    // Every card is labelled — not one is blank.
    const allCards = board.groups.flatMap((group) => group.tasks);
    for (const card of allCards) {
      expect(card.label.length, card.taskId).toBeGreaterThan(0);
    }
  });
});

// ── ASSERTION 9: `sessionTrailOf` — `latestSessionOf`'s sibling, the WHOLE
// history rather than just the badge (S7·7g) ────────────────────────────────

describe('sessionTrailOf — the task’s full session history, oldest first', () => {
  const SESSION_PLANNING = 'dddddddd-1111-4000-8000-000000000011';
  const SESSION_IMPL_ONE = 'dddddddd-2222-4000-8000-000000000012';
  const SESSION_REVIEW_ONE = 'dddddddd-3333-4000-8000-000000000013';
  const SESSION_IMPL_TWO = 'dddddddd-4444-4000-8000-000000000014';
  const SESSION_REVIEW_TWO = 'dddddddd-5555-4000-8000-000000000015';

  it('walks a multi-stage history FORWARDS, numbering attempts per stage', () => {
    const task = taskRecord({
      attachedSessions: [
        { node: 'planning', appSessionId: SESSION_PLANNING },
        { node: 'implementing', appSessionId: SESSION_IMPL_ONE },
        { node: 'review', appSessionId: SESSION_REVIEW_ONE },
        { node: 'implementing', appSessionId: SESSION_IMPL_TWO },
        { node: 'review', appSessionId: SESSION_REVIEW_TWO },
      ],
    }) as never;

    const trail = sessionTrailOf(task, {});

    expect(trail).toEqual([
      { appSessionId: SESSION_PLANNING, stage: 'planning', attempt: 1, liveness: null },
      { appSessionId: SESSION_IMPL_ONE, stage: 'implementing', attempt: 1, liveness: null },
      { appSessionId: SESSION_REVIEW_ONE, stage: 'review', attempt: 1, liveness: null },
      { appSessionId: SESSION_IMPL_TWO, stage: 'implementing', attempt: 2, liveness: null },
      { appSessionId: SESSION_REVIEW_TWO, stage: 'review', attempt: 2, liveness: null },
    ]);
  });

  it('skips a malformed entry (no usable appSessionId) without throwing and without counting it', () => {
    const task = taskRecord({
      attachedSessions: [
        { node: 'planning', appSessionId: SESSION_PLANNING },
        null,
        { appSessionId: 7 },
        {},
        { node: 'planning' },
      ],
    }) as never;

    const trail = sessionTrailOf(task, {});

    // Only the one usable ref survives — none of the malformed siblings bump
    // its attempt number, because none of them was ever counted.
    expect(trail).toEqual([
      { appSessionId: SESSION_PLANNING, stage: 'planning', attempt: 1, liveness: null },
    ]);
  });

  it('keeps a usable id with a malformed stage — stage: "", not dropped, not guessed', () => {
    const task = taskRecord({
      attachedSessions: [{ appSessionId: SESSION_PLANNING }, { node: 42, appSessionId: SESSION_IMPL_ONE }],
    }) as never;

    const trail = sessionTrailOf(task, {});

    expect(trail).toEqual([
      { appSessionId: SESSION_PLANNING, stage: '', attempt: 1, liveness: null },
      { appSessionId: SESSION_IMPL_ONE, stage: '', attempt: 2, liveness: null },
    ]);
  });

  it('is TOTAL over hostile attachedSessions shapes — never throws, always []', () => {
    for (const malformedRefs of [null, undefined, 'nope', 42, {}]) {
      const task = taskRecord({ attachedSessions: malformedRefs }) as never;
      expect(sessionTrailOf(task, {}), JSON.stringify(malformedRefs)).toEqual([]);
    }
  });

  it('joins liveness from sessionsById — present session → its liveness, absent → null', () => {
    const task = taskRecord({
      attachedSessions: [
        { node: 'planning', appSessionId: SESSION_PLANNING },
        { node: 'implementing', appSessionId: SESSION_IMPL_ONE },
      ],
    }) as never;

    const trail = sessionTrailOf(task, {
      [SESSION_PLANNING]: sessionRecord({ appSessionId: SESSION_PLANNING, liveness: 'dormant' }),
    });

    expect(trail).toEqual([
      { appSessionId: SESSION_PLANNING, stage: 'planning', attempt: 1, liveness: 'dormant' },
      { appSessionId: SESSION_IMPL_ONE, stage: 'implementing', attempt: 1, liveness: null },
    ]);
  });
});
