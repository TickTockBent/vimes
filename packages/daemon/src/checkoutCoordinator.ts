import { resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  checkoutRemoved,
  nodeCheckoutBranch,
  nodeCheckoutDirName,
  validateRefName,
  type EventInput,
  type IdSource,
  type NodeProvenance,
  type NodeRecord,
  type NodesState,
  type ProjectsState,
  type SessionRecord,
  type SessionsState,
} from '@vimes/core';
import type { GitAdapter, GitOpError, GitOpResult } from './gitAdapter.js';
import type { NodeWriter } from './nodeWriter.js';

// ─── S17·U2 — the CheckoutCoordinator (slice-17.md §3, E2-c) ─────────────────
//
// **THE ADAPTER PERFORMS; THIS DECIDES.** `gitAdapter.ts` grew a set of pure git
// verbs in this same unit and not one of them holds a lock, reads a projection,
// emits an event or refuses a policy. All of that lives here, and the split is
// the whole architecture of the slice (slice-17.md §1): a checkout is a
// FILESYSTEM act with an EVENT-LOG consequence and a POLICY that says whether it
// may happen at all, and putting those three in one class is how a git service
// turns into a place where nobody can say what the rules are.
//
// What this class owns, and nothing else does:
//   • §3.3's lock — ONE repository-scoped async mutex per projectId, QUEUED.
//   • §3.2's choreography — mint id → derive names → resolve base → git → event
//     → the caller's in-lock follow-up, all inside ONE critical section.
//   • §3.1's default-branch ALGORITHM (the adapter only answers what exists).
//   • §3.10's state table, row for row.
//   • §3.7's compensation and orphan DISCOVERY.
//
// ⚠ **rule 0.3 — EVERY EFFECT IS INJECTED.** No `randomUUID`, no `Date.now()`,
// no `child_process`, no `fs` import: the adapter, the id source, the event
// appender, the projection reads, the path probe and the logger all arrive
// through the constructor. A test drives the whole choreography — including the
// hazard sequences A7 and A8 — with fakes and gets byte-identical results.
//
// ⚠ **NOTHING CONSUMES THIS YET** (§3.11's deliberate sequencing). `app.ts`
// constructs it and runs `listOrphans()` at boot as a WARN line; the dispatcher
// migrates in U3 and the routes arrive in U4. `worktreeManager.ts` keeps working
// exactly as it does today, so two writers EXIST after this unit and only one
// has callers — that is the transition-safety shape §3.11 signed, not an
// oversight.

// ── the closed refusal vocabulary — the COORDINATOR'S OWN ───────────────────
//
// Deliberately NOT `GitOpError`, and deliberately not a widening of it: a policy
// refusal ("that branch is checked out elsewhere") is not a subprocess failure,
// and slice-17.md §3.5 gives the two families different HTTP statuses (409 for
// STATE conflicts, 503/404/400 for the git-and-validation precedent). The three
// adapter-derived members at the bottom are the adapter's facts RE-SPELLED at
// this layer so U4's route mapping reads ONE enum rather than joining two.
//
// ⚠ **NEVER A PATH ECHO BEYOND THE ENGINE'S OWN DERIVED FACTS** (§3.5). `detail`
// carries git's stderr, an engine-derived path, or a blocking session's id —
// never a caller-supplied string reflected back.
export const checkoutRefusalReasonSchema = z.enum([
  // ── shared ──
  /** No LIVE project by that id (D42). An archived project is unknown for CREATE and OPEN; see `remove` for why it is not for removal. */
  'unknown-project',
  /**
   * The derived checkout path did not land beneath `worktreeRoot` (§3.4's
   * verification). Unreachable through any request shape — the path derives
   * from a freshly minted uuid through a total escaper — so it is LOUD rather
   * than repaired: reaching it means the derivation itself is broken.
   */
  'path-escapes-worktree-root',

  // ── create (§3.1, §3.10) ──
  /** §3.1 step 4: no `origin/HEAD`, no local `main`, no local `master`. An explicit base ref is then required. */
  'no-default-branch',
  /** The caller's base ref failed the §3.9 grammar or git's own `check-ref-format`. `detail` names which. */
  'invalid-ref',
  /** The base ref is well-formed but names nothing this repository can resolve to a commit. */
  'unresolvable-ref',
  /**
   * §3.10: the branch this create would mint already exists — refuse, and point
   * at `open`. `detail` NAMES THE EXISTING CHECKOUT PATH when the branch is
   * checked out somewhere, and OMITS it when the branch has no checkout (round
   * 2's wording catch — the two variants are pinned by A1).
   */
  'branch-already-exists',

  // ── open (§3.10) ──
  /** No local branch by that name. */
  'branch-not-found',
  /** The branch is checked out ALREADY — in another worktree or in the main checkout. No reuse, no adoption (§3.4's derivation rule). */
  'branch-checked-out-elsewhere',
  /**
   * The node-derived path is occupied by SOMETHING. Cannot legitimately happen
   * (fresh uuid ⇒ fresh path), so it is loud and never repaired.
   */
  'checkout-unrecorded-mismatch',

  // ── remove (§3.3, §3.4) ──
  /** No node by that id. */
  'unknown-node',
  /** The node exists but carries no provenance — it is a group, not a checkout, and `remove` derives its target from provenance ONLY (§3.4). */
  'not-a-checkout',
  /** §3.3's gate: sessions still claim this checkout. `detail` names the blockers. No `force` in v1. */
  'checkout-in-use',

  // ── the writer's own refusal, surfaced rather than swallowed ──
  /**
   * `NodeWriter.createCheckoutNode` refused after git had already performed.
   * Unreachable in practice — this class checks the project first and the id is
   * freshly minted — so reaching it means the writer and this class disagree
   * about the rules, which is exactly the kind of divergence that must be loud.
   * The git work is COMPENSATED before this is returned.
   */
  'node-write-refused',

  // ── the adapter's facts, re-spelled (§3.5's precedent statuses) ──
  /** git could not be started at all → 503, per `gitApi.ts`'s precedent. */
  'git-unavailable',
  /** The project's root is not a git repository → 404, per precedent. */
  'not-a-repo',
  /** A git command exited non-zero. `detail` carries git's own stderr, verbatim and trimmed. */
  'git-failed',
]);
export type CheckoutRefusalReason = z.infer<typeof checkoutRefusalReasonSchema>;

export interface CheckoutRefusal {
  readonly outcome: 'refused';
  readonly reason: CheckoutRefusalReason;
  /** Git's stderr, an engine-derived path, or the blocking session ids. Never a caller's string. */
  readonly detail?: string;
}

export type CreateCheckoutResult =
  | { readonly outcome: 'created'; readonly node: NodeRecord }
  | CheckoutRefusal;

export type OpenCheckoutResult =
  | { readonly outcome: 'opened'; readonly node: NodeRecord }
  | CheckoutRefusal;

export type RemoveCheckoutResult =
  | {
      readonly outcome: 'removed';
      readonly nodeId: string;
      readonly path: string;
      readonly branch: string;
      /**
       * FALSE on §3.10's last row: the checkout was already gone, so this call
       * removed nothing and emitted NO `checkout_removed`. Idempotent SUCCESS,
       * spelled honestly rather than as a pretend removal — the same shape
       * `worktreeManager.removeWorktree` has always used for its own no-op.
       */
      readonly diskRemoved: boolean;
    }
  | CheckoutRefusal;

/** One checkout on disk under `worktreeRoot` that NO node's provenance claims (§3.7). */
export interface OrphanCheckout {
  readonly projectId: string;
  readonly path: string;
  /** The full ref git reports (`refs/heads/…`), or null when the worktree is detached or bare. */
  readonly branch: string | null;
}

export interface CreateCheckoutRequest {
  readonly projectId: string;
  /** Absent → §3.1's pinned default-branch algorithm resolves one, or refuses. */
  readonly baseRef?: string;
}

export interface OpenCheckoutRequest {
  readonly projectId: string;
  readonly branch: string;
}

export interface RemoveCheckoutRequest {
  readonly nodeId: string;
}

/**
 * The hook U3 hangs the dispatcher's spawn+attach on.
 *
 * ⚠ **IT RUNS INSIDE THE LOCK, AND THAT IS THE POINT** (§3.3, and the rev-2
 * hazard A7 replays): if the lock were released after `node_created`, a `remove`
 * queued behind a create could pass its session gate in the window between the
 * checkout existing and the session that lives in it existing, and delete the
 * ground out from under a process that was still starting. Holding the lock
 * across spawn serializes worktree dispatches per project — an accepted v1 cost,
 * priced in §3.3 rather than discovered later.
 *
 * A throw here is treated exactly like an event-write failure: §3.7 compensation
 * runs, and the throw is re-raised.
 */
export type InLockFollowUp = (checkout: {
  readonly nodeId: string;
  readonly path: string;
  readonly branch: string;
}) => Promise<void>;

export interface CheckoutCoordinatorDeps {
  /** The ONE git seam. This class never spawns anything itself. */
  adapter: GitAdapter;
  /**
   * The sole writer of the nodes stream's three S9·1 events. `node_created`
   * WITH provenance goes through `createCheckoutNode` (nodeWriter.ts Part B) so
   * the one-writer property survives this slice intact.
   */
  nodeWriter: NodeWriter;
  /**
   * The event appender, for `checkout_removed` ONLY.
   *
   * ⚠ Note the asymmetry with `nodeWriter` above, and that it is deliberate:
   * `checkout_removed` is an AUDIT fact with NO FOLD (slice-17.md §1 — the fold
   * is deferred to D86), so there is no projection for a writer to protect and
   * no read-back to prove. `node_created` has both, which is why it keeps its
   * writer. If and when `checkout_removed` grows a fold, it grows a writer with
   * it.
   */
  emit: (events: EventInput[]) => void;
  /** INJECTED (rule 0.3). The only source of nodeIds; §3.2 mints INSIDE the lock. */
  ids: IdSource;
  // Projection reads, called FRESH on every use and never cached in a field —
  // the discipline `NodeWriterDeps` states, for the same reason: a gate decided
  // from a stale copy is not a gate. The remove gate re-reads sessions INSIDE
  // the lock specifically (§3.3), which is what makes A7's queued waiter see
  // the session its predecessor spawned.
  readProjects: () => ProjectsState;
  readNodes: () => NodesState;
  readSessions: () => SessionsState;
  /**
   * The parent directory every engine checkout is created under
   * (`config.worktreeRoot`). Every derived path is joined onto it and then
   * VERIFIED to still be beneath it (§3.4).
   */
  worktreeRoot: string;
  /**
   * Does anything at all exist at this absolute path? §3.10's
   * `checkout-unrecorded-mismatch` row is the only consumer. INJECTED because
   * it is I/O (rule 0.3) — production passes an `fs` probe, tests pass a set.
   */
  pathExists: (path: string) => Promise<boolean>;
  /** Where the loud half of §3.7 goes: compensation failures and boot orphans. */
  logWarn: (message: string) => void;
}

// ── §3.3's remove gate, as a NAMED PREDICATE PAIR ────────────────────────────
//
// Two prongs, kept as two functions so each can be sabotaged independently and
// the right test reddens (A4 is stated over exactly that).
//
// ⚠ **PROJECTION QUERY ONLY** (Pin 2, D45): the gate asks the sessions fold, not
// the filesystem, and never computes a transcript path. Discovery would make
// removal depend on what happens to be on disk at the moment somebody asks.

/**
 * Prong (a): a LIVE session sits in this checkout — REGARDLESS of
 * `claudeSessionIds`.
 *
 * ⚠ **"LIVE" HERE IS `liveness !== 'dead'`, AND THE CHOICE IS LOAD-BEARING.**
 * The repo has no single exported answer: `WATCHDOG_GOVERNED_LIVENESS` is
 * `{spawning, running}` (the watchdog's narrow question), `sessionHost.isLive()`
 * is the PROCESS REGISTRY (which Pin 2 forbids — it is discovery, not a
 * projection query), and `orchestratorApi.ts` spells "standing/adoptable" as
 * `liveness !== 'dead'`. This gate takes the last one, because it is the one
 * that is COMPLEMENTARY to prong (b): §3.3 words prong (b) as "any session,
 * live or dead", which only partitions the space if prong (a) means "not dead".
 * Under `{spawning, running}` a DORMANT session with no transcript yet would
 * pass both prongs and lose its directory mid-life.
 */
function liveSessionsInCheckout(sessions: SessionsState, checkoutPath: string): SessionRecord[] {
  return Object.values(sessions.sessions).filter(
    (session) => session.liveness !== 'dead' && sessionCwdMatchesCheckout(session, checkoutPath),
  );
}

/**
 * Prong (b): ANY session, live or dead, that has a Claude transcript AND sits in
 * this checkout.
 *
 * The SP8·2 resume fact: `claudeSessionIds` is `[]` at `session_created` and
 * fills at `claude_session_mapped`, so a non-empty list means a real Claude
 * conversation happened in this directory and is resumable from it. Removing the
 * directory would make that resume impossible — which is a loss of work, not a
 * reclaim of disk.
 */
function transcriptSessionsInCheckout(sessions: SessionsState, checkoutPath: string): SessionRecord[] {
  return Object.values(sessions.sessions).filter(
    (session) =>
      session.claudeSessionIds.length > 0 && sessionCwdMatchesCheckout(session, checkoutPath),
  );
}

/**
 * Does this session's cwd match the checkout?
 *
 * ⚠ **EXACT EQUALITY, as §3.3 words it ("cwd matches the checkout path"), and
 * the narrowness is deliberate rather than incidental.** A session spawned into
 * a checkout carries the checkout path VERBATIM (the dispatcher hands
 * `spawnSession` the path the engine derived; `session.cwd` is stored exactly as
 * given and is never re-resolved anywhere — orchestratorApi.ts:226 relies on
 * that for `claude --resume`). So the real case is an exact match.
 *
 * A session whose cwd is a SUBDIRECTORY of the checkout is therefore NOT
 * matched by this gate. Nothing in VIMES spawns one today, and widening the
 * predicate to segment-aware containment (`isWithinProjectRoot`'s shape) would
 * change a SIGNED gate — so it is reported as an observation, not patched here.
 */
function sessionCwdMatchesCheckout(session: SessionRecord, checkoutPath: string): boolean {
  return session.cwd === checkoutPath;
}

// Is `candidatePath` the root itself or strictly beneath it, on a SEGMENT
// boundary? The same guard `isWithinProjectRoot` (core) and `isWithinRoot`
// (filePaths.ts) spell — restated rather than imported because both of those
// answer a different question (project attribution; the file-API threat wall)
// and neither takes an already-resolved pair. A bare `startsWith` would let
// `<root>-evil` pass as if it were inside `<root>`.
function isBeneathRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + sep);
}

// The adapter's error, re-spelled in this class's vocabulary. One place, so a
// git failure can never reach a caller wearing two different names.
function refusalFromGitError(error: GitOpError, detail?: string): CheckoutRefusal {
  return detail === undefined
    ? { outcome: 'refused', reason: error }
    : { outcome: 'refused', reason: error, detail };
}

export class CheckoutCoordinator {
  private readonly deps: CheckoutCoordinatorDeps;

  // ── §3.3's lock: ONE repository-scoped async mutex per projectId, QUEUED ──
  //
  // A promise chain per project. A second operation does not fail and does not
  // get a "busy" answer — **there is no try-lock and no 409-on-busy anywhere in
  // this class** (rev 2 claimed both; §3.3 resolved it in favour of queueing).
  // It WAITS, and then re-evaluates its gates from FRESH projection reads inside
  // the lock, which is the property A7 is stated over: the hazard must be
  // IMPOSSIBLE, not unlikely.
  //
  // Key granularity is the PROJECT and not the branch or the path: checkout ops
  // are rare, and reasoning about branch-vs-path contention is not worth buying
  // in v1 (§3.3 prices this explicitly).
  private readonly lockTailByProjectId = new Map<string, Promise<void>>();

  constructor(deps: CheckoutCoordinatorDeps) {
    this.deps = deps;
  }

  /**
   * Run `operation` in this project's critical section, after everything already
   * queued on it.
   *
   * The tail promise is kept SETTLED-ONLY (both outcomes swallowed into
   * `undefined`) so that one operation's failure never poisons the queue behind
   * it: a create that threw must not make every later checkout op on that
   * project reject. The operation's own result — value or throw — is returned to
   * ITS caller untouched.
   */
  private withProjectLock<Value>(projectId: string, operation: () => Promise<Value>): Promise<Value> {
    const previousTail = this.lockTailByProjectId.get(projectId) ?? Promise.resolve();
    const operationResult = previousTail.then(operation, operation);
    const settledTail = operationResult.then(
      () => undefined,
      () => undefined,
    );
    this.lockTailByProjectId.set(projectId, settledTail);
    return operationResult;
  }

  /**
   * §3.2's engine half: create a NEW checkout — a fresh branch off a resolved
   * base commit — and record it as a provenance-bearing node.
   *
   * The whole sequence runs inside ONE §3.3 critical section, in this order and
   * for these reasons:
   *   1. mint the nodeId — because §3.6 derives BOTH the branch and the path
   *      from it, and both must exist before any git command is built;
   *   2. derive and VERIFY the path stays beneath `worktreeRoot` (§3.4);
   *   3. resolve the base ref (§3.1) and pin it to an IMMUTABLE COMMIT — A6 is
   *      stated over the gap between this step and step 5;
   *   4. refuse if the derived branch somehow already exists (§3.10);
   *   5. `git worktree add -b <branch> -- <path> <commit>`;
   *   6. emit `node_created` WITH provenance, through the sole writer;
   *   7. run the caller's in-lock follow-up (U3's spawn+attach).
   * Steps 6 and 7 are the compensated region: a throw or a refusal in either
   * un-makes step 5 completely (§3.7) before it surfaces.
   */
  async create(request: CreateCheckoutRequest, inLockFollowUp?: InLockFollowUp): Promise<CreateCheckoutResult> {
    return this.withProjectLock(request.projectId, () => this.createInLock(request, inLockFollowUp));
  }

  private async createInLock(
    request: CreateCheckoutRequest,
    inLockFollowUp: InLockFollowUp | undefined,
  ): Promise<CreateCheckoutResult> {
    const repoRoot = this.liveProjectRoot(request.projectId);
    if (repoRoot === null) {
      return { outcome: 'refused', reason: 'unknown-project' };
    }

    const nodeId = this.deps.ids.uuid();
    const branch = nodeCheckoutBranch(nodeId);
    const derivedPath = this.derivePath(nodeId);
    if (derivedPath === null) {
      return { outcome: 'refused', reason: 'path-escapes-worktree-root' };
    }

    const baseRefResolution = await this.resolveBaseRef(repoRoot, request.baseRef);
    if (baseRefResolution.outcome === 'refused') {
      return baseRefResolution;
    }
    const { baseRef, resolvedCommit } = baseRefResolution;

    // §3.10's create row. Unreachable from a fresh uuid — which is exactly why
    // it is a refusal and not a silent reuse: reaching it means the id space or
    // a previous compensation is broken, and `open` is the verb for a branch
    // that already exists.
    const branchExists = await this.deps.adapter.localBranchExists(repoRoot, branch);
    if (!branchExists.ok) {
      return refusalFromGitError(branchExists.error, branchExists.detail);
    }
    if (branchExists.value) {
      return this.branchAlreadyExistsRefusal(repoRoot, branch);
    }

    // ⚠ THE COMMIT, NEVER THE REF (§3.1/A6). Between the resolution above and
    // this line the ref may have moved; what is checked out is what was
    // resolved, and the provenance below therefore describes what is on disk.
    const addResult = await this.deps.adapter.addWorktreeFromCommit(repoRoot, {
      path: derivedPath,
      branch,
      commit: resolvedCommit,
    });
    if (!addResult.ok) {
      return refusalFromGitError(addResult.error, addResult.detail);
    }

    const provenance: NodeProvenance = { branch, baseRef, resolvedCommit, path: derivedPath };
    return this.recordCheckout({
      repoRoot,
      projectId: request.projectId,
      nodeId,
      provenance,
      inLockFollowUp,
      // §3.7: the branch was OURS and is recorded nowhere — compensation un-makes
      // both halves.
      compensateBranch: true,
      succeededAs: 'created',
    });
  }

  /**
   * §3.10's `open` state table, VERBATIM: put an EXISTING branch into a fresh
   * engine-derived checkout.
   *
   * The four rows, in the order they are checked (declared, so a request that
   * violates two gets the earlier answer deterministically):
   *   • branch does not exist locally → `branch-not-found`;
   *   • branch checked out ANYWHERE — another worktree OR the main checkout →
   *     `branch-checked-out-elsewhere`. No reuse and no adoption: reusing a
   *     foreign path violates §3.4's derivation rule, which is the whole reason
   *     a caller may not name a path;
   *   • the derived path is occupied by ANYTHING →
   *     `checkout-unrecorded-mismatch`;
   *   • otherwise create the worktree at the fresh node-derived path, with the
   *     branch TIP as `resolvedCommit`.
   */
  async open(request: OpenCheckoutRequest, inLockFollowUp?: InLockFollowUp): Promise<OpenCheckoutResult> {
    return this.withProjectLock(request.projectId, () => this.openInLock(request, inLockFollowUp));
  }

  private async openInLock(
    request: OpenCheckoutRequest,
    inLockFollowUp: InLockFollowUp | undefined,
  ): Promise<OpenCheckoutResult> {
    const repoRoot = this.liveProjectRoot(request.projectId);
    if (repoRoot === null) {
      return { outcome: 'refused', reason: 'unknown-project' };
    }

    // §3.9, BOTH halves, before the name is ever built into a command line.
    const grammarRefusal = await this.validateCallerRef(repoRoot, request.branch);
    if (grammarRefusal !== null) {
      return grammarRefusal;
    }

    const branchExists = await this.deps.adapter.localBranchExists(repoRoot, request.branch);
    if (!branchExists.ok) {
      return refusalFromGitError(branchExists.error, branchExists.detail);
    }
    if (!branchExists.value) {
      return { outcome: 'refused', reason: 'branch-not-found' };
    }

    const checkedOutAt = await this.worktreePathForBranch(repoRoot, request.branch);
    if (checkedOutAt.outcome === 'refused') {
      return checkedOutAt;
    }
    if (checkedOutAt.path !== null) {
      return {
        outcome: 'refused',
        reason: 'branch-checked-out-elsewhere',
        // An ENGINE-DERIVED fact (git's own worktree list), never a caller echo.
        detail: checkedOutAt.path,
      };
    }

    const nodeId = this.deps.ids.uuid();
    const derivedPath = this.derivePath(nodeId);
    if (derivedPath === null) {
      return { outcome: 'refused', reason: 'path-escapes-worktree-root' };
    }
    if (await this.deps.pathExists(derivedPath)) {
      // Cannot legitimately happen (fresh uuid ⇒ fresh path) — so it is loud and
      // never repaired.
      return { outcome: 'refused', reason: 'checkout-unrecorded-mismatch', detail: derivedPath };
    }

    // The branch TIP at open time — recorded for the same reason create records
    // its base commit: a ref moves, and provenance must stay checkable.
    const tip = await this.deps.adapter.resolveCommit(repoRoot, request.branch);
    if (!tip.ok) {
      return refusalFromGitError(tip.error, tip.detail);
    }

    const addResult = await this.deps.adapter.addWorktreeForBranch(repoRoot, {
      path: derivedPath,
      branch: request.branch,
    });
    if (!addResult.ok) {
      return refusalFromGitError(addResult.error, addResult.detail);
    }

    const provenance: NodeProvenance = {
      branch: request.branch,
      // For `open`, the branch IS the base: the checkout starts at its tip and
      // both facts are recorded so the claim stays checkable after it advances.
      baseRef: request.branch,
      resolvedCommit: tip.value,
      path: derivedPath,
    };
    return this.recordCheckout({
      repoRoot,
      projectId: request.projectId,
      nodeId,
      provenance,
      inLockFollowUp,
      // ⚠ §3.7's nuance: the branch PRE-EXISTED and must survive compensation.
      // Deleting it here would destroy a human's work to tidy up after our own
      // failed bookkeeping.
      compensateBranch: false,
      succeededAs: 'opened',
    });
  }

  /**
   * §3.4 + §3.3: remove a checkout, derived from the NODE'S RECORDED PROVENANCE
   * and never from the request.
   *
   * ⚠ **THE GATE IS RE-READ INSIDE THE LOCK, and that is the rev-2 hazard's
   * fix** (A7): a remove that checked its sessions before queueing would decide
   * against a world that no longer exists by the time it runs.
   *
   * ⚠ **THE BRANCH IS NEVER DELETED** (A10). Removal reclaims a directory;
   * destroying commits is a strictly larger act and no verb in v1 performs it
   * except §3.7 compensation, on a branch the engine minted seconds earlier.
   */
  async remove(request: RemoveCheckoutRequest): Promise<RemoveCheckoutResult> {
    // The node is read OUTSIDE the lock for one reason only: to learn which
    // project's lock to take. Every gate is re-read inside.
    const preliminaryNode = this.deps.readNodes().nodes[request.nodeId];
    if (preliminaryNode === undefined) {
      return { outcome: 'refused', reason: 'unknown-node' };
    }
    return this.withProjectLock(preliminaryNode.projectId, () => this.removeInLock(request));
  }

  private async removeInLock(request: RemoveCheckoutRequest): Promise<RemoveCheckoutResult> {
    const node = this.deps.readNodes().nodes[request.nodeId];
    if (node === undefined) {
      return { outcome: 'refused', reason: 'unknown-node' };
    }
    const provenance = node.provenance;
    if (provenance === null || provenance === undefined) {
      return { outcome: 'refused', reason: 'not-a-checkout' };
    }

    // ⚠ AN ARCHIVED PROJECT IS ACCEPTED HERE, unlike create/open. Archiving is
    // how a boundary stops claiming LIVE WORK; it is not a reason to strand a
    // directory on disk forever. Only a project record that does not exist at
    // all leaves us with no repository to run git in.
    const project = this.deps.readProjects().projects[node.projectId];
    if (project === undefined) {
      return { outcome: 'refused', reason: 'unknown-project' };
    }
    const repoRoot = project.root;

    // §3.3's gate, from a FRESH read inside the lock. Both prongs, each named.
    const liveBlockers = liveSessionsInCheckout(this.deps.readSessions(), provenance.path);
    const transcriptBlockers = transcriptSessionsInCheckout(this.deps.readSessions(), provenance.path);
    if (liveBlockers.length > 0 || transcriptBlockers.length > 0) {
      const blockingSessionIds = [
        ...new Set([...liveBlockers, ...transcriptBlockers].map((session) => session.appSessionId)),
      ].sort();
      return {
        outcome: 'refused',
        reason: 'checkout-in-use',
        // The blockers are NAMED (§3.3) so a human can go look at them rather
        // than guess which of their sessions is holding the directory.
        detail: blockingSessionIds.join(','),
      };
    }

    // §3.10's last row. Git's own worktree registry is the instrument — the same
    // question `worktreeManager.findExistingWorktree` has always asked — because
    // a path git does not know about is a path `worktree remove` would refuse.
    const worktrees = await this.deps.adapter.worktrees(repoRoot);
    if (!worktrees.ok) {
      return refusalFromGitError(worktrees.error, worktrees.detail);
    }
    const stillCheckedOut = worktrees.value.some(
      (worktree) => resolve(worktree.path) === resolve(provenance.path),
    );
    if (!stillCheckedOut) {
      // Idempotent SUCCESS, and **NO SECOND `checkout_removed`**: the audit log
      // records that disk was removed, and nothing was.
      return {
        outcome: 'removed',
        nodeId: node.nodeId,
        path: provenance.path,
        branch: provenance.branch,
        diskRemoved: false,
      };
    }

    const removeResult = await this.deps.adapter.removeWorktree(repoRoot, provenance.path);
    if (!removeResult.ok) {
      return refusalFromGitError(removeResult.error, removeResult.detail);
    }

    // No compensation is possible or wanted here: the directory is gone, and
    // re-creating it would be inventing a checkout rather than restoring one. A
    // throw from the append surfaces to the caller with the disk fact already
    // true — which is why this event is the LAST thing the sequence does.
    this.deps.emit([
      checkoutRemoved({ nodeId: node.nodeId, path: provenance.path, branch: provenance.branch }),
    ]);

    return {
      outcome: 'removed',
      nodeId: node.nodeId,
      path: provenance.path,
      branch: provenance.branch,
      diskRemoved: true,
    };
  }

  /**
   * §3.7's recovery contract: which checkouts under `worktreeRoot` does NO
   * node's provenance claim?
   *
   * ⚠ **DISCOVERY ONLY — NO ADOPTION, NO REMOVAL.** An orphan is what process
   * death mid-sequence leaves behind, and v1's honest answer is to SAY SO (a
   * boot WARN line, and the read route in U4) rather than to adopt a directory
   * whose history nobody recorded or to delete one that might hold work. A fresh
   * create mints a fresh nodeId → a fresh branch and path → and proceeds cleanly
   * BESIDE the orphan; it never collides with it and never silently absorbs it
   * (A9).
   *
   * Takes NO lock: it reads, it decides nothing, and it changes nothing.
   *
   * A project whose repository cannot be listed (git down, root moved) is
   * SKIPPED with a warn rather than failing the whole listing — this runs at
   * boot, and a boot diagnostic that can abort a boot is worse than the gap it
   * reports.
   */
  async listOrphans(): Promise<OrphanCheckout[]> {
    const claimedPaths = new Set<string>();
    for (const node of Object.values(this.deps.readNodes().nodes)) {
      if (node.provenance !== null && node.provenance !== undefined) {
        claimedPaths.add(resolve(node.provenance.path));
      }
    }
    const resolvedWorktreeRoot = resolve(this.deps.worktreeRoot);

    const orphans: OrphanCheckout[] = [];
    for (const project of Object.values(this.deps.readProjects().projects)) {
      if (project.archived) {
        continue;
      }
      const worktrees = await this.deps.adapter.worktrees(project.root);
      if (!worktrees.ok) {
        this.deps.logWarn(
          `checkout orphan scan skipped project ${project.projectId} (${project.root}): ${worktrees.error}${
            worktrees.detail === undefined ? '' : ` — ${worktrees.detail}`
          }`,
        );
        continue;
      }
      for (const worktree of worktrees.value) {
        const worktreePath = resolve(worktree.path);
        // Only what lives under OUR root is ours to call an orphan: a human's
        // own worktree elsewhere in their repo is not the engine's business.
        if (!isBeneathRoot(worktreePath, resolvedWorktreeRoot)) {
          continue;
        }
        if (claimedPaths.has(worktreePath)) {
          continue;
        }
        orphans.push({ projectId: project.projectId, path: worktree.path, branch: worktree.branch });
      }
    }
    return orphans;
  }

  // ── the shared tail of create and open: record, follow up, or COMPENSATE ───
  //
  // One function for both verbs because §3.7's only difference between them is
  // WHETHER THE BRANCH IS OURS TO DELETE. Everything else — the emission, the
  // follow-up, the loudness, the zero-orphans guarantee — is identical, and two
  // copies would be two places for that guarantee to drift.
  private async recordCheckout<SuccessOutcome extends 'created' | 'opened'>(step: {
    repoRoot: string;
    projectId: string;
    nodeId: string;
    provenance: NodeProvenance;
    inLockFollowUp: InLockFollowUp | undefined;
    compensateBranch: boolean;
    succeededAs: SuccessOutcome;
  }): Promise<{ outcome: SuccessOutcome; node: NodeRecord } | CheckoutRefusal> {
    let bornNode: NodeRecord;
    try {
      const writeResult = this.deps.nodeWriter.createCheckoutNode({
        nodeId: step.nodeId,
        projectId: step.projectId,
        // The node's LABEL is its branch: for `open` that is the human's own
        // branch name, which is exactly what they would want to see in a tree;
        // for `create` it is the engine-derived name, which is honest about what
        // the node is. One rule, both verbs.
        name: step.provenance.branch,
        directory: step.provenance.path,
        provenance: step.provenance,
      });
      if (writeResult.outcome === 'refused') {
        // A refusal AFTER git performed is still a failure of the whole
        // sequence, so it is compensated exactly like a throw — and then
        // reported loudly rather than as a bare "no".
        await this.compensate(step.repoRoot, step.provenance, step.compensateBranch);
        return {
          outcome: 'refused',
          reason: 'node-write-refused',
          detail: writeResult.reason,
        };
      }
      bornNode = writeResult.node;

      if (step.inLockFollowUp !== undefined) {
        // ⚠ INSIDE THE LOCK (§3.3). See `InLockFollowUp`.
        await step.inLockFollowUp({
          nodeId: step.nodeId,
          path: step.provenance.path,
          branch: step.provenance.branch,
        });
      }
    } catch (sequenceError) {
      // §3.7: git succeeded, the bookkeeping did not. Un-make the git work, then
      // FAIL LOUDLY — never swallow, never return a plausible-looking success.
      await this.compensate(step.repoRoot, step.provenance, step.compensateBranch);
      throw sequenceError;
    }

    return { outcome: step.succeededAs, node: bornNode };
  }

  /**
   * §3.7's in-process compensation, INSIDE the lock.
   *
   * Removes the checkout, and — only when the branch was OURS — deletes the
   * branch too. `deleteBranch` exists in the adapter for this caller and no
   * other.
   *
   * ⚠ **A COMPENSATION THAT ITSELF FAILS IS LOGGED LOUD AND NEVER SWALLOWED.**
   * That path is the process-death-equivalent: what it leaves behind is exactly
   * an orphan, which is what `listOrphans` exists to surface. Reporting it is
   * the whole difference between "we know there is a stray checkout" and "the
   * disk quietly filled up".
   */
  private async compensate(
    repoRoot: string,
    provenance: NodeProvenance,
    compensateBranch: boolean,
  ): Promise<void> {
    const removeResult = await this.safeGitOp(() =>
      this.deps.adapter.removeWorktree(repoRoot, provenance.path),
    );
    if (!removeResult.ok) {
      this.deps.logWarn(
        `checkout compensation FAILED to remove ${provenance.path}: ${removeResult.error}${
          removeResult.detail === undefined ? '' : ` — ${removeResult.detail}`
        } (an orphan checkout remains; see the boot orphan scan)`,
      );
    }
    if (!compensateBranch) {
      // `open`'s branch PRE-EXISTED. It survives, always.
      return;
    }
    const deleteResult = await this.safeGitOp(() =>
      this.deps.adapter.deleteBranch(repoRoot, provenance.branch),
    );
    if (!deleteResult.ok) {
      this.deps.logWarn(
        `checkout compensation FAILED to delete branch ${provenance.branch}: ${deleteResult.error}${
          deleteResult.detail === undefined ? '' : ` — ${deleteResult.detail}`
        }`,
      );
    }
  }

  // A compensation step must never throw its own exception over the ORIGINAL
  // failure — the original is the one a human needs to see. An adapter that
  // throws (an injected one is not something this class gets to assume
  // well-behaved) is turned into a reported result, exactly as
  // `WorktreeManager.runGit` does for the same reason.
  private async safeGitOp(operation: () => Promise<GitOpResult<null>>): Promise<GitOpResult<null>> {
    try {
      return await operation();
    } catch (thrownError) {
      return {
        ok: false,
        error: 'git-failed',
        detail: `git-adapter-threw:${thrownError instanceof Error ? thrownError.message : String(thrownError)}`,
      };
    }
  }

  // ── §3.1's PINNED default-branch algorithm, and the caller-supplied path ───
  //
  // The four steps live HERE and not in the adapter, which only answers what
  // exists (`originHeadTarget`, `localBranchExists`). Both outputs are returned
  // — the ref NAME and the COMMIT it meant — because §3.1 records both and a
  // provenance carrying only one of them is not checkable.
  private async resolveBaseRef(
    repoRoot: string,
    requestedBaseRef: string | undefined,
  ): Promise<{ outcome: 'resolved'; baseRef: string; resolvedCommit: string } | CheckoutRefusal> {
    let baseRef: string;
    if (requestedBaseRef !== undefined) {
      const grammarRefusal = await this.validateCallerRef(repoRoot, requestedBaseRef);
      if (grammarRefusal !== null) {
        return grammarRefusal;
      }
      baseRef = requestedBaseRef;
    } else {
      const defaultRef = await this.resolveDefaultBranch(repoRoot);
      if (defaultRef.outcome === 'refused') {
        return defaultRef;
      }
      baseRef = defaultRef.baseRef;
    }

    const resolved = await this.deps.adapter.resolveCommit(repoRoot, baseRef);
    if (!resolved.ok) {
      if (resolved.error === 'git-failed') {
        // A well-formed ref that resolves to nothing is a REQUEST problem
        // (400-class per §3.5), not a git outage.
        return { outcome: 'refused', reason: 'unresolvable-ref', detail: baseRef };
      }
      return refusalFromGitError(resolved.error, resolved.detail);
    }
    return { outcome: 'resolved', baseRef, resolvedCommit: resolved.value };
  }

  // §3.1's four steps, in order: origin/HEAD's target, then local `main`, then
  // local `master`, then REFUSE. Never a remote guess, never a network call —
  // this is a PINNED LOCAL algorithm, so a repo with no origin and no
  // conventionally-named branch gets an honest "name a base ref" rather than a
  // default somebody has to reverse-engineer.
  private async resolveDefaultBranch(
    repoRoot: string,
  ): Promise<{ outcome: 'resolved'; baseRef: string } | CheckoutRefusal> {
    const originHead = await this.deps.adapter.originHeadTarget(repoRoot);
    if (!originHead.ok) {
      return refusalFromGitError(originHead.error, originHead.detail);
    }
    if (originHead.value !== null) {
      return { outcome: 'resolved', baseRef: originHead.value };
    }
    for (const candidateBranch of ['main', 'master']) {
      const exists = await this.deps.adapter.localBranchExists(repoRoot, candidateBranch);
      if (!exists.ok) {
        return refusalFromGitError(exists.error, exists.detail);
      }
      if (exists.value) {
        return { outcome: 'resolved', baseRef: candidateBranch };
      }
    }
    return { outcome: 'refused', reason: 'no-default-branch' };
  }

  // §3.9, BOTH halves at the boundary: core's pure conservative grammar first
  // (it refuses control bytes, traversal and option-shaped names without git
  // ever seeing them), then git's own `check-ref-format` for the cases only git
  // knows. Returns null when the candidate is acceptable.
  private async validateCallerRef(repoRoot: string, candidate: string): Promise<CheckoutRefusal | null> {
    const grammar = validateRefName(candidate);
    if (!grammar.ok) {
      return { outcome: 'refused', reason: 'invalid-ref', detail: grammar.reason };
    }
    const gitFormat = await this.deps.adapter.checkRefFormat(repoRoot, candidate);
    if (!gitFormat.ok) {
      return refusalFromGitError(gitFormat.error, gitFormat.detail);
    }
    if (!gitFormat.value) {
      return { outcome: 'refused', reason: 'invalid-ref', detail: 'check-ref-format' };
    }
    return null;
  }

  // §3.10's create row, with round 2's wording catch: the refusal DETAIL names
  // the existing checkout path when the branch has one, and OMITS it entirely
  // when the branch is not checked out anywhere. Both variants are pinned (A1).
  private async branchAlreadyExistsRefusal(repoRoot: string, branch: string): Promise<CheckoutRefusal> {
    const checkedOutAt = await this.worktreePathForBranch(repoRoot, branch);
    if (checkedOutAt.outcome === 'refused') {
      return checkedOutAt;
    }
    return checkedOutAt.path === null
      ? { outcome: 'refused', reason: 'branch-already-exists' }
      : { outcome: 'refused', reason: 'branch-already-exists', detail: checkedOutAt.path };
  }

  // Where is this branch checked out — in ANY worktree, the main checkout
  // included? `git worktree list` reports the main worktree as a record like any
  // other, which is what makes one query answer both halves of §3.10's second
  // row. `null` = nowhere.
  private async worktreePathForBranch(
    repoRoot: string,
    branch: string,
  ): Promise<{ outcome: 'listed'; path: string | null } | CheckoutRefusal> {
    const worktrees = await this.deps.adapter.worktrees(repoRoot);
    if (!worktrees.ok) {
      return refusalFromGitError(worktrees.error, worktrees.detail);
    }
    const branchRef = `refs/heads/${branch}`;
    const holder = worktrees.value.find((worktree) => worktree.branch === branchRef);
    return { outcome: 'listed', path: holder === undefined ? null : holder.path };
  }

  // The repository root for a LIVE project, or null. The projectRoot→projectId
  // join §3.2 leans on, read from the D42 registry — verified live-root-unique
  // there (`projectWriter.ts` refuses a duplicate live root), so this direction
  // of the join is well-defined too.
  private liveProjectRoot(projectId: string): string | null {
    const project = this.deps.readProjects().projects[projectId];
    if (project === undefined || project.archived) {
      return null;
    }
    return project.root;
  }

  // §3.4: the path is DERIVED (never accepted) and then VERIFIED to still be
  // beneath `worktreeRoot`. The verification is not theatre — it is the line
  // that makes "a caller-supplied filesystem path is never accepted" true even
  // if the derivation ever grew a bug, and it costs one comparison.
  private derivePath(nodeId: string): string | null {
    const resolvedWorktreeRoot = resolve(this.deps.worktreeRoot);
    const derivedPath = resolve(resolvedWorktreeRoot, nodeCheckoutDirName(nodeId));
    return isBeneathRoot(derivedPath, resolvedWorktreeRoot) && derivedPath !== resolvedWorktreeRoot
      ? derivedPath
      : null;
  }
}
