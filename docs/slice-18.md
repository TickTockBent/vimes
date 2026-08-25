# Slice 18 — Move 4: the tasks extension leaves the engine

**STATUS: SIGNED ⟨Wes⟩ 2026-08-25 — rev 3, with §3.7 BRANCH (b)
(amend Move 4 whole). Building. Rev history: rev 1 rebuilt after
outside review (Sol, round 1 — §7); rev 2 reclassified from the
migration map's SYMBOL-level ownership table; rev 3 closed round 2's
laundering/coverage gaps and widened §3.7 into the full Move-4
amendment (§7).**

The migration map's Move 4 (`migration-map.md` §2.3, added 2026-08-11,
Wes-agreed): create `packages/ext-tasks/`, relocate the tenant-specific
code that can honestly move today, and make the Tier-1 import boundary
MECHANICAL in the same unit — q29's amended enforcement in full. The
boundary is the point: it is cheap in the move that CREATES ext-tasks
and expensive in every move after it, because each later per-declaration
move adds imports written against whatever boundary exists when it
lands.

Sequenced per ⟨Wes⟩'s 2026-08-17 approval (slice 16 → E2-c → Move 4).

## §0. Recon (2026-08-25/rev 2, orchestrator-verified at HEAD `1ce6666`)

1. **Ownership is decided by the map's symbol table, not by directory**
   (`migration-map.md` §1.2; the governing rule at its head:
   *"extensions propose, the engine's deterministic core decides"*).
   Under it, of `packages/core/src/tasks/`:
   - **ENGINE, stays:** `dispatchDecision.ts` (moves "minus the tenant
     words" only in its later per-declaration rewrite),
     `stageRunner.ts`, `reviewOutcome.ts` (becomes the generic rubric
     evaluator later), `watchdogDecision.ts` (custody reasoning; bands
     become ⟨tune⟩s later). Decision logic does not move to a tenant —
     rev 1 had this backwards for all four.
   - **SPLIT:** `taskStateMachine.ts` (edges already died in Move 3;
     what remains is tenant vocabulary + the engine proposer schema —
     and `events.ts` binds it at runtime, see fact 3),
     `workOrder.ts` (identity tuple → engine; verb input schemas →
     tenant — one of the two is events-bound, see fact 3).
   - **TASKS EXT, movable NOW:** `stageInstruction.ts` — "MOVES
     verbatim. ⚠ Byte-stability is a migration requirement, not a
     nicety" (prompt-cache economics + dispatch comparability). Its
     imports are types only (`schemas.js`, `stageRunner.js`), so it
     can cross the boundary through a curated host surface.
   - **ENGINE mis-housed:** `worktreePaths.ts` — checkout naming since
     S17; re-homes INSIDE core.
2. **`createTaskToolPayloadSchema`** (workOrder.ts's tenant half) has
   zero core consumers beyond the barrel — only
   `daemon/createTaskTool.ts` (verified). It can move; daemon → tenant
   imports are the Tier-1 host loading its extension.
3. **The dependency knot (why the other tenant shapes CANNOT move
   yet):** `core/events.ts` imports `taskStateMachine` vocabulary,
   `submitPlanPayloadSchema`, and the report payload schemas AT RUNTIME
   to validate event payloads; `projections/instances.ts` derives field
   types from `TaskRecord`. Relocating those zod schemas creates
   core → ext-tasks (a cycle against ext-host → core), and the map
   says they leave core only by being REWRITTEN as extension JSON
   Schema (§1.2 schemas row) — which is event-model work, explicitly
   out of this slice. They stay as a NAMED compatibility surface with
   death triggers (§3.4).
4. **`legacyTasksView.ts` names Move 4 as its own death trigger**
   (header, S13·U4) — but retiring the `readTasks` narrowing honestly
   requires its four daemon consumers to stop SPEAKING `TaskRecord`,
   and they pass it into ENGINE signatures (`decideDispatch` is typed
   on it). That is per-declaration generalisation, not relocation —
   §3.7 puts the fork to ⟨Wes⟩ rather than absorbing either branch
   silently.
5. **All daemon consumption of the movers flows through the
   `@vimes/core` barrel**; the UI is deliberately core-free
   (`taskBoard.ts:40`) — §2.4's "UI untouched" holds with zero UI
   edits.
6. **⚠ FINDING against a signed premise — q29(b) is false as
   written** (probe 2026-08-25, throwaway workspace package with
   `"dependencies": {}`): tsc exits 0 and the runtime import of
   `@vimes/core` resolves — npm hoists workspace packages into root
   `node_modules`, and resolution finds them regardless of declared
   deps. The checker (q29(c)) is therefore the PRIMARY enforcement;
   dependency absence is hygiene. §3.3 carries the consequence.
7. **No lint toolchain exists** (no eslint, no dependency-cruiser,
   nothing import-shaped in `ci-gate.sh`) — reconfirmed at HEAD.
8. **Workspace mechanics, as they actually are:** root scripts are
   `test: vitest run`, `typecheck: tsc -b`, `ci: ci-gate.sh` (no `-ws`
   scripts — rev 1 said otherwise, wrongly); `packages/daemon/
   tsconfig.json` references only `../core`. New packages enter via
   root tsconfig references + daemon references + daemon deps; vitest
   discovery to be verified in U1 and stated in its checkpoint.
9. **The frozen Move-0 fixture** (D72, 111 events) proves PROJECTION
   compatibility only — it validates records, folds
   `instancesProjection`, serializes. It never executes dispatch,
   watchdog, briefing, review, or work-order logic. The moved-code
   behaviour proof is A2's byte-identical test bodies + the daemon
   integration suite (rev 1 overstated A1; restated per §7).

## §1. Scope

- **New package `packages/ext-host`** (`@vimes/ext-host`) — the Tier-1
  extension-host interface package (q29(a)). v1 is a curated,
  EXACT-ORIGIN-ALLOWLISTED re-export surface over `@vimes/core`. The
  movers' import surface, VERIFIED from their import blocks (rev 2's
  list was wrong in both directions — §7 round 2): types `TaskRecord`,
  `ReportCompletionPayload`, `ReportReviewPayload`, `StageRunnerPlan`,
  plus ONE value — `canonicalJson`, the deterministic serializer the
  moving schema's tests round-trip through (a legitimate host
  primitive: deterministic serialization is engine doctrine, not
  tenant code). Nothing speculative; U1 assembles the final list from
  what actually compiles and records it. The allowlist is a tracked
  file in the package mapping EACH public name to its exact upstream
  package, ORIGINAL symbol name, and type/value status (§3.2); the
  checker enforces the mapping, so the surface changes only by
  reviewable diff.
- **New package `packages/ext-tasks`** (`@vimes/ext-tasks`) — the task
  tenant. Receives this slice: `stageInstruction.ts` + its tests
  (VERBATIM — byte-stability asserted, §4-A6), and
  `createTaskToolPayloadSchema` + its satellite types out of
  `workOrder.ts`. Dependencies: `@vimes/ext-host`, `zod`.
  **`@vimes/core` absent.** Small on day one BY DESIGN: the map's
  per-declaration moves populate it later, each landing behind a
  boundary that already refuses engine internals.
- **The boundary made mechanical** (q29(c), primary per §0.6) — full
  spec in §3.3, sabotage matrix in §4-A5.
- **`worktreePaths.ts` → `packages/core/src/git/`** — engine code
  leaving the tenant-named directory; derivations byte-identical.
- **Consumer re-point:** daemon imports of moved names flip to
  `@vimes/ext-tasks`; the core barrel stops exporting them.
- **The named compatibility surface** (§3.4): the events-bound tenant
  schemas stay in core, each with its stated death trigger — never by
  oversight (S14-F1 discipline).

## §2. Explicitly out

- **The four ENGINE decision modules stay in core** (§0.1) — their
  "minus the tenant words" rewrites are per-declaration moves with
  their own D-records.
- **The events-bound tenant schemas stay in core** (§0.3) — they leave
  only as the JSON-Schema rewrite the event-model work owns.
- **The `readTasks`/legacyTasksView retirement** — unless ⟨Wes⟩ takes
  §3.7's branch (a); the lean is branch (b), amend-and-re-date.
- **The daemon's tenant-facing hosts** (`taskDispatcher.ts`,
  `taskWatchdog.ts`, `createTaskTool.ts`) keep homes and behaviour;
  only import paths change. Extracting them needs D66's capability
  interface — per-declaration work. (A narrowing of Move 4's "and
  `packages/daemon`" phrasing — flagged, §3.5.)
- Every route, the WS op vocabulary, `/api/tasks/*` (§2.4); the entire
  UI; manifest parser / registry / Tier-2 host / grants; all
  per-declaration migrations; E1-e orchestrator notes; Book Genesis;
  InputLease/D81; any event-kind or alias-table change.

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

**3.1 — Package names and layout.** `packages/ext-host` /
`packages/ext-tasks`, npm names `@vimes/ext-host` / `@vimes/ext-tasks`,
both `private: true`, composite builds via project references like
their siblings. *(Orchestrator-chosen; mateclaw's analog is
`mateclaw-plugin-api`. Alternatives: `@vimes/extension-api`,
`@vimes/host-api`.)*

**3.2 — ext-host v1 is a curated EXACT-ORIGIN re-export, not a
parallel type world.** ext-host depends on `@vimes/core` and contains
DIRECT re-exports ONLY: every statement is
`export { X } from '@vimes/core'` or
`export type { X } from '@vimes/core'` — no local declarations, no
aliasing (`export { X as Y }` is refused), no wrapper values. The
tracked allowlist maps each public name → { upstream package, original
symbol, `type` | `value` }, and the public name MUST equal the original
symbol name. This closes round 2's alias-laundering finding
(`export type { EventStore as TaskRecord }` satisfied rev 2's
name-only check while lying about identity; a local declaration
exported under an allowed name did the same). The allowlist file is
the interface artifact; its diff is the changelog. The pure-mateclaw
alternative (independent types, core conforms) still buys drift risk
for nothing the checker doesn't hold. *(Lean: exact-origin re-export;
`canonicalJson` admitted as the first VALUE entry per §1 — Sol's
round-2 lean, adopted after verifying the test dependency.)*

**3.3 — The boundary checker, full spec (restated on §0.6's observed
truth; primary enforcement).** A gate-run script
(`scripts/check-ext-boundary.mjs`, run by `ci-gate.sh` before builds)
that walks `packages/ext-*/src` and fails on:
  - a bare specifier not in {the package's declared deps ∪ `node:`
    builtins};
  - any deep subpath into a `@vimes/*` package (only the root barrel
    is importable);
  - a RELATIVE specifier that, resolved from its file, escapes the
    package root (closes the `../../core/src/...` bypass);
  - a dynamic `import()` whose argument is not a string literal
    (literal ones are checked like static imports; computed ones are
    refused outright — rare, and reviewable when genuinely needed);
  - in ext-host: any `export *`; any statement that is not a direct
    re-export from the allowlisted upstream; any alias; any export
    not matching its allowlist row (name, origin package, original
    symbol, type/value kind);
  - in `packages/core/src` (scanned with the SAME relative-resolution
    rules): any import — bare, deep, relative-resolved, or dynamic —
    reaching `@vimes/ext-*` or any `packages/ext-*` path (the engine
    knows no tenants, by any route);
  - in `packages/daemon/src`: any deep subpath or relative-resolved
    reach into `packages/ext-*` (the daemon consumes tenant packages
    through their root barrels only).
Plus **(hygiene)** `@vimes/core` absent from ext-tasks' deps, and
**(structure)** the interface package itself. *(Deviation flag stands
from rev 1: q29(c) says "a lint rule"; the lean is a purpose-built
script — same mechanical effect, gate-run, no new toolchain. Say the
word if you want real eslint infra instead.)*

**3.4 — The vocabulary split, rebuilt from the map's symbol table.**
MOVES: `stageInstruction.ts` (verbatim), `createTaskToolPayloadSchema`.
**Tests move WITH their modules,** and the split is explicit:
`workOrder.test.ts` splits at describe-block granularity — the
create-schema blocks (canonicalJson round-trips included) go to
ext-tasks importing `canonicalJson` from ext-host; the remaining
blocks stay in core untouched. A2's byte-identical promise applies
per describe-block for split files: block bodies do not change,
import lines do. (Round 2 showed every other resolution violated
something signed: tests-stay-in-core needs the forbidden
core → ext-tasks import; replacing the serializer changes assertion
semantics.)
STAYS ENGINE (the map's own rows): `dispatchDecision`, `stageRunner`,
`reviewOutcome`, `watchdogDecision`, the proposer schema, the stage-run
identity tuple, `worktreePaths` (re-homed). STAYS as NAMED
COMPATIBILITY, each with its death trigger:
  - **(c1)** `taskStageSchema`/`TaskStage`, `taskRecordSchema`/
    `TaskRecord`, report payload schemas, `submitPlanPayloadSchema`,
    and `taskStateMachine`'s event-bound vocabulary — bound by
    `events.ts` runtime validation and `instances.ts` types; die in
    the JSON-Schema rewrite (map §1.2 schemas + events rows).
  - **(c2)** `taskRef` on the session shape — live wire contract.
  - **(c3)** `sessionIdentity.ts`'s `Task:` marker — D91 reads
    recorded bytes; not workflow.
  - **(c4)** `legacyTasksView.ts` — per §3.7's outcome.
  - **(c5)** the residual `tasks/` directory holding the engine
    modules — dies when its last per-declaration rewrite lands; the
    DIRECTORY surviving is accepted so long as the tenant CODE and the
    boundary do not wait on it (q29's question answered in substance,
    amended in letter — flagged).
The A3 grep-gate test enumerates c1–c5; a new hit fails; a mid-build
addition is STOP-and-report.

**3.5 — The daemon keeps its hosts.** As rev 1, now consistent with
§3.4: what the daemon hosts is engine-plus-compatibility; extraction
rides D66. *(Still a flagged narrowing of Move 4's written text.)*

**3.6 — Workspace mechanics, corrected (§0.8).** Root
`tsconfig.json` gains references to ext-host and ext-tasks; daemon's
tsconfig gains `{ "path": "../ext-tasks" }` and its package.json the
dependency; ext-tasks references ext-host; ext-host references core.
Root `typecheck` (`tsc -b`) and `test` (`vitest run`) pick the chain
up through references — U1 PROVES vitest discovery of the new
packages' tests and records the mechanism in its checkpoint before U2
relies on it. Build order: core → ext-host → ext-tasks → daemon.

**3.7 — FORK for ⟨Wes⟩: `legacyTasksView`'s death trigger names this
slice, and this slice cannot honestly kill it.** S13·U4's header re-
dated the view's death to "Move 4, when the writer's legacy
`TaskRecord` narrowing is retired." Verified today: that retirement
means `InstanceWriter`, `TaskDispatcher`, `registerOrchestratorApi`,
and `TaskWatchdog` stop asking for `TaskRecord[]` — but they FEED that
type into engine signatures (`decideDispatch(task, …)`), so the honest
retirement is the per-declaration generalisation of those engine
seams, not a relocation. Branches:
  - **(a) Widen this slice** to genericize the four reader seams now —
    contradicts "moves code without moving behaviour," drags q13
    per-declaration work forward, and grows the slice by roughly its
    own size again. Priced honestly: it is the map's riskiest kind of
    change without the map's per-declaration safety story.
  - **(b) Amend Move 4 whole** (LEAN, widened per round 2): ONE dated
    migration-map amendment under Move 4's own entry covering ALL
    THREE deviations from its written text — (i) the residual `tasks/`
    directory holding engine modules survives until their
    per-declaration rewrites; (ii) the daemon tenant hosts stay until
    D66's capability interface exists; (iii) `legacyTasksView`
    survives, its header re-dated to the real trigger (the
    instance-store per-declaration move that genericizes the writer
    seam), the "no fourth consumer" guard kept — and REDEFINING what
    marks Move 4 complete: both packages exist, the boundary is
    mechanical and sabotage-proven, every tenant symbol that can move
    without violating §0.3's dependency knot has moved, and each
    stay-behind is named with its death trigger. Loud, dated, in one
    place — not three scattered footnotes.

## §4. Assertions (S18-A#)

- **A1** The frozen Move-0 fixture replays byte-identical through the
  post-move build — **stated for what it is: the projection-
  compatibility proof** (§0.9), necessary not sufficient.
- **A2** Full suite green; every moved test keeps its assertion bodies
  byte-identical — at describe-block granularity for split files
  (§3.4) — imports flip, expectations don't. With §0.9, this IS the
  moved-behaviour proof, so U2's diff review checks it
  expectation-by-expectation.
- **A3** The grep gate: the moved names are absent from
  `packages/core/src` except §3.4's enumerated c1–c5; the exemption
  test names each and fails on any new hit.
- **A4** ext-tasks declares no `@vimes/core` dependency; the checker
  passes on the shipped tree; core imports no `@vimes/ext-*`.
- **A5 (sabotage matrix — the exit gate's "a boundary that has never
  refused anything is not a boundary"):** each observed FAILING with
  file+specifier named, then reverted (`cmp` byte-identical), checker
  green after: **(s1)** bare `import '@vimes/core'` in ext-tasks;
  **(s2)** relative escape `../../core/src/…`; **(s3)** deep import
  `@vimes/core/dist/…`; **(s4)** dynamic `import('@vimes/core')`;
  **(s5)** laundering — an un-allowlisted re-export added to ext-host;
  **(s6)** ALIAS laundering — `export type { EventStore as TaskRecord }`
  AND a local declaration exported under an allowed name, both refused
  by §3.2's exact-origin rule; **(s7)** core reaching ext-tasks by
  RELATIVE path (`../../ext-tasks/src/…`); **(s8)** daemon
  deep-importing `@vimes/ext-tasks/dist/…`.
- **A6** stageInstruction byte-stability: composed output for a pinned
  set of briefing contexts is byte-identical pre/post move (goldens
  captured from HEAD before U2 touches anything), and the module file
  itself is byte-identical minus the import lines.
- **A7** `worktreePaths` re-home: checkout branch/dir derivations
  byte-identical, existing pins green unmodified.
- **A8** ext-host's export surface ≡ its allowlist file (pinned by
  test AND by the checker — belt and suspenders across different
  failure modes).

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (sonnet, mechanical):** both package scaffolds, workspace/
  tsconfig/deps wiring per §3.6, vitest discovery PROVEN, the checker
  script + ci-gate wiring + checker unit tests (including driving the
  A5 matrix as expected-failures against throwaway fixtures). Walls
  before furniture; no product code moves.
- **U2 (opus — small but byte-precision work):** `stageInstruction.ts`
  + tests → ext-tasks verbatim (A6 goldens first);
  `createTaskToolPayloadSchema` split out of workOrder.ts →
  ext-tasks; `worktreePaths.ts` → `core/src/git/`; barrel pruned;
  daemon imports flipped; §3.7(b)'s two doc/header edits if that
  branch is signed. A1/A2/A6/A7 green.
- **U3 (sonnet, the gate):** A3 exemption-enumeration test, A8 surface
  pin, the A5 sabotage evidence run recorded, ci-gate all profiles.
- Fixes to NEW agents; one agent at a time.

## §6. Gates, kill criterion, deploy

**Exit gate (machine):** suite ×2 deterministic, ci-gate all profiles,
A1 fixture byte-identical, A5 matrix observed (all five) and reverted,
A6 byte-stability holds, grep gate clean against c1–c5. No human gate —
no UI ships, no behaviour moves.

**Kill criterion:** two triggers, either → STOP + finding (rule 0.1):
(i) ext-host's honestly-assembled allowlist needs projection internals
or >~30 entries for the tenant to compile (baseline: 5 verified
entries — four types + the `canonicalJson` value); (ii) the checker cannot close
§4-A5's matrix without adopting a full toolchain — then §3.3 gets
re-decided rather than quietly weakened.

**Deploy note:** core + daemon change ⇒ restart REQUIRED (CLAUDE.md
diff rule); standing dev-phase clearance applies; ci-gate ships the
(unchanged) UI as a side effect as always.

## §7. Outside-review triage record (Sol)

**Round 1 (2026-08-25, on skeleton rev 1) — verdict "not signable,"
sustained in full.** Every premise repo-verified before amending:

- **P0 inventory-vs-ownership-map: SUSTAINED, orchestrator error.**
  Rev 1 classified all seven `tasks/` modules as tenant by residence +
  purity; the map's §1.2 symbol table (verified) rules four ENGINE, two
  SPLIT, one movable — under the governing rule rev 1 violated:
  extensions propose, the engine decides. Rebuilt: §0.1, §1, §3.4, U2,
  A3.
- **P0 impossible dependency graph: SUSTAINED.** Verified
  `events.ts` binds the tenant zod at runtime (imports at :7–:39) and
  `instances.ts` types on `TaskRecord`; verified the map requires
  JSON-Schema REWRITE not relocation. Resolved via §3.4's named
  compatibility surface (c1) — the rewrite stays out of scope.
- **P0 checker bypasses: SUSTAINED.** Rev 1 exempted relative paths
  wholesale (the `../../core` escape) and under-specified the
  ext-host backstop. Rebuilt as §3.3's full spec + the five-way A5
  matrix (relative escape, deep import, dynamic import, laundering
  added).
- **P1 legacyTasksView trigger: SUSTAINED — and verified one level
  deeper: the retirement cascades into ENGINE signatures
  (`decideDispatch` is `TaskRecord`-typed), so neither silent branch
  is honest. Escalated to §3.7 as a fork for ⟨Wes⟩ (lean: amend).**
- **P1 fixture overstatement: SUSTAINED.** Verified the fixture test
  folds `instancesProjection` and serializes — nothing else. A1
  restated; A2 promoted to the behaviour proof (§0.9).
- **P2 nonexistent `-ws` scripts: SUSTAINED.** Verified root scripts
  and daemon's single `../core` reference. §3.6 rewritten from the
  actual files; U1 proves vitest discovery before U2 leans on it.

**Round 2 (2026-08-25, on rev 2) — "much stronger, not signable";
all five sustained, two after repo verification:**

- **P1 alias-laundering: SUSTAINED, spec gap.** Rev 2's name-only
  allowlist admitted `export { X as AllowedName }` and local
  declarations under allowed names. Closed by §3.2's exact-origin rule
  (direct re-exports only, name ≡ original symbol, per-entry origin
  mapping) + A5 s6.
- **P1 incomplete import surface: SUSTAINED, verified.** Rev 2 claimed
  `TaskStage, TaskRecord, StageRunnerPlan`; the actual import block
  is `TaskRecord, ReportCompletionPayload, ReportReviewPayload` (types,
  `schemas.js`) + `StageRunnerPlan` — wrong in both directions.
  §1 corrected; kill criterion re-baselined at 5 entries.
- **P1 create-schema test split: SUSTAINED, verified**
  (`workOrder.test.ts:2` imports `canonicalJson`; the per-schema
  round-trip blocks include the mover). Sol's lean adopted:
  `canonicalJson` becomes ext-host's first VALUE entry; the split is
  specified at describe-block granularity in §3.4; A2 restated to
  match.
- **P1 Move 4 completeness: SUSTAINED.** Rev 2 left three deviations
  from Move 4's signed text covered by one narrow trigger amendment.
  §3.7(b) widened to a single dated migration-map amendment covering
  all three AND redefining Move 4's completion marker.
- **P2 checker coverage: SUSTAINED, spec gap.** Core was only scanned
  for BARE `@vimes/ext-*` imports (relative reach unchecked) and
  daemon not at all for extension deep paths. §3.3 now scans core and
  daemon with the same resolution rules; A5 gains s7/s8.

Convergence note: round 2's blockers were all in rev-2 text, none in
the repo premises rev 2 added — the doc is approaching fixed point.
§3.7 was the one open human fork; ⟨Wes⟩ signed BRANCH (b)
2026-08-25 with the rest of the packet, closing it.
