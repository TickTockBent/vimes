# Slice 7 — Task-as-work-order + the spec-and-verify loop

> **Sequencing (D47, 2026-07-25):** builds AFTER **slice 6b** (UI foundation —
> panel-frames + design system + re-skin), so slice 7's new surfaces are built on the
> pinned look once, not twice. Slice 7 keeps its number; the `S7·N` unit labels below
> are unchanged. See `slice-6b-ui-foundation.md`.

**Status: DESIGNED (2026-07-25), signed off by Wes. Not yet skeletoned into build
units.** The settled calls live in `decisions.md` **D43 / D44 / D46**; this doc is
the operational compilation (scope, the two internal gates, floor pieces, phase
pivot, spike scope, reserved shapes). It supersedes the old "add a description
field" framing.

## The finding this slice answers (T7, D43 evidence)

The board as built encodes **chat-and-steer** (thin title → dispatch → correct
live). The workflow VIMES exists to run is **spec-and-verify** (a work-order → one
agent → verify → fix-to-a-fresh-agent). Wes's T7 "mid-run correction" was a full
work-order delivered through the wrong door. Slice 7 makes the task *be* a
work-order and makes the plan→implement seam real.

## Shape: ONE slice, TWO internal gates, ambitious endpoint

Kept as one slice (not two) on the **aliasing argument**: if the first
spec-and-verify pass ran under a freshly-built orchestrator, a bad work-order would
have three aliasing suspects — schema (D43), handoff mechanics (D44), orchestrator
authorship (prompt/tooling) — and a bad plan looks identical whichever layer bent
it. Revert wouldn't be clean either (board UX, MCP surface, schema grow
accommodations to the orchestrator). So: isolate the orchestrator out of phase one,
gate, then add it.

### Gate 1 (phase one) — the minimal loop, human-driven, MUST pass once clean
`work-order → planner → structured plan → fresh implementer → verify`, driven **by
Wes from the board**, no orchestrator agent yet. **Exit gate: it passes once
cleanly with ZERO mid-turn steers.** Only then does phase two start. Because the
orchestrator is absent, a phase-one failure can only be **schema or handoff** — the
aliasing is broken by construction.

### Gate 2 (phase two) — the orchestrator, AUTHOR first, driver later
The end-state orchestrator does dispatch/move/surface/read, but its **highest-value
minimal form is an author**: it writes D43-shaped work-orders from a conversation and
**proposes** them (`create_task` + comment); **Wes promotes from the board**.
- Why author-first: that's where the real pain is (nobody hand-types
  scope/explicitly-out/acceptance/kill on a phone); it exercises the new schema
  harder than anything else; it is **principle-10-native from birth** (propose,
  never transition); and it needs almost no new dispatcher surface.
- **Drive authority (promote / move / dispatch) comes after authorship proves the
  schema** — each verb is a **small, individually revertible grant**, never a big
  bang.
- **Pivot criterion:** if orchestrator-authored work-orders need substantial human
  rewriting *more often than not* after ~10 real tasks, **stop expanding its verbs**
  and fix the schema or the doctrine first.

## Phase-one floor pieces (the minimal loop is bigger than schema + handoff)

The loop rests on infrastructure that does not exist yet — name it so phase one
isn't under-scoped:

1. **Artifact store.** Content-addressed. **Reserve the envelope now** (rule 0.5):
   `{ hash, kind, taskRef, rev, createdBy: sessionRef, createdAt }` + a `hash→blob`
   table. **Dedup and GC explicitly deferred.** This is the home for the plan blob
   (codor/AgenC self-owned-blob pattern; D43 "artifact by reference").
2. **`submit_plan` MCP surface.** The first tool VIMES *exposes* to a session (today
   sessions consume nothing from us — new rule-0.6 boundary). Two obligations:
   - **Per-role scoped tokens** binding a credential to `(taskId, stage, attempt)`
     so a planner may `submit_plan` **only for its own run** (the codor
     per-member-credentials lift, arriving one slice early).
   - **Hostile-input coverage** for malformed payloads (a Vimes-owned tool surface
     is attackable; add it to the harness's hostile-input profile).
3. **`report_review` — the third floor piece hiding in "→ verified".**
   Acceptance-as-list only earns its structure **if the reviewer reports against
   it**: `report_review` carries **per-criterion pass/fail**, or the criteria list
   is decorative on day one and verify stays prose. Same tool machinery as
   `submit_plan`. This is the difference between "verified" meaning something
   structured and meaning "the reviewer said LGTM," and it is what lets `review`
   grow toward the grader/Outcomes shape without a second schema pass (D43).

Plus **`report_completion`** (implementer→task): carries the **worklog** —
`decisions-made` and `paths-rejected` — because D46's fresh-fixer loses memory of
the *dead ends*, not the code. The worklog is the fix-seed; without it a fresh fixer
re-explores dead ends on our tokens.

## The board authoring UI (phase one — a feature, not overhead)

With the orchestrator absent, **Wes hand-authors** the structured work-order on the
board, against the **same `create_task` shape** the orchestrator will later propose
into. Build note that **pays twice**: make the form a **renderer of the zod schema**,
not a hand-built form — one definition of D43's shape, consumed by the form, the
orchestrator's `create_task`, and validation alike. Hidden benefit: hand-authoring is
**the schema's first ergonomic test** — if the work-order is annoying for Wes to fill
in, that's D43 feedback caught *before* the orchestrator bakes the annoyance into a
hundred generated tasks. It is also the permanent manual door (principle 8).

## Reserved schema shapes (rule 0.5 — land the shapes, stub the machinery)

- **Work-order fields** on the task record: scope, explicitly-out, **acceptance
  criteria as an individually-addressable list**, kill criterion (+ existing
  isolation, gates). Widening discipline: absent-stays-absent, I6-safe.
- **Revisioning:** amendments as **events**; stage run records `workOrderRev`. Stage
  identity = `(taskId, stage, attempt, workOrderRev)`.
- **Artifact envelope** (above) + `hash→blob`.
- **`submit_plan`** payload (validated against the plan schema in-run) — records
  artifact hash + planner sessionRef onto the task.
- **`report_review`** payload — per-criterion pass/fail keyed to the acceptance list.
- **`report_completion`** payload — worklog (decisions-made, paths-rejected).
- **Per-role scoped token** shape binding credential → `(taskId, stage, attempt)`.

## `composeStageInstruction` — the channel-agnostic context-bundle seam

Now officially (Managed-Agents discussion) the seam that **composes from the
work-order record into whatever the channel renders** — a prompt today, seeded events
if a managed channel ever exists. Keep the instruction **scaffold byte-stable** with
the **work-order fetched by reference** — that is the cache-prefix discipline showing
up again (byte-stable prefix → cache-read rates). D46's fix-seed composition lands
here (work-order + prior diff + review feedback + worklog).

## The plan-mode A/B spike (reframed — D44)

The contract is decided (`submit_plan` wins; native plan mode below the adapter
line), so the spike no longer asks "which wins." Dispatch two identical sessions
(one plan-mode, one not) and **characterize four behaviors**:
- **(a)** Does plan mode's **write-blocking hold in a spawned SDK session?** If yes,
  that's free hardening — the planning stage gets read-only enforcement **by mode**,
  not by trust.
- **(b)** Does **`ExitPlanMode` fire reliably headless**, and is its tool-input plan
  payload **stable in the JSONL across CLI versions?** Fixture it either way.
- **(c)** *The real trouble spot:* native plan mode wants to **continue into
  execution after approval**, but our flow wants the session to **end at plan
  emission**. Can the adapter **stop at the boundary cleanly**, or does suppressing
  the continuation fight the harness?
- **(d)** Does the plan-mode payload map **losslessly into `submit_plan`**, or does
  the adapter need a transform step?
If (c) fights us, the answer is a plain prompt + `submit_plan`, and plan mode stays an
interactive-session nicety — which D44's contract decision already made survivable.

## Ties to existing items

- **S10 (resume bypasses stage independence): RESOLVED by D46** — stage runs never
  resume, so there is nothing to bypass.
- **S2 footing model:** dispatched sessions start `Auto` + a PreToolUse hard-deny
  hook; the `submit_plan`/`report_*` tools are the auth-scoped surface those sessions
  reach. Plan-mode write-blocking (spike (a)) may harden the planning stage further.
- **D42 (project-centric):** the orchestrator is per-project; board controls stay
  first-class (principle 8, dive to any level).

## Build-unit skeleton (DRAFT 2026-07-25 — awaiting Wes on the two scope questions below)

Sequenced behind **Gate 1**. Each unit: scope / out / assertions (I# brought under
test) / exit / kill / model. Per-unit *precise work-orders* (the exact seam, file
anchors, assertion lines) are written by the orchestrator just before dispatch —
this is the plan they compile from. Invariant shorthand: **I6** replay-equivalence,
**I7** transitions only via dispatcher + rejections evented, **I8** totality, **I10**
dispatcher owns state / others propose, **I12** append-only.

### Gate-1 membership — settled 2026-07-25 (the two scope answers)
- **Q1 → human-verify first.** Wes checks the implementer's output against the
  rendered acceptance-list on the board. So `report_review` and the auto **review
  stage move BEHIND Gate 1.**
- **Q2 → keep the machine handoff in.** Artifact store + `submit_plan` stay inside
  Gate 1 — proving the loop without the machine crossing would prove the wrong thing.
- **Consequence — Gate 1 is the FORWARD path only.** A clean pass has **zero steers**,
  so the fix-loop is never exercised at the gate. Therefore **D46's resume-removal and
  the worklog fix-seed also move behind Gate 1** (the resume machinery simply isn't
  hit by a clean loop; removing it belongs with the fix-loop unit it simplifies).
- **Two units split along the gate:**
  - **S7·2** → **2a** work-order fields on `create_task` *(Gate 1)* + **2b** amendment
    events / `workOrderRev` bump *(post-gate, backs the amend door)*.
  - **S7·7** → **7a** the plan→implement handoff, fresh seed = work-order + plan
    *(Gate 1)* + **7b** D46 resume-dies + worklog fix-seed *(post-gate)*.

**Gate 1 = S7·1, S7·2a, S7·3, S7·4, S7·5, S7·7a** (+ spike S7·0).
**Behind Gate 1, same slice = S7·2b, S7·6, S7·7b, S7·8, then phase two S7·9+.**
*(Caveat while D46 (S7·7b) is unbuilt: if a review bounces during Gate-1 testing,
the OLD resume path still fires — acceptable because the gate criterion is a clean
pass, but don't mistake a steered run for the gate.)*

### Spike S7·0 — plan-mode A/B *(front-loaded, before S7·5/S7·7)*
Characterize the four D44 behaviors ((a) write-block in a spawned SDK session,
(b) `ExitPlanMode` headless reliability + JSONL payload stability → **fixture it**,
(c) can the adapter stop at plan emission without fighting the continuation,
(d) lossless map into `submit_plan`). Deliverable: findings + an `ExitPlanMode`
fixture. Isolated test sessions only — **never touches prod `vimes.service`**.

### S7·1 — Reserve the schemas *(rule 0.5)* — `sonnet`
- **Scope:** all reserved shapes as zod in `packages/core` with **no live consumer**:
  work-order fields (scope, explicitlyOut, `acceptanceCriteria[]` individually-keyed,
  killCriterion) widening `taskRecordSchema`; amendment event + `workOrderRev`;
  stage-run identity `(taskId,stage,attempt,workOrderRev)`; artifact envelope;
  `submit_plan` / `report_review` / `report_completion` payloads; scoped-token shape.
- **Out:** any machinery, the artifact store, the MCP server, UI.
- **Assertions:** schema parse/round-trip; **I8** (`proposeTransition` still total over
  the widened record); **I6** (absent new fields → byte-identical replay — the
  widening-discipline test, verify-by-breaking).
- **Exit:** schema tests + typecheck green; scenario double-run byte-identical.
- **Kill:** a shape can't land without reshaping the append-only log (**I12**) or
  perturbing replay → halt + decision record.

### S7·2 — Work-order on the task + amendments — `opus` *(I6/I12-sensitive)*
- **Scope:** `create_task` accepts the full work-order; amendments are **appended
  events** bumping `workOrderRev`; projection reflects current rev; a stage run records
  the rev it dispatched against.
- **Out:** the UI form (S7·3); plan/artifact; report tools.
- **Assertions:** **I7** (work-order set/amended only via dispatcher-proposed writes,
  rejections evented); **I12** (amend appends, never mutates); **I6** (replay
  reconstructs current rev deterministically); stage-run identity carries rev.
- **Exit:** core+daemon green, double-run identical.
- **Kill:** revisioning needs a global-order column the log lacks (see architecture.md
  ordering caveat) → halt.

### S7·3 — Schema-driven board authoring form — `sonnet` *(UI-only, no restart)*
- **Scope:** create/amend form as a **renderer of the zod schema** (one definition,
  shared with `create_task` + validation); acceptance-as-list editor.
- **Assertions:** `lib/*.ts` pure logic tested (schema→form-model, validation); `.vue`
  manual (house rule). **This is the schema's first ergonomic test** (D43 feedback).
- **Exit:** lib tests green; manual authoring works. **Kill:** the schema can't drive
  the form without duplicating field defs → the shape is wrong, reconsider D43.

### S7·4 — Artifact store — `sonnet`
- **Scope:** content-addressed `hash→blob` + envelope persist; put/get; attach-by-ref
  to task. **Out:** dedup, GC (deferred); the tool surface (S7·5).
- **Assertions:** put→get round-trip; content-addressing stable; envelope validates;
  **store injected** (rule 0.3 — tests use in-memory fake). **Exit:** store tests green.
- **Kill:** content-addressing collides with the log's identity model → halt.

### S7·5 — `submit_plan` MCP surface + scoped tokens + hostile-input — `opus` *(security-shaped, new rule-0.6 boundary)*
- **Scope:** expose `submit_plan` to a dispatched session; per-role token binding a
  credential to `(taskId,stage,attempt)`; **validate payload in-run** (retry locality);
  persist plan artifact (S7·4) + attach hash + plannerSessionRef to the task.
- **Out:** report tools (S7·6); native-plan-mode adapter path (spike-informed, optional
  later); the orchestrator's `create_task` tool (S7·9).
- **Assertions:** **I7** (`submit_plan` proposes; task write via dispatcher; rejection
  evented); scoped token **rejects cross-task submit** (verify-by-breaking); the
  harness **hostile-input** profile extended for malformed payloads; **I6** replay of a
  fixture submit.
- **Exit:** tests green incl. hostile-input; double-run identical.
- **Kill:** the MCP boundary can't be made deterministic-testable behind an adapter
  (rule 0.3/0.6) → halt/spike.

### S7·6 — `report_review` (per-criterion) + `report_completion` (worklog) — `opus`
- **Scope:** both tools on the S7·5 machinery; `report_review` carries **per-criterion
  pass/fail keyed to the acceptance list**; `report_completion` carries the **worklog**
  (decisions-made, paths-rejected) — D46's fix-seed.
- **Out:** grader/Outcomes automation (future).
- **Assertions:** review keys validate against the task's acceptance-list ids; **I7/I12**;
  **I6** replay. **Exit:** tests green.
- **Kill:** per-criterion keys can't bind stably to acceptance ids across revs →
  reconsider acceptance-list identity (D43 feedback).

### S7·7 — Plan→implement handoff + D46 fix-loop (resume DIES) — `opus` *(dispatcher behavior change + a decided reversal)*
- **Scope:** (a) `composeStageInstruction` for `implementing` seeds the **fresh**
  implementer with work-order(rev) + plan artifact (D44); (b) **D46**: `stageRunner.ts`
  rule 2 flips `resume`→`spawn`; `taskDispatcher` **removes** `resumeSession` + the
  `resumed`/`resume-failed` outcomes; fix-seed = work-order + prior diff + review
  feedback + worklog, composed in `composeStageInstruction`.
- **Out:** the two-door board UI (S7·8); orchestrator.
- **Assertions:** `resolveStageRunner` **NEVER returns resume** (the S10 resolution —
  assert it AND verify-by-breaking: force a resume path, confirm the test reddens);
  full minimal-loop **I6** replay; **I7**; steer = `attempt++` same rev. **Green-stays-
  green:** step-7's resume tests are deliberately **inverted/removed** — this is a
  recorded reversal (D46), not a regression; call it out in the diff.
- **Exit:** full-loop scenario green, double-run identical.
- **Kill:** a fresh fix-seed can't carry enough (worklog insufficient) to converge in
  the harness → finding; revisit D46's cost stance.

### S7·8 — The two-door board UX — `sonnet` *(UI-only)*
- **Scope:** steer (same rev, new attempt) vs amend (new rev) as a **labeled, visible**
  choice (T7's lesson: the doors weren't labeled).
- **Assertions:** lib logic tested (door → dispatch shape); `.vue` manual.

### ══ GATE 1 ══  (the exit gate for phase one)
The minimal loop **work-order → planner → structured plan → fresh implementer →
verify**, human-driven from the board, **passes once cleanly with ZERO mid-turn
steers.** *Machine half:* full-loop scenario green + double-run byte-identical.
*Human half:* Wes runs one real work-order end-to-end and it converges with no steer.
Only then does phase two begin.

### Phase two (post-Gate-1) — the orchestrator, author first
- **S7·9 — Orchestrator session (author) — `opus`.** `create_task` + comment as
  **proposals** (principle 10 / **I7**, never a transition). Wes promotes from the board.
  **Pivot:** after ~10 real tasks, if authored work-orders need substantial human
  rewrite *more often than not*, **stop** — fix schema/doctrine before adding verbs.
- **S7·10+ — drive verbs (promote / move / dispatch)** added **one at a time**, each an
  individually-revertible grant, only after authorship proves the schema.

## Scope resolved (2026-07-25)

Both scope forks decided — see "Gate-1 membership" above. Q1: human-verify for the
first clean loop (`report_review` + review stage behind the gate). Q2: keep the
machine handoff (artifact store + `submit_plan`) inside Gate 1. Net Gate-1 set:
**S7·1, S7·2a, S7·3, S7·4, S7·5, S7·7a**, plus the front-loaded plan-mode spike.
