# Decomposition: tetsuo-ai/agenc-core → Vimes
**Date:** 2026-07-24 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/tetsuo-ai/agenc-core (v0.7.2, stable, actively developed)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes docs in this repo. Companion to the jinn, agent-teams-ai, and codor decompositions; cross-corroborations flagged. Nothing here self-applies.

---

## 1. Landscape

AgenC Core is a different beast from the rest of the series: not a tool *around* a coding agent but a coding-agent **harness in its own right** — a daemon-backed replacement for the Claude Code/Codex category, Grok-first with 16 providers. Topology: tiny launcher → one daemon per `AGENC_HOME` (JSON-RPC over a cookie-authenticated Unix socket, optional WebSocket) → everything else is a client of that daemon: interactive TUI, headless print mode, background agents, a channel gateway, phone remote control, and an embedding SDK. "Real work flows through the daemon; the TUI is a view onto daemon-owned sessions."

**Why it matters to Vimes:** it is a preview of several Vimes designs at production maturity, independently arrived at. Their session engine's event rule is literally named *persist-before-publish* — I13, shipped. Their durability model is rollout-JSONL-as-authority with rebuildable SQLite projections — the codor two-tier pattern, hardened. And their **execution admission kernel** is pillar 4 (budgets gate work) taken to its terminal form: every model call, tool effect, and spawn passes through durable admission with reservations, exactly-once settlement, hierarchical allocations, and fail-closed accounting. Where the other four repos showed Vimes its neighbors, this one shows Vimes its own designs five slices further down the road.

(Neutral observation: they ride current Node — engines `>=25.9 <26`, artifacts built with exactly 25.9.0 — contra the Vimes LTS discipline. Noted, not adopted; their exact-pinning *practice* is the lift, not the version policy.)

## 2. Patterns worth lifting

### 2.1 The execution admission kernel — pillar 4's terminal form
**Where:** `docs/design/execution-admission-kernel.md`, `runtime/src/budget/execution-admission-kernel.ts`, `runtime/src/state/execution-admission.ts`.

Every admitted request has stable identity `(runId, stepId)` and a kind (`model_turn` | `tool_exec` | `spawn`); enqueuing the same identity+request is idempotent, reuse with different data is an error. Decisions are explicit — `allow | queue | deny | approval_required` — and only `allow` carries a durable reservation. The boundary wrappers **reserve before work, constrain the call to the admitted maximum** (production model calls are capped to the reservation's `maxOutputTokens`), record the dispatch point, and **settle exactly once**. State lives in per-project SQLite with `BEGIN IMMEDIATE` read-check-write transitions; decisions and dispatches land in an **append-only journal with monotonic sequence** — and there is deliberately **no mutation/reset RPC** for the accounting.

The fail-closed table is the hard-won part:
- model output with no finite positive maximum → **deny** (`unbounded_model_output`)
- hard USD cap with an unpriced model or a provider lacking authoritative usage → **deny before dispatch**
- usage missing or invalid after dispatch → **consume the full reservation as `held_unknown`** (unknown = worst case, never zero)
- provider exceeds the reservation → persist `provider_overrun`, **block the allocation, cancel the run subtree**
- children inherit the parent's allocation and deadline; a spawn backend that **cannot propagate the parent allocation across processes is fail-closed** — if the budget can't follow the work, the work doesn't happen
- deliberate provider/model fallback is a visible `fallback` journal event and is **never used to make a cap appear satisfied**

**Vimes adaptation — with the frame that makes it tractable:** Vimes has two budget realities the kernel design cleanly separates. **External meters** (Anthropic's 5-hour window, weekly caps) are *observed* — Vimes cannot reserve against Anthropic's counter, so those stay observational per rule 0.7. **Internal allocations** (the orchestration layer's per-task, per-spawner, per-orchestrator budgets) are *owned* — and those can and should get reserve→constrain→settle semantics instead of I10's current check-then-spawn. Concretely for slices 5–7: adopt `held_unknown` accounting (a missing/malformed usage block charges worst case against the internal allocation, never zero — this composes with the `message.id` dedupe from the Jinn haul); adopt subtree cancellation on overrun (a worker that blows its allocation takes its delegated children with it); make admission decisions spine events (the journal *is* the event spine pattern — `queued/allowed/denied/approval_required/dispatched/reconciled/voided/held_unknown/provider_overrun/cancelled` is a ready-made vocabulary); and adopt no-reset-RPC immutability, which is I12's spirit applied to accounting. Full reservation mechanics are slice-7 machinery; the fail-closed accounting rules are slice-5 design.

### 2.2 Rollout-as-authority, projections-as-rebuildable, snapshot-before-migrate
**Where:** `runtime/src/session/` ("canonical append-only rollout journal + `index.json`, **persist-before-publish** events"), architecture doc §state layout.

Three lifts in one subsystem:
1. **Persist-before-publish is I13, shipped and named.** Independent convergence on the exact invariant — the strongest kind of validation.
2. **The rollout JSONL is the event authority; schema-v15 SQLite tables are rebuildable lifecycle/effect/query projections**, with `thread_rollout_items` as the replay index and advisory `index.json` written atomic tmp+fsync+rename. This is the codor self-owned-blob pattern at production hardness — second corroboration for the D12 post-MVP revisit, now with the projection-rebuild discipline spelled out (Vimes's I6 snapshot+tail equivalence is the same guarantee from the other direction).
3. **Automatic verified rollback snapshot before schema upgrade** — upgrading a project DB to v15 first writes `agenc-state_1.pre-v15.sqlite`, verified. Direct D11 lift: when the Vimes migration harness is eventually built, its contract is snapshot → verify snapshot → migrate → keep the pre-migration file. (Vimes's `VACUUM INTO` before migration already gestures here; "verified" and "named-by-schema-version" are the upgrades.)

### 2.3 Bounded control-plane reads
**Where:** kernel doc (schema v13 "bounded thread-listing indexes used to keep the daemon control plane responsive under load"); CLI (`agenc run replay <id> --after 0 --limit 100`, `run evidence --limit`).

Every list/replay read is bounded and cursored, as a stated design requirement rather than an optimization. Vimes serves a phone over a tunnel; the session list, event replay, and search endpoints should be pagination-disciplined from slice 1 — cheap now, and it prevents the daemon-stalls-under-its-own-history failure class the v13 schema exists to fix.

### 2.4 Evidence as the operator surface
**Where:** `agenc run status|replay|evidence|result|cancel` — the debugging surface *is* the journal, with bounded reads and tree cancellation, and nothing else.

Vimes's planned `replay --to <projection>` is the same instinct; extend it to per-run/per-session evidence reads (admission decisions, usage blocks, attention transitions) so "why did the dispatcher refuse this task" is answered by a query, not a log dive. Low effort once the spine exists — the spine already has the data.

### 2.5 Self-audit with repair
**Where:** `agenc security audit [--fix]` plus `agenc doctor` (reports ripgrep presence, provider auth state, etc.).

A command that checks — and optionally repairs — the deployment's own security posture. Vimes analog: a `doctor`/audit surface validating localhost-only binding, Access JWT middleware liveness (I14 probe against itself), secret file permissions, hook relay wiring, CLI version vs lockfile, and authenticated-not-just-installed (the Jinn/ATA preflight, promoted to an operator command). Composes the scattered preflight items from earlier decompositions into one artifact.

### 2.6 Toolchain pinning as enforced artifacts
**Where:** README requirements + `release-toolchain.json` — engines range, artifacts built with *exactly* Node 25.9.0, npm *exactly* pinned via `packageManager` and `devEngines`.

Third corroboration of version-pinning discipline (ATA runtime lockfile, codor's fresh-install script), extended with the enforcement detail: `packageManager`/`devEngines` make the pin self-enforcing in the toolchain rather than documentary. One-line upgrade to the existing Vimes `engines`/`.nvmrc` discipline.

## 3. Patterns to skip (with reasons)

- **The relay/backend/ticket infrastructure** (Cloudflare Worker relay with per-room Durable Objects, hosted identity backend as sole ticket-secret holder, device pairing by one-time code/QR, short-lived signed host tickets): multi-tenant product infrastructure for shipping remote control to strangers. Vimes's tunnel + Access already solves single-operator reach. Two hygiene notes travel: the connector **never holds the relay secret** (only short-lived tickets) — the scoped-credential principle again (codor 2.6); and pairing-by-device rather than by-account is the right model if Vimes ever grows device management.
- **The harness itself** — provider wire layer, TUI, embedded neovim buffer, model catalog, Grok OAuth. Vimes drives Claude Code; this is the category Claude Code occupies. The 16-provider catalog is the *fifth* corroboration of multi-provider cost — though as an actual harness their provider-neutral `llm/` layer is the one place the abstraction genuinely earns its keep, which sharpens rather than weakens the Vimes seam-not-layer stance.
- **Browser tool + SSRF egress proxy** — out of Vimes scope; but if browser automation ever lands, their default-deny egress (blocks private/loopback/metadata addresses, dedicated profile) is the reference posture. One line for the horizon.
- **OS sandbox layers** (bubblewrap/Landlock on Linux, Seatbelt on macOS, opt-in): out of MVP scope, but flagged as the *hardening path* for the Vimes-builds-Vimes sandbox rule — when workers develop Vimes against sandbox projects, an OS-level jail under the sandbox-projects-only doctrine is the defense-in-depth upgrade. Horizon note, not action.
- **Channel gateway** (Telegram/Discord/Slack/WebChat) — same skip as Jinn's connectors, third time.
- **Trajectory export, Ledger/SOL hardware-wallet transfer flow** — different product's concerns entirely.

## 4. Feature gap analysis

| Feature | In AgenC as | Vimes priority | Notes |
|---|---|---|---|
| Fail-closed budget accounting (`held_unknown`, deny-unpriced, overrun→subtree cancel) | admission kernel | **High** | Slice 5–6 design rules; composes with message.id dedupe |
| Reserve→constrain→settle for *internal* allocations | admission kernel | Medium-high | Slice 7; external meters stay observational (rule 0.7) |
| Admission-decision event vocabulary | journal event names | Medium | Ready-made spine event types for dispatcher decisions |
| Snapshot-verify-before-migrate | pre-v15 rollback file | Medium | D11 contract when the migration harness is built |
| Bounded, cursored control-plane reads | schema v13 + run CLI | Medium | Pagination discipline from slice 1 |
| `doctor`/security-audit self-check with --fix | security audit | Medium | Composes all preflight items from the series |
| Evidence reads per run/session | run evidence CLI | Low | Extension of planned `replay --to` |
| Self-enforcing toolchain pins (`packageManager`/`devEngines`) | release toolchain | Trivial | Upgrade existing engines discipline |
| No-reset-RPC accounting immutability | kernel contract | Trivial (rule) | I12's spirit extended to meters/allocations |

## 5. Open questions

1. **How much kernel for MVP?** Recommendation embedded above: fail-closed accounting *rules* in slice 5–6 (cheap, mostly reducer logic), reservation/settlement *machinery* only for slice 7's internal allocations, and never reservations against Anthropic's external windows. The counter-position — full admission from slice 5 — buys exactness Vimes's single-operator reality doesn't need yet and costs a kernel's worth of complexity mid-MVP.
2. **Approval as an admission decision.** AgenC folds `approval_required` into the same decision set as budget denial — gates and budgets share one choke point. Vimes currently treats gates (attention model) and budget refusals (I10) as separate pathways that both set `needsAttention`. Worth one design pass on whether unifying them at the dispatcher (one decision enum, one evidence trail) simplifies slice 6 or over-couples two things that merely rhyme.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Adopt fail-closed accounting rules: missing/invalid usage charges worst case (`held_unknown`) against internal allocations; unpriceable work under a hard cap is denied before dispatch | low | slice 5–6 design |
| 2 | Adopt subtree cancellation: a worker exceeding its internal allocation cancels its delegated children; overrun blocks the allocation and is evented | low | slice 6–7 |
| 3 | Import the admission-decision event vocabulary (queued/allowed/denied/approval_required/dispatched/reconciled/voided/held_unknown/provider_overrun/cancelled/fallback) as spine event types for dispatcher decisions | trivial | event schema notes |
| 4 | Upgrade slice-7 internal allocations from check-then-spawn to reserve→constrain→settle with idempotent (runId, stepId) identity; fail-closed spawn when an allocation can't propagate | moderate | slice 7 |
| 5 | D11 contract addition: migration harness snapshots the DB, verifies the snapshot, migrates, and keeps the named pre-migration file | trivial (rule) | D11 record |
| 6 | Pagination/cursor discipline on all list/replay endpoints from slice 1 | low | slice 1 onward |
| 7 | `vimes doctor` / audit command composing the series' preflight items: binding, Access middleware self-probe, secret perms, CLI version vs lockfile, authenticated-not-installed | low | slice 2–3 |
| 8 | Extend `replay --to` with per-session/per-run evidence reads (admission decisions, usage blocks, attention transitions) | low | post-spine polish |
| 9 | Self-enforce toolchain pins via `packageManager` + `devEngines` | trivial | repo config |
| 10 | Rules: no mutation/reset path for meter/allocation accounting; deliberate fallbacks are visible events, never cap-satisfiers | trivial (rules) | spec note, next doc pass |

---
*End of decomposition. Cross-corroborations across the five-repo series: **persist-before-publish independently ships Vimes I13**; rollout-authority + rebuildable projections (codor, 2nd); hierarchical per-spawner budgets (4th appearance, now with reservation mechanics); version-pinning discipline (3rd, now self-enforcing); daemon-owned sessions with clients-as-views (5th); multi-provider cost (5th). Unique here: the admission kernel's fail-closed accounting, snapshot-verify-before-migrate, bounded control-plane reads, and audit-with-repair. The series' arc is now unmistakable — every mature project in this space converges on the Vimes bones, and the differences that remain are deliberate scope, not architecture.*
