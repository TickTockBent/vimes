# E2-c skeleton — the engine does git (pre-slice frame)

**Status: FRAME, 2026-08-13 — orchestrator-authored ahead of scheduling
(Wes asked what future work could start early). §0 recon is running; this
becomes `slice-N.md` when Wes schedules it against the other queue heads
(the slice-16 UI follow-up, D73, InputLease-vs-Move-4). Nothing here is
dispatched.**

Implements **E2-c** (settled 2026-08-05, decisions.md D-face block +
architecture.md): both humans and extensions PROPOSE checkouts through one
API; the engine's single injection-guarded GitAdapter decides and performs.
Principle 13 applied to the filesystem.

## §0. Recon (DONE 2026-08-13 → full map in `e2c-recon-2026-08-13.md`)

**The reframe: the GitAdapter already exists** (`gitAdapter.ts` — the one
`execFile('git')` in the repo, injectable runner, structured `GitOpResult`,
read+write verbs). E2-c is EXTEND-in-place: absorb `worktreeManager.ts`
(its private `runGit` duplicates `GitAdapter.run`) and `worktreePaths.ts`
(prefix rewritten; the injective escaper + fingerprint survive verbatim),
add `create`/`open`/`remove`. Pin 1's exact site: `findExistingWorktree`
matches path-OR-BRANCH and silently opens on `create` today. Pin 2's gate
is wholly missing (removeWorktree has zero callers; query the SESSIONS
projection for cwd-match + non-empty claudeSessionIds — never discovery,
never computed transcript paths per D45). The provenance seal in
nodeWriter/nodeApi is this slice's to open, fold write-once untouched.
`GET /api/git/worktrees` is shipped and unconsumed — the free read half.
Hazards: allowlist drops a worktree cwd when its session dies (403 on
inspect); the attribution gap sends worktree sessions to `unfiled` under
the slice-15 tree; `worktree-failed` no-fallback must hold. Note:
isolation default is off — NO production worktree has ever been created.

## §1. Scope (draft)

- **The GitAdapter** (daemon, rule 0.3: git is I/O, so it lives at the
  boundary; core owns the STATE — what checkouts exist as facts — never the
  side effects). ONE module; every git mutation in the codebase routes
  through it by the end of the slice.
- **Three verbs, engine vocabulary:** `create` (new branch + worktree —
  fails LOUD if the branch exists, error points at `open`; E2-c pin 1),
  `open` (attach a node to an existing branch/checkout — different
  provenance: the resolved commit differs, and silently merging the verbs is
  how provenance lies), `remove` (gated or loudly warned when resumable
  sessions have transcripts against the worktree path; E2-c pin 2 / SP8·2).
- **Events (0.5 — shapes land even where behavior stubs):** checkout facts
  as spine events (`checkout_created` / `checkout_opened` /
  `checkout_removed` — names TBD at skeleton proper) folding into node
  state: a worktree node is a node whose `directory` names an
  engine-created checkout, with checkout provenance recorded write-once
  (the E2-a idiom).
- **Branch naming is engine-derived** from the node/instance id — the
  migration-map rule: a tenant word in a branch name is a tenant word in the
  engine (#16). The old `vimes/task-` prefix dies with its call sites.
- **API routes** (the public API is the extension API, #15): propose-verbs
  only; refusals closed-vocabulary 409s, the S14 NodeWriter pattern
  (writer protects the log with loud refusals; fold protects state).

## §2. Explicitly out (draft)

- Any UI beyond wiring existing GitPanel reads through unchanged routes.
- Merge/rebase/push — the adapter does CHECKOUT lifecycle only in v1.
- Auto-cleanup policy (when unreferenced worktrees get removed) — reserve
  the decision, don't build the reaper.
- Migrating the dispatch machinery's existing worktree path in the same
  unit that builds the adapter (absorb it as its own unit with its own
  gate; two writers during transition is the known hazard).

## §3. Design questions to settle at skeleton proper (with leans)

- **Q-a:** does `create` take a base ref, or always the project's default
  branch HEAD? *Lean: explicit base ref, defaulted; the staleness-guard
  trial finding (work referencing symbols absent at the node's checkout
  base fails loud) wants the base recorded as a fact either way.*
- **Q-b:** is the checkout a property of the NODE (directory + provenance)
  or a separate entity the node references? *Lean: node property — E3-a
  already made directory a node fact; a second entity is a second source
  of record.*
- **Q-c:** what does `remove`'s gate CHECK — liveness of attached sessions,
  or existence of any transcript whose cwd matches? *Lean: transcript-cwd
  existence (the SP8·2 fact is about resume, not liveness; a dead session
  is exactly the one you'd want to resume).*
- **Q-d:** injection guarding — args-array execFile everywhere plus a
  ref-name validation at the boundary? *Lean: yes, and the validation is a
  lib function with hostile-input tests; recon will say whether a precedent
  helper exists.*

## §4. Assertions / invariants (sketch — numbered at skeleton proper)

Create-on-existing-branch refuses loudly naming `open`; verbs are the only
writers (grep-assertable: no `git worktree`/`git branch` invocation outside
the adapter); checkout facts replay deterministically (fold from events,
never from disk state — disk is I/O, the log is truth); remove-gate
reddens when a matching-cwd transcript exists; branch names contain no
tenant word (#16 grep); hostile ref names refused at the boundary.

## §5. Why this can start early

Every piece above is signed design (E2-c, E2-a idiom, #15, #16, principle
13); nothing depends on slice 15's human gate. The first REAL consumer
(worktree nodes in the tree UI, parallel-exploration groups) arrives right
after the tree era opens — building the adapter behind the API it will be
consumed through is 0.5 discipline, not speculation.
