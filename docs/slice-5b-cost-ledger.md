# Slice 5b (0.3) — The cost ledger (D27)

> **Status 2026-07-21:** skeleton drafted by the orchestrator. **Construction
> NOT started.** Spikes C1/C2 are front-loaded; **C1 is the kill criterion** and
> decides whether half the slice is honestly buildable at all.

Numbered 5b deliberately: the spec's slice 6 (dispatcher) and slice 7
(orchestrator MCP) keep their numbers. Design record: [D27](open-questions.md).

## The point
Answer, from real data: **"what did that actually cost, and what will the next
one like it cost?"** Per project, per session, per subagent, over time — in
BOTH equivalent API dollars and share-of-window.

Wes's framing (2026-07-21), which is the acceptance test in plain words:
> *"I should be able to click a session we worked in and see the costs in usage
> and raw API dollars, including all the subagent calls. I should be able to
> click a project and see historical data on usage/dollar costs over time. This
> will help for scoping and just give genuinely useful metrics (that API build
> was actually much cheaper than we thought) and it can inform future decisions
> (the last similar task cost 8% usage so it's probably safe to fire when we're
> at 20% remaining)."*

Slice 5 answers *"can I afford to start this?"* from account-wide headroom.
**5b answers "what does this KIND of thing cost?"** — the other half of pillar 4,
and the half that makes headroom actionable rather than merely visible.

## The asymmetry that shapes everything
**Dollars are checkable. Share-of-window is not derivable.**
- Tokens → dollars is arithmetic over a price table, and the table is
  **verifiable against OTel's first-party `claude_code.cost.usage`** (U2). Spike
  C2 has already reproduced Anthropic's own figure to **$0.000000 at n=1**.
- Tokens → percent-of-window is **not derivable at all**: D26 — the endpoint
  publishes percentages and no absolutes, so nothing states how large a window
  is. It can only be **estimated by correlation** and must be **labelled an
  estimate with its band**, or it becomes the lying meter pillar 4 forbids.

These are therefore rendered as **different kinds of number**, never side by side
with equal authority.

## Spikes — FRONT-LOADED, read-only, before construction (rule 0.6)

**C1 — can correlation pin tokens-per-percent to a useful band? ⚠ KILL
CRITERION.** Correlate Δpercent on the account meter against Σtokens VIMES
observed over the same interval. Confounds are known and real: the account is
account-wide while VIMES sees only what it hosts (U3), the weekly cap is
per-model scoped, and other sessions burn concurrently (the D24 confound).
**If the implied window size cannot be stated with a defensible confidence, the
percent half is NOT honestly buildable and the slice ships dollars only** — which
is a perfectly good slice. Do not rescue it with a plausible number.
*Material already banked:* today's deliberate burn (5% → 16% under known load),
the observed rollover, and every poll in `usage-observations.jsonl`.

**C2 — does a price table survive validation against OTel? ✅ SUBSTANTIALLY
ANSWERED 2026-07-21, needs widening.** The OTLP fixture's session was found in
the transcripts and priced from JSONL tokens: **$0.050549 computed vs $0.050549
reported, delta $0.000000.** Pricing the same cache-creation at the 5-minute
rate instead of the 1-hour rate lands **37% low** — the naive failure, quantified.
**Remaining work: widen beyond n=1**, across models and both cache tiers, and
fix the agreement bar (proposed: p95 |rel err| ≤ 0.5%; investigate > 2%; **a
residual correlating with the 1h/5m ratio is a mispriced tier and a rule-0.1
finding, not noise to average out**).

## Scope

**In:**
- **A durable cost store.** The ledger copies usage rows into its own storage.
  Non-negotiable (see the retention finding): transcripts are pruned, and
  `cleanupPeriodDays: 365` is a mitigation that can be changed back or defaulted
  away (rule 0.6). **The ledger must not be a view over data someone else owns.**
- **Hierarchy: project → session → subagent, as a TREE.** Depth > 1 is real
  (observed 129/44/4 at depths 1/2/3 in one session).
- **Dollars** per node, from a **dated** price table, validated against OTel.
- **Share-of-window** per node — as a labelled estimate with its band, or absent.
- **History over time**, per project and per session.
- **Cost per `attributionSkill` / `attributionAgent`** — derivable today, and
  closer to Wes's actual question than per-session is.

**Out (explicit):**
- Headroom. That is slice 5's, endpoint-only, and no local source may impersonate
  it (U3). The ledger reads headroom; it never produces it.
- Enforcement / brakes — slices 6 and 7.
- Multi-account or multi-provider accounting (D18 boundary).

## Binding data rules (each learned the hard way, 2026-07-21)
1. **Dedupe by `message.id` taking the ELEMENTWISE MAX, never first-wins.**
   Repeated ids are progressive partial snapshots, not copies. Keep-first
   undercounts output 2.23× overall, 6.5× on subagents, and up to 19× on a
   single message. (D17, sharpened.)
2. **Walk the tree recursively, and not by directory alone.** 272 of 593
   subagent transcripts live under `subagents/workflows/wf_*/`, and the
   agent→agent edge is **not in the path at all** — it comes from
   `toolUseResult.agentId`, available for only ~46%, with `Workflow` spawns
   recording it solely in a sibling `journal.jsonl`. The spawn tool is named
   `Agent` now, `Task` in older records, `Workflow` for fan-outs; matching only
   `Task` concludes "no nesting" and is wrong.
3. **Parent + child summing is safe** — parent↔subagent `message.id` overlap is
   exactly zero, and cross-project id collisions are zero, so dedupe may be
   global.
4. **But forks double-count**: `subagent_type: 'fork'` copies the spawner's usage
   rows, and forked/compacted sessions copy the whole ancestor prefix — 394 ids
   in more than one session file, inflating a project rollup **+6–13%**.
5. **`usage.iterations[]` is already rolled into the top-level fields** — summing
   it double-counts.
6. **Price per MESSAGE, not per agent** — 31 files mix models within one agent.
   Cache tiers price differently (5m ×1.25, 1h ×2.00, read ×0.10 on base input);
   collapsing them is a ±37% error.
7. **Unknown model → UNPRICED, never $0.** `<synthetic>` records carry zero usage
   and must be excluded, not priced.
8. **`cache_read` is 96–97% of all tokens.** An input/output-only readout is
   wrong by orders of magnitude.
9. **Slugs are not projects.** `-home-ticktockbent`, `-home-ticktockbent-projects`
   and VIMES scratchpad dirs all appear as top-level project directories.
   `VIMES_PROJECT_ROOTS` gives the filter; an outside-roots bucket must exist.
10. **Timestamps are reliable** (0 missing, 0 non-monotonic across 43,197 rows) —
    but async agents outlive the parent's turn, so never infer a subagent's time
    from the parent's tool call.

## Assertions
- Rollups reconcile: Σ(children) + parent === node total, on real data.
- Dedupe is max-wins, asserted against a known progressive-snapshot message.
- A fork does not double-count (the +6–13% inflation is provably absent).
- Dollars for the C2 fixture session reproduce OTel to within the agreed bar.
- Share-of-window is **never rendered without its band**, and is absent entirely
  when C1 could not pin one.
- An unknown model surfaces as unpriced, never as $0.
- Prior assertions green (rule 0.4).

## Exit gate
- **Machine:** a new scenario profile drives the ledger over a fixture corpus and
  **can fail** — proven by sabotage, per the budget-wall precedent. Reconciliation
  and the anti-double-count assertions are the load-bearing checks.
- **Human:** Wes clicks a session he remembers and the number is *believable*;
  clicks a project and the trend tells him something he did not already know.
  Per D28, validated in flight.

## Kill criterion
**If C1 cannot pin tokens-per-percent to a defensible band, the percent half is
cut** and the slice ships dollars-and-attribution only. That is a reduction in
scope, not a failure — a dollar figure that reproduces Anthropic's own number is
worth shipping alone. **What must NOT happen is a percent figure with invented
precision.**

## What would be a finding
- Rollups that do not reconcile (a tree walk missing a level, or a fork counted
  twice).
- Any share-of-window figure rendered without its band.
- A price residual correlating with the 1h/5m cache ratio (a mispriced tier).
- The ledger reading headroom from anything but the endpoint (U3 violation).
