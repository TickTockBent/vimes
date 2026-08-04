import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../schemas.js';
import {
  composeOrchestratorFounding,
  composeOrchestratorReorientation,
  summarizeBoardForOrchestrator,
} from './founding.js';

// ─── D56 — the standing orchestrator's words + its board summary ─────────────
//
// The same posture stageInstruction.test.ts takes: this is the ONLY unit that
// pins the actual prose (rule 0.2 applied to words rather than numbers), plus
// determinism (no clock, no randomness — the same input must produce a
// byte-identical string forever) and totality over shapes a replayed record can
// really have.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const NOTES_PATH = '/home/ticktockbent/.vimes/orchestrator-notes/project-1.md';

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
    projectRoot: PROJECT_ROOT,
    title: 'Fix the widget',
    stage: 'backlog',
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

const EMPTY_BOARD = summarizeBoardForOrchestrator([], PROJECT_ROOT);

describe('summarizeBoardForOrchestrator — scoping', () => {
  it('keeps a task whose projectRoot IS the project root, and one beneath it', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({ taskId: 'a', projectRoot: PROJECT_ROOT }),
        taskRecord({ taskId: 'b', projectRoot: `${PROJECT_ROOT}/packages/core` }),
      ],
      PROJECT_ROOT,
    );
    expect(board.tasks.map((task) => task.taskId)).toEqual(['a', 'b']);
  });

  // ⚠ THE `vimes` / `vimes-2` TRAP, pinned at THIS call site. A bare
  // `startsWith` would put the sibling project's tasks on this project's board;
  // the scoping goes through the core containment authority precisely so it
  // cannot.
  it('never swallows a SIBLING directory that shares the root as a prefix', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({ taskId: 'mine', projectRoot: PROJECT_ROOT }),
        taskRecord({ taskId: 'sibling', projectRoot: `${PROJECT_ROOT}-2` }),
        taskRecord({ taskId: 'sibling-child', projectRoot: `${PROJECT_ROOT}-2/packages` }),
      ],
      PROJECT_ROOT,
    );
    expect(board.tasks.map((task) => task.taskId)).toEqual(['mine']);
  });

  it('excludes a task from an unrelated project entirely', () => {
    const board = summarizeBoardForOrchestrator(
      [taskRecord({ taskId: 'elsewhere', projectRoot: '/home/ticktockbent/projects/johnny' })],
      PROJECT_ROOT,
    );
    expect(board.tasks).toEqual([]);
    expect(board.taskCount).toBe(0);
  });
});

describe('summarizeBoardForOrchestrator — shape', () => {
  it('orders by taskId regardless of the order it was handed', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({ taskId: 'ccc' }),
        taskRecord({ taskId: 'aaa' }),
        taskRecord({ taskId: 'bbb' }),
      ],
      PROJECT_ROOT,
    );
    expect(board.tasks.map((task) => task.taskId)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('counts per stage in the stage vocabulary order, omitting empty stages', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({ taskId: 'a', stage: 'review' }),
        taskRecord({ taskId: 'b', stage: 'backlog' }),
        taskRecord({ taskId: 'c', stage: 'backlog' }),
        taskRecord({ taskId: 'd', stage: 'implementing' }),
      ],
      PROJECT_ROOT,
    );
    expect(board.stageCounts).toEqual([
      { stage: 'backlog', count: 2 },
      { stage: 'implementing', count: 1 },
      { stage: 'review', count: 1 },
    ]);
    expect(board.taskCount).toBe(4);
  });

  it('falls back to "untitled" only when the title is ABSENT — `` is a chosen title', () => {
    const untitled = taskRecord({ taskId: 'a' });
    delete (untitled as { title?: string }).title;
    const board = summarizeBoardForOrchestrator(
      [untitled, taskRecord({ taskId: 'b', title: '' })],
      PROJECT_ROOT,
    );
    expect(board.tasks[0]!.label).toBe('untitled');
    expect(board.tasks[1]!.label).toBe('');
  });

  it('shortens the taskId to eight characters and counts attached stage runs', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({
          taskId: '25f9c558-1111-4000-8000-000000000001',
          sessionRefs: [
            { stage: 'planning', appSessionId: 's1' },
            { stage: 'implementing', appSessionId: 's2' },
          ],
        }),
      ],
      PROJECT_ROOT,
    );
    expect(board.tasks[0]!.shortId).toBe('25f9c558');
    expect(board.tasks[0]!.sessionRunCount).toBe(2);
  });

  it('carries the project root it scoped to', () => {
    expect(summarizeBoardForOrchestrator([], PROJECT_ROOT).projectRoot).toBe(PROJECT_ROOT);
  });
});

describe('composeOrchestratorFounding — the identity contract (D56)', () => {
  it('states what the orchestrator IS, and that it never moves the board', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    });
    expect(founding).toContain(
      'You are the standing orchestrator for this project — the persistent interface a human talks to about it.',
    );
    expect(founding).toContain('You do not move the board.');
    expect(founding).toContain(
      'Tools that let you PROPOSE work are granted to you one at a time as they are built',
    );
  });

  it('states the transcript-rotates / notes-are-durable contract', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    });
    expect(founding).toContain('Your transcript is a rotating vessel, not your identity.');
    expect(founding).toContain('So bank continuously rather than at the end');
  });

  it('names the project, the directory and the notes path in the header block', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    });
    expect(founding).toContain('  Project:   vimes');
    expect(founding).toContain(`  Directory: ${PROJECT_ROOT}`);
    expect(founding).toContain(`  Notes:     ${NOTES_PATH}`);
  });
});

// ─── S8·6 — the two sections the walk-2 finding earned ───────────────────────
//
// These are CONTENT assertions, not golden ones (the goldens above already pin
// the bytes). What they pin is the promises: a wrong wire name, a section that
// stopped naming the harness tools, or a doctrine that lost "independently
// checkable" would all keep the golden honest only by changing it — these fail
// on the meaning instead.
describe('composeOrchestratorFounding — "your tools today" (the anti-confabulation section)', () => {
  const founding = composeOrchestratorFounding({
    projectName: 'vimes',
    projectRoot: PROJECT_ROOT,
    notesPath: NOTES_PATH,
    board: EMPTY_BOARD,
  });

  it('names the EXACT wire name of the one granted verb (D65)', () => {
    // The wire form, not the bare tool name: `mcp__<server>__<tool>` is what the
    // model actually sees, so it is what it is told. If D65's server name ever
    // moves, this and the daemon's spec must move together.
    expect(founding).toContain('`mcp__vimes_board__create_task`');
  });

  it('states that NO other VIMES verb is granted, naming the ones that are not', () => {
    expect(founding).toContain('There is no other VIMES verb.');
    expect(founding).toContain('No promote, no dispatch, no amend, no move');
  });

  it('states that the harness task tools are PRIVATE SCRATCH, not the board', () => {
    // The walk-2 failure verbatim: the orchestrator conflated its harness TaskList
    // with board access and banked that belief in its notes.
    expect(founding).toContain('PRIVATE SCRATCH');
    expect(founding).toContain('They are not the VIMES board');
    expect(founding).toContain('no VIMES surface reads them');
  });

  it('says the granted verb runs nothing', () => {
    expect(founding).toContain('Nothing runs when you call it.');
  });
});

describe('composeOrchestratorFounding — the authoring doctrine (the Gate-2 bar)', () => {
  const founding = composeOrchestratorFounding({
    projectName: 'vimes',
    projectRoot: PROJECT_ROOT,
    notesPath: NOTES_PATH,
    board: EMPTY_BOARD,
  });

  it('names all four work-order fields the schema demands', () => {
    expect(founding).toContain('  Scope —');
    expect(founding).toContain('  Explicitly out —');
    expect(founding).toContain('  Acceptance criteria —');
    expect(founding).toContain('  Kill criterion —');
  });

  it('demands INDEPENDENTLY CHECKABLE criteria, with the pass/fail test spelled out', () => {
    expect(founding).toContain('INDEPENDENTLY CHECKABLE');
    expect(founding).toContain('answer pass or fail without interpreting your intent');
  });

  it('demands a REAL kill observation, not a restatement of failure', () => {
    expect(founding).toContain('a REAL observation that would stop the work');
    expect(founding).toContain(`not a restatement of "it didn't work"`);
  });

  it('closes on the boundary of the grant — authoring ends at backlog', () => {
    // ⚠ THE SAME SENTENCE THE TOOL'S OWN ACKNOWLEDGEMENT RETURNS
    // (`createTaskAcknowledgement`, daemon). Deliberate repetition: the briefing
    // says it once at founding, the tool says it back at every call.
    expect(founding).toContain(
      "Your authoring ends at backlog. Promotion is Wes's call, made from the board.",
    );
  });
});

describe('composeOrchestratorFounding — the standing-notes section', () => {
  it('renders the notes VERBATIM under their heading when present', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      standingNotes: '# where I left off\n\n- D56 is settled; S8·3 is the build.\n',
      board: EMPTY_BOARD,
    });
    expect(founding).toContain(
      'Your standing notes, as you last left them:\n\n# where I left off\n\n- D56 is settled; S8·3 is the build.\n\n',
    );
  });

  // ABSENT-STAYS-ABSENT: the section is OMITTED, never rendered empty.
  it('omits the whole section when the notes are ABSENT', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    });
    expect(founding).not.toContain('Your standing notes, as you last left them');
  });

  it('omits it for a whitespace-only file too — no content is no section', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      standingNotes: '\n\n   \n',
      board: EMPTY_BOARD,
    });
    expect(founding).not.toContain('Your standing notes, as you last left them');
  });

  it('an absent-notes founding is byte-identical to one passed no notes key at all', () => {
    const input = {
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    };
    expect(composeOrchestratorFounding({ ...input, standingNotes: undefined })).toBe(
      composeOrchestratorFounding(input),
    );
  });
});

describe('composeOrchestratorFounding — the board block', () => {
  it('renders an EMPTY board as a sentence, never an empty list', () => {
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board: EMPTY_BOARD,
    });
    expect(founding).toContain('The board is empty — this project has no tasks yet.');
  });

  it('renders counts and one bullet per task, runs shown only when there are any', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({ taskId: 'aaaaaaaa-1', title: 'the queue run', stage: 'backlog' }),
        taskRecord({
          taskId: 'bbbbbbbb-2',
          title: 'the fix loop',
          stage: 'implementing',
          sessionRefs: [{ stage: 'implementing', appSessionId: 's1' }],
        }),
      ],
      PROJECT_ROOT,
    );
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board,
    });
    expect(founding).toContain(
      'The board as it stands — 2 tasks (backlog 1 · implementing 1):\n  - [aaaaaaaa] the queue run — backlog\n  - [bbbbbbbb] the fix loop — implementing, 1 stage run',
    );
  });

  it('singularizes the task word and pluralizes the run word', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({
          taskId: 'aaaaaaaa-1',
          title: 'one',
          sessionRefs: [
            { stage: 'planning', appSessionId: 's1' },
            { stage: 'implementing', appSessionId: 's2' },
          ],
        }),
      ],
      PROJECT_ROOT,
    );
    const founding = composeOrchestratorFounding({
      projectName: 'vimes',
      projectRoot: PROJECT_ROOT,
      notesPath: NOTES_PATH,
      board,
    });
    expect(founding).toContain('The board as it stands — 1 task (backlog 1):');
    expect(founding).toContain('  - [aaaaaaaa] one — backlog, 2 stage runs');
  });
});

describe('composeOrchestratorFounding — the golden', () => {
  it('is byte-identical, in full, WITHOUT notes', () => {
    const board = summarizeBoardForOrchestrator(
      [
        taskRecord({
          taskId: 'aaaaaaaa-1',
          title: 'the queue run',
          stage: 'backlog',
          projectRoot: '/home/foo',
        }),
      ],
      '/home/foo',
    );
    expect(
      composeOrchestratorFounding({
        projectName: 'foo',
        projectRoot: '/home/foo',
        notesPath: '/home/notes/foo.md',
        board,
      }),
    ).toBe(
      `You are the standing orchestrator for this project — the persistent interface a human talks to about it. You are not a worker session: nothing dispatched you, no task is waiting on you, and you do not finish. You converse.

You do not move the board. Tools that let you PROPOSE work are granted to you one at a time as they are built, and even those propose — nothing you do transitions a task by itself. Until a verb is granted, the shape of the answer to "can I do that" is: say what should happen, and the human does it.

  Project:   foo
  Directory: /home/foo
  Notes:     /home/notes/foo.md

Your tools today, stated exactly — do not infer any others.

You have ONE VIMES verb: \`mcp__vimes_board__create_task\`. It authors a work-order onto this project's board, in backlog, and that is all it does. Nothing runs when you call it.

There is no other VIMES verb. No promote, no dispatch, no amend, no move, no way to change a task once it exists. Those are separate grants, added one at a time as they are built, and none of them is yours yet — so when the answer to "can you do that" is one of them, say what should happen and let the human do it.

Your harness also gives you task and todo tools of its own (TodoWrite, TaskList, TaskCreate and their siblings). Those are PRIVATE SCRATCH for your own working memory. They are not the VIMES board, nothing you write with them is visible on any screen the human looks at, and no VIMES surface reads them. Only \`mcp__vimes_board__create_task\` puts work on the board.

When you author, you are writing a work-order, not a wish. Somebody else builds from it without asking you what you meant, and a reviewer grades against it without asking you what you had in mind. Write it so both of those are possible.

  Scope — precise enough to build from. Name the change, not the aspiration.
  Explicitly out — what a reasonable implementer might wrongly include. This is the field that prevents scope creep, so it is worth thinking about what someone would plausibly get wrong.
  Acceptance criteria — each one INDEPENDENTLY CHECKABLE. A reviewer must be able to answer pass or fail without interpreting your intent. "Works correctly" is not a criterion; "the endpoint returns 409 for an archived project" is.
  Kill criterion — a REAL observation that would stop the work, not a restatement of "it didn't work". It names the thing you might find that means this approach is wrong and the plan needs a decision rather than another attempt.

Your authoring ends at backlog. Promotion is Wes's call, made from the board.

Your transcript is a rotating vessel, not your identity. It fills up, it gets compacted, and eventually it is replaced outright — when that happens a fresh session opens with this same briefing. What persists is the board, this project's own documents, and your standing notes file at the path above. Those are what make you the same orchestrator tomorrow.

So bank continuously rather than at the end: whenever you decide something, learn how this project actually works, or leave something half-finished, write it into that notes file with your own file tools. Anything that lives only in this conversation is gone at the next rotation. Keep the file CURRENT — it is read back to you verbatim at every refounding, so a stale note costs more than a missing one.

The board as it stands — 1 task (backlog 1):
  - [aaaaaaaa] the queue run — backlog

Read whatever you need before answering — the board above names the work, your notes carry what you already knew about it. Then pick the conversation up where it left off.`,
    );
  });

  it('is byte-identical, in full, WITH notes (the section sits before the closing)', () => {
    expect(
      composeOrchestratorFounding({
        projectName: 'foo',
        projectRoot: '/home/foo',
        notesPath: '/home/notes/foo.md',
        standingNotes: 'banked: the ledger ingest is idempotent.\n',
        board: summarizeBoardForOrchestrator([], '/home/foo'),
      }),
    ).toBe(
      `You are the standing orchestrator for this project — the persistent interface a human talks to about it. You are not a worker session: nothing dispatched you, no task is waiting on you, and you do not finish. You converse.

You do not move the board. Tools that let you PROPOSE work are granted to you one at a time as they are built, and even those propose — nothing you do transitions a task by itself. Until a verb is granted, the shape of the answer to "can I do that" is: say what should happen, and the human does it.

  Project:   foo
  Directory: /home/foo
  Notes:     /home/notes/foo.md

Your tools today, stated exactly — do not infer any others.

You have ONE VIMES verb: \`mcp__vimes_board__create_task\`. It authors a work-order onto this project's board, in backlog, and that is all it does. Nothing runs when you call it.

There is no other VIMES verb. No promote, no dispatch, no amend, no move, no way to change a task once it exists. Those are separate grants, added one at a time as they are built, and none of them is yours yet — so when the answer to "can you do that" is one of them, say what should happen and let the human do it.

Your harness also gives you task and todo tools of its own (TodoWrite, TaskList, TaskCreate and their siblings). Those are PRIVATE SCRATCH for your own working memory. They are not the VIMES board, nothing you write with them is visible on any screen the human looks at, and no VIMES surface reads them. Only \`mcp__vimes_board__create_task\` puts work on the board.

When you author, you are writing a work-order, not a wish. Somebody else builds from it without asking you what you meant, and a reviewer grades against it without asking you what you had in mind. Write it so both of those are possible.

  Scope — precise enough to build from. Name the change, not the aspiration.
  Explicitly out — what a reasonable implementer might wrongly include. This is the field that prevents scope creep, so it is worth thinking about what someone would plausibly get wrong.
  Acceptance criteria — each one INDEPENDENTLY CHECKABLE. A reviewer must be able to answer pass or fail without interpreting your intent. "Works correctly" is not a criterion; "the endpoint returns 409 for an archived project" is.
  Kill criterion — a REAL observation that would stop the work, not a restatement of "it didn't work". It names the thing you might find that means this approach is wrong and the plan needs a decision rather than another attempt.

Your authoring ends at backlog. Promotion is Wes's call, made from the board.

Your transcript is a rotating vessel, not your identity. It fills up, it gets compacted, and eventually it is replaced outright — when that happens a fresh session opens with this same briefing. What persists is the board, this project's own documents, and your standing notes file at the path above. Those are what make you the same orchestrator tomorrow.

So bank continuously rather than at the end: whenever you decide something, learn how this project actually works, or leave something half-finished, write it into that notes file with your own file tools. Anything that lives only in this conversation is gone at the next rotation. Keep the file CURRENT — it is read back to you verbatim at every refounding, so a stale note costs more than a missing one.

The board is empty — this project has no tasks yet.

Your standing notes, as you last left them:

banked: the ledger ingest is idempotent.

Read whatever you need before answering — the board above names the work, your notes carry what you already knew about it. Then pick the conversation up where it left off.`,
    );
  });

  it('is deterministic — the same input composes the same bytes twice', () => {
    const input = {
      projectName: 'foo',
      projectRoot: '/home/foo',
      notesPath: '/home/notes/foo.md',
      board: EMPTY_BOARD,
    };
    expect(composeOrchestratorFounding(input)).toBe(composeOrchestratorFounding(input));
  });
});

describe('composeOrchestratorReorientation', () => {
  // ⚠ SP8·2: this is ORIENTATION, not fact recall and not interrupted-turn
  // recovery (the CLI does that itself). The golden is what keeps it that way.
  it('is byte-identical, in full', () => {
    expect(
      composeOrchestratorReorientation({
        projectName: 'foo',
        notesPath: '/home/notes/foo.md',
      }),
    ).toBe(
      `The VIMES daemon restarted, and your session for foo was resumed. Your transcript is intact — everything said before this line is still here.

What a restart interrupts is work in flight. Before you carry on, check whether anything you dispatched or were waiting on is still running, and whether your own last turn left something half-done — if it did, say so rather than continuing as though it had finished.

Your standing notes are at /home/notes/foo.md.`,
    );
  });

  it('is short — a handful of lines, not a second founding', () => {
    const reorientation = composeOrchestratorReorientation({
      projectName: 'foo',
      notesPath: '/home/notes/foo.md',
    });
    expect(reorientation.split('\n').length).toBeLessThan(8);
    expect(reorientation).not.toContain('You are the standing orchestrator');
    expect(reorientation).not.toContain('The board as it stands');
  });
});
