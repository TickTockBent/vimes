# Decomposition: hristo2612/jinn → Vimes
**Date:** 2026-07-19 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/hristo2612/jinn (beta, actively developed)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns here are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes design spec and stack doc in this repo. Nothing in this document amends those docs by itself; each carry-over item below must be applied deliberately.

---

## 1. Landscape

Jinn is "run your AI agents as a company": multi-engine orchestration (Claude Code, Codex, Grok, Hermes, Pi) with YAML employee personas in a reporting hierarchy, a durable Todo ledger with reviewer-close, a graph workflow engine (sequential/conditional/parallel/switch, per-phase engine/model/effort, first-class human approvals, idempotent runs with durable history), triggers (cron, webhook, poll, todo-status), and an MCP surface through which agents operate the org ("bus, not brain" — Jinn adds no AI logic of its own). Beta; the engines layer alone is ~7,900 lines.

**Why it matters to Vimes:** it is a shipped implementation of roughly slices 6–7 (task system + orchestration), and it **independently converged on the Vimes foundation** — node-pty process ownership, JSONL transcript tailing for structure, JSONL usage accounting — which is meaningful validation of the session-host architecture. It then solved three problems Vimes has not yet hit (hooks channel, turn attribution, structured rate-limit failure signals) and paid visible costs for two decisions Vimes declined (multi-engine abstraction, prose-heuristic delegation control).

## 2. Patterns worth lifting

### 2.1 Claude Code hooks as the structured event channel for PTY sessions — likely D7 kill
**Where:** `shared/claude-settings.ts`, `~/.jinn/hook-relay.mjs` (written once at boot), `gateway/hook-endpoint.ts`, `gateway/hook-registry.ts`.

Jinn registers five hooks via a **per-session settings file** passed at spawn, each pointing at a relay script that POSTs the payload to the gateway with a shared secret:

```ts
// shape, not code — from claude-settings.ts / hook-registry.ts
hooks: Record<"SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse", HookMatcher[]>
// hook payload: { hook_event_name, session_id, ... }
// StopFailure reason enum: rate_limit | authentication_failed | billing_error |
//                          invalid_request | server_error | max_output_tokens | unknown
```

**Vimes consequences:**
- **PTY sessions gain official, push-delivered, structured lifecycle events** (turn complete, turn failed, tool about to run, session started) with zero parsing — consistent with rule 0.8, complementary to the JSONL tail (hooks = low-latency lifecycle push; tail = full message content).
- **D7 (PTY↔JSONL correlation) likely resolves here:** the settings file is written per-session *before* spawn, so the relay command can carry `appSessionId`; the `SessionStart` payload carries Claude's session ID. That is a deterministic correlation. **Redesign the D7 spike hooks-first; `claude -n` name-record matching demotes to fallback.**
- Hook registration is a fragile-adapter surface under rule 0.6: settings-file schema and hook payload shapes drift with CLI versions → risk-register row, golden fixtures for payloads.

### 2.2 StopFailure as a sanctioned rate-limit signal — usage adapter #4
**Where:** `gateway/hook-registry.ts`, `shared/types.ts` (`EngineRateLimitInfo`), `shared/claude-settings.ts` comment: *"StopFailure fires INSTEAD of Stop when an API error ends the turn (rate_limit, …) — structured rate-limit signal, so it must be registered alongside Stop."*

```ts
// shape, not code
interface EngineRateLimitInfo {
  status?: string; resetsAt?: number;        // unix seconds
  rateLimitType?: string; overageStatus?: string;
  overageDisabledReason?: string; isUsingOverage?: boolean;
}
```

**Vimes consequence:** per-session, structured, per-event rate-limit truth (including reset timestamps and overage state) delivered through an official surface — more sanctioned than the unofficial `/usage` endpoint probe (D8). Add as a fourth usage-service adapter feeding the same meter model; also feeds the attention model (`needsAttention: rate-limited` is a reason the current enum lacks — consider adding).

### 2.3 Unclaimed-turn fallback → turn attribution for the attention model
**Where:** `gateway/hook-registry.ts` — a fallback consumer with per-session debounce for *"Stop hooks no turn ever claims (PTY-native turns typed straight into the xterm view…)."*

Jinn explicitly distinguishes platform-injected turns from turns the human typed directly into the terminal. **Vimes has the identical dual-input reality on PTY sessions, and the attention model needs the distinction:** a turn you typed yourself into xterm must not set `needsAttention` and push-buzz the phone in your other hand. Design turn attribution (injected vs terminal-native) into slices 2–3; it interacts with I5's "set only by defined structured events."

### 2.4 Delegation completion contract — lift the structure, replace the heuristics
**Where:** `sessions/delegation-completion-contract.ts`. Their own header comment concedes the classification is regex heuristics over the worker's prose (`/final report|completed|ready for review/` vs "still working on" vs "need your input"), fail-safe-biased, and that *"the real contract is structural: delegation provenance, an atomic once-per-idle claim, and startup recovery for orphaned claims."*

**Vimes adaptation:** keep the structural triad (provenance binding worker↔task, atomic once-per-idle claim before any nudge, orphaned-claim recovery on daemon restart) in the slice 6 dispatcher — and make the classification structural instead of textual: workers file completion via a **`report_completion` MCP tool with a typed payload**; prose never decides anything. Dispatcher rule: *idle without a filed report = stale*, composing with the existing watchdog. This is the disease-avoidance version of their symptom treatment.

### 2.5 Per-spawner budget scope
**Where:** `gateway/budgets.ts` — sum of session costs per employee since month start vs a YAML limit → `ok | warning | exceeded | paused`.

The mechanism is trivial; the **dimension** is the lift: budgets scoped to the *spawning identity*, not only global meters. For Vimes: one added scope on the meter/gate model — e.g. "orchestrator X may consume ≤ N% of the 5-hour window per day" — which is the natural containment now that D4 resolved interactive (everything Vimes spawns competes in one pool) and the orchestration layer is intended to spider across all active projects. Feeds I10's gate checks unchanged.

### 2.6 Graph-ready stages (design-time only)
**Where:** `workflows/` — reusable graph procedures: sequential/conditional/parallel/switch paths, **per-phase engine/model/effort/prompt overrides**, human approvals as first-class gates inside a run, idempotent runs with evidence and durable history; triggers bind cron/webhook/poll/todo-status to procedures.

**Vimes adaptation:** do *not* build a graph engine in slice 6. Do shape the stage-runner interface so each stage is a node carrying its own model/effort params, making the linear pipeline a degenerate graph — a few interface decisions now vs a rework later. Their todo-status triggers ≈ the Vimes dispatcher already; webhook/poll triggers are the post-MVP trigger shape.

### 2.7 Doctrine migration via composed prompt
**Where:** `jinn migrate` + `migrations/` — upgrades compose a migration prompt that the org's top agent applies, merging new operating doctrine into the instance **without overwriting personal customizations**.

Novel pattern: versioned *prompt-doctrine* migrations applied by an agent rather than file overwrites. Relevant to the Vimes orchestration layer's ops story once orchestrator doctrine/conventions span multiple projects and evolve. Low priority; file the idea.

### 2.8 Free landmines (documented by someone else's pain)
- **`appendSystemPrompt` settings-file KEY is ignored by claude CLI ≥ 2.1.x** — only the `--append-system-prompt` *flag* lands in the request system prompt. (Their comment in `engines/claude-interactive.ts`.)
- **`--effort high` emits two assistant JSONL lines per response with the same `message.id` and identical usage.** Any JSONL usage accounting **must dedupe by `message.id`** or double-count tokens. Apply to the Vimes usage adapter *now*, before it skews meter data. (Their `sumTranscriptUsage` carries a "Phase 0 finding" comment on exactly this.)
- **"`--version` ≠ signed in"** — their top fresh-install gotcha. Setup/first-spawn should verify the CLI is *authenticated*, not merely present.
- **Sub-agent API concurrency can corrupt pooled TLS sockets** ("bad record mac"/EPROTO under fan-out) — only relevant if Vimes ever proxies API traffic (see 3.1), but a useful data point on that path's cost.

## 3. Patterns to skip (with reasons)

### 3.1 The SSE MITM proxy — cleverest thing in the repo, still skip
**Where:** `engines/sse-pty-proxy.ts`. A local proxy in front of `api.anthropic.com`; a gateway-owned sentinel (an HTML comment, `<!-- jinn-main-agent:… -->`) is injected via `--append-system-prompt`; the proxy **tees only sentinel-carrying request streams** (Task sub-agents carry Claude Code's own system prompt, no sentinel → suppressed), yielding live token-level streaming from an interactive PTY session plus a ground-truth busy/idle signal from in-flight upstream request counts.

**Skip because it inverts the observe-only posture:** it sits *in the request path* — proxy hiccup = broken sessions — and the file itself is the receipt for the tax (keep-alive pool to fix TLS corruption under sub-agent fan-out, retry-once-on-fresh-socket logic, hour-long idle reapers). Hooks (2.1) deliver most of the same signals out-of-band; the JSONL tail delivers content; xterm delivers the visual stream. **Lift only the principle:** own your one classification signal (a gateway-controlled marker) rather than fingerprinting requests. Known-fallback status: if slice 2's push loop ever needs sub-second PTY activity signals hooks can't provide, this is the eyes-open option.

### 3.2 Multi-engine abstraction
Five engine families × (interactive driver + MCP shim + protocol adapter) ≈ the ~7,900-line engines directory. This is the itemized bill for the multi-provider abstraction Vimes already declined; it validates the decline.

### 3.3 Company-metaphor depth
Ranks, departments, manager-visibility policies, onboarding doctrine. It is precisely *because* delegation runs deep through persona chains that Jinn needs prose-parsing completion nudges (2.4) to keep the chain honest. The flatter Vimes orchestrator→dispatcher→worker design avoids the disease rather than treating the symptom.

### 3.4 Also skipped
Chat-platform connectors (Slack/WhatsApp/Discord/Telegram — Vimes's surface is push+PWA), the STT/voice layer, and per-session dollar-cost estimation from a hardcoded price table (notional on subscription; Vimes meters measure the real constraint).

## 4. Feature gap analysis

| Feature | In Jinn as | Vimes priority | Notes |
|---|---|---|---|
| Hooks event channel for PTY sessions | per-session settings + relay + registry | **High** | Redesigns the D7 spike; new risk-register surface |
| StopFailure rate-limit signal | reason enum + `resetsAt` + overage | **High** | Usage adapter #4; possible new attention reason |
| Turn attribution (injected vs terminal-native) | unclaimed-Stop fallback + debounce | Medium | Attention-model correctness on PTY dual input |
| Per-spawner budget scope | per-employee monthly caps | Medium | One scope addition to meters; containment for the shared interactive pool |
| Structured completion reports | *absent* (regex instead) | Medium | `report_completion` MCP tool does it right by construction |
| Workflow triggers (webhook, poll) | trigger engine | Low (post-MVP) | todo-status triggers ≈ dispatcher already |
| Doctrine migration via composed prompt | `jinn migrate` | Low | For cross-project orchestrator doctrine evolution |
| Session $-cost estimation | MODEL_PRICES table | Skip | Notional on subscription |

## 5. Open questions

1. **Does `SessionStart` reliably deliver the correlation at PTY spawn time**, and does per-session settings injection coexist with the project's own `.claude/settings.json` hooks (merge vs shadow)? The dev box has real hook configs; one test answers it. → D7 spike, hooks-first.
2. **Hook payload/schema drift:** which CLI versions changed hook shapes, and what does the golden-fixture set for hook payloads look like? (Rule 0.6 treatment, same as transcripts.)
3. **Observe-only stance held?** Position taken here: yes — hooks + tail suffice; the SSE proxy is the known, in-path fallback if sub-second PTY activity signals are ever genuinely needed for the push loop.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Redesign D7 spike hooks-first: `SessionStart` correlation with `appSessionId` baked into the relay command; `-n` demoted to fallback | low | slice 2 spike |
| 2 | Add Stop/StopFailure/PreToolUse relay to the PTY channel; wire StopFailure rate-limit payload into the usage service as adapter #4 | low | slice 2 → 5 |
| 3 | **Dedupe JSONL usage accounting by `message.id`** (effort-high double-line landmine) | trivial | usage adapter, now |
| 4 | Note `--append-system-prompt` flag requirement (settings key dead ≥2.1.x); add authenticated-not-just-installed check to setup/first-spawn | trivial | PTY spawn path |
| 5 | Design turn attribution (injected vs terminal-native) into the attention model | low | slices 2–3 |
| 6 | Add spawner-scoped budget caps to the meter/gate schema notes | trivial | slice 5–6 design |
| 7 | Make the slice 6 stage-runner interface graph-ready (per-stage engine/model/effort params) | low | slice 6 design |
| 8 | Spec `report_completion` MCP tool as the structural completion contract; dispatcher rule: idle without report = stale; mirror atomic-claim + orphan-recovery mechanics | low | slice 6 |
| 9 | Risk-register rows: hook settings/payload schema drift; per-session settings vs project settings interaction | trivial | spec §6 on next doc pass |

---
*End of decomposition. Items above are proposals for deliberate application against the canonical docs; none are applied by this document's existence.*
