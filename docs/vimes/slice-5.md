# Slice 5 (0.3) — Usage service (meters)

> **Status 2026-07-21 (updated):** spikes U1/U2/U3 ✅ run — **kill criterion NOT
> triggered.** The headroom spine is COMPLETE end-to-end and live: endpoint →
> fragile adapter → event log → pure projection → derivations → home-screen
> meters. Steps landed: **1** meter model + pure derivations (`06c7ebd`), **2**
> endpoint adapter + `Cache-Control` fix (`cc3c009`), initial-poll fix
> (`b5bfc12`), **3** home-screen meters strip (`e4ddb07`). Meters confirmed
> rendering on desktop and mobile by Wes.
>
> **Remaining (one daemon-touching unit, then the gate):** the derived read
> model (`GET /api/usage/derived` — burn rate, projected exhaustion, freshness,
> computed at the boundary with an injected clock), the usage **observation
> log** (see below), and **threshold notifications** — bundled into ONE restart
> because a restart kills live shells. Push is verified working again
> (2026-07-21, FCM 201) after the subscription was re-registered.
>
> **Deliberately NOT here:** the burn/exhaustion derivations must not ride
> `/api/projections/meters` — every field is a function of *now*, and projection
> state is snapshot/replay byte-identical by construction. The nondeterminism
> gate exists to keep clocks out of core state; the daemon stamps `nowIso` at the
> boundary and calls the already-tested pure functions (rule 0.3).
>
> **Usage observation log (added 2026-07-21, rule 0.6).** Classified poll
> failures currently emit nothing — correct for product state, but it also makes
> them invisible, and a 401 every ~6h at token roll is the *normal* case we have
> no evidence of. An append-only diagnostic log beside the event DB records one
> line per poll (timestamp, outcome class, HTTP status, and a **fingerprint of
> the response's key structure**), storing the full redacted body the first time
> a fingerprint is unseen. That gives a dated corpus of real shapes and tells us
> the moment Anthropic's surface moves. **Outside the event spine on purpose** —
> it is diagnostic evidence, not product state. Window resets every 5 hours
> exercise reset-detection for free; near-100% and severity escalation are the
> genuinely rare shapes and would have to be provoked deliberately.

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

**Spike U1 — the unofficial `/usage` endpoint. ✅ RUN 2026-07-21 — ALIVE.**
`GET https://api.anthropic.com/api/oauth/usage` (the CLI's own
`fetchUtilization`), OAuth bearer from `~/.claude/.credentials.json` → **HTTP
200**, rich body. **KILL CRITERION NOT TRIGGERED** — the authoritative source
exists, so meters can be truthful. Golden fixture:
`fixtures/usage/oauth-usage-2026-07-21.json`. Full findings in calibration.md.
Binding results for construction:
- **Consume `limits[]`** — already normalized `{kind, group, percent, severity,
  resets_at, scope, is_active}`; `session` / `weekly_all` / `weekly_scoped`
  (+`scope.model`) map 1:1 onto our meter set, and `is_active` marks the
  currently-binding limit. Do NOT enumerate the flat top-level buckets.
- **PERCENT ONLY** — no token/dollar absolutes. `MeterRecord {used, limit}`
  (§5) assumes absolutes and must be revisited in step 1 (**lean: widen the
  record with `percent`/`unit`** rather than fake `used/limit`, because
  inventing precision the source never gave us is exactly the lying meter
  pillar 4 forbids). **This is a Gate-D schema decision — Wes signs it off
  before step 1 builds on it.**
- **The schema churns (rule 0.6 confirmed):** the body carries internal
  codenamed null buckets (`tangelo`, `iguana_necktie`, `nimbus_quill`,
  `cinder_cove`, `amber_ladder`, `seven_day_cowork`, …). Tolerate and IGNORE
  unknown keys; never enumerate.
- **Token expiry is the real staleness trigger:** the OAuth token lives ~6 h and
  the CLI owns refresh; a daemon adapter will meet 401 and must degrade to
  stale, never crash, never show old numbers as current.
- Not usage: `/api/claude_code/policy_limits` (policy/compliance flags only).

**Spike U2 — OTel direct ingest. ✅ RUN 2026-07-21 — WORKS.** OTLP/HTTP JSON
straight to a local listener, no collector. `POST /v1/metrics` + `/v1/logs`.
Metrics: `claude_code.token.usage` (split `input`/`output`/`cacheRead`/
`cacheCreation`), **`claude_code.cost.usage` in USD**, `session.count`,
`active_time.total`. Attribute keys are the contract: `model`, `query_source`
(subagent attribution), and **`terminal.type: interactive|non-interactive`** —
the interactivity signal `usage_block` lacks, and what D24 needed. Resource
carries `service.version` (free CLI-drift signal). Fixture:
`fixtures/usage/otlp-metrics-2026-07-21.json`. **Caveat:** every point carries
identity (`user.email`, org/account ids) — fine on Wes's box, a real
consideration for a product-ized VIMES.

**Spike U3 — JSONL accounting. ✅ RUN 2026-07-21 — IT IS ATTRIBUTION, NOT
HEADROOM.** Two results, the second reshapes the slice:
1. **D17 is load-bearing empirically:** 57 `usage_block` events → 30 counted,
   **27 duplicate `message.id`s skipped (47%)**. Naive summation inflates every
   number by ~2×. (16 events carry no `messageId` and cannot be deduped — a
   bounded residual risk.)
2. **Local sources are ACCOUNT-BLIND.** The endpoint reported the 5-hour window
   at 29–35% consumed while VIMES's JSONL held **zero** `usage_block` events for
   that same window — because VIMES sees only the sessions it HOSTS, and the
   limits are **account-wide** (every Claude Code invocation anywhere, including
   this orchestrator session). OTel shares the blindness (it covers only
   sessions VIMES spawns with the env set).
**This inverts §3.6's "bulletproof floor" framing.** JSONL is bulletproof for
*attribution*, never for *headroom*.

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
  *headroom*, not accounting. **Still out, and now it has a home: D27 (the cost
  ledger) owns hierarchy-aware rollup, dollars, and history as its own slice.**
  Note the rationale shifted: this line was written against a Jinn-style
  *fabricated* price table; U2's first-party `claude_code.cost.usage` in USD is a
  different animal. It stays out of slice 5 because the slice's exit gate is
  about headroom **truthfulness**, not because dollars are notional.
- **Brake ENFORCEMENT** (held work, one-tap release — codor's semantics, better
  than a bare notification). Slice 5 ships the threshold *notification* and
  **reserves the hold/release vocabulary** (rule 0.5, Wes 2026-07-21) so slice 7
  upgrades without a migration. `needsAttention: brake` was already reserved
  2026-07-20.
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
- **Source precedence is a TYPE DISTINCTION, not a preference (U3).** Headroom
  comes from the ENDPOINT ONLY — it is the sole account-wide source. Local
  sources (OTel, JSONL) supply attribution, burn rate and cost for VIMES-hosted
  work, and must NEVER be allowed to impersonate a headroom number. One
  authoritative source per `meterId` (principle 9); corroboration, never a
  silent merge.
- **Staleness is a first-class state, not an absence.** A meter is
  `fresh | stale | unknown`; the UI must render the difference. This is the
  structural expression of the kill criterion — and U3 makes it concrete: if the
  endpoint dies, headroom degrades to **unknown** while attribution keeps
  working. Local data must not be promoted to fill the gap.

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
