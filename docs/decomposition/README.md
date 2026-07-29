# Decomposition series — index & carry-over tracker

Prior-art pattern extraction through the Vimes lens (2026-07-19): three
repos, each analyzed against the canonical spec/docs. **Nothing in these
documents self-applies** — every item below is applied deliberately, and this
tracker is the ledger of what has and hasn't been.

| Doc | Repo | Center of gravity |
|---|---|---|
| [jinn-decompose.md](jinn-decompose.md) | hristo2612/jinn | org-metaphor orchestration; hooks channel; the landmine list |
| [agent-teams-ai-decompose.md](agent-teams-ai-decompose.md) | 777genius/agent-teams-ai | worker-side control protocol; MCP verb families |
| [codor-decompose.md](codor-decompose.md) | rjx18/codor | sibling design; custody trio; assumption ledger; brakes |
| [agenc-core-decompose.md](agenc-core-decompose.md) | agenc-core | admission kernel (fail-closed budgets); deadline propagation |
| [agentswarms-decompose.md](agentswarms-decompose.md) | AgentSwarms-fyi/agentswarms | **checkpoint anatomy** (the resumability checklist); attended/unattended failure-semantics synthesis; quality trends above the verdict |

**Strongest signal of the series:** four-repo independent convergence on the
Vimes bones (daemon-owned sessions, event journal, pure-function core,
JSONL tailing) — and triple-to-quadruple corroboration on: structured
signals over prose, reviewer-close gating, per-spawner budgets, and the full
itemized cost of multi-provider abstraction (declined, now 4× validated).

## Unified carry-over tracker

Status: **applied** (landed in docs/code, cite the commit), **lean-updated**
(open-question lean revised, decision still pending), **noted** (recorded in
the right doc, no action due yet), **pending** (waits for its slice/trigger).

| Item (source) | Lands in | Status 2026-07-19 |
|---|---|---|
| D7 spike hooks-first; `-n` demoted (jinn 1) | slice 2 spike | **applied** — D7 decided 2026-07-19, spike green |
| Custody trio for terminal-started sessions (codor 2) | slice 2 + D10 | **lean-updated** (D10) |
| JSONL usage dedupe **by `message.id`** (jinn 3) | slice 4/5 usage consumers | **lean-updated** (D17); note: current `usage_block` payload does NOT carry messageId — add before slice 4 |
| Self-owned blob refs for D12 horizon (codor 4) | post-MVP revisit | **noted** (design-directions.md) |
| Stop/StopFailure/PreToolUse relay; StopFailure = usage adapter #4 (jinn 2) | slice 2 → 5 | pending |
| `rate_limit_event` from SDK stream into meters/attention (ata 1) | slice 5 | pending (already observed live on this box in the D4 spike) |
| Auto-resume at reset w/ full staleness matrix; policy by session class (ata 2) | slice 5–6 | pending — **matrix re-read 2026-07-21**, four guards transcribed to calibration.md; U1 improves the TRIGGER (schedule proactively from `limits[].resets_at`, not reactively from a rate-limit event) |
| Spend-brake semantics: held work + one-tap release + always-on non-blocking meter (codor 3) | slice 5 read side / slice 7 enforcement | **lean-updated 2026-07-21** — Wes: ship slice 5's threshold *notification* as scoped, **reserve the hold/release vocabulary now** (rule 0.5) so slice 7 upgrades without a migration |
| Per-session $-cost from a hardcoded price table (jinn 3.4/§4) — originally **skipped** as "notional on subscription" | D27 cost ledger | **revisited 2026-07-21** — the objection was *unverifiable fiction*, not *dollars are useless*. U2's first-party `claude_code.cost.usage` (USD) dissolves it, and can **validate** a price table used to price historical transcripts |
| Hierarchical cost rollup (project / session / subagent) + cost-over-time history | D27 cost ledger | **absent from all three repos** — designed from zero; raw material (on-disk subagent transcripts, `query_source`, per-message `usage`) is unique to VIMES |
| `billing_error` StopFailure reason unrouted (jinn 2.1 lists it; only `rate_limit` handled) | attention reason enum | **noted 2026-07-21** — distinct from rate-limiting, currently unclaimed anywhere |
| Turn attribution: injected vs terminal-native (jinn 5) | slices 2–3 attention model | pending |
| Provider preflight + authenticated-not-just-installed (ata 8, jinn 4) | slice 2 step 1 | in build |
| Attention reason enum additions: `rate-limited`, `brake` (jinn 2.2, codor 2.3) | schema reservation (rule 0.5) | **ratified 2026-07-20** — reserved, no setters |
| One-source-of-record rule (codor 8) | design-principles #9 | **ratified 2026-07-20** |
| MCP surface: process_register/list/stop; briefing-as-tool; heartbeat+bootstrap check-in; reviewer-close structural; `report_completion` typed (ata 3/5/6/7, jinn 8) | slice 6 design | pending |
| Cascade guard + brakes layer (held delivery, one-tap release) (ata 4, codor 3) | slice 7 | pending |
| Per-spawner budget scope; per-worker scoped credentials (jinn 6, codor 6) | slices 5–7 design | pending |
| Graph-ready stage-runner interface (jinn 7) | slice 6 design | pending |
| CLI-version lockfile checked at boot (ata 9) | slice 2 step 1 (promoted — box auto-updated 207→215 mid-slice) | in build (warn-only, Wes-approved) |
| Assumption ledger (`harn`-shaped) + can-fail regression rule (codor 1) | repo process, pre Vimes-builds-Vimes | pending — **Wes call** (process adoption) |
| Guardrails doc + critical test tier + sandbox-projects-only (ata 11) | repo process | pending — **Wes call** |
| MCP server = thin client of daemon API (ata 10) | design-principles #10 | **ratified 2026-07-20** |
| Risk-register rows: hook payload drift; settings merge-vs-shadow (jinn 9) | docs/risk-register.md (delta model) | **applied** 2026-07-19 |
| Env-inheritance invariant stated on spawn path (codor 7) | spawn-path design | pending |
| Read codor's `adapters-cli-only-no-sdk` rationale (codor 9) | pre-slice-6 | pending |
| Hygiene: exact-address proxy trust (codor 10; fail-closed already shipped) | daemon config | pending |

### AgentSwarms carry-overs (added 2026-07-29 — agentswarms-decompose.md §6)

| Item (source) | Lands in | Status 2026-07-29 |
|---|---|---|
| Checkpoint anatomy as D51's resumability checklist: completed / ruled-out / dead-edge / resume-point / suspended-at — DERIVED from the spine, never stored; verify the taxonomy can distinguish "ruled out" from "not yet reached" (as 2.1) | D51 design pass | **noted** — annotated onto open-questions D51 (the checklist rides with the decision, not reserved as schema: the graph shape isn't designed enough to reserve honestly) |
| Rule: completion is an explicit EVENT, never inferred from output presence/emptiness (as 2.1) | design-principles | **proposed to Wes 2026-07-29** — already true by construction (`report_completion`, D53 outcomes); rule pins it against regression |
| Rule: no tool/API accepts a parameter asserting a decision the daemon should read from the record (as 2.2) | design-principles + every future tool WO | **proposed to Wes 2026-07-29** — already embodied (deriveReviewOutcome, forced fields on create_task); S8·6+ drive verbs are where it would erode |
| Rule: budget/meter gates fail OPEN attended, fail CLOSED unattended — selected by session class (as 2.4, the AgenC synthesis) | dispatch gates / unattended era | **proposed to Wes 2026-07-29** — one branch when unattended operation lands |
| Risk/urgency tier on attention reasons (not permission on gates); low-risk may auto-proceed when unattended (as 2.3/§5.2) | attention model | pending — trigger: unattended operation |
| Explicit convergence bound: max attempts → quarantine, before unattended fix loops (as 2.6; 4th corroboration) | drive-verbs era (S8·7+) | pending — the state machine already reserves the landing (`done`+manual-review) |
| Per-criterion outcome aggregation over the spine (failure rate by criterion/stage/model/author) (as 2.5) | insights read-model | pending — **natural instrument for the Gate-2 pivot criterion** (authored-vs-hand-made rewrite rate) |
| Defensive-skip discipline for model-shaped text VIMES doesn't control (as 2.5) | as encountered | noted |
| ELv2 packaging shape as the commercial-model reference (as §7) | the someday-conversation | noted, zero action |
