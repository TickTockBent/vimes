# Calibration — the measurement record

Pinned budgets and bands, probe and spike results, and the measurement methods
that produced them. **Bands are pinned with their assumptions** (workload
profile, device, network condition), never as bare numbers, and never
unreviewed (Gate-D).

## Status

**No bands pinned yet** — the harness is pending (slice 0). Until `--report`
mode runs and Wes prices the results, every ⟨tune⟩ number is a placeholder and
every budget assertion is PREVIEW, never FAIL-able.

## Scenario profiles (measurement instruments)

The six profiles from spec §7. Findings are relational — variants run
side-by-side through multiple profiles, never one alone. CI runs every scenario
twice; byte-identical event logs and final projections required.

| Profile | Script / policy | What it proves |
|---|---|---|
| happy-path-desktop | spawn, converse, tool calls, complete, seen, cleared | baseline projections (regression instrument, not an experience claim) |
| flaky-mobile | subscribe, drop mid-stream, gate fires offline, short-gap and very-long-gap returns; backpressure drop | I2 one-path replay; notification event emitted while offline |
| concurrent-clash | two clients, one session; resume mid-run; explicit fork; simultaneous clear-attention | I11, I3, I5 single-transition |
| cold-restart | host dies mid-run, 3 live sessions, one needing attention; restart | I5 attention survives; I3/I4 on resume; I6 snapshot+tail ≡ from-empty |
| hostile-input | truncated/interleaved JSONL, unknown event types, absurd counts; path-traversal uploads; unauth + forged-JWT probes (HTTP, WS upgrade, PTY) | I8, I14 |
| budget-wall | meters approach caps; threshold crossing; requireHeadroom refusal; deferUntilReset on injected clock | I10; notification events |

## Harness observations (`scenarios --report`, 2026-07-13 — PREVIEW, nothing pinned)

First slice-0 report run. **Assumptions:** in-process harness (MemoryEventStore,
no network, no real processes), synthetic profile workloads, seed epoch fixed —
these are shape/regression baselines, not experience measurements; the §8
latency targets need slice-1 live probes.

| profile | events | streams | replay-window | quarantines | raw-bytes | snapshot-bytes |
|---|---|---|---|---|---|---|
| happy-path-desktop | 12 | 1 | 12 | 0 | 0 | 792 |
| flaky-mobile | 309 | 1 | 309 | 0 | 0 | 847 |
| concurrent-clash | 9 | 2 | 8 | 0 | 0 | 842 |
| cold-restart | 18¹ | 4¹ | 8 | 0 | 0 | 1317¹ |
| hostile-input | 14 | 1 | 14 | 3 | 60 | 943 |
| budget-wall | 14 | 4 | 5 | 0 | 0 | 1298 |

(`replay-window` = largest single-stream event count; `raw-bytes` = FakePty
byte-channel total, exercised-never-parsed per rule 0.8; `snapshot-bytes` = sum
of the three mid-log projection snapshots. ¹ cold-restart re-observed same day
after D13 added the spawning-at-crash session to the profile — was 14/3/838.)

### 2026-07-14 — first real gate round-trip (smoke S5/S6, live daemon)

Real SDK session on Dongfu through the deployed daemon + Access + browser:
spawn → converse (thinking/tool_use/tool_result turn) → Write-gate fired →
answered ALLOW from the UI → file created. Event-log evidence (session
17293cfd): `gate_fired` seq 29 → `notification_trigger` seq 30 (**adjacent —
the I5 batch rule holding in production**) → `attention_cleared` seq 31 with
cause `gate_answered`. Also observed: one turn = several assistant messages
each with an identical usage snapshot (→ D17); default spawned model
`claude-opus-4-8-1m`; gate prompt payload carried just the tool name
("Write") — canUseTool `title` apparently absent; enrichment candidate.

### 2026-07-19 — Slice-2 step-0a hooks spike (CLI 2.1.215 — box auto-updated from 2.1.207 mid-slice)

**Q1 — injection is MERGE, both channels.** Surface: SDK `Options.settings`
(file path or object, "flag settings" tier) + `settingSources`; CLI
`--settings` + `--setting-sources`. A per-session settings file's hooks fire
ALONGSIDE the project's own `.claude/settings.json` hooks for the same event
(verified SessionStart + Stop, PTY and SDK). **D14's project-tier promise
holds under injection.**

**Q2 — D7 correlation complete and deterministic.** Hook payload `session_id`
=== transcript filename === SDK-reported id, every run; the relay URL's
embedded appSessionId token survives untouched; PTY hook subprocesses also
carry `CLAUDE_CODE_SESSION_ID` in env (second confirmation channel — note:
D10's lean said `CLAUDE_SESSION_ID`, observed truth is `CLAUDE_CODE_`
prefix). Hook contract: JSON payload on stdin, bash execution, `CLAUDE*` env
present. Spawn→first-POST latency ~470–550 ms both channels.

**Q3 — golden payload fixtures** captured for SessionStart / Stop /
SessionEnd / PreToolUse (sanitized, `fixtures/hooks/`, stamped 2.1.215).
`StopFailure` unobtainable at spike budget — fixture gap noted for slice 5.

**Q4 —** SessionEnd fires on TUI `/exit` with `reason: "prompt_input_exit"`
(distinguishable — D10's adoption trigger is real); a project's OWN settings
hooks fire for uninjected sessions (the foreign-session adoption path works).

**Version-drift rider:** the box auto-updated the CLI 2.1.207→2.1.215 during
the slice. Fresh-transcript field check: ADDITIVE only (new top-level
`requestId` on assistant records); tail/mapper unaffected; full fixture
re-stamp deferred to the next release gate. This is live evidence for the
ATA runtime-lockfile item (tracker) — the platform updates under us without
asking.

Burn: 5 tiny invocations, low thousands of tokens. Process baseline clean.

### 2026-07-20 — S9/S10 + hooks live-confirmation (second smoke session)

**Hooks channel LIVE in production** (first real confirmation): session
58070f4d received `hook_session_start` (payload `session_id` present +
`appSessionId` stamped by the 4601 ingress) and 11× `hook_pre_tool_use`.
**D7 correlation held live** — exactly ONE `claude_session_mapped` on the
stream despite both SDK-init and hook paths firing (principle 9 dedupe
boundary working). The two synthetically-tested fragile surfaces (settings
hooks-block shape, relay contract) are now real-world validated.

**S9 PASS** — airplane-mode gap mid-stream, session resumed on return via
lastSeq replay.

**S10 — I3 (no fork) PASS on disk; I11 refusal harness-owned.** Two phone
tabs on one session; resume fired in tab A → dormant→spawning→running
(seq 92→95), tab B reflected the resumed state (pillar 2 — viewport, not
owner; it never fired its own resume). `transition_rejected: 0` (no
concurrent attempt occurred), `claude_session_mapped: 1`, and ON DISK a
single transcript (`75e6…a.jsonl`, appended in place) — I3 single-chain
verified, the artifact the slice-1 exit gate wanted. I11's concurrent-resume
REFUSAL was not exercised: the UI withdraws the resume affordance the instant
a session leaves dormant, and human click-timing can't hit the sub-second
spawn window, so the registry refusal has a UI guard in front of it in normal
use. I11 stays proven by the concurrent-clash harness profile (its proper
home for a sub-second race). Note for the on-device checkpoint / slice-2
retro: consider whether a deliberate "force concurrent resume" affordance is
worth building purely for manual I11 demonstration — likely not (harness
owns it).

### 2026-07-20 — slice-3 dogfooding finds (during the push checkpoint session)

- **PASS (real-world spawn allowlist):** spawning a session with a cwd outside
  `VIMES_PROJECT_ROOTS` returns a red `cwd-outside-project-roots` refusal with
  a dismiss button — the path-discipline / spawn-allowlist boundary
  (slice-2 step 2) confirmed live, not just in the harness.
- **BUG (queued, not yet fixed — UI state, slice-2 surface):** after a spawn
  refusal, the spawn button stays in "Spawning…" forever. Cause (high
  confidence): the spawn affordance sets a local pending flag on click and
  clears it on `{op:'spawned'}`, but the `{op:'refused', refusedOp:'spawn'}`
  path never resets it. Fix bundles into the next UI deploy (post-measurement,
  with slice-3 + roots-widening). Any refused op that a button optimistically
  "pended" needs the same reset — audit the store's refused handler for other
  stuck-affordance cases while fixing.

### 2026-07-20 — push pipeline, on-device (Gate-D measurement, DAEMON-SIDE pinned-able)

First real gate-to-push measurement, live daemon + Access + Android PWA.
Gate `15e2faf1` (a Bash/awk gate): `gate_fired` and `notification_trigger`
at the SAME ms (15:53:09.372Z — I5 batch rule live), `push_sent` accepted by
the push service at 15:53:09.478Z. **Daemon-side latency gate→push-accepted
= 106 ms** — the ⟨tune 10s⟩ "gate-to-push-delivered" intent has ~100×
headroom on our side; total gate-to-buzz is dominated by push-service/OS
delivery, not the daemon. **Pipeline proven end-to-end** (Wes saw the bell).
**Dead-subscription prune confirmed live:** a stale sub returned 410 Gone and
was auto-pruned before the live send succeeded (subscriptions 2→1). Push
subscription persistence + suppression path exercised without incident.

**OBSERVED (Wes, 2026-07-20): LOCKED phone, gate-to-buzz "basically instant,
same second easily" (sub-1 s).** This is the spike's flagged worst case
(Android background-delivery throttling on a dozing device) and it delivered
effectively immediately. **Slice-2 kill criterion (push unreliable on
Android → halt) is NOT triggered — the pillar-5 promise lands.** Gate-D
pin-readiness: the ⟨tune 10s gate-to-push-delivered⟩ and ⟨tune 60s
gate-noticed⟩ intents both have enormous margin; **push latency is deliberately UNPINNED (D20):** the real invariant is
qualitative — delivery must not silently fail (confirmed) — not a defended
millisecond band. No FAIL-able assertion on gate-to-buzz. Assumptions of the
observation: single Android device, GitHub-IdP Access session valid, home
tunnel, screen-locked.

### 2026-07-20 — queued findings (slice-3 resume)

- **Test-infra flakiness (rule 0.4 — to harden):** `packages/daemon/src/
  auth.test.ts` I14 matrix (real servers + JWKS crypto + WS upgrades) times
  out at the default 5000 ms under CPU contention — observed 3/3 timeout
  failures during a full-gate run while an agent + the live daemon competed;
  passes 6/6 in isolation and on a quiet box. A flaky test in the CI
  double-run gate is a liability as the suite grows. Fix: raise that test's
  `testTimeout` (like the slice-0 I2 sweep's 30 s). Queued as a rider on the
  next daemon-touching agent.
- **Protocol gap (gate_response refusal correlation):** the `refused`
  envelope carries no `requestId`, so a refused `gate_response` can only be
  recovered UI-side by clearing the WHOLE `answeringRequestIds` set (agent's
  flagged choice). Safe for the minimal one-gate-at-a-time page; imprecise
  once many gates are concurrently pending (a refusal on one re-enables all).
  Precise fix needs `requestId` on the refused envelope (daemon protocol
  addition) — queued for the slice where concurrent gates become real
  (6/7). Accepted as-is for now.

### 2026-07-20 — slice-3 live smoke (desktop, deployed build)

- **#1 editor: PASS** — edited gate-test.txt (dongfu) in CM6, saved (87→125 B,
  mtime confirmed); mtime-precondition write path works live.
- **#2 search: PASS** — searched 'gate', all instances found (real ripgrep).
- **#3 terminal: FAIL → fix in flight.** Root cause: `TerminalView.vue`
  ref-timing deadlock — the xterm mount `<div ref>` is behind `v-else`
  (renders only when `started`), but `start()` null-checks the ref and
  silently returns BEFORE setting `started`, so the element never exists →
  click does nothing, no console error. Fix: set started + `nextTick` before
  mount; make failure paths show a visible error, not silence. Bundled: add
  the missing `GET /api/files/roots` endpoint (step-2 gap) so terminal/tree
  offer the configured `~/projects` roots, not just session cwds.
- **#4 NOT a VIMES bug.** Session cwd was correctly `.../infrastructure/vimes`
  (event log confirms); the AGENT chose the absolute path
  `/home/ticktockbent/desktop-test.md` (gate card surfaced it verbatim, then
  approved). Likely driven by the ambient `~/CLAUDE.md` framing `~` as the
  top-level "cockpit" — VIMES sessions load CLAUDE.md up the whole tree and
  agent writes are gated by permission cards, NOT confined to VIMES roots (by
  design — the agent is a full Claude session; §3 scoping is Claude's job).
  **UX finding (queued):** the Write/Edit gate card shows
  `Write: {"file_path":"...","content":"..."}` truncated at 160 chars — the
  path can be hard to scan and easy to approve unread. Improve gate-card
  rendering to surface the tool's target (file_path) PROMINENTLY, not buried
  in truncated JSON. Not a bug (the gate worked); a real safety-ergonomics
  improvement. Cleanup: a stray `/home/ticktockbent/desktop-test.md` ("PASS")
  exists — Wes to remove at will.

## Budget table (`--report`)

Design-intent targets from spec §8, listed so nothing gets pinned from memory.
All ⟨tune⟩; proposal at pin time is ±25% around observed, floors as well as
ceilings ("too fast" = a path skipped fails like "too slow").

| Measure | Design intent | Observed (profile) | Proposed band | Pinned? |
|---|---|---|---|---|
| reconnect-to-caught-up (mobile, tunnel) | < 2 s | — | — | no — harness pending |
| gate-to-push-delivered | < 10 s | — | — | no |
| cold-start-to-usable-session-list | < 5 s (log-size-independent via snapshots) | — | — | no |
| WS bufferedAmount drop threshold | ⟨tune⟩ | — | — | no |
| PTY reconnect ring buffer | 2 MB | — | — | no |
| JSONL tail latency (append→event) | < 300 ms | — | — | no |
| watchdog stale threshold | 5 min | — | — | no |
| meter staleness tolerance | 60 s | — | — | no |
| search first-results (house repo size) | < 1 s | — | — | no |
| initial mobile JS payload (gzipped, excl. lazy CM6/xterm) | < 300 KB | — | — | no |
| measured-quantity tolerance | ±10% relative | — | — | no |

Deterministic CI check, **no calibration needed** (lands slice 3): build
manifest shows CM6 and xterm in separate lazy chunks; entry chunk imports
neither.

## Spike results

### 2026-07-13 — Node 24 native-module coverage (finding F, slice 0 setup) ✅

**Method:** installed Node 24.18.0 via nvm on the dev box (Ubuntu 24.04);
`npm install node-pty better-sqlite3` in a clean scratch project;
loaded both, spawned a real PTY (`bash -c 'echo pty-ok'`, output captured via
`onData`), opened an in-memory better-sqlite3 DB with `journal_mode = WAL`,
round-tripped a row. **Result:** node-pty@1.1.0 and better-sqlite3@12.11.1 both
build (`pty.node`, `better_sqlite3.node` present) and function under Node
24.18.0 / npm 11.16.0. **The Node 24 pin holds; no fallback to 22.**
**Wart recorded:** npm 11's `allow-scripts` policy blocks both packages'
native install scripts by default — repo setup and CI must approve them
(`npm approve-scripts better-sqlite3 node-pty`) or installs silently skip the
native build. Baked into slice 0 step 1.

### 2026-07-13 — Slice-1 step-0 spikes: D4 billing bucket, SDK surface, fixture shape

**Method:** Claude Code CLI 2.1.207, SDK 0.3.207, isolated scratch project.
`/usage` TUI captured programmatically via node-pty (ANSI-stripped), readings
around identical tiny workloads per channel, two rounds. Raw captures +
scripts + typings citations in the spike job dir (see checkpoint).

**D4 headline: on this Max account, SDK `query()` and PTY interactive burn the
SAME meters** — 5-hour window + weekly caps. No non-interactive monthly credit
movement on either channel (usage-credits feature present but OFF). Kill
criterion's billing branch not triggered.

| Reading | Trigger | 5h window | Week all | Week Fable |
|---|---|---|---|---|
| R0 | baseline (pre-spike; Wes's other work already running) | 89% | 66% | 73% |
| R1+R2 | SDK round (cascade, see below) + PTY round | 95% | 66% | 74% |
| R3 | SDK round, isolated (`settingSources: []`) | 96% | 67% | 74% |
| R4 | PTY round | 96% | 67% | 74% |
| R5 | PTY round (cascade recurred) | 97% ("USAGE CRITICAL" banner) | — | — |

**Finding → D14 (settingSources inheritance):** an SDK `query()` with default
`settingSources` inherits the user's ambient `~/.claude/settings.json` — R1's
"reply ok" became an 8-turn, 6,351-output / 812k-cache-read cascade via Wes's
usage-warning Stop hook (its systemd-run / file-write attempts were all
denied — safe, but the burn was real). `settingSources: []` produced the
clean 4-message exchange. PTY has no such knob (inherits everything, by
design). Burn accounting: total spike burn exceeded plan solely due to this
cascade — which is itself D4-relevant data.

**Finding → D15 (PTY transcript absence):** three PTY-hosted spike sessions
(incl. one clean, patient run, clearly billed) produced NO transcript .jsonl
anywhere the spike could find. Unexplained; not chased at critical usage.
Rule 0.8 makes the JSONL tail the ONLY structure source for PTY sessions —
verify-row before the tailer is trusted (step 2 blocker).

**SDK surface (typings + live tests, citations in spike notes):**
`listSessions()`; `resume` option — **live-verified append-to-same-file, no
fork, no new file** (I3 groundwork); `forkSession` (option + standalone fn);
streaming input via `AsyncIterable` prompt / `Query.streamInput()`; `interrupt()`
(streaming mode required); **`canUseTool` callback is a clean promise-based
gate surface** ({title, displayName, requestId} — directly awaitable against
a phone round-trip). CLI: `-n/--name` confirmed (feeds D7). Naming mismatch:
CLI `--permission-mode manual` vs SDK type `default` — fragile-adapter note.

**Fixture shape vs 2.1.207 (SDK-channel transcripts only, per D15):** additive
except one breaking difference — real user records carry `message.content` as
an ARRAY of blocks, fixture has a bare string. Also whole record types absent
from fixtures (`attachment` — majority of lines in one real transcript —
`queue-operation`, `file-history-snapshot`, …); live SDK stream types never
appear in persisted JSONL (it's a strict subset). Action: fixture refresh
task queued (fix user content shape, add representative new record types,
re-stamp 2.1.207).

Remaining slice-ordered queue: D7
`claude -n` correlation + push delivery timing + iOS PWA re-auth bounce
(slice 2); D8 usage endpoint capture (slice 5); D5 streaming-input injection
(slice 6). Results land here dated, with method; decisions they force move to
decisions.md.

## Invariants

I1–I14 are specified in spec §7 with the slice each lands in. Slice 0 brings
I1, I2, I4, I5, I6, I8, I12, I13 under test. Exact where counted (events, seqs,
transitions); relative-epsilon where measured (latencies, projections).
