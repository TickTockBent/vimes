import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  treeOf,
  type NodeRecord,
  type NodesState,
  type ProjectsState,
  type SessionsState,
  type TreeResponse,
} from '@vimes/core';
import { NodeProjectionDisagreementError, type NodeWriter } from './nodeWriter.js';

// ─── S14·U3 — the session-tree API (REST, behind the auth wall) ──────────────
//
// E2's forest, over HTTP: the first caller of `NodeWriter`, and the place the
// composed tree read model (`treeOf`, S14·U2) reaches a client. Until this file
// the daemon served NONE of E2 (slice-14.md §0 item 2: `nodesProjection` was not
// registered and there was no `/api/tree`).
//
// ⚠ THIS FILE IS A VALIDATOR, NEVER A SECOND WRITER (principle 10, and
// projectApi.ts's header verbatim). It parses input at the boundary, hands it to
// `NodeWriter`, and reports exactly what came back. It holds no state, and it
// never constructs an event. Every tree RULE — which parents are legal, what a
// closed subtree refuses, why a session may not be re-attached — lives in the
// writer beside the vocabulary that names those refusals; this file maps
// outcomes to status codes and nothing else.
//
// ⚠ **NO PATH VALIDATION, AND THAT IS A DECISION RATHER THAN AN OMISSION.**
// `projectApi.ts` resolves its `root` through `resolveWithinRoots` against the
// D60 static roots before the writer ever sees it, because a project root is a
// DURABLE CONTAINMENT boundary that later surfaces scope by. A node's
// `directory` is a different animal: E3-a makes it **meaning #2 of three — the
// SPAWN-DEFAULT cwd — and never containment.** Nothing in VIMES grants access on
// the strength of it; a spawn INTO that directory goes through the session
// host's own allow-list, which is where the fence is enforced and where it stays.
// So this route records the string as ORGANIZATION and does not pretend to have
// checked something it has not. The 403-class refusals the file/git/project APIs
// carry therefore do not appear here at all — there is no path being taken.
//
// ⚠ NO DELETE ROUTE. E2's vocabulary has three events; a node is CLOSED, never
// removed (and there is no reopen either — see `NodeWriter.closeNode`).
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()` anywhere in this
// file. Every route runs to completion inside the request that invoked it.

export interface NodeApiDeps {
  // The SOLE node writer — one writer, exactly as `ProjectWriter` is for the
  // registry. Any later in-process caller (a spawn-into-a-node flow, a TUI
  // command) takes THIS instance rather than growing a second path.
  nodeWriter: NodeWriter;
  // The three folds `treeOf` composes, read FRESH per request — never cached
  // copies this file holds. They are the SAME reads the writer takes, so a
  // client that creates a node and immediately reads the tree sees it.
  readProjects: () => ProjectsState;
  readNodes: () => NodesState;
  readSessions: () => SessionsState;
}

// ── the wire contract ───────────────────────────────────────────────────────

// The SAME `{ node }` envelope for create, close and attach — the record **as
// the projection folded it**, so a client reads the operation's real effect
// rather than an echo of what it asked for (the read-back reasoning `NodeWriter`
// states, carried out to the wire).
export interface NodeResponse {
  node: NodeRecord;
}

// A refusal. `reason` is a member of the writer's CLOSED enum and nothing else —
// no free text, no caller string echoed back (see `nodeRefusalReasonSchema`).
export interface NodeRefusalResponse {
  error: 'conflict';
  reason: string;
}

// ── the input caps (I8, boundary-only) ──────────────────────────────────────
//
// The same class of guard as `MAX_PROJECT_NAME_LENGTH` in projectApi.ts: free
// text from an untrusted caller landing in a durable append-only record and on a
// rendered tree row, bounded HERE at the boundary and nowhere deeper —
// `nodeCreatedPayloadSchema`'s fields stay unbounded strings on purpose, so a
// record written before (or under a different) cap still parses and still
// replays (I6). Bounds, not behaviour-shaping ⟨tune⟩s, so Gate-D does not apply.
const MAX_NODE_NAME_LENGTH = 200;
// A path, so the same scale the file API uses for one: long enough for any real
// nested directory, short enough that nothing pathological lands in the log.
const MAX_NODE_DIRECTORY_LENGTH = 4096;

// POST /api/nodes body.
//
// ⚠ **THERE IS NO `provenance` KEY HERE, AND ITS ABSENCE IS S14-A2's API HALF.**
// This is a plain `z.object`, which STRIPS unknown keys (zod's default, and the
// posture every sibling route in this daemon takes) — so a body smuggling
// `provenance` parses successfully and the value is DROPPED before anything sees
// it. It never reaches `CreateNodeInput`, which has no such field to receive it,
// and the writer stamps `provenance: null` unconditionally. Two independent
// stops, and the test suite pins which one a smuggled body actually hits
// (ignored, not refused).
//
// `parentNodeId` and `directory` are `.nullable()` and REQUIRED-optional in the
// sense that omitting them means `null`: a top-level node and a label-only group
// are both ordinary shapes, and forcing a client to spell `null` for the common
// case buys nothing.
const createNodeBodySchema = z.object({
  projectId: z.string().min(1),
  parentNodeId: z.string().min(1).nullable().optional(),
  // Trimmed at the boundary AND re-trimmed by the writer (which owns the
  // `empty-name` rule). `.min(1)` here refuses a body that sent no name at all;
  // a whitespace-only name is the writer's refusal to make, so it gets one.
  name: z.string().max(MAX_NODE_NAME_LENGTH),
  directory: z.string().min(1).max(MAX_NODE_DIRECTORY_LENGTH).nullable().optional(),
});

// POST /api/nodes/:nodeId/sessions body — which session joins this node.
const attachSessionBodySchema = z.object({
  appSessionId: z.string().min(1),
});

export function registerNodeApi(app: Hono, deps: NodeApiDeps): void {
  // ── POST /api/nodes — create a node ───────────────────────────────────────
  //
  //   • **201 + `{ node }`** — created, and the record is the FOLD. 201 rather
  //     than projectApi's 200 because this genuinely mints a new addressable
  //     resource with a server-assigned id, which is the one case the status
  //     code has something to say.
  //   • **400** — the body was not a creation request.
  //   • **409 + `{ reason }`** — the writer refused. See the note on the status
  //     code below.
  app.post('/api/nodes', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, createNodeBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    try {
      const result = deps.nodeWriter.createNode({
        projectId: parsedBody.value.projectId,
        // Absent means `null` — a top-level node. Same for `directory`.
        parentNodeId: parsedBody.value.parentNodeId ?? null,
        name: parsedBody.value.name,
        // ⚠ RECORDED, NOT RESOLVED — see the file header. This string is
        // organization (a spawn default), never a containment claim, so it is
        // passed through exactly as sent.
        directory: parsedBody.value.directory ?? null,
      });
      if (result.outcome === 'refused') {
        return refusalResponse(context, result.reason);
      }
      const response: NodeResponse = { node: result.node };
      return context.json(response, 201);
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/nodes/:nodeId/close — close a node ──────────────────────────
  //
  // A POST to a named sub-resource rather than a DELETE, and the shape says what
  // it means: the forest is event-sourced, so this APPENDS a `node_closed`. It
  // removes nothing, kills nothing, and there is no route that undoes it (E2 has
  // no reopen event — see `NodeWriter.closeNode`).
  //
  // No body is read. Closing names no parameters, and accepting one would invite
  // a future `{ closed: false }` reopen to sneak in without a decision.
  app.post('/api/nodes/:nodeId/close', (context) => {
    try {
      const result = deps.nodeWriter.closeNode({ nodeId: context.req.param('nodeId') });
      if (result.outcome === 'refused') {
        return refusalResponse(context, result.reason);
      }
      const response: NodeResponse = { node: result.node };
      return context.json(response, 200);
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── POST /api/nodes/:nodeId/sessions — attach a session ───────────────────
  //
  // ⚠ **THERE IS NO DETACH AND NO RE-ATTACH.** A session already living
  // somewhere else is refused `attached-elsewhere`, because a move is
  // `node_moved` wearing another name (E2-a) and the tree's exactly-once
  // property depends on the refusal. The absence of a DELETE on this collection
  // is the same fact from the other side.
  app.post('/api/nodes/:nodeId/sessions', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, attachSessionBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    try {
      const result = deps.nodeWriter.attachSession({
        nodeId: context.req.param('nodeId'),
        appSessionId: parsedBody.value.appSessionId,
      });
      if (result.outcome === 'refused') {
        return refusalResponse(context, result.reason);
      }
      // The NODE, not the session: the fact recorded is about this node's
      // membership list, which is why the event rides the `nodes` stream.
      const response: NodeResponse = { node: result.node };
      return context.json(response, 200);
    } catch (error) {
      return findingResponse(context, error);
    }
  });

  // ── GET /api/tree — the composed forest ───────────────────────────────────
  //
  // ⚠ **THE ROUTE ADDS NOTHING AND RESHAPES NOTHING.** The body is `treeOf`'s
  // return value verbatim. Every ordering decision, the virtual roots, the
  // `unfiled` residue, the rollups, the reserved `overlays` maps and the D79
  // short ids are the CORE's (S14·U2) — a route that decorated the payload would
  // be a second opinion about the shape of the estate, and the first client to
  // read it would be reading the daemon's opinion rather than the engine's.
  //
  // `?root=` maps STRAIGHT to `TreeOptions.rootId` in the F1 grammar
  // (`project:<projectId>` or the literal `unfiled`) and matches EXACTLY —
  // S14-A10's route half. A virtual id is never prefix-resolved here, because it
  // is never resolved here at all: the parameter is handed through untouched and
  // core does the exact comparison. An id naming no root yields an empty `roots`
  // list rather than a 404, because "the scope you asked for holds nothing" is a
  // true answer and a client holding a stale selection deserves it rather than
  // an error page.
  //
  // ⚠ **NO CACHE HEADERS.** This is live estate state — liveness, attention,
  // process counts. A cached tree is a tree that says a session is running after
  // it died, which is the going-dark failure the attention system exists to
  // prevent.
  app.get('/api/tree', (context) => {
    const requestedRootId = context.req.query('root');
    const response: TreeResponse = treeOf(
      deps.readProjects(),
      deps.readNodes(),
      deps.readSessions(),
      // Absent stays absent — an omitted parameter must not become `rootId:
      // undefined` on the way in, which would be the same thing here but is the
      // kind of drift that stops being the same thing the moment the option
      // grows a second meaning.
      requestedRootId === undefined ? {} : { rootId: requestedRootId },
    );
    return context.json(response);
  });
}

// ── boundary helpers ────────────────────────────────────────────────────────

// ⚠ **EVERY WRITER REFUSAL IS A 409, INCLUDING THE `unknown-*` ONES**, and the
// uniformity is deliberate. projectApi.ts maps `unknown-project` to 404 because
// there the projectId names a REST resource in the request PATH. Here the
// refusals are adjudications over the forest's own rules — `unknown-parent`,
// `unknown-session` and `cross-project-parent` all describe a request that
// conflicts with recorded state rather than a URL that names nothing — and
// splitting them across status codes would make HTTP a SECOND refusal
// vocabulary that a client would have to keep in step with the engine's. One
// vocabulary, in `reason`; the status code says only "refused".
function refusalResponse(context: Context, reason: string): Response {
  const body: NodeRefusalResponse = { error: 'conflict', reason };
  return context.json(body, 409);
}

type ParseResult<ValueType> =
  | { ok: true; value: ValueType }
  | { ok: false; reason: 'invalid-json' | 'schema' };

// Read + validate a JSON body. TOTAL: unparseable bytes, a non-object body and a
// schema mismatch are all classified refusals, never a throw (I8). The
// classified reason is returned; the offending VALUE never is. Kept local, the
// same way projectApi.ts and taskApi.ts each keep their own — every route module
// owns its boundary.
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
// same posture projectApi.ts and taskApi.ts already take. Any other throw is
// re-raised: swallowing an unknown failure here would turn a bug into a quiet
// wrong answer.
function findingResponse(context: Context, error: unknown): Response {
  if (error instanceof NodeProjectionDisagreementError) {
    return context.json({ error: 'node store finding', detail: error.message }, 500);
  }
  throw error;
}
