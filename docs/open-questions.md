# Open questions

Each entry: what needs deciding, the **trigger** that forces the call, and the
**current lean**. When decided, the entry **moves** to
[decisions.md](decisions.md) as a dated `D#` record — it is not edited in place.

These keep the design spec's `D#` numbers (the spec numbered its open decision
records directly); no separate `Q#` series is minted. Entries marked ⚠ are
**verify-before-building** — they are spikes, run at the start of the named
slice, never answered from documentation alone (rule 0.6).

## D1 — Working title *(trigger: first external naming need — repo publish or the 0.1 tag)*

Is "Vimes" the name? Proposed and un-objected through one red-pen round.
**Lean (2026-07-13):** treat as provisionally settled; rename at will before
0.1. Nothing should hard-code the name where a rename would hurt.

<!-- D3 (deployment shape) moved to decisions.md 2026-07-13 — decided:
     bare-host systemd on the host, vimes.example.dev, GitHub IdP. -->

<!-- D4 moved to decisions.md 2026-07-19 — decided: SDK-hosted default everywhere, PTY escape hatch -->

## D5 — Course-correction mechanism ⚠ *(trigger: slice 6 spike)*

Streaming-input SDK injection vs interrupt+resume-with-correction for injecting
a course correction into a live stage run. **Lean (2026-07-13):** injection
preferred; interrupt+resume is the fallback. If *both* fail such that
corrections require killing runs, that is slice 6's kill criterion.

## D6 — Worker isolation default *(trigger: slice 6 — task system build)*

`shared-dir` (cache-warm, write races possible) vs `worktree` (isolated,
cache-cold; cache is scoped to machine+directory). **Lean (2026-07-13):**
per-task flag `isolation: shared-dir | worktree`, default ⟨tune shared-dir⟩
with dispatcher-serialized write phases.

## D7 — PTY↔JSONL correlation ⚠ *(trigger: slice 2 spike)*

Does `claude -n <appSessionId>` reliably land a matchable name record in the
transcript, making it usable as the correlation key between a PTY child and its
JSONL file? **Lean (2026-07-13):** yes, use the name record; fallback is
newest-file-after-spawn-timestamp with single-spawn serialization per project
dir. Correlation logic isolated in one module either way (risk register).
**Lean revised (2026-07-19, jinn-decompose §2.1):** redesign the spike
**hooks-first** — a per-session settings file at spawn registers a
`SessionStart` hook whose relay command carries `appSessionId`; the payload
carries Claude's session id. Deterministic correlation, plus a push-delivered
lifecycle channel (Stop/StopFailure/PreToolUse) consistent with rule 0.8.
`-n` demotes to fallback. Spike must also answer: per-session settings vs
the project's own `.claude/settings.json` — merge or shadow? (The dev box
has real hook configs; one test answers it.) Hook payload schemas are a new
rule-0.6 fragile surface (golden fixtures, risk-register row at next doc
pass).

## D8 — Usage endpoint adapter ⚠ *(trigger: slice 5 spike)*

Capture what the CLI's `/usage` calls; wrap it as a clearly-marked fragile
adapter for authoritative percentages and reset times. **Lean (2026-07-13):**
do it; meters degrade to JSONL+OTel sources when it breaks. Reopens (happily)
if Anthropic ships the requested official endpoint.

## D10 — Terminal-started session attach depth *(trigger: slice 2 — session surface design)*

How deep does the IDE integrate sessions it didn't spawn? **Lean
(2026-07-13):** read-only-live (JSONL tail) for MVP, plus "adopt on next
resume" — when the session goes dormant, resuming through the IDE brings it
under host ownership. The `resync` marker (spec §3.2) exists solely for these
sessions' pre-adoption history.
**Lean upgraded with mechanism (2026-07-19, codor-decompose §2.2 — the
custody trio):** *join* = mirrored member, daemon never writes, inbound
deliveries queue FIFO while custody is external; *adopt* = explicit transfer
OR the `SessionEnd` hook as the sanctioned automatic adoption point (TUI
exits → daemon adopts → drains the queued FIFO); detection via the session's
own env (`CLAUDE_SESSION_ID`) first — which also enables agent
self-registration — newest-file fallback second. Slots into the D7
hooks channel; resolve D10 with this shape at slice 2 design.

## D11 — Migration convention *(trigger: the first real schema migration)*

The convention is binding now: migrations are pure functions over golden
fixture DBs, run as raw SQL **below** the EventStore interface (the sole
sanctioned I12 exception). What stays open is the machinery. **Lean
(2026-07-13):** the migration harness is built when the first real migration
exists to run through it, not before (rule 0.5: machinery waits for its first
consumer). Moves to decisions.md when that first migration lands.

<!-- D12 (event log body storage) moved to decisions.md 2026-07-13 — signed off
     at slice 0 kickoff: inline bodies. -->

<!-- D13 (spawning-at-crash recovery) moved to decisions.md 2026-07-13 —
     decided: add the spawning→interrupted edge. -->

<!-- D14 moved to decisions.md 2026-07-19 — decided: settingSources ['project'], [] for isolated runs -->

## D17 — usage_block granularity: one per SDK assistant message *(trigger: slice 4/5 — cache stats and meter consumers)*

Observed in the first real smoke session (2026-07-14): one turn = several SDK
assistant messages (thinking, tool_use, final text), EACH carrying a usage
snapshot; the host emits a `usage_block` per message, so identical snapshots
repeat within a turn. The log is honest (rule 0.7 — that IS what the SDK
delivered), but naive summation by slice-4/5 consumers would double-count.
**Lean (2026-07-14):** keep the log as-is; consumers dedupe per API turn
(usage snapshots within one turn are identical → collapse on equality or on
message id); UI collapses consecutive identical usage lines (cosmetic,
landing in slice 1).
**Corroborated + sharpened (2026-07-19, jinn-decompose §2.8):** Jinn hit the
same landmine independently — `--effort high` emits two assistant JSONL
lines with the SAME `message.id` and identical usage; their accounting
carries a "dedupe by message.id" fix. **The dedupe key is `message.id`**,
not payload equality (equality is the weaker proxy we guessed). Binding on
the slice-5 usage adapter from its first line; the host's `usage_block`
payload should carry `message.id` through so consumers can key on it —
check whether it already does before slice 4/5.

<!-- D15 (PTY transcript absence) moved to decisions.md 2026-07-13 —
     resolved: inherited CLAUDE* env suppresses transcripts; PTY channel
     scrubs env; tailer trusted on that basis. -->

