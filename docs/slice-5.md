# Slice 5 (0.3) — Usage service (meters)

> **Status 2026-07-21:** skeleton drafted by the orchestrator. **Construction
> NOT started** — Wes: "prep slice 5 but don't start until the edit button
> lands." Spikes are front-loaded and read-only; the kill criterion is decided
> BY a spike, so U1 runs first and its result is a Gate-D conversation before any
> adapter is built.

Spec reference: §9 slice 5 (line 359), §3.6 (usage service), §5 (`MeterRecord`),
pillar 4 ("budgets gate work, not surprise it"), I10.

## The point
Answer **"can I afford to start this right now?"** from the home screen — 5-hour
window, weekly caps, non-interactive credit, each with a reset countdown and a
burn rate. Today VIMES can tell you a session ran cache-warm on the 1h tier
(slice 4) but not whether you have headroom to start another.

## Exit gate (BOTH halves)
- **Machine:** the `budget-wall` scenario profile runs green against the live
  adapters in replay (meter reads, threshold crossing, staleness degradation).
- **Human:** meters match Anthropic's own `/usage` within ⟨tune 5% PREVIEW⟩ over
  a week of real use. (Reframable like D20/D22 if a shorter honest sample
  settles it — but this one genuinely wants elapsed time, because window
  *rollover* is the interesting behavior and it only happens on the clock.)

## Kill criterion (the sharpest one yet — it is decided by a spike)
**If the unofficial usage endpoint is gone AND JSONL/OTel cannot produce
trustworthy window estimates, HALT.** Per pillar 4, *meters that lie are worse
than meters that don't exist*: a wrong headroom number makes the dispatcher
(slice 6) decline good work or start work it can't finish. Halting means
shipping "usage unknown" honestly rather than a plausible fiction.

## Spikes — FRONT-LOADED, read-only, before any construction (rule 0.6)

**Spike U1 — the unofficial `/usage` endpoint (risk-register VERIFY row).**
Does what the CLI's `/usage` calls still exist, and what does it return? This is
the highest-information probe in the slice and it **gates the kill criterion** —
run it FIRST and report before anything is built. Capture the raw shape as a
fixture (rule 0.7: classify by observation). Expect it to be fragile and
undocumented; the adapter that consumes it is a one-module swap by construction.

**Spike U2 — OTel direct ingest.** `CLAUDE_CODE_ENABLE_TELEMETRY=1` with
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` pinned into the env of every session the
host spawns; the daemon ingests OTLP/HTTP **directly** (no collector process,
spec §3.6). Verify: what metrics actually arrive, at what cadence, with what
field names. Loose schema by design — unknown fields ride through.

**Spike U3 — JSONL accounting (the bulletproof floor).** Can per-window
consumption be computed from the transcripts we already tail? Much of this is
ALREADY in the spine: `usage_block` events with **D17 dedupe by `message.id`**
(the slice-4 cache projection is the worked example — the same dedupe is binding
here or every number double-counts). Determines how good the fallback is when
U1's endpoint is gone, which is half the kill-criterion question.

**Rider on U1/U3 — D24 (billing-bucket classification).** Slice 4 deliberately
declined to fabricate a bucket label from `service_tier`. With a real usage
endpoint and/or observed window movement, correlate `service_tier` × session
interactivity × which meter actually moved, and settle D24 into a decision.
This finally answers Wes's standing dongfu question ("5-hour limit or the $100
automation bucket?").

## Scope / explicitly out

**In:**
- **Meter model** — `MeterRecord` (§5, schema already reserved in slice 0)
  filled for real: `{ meterId, kind: rolling-window | weekly-cap |
  monthly-credit, scope, used, limit, resetsAt, source, observedAt }`. Known set
  (presumed to drift): 5-hour rolling window, weekly all-models cap, weekly
  model-family cap, non-interactive monthly credit.
- **Three adapters, independently degradable** (JSONL / OTel / endpoint probe),
  each stamping `source` + `observedAt` on every sample it emits.
- **Derived, pure:** burn rate, projected exhaustion, headroom per meter.
- **Home-screen meters** with reset countdowns + a **staleness badge**.
- **Threshold notifications** at ⟨tune 80% PREVIEW⟩ crossings, reusing the
  slice-2 push pipeline (`notification_trigger` + D9 suppression, deep-linking
  to the meter).
- **I10 groundwork:** meters readable by a future scheduler (`requireHeadroom` /
  `deferUntilReset` evaluate against them). The dispatcher itself is slice 6 —
  slice 5 lands the *readable* surface and the pure gate evaluator, not the
  spawning policy.

**Out (explicit):**
- The **dispatcher / task system** (slice 6) — I10's *enforcement* (never spawn
  when a headroom gate fails) belongs there; slice 5 only makes the read correct.
- The **keep-warm pinger** (spec §3.7 — out).
- Cost/dollar estimation and billing reconciliation — meters are about
  *headroom*, not accounting.
- Multi-account / multi-provider meters (D18 boundary: provider specifics stay
  inside adapters).

## Architecture (binding)
- **Adapters are fragile-adapter boundaries (rule 0.6)**, each in its own module
  behind one interface, each independently degradable: a dead source marks its
  meters **stale**, it never removes them and never lets another source silently
  impersonate it. Every sample carries `source` + `observedAt`.
- **The core stays pure (rule 0.3):** the meters projection folds `meter_sample`
  events; burn rate / exhaustion / headroom are pure functions over samples with
  the clock INJECTED. Countdown rendering is the UI's job over an injected now.
- **One source of record per fact (principle 9):** when several adapters can see
  the same meter, ONE is authoritative per `meterId` with an explicit precedence
  rule (lean: endpoint > OTel > JSONL, since only the endpoint sees server-side
  thresholds), and the others become corroboration — never a silent merge.
- **Staleness is a first-class state, not an absence.** A meter is
  `fresh | stale | unknown`; the UI must render the difference. This is the
  structural expression of the kill criterion.

## Assertions
- `budget-wall` profile green against the adapters in replay.
- **Staleness degradation:** when a source stops reporting, its meters flip to
  stale within ⟨tune⟩ and the UI says so — a stale number is NEVER shown as
  current (the "meters that lie" guard, asserted not assumed).
- D17 dedupe holds in JSONL accounting (no double-counted usage snapshots).
- Meter reads are pure and snapshot/replay byte-identical.
- All prior assertions green (rule 0.4).

## Build order (sequential agents; verify + commit between each)
| # | Step | Model | Delivers |
|---|------|-------|----------|
| 0 | **Spikes U1/U2/U3 + Gate-D pause** | — | endpoint reality, OTel shape, JSONL fidelity; the kill-criterion call; D24 rider. **Report to Wes before step 1.** |
| 1 | Meter model + pure derivations | opus | `MeterRecord` filled, meters projection beyond the stub, pure burn-rate/exhaustion/headroom + staleness state machine, snapshot/replay assertions |
| 2 | Adapters (JSONL + OTel) | opus | two independently-degradable sources behind one interface, loose OTLP ingest, D17-deduped JSONL accounting, source precedence |
| 3 | Endpoint-probe adapter | opus | the fragile one, swap-in-one-module, degrades loudly (gated on U1 saying it exists) |
| 4 | Home-screen meters + threshold notifications | opus | meters with countdowns + staleness badges, ⟨tune 80%⟩ crossing → push deep-linked to the meter |

## What would be a finding
- Any meter shown as current when its source is stale (halts — this is the
  pillar-4 promise and the kill criterion made concrete).
- JSONL accounting double-counting usage snapshots (D17 regression).
- Two adapters silently writing the same `meterId` (principle 9 violation).
- The endpoint adapter's shape drifting without the staleness path firing
  (fragile-adapter row; the whole point is that it fails loudly).

## Known riders to pick up here
- **StopFailure hook fixture gap** (calibration, 2026-07-19): the one hook
  payload never captured, because it fires only on real API failure — which is
  exactly what a usage/budget wall produces. Slice 5 is its natural home.
- **D24** billing-bucket classification (above).
- **`Cache-Control` on static files** (calibration, 2026-07-21): queued
  daemon-side fix, wants a restart — fold it into the first daemon-touching step
  here rather than spending a separate deploy.
