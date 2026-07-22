# Open questions

Each entry: what needs deciding, the **trigger** that forces the call, and the
**current lean**. When decided, the entry **moves** to
[decisions.md](decisions.md) as a dated `D#` record — it is not edited in place.

These keep the design spec's `D#` numbers (the spec numbered its open decision
records directly); no separate `Q#` series is minted. Entries marked ⚠ are
**verify-before-building** — they are spikes, run at the start of the named
slice, never answered from documentation alone (rule 0.6).

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

## D33 — The degenerate staleness band overstates by one millisecond *(trigger: slice-6 step 5's watchdog, or any decision to run with the usage poller disabled)*

**Raised 2026-07-22 as a rule-0.1 finding during slice-6 step 4b verification.**
Found by the implementing agent, whose first version of the test asserted the
*intent* and failed; confirmed independently against `meterDerivations.ts:75`.

`app.ts` hands `TaskDispatcher` a staleness band of `NOTHING_IS_FRESH_STALE_BAND_MS
= 0` when `deriveStaleAfterMs(config.usagePollIntervalMs)` is null — i.e. when the
usage poller is disabled. The name asserts that no observation can be vouched for.
**It overstates by one millisecond:** `meterFreshness` classifies with
`observationAgeMs > staleAfterMs`, so an observation aged **exactly 0 ms** reads
`fresh` and its gate is evaluated for real.

**Exposure is narrow and it fails OPEN.** With the poller off, `runUsagePoll` is
`meter_sample`'s only emitter, so reaching this needs a forced
`POST /api/usage/refresh` landing in the *same millisecond* as a gated dispatch.
`observedAt` is stamped from the daemon's own injected clock (`usageEndpoint.ts:178`),
never from the endpoint's, so clock skew cannot widen the window — a future-dated
observation is not reachable here. In production the poller is ON and this constant
is never used.

**Why it is written down rather than tuned away (rule 0.1, rule 0.2).** `-1` would
close it, and that is a one-character edit — which is exactly why it is not being
made silently. A number that decides whether a worker spawns against an
unverifiable meter is Wes's to price (pillar 4: never spawn against a number we
cannot see). The current behaviour is PINNED by a test in `taskApi.test.ts`
explicitly labelled as a gap, so taking the decision reddens a test on purpose and
the change is deliberate rather than incidental.

**Lean: change the constant to `-1` and rename it to match what it then means.**
The band's whole purpose is to be the honest degenerate case; a name that
overstates its own guarantee is the pillar-4 failure in miniature, even where the
blast radius is one millisecond. **Cheap now, and step 5's watchdog is the next
consumer of freshness reasoning** — it should inherit a constant that means what it
says. Counter-argument for leaving it at `0`: it is unreachable in the shipped
configuration, and `-1` as a duration reads oddly enough to need its own comment.
