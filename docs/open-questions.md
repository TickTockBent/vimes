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

<!-- D7 moved to decisions.md 2026-07-19 — decided: hooks-first correlation,
     -n demoted to unused fallback. -->

## D8 — Usage endpoint adapter ⚠ *(trigger: slice 5 spike)*

Capture what the CLI's `/usage` calls; wrap it as a clearly-marked fragile
adapter for authoritative percentages and reset times. **Lean (2026-07-13):**
do it; meters degrade to JSONL+OTel sources when it breaks. Reopens (happily)
if Anthropic ships the requested official endpoint.

<!-- D10 moved to decisions.md 2026-07-19 — decided: mirrored custody,
     adopt on resume or SessionEnd; attention never fires for mirrored. -->

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

## D24 — billing-bucket classification: not derivable from the usage block alone *(trigger: slice 4 cache observability; surfaced designing step 2, 2026-07-20)*

Slice 4 wants a **billing-bucket badge** (the interactive 5-hour window vs the
$100 non-interactive monthly credit — spec §3.6) to answer Wes's standing
question "did the dongfu runs burn the 5-hour limit or the $100 automation
bucket?" **Finding while designing step 2:** the bucket is NOT cleanly
derivable from a `usage_block` alone. Spike-C's real sample carries
`service_tier: "standard"` — a *service tier*, not the *billing bucket*.
Whether a run draws on the $100 non-interactive credit depends on session
**interactivity / how it was spawned** (headless automation vs interactive),
which is a SESSION property, not a usage-block field. Classifying a bucket
from `service_tier` alone would be declared-truth guessing — exactly what rule
0.7 forbids.
**Lean (2026-07-20):** step 2 classifies **TTL tier** (cleanly observable) +
numeric cache stats, and captures `service_tier` **raw** as an observed field,
but emits **no fabricated bucket label**. The bucket classifier waits for an
observation spike that correlates `service_tier` × session interactivity ×
known-ground-truth billing (the dongfu automation runs are in `events.db` —
candidate spike data, though ground-truth attribution is the missing piece).
The reserved `billing_bucket_observed` event + session `observedBillingBucket`
field stay stubbed until that spike lands. Settle into a decision (which signal
combination classifies the bucket) when the spike runs — likely slice 5 with
the meter system, where billing buckets become first-class.

Related: **D17** (usage_block granularity) is now BINDING on step 2 — the
cache-observability projection MUST dedupe usage snapshots by `message.id`
(identical snapshots repeat within a turn; naive summation double-counts).

