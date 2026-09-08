# VIMES (working title — see D1)
### Agent-first remote IDE for Claude Code
**Design spec & slice plan — draft 2 — 2026-07-13**

> Code-server gives remote access to an editor with agents bolted on; this inverts it. A session host owns every Claude Code process on the dev box and streams structured state to any browser, so the phone in your pocket is a full peer of the desk: sessions resume without forking, gates ping you in time to answer them warm, and the editor is a tool the agent workflow reaches for rather than the other way around.

**Changes from draft 1 (red-pen round 1):** auth specified as a core system (finding A); replay ring buffer eliminated — the event log is the buffer, persist-before-broadcast is now I13, backpressure policy added (findings B, E); projection snapshots + inline-bodies decision (finding C, D12); status machine split into liveness × attention, resolving D9 (finding D); Node 24 + node:sqlite named (finding F); stack amendments 1–7 applied with the review's edits; D2 resolved; D11 added; chokidar scoping, binary PTY frames, secure-context note folded in.

---

## 0. Ground rules

- **0.1** Any structural flaw discovered by tests, spikes, or scenario runs — a race, an unstable identity, a dependency behaving differently than designed-for — is a *finding*, not a patching problem. Findings halt the slice and get a decision record before work continues.
- **0.2** Numbers marked ⟨tune⟩ are placeholders. They may not be pinned into assertions until the calibrate-then-pin procedure (§8) has run and Wes has signed off. Never pin and pass in the same unreviewed step.
- **0.3** The core is deterministic and headless: pure logic with clocks, randomness, and I/O injected at the boundary. UIs, agents, and external callers are consumers of system state and proposers of transitions — never owners of either. The dispatcher owns the task state machine; orchestrator agents propose, they never transition.
- **0.4** Every slice ships with its assertion set green and all prior assertions still green. Regressions are findings.
- **0.5** Schema reservations are cheap; retrofits are expensive. Slices may stub systems but must land the data shapes, event schemas, and API contracts (§5). (Data shapes, not tooling: machinery with no live consumer waits for its first consumer — see D11.)
- **0.6** External surfaces the project does not control are presumed to drift. Each gets a risk-register entry (§6) and a fragile-adapter boundary; nothing outside the adapter may depend on the surface's specifics. Anthropic surfaces get double suspicion: the March TTL regression and the June billing split both happened mid-design. The OTLP schema and the Cloudflare Access JWT surface are under this rule too.
- **0.7** *Observed truth over declared truth.* Wherever Anthropic behavior matters (TTL tiers, billing buckets, session ID semantics), the system classifies by observation of usage fields and transcript data at runtime, never by documentation. Tags record what a session *did*.
- **0.8** *Never parse the screen.* Structured data comes from JSONL transcripts and SDK streams only. Raw PTY bytes are relayed verbatim to terminal renderers and are never regexed for meaning.

## 1. Design pillars

1. **The session list is the home screen.** Sessions are the primary object; files, editors, and terminals are views opened from a session's context. Consequence: every feature is judged by whether it works from the session list on a phone.
2. **Reconnecting is not resuming.** A browser is a viewport on a server-owned process, never the process's owner. Consequence: closing every tab changes nothing about any running session; "resume" only means waking a dormant transcript, and it never forks.
3. **The agent is the refactor engine.** Editing intelligence beyond CM6 basics + ripgrep is delegated to Claude, not to an embedded language service. Consequence: no LSP, no TS server in the browser, no Monaco; the editor stays small enough to be pleasant on mobile.
4. **Budgets gate work, not surprise it.** Usage windows, credits, and cache economics are first-class domain objects readable by anything that schedules work. Consequence: the dispatcher can decline or defer; the human sees headroom before committing.
5. **Attention is the scarce resource.** The system's job when a session needs a human is to say so within seconds, to a device that can answer in one tap. Consequence: attention state is its own dimension, survives restarts, and is cleared only by deliberate action — never lost by a reboot or a glance.
6. **Deterministic harness, replaceable actors.** State machines and reducers are authoritative and testable without Claude, network, or UI. Consequence: every scenario runs against fixture transcripts and fake process adapters; a green harness means the core is correct even if Anthropic changed everything overnight.
7. **Escape hatches beside abstractions.** Every structured pathway keeps a raw sibling: the PTY terminal next to the SDK stream, direct file paths next to the upload dialog. Consequence: the day the abstraction fails, work continues.

## 2. Problem frame

One developer, one always-on dev environment (Linux box behind a cloudflared tunnel), many concurrent Claude Code sessions, accessed from anywhere — desk, couch, phone in a parking lot. Today that's code-server: heavy, mobile-hostile, agent-blind. The moments this product exists to fix:

- A workflow was queued expecting an hour of autonomy; it hit a permission gate at minute 3 and sat idle. The fix: know within seconds ⟨tune⟩ from a phone, answer in one tap, while the cache is still warm.
- A session was left mid-thought at the desk; picking it up from a phone must attach to the same live stream, or wake the same transcript — never fork it, never lose events across the gap.
- A task queue should be inspectable down to any worker's live session, with a course correction injectable without killing the run.
- "Do I have the budget to kick this off right now?" must be answerable from the home screen: 5-hour window, weekly caps, non-interactive credit, all as meters with reset countdowns.

Planted payoff: the event spine (§3.3) is emitted from slice 0 even though its biggest consumers (usage analytics, the game layer) arrive last. Capture is cheap now and impossible to retrofit.

**Security frame (finding A):** the daemon is, by design, a remote shell (the PTY endpoint) plus an arbitrary-file API, on a public tunnel hostname. Auth is therefore not a product feature to defer; it is the difference between a dev environment and an open RCE. §3.11 specifies it; it is MVP-blocking and live from slice 1.

## 3. Core systems

### 3.1 Identity model

| ID | Minted by | Stability | Notes |
|---|---|---|---|
| `appSessionId` (UUID) | us | permanent | Primary key for all session state, events, UI routes |
| Claude session ID | Claude Code | **rotates** on compaction and /clear | Mapped to `appSessionId`; the mapping is data (`claude_session_ids[]` append-only per app session) |
| JSONL transcript path | Claude Code | per Claude session ID | Derived; tracked per mapping entry with encoded-cwd |
| `taskId` (UUID) | us | permanent | Kanban task; carries 0..n `appSessionId` refs (one per stage run) |
| `eventId` (monotonic per stream + UUID) | us | permanent | `seq` is per-`appSessionId` monotonic; global UUID for cross-stream refs |
| PTY handle | session host | process lifetime | Never persisted as identity; ownership record only |

**Invariant anchor:** nothing long-lived is keyed on a Claude-minted identifier. When Claude rotates the session ID mid-conversation, the app session absorbs the new ID into its mapping and no consumer notices (I1).

### 3.2 Session host & router

The daemon that owns every Claude process. Two channel classes behind one session abstraction:

| | SDK-hosted | PTY-hosted |
|---|---|---|
| Process | Agent SDK `query()` (streaming-input mode) | `claude` CLI in node-pty |
| Control channel | SDK message injection / interrupt | PTY stdin (raw keystrokes) |
| Structured data | SDK event stream | **JSONL transcript tail** |
| Raw view | rendered transcript only | xterm.js verbatim relay (binary WS frames) |
| Billing bucket (see D4) | likely non-interactive credit — **verify** | interactive 5h window — **verify** |
| Use | task/orchestration runs, headless work | interactive daily-driver sessions, TUI features |

The **JSONL tail** is the universal structured channel: fs-watch on the *active project directories only* (a full `~/.claude/projects` watch would enroll thousands of historical transcripts and risk inotify watch limits); historical sessions are listed by on-demand directory scan, not live-watched. Line-buffered parse; malformed/partial lines quarantined not fatal (I8, hostile-transcript scenario). PTY sessions get structure this way without ever parsing terminal output (rule 0.8).

**Run registry.** Per `appSessionId`: live channel refs, `seq` counter, completion state, and subscriber set. **The event log is the replay buffer** (finding B): every event commits to SQLite before any broadcast (I13), so `subscribe(appSessionId, lastSeq)` serves `lastSeq+1..head` directly off the `(stream, seq)` index, then live-streams. There is no in-memory ring buffer, no buffer-overrun case, and one replay path regardless of how long the client was gone (I2). A `resync` marker survives for exactly one case: pre-adoption history of terminal-started sessions whose early transcript predates the event log (D10).

**Backpressure** (finding E): if a client socket's `bufferedAmount` exceeds ⟨tune⟩, the daemon drops the connection. The client resubscribes with its `lastSeq` and replays from the log — the recovery path is the same invariant-covered path as any disconnect. No coalescing, no per-client queues. (PTY byte streams are the exception: the per-terminal ⟨tune 2 MB⟩ ring buffer in §3.4 handles raw bytes, which are not spine events and never will be.)

**Resume semantics** (the never-fork law, I3):
- Session live → attach = subscribe. No CLI/SDK resume occurs at all.
- Session dormant → resume = SDK `resume:` or `claude --resume <id>` from the recorded cwd, appending to the same transcript, same `appSessionId`.
- Fork happens only via an explicit fork action, which mints a *new* `appSessionId` with a `forkedFrom` ref.
- A resume attempted while a run is in-flight on the same session is rejected by the registry before any process spawns (I11).

**Session state = liveness × attention** (finding D; resolves D9). Two orthogonal dimensions, not one machine:

*Liveness* (process reality): `spawning → running → dormant | interrupted | dead`
- `running`: a live process owned by the host.
- `dormant`: no process; transcript resumable.
- `interrupted`: host restarted while the session was live; one-tap dormant-resume offered. (Daily UX, not an edge case — see §4 beat 7.)
- `dead`: unrecoverable (transcript gone, cwd gone).

*Attention* (human-needed reality): `needsAttention: { reason: 'gate' | 'question' | 'completed' | 'stale' | 'quarantined', since } | null`, plus `seenAt`.
- Set by structured events (permission gate, AskUserQuestion, plan approval, run completion, watchdog stale, task quarantine). Setting it emits the notification-trigger event (I5).
- **Viewing the session sets `seenAt`** — this acknowledges the *notification* (stops re-alerting).
- **Only a deliberate action clears `needsAttention`** — responding to the gate, dismissing explicitly, the run resuming. A glance never silently clears "needs you."
- Attention is persisted state and **survives restarts** (cold-restart scenario asserts it): a `waiting` session before a reboot is an `interrupted` session that still needs attention after it. Pillar 5 holds across power cycles.

The old `waiting`/`idle` labels survive only as derived UI badges: waiting = needsAttention ∧ ¬actioned; idle = attention clear ∧ not running.

**PTY↔JSONL correlation** (D7 spike): spawn with `claude -n <appSessionId>`, match the transcript containing that name record; fall back to newest-file-after-spawn-timestamp with single-spawn serialization per project dir.

### 3.3 Event spine

Everything flows through one append-only SQLite events table from slice 0. Emitters: run registry (messages, tool calls, gates, completions, usage blocks), session host (spawn/exit/interrupt), dispatcher (task transitions), usage service (meter samples), UI (seen/cleared/actions). Consumers are pure reducers. Events are never edited or deleted; corrections are new events. The append-only property is enforced by the `EventStore` interface type and implementation, not convention (I12); schema migrations run *below* that interface as raw SQL against the file, so I12 governs runtime writes without forbidding maintenance (D11).

**Persist-before-broadcast** (I13): an event reaches no subscriber before its transaction commits. This single ordering rule is what lets the log be the replay buffer (§3.2) and makes crash-during-broadcast a non-event: the client's next `lastSeq` is always ≤ the log head.

**Projections & snapshots** (finding C, D12): each projection (session states, task board, meters, stats) persists with a `lastAppliedSeq`; boot replays only the tail. I6's replay-from-empty guarantee is a *harness assertion over fixtures*, not a boot path — the harness proves snapshot+tail ≡ from-empty (I6). Message bodies are stored **inline** in the log (D12): a log of transcript refs would make replay depend on Anthropic's files surviving, which rule 0.6 refuses. Growth is accepted and managed post-MVP (archival/compaction sketched in the horizon); snapshots keep cold start flat regardless of log size.

### 3.4 Workspace: editor, files, search, terminal, git

- **Editor:** CodeMirror 6. Multi-cursor, bracket/indent intelligence, syntax highlight via lezer grammars for the house languages ⟨tune: TS/JS, Vue, Python, Rust, Markdown, JSON/YAML⟩. Mobile keyboard toolbar (tab, esc, arrows, ctrl-combos). No LSP (pillar 3).
- **Files:** server-side file API scoped to registered project roots. Upload via dialog and drag-drop (multipart, not base64, for >⟨tune 5 MB⟩); download single files and zipped folders. Path traversal denied at the API boundary (hostile-input scenario).
- **Search:** ripgrep `--json` server-side; results stream with file/line/col/submatch; tap-to-open at location. Search-and-replace runs as a preview-diff then apply.
- **Terminal:** raw PTY shell endpoint (separate from Claude PTY sessions), xterm.js over **binary WS frames** (bytes in, bytes out — no base64-through-JSON; zod validates control envelopes, never payload bytes), per-terminal reconnect ring buffer of ⟨tune 2 MB⟩ (I9).
- **Git:** status, per-file and per-hunk diff view (mobile-legible), stage/commit, branch/worktree listing. Reviewing agent diffs is the primary human job; this panel is that job's tool.

### 3.5 Task system (handoff rework)

Custom rework of the aif-handoff shape, scoped to the open project, single-provider (Claude), with the IDE as its front end.

- **Task state machine:** `backlog → planning → plan-ready → implementing → review → done`, plus `blocked-external`, `quarantined`, and `done+manual-review-required` (the convergence-aware exit: when auto-review rework stops converging, hand off explicitly rather than silently pass).
- **Dispatcher (deterministic code, rule 0.3):** owns all transitions and all worker spawning, through the session host — so every stage run is an `appSessionId` and "open this task's session" is one tap. Checks usage meters before spawning (pillar 4). Heartbeat watchdog: a stage session with no JSONL append for ⟨tune 5 min⟩ is stale → retry with backoff → quarantine after ⟨tune 3⟩ attempts. Stale and quarantine set `needsAttention` on the stage session.
- **Course correction:** injected into live stage runs via SDK streaming input (D5; fallback = interrupt-then-resume-with-correction if the spike fails).
- **Orchestrator layer:** Fable/Opus-class agents get an MCP surface over the task DB — `create_task`, `refine_task`, `promote_task`, `comment`, `read_session_summary`, `read_meters`. Proposals that violate the state machine are rejected and evented (I7). Orchestrators never spawn processes.
- **Project scoping:** auto-open/auto-scaffold the active project; handoff metadata lives in a dot-dir auto-added to ignores.
- **Worker isolation** (D6): per-task flag `isolation: shared-dir | worktree`. Shared-dir preserves cross-worker cache prefixes (cache is scoped to machine+directory); worktree buys file isolation at guaranteed cache misses. Default ⟨tune shared-dir⟩ with dispatcher-serialized write phases.

### 3.6 Usage service

Meters are data, not config: `{ meterId, kind: rolling-window | weekly-cap | monthly-credit, scope: all-models | model-family | non-interactive, used, limit, resetsAt, source, observedAt }`. Current known set (presumed to drift, rule 0.6): 5-hour rolling window, weekly all-models cap, weekly model-family cap, non-interactive monthly credit ($100 on Max 5x).

Three source adapters, independently degradable:
1. **JSONL accounting** (ccusage approach) — per-model/per-project consumption and burn rate from files already tailed. Bulletproof; can't see server thresholds.
2. **OTel export** — `CLAUDE_CODE_ENABLE_TELEMETRY=1`; the daemon ingests OTLP/HTTP **directly** (no collector process). The host pins `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` in the environment of every session it spawns, so the daemon never speaks protobuf or gRPC. The ingest schema is deliberately loose — unknown fields tolerated — because OTLP versions upstream (rule 0.6).
3. **Unofficial `/usage` endpoint probe** — authoritative percentages and reset times; fragile adapter, clearly marked, one-module swap when it breaks or an official endpoint ships (open Anthropic feature request).

Derived: burn rate, projected exhaustion time, headroom per meter — surfaced on the home screen and readable by the dispatcher. Usage-aware scheduling: tasks may declare `deferUntilReset` or `requireHeadroom: {meterId, pct}` gates.

### 3.7 Cache observability

Every assistant message's usage block carries `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` and cache-read counts. The system tags each session and subagent with its **observed** TTL tier (rule 0.7) and computes per-session cache hit rate. UI surfaces cache-vandal warnings before actions known to bust caches (model switch; anything that would churn MCP server connections on a live session). The keep-warm pinger is **out of scope** (post-MVP at most): with 1h TTL observed on subscription main conversations, the notification loop carries cache economics.

### 3.8 Notifications

Web push (VAPID) + PWA install. Triggers: `needsAttention` set, meter threshold crossings ⟨tune 80%⟩. Every notification deep-links to the exact session/task/meter. Delivery target: gate-fired to phone-buzzed under ⟨tune 10 s⟩. Push permission requires a user gesture after PWA install — onboarding includes a deliberate "enable notifications" tap, never an automatic prompt. Push and service workers require a secure context; the tunnel provides HTTPS, and any hypothetical bare-LAN access mode would have no push (accepted; noted here so nobody rediscovers it).

### 3.9 Game layer (post-MVP; schema reserved)

Pure reducers over the event spine: achievements (~100, defined as data), streaks, live stats (completion accuracy, tokens-per-shipped-task, gate response time, cache hit rate, window near-misses). Ships nothing in MVP except its event coverage and the reserved schema (§5).

### 3.10 Degradation posture

| Failure | Detected | Recovered | Surfaced |
|---|---|---|---|
| Client disconnect (any duration) | WS close | subscribe(lastSeq) replay from log — one path, any gap length | silent; "caught up" toast |
| Slow client (backpressure) | bufferedAmount > ⟨tune⟩ | connection dropped; client resubscribes with lastSeq | brief reconnect spinner |
| Host process restart | startup scan vs registry snapshot | live sessions → `interrupted`; **attention state persists** (I5); JSONL rediscovery rebuilds list; one-tap dormant resume | interrupted badge; needs-attention badge intact |
| Dev box reboot | same as above | same; PTY/SDK children do not survive (accepted) | same |
| Claude session ID rotation | new ID in tailed JSONL | append to `claude_session_ids[]` mapping | invisible (I1) |
| JSONL malformed/partial line | parse failure | quarantine line, continue tail, event emitted | diagnostics panel only |
| Cloudflared outage | client-side | nothing to do server-side; sessions run on | client offline banner; queued seen/actions sync on return |
| Access session expiry mid-use | WS upgrade fails with auth redirect | client detects, bounces through re-auth (full-page nav), resubscribes with lastSeq | re-auth interstitial (iOS-PWA path tested in slice 2) |
| Usage endpoint breaks | adapter error | meters degrade to JSONL+OTel sources, marked stale | staleness badge on meters |
| Stage run stalls | watchdog (no append ⟨tune 5 min⟩) | retry w/ backoff → quarantine; needsAttention set | task card flag + push |
| Anthropic changes TTL/billing again | observed-tier tags diverge from expectation | nothing breaks (rule 0.7); dashboard shows the shift | tier/bucket badges change |

### 3.11 Access control (finding A)

Cloudflare Access sits on the tunnel hostname (SSO identity, device posture as desired). The daemon **independently validates** the `cf-access-jwt-assertion` on every HTTP request and on every WS upgrade — signature against the team's JWKS, `aud` claim against the Access application tag — via one middleware at the single choke point in front of everything, including static assets. Unauthenticated or invalid → 401, zero bytes of product. This is one middleware, not a login system; the product-ization auth wrapper remains post-MVP.

Threat honesty: the PTY endpoints are remote code execution *as designed*. Auth failure here is not data exposure, it is a shell. The hostile-input scenario carries unauthenticated and forged-JWT probes against HTTP, WS upgrade, and the PTY endpoint specifically, from slice 1 onward. The known operational wart — Access session expiry breaks WS upgrades with a redirect the WS client cannot follow — is handled client-side (detect, full-page re-auth bounce, resubscribe with lastSeq) and is called out in the risk register because the installed-iOS-PWA re-auth path is genuinely awkward and must be tested on-device (slice 2, alongside push).

## 4. UX beats worth protecting

1. Phone reconnects after 40 minutes offline → caught up in under ⟨tune 2 s⟩, zero lost events, no fork.
2. Gate fires → phone buzzes in under ⟨tune 10 s⟩ → one tap opens the exact prompt → answered while the cache is warm.
3. Session list home screen: every session's liveness, attention, project, and cost at a glance; the needs-you badge is never wrong and never silently lost.
4. Any kanban card → its live session stream in one tap; type a course correction into a running task.
5. "Can I afford to start this?" answered by the home-screen meters without opening anything.
6. Model-switch confirm shows "this will re-read the full context cold" before it costs you.
7. **Daemon restarted (it will, daily, during development) → the interrupted list reads like a to-do, attention badges intact, and every session is one tap from resumed.** Interrupted-recovery is daily UX from slice 3 onward, not an edge case, and gets polish accordingly.

## 5. Schema reservations

```typescript
// Core entity — slice 0
interface SessionRecord {
  appSessionId: string;              // UUID, ours, permanent
  channel: 'sdk' | 'pty';
  cwd: string;                       // resume must run from here
  claudeSessionIds: Array<{ id: string; jsonlPath: string; observedAt: string }>; // append-only
  liveness: 'spawning'|'running'|'dormant'|'interrupted'|'dead';   // finding D: liveness only
  needsAttention: { reason: 'gate'|'question'|'completed'|'stale'|'quarantined'; since: string } | null;
  seenAt: string | null;             // viewing acks the notification; only action clears needsAttention
  forkedFrom: string | null;         // appSessionId
  taskRef: { taskId: string; stage: string } | null;   // null for free sessions
  observedTtlTier: '1h' | '5m' | 'mixed' | 'unknown';  // rule 0.7, never assumed
  observedBillingBucket: 'interactive' | 'non-interactive' | 'unknown'; // D4
  name: string | null;
  createdAt: string;
}

// Event spine — slice 0. Append-only (I12); enforced by the EventStore interface.
interface EventRecord {
  eventId: string;                   // UUID
  seq: number;                       // per-stream monotonic
  stream: string;                    // appSessionId | 'system' | 'usage' | 'tasks'
  ts: string;
  type: string;                      // 'message'|'tool_call'|'tool_result'|'gate'|'seen'|'attention_cleared'|
                                     // 'spawn'|'exit'|'interrupted'|'task_transition'|'meter_sample'|
                                     // 'usage_block'|'correction_injected'|'auth_rejected'|...
  payload: unknown;                  // typed per event type; message bodies INLINE (D12)
}

// Projection snapshot — slice 0 (finding C)
interface ProjectionSnapshot {
  projectionId: string;              // 'sessions' | 'tasks' | 'meters' | 'stats' | ...
  lastAppliedSeq: Record<string, number>; // per-stream high-water marks
  state: unknown;                    // serialized projection
  savedAt: string;
}

// Task — slice 0 schema, slice 6 system. MVP collapses to: table exists, dispatcher stubbed.
interface TaskRecord {
  taskId: string;
  projectRoot: string;
  stage: 'backlog'|'planning'|'plan-ready'|'implementing'|'review'|'done'|'blocked-external'|'quarantined';
  manualReviewRequired: boolean;
  isolation: 'shared-dir' | 'worktree';                 // D6
  gates: { deferUntilReset?: string; requireHeadroom?: { meterId: string; pct: number } };
  sessionRefs: Array<{ stage: string; appSessionId: string }>;
  createdBy: 'human' | 'orchestrator';
  lastHeartbeatAt: string | null;
  staleRetries: number;
}

// Usage meter — slice 0 schema, slice 5 system. MVP collapses to: JSONL-accounting source only.
interface MeterRecord {
  meterId: string;
  kind: 'rolling-window' | 'weekly-cap' | 'monthly-credit';
  scope: 'all-models' | 'model-family' | 'non-interactive';
  modelFamily: string | null;
  used: number; limit: number | null;                   // null = threshold unknown (JSONL-only source)
  unit: 'tokens' | 'percent' | 'usd';
  resetsAt: string | null;
  source: 'jsonl' | 'otel' | 'endpoint';
  observedAt: string;
  stale: boolean;
}

// Game layer — slice 0 schema, post-MVP system. MVP collapses to: nothing reads it.
interface AchievementProgress {
  achievementId: string;             // definitions are data, shipped later
  progress: number; target: number;
  unlockedAt: string | null;
  sourceEventIds: string[];          // audit trail back to the spine
}
```

## 6. External dependency risk register

| Surface | Documented | Observed | Verify | Isolation plan |
|---|---|---|---|---|
| Claude session IDs | resumable handles | **rotate** on compaction//clear; interactive `--session-id` doesn't control persistence ID | — | never a primary key (I1); mapping table |
| JSONL transcript format & `~/.claude/projects/<encoded-cwd>/` layout | partially documented | stable in practice; partial-line writes during streaming | format drift | single tail-parser module; quarantine-not-crash; golden fixture transcripts pinned per Claude Code version |
| `claude -n` name record in transcript | thinly documented | unconfirmed as correlation key | **VERIFY — slice 2 spike** | correlation isolated in one module; timestamp fallback |
| SDK billing bucket (June 15 non-interactive credit) | "SDK, -p, third-party apps → monthly credit" | **unconfirmed which bucket IDE-spawned SDK sessions hit** | **VERIFY — slice 1 spike, blocks channel-choice defaults** | dual-channel host makes either answer survivable; `observedBillingBucket` per session |
| Cache TTL tiers (1h main / 5m subagent on subscription) | current docs | matches, but regressed silently in March; SDK default has flip-flopped (open issue) | ongoing | rule 0.7 observed tags; nothing asserts a tier, only records it |
| Unofficial usage endpoint (what `/usage` calls) | none | community monitors use it successfully | **VERIFY — slice 5 spike** | fragile adapter; meters degrade to JSONL+OTel |
| OTel telemetry export (OTLP schema) | documented (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) | widely used; schema versions upstream | field coverage | daemon-side loose zod (unknown fields tolerated); http/json pinned via spawn env |
| **Cloudflare Access JWT surface** | JWKS validation of `cf-access-jwt-assertion`, `aud` check | standard in the wild | key-rotation cadence; **Access session expiry breaks WS upgrade with a redirect the WS client can't follow — client-side re-auth bounce required; iOS installed-PWA path awkward, on-device test slice 2** | one auth middleware, single choke point; JWKS cached with refresh |
| **PTY endpoint threat class** | n/a — internal honesty row | **the PTY endpoint is RCE if auth fails**; that is the product working as designed | — | §3.11 middleware in front of everything incl. static; hostile-input probes it every CI run from slice 1 |
| Agent SDK streaming input / interrupt / session listing fns | documented | unconfirmed for mid-run correction injection | **VERIFY — slice 6 spike (D5)** | dispatcher falls back to interrupt+resume |
| node-pty & better-sqlite3 (native modules) | prebuilds per Node ABI | children die with parent (accepted); rebuild needed on Node version change | **node-pty prebuild coverage on Node 24 — verify in slice 0 setup** | `engines` pin + `.nvmrc` + identical CI version; Node bumps gated like Claude Code bumps (fixtures green first) |
| cloudflared WS behavior | supports WS upgrades | works for code-server today | idle-timeout tuning | log-as-buffer makes drops cheap regardless |
| MCP connect/disconnect busts prefix cache | documented | — | — | host never churns MCP connections on live sessions; UI warns |

## 7. Harness & invariants

Headless scenario harness from slice 0: fixture JSONL transcripts, fake process adapters (scripted SDK streams, scripted PTY byte feeds), injected clock. CI runs every scenario **twice**; identical event logs and final projections required, or the run is a failure report. Anything nondeterministic (real Claude, network) lives outside the harness behind adapters and is exercised only in slice-1+ manual gates.

### Invariants

- **I1** (slice 0) — `appSessionId` and all derived state survive Claude session ID rotation: injecting a rotation into a fixture stream changes only the mapping table.
- **I2** (slice 0) — No event lost or duplicated across disconnect: for any `lastSeq`, subscribe delivers exactly `lastSeq+1..head` in order, served from the event log. One path, any gap length. (`resync` exists solely for pre-adoption transcript history, D10.)
- **I3** (slice 1) — Resume never forks: after any dormant-resume, the session's transcript lineage is a single chain; fork requires the explicit fork action and mints a new `appSessionId` with `forkedFrom` set.
- **I4** (slice 0) — Every live process has exactly one registry owner; an orphan scan finds zero unowned Claude processes spawned by the host.
- **I5** (slice 0) — Attention conservation: `needsAttention` is set only by defined structured events, setting it always emits a notification-trigger event, it is cleared only by a deliberate action event (never by viewing, never by restart), and it survives daemon restart byte-identically. Liveness transitions occur only via defined edges.
- **I6** (slice 0) — Replay equivalence: for every fixture, replaying the full log from empty and loading snapshot + tail replay produce byte-identical projections. (From-empty is a harness assertion, not a boot path.)
- **I7** (slice 6) — Task transitions occur only via the dispatcher; orchestrator proposals violating the state machine are rejected and the rejection is evented.
- **I8** (slice 0) — Malformed transcript input never crashes the tail: hostile fixture lines are quarantined with events emitted; parsing resumes at the next valid line.
- **I9** (slice 3) — PTY reconnect conserves bytes: within the ring buffer window ⟨tune⟩, reconnecting renders the identical byte sequence a never-disconnected client saw.
- **I10** (slice 5) — Dispatcher never spawns when a task's `requireHeadroom` gate fails against current meters; the refusal is evented.
- **I11** (slice 1) — Concurrent resume rejected: a resume request against a session with a live run is refused before any process spawns.
- **I12** (slice 0) — The `EventStore` interface admits no update or delete operation; append-only is enforced by type and implementation, not convention. Schema migrations run below the interface as raw SQL (D11) and are the sole sanctioned exception.
- **I13** (slice 0) — Persist-before-broadcast: no event reaches any subscriber before its transaction commits. A client's `lastSeq` is therefore always ≤ log head, under any crash timing.
- **I14** (slice 1) — Auth choke point: every HTTP request and WS upgrade without a valid Access JWT is rejected with zero bytes of product served; rejections are evented (`auth_rejected`).

Precision policy: counted quantities (events, seqs, transitions) assert exact; measured quantities (latencies, tokens-per-window projections) assert within stated tolerance ⟨tune ±10%⟩.

### Scenario profiles

1. **happy-path-desktop** — spawn, converse, tool calls, complete, seen, cleared. Baseline projections.
2. **flaky-mobile** *(degraded-realist)* — client subscribes, drops mid-stream, gate fires while offline (notification event emitted), returns after a short gap, then again after a very long gap; both returns served identically from the log (I2). A slow-client drop via backpressure recovers through the same path (finding E).
3. **concurrent-clash** — two clients on one session; resume attempted mid-run (I11); explicit fork (I3); simultaneous clear-attention actions (single transition, I5).
4. **cold-restart** — host dies mid-run with 3 live sessions, one of them needing attention; restart rediscovers, marks `interrupted`, **attention badge intact** (I5); dormant-resume chains lineage (I3, I4); snapshot+tail boot equals from-empty replay (I6).
5. **hostile-input** — truncated JSONL lines, interleaved partial writes, unknown event types, absurd token counts (I8); path-traversal filenames in upload API; **unauthenticated and forged-JWT probes against HTTP, WS upgrade, and the PTY endpoint** (I14).
6. **budget-wall** — meters approach caps mid-workflow; threshold notification event; `requireHeadroom` task refused (I10); `deferUntilReset` task fires only after injected-clock reset.

Machine gate: all six pass deterministically, twice, or produce a clear failure report. A scenario that cannot complete is a rule-0.1 finding.

## 8. Budgets — calibrate-then-pin

`--report` mode runs all scenarios plus (post-slice-1) live-probe measurements and prints observations with no assertions. Wes reviews and pins; starting proposal ±25% around observed. Floors as well as ceilings where "too fast" means a path wasn't exercised (e.g., a boot that skipped tail replay).

Design-intent targets to calibrate against (all ⟨tune⟩): reconnect-to-caught-up < 2 s on mobile over tunnel; gate-to-push-delivered < 10 s; cold-start-to-usable-session-list < 5 s (snapshots make this log-size-independent); WS `bufferedAmount` drop threshold; PTY ring buffer 2 MB; JSONL tail latency (append-to-event) < 300 ms; watchdog stale threshold 5 min; meter staleness tolerance 60 s; search first-results < 1 s on ⟨tune house-repo-size⟩; initial mobile JS payload < 300 KB gzipped excluding lazy CM6/xterm chunks — paired with a **deterministic build-manifest CI check** (no calibration): CM6 and xterm land in separate lazy chunks and the entry chunk imports neither.

## 9. Slice plan

**Slice 0 — Headless core & harness.**
*Scope:* SessionRecord/EventRecord/ProjectionSnapshot/TaskRecord/MeterRecord schemas + `schema_version` row; event spine (SQLite, append-only EventStore, persist-before-broadcast); log-as-buffer subscribe protocol (in-memory transport); projection snapshots + tail replay; `replay --to <projection>` debug command; liveness × attention model; JSONL tail parser against golden fixtures; fake SDK/PTY adapters; scenario runner, all six profiles; `--report`; CI double-run gate; **setup verification: node-pty prebuild coverage on Node 24** (finding F).
*Explicitly out:* any real Claude process, any UI, any network, the migration harness (D11 — convention documented, machinery waits for its first migration).
*Assertions:* I1, I2, I4, I5, I6, I8, I12, I13.
*Exit gate:* machine — six scenarios green twice.
*Kill criterion:* none — slice 0 cannot fail, only find.

**Slice 1 — Find the value: one real session on a phone.**
*Scope:* minimal daemon (Hono + WS, static serving) **with the Access-JWT middleware live from the first request** (§3.11, I14); Cloudflare Access configured on the tunnel hostname; minimal mobile page (session stream, send message, answer a gate, resume button). One hand-configured project, n=1. **Spikes first:** (a) D4 billing-bucket — spawn one SDK-hosted and one PTY-hosted session, run identical small workloads, observe which meters move via /usage before/after; (b) SDK session-listing/resume surface check. Real-world I3/I11 verification: resume dormant, attempt concurrent resume, confirm no fork in `~/.claude/projects/`.
*Explicitly out:* editor, search, files, tasks, push, polish.
*Assertions:* I3, I11 against real transcripts; I14 against the live daemon (hostile-input auth probes run against it in CI).
*Exit gate:* human — a full workday driven from the phone page against a real project: gates answered, disconnects survived, one dormant resume, zero forks, **and every unauthenticated probe rejected**.
*Kill criterion:* **if resume forks, reconnect loses events, or the phone loop feels worse than SSH at n=1 — stop; the core promise isn't landing and no amount of IDE on top fixes it.** Secondary: if D4 shows SDK sessions burn the non-interactive credit *and* PTY-hosted interactive proves unviable, halt for a topology decision record.

**Slice 2 — Session surface.**
*Scope:* session-list home screen from JSONL discovery (including terminal-started sessions, read-only-live per D10); spawn/kill/name; seen/clear attention flow; liveness + attention badges; PWA manifest + web push on `needsAttention`; onboarding with deliberate notification-permission tap. **Spikes:** (a) PTY↔JSONL correlation via `claude -n` (D7); (b) push reality-check on actual devices — **locked-phone delivery timing specifically, Declarative Web Push (iOS 18.4+) evaluated against SW-based push**, and the Access-expiry re-auth bounce inside the installed iOS PWA.
*Explicitly out:* editor, tasks, meters beyond raw token counts.
*Assertions:* I5 end-to-end (gate → push event → tap → seen → action → cleared).
*Exit gate:* human — one week where no gate goes unnoticed past ⟨tune 60 s⟩ while phone is in pocket.
*Kill criterion:* if push delivery through the PWA proves unreliable on his devices, halt — pillar 5 needs a decision record (fallback: ntfy/Telegram adapter behind the same trigger events), not a workaround.

**Slice 3 — Workspace. → MVP line.**
*Scope:* CM6 editor + file tree; upload (dialog + drag-drop) and download (file + zipped folder); ripgrep search with tap-to-open; preview-diff replace; raw PTY shell with reconnect buffer (binary frames); mobile keyboard toolbar; interrupted-recovery polish (§4 beat 7 becomes daily reality here).
*Explicitly out:* git panel, LSP-anything, multi-pane layouts.
*Assertions:* I9; hostile-input upload assertions; build-manifest lazy-chunk check (§8).
*Exit gate:* human — code-server retired for one full week of daily work, desktop and mobile.
*Kill criterion:* if CM6 mobile editing is not comfortably better than code-server-on-mobile for real edits, halt and reassess the editor layer before building more on it.

**MVP = slices 0–3, deployable as 0.1.** Release discipline: golden fixture transcripts + full scenario suite green before every tag; a fixture refresh accompanies every Claude Code version bump; Node version bumps gated identically.

**Slice 4 (0.2) — Git & cache observability.**
*Scope:* git status/diff/stage/commit, hunk-level mobile diffs; observed TTL-tier + billing-bucket badges; per-session cache hit rate; cache-vandal warnings.
*Assertions:* tier tags derived exclusively from usage-block events (rule 0.7 checked by fixture).
*Exit gate:* human — agent diff review done from phone comfortably.
*Kill criterion:* none structural; scope-creep watch only.

**Slice 5 (0.3) — Usage service.**
*Scope:* meter model + three adapters (JSONL, OTel direct-ingest with loose schema, endpoint-probe **spike**); home-screen meters, burn rate, projections, reset countdowns; threshold notifications.
*Assertions:* I10 groundwork (meter reads); staleness degradation.
*Exit gate:* machine (budget-wall scenario against live adapters in replay) + human (meters match /usage within ⟨tune 5%⟩ for a week).
*Kill criterion:* if the unofficial endpoint is gone *and* JSONL/OTel can't produce trustworthy window estimates, halt — meters that lie are worse than none (pillar 4).

**Slice 6 (0.4) — Task system.**
*Scope:* task DB + state machine + deterministic dispatcher; stage runs through session host (every card → live session); watchdog/quarantine; convergence exit; kanban UI; course-correction injection (**spike:** D5 streaming-input); D6 isolation flag.
*Assertions:* I7, I10; watchdog scenario added to suite.
*Exit gate:* human — one real feature shipped end-to-end through the board with at least one mid-run correction.
*Kill criterion:* if correction injection fails both paths (streaming-input and interrupt+resume) such that corrections require killing runs, halt — the inspect-and-steer promise is the point of the rework.

**Slice 7 (0.5) — Orchestration.**
*Scope:* MCP surface for orchestrator agents (task CRUD/promote/comment/read-summary/read-meters); usage-gated promotion; orchestrator activity feed.
*Assertions:* I7 hardened against hostile/malformed orchestrator proposals (extend hostile-input).
*Exit gate:* human — an orchestrator plans and promotes a small multi-task feature overnight within its credit budget.
*Kill criterion:* if orchestrator-written tasks are consistently worse than human-written ones at this scale, park the layer — the task system stands alone.

**Post-MVP horizon (sketched, not scoped):** game layer (achievements, streaks, live stats over the spine); event-log archival/compaction once growth data exists (D12 accepted inline growth); keep-warm pinger for API-billed runs if ever relevant; multi-project workspaces; multi-machine session hosts; read-write attach to terminal-started sessions; product-ization (real auth/user system, multi-user).

## 10. Decision records

### Resolved

- **D2 — Process topology. RESOLVED: one daemon + static UI bundle.** The split's only protection was sessions surviving web-layer restarts — but during slices 1–6 the code that churns is the registry and session-host logic itself, which forces restarts of the process-owning layer under either topology, and the web layer is static middleware that will never change independently. The split bought nothing; `interrupted` + one-tap resume (§4 beat 7) is the real mitigation and is promoted to daily UX. Registry stays transport-agnostic (in-memory for harness, WS for prod).
- **D9 — Ack semantics. RESOLVED by the liveness × attention split (finding D):** viewing sets `seenAt` (acknowledges the notification, stops re-alerting); only deliberate action clears `needsAttention`. A glance never silently clears "needs you."

### Open

- **D1 — Working title.** "Vimes" proposed and un-objected through one red-pen round; treated as provisionally settled, rename at will.
- **D3 — Deployment.** Bare-host under systemd (leaning) vs Docker-with-mounts. The host must spawn `claude`, read `~/.claude`, and touch project dirs. Reopens if a dedicated dev container becomes the environment itself.
- **D4 — Channel billing buckets.** ⚠ **verify-before-building, slice 1 spike.** Which meter do IDE-spawned SDK sessions burn: interactive 5h window or the $100/mo non-interactive credit? If non-interactive → PTY-hosted becomes the daily-driver default, SDK reserved for task/orchestration runs (which *want* the isolated credit); if interactive → SDK default everywhere, PTY stays the escape hatch. The dual-channel host survives either answer; the *defaults* depend on it.
- **D5 — Course-correction mechanism.** Streaming-input SDK injection vs interrupt+resume-with-correction. Spike inside slice 6, injection preferred.
- **D6 — Worker isolation default.** shared-dir (cache-warm, write races possible) vs worktree (isolated, cache-cold). Leaning: per-task flag, default shared-dir with dispatcher-serialized write stages.
- **D7 — PTY↔JSONL correlation.** ⚠ verify, slice 2 spike: does `claude -n <name>` reliably land a matchable name record in the transcript? Fallback: newest-file-after-spawn with per-project spawn serialization.
- **D8 — Usage endpoint adapter.** ⚠ verify, slice 5 spike: capture what `/usage` calls; wrap as fragile adapter. Reopens (happily) if Anthropic ships the requested official endpoint.
- **D10 — Terminal-started session attach depth.** Read-only-live (JSONL tail) for MVP + "adopt on next resume" (when it goes dormant, resuming through the IDE brings it under host ownership). The `resync` marker (§3.2) exists solely for these sessions' pre-adoption history.
- **D11 — Migration convention (new).** Migrations are pure functions over golden fixture DBs, run as raw SQL **below** the EventStore interface (the sole sanctioned I12 exception); the migration harness is built when the first real migration exists to run through it, not before. Convention is binding now; machinery waits for its consumer.
- **D12 — Event log body storage (new; finding C).** Message bodies **inline** in the log + projection snapshots for boot (leaning, near-settled): transcript-refs would make replay depend on Anthropic's files surviving, which rule 0.6 refuses. Cost: log growth (multi-GB/year at heavy use), accepted and revisited with real growth data post-MVP (archival/compaction in the horizon). Snapshots keep cold start flat regardless.

---

*End of draft 2. Everything marked ⟨tune⟩ is a placeholder awaiting the §8 procedure. Red-pen at will.*
