# Slice 19 — the briefing declaration goes LIVE (first per-declaration move)

**STATUS: SIGNED ⟨Wes⟩ 2026-08-25 — rev 3. Building. Rev 1 rebuilt after outside review round 1 (all eight
sustained); rev 3 closes round 2's four implementation-contract issues
(§7) — the preflight now composes, the seam carries ids not specs, and
the refusal stays wire-stable.**

The first post-Move-4 per-declaration move: `[workflows.nodes.briefing]`
stops being descriptive and starts GOVERNING dispatch — composer
resolution, engine-assembled input sets, declared tools /
permission_mode / capture — via Move 3's choreography (differential
beside → flip → delete-and-freeze).

## §0. Recon (2026-08-25 rev 2, orchestrator-verified at `cb3dbf3`)

1. **The manifest declares briefings on exactly 3 of its 11 nodes**
   (planning, implementing, review) — and that is TOTAL coverage of
   the domain that matters: `DISPATCHABLE_TASK_STAGES` is exactly
   those three (dispatchDecision.ts:49–53). Rev 1 said "all nine
   nodes" — wrong twice. A2/A3's domain is "every dispatchable node,"
   and non-dispatchable nodes need no briefing by construction.
2. **The parser validates the closed input vocabulary** with named
   refusals (manifest.ts:1544–1583); `permission_mode` is accepted at
   BOTH node level (the live manifest, `planning`) and briefing level
   (BRIEFING_KEYS) — a resolution rule between them does not exist
   yet (§3.4 creates it).
3. **⚠ `instance.record` as the raw `TaskRecord` would leak the
   other input kinds** — the record carries `planArtifactHash`,
   `lastReview`, `lastCompletion` (schemas.ts), so a composer
   receiving it can read report data its node never declared. The
   input kinds must be DISJOINT for the allow-list to mean anything
   (§3.2 defines the projected record).
4. **The manifest's permission vocabulary is `default | plan`**
   (manifest.ts:180) while compiled dispatch passes `auto | plan`
   (taskDispatcher.ts:751/759) — declared ≡ compiled cannot even be
   stated without a semantics decision (§3.4).
5. **Briefing delivery is POST-spawn today** (`spawnStageRun` then
   `deliverStageInstruction`; compose failures land as
   `not-delivered`, taskDispatcher.ts:1406) — rev 1's A4 ("no spawn")
   requires a new PREFLIGHT resolution step before worktree/spawn
   (§3.5).
6. **Tool mounting is the session host's private stage switch**
   (`reportToolsOptionFor(stage)`, sessionHost.ts:790) — the
   dispatcher passes `stage`, not specs. Declared tool ids need a
   named resolution point with fail-closed unknown-id handling
   (§3.6).
7. **The composer's second argument is `StageRunnerPlan`, not plan
   text** (stageInstruction.ts:166); the captured plan is
   `context.plan` (:192). And `StageRunnerPlan` is SINGLE-VALUED
   (`{mode:'spawn'}`) since D46 — an engine fact with no input-kind
   home, but degenerate, so it never crosses the boundary (§3.2).
8. **Move 3's signed F2: adjudication consults the BOOT declaration,
   never per-instance re-resolution** (instanceWriter.ts:381 region);
   a rev difference is not a mismatch. Dispatch follows the SAME law
   (§3.3) — rev 1's "pinned declaration" overstated the machinery.
9. **Capture is coupled to `permissionMode === 'plan'` today**
   (sessionHost.ts:754 `planCaptureSessions.add`); the declaration's
   `capture` list is inert, and the shipped manifest correlates the
   two — so a naive differential passes while proving nothing about
   capture. §3.7 decouples and perturbs.
10. The 37-golden set + the S18-F4 daemon stem test are the inherited
    byte-stability instruments. Doctrine rows still name nonexistent
    files (carried from rev 1, §3.8). D81 decided/build parked; the
    orchestrator attach-immunity trigger is adjacent, not fired.

## §1. Scope

- The Tier-1 composer table in ext-tasks + registry-resolved
  entry-point strings, with a PREFLIGHT resolution stage (before
  worktree creation and spawn) whose refusals are loud and spawn
  nothing.
- The `BriefingInputSet`: engine-assembled, DISJOINT input kinds, the
  projected instance record, absent-stays-absent degrade.
- Declared `tools` / `permission_mode` / `capture` govern the spawn,
  with the engine's D50 clamp untouched and unknown declared ids
  refused preflight.
- Move-3 choreography: differential beside → flip → delete + freeze.
- Manifest edits: doctrine rows out (§3.8); permission-mode placement
  normalized (§3.4).

## §2. Explicitly out

Tier-2; dynamic loading; any new manifest vocabulary (§3.4 REMOVES a
key placement and adds nothing); acceptance/auto-dispatch/isolation/
watchdog/verbs/overlays/panes moves; InputLease build; orchestrator
surface; doctrine externalization; all UI/routes/WS — including the
dispatch routes' wire vocabulary (§3.5 keeps the result union
unchanged for exactly this reason).

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

**3.1 — Composer table** (unchanged from rev 1): ext-tasks exports
`briefingComposers` keyed by entry-point string; thin wrappers over
the single prose module, zero prose bytes moved; the degenerate
`StageRunnerPlan` is supplied INSIDE the wrappers as the constant it
is. Unresolvable entry-point → preflight refusal, never a generic
fallback.

**3.2 — The input kinds are DISJOINT, and `instance.record` is a
PROJECTION.** `instance.record` = the engine core fields + the payload
at its current rev, MINUS the report/plan-derived fields
(`lastReview`, `lastCompletion`, `planArtifactHash` and any sibling
that is another input kind's content). `artifact:plan` → the fetched
plan text (today's `context.plan`); `report:last-review` /
`report:last-completion` → the fix-seed's two halves. The engine
assembles ONLY declared rows; the composer wrappers reconstruct
today's `(task, plan, context)` call from the set — and the
projection means an undeclared report is UNREACHABLE, not merely
unhanded. Honesty line kept from the kit: at Tier 1 this is a
composition guarantee, not containment (node-kit §1.8.1 limit 1) —
but within composition it is now real, which rev 1's version was not.
*(U1 delivers the field-level projection table as signed data before
U2 builds against it.)*

**3.3 — Dispatch follows Move 3's one-boot-declaration law.** The
dispatcher reads the boot-resolved declaration (same source
adjudication uses, F2 ⟨signed⟩); no per-instance re-resolution, and a
rev difference is not a mismatch. Consistency with the signed
limitation, stated rather than silently exceeded.

**3.4 — Permission-mode semantics, decided not assumed.** The
manifest vocabulary stays `default | plan` — `auto` does NOT enter it:
`auto` is the ENGINE's footing for dispatched sessions, not a tenant
word. Mapping: declared `plan` → SDK `plan` (+ capture per §3.7);
declared `default` or ABSENT → the engine's dispatched footing
(`auto`) for dispatched spawns. Placement: briefing-level
`permission_mode` is REMOVED from `BRIEFING_KEYS` (one home: the
node), and the live manifest's node-level placement becomes the only
legal one — parser refusal on the briefing-level key, manifest
untouched. *(Lean; alternative — admit `auto` as tenant vocabulary —
rejected lean: it names an Anthropic-SDK footing inside a tenant
document, exactly the drift rule 0.6 fences.)*

**3.5 — The preflight COMPOSES, and its refusal stays wire-stable.**
Before worktree creation and spawn, dispatch: resolves the composer
entry-point; validates every declared tool id against the engine-known
set; validates the §3.7 combo; ASSEMBLES the declared input set and
INVOKES the composer, retaining the composed string for post-spawn
delivery. A failure at ANY of those steps — including compose-threw —
spawns nothing, creates no worktree, and is RETURNED to the caller
with NO event, exactly as `worktree-failed` behaves (rev 2 said
"recorded"; the code says NO EVENT and rev 3 says what the code
says). Wire vocabulary: the result REUSES the existing `spawn-failed`
outcome with reason `briefing-unresolvable:<sub-reason>` — the routes
serialize `DispatchAttemptResult` verbatim, so a new union member
would be a wire change §2 forbids; the named reason carries the
precision instead. Post-spawn `not-delivered` shrinks to SEND-time
failures only — composition already happened preflight.

**3.6 — Declared tools: the dispatcher VALIDATES ids, the host BUILDS
specs.** Report-tool specs close over the freshly allocated
`appSessionId` (sessionHost.ts:843) — they cannot exist before
`spawnSession`. So: preflight validates each declared id against the
engine-known id set (fail-closed, §3.5 refusal on unknown); the spawn
seam gains `reportToolIds: string[]` (ids, not specs); the host
constructs the session-bound specs from ids after allocation. The
deleted compiled half is the stage→ids derivation inside
`reportToolsOptionFor` — spec CONSTRUCTION stays host-side, exactly
where it is today. D50 clamp and denylist untouched; a tenant selects
among engine tools, never mints one.

**3.7 — Capture follows the DECLARATION, independently, and the
invalid combo is refused.** `capture: ["plan"]` is what arms
plan-capture (the `planCaptureSessions` add keys off the declaration,
not off the mode); `permission_mode = "plan"` without
`capture = ["plan"]` runs plan-mode WITHOUT harvest; capture declared
without plan mode is REFUSED preflight (the harvest mechanism only
exists at the ExitPlanMode boundary — declaring it elsewhere is a
tenant error, fail-closed, §3.5 vocabulary). Perturbation tests for
all three cells beyond the shipped manifest's correlated corner.

**3.8 — Doctrine rows out of the manifest** (carried from rev 1,
lean unchanged): rows naming nonexistent files leave, dated comment,
return only under a future externalization signing.

## §4. Assertions (S19-A#)

- **A1** 37 goldens byte-identical through the declaration path.
- **A2** Differential over the DISPATCHABLE domain (the three
  briefing-carrying nodes): declared ≡ compiled for tools ×
  permission-footing × capture × briefing bytes; frozen at the flip
  against the deleted switches' image (Move-3 precedent).
- **A3** Disjointness + allow-list: per node, a spy composer receives
  exactly the declared kinds; AND the projected `instance.record`
  provably excludes the report/plan fields (asserted on the
  projection, not just the top-level keys — S19's answer to rev 1's
  false security claim).
- **A4** Preflight refusals: unresolvable composer, unknown tool id,
  invalid capture combo, AND compose-threw — each refuses BEFORE
  worktree/spawn (no spawn, no worktree, returned with no event,
  `spawn-failed` + `briefing-unresolvable:<sub>` reason), asserted
  per sub-reason; plus the routes' pass-through tests green
  UNCHANGED (the wire union did not grow).
- **A5** Capture perturbation cells (§3.7): plan-without-capture does
  not harvest; capture-without-plan refused; the shipped corner
  unchanged.
- **A6** Suite green, zero behavioural pins changed; Move-0 fixture
  untouched; boundary checker clean; ext-host surface unchanged (or
  STOP — surface.json is signed).
- **A7** Non-dispatchable nodes: dispatch already refuses them
  upstream (`stage-not-dispatchable`) — asserted still true so the
  briefing domain claim can't rot silently.

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (opus):** the projection table (§3.2) as signed data + 
  `BriefingInputSet` + engine assembly (pure, injected reads) +
  composer table (§3.1) + parser change (§3.4 placement) + manifest
  edits (§3.8). No dispatcher change.
- **U2 (opus):** preflight (§3.5/3.6/3.7) + declaration path BESIDE
  compiled + A2 differential + A3 spies + A4/A5. Nothing flips.
- **U3 (sonnet):** the flip; compiled halves deleted at BOTH homes —
  the dispatcher's permission-mode selection switch AND the
  sessionHost's stage→ids derivation in `reportToolsOptionFor` AND
  the sessionHost's mode-derived capture arming
  (`planCaptureSessions.add` keyed on mode, :754 — replaced by the
  declaration-keyed arming §3.7 built); differential frozen; A1
  re-run live.
- Fixes to NEW agents; one at a time.

## §6. Gates, kill criterion, deploy

**Exit gate (machine):** suite ×2, ci-gate all profiles, A1 37/37,
frozen A2, A3 projection evidence, A4/A5 refusal+perturbation
evidence, checker clean. No human gate.

**Kill criterion:** a `StageInstructionContext` fact with no
input-kind home that is NOT degenerate (the §0.7 constant is the one
known degenerate); any dispatchable node whose declared briefing
cannot reproduce compiled behaviour byte-exactly; or the projection
of §3.2 turning out to need a field another input kind owns. Each →
STOP, back to the pass (rule 0.1).

**Deploy note:** daemon + core + ext-tasks change ⇒ restart at close;
standing clearance applies.

## §7. Outside-review triage record (Sol)

**Round 1 (2026-08-25, on rev 1) — "not ready"; ALL EIGHT sustained,
each repo-verified before amending:**

1. **Allow-list not a security boundary: SUSTAINED** — `TaskRecord`
   carries `lastReview`/`lastCompletion`/`planArtifactHash`
   (verified), so raw `instance.record` leaks undeclared kinds.
   → §3.2 disjointness + projection; A3 rebuilt to assert on the
   projection.
2. **Permission vocabularies inequivalent: SUSTAINED** —
   `default|plan` vs compiled `auto|plan` (both verified), plus the
   node-vs-briefing placement ambiguity. → §3.4 semantics + one-home
   rule.
3. **Composer failure is post-spawn today: SUSTAINED** (verified
   `not-delivered` at :1406). → §3.5 preflight + refusal vocabulary;
   A4 restated.
4. **Tool ownership misdescribed: SUSTAINED** — the stage switch is
   sessionHost-private (verified :790); rev 1's "dispatcher already
   passes a reportTools mount" was false. → §3.6; the spawn seam
   change named explicitly.
5. **Wrong second-argument mapping: SUSTAINED** — `StageRunnerPlan`
   ≠ plan text; `context.plan` is the capture (both verified). Rev 1
   would have signed a wrong contract into U1. → §3.2 corrected;
   §0.7 records the degenerate-constant resolution.
6. **"Pinned declaration" overstated: SUSTAINED** — F2's
   boot-declaration law verified at instanceWriter.ts:381. → §3.3
   adopts the same law explicitly.
7. **Capture inert under the correlated manifest: SUSTAINED**
   (verified :754 coupling). → §3.7 independence + invalid-combo
   refusal + perturbation cells (A5).
8. **Briefing overcount: SUSTAINED** — 3 briefings / 11 nodes
   (verified), and the dispatchable subset is exactly those three —
   so the domain is total, which rev 2 states as a FACT rather than
   an accident (A7 keeps it from rotting).

**Round 2 (2026-08-25, on rev 2) — "much stronger, not ready"; all
four sustained (two repo-verified, two logical):**

1. **Specs can't be built preflight: SUSTAINED, verified** —
   `buildReviewSpec(appSessionId)` closes over the id allocated
   inside `spawnSession` (:843). → §3.6 rebuilt: ids across the seam,
   host builds specs post-allocation; the deleted switch restated as
   the stage→ids derivation.
2. **Preflight-without-compose leaves post-spawn compose failure:
   SUSTAINED, logical** — rev 2 preflighted existence, not
   invocation. → §3.5: preflight assembles inputs AND invokes the
   composer, retains the string; compose-threw joins A4's pre-spawn
   cases; `not-delivered` shrinks to send-time.
3. **Recording claim false + wire-vocabulary conflict: SUSTAINED,
   verified** — `worktree-failed` emits NO event (the orchestrator
   had read that comment and still wrote "recorded" — the sharper
   catch of the round), and `DispatchAttemptResult` is serialized
   verbatim by the routes. → §3.5: returned-no-event stated; refusal
   reuses `spawn-failed` + named reason, union unchanged; A4 asserts
   route pass-through tests green.
4. **Capture deletion site misplaced: SUSTAINED, verified** (:754 is
   host-side). → U3 names both deletion homes.
Minor: §2's "ruled addition" wording corrected (§3.4 adds nothing;
it removes a placement).

Convergence: round 2 was entirely implementation-contract precision —
no repo premise from rev 2 fell, no signed decision moved. A round 3
would be testing for fixed point.
