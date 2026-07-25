# Slice 7 — Task-as-work-order + the spec-and-verify loop

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

## Not yet done (orchestrator's next skeleton step)

Build-unit decomposition, assertion list (which I# each unit brings under test), and
the kill criterion per unit. That is the orchestrator's skeleton work when the slice
opens — this doc is the signed-off design it compiles from.
