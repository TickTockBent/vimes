import type { TaskRecord, TaskStage } from '../schemas.js';
import { taskStageSchema } from '../schemas.js';
import { isWithinProjectRoot } from '../projections/projects.js';

// ─── D56 — the standing orchestrator's WORDS (pure, packages/core) ────────────
//
// Pure, deterministic, no clock/IO (rule 0.3), golden-tested — the same seam
// `packages/ext-tasks/src/stageInstruction.ts` occupies for dispatched workers, and written to the
// same discipline. The daemon does the reading (the standing-notes file, the
// projections) and passes the results IN; nothing here touches disk.
//
// ⚠ **WHAT THESE TWO COMPOSERS ARE FOR IS DIFFERENT, AND SP8·2 IS WHY.** The
// spike observed that `claude --resume` recalls facts perfectly across every kill
// shape tried, and that the CLI auto-normalizes a dead turn on the next resume
// (a synthetic "Continue from where you left off." pair) — so neither of these is
// fact-recall insurance and neither reinvents interrupted-turn recovery:
//
//   • `composeOrchestratorFounding` opens a transcript that does not exist yet —
//     a first founding, or a REFOUNDING after the previous transcript died. It
//     carries the whole of the entity's durable identity (D56: the board, the
//     project, the standing notes), because the new process knows nothing.
//   • `composeOrchestratorReorientation` speaks to a transcript that is INTACT
//     and was merely resumed. It says one thing the transcript cannot: a restart
//     just happened, so check what was in flight.
//
// ⚠ The PROSE constants below are UNWRAPPED on purpose — each paragraph is one
// long source line (no mid-sentence `\n`) because template literals preserve hard
// wraps verbatim into the delivered turn; do not re-wrap them for tidiness. Same
// rule as stageInstruction.ts.

// ── the board summary (the durable state half of D56's identity model) ────────

// One task, as the orchestrator's briefing renders it. Deliberately THIN: this is
// an orientation summary, not the board — an orchestrator that needs a task's
// scope, criteria or history reads the task, and a briefing that inlined all of it
// would grow without bound as the project does.
export interface OrchestratorBoardTask {
  readonly taskId: string;
  // The leading characters of the taskId — presentation only, never a key.
  readonly shortId: string;
  // The task's title, or the untitled fallback. ABSENT vs EMPTY: a title of `''`
  // is a title someone chose and is used as-is (the `taskRecordSchema.title`
  // distinction), so only a genuinely absent one falls back.
  readonly label: string;
  readonly stage: TaskStage;
  // How many stage runs have ever been attached to this task (`sessionRefs`) —
  // the minimal "has this been attempted, and how often" signal that is actually
  // FOLDED on the record. Not a retry count and not an attempt number: nothing
  // increments it but an attachment.
  readonly sessionRunCount: number;
}

// The counts, in the stage vocabulary's own order, with the tasks themselves.
export interface OrchestratorBoardSummary {
  // The project root the summary was scoped to — carried so the composer states
  // the same directory the scoping used, rather than being handed a second one.
  readonly projectRoot: string;
  readonly taskCount: number;
  // Only stages that HAVE tasks, in `taskStageSchema` order. A board line reading
  // `done 0 · cancelled 0` is noise; a stage with nothing in it is not news.
  readonly stageCounts: ReadonlyArray<{ readonly stage: TaskStage; readonly count: number }>;
  // Ordered by taskId — deterministic, and independent of projection insertion
  // order (which is neither meaningful nor stable across a snapshot boundary).
  readonly tasks: readonly OrchestratorBoardTask[];
}

// How many leading characters of a taskId make the short id. Presentation only,
// like `FALLBACK_LABEL_ID_LENGTH` in sessionIdentity.ts, and the same width —
// and out of D79's scope for the same reason §3c gives that one (a display
// distinguisher with no estate to collision-extend against is not an addressable
// handle). These are TASK ids besides; D79 is about session ids.
const SHORT_TASK_ID_LENGTH = 8;

/**
 * The project's board, scoped and summarized for a founding briefing.
 *
 * ⚠ **SCOPING GOES THROUGH THE CORE CONTAINMENT AUTHORITY**
 * (`isWithinProjectRoot`, exported from projections/projects.ts for exactly this
 * caller). A task carries its `projectRoot` verbatim, so the question here is
 * containment, not attribution — but it is the SAME containment question
 * `projectForCwd` asks, and a second `startsWith` spelled locally is how
 * `~/projects/vimes-2` ends up on `~/projects/vimes`'s board (principle 9).
 *
 * PURE and TOTAL: strings and records in, a summary out. No clock, no IO, no
 * realpath — the roots it compares were canonicalized once, at declaration time.
 */
export function summarizeBoardForOrchestrator(
  tasks: TaskRecord[],
  projectRoot: string,
): OrchestratorBoardSummary {
  const scopedTasks = tasks
    .filter((task) => isWithinProjectRoot(task.projectRoot, projectRoot))
    // By taskId, always. `Object.values(state.tasks)` is insertion order, and a
    // briefing whose bullets reshuffle between two foundings of the same board is
    // one nobody can diff (and one no golden test can pin).
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  const countsByStage = new Map<TaskStage, number>();
  for (const task of scopedTasks) {
    countsByStage.set(task.stage, (countsByStage.get(task.stage) ?? 0) + 1);
  }

  return {
    projectRoot,
    taskCount: scopedTasks.length,
    // The vocabulary's own order (backlog → … → cancelled), so the counts line
    // reads as the board's flow rather than as whatever order tasks arrived in.
    stageCounts: taskStageSchema.options
      .map((stage) => ({ stage, count: countsByStage.get(stage) ?? 0 }))
      .filter((entry) => entry.count > 0),
    tasks: scopedTasks.map((task) => {
      const shortId = task.taskId.slice(0, SHORT_TASK_ID_LENGTH);
      return {
        taskId: task.taskId,
        shortId,
        // ⚠ Plain `untitled`, NOT stageInstruction's `untitled (<taskId>)`. There
        // the label is the only identifier in the briefing; here the bullet already
        // opens with `[<shortId>]`, so repeating the id would be noise.
        label: task.title ?? 'untitled',
        stage: task.stage,
        sessionRunCount: task.sessionRefs.length,
      };
    }),
  };
}

// ── the FOUNDING briefing ────────────────────────────────────────────────────

export interface OrchestratorFoundingInput {
  readonly projectName: string;
  readonly projectRoot: string;
  // Where the orchestrator's standing notes live. Stated so the model can write
  // them with its OWN file tools — VIMES has no notes-writing tool and (D56,
  // Phase B) deliberately does not grow one for this.
  readonly notesPath: string;
  // The notes as they are ON DISK right now, read by the daemon. Absent when the
  // file does not exist (a first founding) or could not be read — and an absent
  // note OMITS ITS WHOLE SECTION rather than rendering an empty heading, the same
  // absent-stays-absent composition every stageInstruction section follows.
  readonly standingNotes?: string;
  readonly board: OrchestratorBoardSummary;
}

// The stable OPENING — a byte-stable constant with no project-specific values, so
// it is a common PREFIX across every founding (the cache-read discipline
// stageInstruction.ts documents: a fixed prefix lets the prompt cache hit).
//
// D56, said plainly: this is a conversation partner, not a worker; and
// propose-never-transition (principle 10 / I7) from birth — verbs are grants,
// added one at a time, each individually revertible.
const FOUNDING_OPENING =
  `You are the standing orchestrator for this project — the persistent interface a human talks to about it. You are not a worker session: nothing dispatched you, no task is waiting on you, and you do not finish. You converse.

You do not move the board. Tools that let you PROPOSE work are granted to you one at a time as they are built, and even those propose — nothing you do transitions a task by itself. Until a verb is granted, the shape of the answer to "can I do that" is: say what should happen, and the human does it.`;

// ── "Your tools today" — the ANTI-CONFABULATION section (S8·6) ───────────────
//
// ⚠ **THIS SECTION EXISTS BECAUSE OF AN OBSERVED FAILURE, not as documentation**
// (rule 0.7). Walk 2, 2026-08-04: a founded orchestrator was told nothing about
// which VIMES verbs it had, saw the harness's own built-in task tools, concluded
// it had board access, and WROTE THAT WRONG BELIEF INTO ITS STANDING NOTES —
// where it would have been read back verbatim at every refounding. A capability
// belief that is never stated is a capability belief the model supplies itself.
//
// So this says three things, and each one is load-bearing: the EXACT wire name of
// what is granted, that NOTHING ELSE is, and that the harness's task tools are
// not this board. It is stated in the WIRE FORM (`mcp__vimes_board__create_task`)
// on purpose — D65 makes the server the prefix, and this is the belt to that
// braces: the model can match what it is told against what it can see.
//
// ⚠ MUST AGREE WITH THE TOOL ITSELF. The daemon's `CREATE_TASK_TOOL_DESCRIPTION`
// (createTaskTool.ts) makes the same promises about the same verb; if one drifts,
// the model is being told two different things about one tool.
//
// Byte-stable (no project-specific value), so it stays a shared prefix across
// every founding of every project — the cache-read discipline this file follows.
const FOUNDING_TOOLS_TODAY =
  `Your tools today, stated exactly — do not infer any others.

You have ONE VIMES verb: \`mcp__vimes_board__create_task\`. It authors a work-order onto this project's board, in backlog, and that is all it does. Nothing runs when you call it.

There is no other VIMES verb. No promote, no dispatch, no amend, no move, no way to change a task once it exists. Those are separate grants, added one at a time as they are built, and none of them is yours yet — so when the answer to "can you do that" is one of them, say what should happen and let the human do it.

Your harness also gives you task and todo tools of its own (TodoWrite, TaskList, TaskCreate and their siblings). Those are PRIVATE SCRATCH for your own working memory. They are not the VIMES board, nothing you write with them is visible on any screen the human looks at, and no VIMES surface reads them. Only \`mcp__vimes_board__create_task\` puts work on the board.`;

// ── The AUTHORING DOCTRINE — the quality bar the Gate-2 trial measures ────────
//
// The pivot criterion for the author grant is whether authored work-orders need
// substantial human rewrite MORE OFTEN THAN NOT. That is a question about
// WORK-ORDER QUALITY, so the bar is stated to the author rather than inferred by
// it — an orchestrator that writes vague criteria because nobody told it what a
// checkable one is has been failed by this briefing, not by the model.
//
// Every line is D43's "a task IS a work-order" made operational, and the closing
// line is the same sentence the tool's own acknowledgement returns, deliberately:
// the boundary of the grant is worth hearing twice.
//
// Byte-stable, for the same prefix reason as the section above it.
const FOUNDING_AUTHORING_DOCTRINE =
  `When you author, you are writing a work-order, not a wish. Somebody else builds from it without asking you what you meant, and a reviewer grades against it without asking you what you had in mind. Write it so both of those are possible.

  Scope — precise enough to build from. Name the change, not the aspiration.
  Explicitly out — what a reasonable implementer might wrongly include. This is the field that prevents scope creep, so it is worth thinking about what someone would plausibly get wrong.
  Acceptance criteria — each one INDEPENDENTLY CHECKABLE. A reviewer must be able to answer pass or fail without interpreting your intent. "Works correctly" is not a criterion; "the endpoint returns 409 for an archived project" is.
  Kill criterion — a REAL observation that would stop the work, not a restatement of "it didn't work". It names the thing you might find that means this approach is wrong and the plan needs a decision rather than another attempt.

Your authoring ends at backlog. Promotion is Wes's call, made from the board.`;

// The standing-notes contract — the D56 identity model stated to the entity it is
// about. Byte-stable (the path itself rides in the header block above it, so this
// constant stays a shared prefix across projects as well as across foundings).
const FOUNDING_NOTES_CONTRACT =
  `Your transcript is a rotating vessel, not your identity. It fills up, it gets compacted, and eventually it is replaced outright — when that happens a fresh session opens with this same briefing. What persists is the board, this project's own documents, and your standing notes file at the path above. Those are what make you the same orchestrator tomorrow.

So bank continuously rather than at the end: whenever you decide something, learn how this project actually works, or leave something half-finished, write it into that notes file with your own file tools. Anything that lives only in this conversation is gone at the next rotation. Keep the file CURRENT — it is read back to you verbatim at every refounding, so a stale note costs more than a missing one.`;

// The stable CLOSING. Deliberately short: a founding ends by handing the floor
// back, because the next thing that happens is a human talking.
const FOUNDING_CLOSING =
  `Read whatever you need before answering — the board above names the work, your notes carry what you already knew about it. Then pick the conversation up where it left off.`;

/**
 * The founding message for a standing orchestrator's transcript — first founding
 * and refounding alike (D56). Composed as an ordered list of BLOCKS joined by a
 * single blank line: no block carries a leading or trailing blank line and the
 * join owns every gap, so the spacing stays deterministic whichever conditional
 * sections are present (the stageInstruction.ts composition rule).
 *
 * PURE: every fact it needs is passed in.
 */
export function composeOrchestratorFounding(input: OrchestratorFoundingInput): string {
  const foundingBlocks: string[] = [];

  foundingBlocks.push(
    `${FOUNDING_OPENING}

  Project:   ${input.projectName}
  Directory: ${input.projectRoot}
  Notes:     ${input.notesPath}`,
  );

  // S8·6, and the ORDER is chosen: what you can do, then how to do it well, then
  // what persists, then the board. The opening block above ends on "until a verb
  // is granted, say what should happen and let the human do it" — so the verb
  // that IS granted belongs immediately after it, before the model has a chance
  // to fill the gap itself (the walk-2 failure).
  foundingBlocks.push(FOUNDING_TOOLS_TODAY);
  foundingBlocks.push(FOUNDING_AUTHORING_DOCTRINE);
  foundingBlocks.push(FOUNDING_NOTES_CONTRACT);
  foundingBlocks.push(renderBoardBlock(input.board));

  // ⚠ ABSENT vs EMPTY, and the empty case is real: a notes file that exists but
  // holds only whitespace carries no content, so it omits the section exactly as a
  // missing file does — the section heading promises notes below it.
  const standingNotes = input.standingNotes;
  if (typeof standingNotes === 'string' && standingNotes.trim().length > 0) {
    // VERBATIM — the orchestrator's own words, handed back unedited. No trimming
    // beyond the trailing newline the file almost certainly ends with (which would
    // otherwise show up as a blank line inside the block and drift the golden with
    // the editor that last saved the file), no reflowing, no truncation. If these
    // ever need a size bound it belongs at the daemon's read, where the bytes are.
    foundingBlocks.push(
      `Your standing notes, as you last left them:\n\n${standingNotes.replace(/\n+$/, '')}`,
    );
  }

  foundingBlocks.push(FOUNDING_CLOSING);

  return foundingBlocks.join('\n\n');
}

// The board block. An empty board is a SENTENCE, not an empty list — a heading
// with nothing under it reads as a rendering failure.
function renderBoardBlock(board: OrchestratorBoardSummary): string {
  if (board.taskCount === 0) {
    return `The board is empty — this project has no tasks yet.`;
  }
  const countsLine = board.stageCounts
    .map((entry) => `${entry.stage} ${entry.count}`)
    // U+00B7 MIDDLE DOT, the separator core already uses for compact labels
    // (sessionIdentity.ts) — printable, quiet, never a control byte.
    .join(' · ');
  const taskBullets = board.tasks
    .map((task) => {
      // Omitted entirely at zero — "0 stage runs" is a fact about nothing, and a
      // never-attempted task is the ordinary case on a fresh board.
      const runs =
        task.sessionRunCount === 0
          ? ''
          : `, ${task.sessionRunCount} stage run${task.sessionRunCount === 1 ? '' : 's'}`;
      return `  - [${task.shortId}] ${task.label} — ${task.stage}${runs}`;
    })
    .join('\n');
  const taskWord = board.taskCount === 1 ? 'task' : 'tasks';
  return `The board as it stands — ${board.taskCount} ${taskWord} (${countsLine}):\n${taskBullets}`;
}

// ── the REORIENTATION turn ───────────────────────────────────────────────────

export interface OrchestratorReorientationInput {
  readonly projectName: string;
  readonly notesPath: string;
}

/**
 * The short turn sent to a RESUMED orchestrator whose transcript survived a daemon
 * restart. Deliberately a few lines, and deliberately NOT a second founding.
 *
 * ⚠ **WHAT IT DOES NOT DO IS THE POINT (SP8·2).** It does not re-state identity,
 * re-list the board, or re-read the notes into context — the transcript already
 * holds all of that, with observed-perfect recall through every kill shape the
 * spike tried. It does not detect or paper over an interrupted turn either: the
 * CLI auto-inserts its own recovery pair on resume, for SIGTERM and SIGKILL deaths
 * alike, and a second recovery story layered on top of that would be VIMES
 * describing a mechanism it does not own (rule 0.7).
 *
 * What it says is the one thing the transcript cannot: a restart happened between
 * the last turn and this one, so work that was in flight may not be any more.
 */
export function composeOrchestratorReorientation(input: OrchestratorReorientationInput): string {
  return `The VIMES daemon restarted, and your session for ${input.projectName} was resumed. Your transcript is intact — everything said before this line is still here.

What a restart interrupts is work in flight. Before you carry on, check whether anything you dispatched or were waiting on is still running, and whether your own last turn left something half-done — if it did, say so rather than continuing as though it had finished.

Your standing notes are at ${input.notesPath}.`;
}
