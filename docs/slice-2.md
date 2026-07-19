# Slice 2 — Session surface (operational plan)

*Skeleton drafted 2026-07-19, against: spec §9 slice 2; the decomposition
series (D7 hooks-first lean, D10 custody trio lean); D4/D14/D18 (decided
2026-07-19). Slice-1 carry-ins: S9/S10 smoke items run early in this slice's
first live checkpoint.*

**Exit gate: human** — one week where no gate goes unnoticed past
⟨tune 60 s⟩ while the phone is in a pocket.
**Kill criterion:** if push delivery through the PWA proves unreliable on
Wes's Android devices — halt; pillar 5 needs a decision record (fallback:
ntfy/Telegram adapter behind the same `notification_trigger` events), not a
workaround.

## Scope / explicitly out

**In:** hooks channel (per-session settings injection, relay, authenticated
hook ingress) with hooks-first D7 correlation; session-list home screen from
JSONL discovery incl. terminal-started sessions read-only (D10 custody:
mirrored + adopt-on-resume; SessionEnd adoption where hooks exist);
spawn/kill/name; seen/clear-attention flow end-to-end; PWA manifest + web
push on `needsAttention`; onboarding with the deliberate
notification-permission tap; spawn preflight (authenticated, not just
installed); D18 riders (provider field, adapter interface); `messageId` on
`usage_block` (D17 rider).

**Out:** editor/files/search/terminal (slice 3); meters beyond raw token
counts (slice 5); StopFailure→usage adapter wiring (slice 5 — the hook
*arrives* now, its consumer waits); turn attribution beyond the
mirrored-session rule below (completes in slice 3 with xterm attach); iOS
push (no iOS device in the loop — re-enters at product-ization; Declarative
Web Push evaluation parked with it); brakes/heartbeats/MCP surface (6–7);
the assumption ledger + guardrails adoptions (separate Wes-calls, tracker).

## Architecture (binding)

- **Hook ingress** *(amended at step-1 build — stronger than drafted)*: a
  **separate listener** on `127.0.0.1:⟨VIMES_HOOK_PORT, 4601⟩` serving ONLY
  `POST /hooks/<appSessionId>`. The tunnel routes only to 4600, so the
  Access-wall exemption is structural, not header-based; the main server
  404s `/hooks` outright (asserted). Auth: **per-spawn secret**
  (`Authorization: Bearer`; constant-time digest compare; secret outlives
  the process until re-spawn/shutdown so post-exit `SessionEnd` still
  authenticates — the D10 adoption trigger needs it). Unknown session or
  bad secret → 401 + `auth_rejected`, zero bytes — I14 extends to this
  ingress. Hook payloads are rule-0.6 fragile: loose zod (unknown
  fields tolerated), golden payload fixtures pinned per CLI version,
  risk-register row. The ingress emits vocabulary events:
  `hook_session_start` {claudeSessionId, ...} (→ `claude_session_mapped` —
  the D7 correlation), `hook_stop`, `hook_stop_failure` {reason, resetsAt?,
  ...} (consumer: slice 5), `hook_pre_tool_use` — schema lands now, consumers
  arrive with their slices (rule 0.5).
- **Per-session settings injection (SDK + PTY spawns):** written to a
  VIMES-owned temp settings file passed at spawn, registering
  SessionStart/Stop/StopFailure/PreToolUse relays. **Spike (a) decides
  merge-vs-shadow** with project `.claude/settings.json` before this is
  trusted (the dev box has real project hooks). `settingSources:
  ['project']` per D14 — the injected file must not reintroduce the user
  tier.
- **Adapter interface (D18):** the session host's channel table becomes
  `SessionAdapter` with declared capabilities `{resume, discover,
  interactiveAttach, gates: 'runtime'|'none', settingsIsolation}` — two
  implementations (claude-sdk, claude-pty). `respondInteraction(requestId,
  answer)` resolving on the adapter's ack becomes the gate-answer contract.
  `SessionRecord.provider` lands (default `'claude-code'`; absent-in-
  snapshot defaults applied at projection — no migration needed, snapshots
  are caches).
- **Discovery & custody (D10):** on-demand scan of `~/.claude/projects/`
  (never watched — inotify budget) lists foreign/historical sessions as
  **mirrored** rows: read-only-live via the tailer, `custody: 'external'`,
  daemon never writes to them, attention setters NEVER fire for mirrored
  sessions (the turn-attribution rule this slice needs; full attribution
  lands with xterm in slice 3). Adopt = explicit action or resume-through-
  VIMES; where a project's own settings carry the VIMES relay (opt-in),
  SessionEnd fires adoption automatically. Pre-adoption history replays
  under the `resync` marker (spec §3.2).
- **Push:** `web-push` VAPID on the daemon (keys generated once at first
  boot, stored in the daemon data dir, mode 600); `push_subscriptions` table
  (cache-class, not event log); the pipeline is `notification_trigger` event
  → push send with deep link `#/session/<id>` → delivery attempt evented
  (`push_sent`/`push_failed` — new vocabulary, schema now). Re-alert
  suppression: a session with `seenAt` newer than `needsAttention.since`
  does not re-push. PWA: vite-plugin-pwa/workbox, manifest, install prompt
  path, onboarding screen with the deliberate enable-notifications tap
  (never auto-prompt). Access-expiry: the WS client distinguishes auth-shaped
  upgrade failure from network failure and performs the full-page re-auth
  bounce, resubscribing with lastSeq after.
- **Preflight:** spawn path checks the CLI binary is present AND
  authenticated (cheap probe) before process launch; failure → structured
  spawn-failure refusal + `transition_rejected`-style event, never a mystery
  hang.
- **Protocol v0.2:** adds `{op:'seen'}`, `{op:'clear_attention',
  cause:'dismissed'}`, `{op:'kill'}` (confirm-guarded in UI),
  `{op:'rename', name}`; new event `session_renamed`. Kill = terminate
  owned process → dormant (software kills processes only on explicit human
  command — the codor stall-flag stance, noted).

## Assertions

**I5 end-to-end (the slice's spine):** harness scenario — gate fires →
`notification_trigger` → fake push adapter records send with deep link →
`seen` sets seenAt (re-push suppressed) → `attention_cleared` only via
action; cold-restart variant keeps attention + subscriptions. Hook-ingress
hostility joins hostile-input (bad secret, unknown session, malformed
payloads, alien hook shapes → 401/quarantine, zero crashes). All prior
assertions green (rule 0.4).

## Build order (sequential agents; my verification + commit between each)

| # | Step | Model | Delivers |
|---|---|---|---|
| 0a | Spike: hooks (small burn) | sonnet | settings merge-vs-shadow answer; SessionStart correlation proven live; relay→ingress prototype; hook payload golden fixtures; **D7 pinned** |
| 0b | S9/S10 smoke carry-over (with Wes, phone in hand) | — | airplane-mode replay; concurrent-resume refusal + I3/I11 transcript-dir evidence |
| ⟸ | **Gate-D pause: D7 pin + merge-vs-shadow result sign-off** | | |
| 1 | Hooks channel + adapter reshaping | opus | ingress endpoint + per-spawn secrets; settings injection; hook event vocabulary; `SessionAdapter` interface + capabilities; provider field; messageId on usage_block; preflight |
| 2 | Discovery + custody + session ops | opus | mirrored sessions (read-only, no-attention rule); adopt paths; kill/name; seen/clear; protocol v0.2; session-list UI upgrade (foreign rows, actions, confirm-guarded kill) |
| 3 | PWA + push | opus | manifest/SW/onboarding; VAPID + subscriptions; trigger→push pipeline + suppression; deep links; Access-expiry bounce; I5 end-to-end scenario |
| 4 | On-device checkpoint (Wes) | — | install PWA on Android; locked-phone delivery timing measured → calibration.md; then the week-long exit gate begins |

## What would be a finding

Per-session settings SHADOWING project settings (breaks D14's project-tier
promise → halt, decision record); SessionStart hook payload lacking the
session id or firing unreliably (D7 falls back to `-n`, recorded); push
delivery on the installed Android PWA missing the ⟨tune 60 s⟩ intent under
locked-phone conditions (kill criterion territory); hook ingress reachable
through the tunnel (would be an I14 breach — the exemption must be
localhost-path-only by construction).
