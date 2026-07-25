# Open questions

Each entry: what needs deciding, the **trigger** that forces the call, and the
**current lean**. When decided, the entry **moves** to
[decisions.md](decisions.md) as a dated `D#` record — it is not edited in place.

These keep the design spec's `D#` numbers (the spec numbered its open decision
records directly); no separate `Q#` series is minted. Entries marked ⚠ are
**verify-before-building** — they are spikes, run at the start of the named
slice, never answered from documentation alone (rule 0.6).

## D36 — Should the tailer read SDK transcripts for attachment records only? *(trigger: the first time a correction's clear latency is felt in real use, or any second consumer of a JSONL-only record type)*

Raised by D35 (2026-07-23) and deliberately left out of that fix. On the SDK
channel the tailer skips the transcript entirely (`markSdkJsonl`), so the
`queued_command` attachment — which exists only in the JSONL, never in the SDK
stream — is never seen, and `correction_delivered` cannot fire on the default
channel. D35 makes `run_completed` the clear, which is *correct* but coarser: the
indicator clears at end-of-turn rather than at the moment of delivery.

The narrow repair is to let the tailer read SDK transcript files while mapping
**only** attachment-shaped records, never `message` ones — the double-count the
skip exists to prevent. That means the skip stops being a file-level decision and
becomes a record-level one.

**Lean (2026-07-23):** don't, until something *needs* it. The skip protects the
highest-frequency path in the system (S3 counted 80.6k transcript records) and
the gain today is a few seconds of indicator latency. Two things would change
the answer: a second JSONL-only record type worth having (the CLI's
`queue-operation` records are the live candidate — they capture enqueue, edit,
and delivery separately), or quarantine/retry landing (5c), where the difference
between "steered" and "wedged" starts costing real work rather than polish.

## D1 — Working title *(trigger: first external naming need — repo publish or the 0.1 tag)*

Is "Vimes" the name? Proposed and un-objected through one red-pen round.
**Lean (2026-07-13):** treat as provisionally settled; rename at will before
0.1. Nothing should hard-code the name where a rename would hurt.

<!-- D3 (deployment shape) moved to decisions.md 2026-07-13 — decided:
     bare-host systemd on the host, vimes.example.dev, GitHub IdP. -->

<!-- D4 moved to decisions.md 2026-07-19 — decided: SDK-hosted default everywhere, PTY escape hatch -->

<!-- D5 moved to decisions.md 2026-07-22 — decided by spike S1: streaming-input
     injection STEERS a live run mid-turn (confirmed, two models); interrupt is
     the hard-stop lever, not the correction fallback. Kill criterion NOT
     triggered. -->


<!-- D6 moved to decisions.md 2026-07-22 — decided: default WORKTREE, per-task
     override retained. Spike S2 refuted the lean's premise: caching is not
     directory-scoped on this host, so shared-dir's cache benefit does not exist. -->

<!-- D7 moved to decisions.md 2026-07-19 — decided: hooks-first correlation,
     -n demoted to unused fallback. -->

<!-- D8 moved to decisions.md 2026-07-21 — decided: the usage endpoint is the
     SOLE headroom authority; local sources (JSONL/OTel) are account-blind (U3)
     and supply attribution only, never headroom. The 2026-07-13 lean's
     "degrade to JSONL+OTel" clause was disproved by the spike and is recorded
     as corrected in the decision. Settled by the adapter shipping (cc3c009). -->

<!-- D10 moved to decisions.md 2026-07-19 — decided: mirrored custody,
     adopt on resume or SessionEnd; attention never fires for mirrored. -->

## D11 — Migration convention *(trigger: the first real schema migration)*

The convention is binding now: migrations are pure functions over golden
fixture DBs, run as raw SQL **below** the EventStore interface (the sole
sanctioned I12 exception). What stays open is the machinery. **Lean
(2026-07-13):** the migration harness is built when the first real migration
exists to run through it, not before (rule 0.5: machinery waits for its first
consumer). Moves to decisions.md when that first migration lands.

**Contract addition (mined from the AgenC-core decomp, 2026-07-24):** when the
harness is built, its contract is **snapshot → VERIFY the snapshot → migrate →
keep the named pre-migration file** (`<db>.pre-<schemaVersion>.sqlite`). AgenC does
exactly this before a schema-v15 upgrade (writes + verifies `…pre-v15.sqlite`).
This hardens VIMES's existing `VACUUM INTO`-before-migration gesture with the two
parts it lacks: the snapshot is *verified*, and it is *named by schema version* so
a failed migration has an obvious, addressable rollback artifact.

<!-- D12 (event log body storage) moved to decisions.md 2026-07-13 — signed off
     at slice 0 kickoff: inline bodies. -->

<!-- D13 (spawning-at-crash recovery) moved to decisions.md 2026-07-13 —
     decided: add the spawning→interrupted edge. -->

<!-- D14 moved to decisions.md 2026-07-19 — decided: settingSources ['project'], [] for isolated runs -->

## D17 — usage_block granularity: one per SDK assistant message *(trigger: slice 4/5 — cache stats and meter consumers)*

Observed in the first real smoke session (2026-07-14): one turn = several SDK
assistant messages (thinking, tool_use, final text), EACH carrying a usage
snapshot; the host emits a `usage_block` per message, so identical snapshots
repeat within a turn. The log is honest (rule 0.7 — that IS what the SDK
delivered), but naive summation by slice-4/5 consumers would double-count.
**Lean (2026-07-14):** keep the log as-is; consumers dedupe per API turn
(usage snapshots within one turn are identical → collapse on equality or on
message id); UI collapses consecutive identical usage lines (cosmetic,
landing in slice 1).
**Corroborated + sharpened (2026-07-19, jinn-decompose §2.8):** Jinn hit the
same landmine independently — `--effort high` emits two assistant JSONL
lines with the SAME `message.id` and identical usage; their accounting
carries a "dedupe by message.id" fix. **The dedupe key is `message.id`**,
not payload equality (equality is the weaker proxy we guessed). Binding on
the slice-5 usage adapter from its first line; the host's `usage_block`
payload should carry `message.id` through so consumers can key on it —
check whether it already does before slice 4/5.
**SHARPENED 2026-07-21 — the KEY was right, the COMBINE was under-specified.**
Repeated `message.id` records are **not identical copies**: the transcript writes
a partial usage snapshot per content block, then a settled one (flagged by a
populated `usage.iterations`). Observed: 1123 of 1276 repeated ids carry
DIFFERING `output_tokens`, monotonically non-decreasing — e.g. `[5, 5, 455]`.
**Skip-the-repeat therefore undercounts output 2.23× overall and 6.5× on
subagents.** The corrected rule, binding on D27 and every future JSONL consumer:
**dedupe by `message.id` taking the ELEMENTWISE MAX, never first-wins.** Slice
4's shipped keep-first projection is NOT a regression — verified against the live
event log, where 0 of 11 repeated ids differ, because the daemon tails only
parent sessions whose transcripts repeat the FINAL usage on every block. It is
correct by coincidence, and the coincidence ends the moment anything reads a
subagent transcript. Full evidence in calibration.md.

<!-- D15 (PTY transcript absence) moved to decisions.md 2026-07-13 —
     resolved: inherited CLAUDE* env suppresses transcripts; PTY channel
     scrubs env; tailer trusted on that basis. -->

## D27 — The cost ledger: hierarchy-aware rollup of usage and equivalent API dollars ⚠ *(trigger: its own slice, after slice 5 closes; TWO spikes decide the shape)*

Wes's ask (2026-07-21): *"a hierarchy-aware readout that rolls up … what
percentage of my usage AND what the equivalent API costs would be, per project
and per session … click a session and see the costs including all the subagent
calls … click a project and see historical data over time."* Purpose is
retrospective scoping (*"that API build was actually much cheaper than we
thought"*) and forward decisions (*"the last similar task cost 8% usage so it's
probably safe to fire when we're at 20% remaining"*).

**Scope call (Wes, 2026-07-21): its own slice, spikes first.** It is materially
bigger than slice 5's remaining items, and slice 5's exit gate is about headroom
*truthfulness*, not accounting — folding this in would require rewriting that
gate mid-slice.

**The raw material exists and is retroactive** (observed 2026-07-21, rule 0.7 —
see calibration.md): `~/.claude/projects/<project-slug>/<sessionId>.jsonl` plus
`<sessionId>/subagents/agent-<agentId>.jsonl`. **652 transcripts in total — 593
SUBAGENT transcripts and 59 top-level sessions** (corrected 2026-07-21; the
original "641 sessions" was the recursive total written into the sessions slot —
subagents outnumber sessions ~10:1, so a ledger that treats subagents as a detail
has the proportions backwards), each message carrying `usage` with
cache tiers split (`ephemeral_5m` / `ephemeral_1h`), `model`, and `message.id`
for the D17 dedupe. The parent→child link is the directory path. So project,
session and subagent are all derivable **for work already done**, not only from
the ship date forward.

**The asymmetry that shapes the whole slice: dollars are checkable, percent is
not.** Tokens→dollars is arithmetic over a price table. Tokens→*percent of
window* is **not derivable at all** — D26: the endpoint discloses percentages
and no absolutes, so nothing states how many tokens a window holds. It can only
be *estimated* by correlating Δpercent on the account meter against Σtokens
VIMES observed over the same interval — valid only when VIMES saw essentially
all account activity (the D24 confound), and drifting with model mix because the
weekly cap is per-model scoped.

**Lean (2026-07-21):** build both, and render them as *different kinds of
number*. Dollars are computed and stated; percent-of-window is calibrated and
carries its confidence band visibly. A "8% of weekly" figure with false precision
is the lying meter pillar 4 forbids wearing a more useful hat.

**Lean on pricing — the prior art's objection is dissolved, not inherited.**
Jinn built tokens→dollars from a hardcoded `MODEL_PRICES` table and the
decomposition declined it twice as *"notional on subscription"*. The objection
was that the number is an unverifiable fiction, **not** that dollars are
useless. U2 found `claude_code.cost.usage` — **USD emitted first-party by the
CLI**, model- and cache-tier-correct, no table to maintain. So: OTel supplies
dollars going forward; a price table is needed only to price the historical
transcripts; and **running both concurrently lets the OTel figure validate the
table on the same work**, turning it from a fiction into a calibrated instrument
with a known error band. That validation loop is the difference between what
Jinn built and what this slice would build.

**Spikes — both verify-before-build, both runnable against existing data:**
- **C1 — can correlation pin tokens-per-percent to a useful band?** If the
  implied window size is too noisy or too model-dependent to state with a
  defensible confidence, the percent half of the ask is not honestly buildable
  and the slice ships dollars only. *This is the kill criterion.*
- **C2 — does a price table survive validation against OTel's USD figure** on
  the same session, once cache tiers are priced correctly (1h vs 5m cache writes
  price differently)? Fails → historical dollars carry a wider band, or the
  ledger is forward-only from OTel.

**No prior art to borrow (mining, 2026-07-21).** Per-project attribution,
per-task attribution, parent/child subagent rollup, and cost-over-time history
are **absent from all three** decomposed repos. Jinn's SSE proxy came closest to
subagent cost and *suppressed* subagent traffic deliberately — the opposite of
rollup. This is designed from zero, on raw material none of them had.

<!-- D24 (billing-bucket classification) moved to decisions.md 2026-07-21 —
     decided: Claude Code usage, interactive or headless, consumes the standard
     account-wide 5h/weekly windows; there is no separate automation credit;
     seven_day_oauth_apps is presumed third-party OAuth apps. Settled by slice-5
     spikes U1-U3 plus a correlation experiment; ratified by Wes.
     (D17 remains open above and is now implemented + validated in the slice-4
     cache-observability projection: 47% of real usage_block events were
     duplicate message.ids.) -->

<!-- D33 (degenerate staleness band) moved to decisions.md 2026-07-22 — decided:
     `NOTHING_IS_FRESH_STALE_BAND_MS` renamed to
     `NO_OBSERVATION_IS_FRESH_STALE_BAND_MS` and its value changed from `0` to
     `-1`, closing the one-millisecond gap (`meterFreshness`'s strict `>` let an
     observation aged exactly 0 ms read `fresh`). Wes approved the value and the
     rename; the test that pinned the gap in `taskApi.test.ts` was inverted to
     pin the guarantee instead. -->

<!-- D34 (projections cannot fold cross-stream) moved to decisions.md 2026-07-22 —
     decided: option (d). The watchdog heartbeat becomes `lastAppendAt` on the
     SESSION record, folded by the sessions projection (single-stream, no ordering
     problem, I6 unaffected), because "when did this session last append" is a fact
     about a session rather than a task (principle 9). TaskRecord.lastHeartbeatAt
     and .staleRetries are retired as slice-0 reservations that predate the
     session/task split. The standing constraint — no projection may fold another
     stream's events, because the log has no global ordering column — is recorded
     in architecture.md. Wes approved the recommendation. -->

## D43 — A task's spec source: title-only, or a durable `description` field? *(trigger: slice 7 — the first time a worker needs a brief beyond a title, esp. the independent reviewer)*

Surfaced 2026-07-24 while drafting the stage-instruction seam-fill (parked here so
slice 6 can close on a *minimal* instruction — see the seam-fill draft). Today
`TaskRecord` carries only an **optional `title`** — there is no description/spec
field. The minimal slice-6 instruction gets by on title + the human's mid-run
steering. But the richer pipeline needs a real brief: the **independent reviewer**
(`review` always spawns fresh — the independence rule) has *only a title* to
review against, and a cold-spawn implementer likewise.

**Lean (2026-07-24):** add an **optional `description` field**, same widening
discipline `title`/`gates` already followed (absent stays absent, I6-safe, set at
creation). It is the cheapest thing that gives the reviewer and the cold
implementer something concrete. Interacts with D44 (the plan may BE the
implementer's spec, in which case the description is the *planner's* brief, not the
implementer's). Decide the two together.

**⚠ Evidence from T7 real-use (2026-07-24) — this may be BIGGER than a
`description` string.** Running the board for the first time, Wes hit the gap
directly and named the real shape of it: *"the workflow isn't me saying in 256
characters 'I want to do this' and then hammering you with mid-turn corrections."*
The board as built encodes a **chat-and-steer** model (thin title → dispatch →
converge by live correction). But the software-orchestration workflow VIMES exists
to run is **spec-and-verify**: a precise **work-order** (scope / files-to-read /
assertions / verify / report — the shape of every `scratchpad/unit-*.md` and
`spike-*.md` in this repo) → **one** agent dispatched against it → the orchestrator
**verifies** → a wrong result goes to a **new** agent with a new spec, not a barrage
of corrections. Mid-run correction is the *exception* (the kill-criterion lever),
not the mechanism.

So the D43 answer may not be an optional string but a **work-order-shaped spec
artifact** authored before dispatch, and D44's "plan" is one such artifact produced
by the planning stage. This reframes D43/D44 from "add a field" to "make a task a
work-order and the stage flow mirror the orchestrate→dispatch→verify→fix-to-new-agent
loop." Related symptoms from the same T7 run: the create-sheet showed only the
allowlist container not the projects in it (fixed 2026-07-24, `TaskBoardView.vue`);
the move modal shows all stages but the machine refuses most (QUEUE S8). **Status:
OPEN — Wes deferred the rule-0.1 decision record to keep running T7 ("capture the
confusion, I'll continue the test"); this note is the captured evidence, NOT a
settled call.**

## D44 — The plan→implement hand-off for a cold-spawned implementer *(trigger: slice 7 — when planning and implementing run as separate auto-dispatched stages)*

Surfaced 2026-07-24, same investigation. `resolveStageRunner` rule 3 spawns the
**first implementer FRESH and deliberately does NOT resume the planning session**
("a planning session is NOT the author" — resuming it would carry the wrong
artifact). So a first-pass implementer has the **title but not the plan the
planning stage produced** — the plan lives in a session context it is explicitly
not resumed into. Nothing currently conveys the plan across that boundary.

**Lean (2026-07-24):** the plan must become a **durable artifact** the instruction
can reference — captured from the planning session and attached to the task
(candidate homes: a `plan` field, or the `description` from D43 repurposed) — so
`composeStageInstruction` for `implementing` can hand the fresh worker the actual
plan. The alternative (read the planner's transcript to extract the plan) is
fragile and edges toward screen-parsing (rule 0.8). Decide with D43. **Not a
slice-6 blocker** — slice 6 closes on a single-stage dispatch that never crosses
this boundary.

**⚠ Wes's articulated mechanism, T7 real-use (2026-07-24, session `3a81825a`).** After
accepting a planning worker's plan, Wes described the handoff he'd want, and it *is*
the target design: *"ideally we'd have the orchestrator at this point lift out the
plan and attach it to the task and then ingest it in the worker session we spawn
next. Or if the agent needed more information we'd send the task back up for human
review and buzz my phone."* This names three pieces:
1. **Plan capture → attach → ingest.** An orchestrator step lifts the plan out of the
   planning session, persists it as the task's durable artifact (D43/D44 field), and
   `composeStageInstruction` for `implementing` feeds it to the FRESH implementer.
   `resolveStageRunner` rule 3 already guarantees the fresh spawn (never resume the
   planner — "a planning session is NOT the author"), so the independence half is
   built; the capture/attach/ingest half is not.
2. **The needs-more-info branch → human review + notify.** When the worker needs
   more than it has, the task routes back to a human gate (`blocked-external` or a
   review bounce) with `needsAttention` → the push pipeline buzzes the phone. States
   + notify path exist (slices 0–2); the worker *signaling* the need is the new part.
3. **WHO is "the orchestrator"?** Today it is the human or Fable, by hand. Automating
   this role — capture, verify, attach, dispatch-next, or bounce-with-notification —
   is the slice-7 orchestrator surface (the MCP/agent-facing proposer, principle 10:
   a thin client of the daemon, never a second writer). This is its first concrete
   job. Feeds directly into the task-model finding under D43.
