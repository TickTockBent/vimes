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
