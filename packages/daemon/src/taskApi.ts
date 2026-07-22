import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  type TaskRecord,
  type TransitionProposal,
  type TransitionProposedBy,
  type TransitionRejectionReason,
} from '@vimes/core';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';
import { TaskProjectionDisagreementError, type TaskWriter } from './taskWriter.js';
import type { DispatchAttemptResult } from './taskDispatcher.js';

// ─── slice 6 step 4b — the task API (REST, behind the auth wall) ─────────────
//
// The first caller of the decisions steps 1–4a built, and the first place task
// state is written by anything other than a test.
//
// ⚠ THIS FILE IS A PROPOSER, NEVER A SECOND WRITER (principle 10, I7).
// A route here MAY NOT compute a next stage, MAY NOT decide a dispatch, and MAY
// NOT construct a `task_transitioned` from its own reasoning. It parses input at
// the boundary, hands it to `TaskWriter` / `TaskDispatcher`, and reports exactly
// what came back. Everything that DECIDES lives in packages/core; everything that
// WRITES lives in `taskWriter.ts`; this file is the adapter between HTTP and
// those two, and it holds no state of its own.
//
// ⚠ SLICE 7'S MCP SURFACE WILL BE A THIN CLIENT OF THESE ROUTES (slice-6
// "explicitly out": the MCP server is never a second writer to the store). The
// boundary set here is the one it inherits, so it is written as the public
// contract it is — envelopes over status-code semantics, enumerated reasons over
// prose, and one route per verb.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()` anywhere in this
// file. Every route runs to completion inside the request that invoked it.

export interface TaskApiDeps {
  // The SOLE task writer (step 4b). Not an emit function: routing every write
  // through the one class is what keeps step 5's in-process watchdog and this
  // HTTP surface from becoming two writers.
  taskWriter: TaskWriter;
  // ONE explicit dispatch attempt. Deliberately a narrow function rather than the
  // `TaskDispatcher` itself, so no route can reach past it into the session host.
  dispatchTask: (taskId: string) => DispatchAttemptResult;
  // The live allowlist union (config.projectRoots ∪ host.liveSessionCwds()), read
  // fresh per request — the SAME union and the SAME shape the file/git/search
  // APIs use.
  getAllowedRoots: () => readonly string[];
  // Injected realpath probe (fs boundary). Defaults to the real one; mirrors
  // FileApiDeps / GitApiDeps.
  realpath?: RealpathProbe;
}

// ── the wire contract ────────────────────────────────────────────────────────

export interface CreateTaskResponse {
  task: TaskRecord;
}
export type ProposeTransitionResponse =
  | { accepted: true; task: TaskRecord }
  | { accepted: false; reason: TransitionRejectionReason };
export interface DispatchResponse {
  result: DispatchAttemptResult;
}

// ── the boundary vocabularies ────────────────────────────────────────────────
//
// ⚠ RE-DECLARED HERE RATHER THAN IMPORTED FROM CORE, AND THE REASON IS BORING BUT
// REAL: `packages/core` validates with **zod 3**, while the daemon's tree resolves
// **zod 4** (the Anthropic SDK pulls it in). A v3 schema object nested inside a v4
// `z.object()` type-checks but degrades every inferred field to `unknown`, so the
// route would lose the very typing the validation exists to give it. wsHub.ts
// already declares its own literal enums for the same reason.
//
// Re-declaring a vocabulary is exactly the drift principle 9 warns about, so each
// tuple is BOUND to core's own union by `exhaustiveVocabulary`: a value added to
// (or renamed in) `taskRecordSchema` / `transitionProposedBySchema` fails the
// BUILD here rather than silently becoming un-proposable over HTTP.
function exhaustiveVocabulary<UnionType extends string>() {
  return <const TupleType extends readonly UnionType[]>(
    values: [UnionType] extends [TupleType[number]] ? TupleType : never,
  ): TupleType => values;
}

const CREATED_BY_VALUES = exhaustiveVocabulary<TaskRecord['createdBy']>()([
  'human',
  'orchestrator',
]);
const ISOLATION_VALUES = exhaustiveVocabulary<TaskRecord['isolation']>()([
  'shared-dir',
  'worktree',
]);
const TASK_STAGE_VALUES = exhaustiveVocabulary<TaskRecord['stage']>()([
  'backlog',
  'planning',
  'plan-ready',
  'implementing',
  'review',
  'done',
  'blocked-external',
  'quarantined',
]);
const PROPOSED_BY_VALUES = exhaustiveVocabulary<TransitionProposedBy>()([
  'human',
  'orchestrator',
  'dispatcher',
]);

// The gates a creator may name, mirroring `taskRecordSchema.gates`. Both halves
// stay optional: a task that names only `requireHeadroom` must not acquire a
// `deferUntilReset` it never asked for. The `satisfies` binds this shape to the
// record's own, so a reshaped gate fails the build here too.
const taskGatesSchema = z.object({
  deferUntilReset: z.string().optional(),
  requireHeadroom: z.object({ meterId: z.string(), pct: z.number() }).optional(),
});
const _gatesMatchTheRecord = {} as z.infer<typeof taskGatesSchema> satisfies TaskRecord['gates'];
const _recordGatesMatchTheSchema = {} as TaskRecord['gates'] satisfies z.infer<
  typeof taskGatesSchema
>;

// POST /api/tasks body. Validated at the boundary — a daemon route never trusts a
// request shape (I8: hostile input must not crash anything, and must not reach a
// decision function as something it is not).
//
// `isolation` defaults to **'worktree'** — **D32** (spike S2 refuted shared-dir's
// only claimed benefit: caching is not directory-scoped on this host, so a fresh
// worktree took a 100% cache hit). This is the FIRST PLACE IN CODE that default
// becomes real; slice-6 step 8 makes it actually isolate. Per-task override
// retained, which is why the field is still accepted.
//
// `stage` defaults to `backlog` — `INITIAL_TASK_STAGE`, stated in the birth record
// rather than assumed downstream so the projection folds a named stage.
const createTaskBodySchema = z.object({
  projectRoot: z.string(),
  createdBy: z.enum(CREATED_BY_VALUES),
  isolation: z.enum(ISOLATION_VALUES).default('worktree'),
  stage: z.enum(TASK_STAGE_VALUES).default('backlog'),
  gates: taskGatesSchema.optional(),
});

// POST /api/tasks/:taskId/transitions body.
//
// ⚠ `toStage` IS VALIDATED AS A PLAIN STRING, NOT THE STAGE ENUM, AND THAT IS
// DELIBERATE. Step 1 typed `task_transition_rejected`'s stage fields as
// `z.string()` precisely so an `unknown-stage` rejection stays RECORDABLE. If zod
// refused an unknown stage here, that rejection reason would become structurally
// unreachable through the API, I7 would lose a branch, and the one case where the
// record matters most (slice 7's hostile input) would produce a 400 with nothing
// written down. So an unknown stage is let through to `proposeTransition`, and the
// MACHINE refuses it — on the record.
const proposeTransitionBodySchema = z.object({
  toStage: z.string(),
  manualReviewRequired: z.boolean().optional(),
  proposedBy: z.enum(PROPOSED_BY_VALUES),
  note: z.string().optional(),
});

export function registerTaskApi(app: Hono, deps: TaskApiDeps): void {
  const realpath = deps.realpath ?? realpathProbe;

  // ── POST /api/tasks — create ────────────────────────────────────────────────
  //
  // ⚠ THE SECURITY BOUNDARY IS `projectRoot`, AND IT IS LOAD-BEARING.
  // `sessionHost.spawnSession()` does NOT validate `cwd` — the only guard in the
  // daemon today is inside `wsHub.handleSpawn`, on the WS spawn path. A TASK is a
  // DURABLE INSTRUCTION to spawn a Claude process in a directory, so an
  // unvalidated `projectRoot` here would be an allowlist bypass WITH A PERSISTENCE
  // LAYER: written once, honoured by the dispatcher on every later attempt.
  //
  // The guard is `resolveWithinRoots` — the same symlink-aware helper the
  // file/git/search APIs share, against the same allowlist union — and a refusal
  // is a 403 with **NO EVENT EMITTED**. A refused creation must not leave a
  // task-shaped record in the log.
  app.post('/api/tasks', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, createTaskBodySchema);
    if (!parsedBody.ok) {
      // 400: this was never a proposal. Nothing reached the writer, so there is
      // nothing to record — see the status-code note on the transitions route.
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const resolvedProjectRoot = resolveWithinRoots(
      parsedBody.value.projectRoot,
      deps.getAllowedRoots(),
      realpath,
    );
    if (!resolvedProjectRoot.ok) {
      // No path echo, matching the file/git APIs: a refusal names the class of
      // failure and never confirms what does or does not exist outside the roots.
      return context.json({ error: 'forbidden', detail: resolvedProjectRoot.reason }, 403);
    }

    try {
      const task = deps.taskWriter.createTask({
        // The RESOLVED path, never the raw input — so the record cannot carry a
        // `..` segment or a symlink that resolves somewhere else later. The
        // allowlist is checked once, here; what gets persisted is what was checked.
        projectRoot: resolvedProjectRoot.absolute,
        createdBy: parsedBody.value.createdBy,
        isolation: parsedBody.value.isolation,
        stage: parsedBody.value.stage,
        ...(parsedBody.value.gates === undefined ? {} : { gates: parsedBody.value.gates }),
      });
      const response: CreateTaskResponse = { task };
      return context.json(response, 201);
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/tasks/:taskId/transitions — propose (I7's route) ──────────────
  //
  // STATUS-CODE RATIONALE, WRITTEN DOWN BECAUSE SLICE 7 INHERITS IT:
  //
  //   • **409 = "the machine said no"**, and the rejection IS IN THE LOG. EVERY
  //     enumerated `TransitionRejectionReason` returns 409 — including
  //     `unknown-stage`. One code for "the machine refused" keeps clients (and
  //     slice 7's MCP client) reading the `reason` FIELD rather than branching on
  //     HTTP semantics we would then be obliged to keep stable forever.
  //   • **400 = "this was not a proposal"**, and NOTHING is in the log. The body
  //     never reached the state machine, so there is no proposal to record. A 400
  //     that evented would put proposals in the log that were never made.
  //   • **404 = "no such task"**, nothing in the log — fabricating a rejection for
  //     a taskId no `task_created` introduced would put a phantom task there.
  app.post('/api/tasks/:taskId/transitions', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, proposeTransitionBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const proposal: TransitionProposal = {
      // ⚠ CAST ON PURPOSE, and the ONLY cast in this file. `TransitionProposal`
      // types `toStage` to the enum, but step 1 widened the machine's own check to
      // `string` precisely because a value outside the enum physically reaches it
      // across this boundary — TypeScript's guarantee stops at the wire. Refusing
      // it here instead would make `unknown-stage` unreachable (see the schema).
      toStage: parsedBody.value.toStage as TransitionProposal['toStage'],
      proposedBy: parsedBody.value.proposedBy,
      ...(parsedBody.value.manualReviewRequired === undefined
        ? {}
        : { manualReviewRequired: parsedBody.value.manualReviewRequired }),
      ...(parsedBody.value.note === undefined ? {} : { note: parsedBody.value.note }),
    };

    try {
      const result = deps.taskWriter.proposeTaskTransition(context.req.param('taskId'), proposal);
      switch (result.outcome) {
        case 'unknown-task':
          return context.json({ error: 'not found' }, 404);
        case 'rejected': {
          // The writer ALREADY emitted the `task_transition_rejected`. This branch
          // only reports it — I7 is satisfied by the record, not by this response.
          const response: ProposeTransitionResponse = { accepted: false, reason: result.reason };
          return context.json(response, 409);
        }
        case 'accepted': {
          const response: ProposeTransitionResponse = { accepted: true, task: result.task };
          return context.json(response, 200);
        }
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/tasks/:taskId/dispatch — ONE explicit attempt ─────────────────
  //
  // Calls `TaskDispatcher.dispatchTask(taskId)` EXACTLY ONCE. **No loop, no
  // timer, no scheduling** — step 4a's boundary holds unchanged: scheduling policy,
  // and the event-spam question that arrives with a polling loop, is deliberately
  // out of this slice step. One request, one attempt.
  //
  // CONVENTION: **200 + the `DispatchAttemptResult` envelope for every honest
  // outcome** — `spawned`, `deferred`, `refused` and `spawn-failed` alike. This
  // mirrors `/api/usage/refresh` (documented in app.ts): a refusal is a complete,
  // honest answer rather than an HTTP error, and 4xx-ing it would push clients
  // toward retry/backoff machinery for what is really "here is what happened."
  // The one exception is an unknown task — there was nothing to attempt.
  app.post('/api/tasks/:taskId/dispatch', (context) => {
    const result = deps.dispatchTask(context.req.param('taskId'));
    if (result.outcome === 'unknown-task') {
      return context.json({ error: 'not found' }, 404);
    }
    const response: DispatchResponse = { result };
    return context.json(response, 200);
  });

  // ── NO `GET /api/tasks` — deliberately ─────────────────────────────────────
  //
  // `GET /api/projections/tasks` already serves task state, behind the same auth
  // wall, and the kanban UI (step 9) reads it. A second reader of the same fact is
  // exactly the drift principle 9 forbids, and rule 0.5 says machinery waits for
  // its consumer. Nothing in this step needed one.
}

// ── boundary helpers ─────────────────────────────────────────────────────────

type ParseResult<ValueType> =
  | { ok: true; value: ValueType }
  | { ok: false; reason: 'invalid-json' | 'schema' };

// Read + validate a JSON body. TOTAL: unparseable bytes, a non-object body and a
// schema mismatch are all classified refusals, never a throw (I8) — a daemon that
// crashes on a malformed body is a daemon a single bad client can take down.
// The classified reason is returned; the offending VALUE never is (it would echo
// hostile input straight back to the caller).
async function parseJsonBody<OutputType>(
  request: Request,
  schema: z.ZodType<OutputType, unknown>,
): Promise<ParseResult<OutputType>> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, reason: 'schema' };
  }
  return { ok: true, value: parsed.data };
}

// A projection/log divergence is a rule-0.1 FINDING, not a request error: the
// event was written and the fold did not produce the record it describes. It
// surfaces as a 500 carrying the finding — never a plausible-looking 200 — which
// is the same posture `GET /api/cost/ledger` already takes for a tree that fails
// to reconcile. Any other throw is re-raised: swallowing an unknown failure here
// would turn a bug into a quiet wrong answer.
function findingResponse(context: Context, error: unknown): Response {
  if (error instanceof TaskProjectionDisagreementError) {
    return context.json({ error: 'task store finding', detail: error.message }, 500);
  }
  throw error;
}
