import { z } from 'zod';
import { createTaskToolPayloadSchema, type CreateTaskToolPayload } from '@vimes/core';
import type { SdkReportToolSpec } from './sessionHost.js';
import type { CreateInstanceInput } from './instanceWriter.js';

// ─── S8·6 — the AUTHOR GRANT: `create_task` on the D52 tool channel ───────────
//
// D56's first verb. A standing orchestrator may AUTHOR a work-order onto its own
// project's board; it may not promote it, dispatch it, amend it or move it. This
// module builds the SDK-agnostic spec for that one verb — the same plain
// `{ name, description, inputSchema, handler }` shape `buildReviewSpec` /
// `buildCompletionSpec` produce, so it rides the S7·6b channel with no new
// mechanism (the SDK is still touched in exactly one place, the query factory).
//
// ⚠ **WHY THIS LIVES IN ITS OWN FILE AND NOT BESIDE THE REPORT SPECS.** The two
// report specs are ADAPTER methods because everything they need is already on the
// adapter's services (`onReviewReported` / `onCompletionReported` — observe and
// propose, nothing more). This one needs the TASK WRITER and the PROJECT
// REGISTRY, and putting either inside `sessionHost.ts` would make the session
// host a reader of task state. It is not one, and the D18 boundary is the reason
// the dispatcher exists at all. So the capability is composed at `app.ts`, where
// every other cross-module wire is made, and handed in.
//
// ⚠ **I7, STRUCTURALLY — READ `CreateTaskToolDeps` BEFORE WIDENING IT.** The
// handler closure receives ONE capability, `createTask`, and NOT the
// `InstanceWriter`. That is not tidiness: a closure holding the writer could call
// `proposeMove` or `revisePayload`, and "the orchestrator cannot move
// the board" would then be a property of this file's current text rather than of
// its types. As written, the drive verbs are UNREACHABLE from here — the compiler
// says so. When a drive verb IS granted (S8·7+, one individually-revertible grant
// at a time, D56), it arrives as its own named capability on its own spec, never
// by widening this one to the whole writer.
//
// ⚠ NO CLOCK, NO TIMER, NO `Date.now()`, NO fs. The handler runs to completion
// inside the tool call that invoked it.

export interface CreateTaskToolDeps {
  // THE ONE CAPABILITY (see the I7 note above). Composed at `app.ts` off the
  // daemon's single `InstanceWriter` instance — the same writer the HTTP create
  // door uses, never a second write path (principle 10).
  readonly createTask: (input: CreateInstanceInput) => { readonly taskId: string };
  // The orchestrator's project ROOT, read FRESH on every call and never captured
  // at spawn time. D42 roots are editable and projects are archivable, so a root
  // closed over at founding could be hours stale by the time the model authors
  // against it; reading through the registry means an edited root binds the task
  // to where the project actually is now. `undefined` = the registry no longer
  // knows this project, which REFUSES the call (see the handler).
  readonly resolveProjectRoot: () => string | undefined;
}

// ── the forced fields (principle 13) ─────────────────────────────────────────
//
// What the daemon decides and the model may not name. The payload schema
// (`createTaskToolPayloadSchema`, core) makes naming any of them a validation
// error; these constants are the values that go in their place.
//
// `backlog` because promotion is a human's decision made from the board (D53) —
// an author grant that could land work in `planning` would be a dispatch grant
// wearing a different name.
const AUTHORED_TASK_STAGE = 'backlog' as const;
// `orchestrator` because provenance is an observation, not a claim. It is also
// the pivot criterion's only handle: Gate 2 measures how often ORCHESTRATOR-
// authored work-orders need a human rewrite, and a caller that could name its own
// `createdBy` could quietly poison that measurement.
const AUTHORED_TASK_CREATED_BY = 'orchestrator' as const;
// ⚠ **READ FROM THE HUMAN DOOR, NOT INVENTED.** `createTaskBodySchema.isolation`
// (taskApi.ts) defaults to `'worktree'`, so a task a human creates without saying
// anything about isolation gets `'worktree'` — and an authored one gets the same,
// because the two doors must produce the same KIND of record. If that default
// ever moves, this constant moves with it; they are one decision in two places
// only because the model's door and the human's door do not share a schema.
const AUTHORED_TASK_ISOLATION = 'worktree' as const;

// ── the ADVERTISED input shape (the zod v3/v4 boundary) ──────────────────────
//
// ⚠ RESTATED IN THE DAEMON'S v4 ZOD, NOT IMPORTED FROM CORE, and this is the
// S7·6b finding applied a third time (D52 finding 2): `packages/core` validates
// with zod **v3**, the daemon tree and the Agent SDK use zod **v4**. Handing
// core's schema OBJECT to the SDK's `tool()` throws at construction, and passing
// its raw shape converts to a broken JSON schema at query time. So this is the
// shape the MODEL SEES, restated here, and BOUND to core at the type level below.
//
// It is deliberately LOOSER than core's: no `.min(1)`, no `.strict()`. The split
// is the design. This shape is a DESCRIPTION handed to the model (what fields
// exist, of what type); the AUTHORITY is `createTaskToolPayloadSchema`, run
// inside the handler. Advertising the constraints here would only mean a hostile
// or confused payload got rejected by the SDK's own wrapper with the SDK's own
// words — instead of by VIMES, with a sentence naming the field, which is the
// whole point of validating in-run (D44's retry locality).
const createTaskInputShape = {
  title: z.string(),
  scope: z.string(),
  explicitlyOut: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.object({ text: z.string() })),
  killCriterion: z.string(),
} satisfies z.ZodRawShape;

type CreateTaskAdvertisedInput = z.infer<z.ZodObject<typeof createTaskInputShape>>;
// Drift bind (both directions = structural equivalence with core), the same guard
// the two report shapes carry in sessionHost.ts: if `createTaskToolPayloadSchema`
// gains, loses or renames a field, ONE of these two stops compiling and the build
// fails here — rather than a live orchestrator being advertised a field VIMES no
// longer accepts.
const _advertisedMatchesCore = {} as CreateTaskAdvertisedInput satisfies CreateTaskToolPayload;
const _coreMatchesAdvertised = {} as CreateTaskToolPayload satisfies CreateTaskAdvertisedInput;
void _advertisedMatchesCore;
void _coreMatchesAdvertised;

// ⚠ LOAD-BEARING PROSE, and it must AGREE WITH THE BRIEFING. The founding
// briefing's "your tools today" section (core `founding.ts`) names this tool and
// makes the same two promises — authors into backlog, moves nothing — so if one
// drifts the model is being told two different things about the same verb.
//
// It states what the tool does NOT do as plainly as what it does, because the
// walk-2 finding was a model inventing a capability it had not been given: the
// cheapest defence against that is a description that closes the door explicitly.
const CREATE_TASK_TOOL_DESCRIPTION =
  'Author a new work-order onto this project\'s VIMES board. It lands in BACKLOG and nothing runs: ' +
  'this tool does not promote, dispatch, review or amend anything, and there is no tool that lets ' +
  'you do those. The project, the stage, the isolation mode and the provenance are set by VIMES and ' +
  'are not parameters — naming one is an error. Acceptance criteria are text only; VIMES mints their ids.';

// The pinned success acknowledgement. It names the MINTED taskId (the model's only
// handle on what it just created — nothing else in the turn tells it) and states
// the one doctrine sentence that has to survive into the conversation: authoring
// ends at backlog.
export function createTaskAcknowledgement(taskId: string): string {
  return `Work-order ${taskId} created in backlog. Promotion is Wes's call, made from the board.`;
}

// One zod issue, STRUCTURALLY — not `z.ZodIssue`. The issues this reads come out
// of CORE's zod v3 while this file's `z` is v4 (the same split the input shape
// above documents), so naming either package's issue type here would bind the
// helper to the wrong one. Both spell `path` and `message`; that is all this
// needs.
interface ValidationIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

// The pinned VALIDATION refusal. Exported for the test that pins it, and composed
// from zod's own issues rather than a generic sentence: the model has to know
// WHICH field it got wrong to fix it in the next turn, and "invalid payload" is
// exactly the answer that produces a retry storm.
export function createTaskValidationRefusal(issues: readonly ValidationIssueLike[]): string {
  const namedIssues = issues
    .map((issue) => {
      // A top-level failure (an unrecognized key, typically) has an empty path;
      // calling it 'payload' keeps every line the same shape.
      const fieldPath =
        issue.path.length === 0 ? 'payload' : issue.path.map((segment) => String(segment)).join('.');
      return `${fieldPath}: ${issue.message}`;
    })
    .join('; ');
  return `No task was created — the payload did not validate: ${namedIssues}`;
}

// The pinned UNKNOWN-PROJECT refusal. Reachable when the registry no longer holds
// the project this orchestrator was founded for (a re-declared root mints a new
// id, so this is not hypothetical). Refusing is the only honest answer: the tool's
// entire safety property is that the task is bound to the orchestrator's OWN
// project, and there is no fallback root that keeps that true.
export const CREATE_TASK_UNKNOWN_PROJECT_REFUSAL =
  'No task was created — VIMES can no longer resolve this project in its registry, ' +
  'so there is no board to author onto. Tell the human; this is not something you can retry.';

/**
 * The `create_task` spec for ONE standing orchestrator.
 *
 * Handler contract, in order:
 *   1. VALIDATE with core's schema. Malformed → `{ ok: false }` with the field-
 *      naming sentence and **ZERO EVENTS**. Nothing is minted, nothing is
 *      written, and the model can fix it in its next turn (D44 retry locality).
 *   2. RESOLVE the project root, fresh. Gone → `{ ok: false }`, again zero events.
 *   3. CREATE, with the forced fields overriding nothing the model said (it could
 *      not have said them — step 1 rejects a payload that tries).
 *
 * TOTAL over its input space: no payload throws out of an SDK tool call. The one
 * thing that can throw is the writer's own projection-disagreement error, which
 * is a rule-0.1 finding and must not be swallowed here.
 */
export function buildCreateTaskSpec(deps: CreateTaskToolDeps): SdkReportToolSpec {
  // ⚠ DESTRUCTURED AT THE BOUNDARY — the closure below captures these two
  // functions and nothing else, so it cannot reach a wider object even by
  // accident. See the I7 note in this file's header.
  const { createTask, resolveProjectRoot } = deps;
  return {
    name: 'create_task',
    // D65: the board family. `vimes_report` is the stage-run family and this tool
    // is not in it — the model sees `mcp__vimes_board__create_task`.
    server: 'vimes_board',
    description: CREATE_TASK_TOOL_DESCRIPTION,
    inputSchema: createTaskInputShape,
    handler: async (input) => {
      const parsed = createTaskToolPayloadSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, acknowledgement: createTaskValidationRefusal(parsed.error.issues) };
      }
      const projectRoot = resolveProjectRoot();
      if (projectRoot === undefined) {
        return { ok: false, acknowledgement: CREATE_TASK_UNKNOWN_PROJECT_REFUSAL };
      }
      const payload = parsed.data;
      const bornTask = createTask({
        // ── forced, every one of them (principle 13) ──────────────────────────
        projectRoot,
        createdBy: AUTHORED_TASK_CREATED_BY,
        stage: AUTHORED_TASK_STAGE,
        isolation: AUTHORED_TASK_ISOLATION,
        // `gates` is ABSENT, not `{}`: PROMOTION is the gate on authored work
        // (D53 — a human moves it out of backlog), and an authored task's birth
        // record stays byte-identical to an ungated hand-made one.
        // ── what the model actually said ─────────────────────────────────────
        title: payload.title,
        scope: payload.scope,
        // Absent stays absent — the one optional field, omitted rather than sent
        // as `[]`, so "nothing was fenced off" and "the author named no fence"
        // stay the same fact they are on the human door.
        ...(payload.explicitlyOut === undefined ? {} : { explicitlyOut: payload.explicitlyOut }),
        // TEXT ONLY. `createInstance` mints one id per criterion from the injected id
        // source; this handler never sees an id and never invents one.
        acceptanceCriteria: payload.acceptanceCriteria,
        killCriterion: payload.killCriterion,
      });
      return { ok: true, acknowledgement: createTaskAcknowledgement(bornTask.taskId) };
    },
    acknowledgement: {
      // ⚠ FALLBACKS ONLY — every path through the handler above supplies its own
      // acknowledgement, so neither of these is reachable today. They are stated
      // anyway (the field is required, and for the reason its comment gives: a
      // tool's words should be readable without stepping through a closure), and
      // they are written to be TRUE rather than plausible if one ever is reached.
      recorded: 'Work-order created in backlog. Promotion is Wes\'s call, made from the board.',
      notRecorded: 'No task was created.',
    },
  };
}
