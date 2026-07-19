# Decomposition: rjx18/codor → Vimes
**Date:** 2026-07-19 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/rjx18/codor (alpha, actively developed)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes docs in this repo. Companion to `jinn-decompose.md` and `agent-teams-ai-decompose.md`; cross-corroborations flagged. Nothing here self-applies.

---

## 1. Landscape

Codor is "one channel, every agent on the wire": a per-machine daemon (**switchboard**) hosting channels where humans and agent sessions (Claude Code, Codex, Gemini, Copilot, OpenCode) converse and work, with a mention router, per-member FIFO delivery inboxes, roles (`admin`/`owner` matrix, single-operator default), remote access via Tailscale, a content-blind E2E push relay, and an adapter layer over harness CLIs. Alpha.

**Why it matters to Vimes:** it is the closest thing to a *sibling design* in the entire decomp series — single Node/TS daemon, SQLite via better-sqlite3, sessions-durable-processes-cattle, pure-function router as "unit-test heaven," an event journal, systemd user service. Near-identical bones make its **deliberate divergences** the most informative signal yet (§5), and it contributes three things the other repos didn't: a complete custody model for terminal-started sessions (D10's answer), a hold-and-release "brakes" philosophy for agent chains, and — the find of the series — a mechanized assumption ledger (`harn`) that is the Vimes documentation culture turned into tooling.

## 2. Patterns worth lifting

### 2.1 The `harn` assumption ledger — the Vimes doc culture, mechanized
**Where:** `.harn/assumptions/*.yaml`, `.harn/plans/*.yaml`, `harn:assume <id> ref=<anchor>` markers embedded in README/docs, `.harnignore`.

Each assumption is a YAML record: `id`, content `hash`, `title`, `state`, a dense `statement` carrying the invariant *and* the causal reasoning *and* (where applicable) the finding story that created it, a `depends_on` graph to other assumptions, and `created_by` linking to the plan that introduced it. Plans create assumptions and demand regressions **that are able to fail** — one plan (`a1-card-crush`) is a masterclass: it records a UI invariant, the CSS mechanism of the observed failure, the operator-reported finding (F10) that motivated it, and the requirement that the regression fixture must overflow the viewport *because a fixture that cannot shrink anything produces a test that can never fail*. Doc prose is then bound to the ledger with `harn:assume` markers, so claims in README/docs cite assumption IDs.

**Vimes adaptation (process, high value):** this is rule 0.1 findings + the risk register's verify column + the invariant list, unified into one dependency-graphed, doc-linked ledger that *agents* can read, cite, and extend — which is exactly what the Vimes-builds-Vimes workflow needs. Concretely: an `assumptions/` ledger in the Vimes repo (same YAML shape), findings recorded as ledger entries with their story, `depends_on` between assumptions, doc markers binding spec claims to entries, and the plan rule that every new assumption ships with a regression demonstrated to be *capable of failing*. This composes with (does not replace) the scenario harness: the ledger is the why-graph; the harness is the enforcement. Their assumption titles alone are a curriculum — `a-permission-change-is-never-silent`, `adoption-explicit-or-sessionend`, `agent-chains-uninterrupted-by-default`, `a-session-carries-the-environment-its-children-need`.

### 2.2 The custody trio — D10's complete mechanism
**Where:** `docs/JOIN.md`, `adoption-explicit-or-sessionend.yaml`.

- **`join`** registers a live terminal session as a *mirrored* member: the TUI keeps custody, **the daemon never writes to that session**, and inbound deliveries queue in the member's FIFO.
- **`adopt`** transfers custody explicitly — or, for Claude Code, the **`SessionEnd` hook is the authoritative automatic adoption point**: TUI exits → hook fires → daemon adopts and **drains the queued FIFO**.
- Detection for `join` uses the session's own environment first (`CLAUDE_SESSION_ID`), then newest-session-file fallback — which enables the neat trick that **the agent can register itself** (the human asks the agent to run the join command; the env var is in its shell).

**Vimes adaptation:** this is D10's "read-only-live + adopt on next resume" leaning, upgraded with mechanism: mirrored-while-foreign (JSONL tail gives Vimes the read-only-live view already), queued deliveries while custody is external, SessionEnd as the sanctioned custody-transfer trigger (slots into the hooks channel from the Jinn decomposition), FIFO drain on adoption, and env-based self-registration as a bonus correlation path. Resolve D10 with this shape.

### 2.3 Brakes: hold-and-release, not error — and "operators kill, software doesn't"
**Where:** `docs/PROTOCOL.md` §Visibility and optional brakes.

Their stance: *"agent→agent chains are the product, not a hazard — the switchboard never interrupts them out of the box."* What ships instead: an always-on, never-blocking **spend meter** in the channel header; an opt-in **turn brake** (max consecutive agent→agent deliveries with no human-authored message — on breach the next delivery is **held**, a system message lands, and the human gets a push: *"paused after N hops — release?"*); an opt-in **spend brake** (same hold semantics at a daily cost threshold); and an always-on **stall flag** that marks a run stalled after N quiet minutes but never kills it — *operators kill, software doesn't.*

**Vimes adaptation:** this layers cleanly on the ATA cascade guard rather than replacing it — hard deterministic limits (chain depth, rate windows) as the outer wall, *brakes as soft checkpoints* inside it: held delivery + `needsAttention: brake` + one-tap release from the phone, which is about as Vimes-shaped as a feature gets (pillar 5 meets pillar 4). The stall-flag stance also sharpens the watchdog wording: the dispatcher retries/quarantines *stage runs*; software never kills a *session*.

### 2.4 Self-owned event blobs — the D12 alternative worth recording
**Where:** `docs/ARCHITECTURE.md` — hot state (rooms, members, messages, per-member deliveries, budgets) in SQLite; **run event streams as JSONL blobs on disk under the daemon's own data dir**, referenced by `events_ref`; "the DB stays small and the 'one message per run' rule is structural."

D12 chose inline bodies partly because *transcript-ref* storage would chain replay to Anthropic's files (rule 0.6 refuses). Codor shows the third option finding C didn't weigh: refs to **self-owned** blobs the daemon writes itself — replay stays self-contained, rule 0.6 is satisfied, and the DB stays small. Not a reason to reopen D12 now; it *is* the shape the post-MVP archival/compaction revisit should evaluate first, so record it against D12's horizon note.

### 2.5 Adapter interface with a capabilities matrix — a cleaner frame for the dual channel
**Where:** `docs/ARCHITECTURE.md` — `HarnessAdapter` with `spawn / attach / deliver / respondInteraction / interrupt / discoverSessions` and declared `capabilities: {resume, discover, interactiveAttach, ask, approvals: 'runtime'|'spawn-time', …}`; adapters without `resume` are surfaced as one-shot-only.

Vimes is Claude-native but still has two channels (SDK, PTY) plus adopted-foreign sessions. Declaring each as a capability profile behind one interface — rather than if/else on channel type — formalizes the §3.2 table, makes "this session can't do X" a surfaced property instead of a runtime surprise, and gives `respondInteraction(interaction_id, answer)` **resolving on the agent's ack** as the gate-answer API contract. Design-time lift for the session host.

### 2.6 Per-member credentials and narrow authority
**Where:** assumption titles `agent-member-credentials-are-defense-in-depth`, `agent-member-credentials-stay-secret`, `agent-network-authority-is-narrow`.

Each agent member gets its own scoped credential rather than sharing one daemon secret. For Vimes: per-worker scoped tokens on the MCP surface and hook relay (upgrading Jinn's single shared relay secret), so a leaked worker credential is one revocation, not a master-key rotation — defense-in-depth behind the Access wall from finding A. Slice 6–7 design note.

### 2.7 Environment inheritance as a recorded assumption
**Where:** `a-session-carries-the-environment-its-children-need.yaml`, `adapter-children-inherit-session-env.yaml`.

They record, as first-class assumptions, that spawned sessions carry the env their children need and that adapter children inherit it. Vimes already depends on exactly this in two places (the pinned `OTEL_EXPORTER_OTLP_PROTOCOL` from the stack doc; the hook-relay wiring from the Jinn decomposition) without stating it as an invariant. State it — one line in the spawn-path design, one ledger entry once 2.1 exists.

## 3. Patterns to skip (with reasons)

- **The E2E push relay** (content-blind forwarder, sealed payloads, Ed25519 sender allowlist, fail-closed startup): solves *their* problem — community/multi-tenant push through an untrusted hop. Vimes pushes direct from daemon to browser push service over its own tunnel; no relay hop exists. Two hygiene notes travel anyway: fail-closed startup when auth material is absent, and exact-address `TRUST_PROXY` discipline (never trust arbitrary forwarded addresses).
- **Multi-harness adapter registry** — fourth corroboration of the multi-provider bill; the registry-validation assumption is thoughtful, and still out of scope.
- **Channels/mention-router/roles as product surface** — Vimes's social model is one human + workers + an orchestrator, not a chat org. The router-as-pure-function *discipline* is already Vimes rule 0.3; the product surface isn't needed.
- **Tailscale + pairing-link onboarding** — their answer to remote access; Vimes settled cloudflared + Access (finding A). The one-time pairing-link UX is a pleasant device-onboarding idea if Vimes ever grows device management; not now.
- **Multi-box federation** (home-switchboard-per-channel, hyperswarm DHT tier) — maps to the existing "multi-machine session hosts" horizon line; nothing to do before then.

## 4. Feature gap analysis

| Feature | In Codor as | Vimes priority | Notes |
|---|---|---|---|
| Assumption ledger w/ doc bindings + can-fail regression rule | `.harn/` + doc markers | **High (process)** | The Vimes-builds-Vimes workflow's missing artifact |
| Custody trio: join/adopt/SessionEnd + FIFO drain | JOIN.md + hooks | **High** | Resolves D10 with mechanism; slots into hooks channel |
| Brakes: held delivery + push + one-tap release | PROTOCOL brakes | Medium-high | Layers on ATA cascade guard; `needsAttention: brake` |
| Self-owned event blob refs | events_ref architecture | Note on D12 | First option for the post-MVP growth revisit |
| Capabilities-declared adapter interface; `respondInteraction` resolving on ack | HarnessAdapter | Medium (design) | Formalizes the SDK/PTY/adopted trichotomy |
| Per-member scoped credentials | assumption ledger | Medium | Upgrades the shared relay secret; slice 6–7 |
| Env-inheritance as stated invariant | assumption ledger | Trivial | Vimes already depends on it unstated |
| Stall-flag wording: software never kills sessions | PROTOCOL | Trivial | Sharpens watchdog scope language |
| Agent self-registration via session env | JOIN.md | Low | Bonus D7-adjacent path; nice for adopted sessions |

## 5. Open questions — the two deliberate divergences of a sibling design

1. **Hooks-only vs tail-as-truth.** Codor is explicit: *"Do not also tail Claude transcripts: the Stop hook is the single authoritative source."* Vimes holds the opposite (tail = content truth; hooks = lifecycle push). Both are defensible; the danger is only in being accidentally *both*. The Vimes rule to write down: **every fact has exactly one source-of-record** — content facts from the tail, lifecycle facts from hooks/stream, and nothing ingested twice. If the dual-source dedup ever gets hairy in practice, Codor is the evidence the single-source design works.
2. **`adapters-cli-only-no-sdk`.** Their ledger records a deliberate CLI-only, no-SDK stance for adapters (while an older architecture doc still says SDK `query()` — the ledger evidently superseded it). Rationale not established in this pass — could be multi-harness symmetry, dependency weight, stability, or billing. Vimes's SDK-first choice was made with eyes open (D4 spike, dual-channel fallback), so no action — but this is a sibling design walking away from the SDK, and worth one look at their reasoning (ledger `statement` + linked plan) before slice 6 leans harder on SDK streaming-input. Cheap to check, cheap to ignore.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Stand up an assumption ledger in the Vimes repo (YAML shape from 2.1: id/title/statement-with-why/depends_on/created_by), bind spec claims with doc markers, adopt the "regression must be able to fail" plan rule | moderate (process) | repo, before Vimes-builds-Vimes |
| 2 | Resolve D10 with the custody trio: mirrored join (tail-based), queued deliveries while custody is external, SessionEnd-hook adoption + drain, explicit adopt action | low–moderate | slice 2 (hooks) + D10 record |
| 3 | Add the brakes layer over the cascade guard: opt-in turn/spend brakes with held-delivery + `needsAttention: brake` + one-tap release; always-on spend meter in channel/task header | moderate | slice 7 |
| 4 | Record self-owned-blob refs as the first option for D12's post-MVP growth revisit | trivial | D12 horizon note |
| 5 | Reframe the session-host channel table as a capabilities-declared adapter interface; adopt `respondInteraction`-resolves-on-ack as the gate-answer contract | low (design) | slice 1–2 design |
| 6 | Per-worker scoped credentials on MCP surface + hook relay (replaces single shared secret) | low | slice 6–7 |
| 7 | State the env-inheritance invariant on the spawn path (OTLP pin + hook relay already depend on it) | trivial | spawn-path design |
| 8 | Write the one-source-of-record rule for the dual-channel event pipeline (content=tail, lifecycle=hooks/stream; nothing ingested twice) | trivial (rule) | spec note, next doc pass |
| 9 | Read Codor's `adapters-cli-only-no-sdk` rationale before slice 6 leans on SDK streaming-input | trivial | pre-slice-6 |
| 10 | Hygiene: fail-closed startup when auth material absent; exact-address proxy trust only | trivial | daemon config |

---
*End of decomposition. Cross-corroborations across the series: per-spawner budgets now appear in all three orchestrators (Jinn budgets, ATA meters, Codor `budgets` table); reviewer/approval gating in all three; structured-signals-over-prose in all three; multi-provider cost validated a fourth time. New here and nowhere else: the assumption ledger, the custody trio, hold-and-release brakes. Four-repo convergence on Vimes's bones — daemon-owned sessions, event journal, pure-function core — is the strongest validation the series has produced.*
