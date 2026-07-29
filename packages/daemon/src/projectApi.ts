import { stat } from 'node:fs/promises';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ProjectRecord, ProjectsState } from '@vimes/core';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';
import { ProjectProjectionDisagreementError, type ProjectWriter } from './projectWriter.js';

// ─── S8·1 — the project-registry API (REST, behind the auth wall) ────────────
//
// D42's declared boundaries, over HTTP. The first caller of `ProjectWriter`, and
// the place a directory a human picked becomes a recorded fact.
//
// ⚠ THIS FILE IS A VALIDATOR, NEVER A SECOND WRITER (principle 10). It parses
// input at the boundary, proves the requested directory is one VIMES is allowed
// to touch, hands it to `ProjectWriter`, and reports exactly what came back. It
// holds no state, and it never constructs an event.
//
// ⚠ **NOTHING HERE TOUCHES ANY EXISTING SURFACE.** Sessions, tasks, cost, files,
// git and search are untouched by this unit: declaring a project changes no
// scoping anywhere today. Attribution stays the read-time derivation
// `projectForCwd` (packages/core), consumed by S8·2 when the picker lands. A
// registry that quietly re-scoped a live surface the moment it gained its first
// row would be a much larger change than the one anybody signed off.
//
// ⚠ NO DELETE ROUTE, ANYWHERE — see `ProjectWriter.archiveProject`. D42's
// lifecycle is archive, not delete: the log is append-only (I12) and the record
// has to survive so the history under its root stays attributable.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()` anywhere in this
// file. Every route runs to completion inside the request that invoked it.

export interface ProjectApiDeps {
  // The SOLE project writer. Not an emit function: routing every write through
  // the one class is what keeps this HTTP surface and any later in-process caller
  // (an onboarding workflow, the picker's own bookkeeping) from becoming two
  // writers.
  projectWriter: ProjectWriter;
  // The registry as folded from the log, read FRESH per request — the same
  // projection the writer reads, never a cached copy this file holds.
  readProjects: () => ProjectsState;
  // ── ⚠ THE STATIC CONFIG ROOTS (D60), *NOT* THE LIVE SESSION-CWD UNION ───────
  //
  // **This is the one place this file deliberately differs from fileApi/gitApi/
  // taskApi**, every one of which allow-lists against
  // `config.projectRoots ∪ liveSessionCwds()`. A project declaration is not a
  // file read: it is a DURABLE boundary that will scope surfaces for as long as
  // it exists, and D60 settled D42's one deferred sub-decision — declaration is
  // CONSTRAINED WITHIN `VIMES_PROJECT_ROOTS` (D21) and never widens the fence.
  //
  // A live session's cwd is a TRANSIENT fact that disappears when the session
  // dies; declaring a project inside one would mint a permanent boundary out of a
  // temporary allowance, and (worse) would let anyone who can spawn a session
  // anywhere outside the roots — a worktree-isolated stage run's cwd is
  // deliberately outside every root, `config.worktreeRoot` — turn that into a
  // standing declaration. Widening the fence stays a deliberate act:
  // `/etc/vimes/env` plus a restart, never a side effect of clicking in a picker.
  getConfiguredProjectRoots: () => readonly string[];
  // Injected realpath probe (fs boundary). Defaults to the real one; mirrors
  // FileApiDeps / GitApiDeps / TaskApiDeps.
  realpath?: RealpathProbe;
}

// ── the wire contract ────────────────────────────────────────────────────────

// ⚠ **EVERY RECORD, ARCHIVED INCLUDED.** The flag is ON the record and clients
// filter — a route that hid archived projects would make "show me the archived
// ones" a second endpoint, and would leave a client unable to explain why
// re-declaring a directory it cannot see comes back `duplicate-root`... except it
// would not, because archiving frees the root. Both halves are the caller's to
// reason about, and both need the whole list.
export interface ListProjectsResponse {
  projects: ProjectRecord[];
}
// The SAME `{ project }` shape for create, metadata and archive — the body is the
// record **as the projection folded it**, so a client reads the operation's real
// effect rather than an echo of what it asked for (the read-back reasoning
// `TaskWriter` states, carried out to the wire).
export interface ProjectResponse {
  project: ProjectRecord;
}

// ── the input caps (I8, boundary-only) ───────────────────────────────────────
//
// `name` and `description` are FREE TEXT FROM AN UNTRUSTED CALLER that land in a
// durable append-only record and on a rendered picker row, so they are bounded
// HERE, at the boundary, and nowhere deeper — `projectRecordSchema`'s fields stay
// unbounded optional strings on purpose, so a record written before (or under a
// different) cap still parses and still replays (I6). A cap enforced by the record
// schema would be a migration; a cap enforced by the route is a policy.
//
// These are the SAME CLASS of input guard as `MAX_TASK_TITLE_LENGTH` /
// `MAX_WORK_ORDER_TEXT` in taskApi.ts — bounds, not behavior-shaping ⟨tune⟩s
// (nothing about the system's behaviour changes with the exact number), so
// Gate-D does not apply and they are pinned directly, at the same scale as their
// task-side counterparts: a name is a label (title scale), a description is prose
// (work-order text scale).
const MAX_PROJECT_NAME_LENGTH = 200;
const MAX_PROJECT_DESCRIPTION_LENGTH = 8000;

// ⚠ **TRIMMED, THEN REQUIRED NON-EMPTY**, and the order is the point: `.trim()`
// runs before `.min(1)`, so a name of `"   "` is refused rather than stored as
// three spaces. What reaches the writer is the TRIMMED value, so the record never
// carries leading/trailing whitespace nobody meant to type.
//
// A caller who wants NO name omits the key — absent stays absent all the way to
// the birth record (D42's basename fallback is a read-time derivation). `''` is
// deliberately NOT the way to say that: an empty string is a name someone chose,
// and the two facts must stay distinguishable.
const projectNameSchema = z.string().trim().min(1).max(MAX_PROJECT_NAME_LENGTH);
const projectDescriptionSchema = z.string().trim().min(1).max(MAX_PROJECT_DESCRIPTION_LENGTH);

// POST /api/projects body. Validated at the boundary — a daemon route never
// trusts a request shape (I8: hostile input must not crash anything, and must not
// reach a decision function as something it is not).
const declareProjectBodySchema = z.object({
  root: z.string(),
  name: projectNameSchema.optional(),
  description: projectDescriptionSchema.optional(),
});

// POST /api/projects/:projectId/metadata body — the PATCH half. Both fields
// optional; naming NEITHER is not a schema error but an `empty-update` (the
// writer's outcome, a 400 below), because "you sent a well-formed request that
// asks for nothing" is a different fact from "your body was not a request" — the
// same distinction the amendments route draws.
const updateProjectMetadataBodySchema = z.object({
  name: projectNameSchema.optional(),
  description: projectDescriptionSchema.optional(),
});

export function registerProjectApi(app: Hono, deps: ProjectApiDeps): void {
  const realpath = deps.realpath ?? realpathProbe;

  // ── GET /api/projects — the registry ────────────────────────────────────────
  //
  // ORDERED BY ROOT, always. The projection is a `Record` keyed by projectId, and
  // `Object.values` order is insertion order — i.e. declaration order, which is
  // neither meaningful to a human nor stable across a snapshot boundary. Sorting
  // by root gives the picker a deterministic list AND groups nested boundaries
  // next to their parents (`~/projects` immediately before `~/projects/vimes`),
  // which is exactly how D42's longest-prefix-wins nesting reads on screen.
  app.get('/api/projects', (context) => {
    const response: ListProjectsResponse = {
      projects: Object.values(deps.readProjects().projects).sort((left, right) =>
        left.root.localeCompare(right.root),
      ),
    };
    return context.json(response);
  });

  // ── POST /api/projects — declare a boundary ────────────────────────────────
  //
  // ⚠ THE SECURITY BOUNDARY IS `root`, AND IT IS LOAD-BEARING. A project is a
  // DURABLE boundary that later surfaces scope by; an unvalidated root would be a
  // permanent, persisted claim over a directory nobody allowed. So validation
  // runs IN THIS ROUTE, BEFORE the writer, in this order:
  //
  //   1. `resolveWithinRoots` against the **STATIC config roots** (D60 — see
  //      `getConfiguredProjectRoots`). Refusal → 403 with the classified reason
  //      and NO path echo, matching the file/git/task APIs: a refusal names the
  //      class of failure and never confirms what does or does not exist outside
  //      the roots.
  //   2. The directory must EXIST and BE A DIRECTORY. A boundary pointing at a
  //      file, or at nothing, is a boundary no cwd can ever sit under — it would
  //      sit in the registry forever, matching nothing, and the human would have
  //      no idea why. Refusal → 400 with a classified reason.
  //   3. Only then the writer, which owns the registry's own rules
  //      (`duplicate-root`).
  //
  // ⚠ THE ORDER IS THE POINT, not an implementation detail: an out-of-roots root
  // must never reach the writer at all, so a refused declaration leaves NO
  // project-shaped record — and no minted id — behind.
  app.post('/api/projects', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, declareProjectBodySchema);
    if (!parsedBody.ok) {
      // 400: this was never a declaration. Nothing reached the writer, so there is
      // nothing to record — the idiom every sibling route follows.
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const resolvedRoot = resolveWithinRoots(
      parsedBody.value.root,
      deps.getConfiguredProjectRoots(),
      realpath,
    );
    if (!resolvedRoot.ok) {
      return context.json({ error: 'forbidden', detail: resolvedRoot.reason }, 403);
    }

    // The fs probe. `resolveWithinRoots` canonicalizes the longest EXISTING
    // ancestor and re-appends whatever tail does not exist yet (that is what makes
    // it safe for writing new files), so a path inside the roots that names
    // nothing at all still resolves `ok` — existence is this route's question to
    // ask, not the path-safety helper's.
    let rootStats;
    try {
      rootStats = await stat(resolvedRoot.absolute);
    } catch {
      return context.json({ error: 'bad request', detail: 'no-such-directory' }, 400);
    }
    if (!rootStats.isDirectory()) {
      return context.json({ error: 'bad request', detail: 'not-a-directory' }, 400);
    }

    try {
      const result = deps.projectWriter.createProject({
        // The RESOLVED path, never the raw input — so the record cannot carry a
        // `..` segment or a symlink that resolves somewhere else later. The
        // allow-list is checked once, here; what gets persisted is what was
        // checked, and it is also what `projectForCwd` will string-compare
        // against, which is why canonicalization has to happen before the write
        // and never at match time.
        root: resolvedRoot.absolute,
        // Absent stays absent all the way down to the birth record — never `''`.
        // The values are the TRIMMED ones the schema produced.
        ...(parsedBody.value.name === undefined ? {} : { name: parsedBody.value.name }),
        ...(parsedBody.value.description === undefined
          ? {}
          : { description: parsedBody.value.description }),
      });
      switch (result.outcome) {
        case 'duplicate-root':
          // 409 + the EXISTING projectId. The id IS echoed, unlike the 403's path
          // suppression above: it names a project this caller just proved it is
          // allowed to see, and returning it is how a picker says "you already
          // have this one" and navigates there instead of showing a dead end.
          return context.json(
            { error: 'conflict', detail: 'duplicate-root', projectId: result.projectId },
            409,
          );
        case 'created': {
          // 200 rather than 201, uniform with the metadata and archive routes
          // below: all three answer with the SAME `{ project }` envelope, and the
          // thing a client wants is the record as folded, not a `Location` header
          // pointing at a per-project resource this API does not serve.
          const response: ProjectResponse = { project: result.project };
          return context.json(response, 200);
        }
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/projects/:projectId/metadata — patch name/description ─────────
  //
  // A POST to a named sub-resource rather than a PATCH on `/api/projects/:id`,
  // matching `/api/tasks/:taskId/amendments`: the registry is event-sourced, so
  // this appends a `project_updated` rather than editing a stored row, and the
  // route's shape says so.
  //
  // ⚠ **`root` CANNOT BE CHANGED THROUGH THIS DOOR OR ANY OTHER.** D42: a
  // different directory is a different project — declare it, and archive the old
  // one if it has stopped meaning anything.
  //
  //   • **200 + `{ project }`** — patched, and the record is the FOLD.
  //   • **404** — no such project, nothing written.
  //   • **400** — an update that names no field at all. A patch that changes
  //     nothing is log noise; the writer refuses it and writes nothing.
  app.post('/api/projects/:projectId/metadata', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, updateProjectMetadataBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    try {
      const result = deps.projectWriter.updateProject(context.req.param('projectId'), {
        // Absent stays absent all the way down to the event — and here the fold
        // READS that absence to decide what to leave alone, so an
        // `undefined`-valued key would not merely be untidy, it would change the
        // update's meaning.
        ...(parsedBody.value.name === undefined ? {} : { name: parsedBody.value.name }),
        ...(parsedBody.value.description === undefined
          ? {}
          : { description: parsedBody.value.description }),
      });
      switch (result.outcome) {
        case 'unknown-project':
          return context.json({ error: 'not found' }, 404);
        case 'empty-update':
          return context.json({ error: 'bad request', detail: 'empty-update' }, 400);
        case 'updated': {
          const response: ProjectResponse = { project: result.project };
          return context.json(response, 200);
        }
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/projects/:projectId/archive — retire a boundary ──────────────
  //
  // ⚠ **THE CLOSEST THING TO A DELETE THIS API HAS, AND IT IS NOT ONE.** The
  // record stays in the projection with `archived: true` so every session and
  // cost row that ever sat under the root remains attributable; only
  // `projectForCwd` stops matching it, which is what frees the directory to be
  // declared again (as a NEW project, with a new id).
  //
  //   • **200 + `{ project }`** — archived, and the record is the FOLD.
  //   • **404** — no such project, nothing written.
  //   • **409** — already archived. Refused honestly rather than answered 200:
  //     the state would be identical either way, but a second `project_archived`
  //     in the log would claim a human archived this twice. See the writer.
  //
  // No body is read. Archiving names no parameters, and accepting one would
  // invite a future `{ archived: false }` un-archive to sneak in without a
  // decision (rule 0.5 — un-archive lands when it has a consumer).
  app.post('/api/projects/:projectId/archive', (context) => {
    try {
      const result = deps.projectWriter.archiveProject(context.req.param('projectId'));
      switch (result.outcome) {
        case 'unknown-project':
          return context.json({ error: 'not found' }, 404);
        case 'already-archived':
          return context.json(
            { error: 'conflict', detail: 'already-archived', projectId: result.projectId },
            409,
          );
        case 'archived': {
          const response: ProjectResponse = { project: result.project };
          return context.json(response, 200);
        }
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  });
}

// ── boundary helpers ─────────────────────────────────────────────────────────

type ParseResult<ValueType> =
  | { ok: true; value: ValueType }
  | { ok: false; reason: 'invalid-json' | 'schema' };

// Read + validate a JSON body. TOTAL: unparseable bytes, a non-object body and a
// schema mismatch are all classified refusals, never a throw (I8) — a daemon that
// crashes on a malformed body is a daemon a single bad client can take down. The
// classified reason is returned; the offending VALUE never is (it would echo
// hostile input straight back to the caller). The same helper `taskApi.ts`
// carries, kept local for the same reason `wsHub.ts` keeps its own vocabularies:
// each route module owns its boundary.
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
// surfaces as a 500 carrying the finding — never a plausible-looking 200 — the
// same posture `taskApi.ts` and `GET /api/cost/ledger` already take. Any other
// throw is re-raised: swallowing an unknown failure here would turn a bug into a
// quiet wrong answer.
function findingResponse(context: Context, error: unknown): Response {
  if (error instanceof ProjectProjectionDisagreementError) {
    return context.json({ error: 'project store finding', detail: error.message }, 500);
  }
  throw error;
}
