# Decomposition series — index & carry-over tracker

Prior-art pattern extraction through the Vimes lens (series opened
2026-07-19), each repo analyzed against the canonical spec/docs. **Nothing in these
documents self-applies** — every item below is applied deliberately, and this
tracker is the ledger of what has and hasn't been.

*Provenance (noted 2026-08-04): the decomps are produced in Wes's web chats
about VIMES — the analyst has current project context, which is why the
targeting is sharp (and why header dates can lag the context they carry).
They are informed prior-art analyses, not independent outside reviews; the
deliberate-application rule above is the compensating control.*

| Doc | Repo | Center of gravity |
|---|---|---|
| [jinn-decompose.md](jinn-decompose.md) | hristo2612/jinn | org-metaphor orchestration; hooks channel; the landmine list |
| [agent-teams-ai-decompose.md](agent-teams-ai-decompose.md) | 777genius/agent-teams-ai | worker-side control protocol; MCP verb families |
| [codor-decompose.md](codor-decompose.md) | rjx18/codor | sibling design; custody trio; assumption ledger; brakes |
| [agenc-core-decompose.md](agenc-core-decompose.md) | agenc-core | admission kernel (fail-closed budgets); deadline propagation |
| [agentswarms-decompose.md](agentswarms-decompose.md) | AgentSwarms-fyi/agentswarms | **checkpoint anatomy** (the resumability checklist); attended/unattended failure-semantics synthesis; quality trends above the verdict |
| [agent-of-empires-decompose.md](agent-of-empires-decompose.md) | agent-of-empires/agent-of-empires | **the closest competitor** (same lane: sessions + mobile PWA + tunnel); ACP as an off-the-shelf capabilities seam; approval nonces; context-reset surfacing; notification debounce; written UI doctrine |
| [herdr-decompose.md](herdr-decompose.md) | herdrdev/herdr | **the working reference for VIMES-as-engine** (shipped manifest-based plugin contract + marketplace); "the existing API *is* the plugin API"; extension trust model; env-gated negatively-triggered agent capability; rule 0.8's strongest external evidence (their screen-scraping manifests) |

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
| Rule: completion is an explicit EVENT, never inferred from output presence/emptiness (as 2.1) | design-principles | **ratified 2026-07-29** → design-principles #12 |
| Rule: no tool/API accepts a parameter asserting a decision the daemon should read from the record (as 2.2) | design-principles + every future tool WO | **ratified 2026-07-29** → design-principles #13; checked in every drive-verb WO |
| Rule: budget/meter gates fail OPEN attended, fail CLOSED unattended — selected by session class (as 2.4, the AgenC synthesis) | dispatch gates / unattended era | **ratified 2026-07-29** → design-principles #14 |
| Risk/urgency tier on attention reasons (not permission on gates); low-risk may auto-proceed when unattended (as 2.3/§5.2) | attention model | pending — trigger: unattended operation |
| Explicit convergence bound: max attempts → quarantine, before unattended fix loops (as 2.6; 4th corroboration) | drive-verbs era (S8·7+) | pending — the state machine already reserves the landing (`done`+manual-review) |
| Per-criterion outcome aggregation over the spine (failure rate by criterion/stage/model/author) (as 2.5) | insights read-model | pending — **natural instrument for the Gate-2 pivot criterion** (authored-vs-hand-made rewrite rate) |
| Defensive-skip discipline for model-shaped text VIMES doesn't control (as 2.5) | as encountered | noted |
| ELv2 packaging shape as the commercial-model reference (as §7) | the someday-conversation | noted, zero action |

### Agent-of-Empires carry-overs (added 2026-07-29 — agent-of-empires-decompose.md §6; Wes-ratified same day)

| Item (source) | Lands in | Status 2026-07-29 |
|---|---|---|
| Context-reset made explicit + visible: spine event when a resume fails to restore model context + a visible marker in the session view (aoe 2.2) | session host | **ratified, pending** — the S8·4a `compaction_observed` recognizer/projection is the exact pattern to follow (this is its sibling event); note the orchestrator's refound notice (S8·5) already surfaces the standing-entity case |
| Notification debounce on status flicker: attention state stays instantaneous in the spine, DELIVERY waits for stability (aoe 2.4, their 100ms default) | attention model / push pipeline | **ratified, pending** — protects push-channel credibility (the operator screenshots these); low effort |
| Stale-action guard on state-advancing UI actions (aoe 2.3, approval nonces) | board API + UI, incrementally | **ratified, reshaped** — the orchestrator's check found VIMES closer than the decomp assumed: `TaskWriter` already reads fresh + refuses departed-stage edges, and `(taskId, stage, attempt, workOrderRev)` already exists. The lift is CAS, not a token system: UI actions CARRY the identity they rendered against; server refuses mismatch. The genuinely-missing half — an anti-synthesis human-proof secret the agent never sees — is designed as part of the S8·6-era grant work (principle 13's mobile-shaped corollary), not standalone |
| Read the ACP spec; decide adopt-vs-private-seam by D-record (aoe 2.1/§5 Q1) | before the stage-runner interface hardens | **ratified → open-questions D62** — explicit input to the slice-9 D51 design pass; research, not a spike |
| Written UI design doctrine doc: principles, type scale, tokens, an explicit "what we avoid" list; names the AoE divergence (their "mobile is monitoring" vs VIMES "mobile is for deciding", pillar 5) (aoe 2.7) | repo `docs/`, before the next substantial agent-built UI unit | **ratified, pending** — a doctrine document (work-order input for UI agents), not a style guide; see the design-directions entry |
| Bounded transport-respawn → park-with-reason, never go silent (aoe 2.5; 5th series appearance of bounded-retry-then-park, first at transport level) | session host | pending — extends the watchdog discipline from stage runs to SDK-stream/PTY death |
| Per-session operational log: LRU-bounded writers, synchronous best-effort writes, re-entrancy guarded (aoe 2.6) | daemon diagnostics | pending — pairs with the `vimes doctor` item (agenc) |
| Device pairing (QR + passphrase) + connected-devices view (aoe 2.8; 3rd appearance of pairing-link) | horizon | deferred — post-MVP, only if VIMES goes beyond one operator |
| **Strategic (§7): the verification loop must be VISIBLE in the UI**, or VIMES gets compared to AoE as a session list — and loses that comparison | UI redesign era | **ratified → design-directions entry** — standing input, not a unit |

### Herdr carry-overs (added 2026-08-04 — herdr-decompose.md §6)

| Item (source) | Lands in | Status 2026-08-04 |
|---|---|---|
| Extension manifest shape modelled on `herdr-plugin.toml`: id/version/`min_vimes_version`, actions (with `contexts`), events (SPINE subscriptions — exact fit), panes, link handlers, build/startup (hd 2.1.6) | slice-9 D51 node-kit design pass | **noted** → design-directions herdr entry; design-pass input alongside D62 ACP read |
| Rule: the daemon's public API (HTTP/WS + MCP) *is* the extension API — no second SDK; first-party consumers dogfood it (hd 2.1.1) | design-principles | **proposed** — awaits Wes ratification (compounds principle 10) |
| Two-tier extension boundary: in-process modules vs external argv processes, and which API each gets (hd §5 Q1) | slice-9 design pass | **opened → D66** (lean: both tiers, deliberately) |
| Per-extension config/state isolation on disk; no cross-extension state access (hd 2.1.5) | engine design | **noted** — makes the already-articulated module-isolation rule concrete |
| Extension trust decision BEFORE third-party extensions: preview-before-install, ref pinning, stated non-sandboxing — priced against the Access-authenticated daemon, not a local tool (hd §5 Q2) | before the authoring method publishes | **opened → D67** (lean: v1 first-party-only; manifest designed so preview/pinning are possible day one) |
| `min_engine_version`-style compatibility floors on DATA artifacts (golden fixtures, work-order schemas, manifests) (hd 2.4) | schema notes | **noted** — adopt at next fixture/schema touch; version-pinning's 4th series appearance, first on data files |
| Skill-file discipline for S8·7+ verb grants: env/context-gated capability, explicit NEGATIVE triggers, defer-to-live-schema over prose (hd 2.3) | every drive-verb work order | pending — S8·6 briefing already enumerates exact names; negative triggers + pointer docs are the upgrades |
| Keyboard-first navigation for board/session list alongside pointer/touch (hd 2.5) | UI doctrine doc | **noted** — doctrine doc already ratified-pending (AoE pass); this is an input to it |
| Dated/versioned data-driven classifier WITH explain output, IF external-surface drift gets hairy (hd 2.2, the narrow lift) | as encountered (CLI-version drift) | noted — the shape to reach for, not a unit |
| Marketplace goods = work-order templates, criteria libraries, review rubrics (the verification layer as the sellable artifact) (hd §5 Q3) | the someday-conversation | noted, zero action (pairs with agentswarms' ELv2 row) |
