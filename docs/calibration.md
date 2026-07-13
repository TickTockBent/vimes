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

Remaining slice-ordered queue: D4 billing buckets + SDK resume-surface check (slice 1); D7
`claude -n` correlation + push delivery timing + iOS PWA re-auth bounce
(slice 2); D8 usage endpoint capture (slice 5); D5 streaming-input injection
(slice 6). Results land here dated, with method; decisions they force move to
decisions.md.

## Invariants

I1–I14 are specified in spec §7 with the slice each lands in. Slice 0 brings
I1, I2, I4, I5, I6, I8, I12, I13 under test. Exact where counted (events, seqs,
transitions); relative-epsilon where measured (latencies, projections).
