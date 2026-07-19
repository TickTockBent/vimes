# Decomposition: 777genius/agent-teams-ai → Vimes
**Date:** 2026-07-19 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/777genius/agent-teams-ai (v2.7.x, Electron desktop app, ~3,800 files)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns here are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes design spec and stack doc in this repo. Companion to `jinn-decompose.md`; cross-corroborations between the two are flagged. Nothing here self-applies.

---

## 1. Landscape

Agent Teams AI is a free Electron desktop app that runs teams of AI agents (Claude Code, Codex, OpenCode, Cursor, Copilot, and others) against projects: a lead agent plus members, a kanban task board, reviewer-gated task closure, execution logs with tool-call rendering, hunk-level code review, and cross-team messaging. Sessions run over the CLI stream-json protocol (`user | assistant | control_request | rate_limit_event | result | system` event types) with node-pty and tmux in the terminal layer. Coordination state lives in file-based stores with atomic writes and file locks, exposed to agents through an MCP server backed by a shared controller library.

**Why it matters to Vimes:** it overlaps slices 4 and 6–7 (review flow, kanban, worker MCP surface) from a different angle than Jinn — where Jinn's center of gravity is the org metaphor and workflow engine, this project's is the **worker-side control protocol**: how agents phone home, register processes, request review, and get context. It is also a live specimen of the meta-workflow Vimes is building toward, since the repo is developed *by* agent teams under an explicit guardrails doctrine.

## 2. Patterns worth lifting

### 2.1 `rate_limit_event` as a first-class stream type — corroborates and completes the rate-limit picture
**Where:** `src/main/services/team/provisioning/TeamProvisioningStreamEvents.ts` — `HANDLED_STREAM_JSON_TYPES` includes `rate_limit_event` and `control_request` alongside messages and results.

The CLI's stream-json output (the surface the Agent SDK wraps) emits structured rate-limit events mid-stream. Combined with the Jinn finding (StopFailure hook with reason enum + `resetsAt`), Vimes now has sanctioned structured rate-limit signals on **both channels**: SDK-hosted sessions get `rate_limit_event` in the stream; PTY-hosted sessions get `StopFailure` via hooks. The usage service (slice 5) should consume both into the same meter/attention pathway. `control_request` in the same set is the structured permission-gate surface — confirmation that gate detection on SDK sessions never needs inference.

### 2.2 AutoResumeService — `deferUntilReset` made reactive, with the staleness matrix that makes it safe
**Where:** `src/main/services/team/AutoResumeService.ts`.

On a rate-limit event they parse the reset time and schedule a resume nudge. The timer is trivial; **the guard list is the hard-won part**:

- a newer rate-limit event supersedes a pending timer (never stack timers)
- parsed reset times are sanity-capped (a ceiling rejects absurd values)
- a reset time already in the past falls back to a small buffered delay
- at fire time: re-check the enabling config flag, re-check the session is still alive, and **re-check the session hasn't advanced past the run that hit the limit** — a stale nudge to a session that moved on is skipped

**Vimes adaptation:** this is the reactive twin of the dispatcher's planned `deferUntilReset` gate, and it applies to interactive sessions too. Policy split by session class (see §5 Q3): task workers auto-resume silently at reset; interactive sessions set `needsAttention` instead. Implement the full staleness matrix — every guard above maps onto a Vimes concept (event supersession, injected clock sanity, liveness check, run-identity check against the registry).

### 2.3 `process_register` / `process_list` / `process_stop` — agent-spawned processes become platform-owned
**Where:** `mcp-server/src/tools/processTools.ts`, `agent-teams-controller/src/internal/processes.ts`.

Agents register long-running processes they start (dev servers, watchers) with the platform, which can list and stop them. **This extends I4's orphan philosophy to the processes *workers* spawn** — without it, the first task that starts a dev server creates an orphan the session host doesn't know it owns. Add to the slice 6 MCP surface and widen the orphan scan's scope to registered agent processes. Cheap, and it closes a real hole in the ownership model.

### 2.4 Cascade guard — loop prevention for inter-agent messaging
**Where:** `agent-teams-controller/src/internal/cascadeGuard.js` — per-team send-rate window (max 10/min), per-pair cooldown (3 s), and **max chain depth 5** on chained sends, enforced deterministically with hard errors.

The failure mode this prevents (two agents amplifying each other into a message storm, or delegation chains that never bottom out) is one the Vimes orchestration layer will meet the first time agents can message agents. The chain-depth cap on delegation is the key primitive; the rate window and pair cooldown are one small deterministic module in the dispatcher/MCP layer. Fits rule 0.3 exactly: the guard is harness-testable code, not agent judgment.

### 2.5 The worker-side MCP catalog — three verb families Vimes hasn't specced
**Where:** `mcp-server/src/tools/*` + `agent-teams-controller/src/mcpToolCatalog.js`. Beyond the task CRUD Vimes already plans:

- **Briefing tools** (`task_briefing`, `lead_briefing`, `member_briefing`): context is *pulled by the worker via tool call*, not stuffed into the spawn prompt. Two Vimes wins: workers fetch current context at start-of-work (always fresh, no stale prompt baking), and — the subtle one — **pull-context keeps spawn prefixes byte-identical across workers, which is precisely the prefix discipline the cross-agent cache-sharing design requires.** Briefing-as-tool and cache economics point the same direction.
- **Runtime lifecycle tools** (`runtime_heartbeat`, `runtime_task_event`, `runtime_bootstrap_checkin`): the worker phones home explicitly. An explicit heartbeat tool call is a stronger watchdog signal than transcript-silence inference (and complements hooks); a bootstrap check-in makes "worker actually started and oriented" an observed event instead of an assumption.
- **Review tools** (`review_request`, `review_start`, `review_approve`, `review_request_changes`, `kanban_add_reviewer`): reviewer-close enforced *by the tool surface itself* — the producer has no close verb. Corroborates Jinn's Todos ledger and the Vimes review stage; the lift is making the state machine's "reviewer closes, producer cannot" rule structural in the MCP catalog rather than doctrinal.
- **Work-sync tools** (`member_work_sync_report`, `member_work_sync_status`): structured status reports as tool calls — corroborates the `report_completion` design from the Jinn decomposition (item 8 there). Two independent projects landed on "status via typed tool call"; Jinn's regex-parsing of prose is the road not to take, and this repo shows the alternative shipped.

### 2.6 Provider preflight + doctor probes
**Where:** `src/main/services/team/ClaudeDoctorProbe.ts`, `TeamProvisioningProviderPreflight.ts`; their debugging doctrine names launch hangs as the top failure class.

Health-check the provider *before* launch: binary present, authenticated, version known, responsive. Extends Jinn's "`--version` ≠ signed in" gotcha into a proper preflight stage on the Vimes spawn path: preflight failure surfaces as a structured spawn-failure reason (and an attention event) instead of a mystery hang. Their guardrails doc treats launch-hang debugging as first-class doctrine — evidence this failure class is common enough to deserve the stage.

### 2.7 Runtime lockfile — version-gating made into an artifact
**Where:** `runtime.lock.json`, `terminal-platform.lock.json` — pinned runtime versions with per-platform assets, checked at boot.

The Vimes release discipline already says "a fixture refresh accompanies every Claude Code version bump; Node bumps gated identically." This repo makes that a *checked artifact*: a lockfile the daemon reads at boot, warning (or gating spawns) on drift between the pinned CLI version and what's on PATH, with the golden-fixture set keyed to the pinned version. Trivial to add; turns a discipline into a mechanism.

### 2.8 Meta-pattern: the operating doctrine for a repo built by agents
**Where:** `AGENT_CRITICAL_GUARDRAILS.md`, `vitest.critical.config.ts`, `docs/FEATURE_ARCHITECTURE_STANDARD.md`, `docs/team-management/debugging-agent-teams.md`.

This repo is developed by the workflow Vimes is being built to host, and its process artifacts are directly liftable for the Vimes repo itself:
- a **guardrails doc** of hard rules agents read first (notably: *never test agent features against real user projects — sandbox projects only*, a rule that becomes load-bearing the day Vimes-building-Vimes workers start spawning sessions);
- a **critical test tier** (separate vitest config) — a fast, always-run invariant suite distinct from the full scenario suite, the natural per-agent-commit gate with full scenarios at slice boundaries;
- named doctrine docs for the top failure classes (their launch-hang doc), which is the Jinn "doctrine" idea (jinn-decompose §2.7) applied to debugging.

## 3. Patterns to skip (with reasons)

### 3.1 File-based stores with lock files — and the architectural rule it teaches
Their controller persists kanban/tasks/messages/processes as JSON files with atomic writes, file locks, and a board lock — because their MCP server runs as a **separate process** from the app and needs shared mutable state. Vimes must not import this: the SQLite spine with I13 ordering is strictly stronger. **The transferable rule:** the slice-7 MCP server must be a *thin client of the daemon's API*, never a second writer to the store. Two writers is how you end up needing file locks. (Applies equally to anything lifted from Jinn.)

### 3.2 Electron packaging & desktop distribution
Their whole delivery model (dmg/exe installers, auto-update, tmux installer feature). Vimes is PWA-first behind a tunnel by design; none of this transfers, and the Tauri question stays post-MVP per the stack doc.

### 3.3 Multi-provider layer (third corroboration)
Provider preflights, per-provider hydration quirks (e.g. Gemini post-launch hydration state), per-provider stream adapters. Same itemized bill Jinn paid; the Claude-native decision is now triple-validated.

### 3.4 Vendored custom runtime binary
They ship a patched orchestrator binary (`claude-multimodel`) from a separate repo as platform-specific release tarballs. An opaque vendored binary in the agent-execution path is the opposite of the observed-truth posture (rule 0.7) — and, flagged without quality judgment, a pattern any adopter should weigh as a supply-chain consideration. Vimes drives the official CLI/SDK only.

### 3.5 Team hierarchy & cross-team federation
Lead/member roles, cross-team send/outbox protocols. Beyond single-instance Vimes scope; only the cascade-guard primitives (2.4) survive the crossing. The `agent-graph` package is likewise a canvas *visualization* of the org, not an execution engine — post-MVP eye candy at most.

## 4. Feature gap analysis

| Feature | In ATA as | Vimes priority | Notes |
|---|---|---|---|
| Structured rate-limit on the SDK channel | `rate_limit_event` stream type | **High** | Pairs with Jinn's StopFailure for PTY; both feed one meter/attention path |
| Auto-resume at reset w/ staleness matrix | AutoResumeService | **High** | Reactive twin of `deferUntilReset`; policy split by session class |
| Agent-spawned process registry | process_* MCP tools | **High** | Closes an I4 ownership hole slice 6 would otherwise open |
| Briefing-as-tool context delivery | *_briefing tools | Medium | Also serves prefix discipline / cache sharing |
| Explicit heartbeat + bootstrap check-in tools | runtime_* tools | Medium | Stronger watchdog signal than transcript silence |
| Reviewer-close enforced by tool surface | review_* tools | Medium | Make the doctrine structural in the MCP catalog |
| Cascade guard (chain depth, rate, cooldown) | cascadeGuard | Medium | Before agents can message agents (slice 7) |
| Provider preflight stage | doctor probes | Medium | Structured spawn-failure reasons vs mystery hangs |
| Runtime version lockfile | runtime.lock.json | Low | Mechanizes an existing release rule |
| Guardrails doc + critical test tier | repo meta | Low (process) | For the Vimes repo's own agent workflow |

## 5. Open questions

1. **Watchdog signal hierarchy.** Three liveness signals now exist: explicit heartbeat tool call (this repo), hooks (Jinn), transcript silence (current design). Proposed precedence for workers: heartbeat > hooks > silence, with silence retained as the outermost net. Decide in slice 6 design.
2. **Briefing-as-tool vs prompt-baked context.** Pull-context wins on freshness and cache-prefix stability, but adds a first-tool-call dependency to every worker start (a worker that never calls its briefing works blind). Likely answer: spawn prompt carries only the pointer + obligation to call `task_briefing`; the bootstrap check-in (2.5) verifies it happened.
3. **Rate-limit policy by session class.** Auto-resume silently (workers) vs `needsAttention: rate-limited` (interactive) vs both (notify *and* schedule). Interacts with the attention reason enum (Jinn decomp already proposed adding `rate-limited`).

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Consume `rate_limit_event` from the SDK stream into the usage service + attention model (pair with Jinn item 2's StopFailure) | low | slice 5 |
| 2 | Implement scheduled auto-resume with the full staleness matrix (supersession, sanity cap, liveness + run-identity re-check at fire time); policy split by session class | moderate | slice 5–6 |
| 3 | Add `process_register/list/stop` to the worker MCP surface; widen orphan scan to registered agent processes | low | slice 6 |
| 4 | Add cascade guard (chain-depth cap, per-sender rate window, pair cooldown) to the dispatcher/MCP messaging layer | low | slice 7 |
| 5 | Design briefing-as-tool context delivery; spawn prompt carries pointer only (serves cache prefix discipline) | low | slice 6 design |
| 6 | Add `runtime_heartbeat` + bootstrap check-in tools; set watchdog signal precedence (heartbeat > hooks > silence) | low | slice 6 |
| 7 | Make reviewer-close structural: producer's MCP surface has no close verb | trivial | slice 6 MCP catalog |
| 8 | Add provider preflight stage to the spawn path with structured failure reasons | low | slice 2–3 spawn path |
| 9 | Add a CLI-version lockfile checked at daemon boot; key golden fixtures to it | trivial | release discipline |
| 10 | **Architectural rule from 3.1:** slice-7 MCP server is a thin client of the daemon API — never a second store writer | trivial (rule) | spec note, next doc pass |
| 11 | Adopt the repo-meta artifacts for Vimes's own agent workflow: guardrails doc, critical always-run invariant tier, sandbox-projects-only rule | low (process) | repo, ongoing |

---
*End of decomposition. Cross-corroborations with `jinn-decompose.md`: reviewer-close (2.5↔Jinn 2.4), structured status reporting (2.5↔Jinn item 8), sanctioned rate-limit signals (2.1↔Jinn 2.2), version-gating discipline (2.7↔Jinn landmines). Independent convergence across three projects is the strongest evidence class this research method produces.*
