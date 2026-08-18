# Slice 17 — E2-c: the engine does git

**Status: SIGNED 2026-08-18 ⟨Wes⟩ — "Signed, I think we're good to go."
All eleven §3 decisions signed at rev 3, including the three
orchestrator-chosen options flagged in the signing packet (crash
recovery via compensation + orphan discovery; coordinator-owned
repo-scoped queued lock; the §3.10 open table). Units dispatch
sequentially per §5.** Rev 1 (`48a0ac3`) and rev 2
(`44f056f`) were each reviewed by an outside model (Sol, at ⟨Wes⟩'s
instigation); the orchestrator verified premises against the repo before
amending. Round 1 fixed four blockers (rev 1's event model contradicted
signed E2-a). Round 2 fixed three more: durable crash identity, lock
placement, and `open`'s state table. Triage records in §7. Supersedes
the pre-slice frame (`e2c-git-skeleton.md`) and consumes the recon
(`e2c-recon-2026-08-13.md`).

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
- **Pin 1's site confirmed** (`findExistingWorktree` :279, `reused:
  true` :164 — create still silently opens).
- **The provenance seal is intact both halves** (S14-A2; the nodes fold
  enforces write-once-at-creation STRUCTURALLY).
- **`TASK_WORKTREE_BRANCH_PREFIX = 'vimes/task-'` alive**; escaper +
  FNV-1a fingerprint intact.
- **`GET /api/git/worktrees` still unconsumed**; isolation default still
  `off`; worktreeManager callers: app.ts + taskDispatcher only.
- **Error-status precedent** (`gitApi.ts`): git-unavailable → 503,
  not-a-repo → 404, git-failed → 400.
- **`claudeSessionIds` is `[]` at `session_created`**, fills at
  `claude_session_mapped` (drives §3.3's union predicate).
- **Migration map :92**: `task_worktree_created` → **`node_created`
  with provenance** — the signed event model this slice honors.
- **Project creation refuses duplicate live roots**
  (`projectWriter.ts:81,163` `duplicate-root`) — the projectRoot→
  projectId join is well-defined for live projects (kill criterion 4
  still guards the dead/ambiguous edge).

New facts since the recon that IMPROVE this slice's ground: unfiled is
reachable (S16/D90 floor); D91 names dispatched sessions; sessions
projection is v2 (gate input unchanged); `node_created` is
production-exercised; D94 is open (parked — §3.8).

## §1. Scope

- **GitAdapter grows the checkout lifecycle** — `create` / `open` /
  `remove` as PURE GIT I/O verbs, absorbing `worktreeManager.ts` and
  `core/tasks/worktreePaths.ts` (prefix rewritten; injective escaper +
  fingerprint survive VERBATIM). Every git mutation routes through the
  adapter by slice end.
- **A CheckoutCoordinator (daemon service, NEW) owns orchestration**:
  the lock (§3.3), the choreography (§3.2), the gates, the event
  emission, and compensation (§3.7). The adapter performs; the
  coordinator decides. (Rev 2 put the lock in the adapter; that left
  the git→spawn window unguarded — §7 round 2.)
- **Event model (E2-a honored):** `node_created` WITH provenance is THE
  state event for both `create` and `open` — a checkout node is BORN
  with its provenance, write-once, fold untouched. `checkout_removed`
  is a nodes-stream AUDIT fact: payload `{nodeId, path, branch}`,
  emitted ONLY when disk was actually removed, fold DEFERRED to its
  first consumer (a later deliberate nodes bump, D86 — not this
  slice).
- **Pin 1 (verb split)** per §3.10's explicit state table. **Pin 2
  (remove gate)** per §3.3 — projection query only, never discovery,
  never computed transcript paths (D45).
- **API routes:** propose-verbs carrying IDENTITIES AND INTENT (§3.4);
  refusal statuses per §3.5.
- **Dispatcher migrates to the coordinator** in its own unit (§5 U3),
  transition-safe per §3.11.

## §2. Explicitly out

- Any UI beyond existing reads continuing to work.
- Merge / rebase / push — checkout lifecycle only in v1.
- Auto-cleanup reaper and any `force` escape on remove — reserved.
- Flipping `VIMES_WORKTREE_ISOLATION` default — stays `off`.
- The `checkout_removed` FOLD and any NodeRecord growth — deferred.
- Automatic crash-orphan ADOPTION — §3.7 defines discovery + refusal;
  adoption machinery is reserved with the reaper decision.
- D94 enforcement — parked (§3.8).

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

1. **Base ref resolution.** `create` takes an optional base ref,
   defaulted to the project's default branch resolved by a PINNED
   local algorithm: (1) `refs/remotes/origin/HEAD` target if present;
   (2) local `main`; (3) local `master`; (4) otherwise REFUSE
   (`no-default-branch`, 400) — an explicit base ref is then required.
   The winning ref is resolved to an immutable commit FIRST, BOTH are
   recorded (`baseRef` name, `resolvedCommit`), and the worktree is
   created FROM THE COMMIT — never from a ref that can move between
   resolution and `git worktree add`.
2. **Identity & choreography.** For every engine-created checkout, the
   COORDINATOR, inside one §3.3 critical section: mints the nodeId
   (uuid) → derives branch + path from it (§3.6) → resolves base
   (§3.1) → adapter runs git → emits `node_created` with provenance
   (under the task's project via the projectRoot→projectId join —
   verified live-root-unique, §0) → spawns the session with cwd = the
   checkout → emits `session_attached_to_node`. Consequence,
   deliberate: dispatcher worktree sessions land IN the project's tree
   on their checkout node — the attribution gap closes structurally
   for new worktree sessions.
3. **Remove gate + concurrency (revised, round 2).** Remove refuses
   (409, naming the blockers) when EITHER: (a) any LIVE session's cwd
   matches the checkout path — regardless of claudeSessionIds; OR
   (b) any session, live or dead, with matching cwd AND non-empty
   claudeSessionIds (SP8·2 resume fact). No `force` in v1.
   **The lock lives in the CheckoutCoordinator, not the adapter**, and
   is ONE repository-scoped async mutex per project (checkout ops are
   rare; key-granularity reasoning about branch-vs-path contention is
   not worth buying in v1). **Queued serialization, not try-lock**: a
   second operation WAITS, then re-evaluates its gates inside the
   lock — "checkout busy" as a 409 does not exist (rev 2 claimed both;
   this resolves it). Create/open hold the lock across git →
   node_created → spawn → session_attached_to_node; remove holds it
   across projection re-read → git remove → checkout_removed. Holding
   the lock across spawn serializes worktree dispatches per project —
   accepted v1 cost, stated here so it is priced, not discovered.
4. **API authority.** Routes accept identities and intent ONLY —
   projectId + verb + (base ref | branch | node ref). The engine
   resolves the repository from the project record, derives the
   checkout path under `worktreeRoot`, and verifies the derivation
   stays beneath it. A caller-supplied filesystem path is never
   accepted; `remove` derives its target from the NODE's recorded
   provenance, never from the request.
5. **Refusal statuses.** 409 is reserved for STATE conflicts (branch
   exists; branch checked out elsewhere; sessions block remove).
   Precedent statuses keep: git-unavailable 503, not-a-repo 404,
   validation/no-default 400. Closed vocabulary; never a path echo
   beyond the engine's own derived facts.
6. **Branch AND directory shape.** Branch:
   `vimes/node-<escaped-node-id>-<fp>`. Directory:
   `<worktreeRoot>/node-<escaped-node-id>-<fp>`. Both derive from the
   nodeId through the surviving injective escaper + fingerprint; the
   tenant word `task` appears in neither.
7. **Crash consistency (revised, round 2 — automatic crash completion
   ABANDONED).** Rev 2's idempotent retry required a nodeId that dies
   with process memory; rather than build a durable intent store for a
   feature that has never run in production (isolation off, zero
   worktrees ever created), v1 pins the honest contract:
   - **In-process failure (git succeeded, event write threw):** the
     coordinator COMPENSATES — `worktree remove` + delete the branch
     it just created (both engine-derived, recorded nowhere yet) —
     then refuses loudly. No orphan when the process survives.
   - **Process death mid-sequence:** the checkout on disk that no
     node's provenance claims is an ORPHAN. Recovery contract =
     DISCOVERY, not adoption: the coordinator lists orphans (adapter
     `worktrees()` under `worktreeRoot` minus provenance-claimed
     paths) at boot as a WARN log line, and the listing is exposed on
     the existing worktrees read route. Removal/adoption of orphans is
     manual and reserved with the reaper decision. A fresh retry mints
     a fresh nodeId → fresh branch/path → proceeds cleanly beside the
     orphan; it never collides with it and never silently adopts it.
   - `resolvedCommit` re-resolution across a crash is therefore a
     non-issue: the retry is a NEW create with a new resolution,
     recorded as its own fact; the orphan's commit stays recoverable
     from its own HEAD if adoption is ever built.
8. **D94: PARKED** (round 1; unchanged).
9. **Ref validation grammar.** Explicit conservative grammar
   (`[A-Za-z0-9._/-]`, no leading `-`, no `..`, no trailing `/` or
   `.lock`, length-capped) at the API boundary, AND the adapter runs
   candidates through git's own `check-ref-format` semantics.
10. **`open` state table (NEW, round 2 — replaces the abstract
    matrix).** `open(projectId, branch)` in v1:
    - Branch exists locally, NOT checked out anywhere → open CREATES a
      worktree for it at the NEW node-derived path (§3.6), provenance
      recorded with the branch tip as `resolvedCommit`.
    - Branch checked out ANYWHERE already (another worktree, the main
      checkout) → refuse `branch-checked-out-elsewhere` (409). No
      reuse, no adoption — reusing a foreign path violates §3.4's
      derivation rule.
    - Branch does not exist locally → refuse (`branch-not-found`,
      404-class per precedent).
    - The derived path is occupied by ANYTHING → refuse
      `checkout-unrecorded-mismatch` (409; cannot legitimately happen
      — fresh uuid ⇒ fresh path — so it is loud, never repaired).
    And `create`: branch already exists → refuse
    `branch-already-exists` (409) pointing at `open`; the refusal
    detail names the existing checkout path WHEN one exists, and omits
    it when the branch has no checkout (round 2's wording catch).
    Second `remove` of an already-removed checkout: idempotent SUCCESS
    no-op, NO second `checkout_removed` emitted.
11. **Transition safety (NEW, round 2).** U1 ADDS the node-derived
    helpers ALONGSIDE the legacy task-derived helpers; nothing consumes
    them until U3 switches the dispatcher and DELETES the legacy pair
    in the same unit. No intermediate deploy can derive `vimes/node-*`
    from a task id (theoretical under isolation-off, closed anyway).

## §4. Assertions (S17-A#; lib-level per house rule)

- A1: the §3.10 state table pinned row-by-row — every listed state ×
  verb has exactly the stated outcome, including both
  `branch-already-exists` detail variants and the remove no-op row.
- A2: single-writer grep — no `worktree`/`branch` git invocation
  outside gitAdapter.ts in live code (S16-A7 framing).
- A3: `node_created`-with-provenance replays deterministically; the
  fold never reads disk; every existing S14-A2 write-once assertion
  stays green UNMODIFIED. The COORDINATOR/WRITER refuses a second
  provenance write loudly; the fold's ignore-duplicate is the
  structural backstop, not the refusal (round 2's wording catch).
- A4: the remove gate reddens for BOTH §3.3 prongs independently;
  sabotage each prong's guard line, prove the right test reddens.
- A5: branch names tenant-word-free (#16 grep); hostile ref names
  refused by the grammar (control bytes, option-shaped, traversal,
  out-of-grammar).
- A6: immutable base — recorded `resolvedCommit` equals the worktree's
  actual HEAD even when the base REF moves between resolution and add
  (injected-runner interleaving).
- A7: coordinator lock — a remove racing a dispatch on the same
  project WAITS (queued, never 409-on-busy) and its re-read inside the
  lock sees the freshly spawned session (the rev-2 hazard sequence
  replayed deterministically: it must be IMPOSSIBLE, not unlikely).
- A8: compensation — git-succeeded-then-event-write-throws removes the
  checkout AND the branch, refuses loudly, leaves zero orphans; a
  subsequent create succeeds fresh.
- A9: orphan discovery — a checkout under worktreeRoot claimed by no
  provenance is listed as an orphan (boot WARN + read route); a fresh
  create beside it neither collides nor adopts.
- A10: removal preserves branch, provenance, node closure state, and
  session attachments (only disk + the audit event change).
- A11: no-fallback holds — `worktree-failed` still spawns NOTHING.
- Prior suites green (0.4). Baseline 3531/147. Nodes projection stays
  v1 (existing pin asserts it).

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (core, lib):** ref-validation lib + hostile tests (§3.9);
  node-derived naming helpers ADDED BESIDE legacy task helpers
  (§3.11); `checkout_removed` schema `{nodeId, path, branch}` (0.5,
  no fold); verify the nodes fold accepts provenance-bearing
  `node_created` exactly as the E2-a schema promises — report, don't
  improvise.
- **U2 (daemon, ADAPTER + COORDINATOR):** adapter create/open/remove
  as pure git verbs; worktreeManager wrapper collapses;
  CheckoutCoordinator with the repo-scoped queued lock, §3.10 table,
  §3.1 resolution, §3.7 compensation + orphan discovery; provenance
  emitter through nodeWriter (seal opens; S14-A2 tests untouched);
  `checkout_removed` emitted. ONE restart owed.
- **U3 (daemon):** taskDispatcher migrates to the coordinator (§3.2
  choreography inside the lock); legacy task-derived helpers DELETED
  (§3.11); worktreeManager.ts dies; no-fallback re-verified. Restart
  (bundle with U2's if pipelining allows — Wes owns awareness, D19).
- **U4 (API):** propose routes per §3.4 + status vocabulary per
  §3.5/§3.10. No UI.
- Deploys: U2/U3 daemon restarts (or one bundled); U4 rides ci-gate.
  No `.vue` files are touched, so no per-unit vue-tsc legs are OWED —
  ci-gate's vue-tsc + vite build still run as always.

## §5b. Unit ledger + in-mandate judgment record (running)

**U1 `da1de7c`** (2026-08-18): ref grammar lib, node-derived names
beside legacy, `checkout_removed` schema + no-fold-by-test. 3531 →
3585, zero changed pins. Agent self-caught a Write-tool NUL injection
pre-census and added the missing node-pair collision test its own
sabotage then proved load-bearing. One WO omission surfaced later:
U1 never exported the new symbols from the core barrel.

**U2 `ef5d3f9`** (2026-08-18): adapter checkout verbs + the
CheckoutCoordinator + nodeWriter engine path. 3585 → 3640, zero
changed pins; S14-A2 untouched; A10 verified by running. Orchestrator
gate: suite ×1 here (×2 at slice gate), lock/compensation code read,
independent prong-(b) sabotage reddened exactly its test. Judgment
items, all in-mandate, recorded with rationale AT the code:
- **Barrel exports**: U2 added U1's missing six re-export lines
  (STOP-file deviation, additive only, reported not hidden) — the
  alternative was daemon-side re-derivation, the §3.6 hazard itself.
  WO-authoring miss, orchestrator's.
- **"Live" = `liveness !== 'dead'`** for prong (a): the only reading
  under which (a)/(b) partition the space; `{spawning,running}` would
  let a dormant no-transcript session lose its cwd mid-life.
- **Gate matches cwd by EXACT equality** (the literal §3.3 reading).
  Sub-directory cwds don't block — safe BY CONSTRUCTION today:
  worktreeRoot is outside every project root, so no spawn surface can
  place a session below a checkout root; the coordinator's own
  follow-up spawns at the root. Known limitation, revisit if a
  surface ever spawns sub-cwd sessions.
- **`checkout_removed` appended directly** (not via a writer): no
  fold exists to protect (deferred, D86); it earns a writer when it
  earns a fold.
- **Checkout nodes born top-level** (`parentNodeId: null`, no
  parameter): parenting checkouts under groups is a real decision
  that lands with the surface that asks for it.
- **Rule 0.7 live observation**: git 2.43 `check-ref-format` REFUSES
  `--end-of-options` (exit 129) — its guard is the constant
  `refs/heads/` prefix instead. Observed in a scratch repo, not
  assumed from docs.
- Restart owed by U2+U3, bundled (none taken yet).

## §6. Gates & kill criteria

- **Machine gate:** full suite green ×2, ci-gate ALL PROFILES, A2/A5
  greps clean, plus LIVE FIRE at the ROUTE level against a SCRATCH
  repository registered as a TEMPORARY PROJECT on a test daemon (never
  a real production project root — round 2's wording): create →
  create-again-refused-naming-open → open-on-free-branch →
  open-refused-checked-out-elsewhere → remove-gated-by-live-session →
  remove-gated-by-dead-session-with-transcript → remove → branch
  survives → second-remove-no-op. The deterministic harness carries
  A6/A7/A8/A9.
- **Human gate:** none scheduled — no UI ships. ⟨Wes⟩'s §3 signature
  is the design gate; the first worktree-node UI slice inherits the
  lived-gate duty.
- **Kill criteria:** (1) absorbing worktreeManager requires RELAXING
  the provenance write-once fold — halt. (2) The remove gate cannot be
  a projection query without computed transcript paths — halt (D45).
  (3) The dispatcher migration cannot be sequenced without a
  two-writer window — halt, decision record. (4) The projectRoot→
  projectId join is ambiguous for a case the dispatcher actually hits
  — halt (§0 says live roots are unique; a dead-project edge earns a
  ruling). (5) Holding the coordinator lock across spawn measurably
  starves dispatches in practice — halt, the lock scope earns its own
  decision rather than a quiet narrowing.

## §7. Outside-review triage record (Sol; both rounds)

⟨Wes⟩ commissioned outside-model review of each skeleton revision. The
orchestrator verified factual premises against the repo before
amending; analysis-only points were walked, not trusted.

**Round 1 (rev 1 → rev 2), four blockers, ALL ACCEPTED:** (1) rev 1's
`checkout_created/opened` fold contradicted signed E2-a — verified
against architecture.md, the fold's structural write-once, and
migration-map :92; rev 1 was WRONG and the event model was re-aligned.
(2) Identity/choreography gap → §3.2. (3) Remove-gate hole
(`claudeSessionIds: []` at spawn — verified) + race → §3.3. (4) API
authority → §3.4. Sharper wordings all accepted (immutable base, ref
grammar, directory shape, status precedent, crash consistency,
vue-tsc). D94 rider withdrawn and parked. Nothing declined.

**Round 2 (rev 2 → rev 3), three blockers, ALL ACCEPTED, with the
orchestrator choosing among the reviewer's offered options:**
(1) Durable retry identity: rev 2's idempotent completion required a
nodeId that dies with the process. CHOSEN: abandon automatic crash
completion (the reviewer's option 4) + in-process compensation +
orphan-discovery contract (§3.7) — proportionate to a feature with
zero production use; a durable intent store is machinery without a
consumer. (2) Lock placement: the adapter-level lock left git→spawn
unguarded (the hazard sequence verified by inspection); CHOSEN:
coordinator-owned, ONE repo-scoped lock (the reviewer's v1
simplification), QUEUED semantics — the rev-2 "serialize AND 409"
contradiction resolved in favor of queueing. (3) `open` semantics:
the four-cell matrix replaced by §3.10's explicit state table,
adopting the reviewer's v1 rule set essentially verbatim. Smaller
amendments all accepted: default-branch algorithm (§3.1), transition
safety (§3.11), `checkout_removed` payload + repeat semantics (§1,
§3.10), live-fire wording (§6), A3 refusal attribution (§4). The
reviewer's supporting claim that project creation refuses duplicate
live roots was verified (`projectWriter.ts:81,163`).
