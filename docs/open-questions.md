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

<!-- D33 (degenerate staleness band) moved to decisions.md 2026-07-22 — decided:
     `NOTHING_IS_FRESH_STALE_BAND_MS` renamed to
     `NO_OBSERVATION_IS_FRESH_STALE_BAND_MS` and its value changed from `0` to
     `-1`, closing the one-millisecond gap (`meterFreshness`'s strict `>` let an
     observation aged exactly 0 ms read `fresh`). Wes approved the value and the
     rename; the test that pinned the gap in `taskApi.test.ts` was inverted to
     pin the guarantee instead. -->

## D34 — Projections cannot fold cross-stream, and the event log has no global order *(trigger: slice-6 step 5b, BLOCKED on this; and any future projection that needs a fact from another stream)*

**Raised 2026-07-22 as a rule-0.1 finding. Step 5b HALTED at section B; the
runner (sections C/D) was not built.** Found by the implementing agent, which
stopped rather than working around it; reproduced independently by the
orchestrator with the agent's three probes
(`scratchpad/slice6-step5b-finding-probe.test.ts.txt`).

### The finding

`bootFromSnapshot` (`projection.ts:107`) and `readAllStreamsGrouped`
(`projection.ts:53`) fold **each stream to completion before starting the next**,
and `streams()` is `ORDER BY stream ASC` in the SQLite store / `.sort()` in the
memory store. Every `appSessionId` is a UUIDv4, so **every session stream sorts
before the literal `'tasks'`**. A projection on the tasks stream therefore folds
every session-stream record *before* the `task_created` / `task_session_attached`
that would give it meaning — `sessionRefs` is still empty, and the record is
dropped.

Correctness turns on a UUID's alphabetical relationship to a stream name: the
same fold works with a `zzzz…` stream id and fails with a real one. That was
demonstrated directly (probe 2).

**The sharper half is that it breaks I6.** With a snapshot taken after the attach,
the append arrives as a *tail* record folded against a state where the task
exists, so the value is set; a from-empty replay of the same log drops it:

```
BOOT   : "lastHeartbeatAt":"2026-01-01T00:00:02.000Z"
REPLAY : "lastHeartbeatAt":null
```

The existing I6 helper cannot catch this: `assertBootEqualsReplayAtCuts` cuts an
*already-grouped* array, so its cut points never reproduce the
snapshot-contains-the-attach shape a live daemon produces constantly.

**Root cause, stated plainly: `seq` is per-stream** (`UNIQUE(stream, seq)`,
`MAX(seq) WHERE stream = ?`). **The event log has no global ordering column at
all** — only `ts`, which is not guaranteed unique or monotonic across streams.
So "replay the log in order" is not currently a thing the system can do.

### Why this has not bitten before

Every existing projection is single-stream in effect: `sessions` folds session
events, `meters` folds `meter_sample` on `'usage'`, `tasks` folded only
`'tasks'`. Step 5b's heartbeat fold is **the first genuine cross-stream fold in
the codebase**, and it walked straight into the wall. Nothing shipped is broken —
the constraint was simply never tested, because nothing had needed it.

### The options

- **(a) Give the log a global order** and replay by it. The general fix, and the
  only one that makes cross-stream folds a normal thing to write. Costs an event-
  store schema migration plus changes to snapshot `lastAppliedSeq` semantics, and
  touches the I6/I12 foundations under *every* projection. Large blast radius.
- **(b) Emit a heartbeat event on the `'tasks'` stream.** Keeps the fold
  single-stream, but doubles event volume for the highest-frequency signal in the
  system (S3 counted 80.6k transcript records) and writes a second record of a
  fact the session stream already holds — principle 9.
- **(c) Buffer unresolved heartbeats inside `TasksState`** and adopt them when the
  attach arrives. Makes the fold order-independent, so I6 holds. But state grows
  with every session ever observed and needs pruning, and the mechanism is subtle
  in a projection that is currently easy to read.
- **(d) ⭐ RECOMMENDED — put `lastAppendAt` on the SESSION record.** The sessions
  projection already folds session-stream events, so this is a single-stream fold
  with no ordering problem at all. The watchdog runner already reads sessions
  state for `liveness` and `needsAttention`, so it costs nothing at the call site.
  The same applies to the retry count: `watchdog_stale` carries `appSessionId` and
  is already folded by the sessions projection.

### Lean: (d), plus write the constraint down regardless

**(d) is the smallest change and is also the better model.** "When did this
session last append?" is a fact *about a session*, not about a task — principle 9
says it belongs where its stream already is. `TaskRecord.lastHeartbeatAt` and
`staleRetries` are slice-0 reservations that predate the session/task split being
worked out; under (d) they stay unwritten and should be explicitly retired rather
than left looking live.

**Whatever we choose, the constraint itself needs recording in
`architecture.md`:** *no projection may fold an event from a stream other than its
own.* The next person to try it will otherwise lose the same day. If cross-stream
folding is ever genuinely required, (a) is the honest answer and should be its own
slice, not a step inside one.
