# Open questions

Each entry: what needs deciding, the **trigger** that forces the call, and the
**current lean**. When decided, the entry **moves** to
[decisions.md](decisions.md) as a dated `D#` record — it is not edited in place.

These keep the design spec's `D#` numbers (the spec numbered its open decision
records directly); no separate `Q#` series is minted. Entries marked ⚠ are
**verify-before-building** — they are spikes, run at the start of the named
slice, never answered from documentation alone (rule 0.6).

## D49 — Should VIMES self-refresh the usage OAuth token, or keep delegating refresh to the CLI? *(trigger: meter staleness during an UNATTENDED window becomes painful in real use — e.g. driving from the phone and the headroom gauge sits dark because nothing else has run to refresh the token)*

**Finding (2026-07-26, diagnosing the usage-meter 401/429s).** The usage endpoint
(`GET /api/oauth/usage`, the sole account-wide headroom authority, spike U3) is
called with the CLI's OAuth **access token, read fresh from
`~/.claude/.credentials.json` on every poll** (`usageEndpoint.ts`
`createCredentialsReader`). That access token has an **~8h life** (`expiresAt`,
confirmed live; the `refreshToken` is ~13-day). **VIMES has no refresh path — it
only reads the token and delegates renewal to "the CLI"** (`usageEndpoint.ts:15`).
But the shared credentials file is only re-minted when **some Claude Code process
makes an inference call** and the SDK auto-refreshes. When VIMES polls in an
**unattended window** (overnight, between sessions), nothing refreshes the file, so
VIMES re-reads the dead token and 401s every poll until the next session runs.
Journal evidence: sustained 401 windows (e.g. Jul 24 16:19→17:14) and a live
recovery at Jul 26 10:01 when *this session's* inference calls refreshed the file
one minute after two 401s. The fixed 5-min poll with no backoff also let the
endpoint escalate **401 → 429**. This is a rule-0.1 finding: a first-class data
source silently ages out.

**Interim mitigation (B):** **B1 — auth-failure backoff** on the poller (repeated
failures widen the interval instead of hammering into 429 + journal spam; reset to
base on success) ships this session. **B2 — surfacing the stale *reason*** in the
read model + UI is the companion fast-follow (a wider poll interval makes the
staleness slightly more visible, so the gauge should say *why* it is dark). B makes
the failure honest and non-escalating; it does **not** keep meters fresh while
unattended — only A does.

**A — the open question:** should VIMES mint its own access token from the stored
`refreshToken` (POST the OAuth token endpoint, write the file back), becoming
independent of other CLI activity?

**Lean (2026-07-26): don't build A yet — spike first, and it may be unnecessary.**
Three reasons to hold: (1) **security surface (0.6)** — VIMES would start handling
the long-lived refresh token + the OAuth client/token endpoint, a new
fragile-adapter boundary with its own risk-register row; (2) **shared-file race** —
it writes `~/.claude/.credentials.json`, which the CLI also owns, so two refreshers
last-writer-wins; (3) **observed-truth (0.7)** — the refresh endpoint + client_id
are undocumented-internal, so it is a spike, never build-against-docs. And the
case it is *unnecessary*: headroom matters precisely when work is running, and
**that is exactly when the token gets refreshed anyway** (a live CLI or a
VIMES-hosted SDK session triggers it); the stale windows are idle stretches where
headroom is moot. **The one thing to verify before deciding:** whether VIMES's own
SDK sessions refresh the shared credentials file — if they do, B fully covers the
windows that matter and A stays parked. See `risk-register.md` (usage-token row).

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

## D51 — Is the linear task-stage state machine the right model? *(trigger: Wes to revisit deliberately; surfaced 2026-07-26 while probing a review-dispatch — out of scope for now)*

**Flag, not yet a worked question (2026-07-26).** While exploring "what happens if I
throw a task straight into implementing," the current stage model showed its shape:
`TASK_STAGE_EDGES` is essentially a linear pipeline (`backlog → planning → plan-ready
→ implementing → review → done`, plus escape stages), so a direct `backlog →
implementing` is rejected and the only way to skip planning is to manually walk the
task through `plan-ready` (arriving with no captured plan). **Wes's instinct: "I
don't think it's the right model" — but explicitly out of scope right now.** No
specifics pinned yet; captured so the thread isn't lost.

**What to consider when it's revisited:** whether stages should be a strict linear
edge set at all vs. a looser "state + allowed operations" model; whether "skip
planning for a small/well-specified task" is a first-class path (today it degrades to
the generic implementing briefing with no plan — see S7·7a); how this interacts with
the work-order-as-spec model (D43) and the plan handoff (D44). **Lean:** none pinned;
revisit as its own design pass, likely alongside the orchestrator/project-loop work
(where dispatch paths get exercised for real). Relates to `taskStateMachine.ts`
(`TASK_STAGE_EDGES`), D43/D44, and the slice-7 loop.

**Annotation 2026-07-29 — the resumability checklist rides with this decision
(agentswarms decomposition 2.1, Wes: "the checkpoint anatomy is the real haul").**
The moment stages form a graph (parallel/conditional edges, a review routing to one
of several destinations), a paused run's full state is: completed stages / stages
RULED OUT by routing / dead edges / the resume point / the suspended-at gate — and
two of those (ruled-out, dead edges) are ROUTING DECISIONS that cannot be re-derived
after the fact. Their three paid-for findings, kept whole: losing routing decisions
resumes into branches already ruled out; losing the completed set re-runs
non-idempotent side effects; completion must be an EXPLICIT record because a stage
whose output was empty is still done. VIMES derivation posture: the spine derives
the checkpoint (never stored — I6, one source of record), which is safe ONLY if the
event taxonomy can distinguish "ruled out" from "not yet reached" — a distinction
that doesn't exist in the linear machine and likely costs ONE new event type at
graph time. Check that against the taxonomy FIRST when this reopens; and pull the
agentswarms repo to read `swarmCheckpoint.ts`'s inline findings first-hand during
the design pass (ELv2: ideas only, never code).

**Annotation 2026-07-29 (same day, hours later) — the killer use case arrived,
and a worked design sketch with it. This is no longer a flag; it is a QUEUED
DESIGN PASS with a driving requirement.**

**Wes's use case (verbatim in spirit):** non-coding projects — books. "What is a
review task in a book? What is a coding task with criteria?" The want: a
**customizable per-project node graph** with configurable edges instead of the
baked-in pipeline. Each node carries: a defined acceptance, a defined
first-message injection (the briefing), and an auto-dispatch on/off flag for
tasks dropped into the state. Example book workflow: pattern scanning → prose
review → beta readers.

**Why this is tractable (the seams are already data):** the three per-node
properties map 1:1 onto existing machinery — acceptance = the criteria list
(already per-task data, already what `report_review` keys against);
first-message injection = `composeStageInstruction`'s composition context;
auto-dispatch = `shouldDispatchOnTransition` reading a node flag instead of a
hard-coded stage pair. D53's taxonomy (decisions / outcomes / mechanics) is
already stage-agnostic; I7, the event spine, fix-seed, and attempt identity all
carry unchanged. The transition machine already treats `toStage` as an open
string at the wire.

**The sketch (Fable, discussed with Wes 2026-07-29):**
- **Nodes pick from a KIT OF KINDS; config supplies the rest.** Kind = `plan` /
  `work` / `review` / `hold` / `terminal` — each kind brings its mechanics
  (tool exposure per D55's pattern, permission mode, outcome vocabulary,
  routing slots: a review-kind node has on-pass and on-fail edges pointed
  wherever the workflow says). Config supplies: node name, briefing injection,
  acceptance handling, auto-dispatch flag, edges. Custom nodes cannot invent
  mechanics — they compose them. (Book flow: pattern scanning = work-kind,
  prose review = review-kind with prose criteria, beta readers = hold-kind —
  `blocked-external` is the ancestor.)
- **Workflow definitions are event-sourced** (their own stream) and **a task
  PINS the workflow rev it was created under** — the `workOrderRev` pattern
  reused, so redefining a workflow never orphans a mid-flight task.
- **Migration story = the default definition:** today's pipeline becomes the
  built-in `software` workflow; existing events replay under it byte-identically
  (I6), and stage-name validation moves from parse-time enum to proposal-time
  adjudication against the task's pinned definition.
- **Where the real work is:** the stage vocabulary is compile-time in ~a dozen
  places (core enum + daemon/UI mirrors) and three subsystems have per-stage
  SEMANTICS baked in — dispatcher (permission mode, tool exposure), briefing
  composer, `deriveReviewOutcome`'s hard-coded pass→done / fail→implementing
  routing. Slice-sized (slice-7-scale), not a unit.
- **The deep risk to inventory FIRST: semantics leakage** — behaviors that look
  per-stage but are load-bearing invariants (plan capture exists via plan-mode
  `ExitPlanMode` interception; D55 exists because plan mode gates MCP tools).
  The design pass opens with that inventory, plus the checkpoint-anatomy
  taxonomy check above (routing decisions must be evented once edges are
  conditional).

**Sequencing (Wes-agreed lean, 2026-07-29):** do NOT preempt slice 8 — the
slice-7 aliasing argument (never change the schema and the orchestrator in the
same motion) applies in full. Land slice 8 Phases A–C, run the Gate-2 trial on
the linear machine, then this becomes **the slice-9 design pass**, with the
book workflow as the driving use case and trial data informing node design.

## D43 — task spec source — ✅ DECIDED 2026-07-25 → decisions.md D43
A task IS a work-order: structured fields (scope / explicitly-out / acceptance-as-list
/ kill) for what the machine reads, attached artifacts by reference for what only an
agent reads. Revisioned, not mutated. Full record + rationale: **decisions.md D43**
(and D44 for the plan handoff, D46 for fix-freshness). Operational plan: slice-7.md.

## D44 — plan→implement handoff — ✅ DECIDED 2026-07-25 → decisions.md D44
The plan crosses via a `submit_plan` tool call, validated in-run (retry locality);
native plan mode lives below the claude-adapter line. Full record: **decisions.md D44**.

## D54 — Concurrent-implementer hazard / per-task dispatch lock — ✅ DECIDED 2026-07-28 → decisions.md D54
The trigger fired (S7·7c made dispatch machine-initiated) and the lean landed as
built: an in-flight lock in `TaskDispatcher`, claimed in the synchronous prefix,
released in a `finally`, loser gets a silent `in-flight` execution outcome.
Full record: **decisions.md D54**.

## D58 — Orchestrator session permission mode — ✅ DECIDED 2026-08-04 → decisions.md D58
`'auto'`, the lean as stated: promotion is the approval; D55's bypass evidence
made interactive the worst of both. Full record: **decisions.md D58** (and D65
for the companion tool-naming call).

## D59 — `task_commented`: when does the emitter earn its build?
**Opened 2026-07-29 (same reframe).** The comment verb is reserved (schema, no
emitter — D56 carries the reservation forward). The live conversation IS the
comment channel while Wes is the only promoter. **Trigger:** review flows going
async (comments needing to outlive a conversation), or the orchestrator needing
to annotate tasks it didn't author. **Lean:** reserve-only until the trigger
fires; the consumer surface (board comments) gets designed with it.

## D62 — ACP: seam, vocabulary, or ignore — ✅ DECIDED 2026-08-06 → decisions.md D62

## D63 — How does a local/terminal CLI client authenticate to the daemon?
**Opened 2026-07-29 (the CLI-client direction — see "One daemon, N faces" in
design-directions.md; Wes: "we're not adding auth yet, but eventually").** I14
is deliberately fail-closed with no loopback exemption: every route, static and
WS included, requires a Cloudflare Access JWT, so a local client hitting
127.0.0.1:4600 gets 401 today (verified). A CLI needs a credential story, and
there are two shapes: **(a) go through the front door** — the CLI talks to the
public URL like every other client, minting an Access token via `cloudflared
access login`; zero daemon changes, I14 stays a single choke point, works
today. **(b) a local credential path** — unix domain socket or loopback bearer
token (the hook-ingress :4601 posture already in the codebase; same territory
as the "alert my phone" API entry) — faster round-trips, but a second door
beside the choke point I14 built, which is a real security decision, not a
detail. **Trigger:** the tier-one CLI unit gets scheduled. **Lean:** (a) first —
prove the CLI on the front-door path where no new trust is minted; build (b)
only if tunnel latency costs real work in practice, and design it together with
the "alert my phone" machine-caller credential rather than as a second bespoke
door.

## D66 — Extension boundary tiers — ✅ DECIDED 2026-08-06 → decisions.md D66

## D67 — Extension trust model — ✅ DECIDED 2026-08-06 → decisions.md D67
