import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { NodeRecord } from '@vimes/core';
import type {
  CheckoutRefusal,
  CheckoutRefusalReason,
  CreateCheckoutRequest,
  CreateCheckoutResult,
  OpenCheckoutRequest,
  OpenCheckoutResult,
  RemoveCheckoutRequest,
  RemoveCheckoutResult,
} from './checkoutCoordinator.js';

// ─── S17·U4 — the checkout propose-routes (slice-17.md §3.4, §3.5) ───────────
//
// ⚠ **THIS FILE DECIDES NOTHING.** Every rule about whether a checkout may be
// made, opened or removed lives in `CheckoutCoordinator` beside the vocabulary
// that names its refusals (§3.10's state table, §3.3's gate, §3.1's base-ref
// algorithm). This module does exactly two things: it validates the SHAPE of a
// request, and it maps the coordinator's CLOSED refusal enum onto HTTP. That is
// `nodeApi.ts`'s "a validator, never a second writer" discipline applied to a
// service that happens to touch a filesystem — and here it matters more, not
// less, because the thing being proposed is a directory on a real disk.
//
// ⚠ **§3.4 — A CALLER-SUPPLIED FILESYSTEM PATH IS NEVER ACCEPTED, IN ANY FIELD,
// BY ANY ROUTE. THIS IS THE UNIT'S CENTRAL RULE.** Routes carry IDENTITIES AND
// INTENT only: a projectId, a branch name, a nodeId, a base ref. The engine
// resolves the repository from the project record, derives the checkout path
// under `worktreeRoot` from a freshly minted nodeId, and verifies the derivation
// stays beneath it. `remove` derives its target from the NODE'S RECORDED
// PROVENANCE and never from the request — which is why its route reads no body
// at all and passes only the id.
//
// The three body schemas are plain `z.object`s, which STRIP unknown keys (zod's
// default, and the posture every sibling route in this daemon takes). So a body
// smuggling `path` / `directory` / `worktreePath` parses successfully and the
// value is DROPPED before anything sees it: it never reaches
// `CreateCheckoutRequest`/`OpenCheckoutRequest`, neither of which has a field to
// receive it. Two independent stops — the schema and the request types — and the
// test suite pins which one a smuggled body actually hits (ignored, not
// refused), exactly as `nodeApi.ts` pins the same question for `provenance`.
//
// ⚠ **NO `inLockFollowUp` FROM HTTP.** The coordinator's in-lock hook is the
// DISPATCHER'S alone (§3.3 — it exists so a spawn happens inside the critical
// section that made the checkout). `CheckoutApiDeps` therefore narrows the
// coordinator to three ONE-ARGUMENT methods: an HTTP caller cannot supply a
// follow-up because this file's view of the coordinator has nowhere to put one.
// Structural, not a convention.
//
// ⚠ **NO REF GRAMMAR HERE, AND THAT IS A DECISION RATHER THAN AN OMISSION.**
// `validateRefName` (§3.9's core half) and git's own `check-ref-format` both run
// inside the coordinator, which is where `invalid-ref` is named. Re-checking the
// grammar at the boundary would make this file a SECOND opinion about what a
// legal ref is, and the two would drift. `.min(1)` is a SHAPE check ("the field
// was sent at all"), not a grammar check; the 200-character cap `nodeApi.ts`
// would apply to an unbounded free-text field is already `MAX_REF_NAME_LENGTH`'s
// job one layer down.
//
// ⚠ NO TIMER, NO INTERVAL, NO `Date.now()`, NO `fs`, NO `child_process` in this
// file. Every route runs to completion inside the request that invoked it.

export interface CheckoutApiDeps {
  /**
   * The ONE coordinator — the same instance the dispatcher reaches through its
   * own deferred thunk (principle 10: one maker of checkouts, never a second
   * path). Narrowed to the three propose-verbs with NO follow-up parameter; see
   * the header.
   */
  checkoutCoordinator: {
    create: (request: CreateCheckoutRequest) => Promise<CreateCheckoutResult>;
    open: (request: OpenCheckoutRequest) => Promise<OpenCheckoutResult>;
    remove: (request: RemoveCheckoutRequest) => Promise<RemoveCheckoutResult>;
  };
}

// ── the wire contract ───────────────────────────────────────────────────────

// `create` and `open` both answer with the BORN NODE — the record as the nodes
// projection folded it, never an echo of the request (the read-back reasoning
// `NodeWriter` states, carried to the wire exactly as `NodeResponse` does).
export interface CheckoutNodeResponse {
  node: NodeRecord;
}

// `remove` answers with the coordinator's own four ENGINE-DERIVED facts,
// verbatim. `diskRemoved: false` is §3.10's idempotent no-op row — the checkout
// was already gone, so nothing was removed and no `checkout_removed` was
// emitted. Spelled honestly rather than as a pretend removal.
export interface CheckoutRemovedResponse {
  nodeId: string;
  path: string;
  branch: string;
  diskRemoved: boolean;
}

// A refusal. `error` is a member of the coordinator's CLOSED enum and nothing
// else; `detail` is the coordinator's own detail passed through VERBATIM and
// never enriched here (§3.5: git's stderr, an engine-derived path, or the
// blocking session ids — never a caller string reflected back).
//
// ⚠ **THIS IS `gitApi.ts`'s `GitRefusalResponse` SHAPE, NOT `nodeApi.ts`'s
// `{ error: 'conflict', reason }`, AND THE CHOICE IS FORCED.** nodeApi can put
// the constant `'conflict'` in `error` because EVERY writer refusal there is a
// 409 — one status, so the status carries no information and the reason needs a
// field of its own. Here §3.5 spreads sixteen reasons across four statuses
// (409/404/400/503) and names `gitApi.ts` as the precedent for three of them, so
// the reason IS the error and the status is the coarse class. Matching nodeApi
// instead would mean inventing a constant word per status family.
export interface CheckoutRefusalResponse {
  error: CheckoutRefusalReason;
  detail?: string;
}

// ── §3.5's status map, stated as a TOTAL FUNCTION ───────────────────────────
//
// ⚠ **THERE IS NO `default` ARM, DELIBERATELY.** A seventeenth member of
// `checkoutRefusalReasonSchema` must FAIL TYPECHECK here ("function lacks ending
// return statement") rather than silently becoming a 400 — a swallowing default
// is precisely how a new engine refusal reaches a client wearing the wrong
// meaning. The suite also enumerates the enum at runtime and asserts every
// member maps, so the guard holds from both sides.
//
// The three families, and why each member sits where it does (§3.5 signs the
// principle; the rows are its application):
//
//   • **409 — STATE CONFLICT.** §3.5 reserves 409 for exactly this: the request
//     was well-formed and named things that exist, and the ESTATE says no. The
//     branch is already there; it is checked out somewhere else; sessions still
//     claim the checkout; the node is not a checkout; the derived path is
//     occupied; the node writer refused after git had performed.
//   • **404 — NAMES NOTHING THAT EXISTS.** The identity in the request has no
//     referent: no live project, no node, no such branch, no repository at the
//     project's root. `not-a-repo` keeps its precedent status from `gitApi.ts`
//     verbatim.
//   • **400 — the request (or the repository's own state) cannot produce a valid
//     operation.** §3.5's "validation/no-default 400", plus `git-failed`'s
//     precedent status.
//   • **503 — `git-unavailable`**, the infrastructure answer, precedent verbatim.
//
// Two rows worth stating out loud because a reader will wonder:
//   • `unknown-project` is 404 here and 409 in `nodeApi.ts`. nodeApi maps every
//     writer refusal to 409 on the grounds that its refusals are adjudications
//     over the forest's own rules; §3.5 makes the opposite call binding for this
//     API by RESERVING 409 for state conflicts, and "no live project by that id"
//     is an identity that names nothing, not a conflict. Same posture as
//     `projectApi.ts`'s own 404.
//   • `node-write-refused` and `path-escapes-worktree-root` are both documented
//     in the coordinator as UNREACHABLE-in-practice divergences. They are still
//     refusals, not throws, so they get refusal statuses: the first is a
//     disagreement about recorded state (409), the second a derivation that
//     failed validation (400, §3.5's validation family). Neither is a 500,
//     because the coordinator already compensated and answered — a route that
//     re-classified them would be deciding, which this file does not do.
export function statusForCheckoutRefusal(reason: CheckoutRefusalReason): 400 | 404 | 409 | 503 {
  switch (reason) {
    // ── 409: the estate says no ──
    case 'branch-already-exists':
    case 'branch-checked-out-elsewhere':
    case 'checkout-in-use':
    case 'checkout-unrecorded-mismatch':
    case 'not-a-checkout':
    case 'node-write-refused':
      return 409;

    // ── 404: the request names nothing that exists ──
    case 'unknown-project':
    case 'unknown-node':
    case 'branch-not-found':
    case 'not-a-repo':
      return 404;

    // ── 400: no valid operation can be built from this ──
    case 'invalid-ref':
    case 'unresolvable-ref':
    case 'no-default-branch':
    case 'path-escapes-worktree-root':
    case 'git-failed':
      return 400;

    // ── 503: infrastructure, not the caller ──
    case 'git-unavailable':
      return 503;
  }
}

// ── the request bodies (SHAPE ONLY — see the header) ────────────────────────

// POST /api/checkouts body.
//
// ⚠ **THERE IS NO `path` KEY HERE, AND ITS ABSENCE IS §3.4's API HALF.** A plain
// `z.object` strips unknown keys, so a smuggled path parses and is dropped.
// `baseRef` is optional because §3.1's pinned default-branch algorithm resolves
// one when it is absent (or refuses `no-default-branch`) — the engine's decision,
// not a default this file invents.
const createCheckoutBodySchema = z.object({
  projectId: z.string().min(1),
  baseRef: z.string().min(1).optional(),
});

// POST /api/checkouts/open body. `branch` is REQUIRED: `open` puts an EXISTING
// branch into a fresh engine-derived checkout, so there is nothing for the
// engine to default to.
const openCheckoutBodySchema = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
});

export function registerCheckoutApi(app: Hono, deps: CheckoutApiDeps): void {
  // ── POST /api/checkouts — propose a NEW checkout ──────────────────────────
  //
  //   • **201 + `{ node }`** — created, and the record is the FOLD. 201 for the
  //     same reason `POST /api/nodes` uses it: this mints a new addressable
  //     resource with a server-assigned id.
  //   • **400** — the body was not a creation proposal (zod), or the engine
  //     refused with a 400-class reason.
  //   • **409 / 404 / 503** — per the status map above.
  app.post('/api/checkouts', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, createCheckoutBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    // ⚠ Absent stays ABSENT — an omitted `baseRef` must not become
    // `baseRef: undefined` on the way in. It is the same thing to the coordinator
    // today, and it is the kind of drift that stops being the same thing the
    // moment the option grows a second meaning (`/api/tree`'s `rootId` draws this
    // line for the same reason).
    const request: CreateCheckoutRequest =
      parsedBody.value.baseRef === undefined
        ? { projectId: parsedBody.value.projectId }
        : { projectId: parsedBody.value.projectId, baseRef: parsedBody.value.baseRef };

    const result = await deps.checkoutCoordinator.create(request);
    if (result.outcome === 'refused') {
      return refusalResponse(context, result);
    }
    const response: CheckoutNodeResponse = { node: result.node };
    return context.json(response, 201);
  });

  // ── POST /api/checkouts/open — propose a checkout OF AN EXISTING BRANCH ───
  //
  // A POST to a named sub-resource rather than a variant of the create route,
  // because §3.10 makes them different verbs with different state tables: a
  // `create` whose branch already exists is REFUSED and pointed at this route,
  // never quietly turned into an open (Pin 1 — the verb split the recon found
  // `worktreeManager` silently collapsing).
  app.post('/api/checkouts/open', async (context) => {
    const parsedBody = await parseJsonBody(context.req.raw, openCheckoutBodySchema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const result = await deps.checkoutCoordinator.open({
      projectId: parsedBody.value.projectId,
      branch: parsedBody.value.branch,
    });
    if (result.outcome === 'refused') {
      return refusalResponse(context, result);
    }
    // 201: `open` mints a NEW node at a NEW engine-derived path (§3.10 — no
    // reuse, no adoption), so it creates a resource exactly as `create` does.
    const response: CheckoutNodeResponse = { node: result.node };
    return context.json(response, 201);
  });

  // ── POST /api/checkouts/:nodeId/remove — propose a removal ────────────────
  //
  // ⚠ **NO BODY IS READ, AND THAT IS §3.4 STRUCTURALLY.** The target derives
  // from the node's RECORDED PROVENANCE inside the coordinator; this route
  // passes an id and nothing else. Reading a body here would create the one
  // place a caller could try to name a path — so there is no such place. It is
  // also `POST /api/nodes/:nodeId/close`'s reasoning: accepting a parameter
  // would invite a future `{ force: true }` to sneak in without a decision, and
  // §2 reserves `force` explicitly.
  //
  // A POST to a named sub-resource rather than a DELETE for the same reason
  // `close` is: this is a proposal the engine may refuse, and on §3.10's last
  // row it succeeds having removed nothing at all.
  app.post('/api/checkouts/:nodeId/remove', async (context) => {
    const result = await deps.checkoutCoordinator.remove({ nodeId: context.req.param('nodeId') });
    if (result.outcome === 'refused') {
      return refusalResponse(context, result);
    }
    // The coordinator's own facts, passed through — including `diskRemoved`.
    const response: CheckoutRemovedResponse = {
      nodeId: result.nodeId,
      path: result.path,
      branch: result.branch,
      diskRemoved: result.diskRemoved,
    };
    return context.json(response, 200);
  });
}

// ── boundary helpers ────────────────────────────────────────────────────────

// The refusal, on the wire. `detail` is OMITTED when the coordinator omitted it
// (§3.10's `branch-already-exists` has exactly two variants, and the difference
// between them is whether a detail exists) — never coerced to `null`, never
// filled in with something this file made up.
function refusalResponse(context: Context, refusal: CheckoutRefusal): Response {
  const body: CheckoutRefusalResponse =
    refusal.detail === undefined
      ? { error: refusal.reason }
      : { error: refusal.reason, detail: refusal.detail };
  return context.json(body, statusForCheckoutRefusal(refusal.reason));
}

type ParseResult<ValueType> =
  | { ok: true; value: ValueType }
  | { ok: false; reason: 'invalid-json' | 'schema' };

// Read + validate a JSON body. TOTAL: unparseable bytes, a non-object body and a
// schema mismatch are all classified refusals, never a throw (I8). The
// classified reason is returned; the offending VALUE never is — which is the
// same rule §3.5 states for refusal details, arriving from the other side. Kept
// local, the way `nodeApi.ts`, `projectApi.ts` and `taskApi.ts` each keep their
// own: every route module owns its boundary.
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
