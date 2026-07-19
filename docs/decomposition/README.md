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
| D7 spike hooks-first; `-n` demoted (jinn 1) | slice 2 spike | **lean-updated** (D7) |
| Custody trio for terminal-started sessions (codor 2) | slice 2 + D10 | **lean-updated** (D10) |
| JSONL usage dedupe **by `message.id`** (jinn 3) | slice 4/5 usage consumers | **lean-updated** (D17); note: current `usage_block` payload does NOT carry messageId — add before slice 4 |
| Self-owned blob refs for D12 horizon (codor 4) | post-MVP revisit | **noted** (design-directions.md) |
| Stop/StopFailure/PreToolUse relay; StopFailure = usage adapter #4 (jinn 2) | slice 2 → 5 | pending |
| `rate_limit_event` from SDK stream into meters/attention (ata 1) | slice 5 | pending (already observed live on this box in the D4 spike) |
| Auto-resume at reset w/ full staleness matrix; policy by session class (ata 2) | slice 5–6 | pending |
| Turn attribution: injected vs terminal-native (jinn 5) | slices 2–3 attention model | pending |
| Provider preflight + authenticated-not-just-installed (ata 8, jinn 4) | slice 2–3 spawn path | pending |
| Attention reason enum additions: `rate-limited`, `brake`, spawn-failure (jinn 2.2, codor 2.3) | schema reservation (rule 0.5) | pending — **Wes call** |
| One-source-of-record rule: content=tail, lifecycle=hooks/stream, nothing ingested twice (codor 8) | ground-rule/spec note | pending — **Wes call** (constitution territory) |
| MCP surface: process_register/list/stop; briefing-as-tool; heartbeat+bootstrap check-in; reviewer-close structural; `report_completion` typed (ata 3/5/6/7, jinn 8) | slice 6 design | pending |
| Cascade guard + brakes layer (held delivery, one-tap release) (ata 4, codor 3) | slice 7 | pending |
| Per-spawner budget scope; per-worker scoped credentials (jinn 6, codor 6) | slices 5–7 design | pending |
| Graph-ready stage-runner interface (jinn 7) | slice 6 design | pending |
| CLI-version lockfile checked at boot (ata 9) | release discipline | pending |
| Assumption ledger (`harn`-shaped) + can-fail regression rule (codor 1) | repo process, pre Vimes-builds-Vimes | pending — **Wes call** (process adoption) |
| Guardrails doc + critical test tier + sandbox-projects-only (ata 11) | repo process | pending — **Wes call** |
| MCP server = thin client of daemon API, never second store writer (ata 10) | spec note | pending — **Wes call** (rule-shaped) |
| Risk-register rows: hook payload drift; settings merge-vs-shadow (jinn 9) | spec §6 next doc pass | pending |
| Env-inheritance invariant stated on spawn path (codor 7) | spawn-path design | pending |
| Read codor's `adapters-cli-only-no-sdk` rationale (codor 9) | pre-slice-6 | pending |
| Hygiene: exact-address proxy trust (codor 10; fail-closed already shipped) | daemon config | pending |
