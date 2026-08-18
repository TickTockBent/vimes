# Slice 17 — E2-c: the engine does git

**Status: SKELETON 2026-08-18 — awaiting ⟨Wes⟩'s §3 signatures. Nothing
dispatches until signed.** Supersedes the pre-slice frame
(`e2c-git-skeleton.md`, 2026-08-13) and consumes the recon
(`e2c-recon-2026-08-13.md`); both stay as the record of what was known
when. Sequenced per the ⟨Wes⟩-approved order (slice 16 → **E2-c** →
Move 4; InputLease parked).

Implements **E2-c** (decisions.md, settled 2026-08-05): humans and
extensions PROPOSE checkouts through one API; the engine's single
injection-guarded GitAdapter decides and performs. Principle 13 applied
to the filesystem.

## §0. Recon reconciliation (2026-08-18, orchestrator-verified at HEAD `691d5cc`)

The 08-13 recon re-verified five slices later — every load-bearing row
holds, one is BETTER than mapped:

- **gitAdapter.ts is still the only `execFile('git')` in the repo.**
- **worktreeManager already injects the adapter's `GitRunner`** (line 3,
  36; "nothing in this file shells out") — its private `runGit`
  duplicates the WRAPPER, not the subprocess seam. Absorption = collapse
  a duplicate wrapper + move verbs, not re-plumb a second seam.
- **Pin 1's site confirmed** (`findExistingWorktree` at :279, called
  :156/:233, `reused: true` at :164 — create still silently opens).
- **The provenance seal is intact both halves** (S14-A2: writer stamps
  `provenance: null` unconditionally at nodeWriter.ts:293; nodeApi drops
  smuggled provenance; fold write-once untouched).
- **`TASK_WORKTREE_BRANCH_PREFIX = 'vimes/task-'` alive** (worktreePaths
  :29); escaper + FNV-1a fingerprint intact.
- **`GET /api/git/worktrees` still unconsumed** by any UI.
- **Isolation default still `off`** (config :275); no production worktree
  has ever been created. Callers of worktreeManager: app.ts (wiring) +
  taskDispatcher only.

New facts since the recon that IMPROVE this slice's ground:
- **The attribution-gap hazard has a floor now**: worktree sessions land
  in `unfiled`, and slice 16 made unfiled REACHABLE (bare-`/` picker,
  D90 floor). The gap is visible instead of silent; full taskRef join
  stays future.
- **D91 names dispatched sessions** — worktree spawns arrive named.
- **Sessions projection is v2** (S16-F1) — the remove gate's input
  (`cwd` + `claudeSessionIds`) is unchanged by the bump.
- **`node_created` is exercised in production** (S16 walk) — the fold
  the checkout facts land in is live code, not shelf code.
- **D94 (orchestrator attach-immunity) is open** with a lean that names
  "ride any daemon unit as a rider" — offered as §3.7.

## §1. Scope

- **GitAdapter grows the checkout lifecycle:** `create` / `open` /
  `remove`, engine vocabulary, absorbing `worktreeManager.ts` (wrapper
  collapses into `GitAdapter.run`) and `core/tasks/worktreePaths.ts`
  (prefix rewritten; injective `escapeToSafeCharset` + fingerprint
  survive VERBATIM). Every git mutation routes through the adapter by
  slice end.
- **Pin 1 (verb split):** `create` on an existing branch refuses LOUD
  with a new closed-vocabulary `GitOpError` naming the existing checkout
  path and pointing at `open`. `open` attaches to an existing
  branch/checkout with its own provenance (`resolvedCommit` differs —
  merging the verbs is how provenance lies).
- **Pin 2 (remove gate):** `remove` refuses (or loudly warns — §3.3
  signs which) when the sessions projection holds a session whose
  `cwd` matches the checkout path with non-empty `claudeSessionIds`.
  Projection query ONLY — never discovery, never computed transcript
  paths (D45).
- **Checkout facts as spine events** (0.5): schemas land even where
  behavior stubs; they fold into node state via the EXISTING
  `nodeProvenanceSchema` `{branch, baseRef, resolvedCommit, path}`,
  write-once. The engine emitter is the FIRST legitimate provenance
  writer — the seal opens for it without relaxing the fold.
- **Branch naming engine-derived** from the node id (#16: a tenant word
  in a branch name is a tenant word in the engine). `vimes/task-` dies
  with its call sites.
- **API routes:** propose-verbs only; refusals are closed-vocabulary
  409s (S14 NodeWriter pattern).
- **Dispatcher migrates to the new verbs** in its own unit with its own
  gate (two-writers-during-transition is the named hazard; sequencing
  is the mitigation).

## §2. Explicitly out

- Any UI beyond existing reads continuing to work. (The unconsumed
  `GET /api/git/worktrees` STAYS unconsumed this slice — wiring it is
  tree-era UI work with its own slice.)
- Merge / rebase / push — checkout lifecycle only in v1.
- Auto-cleanup policy (reaper) — reserve the decision, do not build.
- Flipping `VIMES_WORKTREE_ISOLATION` default — stays `off`; this slice
  builds the machinery the flip will someday trust.
- The attribution-gap FIX (taskRef→projectRoot join) — floor is deemed
  sufficient for now (§0); full fix waits for the isolation flip.

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

1. **Base ref (Q-a).** LEAN: `create` takes an explicit base ref,
   defaulted to the project's default-branch HEAD; the RESOLVED base is
   recorded as fact in provenance either way (`baseRef` +
   `resolvedCommit` already in the schema — the staleness-guard trial
   wants it).
2. **Checkout is a NODE property (Q-b).** LEAN: yes — directory is
   already a node fact (E3-a), provenance schema already lives on
   `node_created`; a separate checkout entity would be a second source
   of record.
3. **Remove gate semantics (Q-c).** LEAN: gate on TRANSCRIPT-CWD
   EXISTENCE (any session, live or dead, whose cwd matches and has
   claudeSessionIds — the SP8·2 fact is about RESUME, and a dead
   session is exactly the one you'd want to resume). Refusal, not
   warning: closed-vocabulary 409 naming the blocking session(s); a
   `force` escape is NOT offered in v1 (reserve, don't build).
4. **Injection guarding (Q-d).** LEAN: args-array execFile everywhere
   (already the seam's law), `--` before every request-derived operand
   (gitApi precedent), plus a NEW ref-name validation lib function with
   hostile-input tests at the API boundary; name derivation keeps the
   injective escaper.
5. **Event names.** LEAN: `checkout_created` / `checkout_opened` /
   `checkout_removed`, session-stream-free (they are node facts; stream
   = nodes, the E2-a idiom).
6. **Branch shape.** LEAN: `vimes/node-<escaped-node-id>-<fp>` — keeps
   the product namespace (valid-ref guarantee), swaps the tenant word
   `task` for the engine word `node`, keeps escaper + fingerprint
   verbatim.
7. **D94 rider (OPTIONAL).** The daemon unit could carry D94's
   enforcement (attach/move envelopes naming the orchestrator session
   refuse, D10-style verbatim refusal). LEAN: take it — it is small,
   daemon-side, and D94's trigger names exactly this. Declining costs
   nothing; it waits for the next daemon unit.

## §4. Assertions (S17-A#; lib-level per house rule)

- A1: `create` on an existing branch refuses with the new error member,
  naming the existing path and `open`; `open` on a missing branch
  refuses symmetrically.
- A2: single-writer grep — no `worktree`/`branch` git invocation outside
  gitAdapter.ts in live code (`packages/*/src`, comments/test literals
  excluded, the A7-of-S16 framing).
- A3: checkout facts fold deterministically from events; the fold never
  reads disk (disk is I/O; the log is truth). Replay of a
  created→opened→removed sequence is byte-stable.
- A4: the remove gate reddens when a matching-cwd session with
  claudeSessionIds exists; sabotage the gate line, prove the right test
  reddens.
- A5: branch names carry no tenant word (#16 grep over live code);
  hostile ref names (traversal, control bytes, `--` prefixes, unicode
  confusables) refused at the boundary by the validation lib.
- A6: provenance write-once holds — every existing S14-A2 assertion
  stays green while the engine emitter stamps real provenance on
  engine-created nodes; a second stamp on the same node refuses.
- A7: no-fallback holds — `worktree-failed` still spawns NOTHING
  (existing dispatcher tests re-read, not re-pinned).
- (A8, only if §3.7 signed: attach/move naming the orchestrator session
  refuses closed-vocabulary; refusal renders verbatim in the UI's
  existing lastRefusal strip — no UI change.)
- Prior suites green (0.4). Baseline 3531/147.

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (core, lib):** ref-validation lib + hostile tests; worktreePaths
  rewrite (naming per §3.6, escaper verbatim); checkout event schemas +
  nodes-fold consumption of provenance (verify the fold already accepts
  what the schema promises — report, don't improvise). No daemon.
- **U2 (daemon, THE ADAPTER):** create/open/remove on GitAdapter;
  worktreeManager wrapper collapses; pin 1 split; pin 2 gate (sessions
  projection query); provenance emitter through nodeWriter (the seal
  opens — S14-A2 tests must stay green unmodified); events emitted.
  ONE restart owed (+ §3.7 rider here if signed).
- **U3 (daemon):** taskDispatcher migrates to the new verbs;
  worktreeManager.ts dies; no-fallback re-verified. Restart (bundled
  with U2's if pipelining allows — Wes owns awareness, D19).
- **U4 (API):** propose routes + 409 vocabulary + auth/roots checks per
  gitApi precedent. No UI.
- Deploys: U2/U3 each daemon restarts (or one bundled); U4 rides
  ci-gate. No `.vue` anywhere → no vue-tsc legs.

## §6. Gates & kill criteria

- **Machine gate:** full suite green ×2, ci-gate ALL PROFILES, A2/A5
  greps clean, plus ONE live-fire adapter exercise on a SCRATCH repo
  (create → open-refused-on-create → remove-gated → remove) run at the
  orchestrator gate — real git, throwaway repo, never a project root.
- **Human gate:** none scheduled — no UI ships. ⟨Wes⟩'s sign-off on
  this skeleton IS the design gate; the first worktree-node UI slice
  inherits the lived-gate duty.
- **Kill criteria:** absorbing worktreeManager requires RELAXING the
  provenance write-once fold (halt — the seal is the point); the remove
  gate cannot be expressed as a projection query without computed
  transcript paths (halt — D45); the dispatcher migration cannot be
  sequenced without a two-writer window (halt, decision record on the
  transition shape).
