# Decomposition: agent-of-empires/agent-of-empires → Vimes
**Date:** 2026-07-29 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/agent-of-empires/agent-of-empires (AoE — MIT, Rust, Homebrew/Nix distributed, actively developed, ~15 agent CLIs supported)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes docs in this repo. Sixth in the series (jinn, agent-teams-ai, codor, agenc-core, agentswarms, this); cross-corroborations flagged. Nothing here self-applies.

> **This is the closest competitor in the series.** Not a neighbor, not a sibling — the *same lane*: tmux-backed sessions that outlive your terminal, a mobile-first PWA over a Cloudflare tunnel, status-at-a-glance, push when an agent needs you, git worktrees, diff review. It is further along on the *session-manager* axis and MIT-licensed. The strategic read (§7) matters as much as the patterns.

---

## 1. Landscape

AoE is a Rust session manager for AI coding agents: each agent runs in its own tmux session, driven from a TUI or a browser PWA. Fifteen agent CLIs auto-detected. Worktrees and multi-repo workspaces, Docker/Podman/Apple-Containers sandboxing, diff view, session resume, sound + push notifications, HTTP API + CLI for external orchestrators, plugin API, themes, and a remote-access flow (`R` in the TUI → HTTPS via Tailscale Funnel or Cloudflare Tunnel with QR + passphrase).

The headline architecture: **the web dashboard's default is a "structured view" rendering agent state natively via the Agent Client Protocol** — plan panels, tool-call cards, swipe-to-approve — with raw tmux rendering available as a *fallback* view. That is the same inversion Vimes made (structure first, terminal as escape hatch), reached from the opposite direction: AoE started as a tmux manager and grew structure; Vimes started structured and kept a PTY escape hatch.

**Why it matters to Vimes:** everything above the task machine — session hosting, mobile UX, notifications, remote access, status detection — is territory AoE has already walked, at production polish, in the open. It is the single best source in the series for *operational* patterns, and the only one that competes with Vimes's stated MVP scope. It has nothing resembling the work-order/verdict machine.

## 2. Patterns worth lifting

### 2.1 ACP as the structured channel — the multi-provider seam, solved by a standard
**Where:** `src/acp/*` (28 modules: `protocol.rs`, `acp_client.rs`, `supervisor.rs`, `capability_probe.rs`, `agent_registry.rs`, `permissions.rs`, `elicitations.rs`, `terminal_handler.rs`, `fs_handler.rs`), plus an `acp-worker/` crate with per-agent adapters and a bundled `aoe-agent`.

AoE speaks the **Agent Client Protocol** — a JSON-RPC protocol standardizing agent↔client interaction (session lifecycle, prompt turns, tool-call reporting, permission requests, plan updates, terminal/fs delegation). Agents that speak ACP natively connect directly; ones that don't get an adapter in `acp-worker/adapters`. Capability negotiation is explicit: `capability_probe.rs` + `agent_capabilities` on the `initialize` response drive what the UI offers per agent.

**Vimes consequence — this is the eventual-multi-provider answer, and it's better than the seam we designed.** The Vimes plan was a capabilities-declared adapter interface of our own invention (codor 2.5). ACP is that interface, already specified, already implemented by multiple agent CLIs and editors, with the exact primitives Vimes's structured view needs — including *plan updates* and *permission requests* as protocol-level messages rather than per-harness scraping. The strategic question this raises is genuinely open (§5 Q1): if provider #2 arrives via ACP rather than a hand-rolled adapter, the seam becomes an implementation of a public standard instead of a private abstraction, and Vimes's `submit_plan`/`report_review` contracts sit *above* it as Vimes-specific semantics ACP doesn't cover. Worth reading the ACP spec before D51-era work hardens the stage-runner interface.

### 2.2 `session/load` with an explicit context-reset callout — the honest half of resume
**Where:** `src/acp/event_store.rs` (doc comment), `supervisor.rs`.

Two layers, deliberately separated: the **UI transcript** persists in a disk-backed event store, while the **model's conversation context** across restarts is a *different* mechanism — when an agent advertises `agent_capabilities.load_session = true`, the supervisor stores the agent-assigned session id and uses `session/load` instead of `session/new` on subsequent spawns. And the part worth stealing outright: **if `session/load` fails, the stored id is cleared, a `SessionContextReset` event is published, and the UI renders an amber callout in the transcript so the user knows prior turns are no longer in the model's context.**

**Vimes adaptation:** Vimes has the same two layers (event spine vs Claude's own context) and the same hazard — a resumed session whose *transcript* is intact but whose *model context* silently isn't. Today that failure would be invisible. Make context-reset an explicit spine event with a visible marker in the session view. It is a small addition that turns a silent, confusing failure into an observable one, and it is squarely rule 0.7: the UI should show what actually happened, not what the transcript implies.

### 2.3 Approval nonces — the anti-replay primitive Vimes's phone UX needs
**Where:** `src/acp/approvals.rs`. Server-generated single-use tokens attached to each approval card; clients echo the nonce back on allow/deny. Stated purposes: **stale-button replay** (a backgrounded mobile client tapping an approval already superseded) and **malicious agents synthesizing approvals** (the agent never sees the nonce — it travels client→server only on resolution). Single-use, expires with the approval timeout.

**Vimes adaptation:** the stale-button case is not hypothetical for Vimes — a phone that was backgrounded for an hour, waking to a PWA still rendering a gate that has since resolved, is the *expected* mobile lifecycle. Nonce every gate/verdict/promotion action. This also generalizes the AgentSwarms rule (decision read from the record, never the caller) into its mobile-specific form: **the record decides, and the token proves the click was for the state the user was actually looking at.**

### 2.4 Status-hook debounce — the flicker guard
**Where:** `src/status_hooks.rs` — a status must remain stable for a debounce window (default 100ms) before hook commands fire, *so rapid flickers (Running → Waiting → Running) don't fire spurious hooks.*

**Vimes adaptation:** direct hit on the attention model. A run that momentarily quiesces between tool calls should not buzz a phone. Debounce the *notification-trigger* edge, not the state itself — attention state stays instantaneous and correct in the spine; delivery waits for stability. One small addition, and it prevents the failure mode that would most quickly train the operator to ignore Vimes's pushes.

### 2.5 Supervisor respawn with a bounded window, then park loudly
**Where:** `src/acp/supervisor.rs` — when an agent's connection task ends (subprocess exit, transport break) the drain task respawns it; up to `MAX_RESPAWNS_IN_WINDOW` inside `RESTART_WINDOW`, **beyond which the session is parked and an `AgentStartupError` event is published so the UI can surface "session crashed" instead of going silent.**

Fifth appearance of bounded-retry-then-park in the series. What is new here is that it applies to *transport-level* failures, not task-level ones — Vimes's watchdog covers stalled stage runs, but a session host whose SDK stream or PTY dies repeatedly should follow the same discipline: bounded respawn, then park with a loud, distinguishable state. "Going silent" is the failure mode to design against; a parked-with-reason session is recoverable, a silently dead one is not.

### 2.6 Per-session diagnostic tee with LRU-bounded writers
**Where:** `src/acp/session_tee.rs` — mirrors session-scoped tracing events into `acp-workers/<id>.log` so per-session logs surface daemon watchdog/cancel breadcrumbs, not just agent stderr. Notable engineering: routing by span scope (events inherit the session field from an enclosing span even when they don't set it), synchronous best-effort writes (*"dropping a breadcrumb during a spike would lose exactly the diagnostics this exists to capture"*), **writers bounded by count with LRU eviction so a long-lived daemon doesn't leak file handles**, and re-entrancy guarded (the writer never emits tracing).

**Vimes adaptation:** Vimes's spine holds *domain* events; this is the *operational* layer beneath — "why did this session's transport hiccup at 03:14." The three design notes transfer as-is: bound the writers (a self-hosting daemon accumulates sessions), don't background the writes you most need during an incident, and guard re-entrancy. Pairs naturally with the `vimes doctor` item from the AgenC decomposition.

### 2.7 The web design system as a written artifact
**Where:** `web/DESIGN.md` — a standalone design system for the dashboard, explicitly separate from the TUI/marketing design doc. Product classifier, mood, **an explicit "what we avoid" list** (pervasive brand colors, decorative elements, *"AI slop patterns (purple gradients, 3-column icon grids, centered-everything layouts)"*), six numbered design principles, a full typography table with per-element sizes/weights, and named surface tokens.

Two principles are directly applicable to Vimes: **"Density over chrome"** (every pixel of border and padding earns its space — the right instinct for a session list that must scan at a glance on a phone) and **"Mobile is monitoring"** (*on mobile, you mostly watch*). That second one is where Vimes deliberately **diverges**, and naming the divergence is useful: Vimes's pillar 5 says mobile is for *deciding* — answering a gate in one tap while the cache is warm. AoE optimizes mobile for observation; Vimes optimizes it for the decision. Worth stating in Vimes's own design doc, because it's the difference that justifies the swipe-to-approve-class interactions.

The meta-lift: **the design system is a written artifact with a "what we avoid" section.** Vimes has design *principles* for architecture but nothing equivalent for the UI. One page, written once, is what keeps an agent-built UI from drifting into slop — and Vimes is now building its own UI through agents, which makes this a doctrine document, not a style guide.

### 2.8 Remote access as a first-class flow
**Where:** `R` in the TUI → HTTPS web dashboard via Tailscale Funnel or Cloudflare Tunnel, QR + passphrase auth, PWA-installable, `ConnectedDevices` component.

Vimes's tunnel is hand-configured, which is correct for a single operator and a known blocker for anyone else. The liftable pieces if Vimes ever ships beyond one user: QR-based device pairing (codor's pairing-link idea, third appearance), a connected-devices view, and treating "expose it securely" as a product flow rather than a setup document. Post-MVP; noted because it's the friction that decides whether anyone else can use the thing.

## 3. Patterns to skip (with reasons)

- **Rust + tmux hosting.** AoE's process model is tmux-per-session with a Rust daemon; Vimes owns processes directly via node-pty/SDK with the log as the replay buffer. Both work. Vimes's model gives finer-grained structured control and no tmux dependency; AoE's gives free out-of-band survivability and terminal-native attach. Settled architecture on both sides — no action.
- **Fifteen agent CLIs.** Seventh corroboration of the multi-provider bill. *But* see §5 Q1: AoE pays that bill with a standard (ACP) rather than bespoke adapters, which is the first genuinely cheaper answer the series has produced.
- **Docker/Podman/Apple-Containers sandboxing.** Real feature, out of MVP scope; relevant later for the Vimes-builds-Vimes sandbox rule (fourth appearance of sandboxing as the hardening path).
- **TUI dashboard, sounds, themes, plugin API, Homebrew/Nix distribution.** Product surface for a broad audience. Vimes is single-operator; distribution polish is a monetization-era concern.
- **Multi-repo workspaces / worktree orchestration.** Vimes has D6's isolation flag and the cache-prefix tradeoff already reasoned; AoE's worktree-per-session default is the opposite tradeoff (isolation over cache warmth) made for parallel-agent users. No change.

## 4. Feature gap analysis

| Feature | In AoE as | Vimes priority | Notes |
|---|---|---|---|
| Context-reset made explicit + visible | `SessionContextReset` + amber callout | **High** | Silent failure → observable event; pure rule-0.7 |
| Approval nonces (anti-replay, anti-synthesis) | `approvals.rs` | **High** | Mobile lifecycle makes stale buttons routine |
| Notification debounce on status flicker | `status_hooks.rs` (100ms) | **High** | Protects the push channel's credibility |
| ACP as the multi-provider seam | whole `src/acp/` tree | **High (strategic)** | Read the spec before hardening the stage-runner interface |
| Bounded transport respawn → park loudly | `supervisor.rs` | Medium | Extends watchdog discipline to transport failures |
| Written UI design system w/ "what we avoid" | `web/DESIGN.md` | Medium | Doctrine for an agent-built UI |
| Per-session operational log, LRU-bounded | `session_tee.rs` | Medium | Pairs with `vimes doctor` |
| QR/device pairing + connected devices | remote access flow | Low (post-MVP) | 3rd appearance of pairing-link pattern |

## 5. Open questions

1. **Does Vimes adopt ACP as the seam, or keep its own adapter interface?** Arguments for: the standard already encodes plan updates, permission requests, capability negotiation, and fs/terminal delegation; provider #2 becomes near-free; interop with other ACP clients/editors comes along. Arguments against: ACP is a *session-interaction* protocol, not a work-order protocol — Vimes's differentiators (`submit_plan`, `report_completion` with worklog, `report_review` with criterion UUIDs, `deriveReviewOutcome`) sit above it either way, and adopting a standard means inheriting its versioning and its abstraction's assumptions. Also unresolved: whether ACP's plan-update primitive is *liftable as an artifact* the way D48's `ExitPlanMode` interception is, or whether it would force Vimes back toward a tool-call contract for the plan boundary. **This is the highest-value thing to investigate before the multi-provider seam hardens** — and it's a read-the-spec task, not a spike.
2. **Does the structured-view convergence change Vimes's positioning?** AoE's default view is structured, mobile-first, with swipe-to-approve — the visual language Vimes is also building. The differentiator was never the rendering; it's what happens *after* the agent finishes (work-orders, verdicts, bounce loops). Worth a deliberate look at their structured view before further Vimes UI work: partly for ideas, partly to make sure Vimes's UI expresses the thing AoE's cannot.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Emit an explicit context-reset event when a resume fails to restore model context; render a visible marker in the session view | low | session host |
| 2 | Nonce every state-advancing UI action (gate answer, verdict, promotion, dispatch); single-use, expires with the action | low | board API + MCP surface |
| 3 | Debounce notification delivery on status flicker (state instantaneous in spine, delivery waits for stability) | low | attention model |
| 4 | Read the ACP spec; decide D-record: adopt as the multi-provider seam vs keep the private adapter interface | low (research) | before seam hardens |
| 5 | Bounded respawn → park-with-reason for transport-level session failures (never go silent) | low | session host |
| 6 | Write a Vimes UI design doctrine doc: principles, typography scale, tokens, and an explicit "what we avoid" list | low | repo, before more agent-built UI |
| 7 | Per-session operational log with LRU-bounded writers, synchronous best-effort writes, re-entrancy guard | low | daemon diagnostics |
| 8 | Post-MVP: device pairing flow (QR + passphrase) and connected-devices view if Vimes goes beyond one operator | deferred | horizon |

## 7. Strategic read — the competitive position

AoE is MIT-licensed, Homebrew/Nix-distributed, has a public roadmap, a YouTube channel, merch, and Trendshift traction. On the session-manager axis it is ahead of Vimes and will stay ahead: more agents, more platforms, more polish, more contributors.

**That does not threaten Vimes's thesis — it clarifies it.** AoE is the best-in-class answer to *"I have many agents running; show me which ones need me."* It is chat-and-steer at excellent production quality: watch, approve, review the diff, type again. What it does not have, anywhere in 28 ACP modules and a full web dashboard, is a **work-order with acceptance criteria, a plan crossing an agent boundary as an artifact, a fresh implementer, or a verdict function that can't be talked around.** Its approval flow is per-tool-call permission; Vimes's is per-criterion verification. Different products that look similar from a distance.

Three consequences worth acting on:
- **Don't compete on session-manager breadth.** Fifteen agents, sandboxing, themes, sounds — that race is lost and it was never the point.
- **The differentiator is the verification loop, and it should be visible in the UI**, not just true in the architecture. If Vimes's board looks like a nicer session list, it will be compared to AoE as a session list.
- **ACP adoption would be a strategic *win*, not a concession** (§5 Q1): it puts Vimes's work-order semantics on top of the same substrate the ecosystem is standardizing on, instead of maintaining a private seam that duplicates it.

---
*End of decomposition. Cross-corroborations across the six-repo series: bounded-retry-then-park (5th); human approval as first-class parked state (5th); pairing/device-onboarding (3rd); sandboxing as hardening path (4th); multi-provider cost (7th — but first solved by a standard rather than paid per-agent). New here: ACP as an off-the-shelf capabilities seam, approval nonces, notification debounce, explicit context-reset surfacing, and a written UI design doctrine. Notably absent here and present in Vimes: any structured contract for what work is, when it is done, or who says so — the seventh consecutive project without a verdict machine.*
