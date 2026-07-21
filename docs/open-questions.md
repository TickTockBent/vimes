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

## D5 — Course-correction mechanism ⚠ *(trigger: slice 6 spike)*

Streaming-input SDK injection vs interrupt+resume-with-correction for injecting
a course correction into a live stage run. **Lean (2026-07-13):** injection
preferred; interrupt+resume is the fallback. If *both* fail such that
corrections require killing runs, that is slice 6's kill criterion.

## D6 — Worker isolation default *(trigger: slice 6 — task system build)*

`shared-dir` (cache-warm, write races possible) vs `worktree` (isolated,
cache-cold; cache is scoped to machine+directory). **Lean (2026-07-13):**
per-task flag `isolation: shared-dir | worktree`, default ⟨tune shared-dir⟩
with dispatcher-serialized write phases.

<!-- D7 moved to decisions.md 2026-07-19 — decided: hooks-first correlation,
     -n demoted to unused fallback. -->

## D8 — Usage endpoint adapter ⚠ *(trigger: slice 5 spike — VERIFY DONE 2026-07-21)*

Capture what the CLI's `/usage` calls; wrap it as a clearly-marked fragile
adapter for authoritative percentages and reset times. ~~**Lean (2026-07-13):**
do it; meters degrade to JSONL+OTel sources when it breaks.~~

**⚠ The verify half is DONE and it CORRECTED the lean (spike U1/U3,
2026-07-21).** The endpoint is alive (`GET /api/oauth/usage`, the CLI's own
`fetchUtilization`) and its shape is fixtured. But the degradation clause was
**wrong**: U3 showed JSONL and OTel are **account-blind** — they see only the
sessions VIMES hosts, while the limits are account-wide, so neither can
substitute for headroom when the endpoint breaks. **Corrected lean:** build the
fragile adapter as the SOLE headroom authority; when it breaks, headroom
degrades to **unknown** (local sources keep serving attribution/burn/cost, and
are never promoted to fill the headroom gap). Settles into decisions.md when the
step-3 adapter lands. Reopens (happily) if Anthropic ships an official endpoint.

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
`<sessionId>/subagents/agent-<agentId>.jsonl`. **641 session transcripts, 584
subagent transcripts across 10 projects**, each message carrying `usage` with
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
