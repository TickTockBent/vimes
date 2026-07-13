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

## D4 — Channel billing buckets ⚠ *(trigger: slice 1 spike — blocks channel-choice defaults)*

Which meter do IDE-spawned SDK sessions burn: the interactive 5-hour window or
the $100/mo non-interactive credit? Spike: spawn one SDK-hosted and one
PTY-hosted session, run identical small workloads, observe which meters move
via /usage before/after. If non-interactive → PTY-hosted becomes the
daily-driver default, SDK reserved for task/orchestration runs (which *want*
the isolated credit); if interactive → SDK default everywhere, PTY stays the
escape hatch. **Lean (2026-07-13):** none — genuinely unknown; the dual-channel
host survives either answer, only the *defaults* depend on it. Kill-criterion
adjacency: if SDK burns credit *and* PTY-hosted interactive proves unviable,
slice 1 halts for a topology decision record.

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

