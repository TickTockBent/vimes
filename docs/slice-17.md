# Slice 17 — E2-c: the engine does git

**Status: SKELETON rev 2, 2026-08-18 — awaiting ⟨Wes⟩'s §3 signatures.
Nothing dispatches until signed.** Rev 1 (`48a0ac3`) was reviewed by an
OUTSIDE model (Sol, at ⟨Wes⟩'s instigation, 2026-08-18); the orchestrator
verified every factual premise against the repo before amending. All four
signature blockers were REAL — most notably rev 1's event model
contradicted signed E2-a — and are fixed below. Triage record in §7.
Supersedes the pre-slice frame (`e2c-git-skeleton.md`) and consumes the
recon (`e2c-recon-2026-08-13.md`).

Implements **E2-c** (decisions.md, settled 2026-08-05): humans and
extensions PROPOSE checkouts through one API; the engine's single
injection-guarded GitAdapter decides and performs. Principle 13 applied
to the filesystem.

## §0. Recon reconciliation (2026-08-18, orchestrator-verified at HEAD `691d5cc`)

The 08-13 recon re-verified five slices later — every load-bearing row
holds, one is BETTER than mapped:

- **gitAdapter.ts is still the only `execFile('git')` in the repo.**
- **worktreeManager already injects the adapter's `GitRunner`** — its
  private `runGit` duplicates the WRAPPER, not the subprocess seam.
  Absorption = collapse a duplicate wrapper + move verbs.
- **Pin 1's site confirmed** (`findExistingWorktree` :279, `reused:
  true` :164 — create still silently opens).
- **The provenance seal is intact both halves** (S14-A2; the nodes fold
  enforces write-once-at-creation STRUCTURALLY — no post-birth write
  path exists).
- **`TASK_WORKTREE_BRANCH_PREFIX = 'vimes/task-'` alive**; escaper +
  FNV-1a fingerprint intact.
- **`GET /api/git/worktrees` still unconsumed**; isolation default still
  `off`; worktreeManager callers: app.ts + taskDispatcher only.
- **Error-status precedent** (`gitApi.ts` `statusForOpError`):
  git-unavailable → 503, not-a-repo → 404, git-failed → 400.
- **`claudeSessionIds` is `[]` at `session_created`** and fills only at
  `claude_session_mapped` — a live just-spawned session has an empty
  list (drives §3.3's union predicate).
- **Migration map :92**: `task_worktree_created` → **E2's `node_created`
  with provenance** — the signed event model this slice must honor.

New facts since the recon that IMPROVE this slice's ground: unfiled is
reachable (S16/D90 floor); D91 names dispatched sessions; sessions
projection is v2 (gate input unchanged); `node_created` is
production-exercised; D94 is open (parked for this slice — §3.8).

## §1. Scope

- **GitAdapter grows the checkout lifecycle:** `create` / `open` /
  `remove`, engine vocabulary, absorbing `worktreeManager.ts` and
  `core/tasks/worktreePaths.ts` (prefix rewritten; injective
  `escapeToSafeCharset` + fingerprint survive VERBATIM). Every git
  mutation routes through the adapter by slice end.
- **Event model (E2-a honored):** `node_created` WITH provenance is THE
  state event for both `create` and `open` — a checkout node is BORN
  with its provenance (`{branch, baseRef, resolvedCommit, path}`,
  existing schema), write-once, the fold untouched. `checkout_removed`
  is a nodes-stream AUDIT fact recording disk lifecycle: schema lands
  (0.5), it NEVER clears provenance/directory/attachments/closure, and
  its fold is DEFERRED to the first consumer (adding the fold later is
  a deliberate nodes-projection bump, D86 — not this slice's job).
- **Pin 1 (verb split):** `create` on an existing branch refuses LOUD
  (closed-vocabulary `GitOpError`, names the existing checkout path,
  points at `open`). `open` attaches a NEW node to an EXISTING branch,
  with its own provenance (its `resolvedCommit` is the branch's tip at
  open time — merging the verbs is how provenance lies).
- **Pin 2 (remove gate):** §3.3's union predicate, projection query
  only — never discovery, never computed transcript paths (D45).
- **Identity & choreography** per §3.2 — the daemon mints the nodeId
  BEFORE git runs; branch and path derive from it; the spawned session
  attaches to the node it runs in.
- **API routes:** propose-verbs carrying IDENTITIES AND INTENT, never
  filesystem authority (§3.4); refusal statuses per §3.5.
- **Dispatcher migrates to the new verbs** in its own unit with its own
  gate (two-writers-during-transition is the named hazard; sequencing
  is the mitigation).

## §2. Explicitly out

- Any UI beyond existing reads continuing to work (`GET
  /api/git/worktrees` stays unconsumed this slice).
- Merge / rebase / push — checkout lifecycle only in v1.
- Auto-cleanup policy (reaper) and any `force` escape on remove —
  reserve the decisions, build neither.
- Flipping `VIMES_WORKTREE_ISOLATION` default — stays `off`.
- The `checkout_removed` FOLD and any NodeRecord growth — deferred to
  the first consumer (the event schema itself is in scope).
- D94 enforcement — parked (§3.8).

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

1. **Base ref resolution (revised per review).** `create` takes an
   optional base ref, defaulted to the project's default branch. The
   adapter RESOLVES the ref to an immutable commit FIRST, records BOTH
   (`baseRef` as requested/defaulted name, `resolvedCommit`), and
   creates the worktree FROM THE COMMIT — never from a ref that can
   move between resolution and `git worktree add`.
2. **Identity & choreography (NEW, the review's gap 2).** For every
   engine-created checkout, in order: the daemon MINTS the nodeId
   (uuid) → derives branch + path from it (§3.6) → resolves base
   (§3.1) → runs git → emits `node_created` with provenance (under the
   task's project: the projectRoot→projectId join — U3 verifies the
   join exists and reports if it doesn't, kill criterion 4) → spawns
   the session with cwd = the checkout → emits
   `session_attached_to_node` to that node. Consequence, deliberate:
   dispatcher worktree sessions land IN the project's tree on their
   checkout node — the attribution gap closes STRUCTURALLY for new
   worktree sessions (the cost-ledger half of the gap stays future).
3. **Remove gate predicate (revised per review).** Remove refuses
   (409, naming the blockers) when EITHER: (a) any LIVE session's cwd
   matches the checkout path — regardless of claudeSessionIds, a
   fresh spawn has an empty list; OR (b) any session, live or dead,
   has a matching cwd AND non-empty claudeSessionIds (the resume
   fact, SP8·2). No `force` in v1. **Concurrency:** all four
   checkout-touching operations (create / open / remove / the
   dispatcher's ensure path) serialize through a KEYED in-process
   async lock (key = derived checkout path) in the adapter — the
   daemon is the single process performing git, so an in-process lock
   closes the check/use race; the gate re-reads the projection INSIDE
   the critical section.
4. **API authority (revised per review).** Routes accept identities
   and intent ONLY — projectId + verb + (base ref | node ref). The
   engine resolves the repository from the project record, derives the
   checkout path under `worktreeRoot`, and verifies the derivation
   stays beneath it. A caller-supplied filesystem path is never
   accepted; `remove` derives its target from the NODE's recorded
   provenance, never from the request.
5. **Refusal statuses (revised per review).** 409 is reserved for
   STATE conflicts (branch exists → points at `open`; resumable/live
   sessions block remove; checkout busy under the lock). Existing
   precedent keeps its statuses: git-unavailable 503, not-a-repo 404,
   validation failures 400. Closed vocabulary throughout, never a path
   echo beyond the engine's own derived facts.
6. **Branch AND directory shape (completed per review).** Branch:
   `vimes/node-<escaped-node-id>-<fp>`. Directory:
   `<worktreeRoot>/node-<escaped-node-id>-<fp>`. Both derive from the
   nodeId through the surviving injective escaper + fingerprint; the
   tenant word `task` appears in neither.
7. **Crash consistency (NEW, per review).** Order: git FIRST, event
   SECOND. The gap (git succeeded, event never landed) is closed by
   IDEMPOTENT COMPLETION: because branch and path derive from the
   pre-minted nodeId, a retry carrying the same nodeId finds the
   existing checkout, VERIFIES it matches its own derivation
   (branch, path, and — via `git rev-parse` — a commit reachable from
   the recorded base), and completes by emitting the event. An
   existing checkout that does NOT match its derivation is a distinct
   closed-vocabulary refusal (`checkout-unrecorded-mismatch`), never
   adopted silently. Kill criterion 5 guards the case where
   idempotency can't be made to hold.
8. **D94: PARKED (review's recommendation, accepted).** Unrelated to
   git lifecycle, and the tree has no move op to guard (the fold's
   invariant 1: no `node_moved` exists). D94 waits for a focused
   NodeWriter/orchestrator unit; its open-questions entry stands.
9. **Ref validation grammar (sharpened per review).** The API-boundary
   validation lib accepts an EXPLICIT conservative grammar
   (`[A-Za-z0-9._/-]`, no leading `-`, no `..`, no trailing `/` or
   `.lock`, length-capped) AND the adapter additionally runs
   candidates through git's own `check-ref-format` semantics.
   "Unicode confusables" as a category dies — anything outside the
   grammar is refused, which subsumes it.

## §4. Assertions (S17-A#; lib-level per house rule)

- A1: `create` on an existing branch refuses naming `open` + the
  existing path; `open` on a missing branch refuses symmetrically; the
  create/open CONFLICT MATRIX (branch × worktree: exists/absent, four
  cells) is pinned exhaustively.
- A2: single-writer grep — no `worktree`/`branch` git invocation
  outside gitAdapter.ts in live code (S16-A7 framing).
- A3: `node_created`-with-provenance replays deterministically; the
  fold never reads disk; every existing S14-A2 write-once assertion
  stays green UNMODIFIED; a second provenance write refuses.
- A4: the remove gate reddens for BOTH §3.3 prongs independently
  (live-empty-ids AND dead-with-transcripts); sabotage each prong's
  guard line, prove the right test reddens.
- A5: branch names tenant-word-free (#16 grep); hostile ref names
  (control bytes, option-shaped `-`/`--` prefixes, traversal, out-of-
  grammar) refused at the boundary by the validation lib.
- A6: immutable base — the recorded `resolvedCommit` equals the
  worktree's actual HEAD at creation even when the base REF is moved
  between resolution and add (injected-runner interleaving test).
- A7: concurrency — a remove and a dispatch racing on the same derived
  path serialize under the keyed lock; the loser gets the 409, never a
  half-removed checkout (deterministic interleaving via the injected
  runner; the lock, not wall clocks, is what's proven).
- A8: crash-gap — create → (event write fails) → retry with the same
  nodeId completes idempotently; retry against a MISMATCHED existing
  checkout refuses `checkout-unrecorded-mismatch`.
- A9: removal preserves branch, provenance, node closure state, and
  session attachments (only disk + the audit event change).
- A10: no-fallback holds — `worktree-failed` still spawns NOTHING.
- Prior suites green (0.4). Baseline 3531/147. (No nodes-projection
  bump this slice — asserted by the existing version pin staying 1.)

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (core, lib):** ref-validation lib + hostile tests (§3.9);
  worktreePaths rewrite (§3.6, escaper verbatim); `checkout_removed`
  schema (0.5, no fold); verify the nodes fold accepts provenance-
  bearing `node_created` exactly as the E2-a schema promises — report,
  don't improvise.
- **U2 (daemon, THE ADAPTER):** create/open/remove + keyed lock;
  worktreeManager wrapper collapses; pins 1+2; §3.1 immutable-base;
  §3.7 idempotent completion; provenance emitter through nodeWriter
  (the seal opens; S14-A2 tests untouched); `checkout_removed`
  emitted. ONE restart owed.
- **U3 (daemon):** taskDispatcher migrates to the new verbs + §3.2
  choreography (nodeId mint → git → node_created → spawn → attach);
  worktreeManager.ts dies; no-fallback re-verified; projectRoot→
  projectId join verified-or-reported. Restart (bundle with U2's if
  pipelining allows — Wes owns awareness, D19).
- **U4 (API):** propose routes per §3.4 + status vocabulary per §3.5.
  No UI.
- Deploys: U2/U3 daemon restarts (or one bundled); U4 rides ci-gate.
  No `.vue` files are touched, so no per-unit vue-tsc legs are OWED —
  ci-gate's vue-tsc + vite build still run as always.

## §6. Gates & kill criteria

- **Machine gate:** full suite green ×2, ci-gate ALL PROFILES, A2/A5
  greps clean, plus LIVE FIRE on a SCRATCH repo (never a project
  root), exercised at the ROUTE level, not adapter-only: create →
  create-again-refused-naming-open → open → remove-gated-by-live-
  session → remove-gated-by-dead-session-with-transcript → remove →
  branch survives. The §4 matrix rows (A6 immutable base, A7 race, A8
  crash-gap) run in the deterministic harness.
- **Human gate:** none scheduled — no UI ships. ⟨Wes⟩'s §3 signature
  is the design gate; the first worktree-node UI slice inherits the
  lived-gate duty.
- **Kill criteria:** (1) absorbing worktreeManager requires RELAXING
  the provenance write-once fold — halt. (2) The remove gate cannot be
  expressed as a projection query without computed transcript paths —
  halt (D45). (3) The dispatcher migration cannot be sequenced without
  a two-writer window — halt, decision record. (4) The projectRoot→
  projectId join doesn't exist or is ambiguous — halt, the §3.2
  choreography needs a ruling, not an improvisation. (5) §3.7's
  idempotent completion cannot be made safe (derivation-match
  undecidable) — halt, crash-consistency needs its own decision
  record.

## §7. Outside-review triage record (Sol, 2026-08-18)

⟨Wes⟩ commissioned an outside-model review of rev 1. Orchestrator
verified every factual premise against the repo; disposition:

- **Blocker 1 (event model vs E2-a): ACCEPTED — rev 1 was WRONG.**
  Verified: architecture.md's one-table/write-once model, the fold's
  structural enforcement, migration-map :92's `task_worktree_created →
  node_created`. Rev 1's separate `checkout_created/opened` fold
  contradicted signed design; §1/§3 now honor E2-a (`node_created`
  carries provenance; `checkout_removed` is audit-only, fold
  deferred).
- **Blocker 2 (identity/choreography): ACCEPTED** → §3.2, with the
  deliberate consequence named (worktree sessions land on their node,
  in-tree). Kill criterion 4 guards the join.
- **Blocker 3 (gate hole + race): ACCEPTED** — `claudeSessionIds: []`
  at spawn verified; §3.3 union predicate + keyed lock + A4/A7.
- **Blocker 4 (API authority): ACCEPTED** → §3.4 identities-and-
  intent; caller paths never accepted.
- **Sharper wordings: ALL ACCEPTED** — immutable base (§3.1), explicit
  ref grammar replacing "confusables" (§3.9), directory shape (§3.6),
  status mapping per precedent (§3.5), crash consistency (§3.7),
  vue-tsc wording (§5).
- **D94 park: ACCEPTED** (§3.8) — the reviewer's one-step-at-a-time
  argument is the house's own; rev 1's rider lean withdrawn.
- **Gate additions: ALL ACCEPTED** (§4 A6–A9, §6 route-level live
  fire).
- Nothing in the review was declined; two of its premises the
  orchestrator re-verified rather than trusted (fold enforcement,
  claudeSessionIds timing) and both held exactly as claimed.
