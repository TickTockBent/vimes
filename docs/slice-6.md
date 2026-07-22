# Slice 6 (0.4) — The task system (the dispatcher)

*Opened 2026-07-22 (Wes: "Open slice 6 — let D28 accumulate in the background").
**Skeleton APPROVED by Wes 2026-07-22**, same day: S1 and S3 ran, **D5 is
settled**, the kill criterion is cleared, and the **staleness band is PINNED at
15 min (D30)**. Still open before their dependent steps: **D6** (needs S2's priced
comparison) and the retry/backoff ⟨tune⟩s (no evidence covers retries yet).*

Spec source: §3.5 (task system), §9 slice 6, invariants I7 + I10, D5 + D6.

## The point

Everything before this slice made **one session** observable, steerable and
affordable. Slice 6 makes **work itself** a first-class object: a task with a
stage, a dispatcher that owns every transition, and stage runs that are ordinary
live sessions — so "open this task's session" is one tap into the surfaces
slices 1–5b already built.

This is the slice where VIMES stops being an IDE you drive and starts being a
system that runs work you supervise. Principle 8 ("tunnel to any depth; live at
the top") is the target: the board is the layer you live at, and every layer
beneath it — dispatcher → live session → raw PTY — stays independently solid for
the moments it goes wrong.

**Rule 0.3 is the spine of this slice.** The dispatcher is deterministic code
that owns the task state machine. Agents *propose*; they never transition. That
line is what makes I7 assertable and what keeps slice 7's orchestrator layer from
becoming a second writer (principle 10).

## What already exists (rule 0.5 groundwork — do NOT rebuild)

Slice 0 reserved the shapes and slice 5 built the read half. Slice 6 consumes
them:

| Thing | Where | State |
|---|---|---|
| `TaskRecord` schema (stage enum, isolation, gates, sessionRefs, heartbeat, staleRetries) | `packages/core/src/schemas.ts` | **Complete**, slice-0 reserved. Do not reshape without a decision record. |
| `tasksProjection` | `packages/core/src/projections/tasks.ts` | **Deterministic STUB** — folds nothing. Slice 6 replaces `apply`. |
| `task_quarantined` event | `packages/core/src/events.ts` | Reserved (session stream). |
| `dispatch_refused` event `{taskId, reason}` | `events.ts`, `'tasks'` stream | Reserved — this is I10's refusal record. |
| Headroom gate evaluator (`headroomPercent`, `meterFreshness`, gate verdict/reasons) | `packages/core/src/meterDerivations.ts` | **Complete and pure** — slice 5 built the READ. Slice 6 owns ENFORCEMENT. |
| Session host, registry, resume/interrupt, `appSessionId` identity | slices 0–1 | Stage runs are ordinary sessions through this. |
| Push pipeline + `needsAttention` (I5) | slice 2 | Stale/quarantine raise attention through the existing path. |
| Git panel + mobile hunk diffs (D25) | slice 4 | The review surface the loop hands off to. |
| Cost ledger, per-agent rollup | slice 5b | **Newly load-bearing here** — see D6 below. |

The headroom evaluator is the important one: **slice 5 deliberately shipped the
readable surface and the pure gate, and left the spawning policy to this slice.**
I10 is half-built already; slice 6 supplies the half that can refuse.

## The two decisions this slice must settle

### D5 — Course-correction mechanism ✅ **SETTLED 2026-07-22 (spike S1, Wes approved)**
**Steer = inject, abort = interrupt.** Injection was observed to steer a live run
**mid-turn** (two models, production message shape, one continuous run, I3 no-fork
verified structurally). `interrupt()` is retained as the *hard-stop* lever — not
the correction fallback it was originally cast as. Full record: `decisions.md` D5
+ `calibration.md` 2026-07-22.

**The constraint it carries into step 6:** delivery is bounded by the **next model
call** — injection does NOT preempt an in-flight tool (30.4 s observed against a
40 s tool; unbounded worst case). So the UI renders a correction as *queued →
delivered*, and **the watchdog must not read "queued, not yet delivered" as
stale.** The mechanism already ships (`sendMessage()` reaches the SDK queue), so
step 6 is semantics + evidencing + UI, not plumbing.

### D6 — Worker isolation default
`shared-dir` (cache-warm, write races) vs `worktree` (isolated, cache-cold; cache
is scoped to machine+directory). Lean: per-task flag, default ⟨tune shared-dir⟩
with dispatcher-serialized write phases.

**New this slice: D6 is now MEASURABLE rather than a judgment call.** The cost
ledger (5b) prices per-session and per-agent cache reads and cache writes in real
dollars. A worktree worker's cache-cold penalty and a shared-dir worker's
cross-worker cache sharing are both now *observable quantities on this host*, not
architectural intuition. D6 should be priced against the ledger before the default
is pinned (Gate-D: calibrate → sign off → pin). This is the first time a slice-5b
artifact pays for itself in a later design decision.

## Spikes — FRONT-LOADED, before construction (rule 0.6)

**S1 — D5 correction injection ✅ DONE 2026-07-22. Kill criterion NOT triggered.**
Verdict: **mid-turn steer**, confirmed on two models; interrupt+resume also works
cleanly; I3 no-fork verified structurally on both paths. Two riders fell out of it
and became risk-register rows: the SDK vendors its own CLI binary at a different
version from PATH (drift-guard fix approved as its own unit), and an injected
correction is written as a `queued_command` **attachment** carrying the *enqueue*
timestamp at the *delivery* file position — **the tailer must learn that shape or
mid-run corrections are invisible in the session stream**, which is exactly what
this slice's exit gate demonstrates. Records: `decisions.md` D5, `calibration.md`.

**S2 — D6 cache economics, priced.** Run the same small task twice — once
`shared-dir`, once `worktree` — and read the delta off the cost ledger
(cache-read vs cache-write dollars, per-agent). Deliverable: a priced comparison
Wes can sign D6's default against. Cheap now that 5b exists.

**S3 — Heartbeat reality ✅ DONE 2026-07-22 (read-only, zero burn).** Measured over
the REAL corpus (697 transcripts, 80.6k records) instead of synthesised runs.
Machine-work gaps: p50 1.5 s, p99 1.33 min, p99.9 3.52 min, **max 14.87 min**;
false quarantines >5 min → 30, >10 → 8, **>15 min → 0**. **Staleness PINNED at
15 min (D30).** The spec's 5 min failed *systematically*, not occasionally — the
tail is long thinking blocks plus a reproducible `TaskOutput`/`Agent` cluster at
exactly 10.00 min (a subagent-poll cap), and stage runners spawn subagents.
**The bigger result was a design finding, not a number:** healthy human-gated waits
reach 10 h, so no threshold can separate them from a stall — hence D30's
three-condition definition of stale. S3b (a synthetic wedge) was NOT run and is not
worth its burn: S1's A5 already showed a wedge and a slow tool are indistinguishable
in JSONL (absence of appends is the only signal), which also gives the watchdog
scenario fixture its mechanism — `python3 -c "time.sleep(N)"` runs foreground where
the CLI blocks `sleep`. Full record: `calibration.md`, D30.

**⟨tune⟩ inventory.** Heartbeat staleness ✅ **PINNED 15 min** (D30, Gate-D
2026-07-22 — S3a measured the machine-work tail at max 14.87 min; the spec's
5 min would have quarantined healthy subagent work systematically). Still
UNPINNED and not FAIL-able until signed off: stale retries before quarantine
⟨tune 3⟩; retry backoff curve ⟨tune⟩; isolation default ⟨tune shared-dir⟩
(pending S2).

## Scope

- **Task state machine (PURE).** `backlog → planning → plan-ready → implementing
  → review → done`, plus `blocked-external`, `quarantined`, and the
  convergence-aware exit `done + manualReviewRequired` — when auto-review rework
  stops converging, hand off explicitly rather than silently pass.
- **The dispatcher (deterministic).** Owns *all* transitions and *all* worker
  spawning, through the session host. Every stage run is an `appSessionId`.
- **I10 enforcement.** Checks meters before spawning; a failed `requireHeadroom`
  or `deferUntilReset` gate refuses the spawn and events `dispatch_refused`.
- **Watchdog / quarantine.** ⚠ Per **D30**, "stale" is **three conditions, all
  required**: the run is (1) NOT blocked on a human gate, (2) NOT at a resume
  boundary, and (3) has not appended for **≥ 15 min** (pinned). A watchdog
  implementing only (3) is wrong at any band — S3a observed healthy human-gated
  waits up to **10 hours**, and quarantining one is precisely this slice's
  named rule-0.1 failure. Gate state already exists (`canUseTool` /
  `needsAttention`, slices 0–2); the watchdog CONSULTS it rather than inventing a
  second notion of "blocked". Then: retry with backoff → quarantine after
  ⟨tune 3, unpinned⟩ attempts; stale and quarantine set `needsAttention` on the
  stage session (existing I5 path).
- **Stage runner with distinct dispatch verbs.** `review` and `fix` are different
  verbs with the independence rule baked in (design-directions 2026-07-20):
  **review wants independence** (orchestrator or a fresh reviewer — an agent
  reviewing its own work shares its own misunderstanding), **fixes want the hot
  author** (cheap, context-rich, cache-warm).
- **Course correction** into a live stage run (mechanism per S1/D5).
- **D6 isolation flag** per task, including worktree creation/management (moved
  here from slice 4 explicitly).
- **Kanban board UI** — the layer Wes lives at.
- **Watchdog scenario profile** added to the harness suite.

## Explicitly out

- **The MCP orchestrator surface (slice 7).** Slice 6 builds the state machine
  and its rejection path; slice 7 exposes it to agents and hardens I7 against
  hostile/malformed proposals (extended hostile-input). Principle 10 is binding
  on the boundary: the MCP server will be a thin client of the daemon API, never
  a second writer to the store.
- **Brake ENFORCEMENT** (held work + one-tap release) — slice 7. The vocabulary
  is already reserved (slice 5, `disposition`; `needsAttention: brake`).
- **Multi-project workspaces / multi-machine session hosts** — post-MVP horizon.
- **Keep-warm pinger** (spec §3.7 — out).
- **Cost/accounting changes** — 5b owns dollars; slice 6 only *reads* the ledger
  for D6 and never re-derives money.

## Architecture (binding)

- **The dispatcher's decision is PURE; only the spawn is I/O.** A pure function
  over (task, meters, policy, clock-injected now) returns a decision —
  `spawn | defer | refuse(reason) | quarantine`. The daemon executes it. This is
  what makes I7 and I10 assertable headlessly, with no Claude and no network.
- **Every transition is an event; the projection is a fold.** No task state is
  written anywhere but the log (I12). `tasksProjection.apply` stops being a stub
  and must satisfy I6 (replay equivalence: from-empty === snapshot + tail).
- **Rejections are evented, never silent.** A proposal that violates the state
  machine produces a rejection event carrying the attempted edge and the reason.
  I7's assertability depends on the rejection being *recorded*, not merely
  returned.
- **Stage runs are ordinary sessions.** No parallel session concept. The task
  holds `sessionRefs`; everything slices 1–5b built (stream, diff, cost, resume,
  attention) applies to a stage run for free.
- **The watchdog reads the same liveness the UI does** — no second definition of
  "is it alive." Rule 0.7: staleness is *observed* (JSONL append cadence), never
  declared.

## Assertions

- **I7 (new)** — Task transitions occur only via the dispatcher; proposals that
  violate the state machine are rejected **and the rejection is evented.**
- **I10 (completed)** — The dispatcher never spawns when a task's
  `requireHeadroom` gate fails against current meters; the refusal is evented.
  (Slice 5 asserted the read; slice 6 asserts the refusal.)
- **I6 still holds over the now-live tasks projection** — replay equivalence with
  real task events, not an empty fold.
- **Watchdog scenario** added to the suite: a stage run goes quiet → stale →
  retries → quarantines → raises attention, deterministically, twice.
- **All prior assertions stay green** (rule 0.4), including slice 5b's cost exit
  gate and the six existing profiles.

⚠ **Deliberate harness change:** `harness/scenarios.test.ts` currently asserts
*exactly the six spec §7 profiles*. Slice 6 is the sanctioned point to extend
that to seven (spec §9: "watchdog scenario added to suite"). It must be a
deliberate, reviewed edit — not an incidental one — because that assertion is the
guard against profile sprawl.

## Exit gate — HUMAN

**One real feature shipped end-to-end through the board, with at least one
mid-run correction.** Not a demo task: a real feature Wes actually wanted, moved
backlog → done through the dispatcher, where he corrected a worker mid-run and
the correction landed without killing the run.

Per D20/D22/D25 precedent, this reframes on passing to "validated in real use +
continuous daily use going forward."

## Kill criterion

**If correction injection fails BOTH paths** — streaming-input *and*
interrupt+resume — such that corrections require killing runs, **halt and write a
decision record.** The inspect-and-steer promise is the entire point of the
rework; a task system you can only stop and restart is a worse version of a shell
script.

✅ **CLEARED 2026-07-22 by spike S1** — both paths work; neither requires killing
a run. The slice proceeds. (The criterion stays written down: a later SDK change
that breaks both levers re-triggers it, rule 0.6.)

## What would be a finding (rule 0.1 — halt, don't patch)

- The watchdog quarantines a **healthy** run (a long thinking block or slow tool
  call reads as stale). That is a wrong ⟨tune⟩ *or* a wrong staleness signal —
  either way it halts, because a system that kills good work is worse than no
  watchdog.
- A task reaches a stage through any path other than a dispatcher transition
  (I7 violated) — including via a projection rebuild or a migration.
- Replay equivalence breaks once task events are real (I6).
- The dispatcher spawns against a failed gate (I10) under any timing.
- Two writers to task state appear (principle 10) — e.g. the UI mutating a task
  directly rather than proposing.

## Build order (sequential agents; my verification + a commit between each)

0. ~~**S1 spike (D5)**~~ ✅ **DONE 2026-07-22** — D5 settled, kill criterion cleared,
   step 6 unblocked (and cheaper than planned: the plumbing already exists).
1. **Task state machine (PURE, core).** Transition table, legal edges, rejection
   reasons, the convergence exit. Full task event set (rule 0.5) — extend
   `events.ts` beyond the two reserved events.
2. **Tasks projection (core).** Replace the stub; I6 must hold.
3. **Dispatcher decision function (PURE, core).** spawn/defer/refuse/quarantine,
   consuming slice 5's headroom evaluator. **I7 + I10 land here.**
4. **Dispatcher execution (daemon).** Spawn through the session host; wire
   `dispatch_refused`; task API.
5. **Watchdog + quarantine** (after S3 calibration + sign-off for the ⟨tune⟩s).
6. **Course correction** — the verb the kill criterion protects. Per D5 this is a
   `correction` verb + its event + the board affordance over the EXISTING
   `sendMessage()` path, plus the *queued → delivered* rendering and the
   watchdog's "queued correction is not staleness" rule.
7. **Stage-runner verbs: review vs fix**, independence rule baked in.
8. **D6 isolation + worktree management** (after S2 + Wes's pin).
9. **Kanban UI.**
10. **Watchdog scenario profile** + the deliberate six→seven assertion change.

## Concurrent, not blocking

**D28 (slice 5b's accuracy sign-off) accumulates in the background** — Wes clicks
through the ledger against `/usage` over the coming days. It is independent of
slice 6 (different surface, different gate) and does not block this slice. Rule
0.4 still applies: slice 6 keeps 5b's assertions green.

## Operational hazard to design around (not a blocker)

**The dispatcher will spawn workers that build VIMES.** Those workers are
descendants of `vimes.service`, so a deploy restart kills in-flight stage runs —
the bootstrap tax already recorded in CLAUDE.md, now multiplied by a system that
runs work unattended. The two-half pre-flight (sessions AND terminals) needs a
third half: **in-flight stage runs.** Worth designing the dispatcher so a
restart leaves tasks *resumable* rather than merely interrupted; the
hot-reload direction (design-directions, 2026-07-21) is the eventual answer.
