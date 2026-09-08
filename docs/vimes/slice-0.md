# Slice 0 — Headless core & harness (operational plan)

> **Status 2026-07-13:** all four build steps implemented and verified; exit
> gate machine-green (six profiles byte-identical, twice, in ci-gate). 97
> tests. Finding D13 (spawning-at-crash recovery) decided by Wes same day:
> `spawning→interrupted` edge added, cold-restart profile exercises it. First
> `--report` observations recorded in calibration.md (PREVIEW).

*Skeleton designed 2026-07-13; signed off by Wes at kickoff (with D12 → inline
bodies, and finding F verified: Node 24.18.0 / node-pty 1.1.0 /
better-sqlite3 12.11.1 all green — see calibration.md spike record).*

Spec reference: §9 slice 0; assertions **I1, I2, I4, I5, I6, I8, I12, I13**
(spec §7). Exit gate: **machine** — all six scenario profiles green,
deterministically, **twice**. Kill criterion: none — slice 0 cannot fail, only
find (rule 0.1 findings halt and get a decision record).

## Scope / explicitly out

**In:** schemas + `schema_version`; SQLite append-only EventStore;
persist-before-broadcast router; log-as-buffer subscribe (in-memory transport);
projection snapshots + tail replay; `replay --to <projection>` CLI; liveness ×
attention model; JSONL tail parser vs golden fixtures; fake SDK/PTY adapters;
scenario runner + all six profiles; `--report`; CI double-run gate.

**Out:** any real Claude process, any UI, any network (no Hono, no ws — the
router's transport is in-process callbacks), the migration harness (D11: the
`schema_version` row and the convention land; machinery waits for the first
real migration). Backpressure is out (needs sockets — slice 1). Budget
assertions are **PREVIEW only** — nothing ⟨tune⟩ becomes FAIL-able in slice 0
(Gate-D; there is nothing to calibrate against until `--report` runs and Wes
pins).

## Repo shape (stack doc §2)

```
packages/core/      # pure: schemas, EventStore iface + memory impl, router,
                    # liveness×attention, projections, snapshots, JSONL parser,
                    # harness (clock/ids, fake adapters, scenario runner, profiles)
                    # deps: zod ONLY. No node-pty, no sqlite, no ws, no fs.
packages/daemon/    # slice 0 tenants: sqlite EventStore (better-sqlite3, WAL),
                    # replay/report CLI. fs allowed here.
fixtures/           # golden transcripts (synthetic, real-shaped), adapter feeds
scripts/            # ci-gate (double-run + byte-compare), report entrypoint
```

npm workspaces; TypeScript strict ESM; Vitest. `.nvmrc` = 24; `engines`
`>=24 <25`; CI on the identical version. npm 11 allow-scripts: repo carries
the approval for better-sqlite3 + node-pty (finding F wart).

## Determinism contract (rule 0.3 — binding on every module)

- All time from an injected `Clock` (`now(): string` ISO-8601); all IDs from an
  injected `IdSource` (`uuid(): string`). Harness impls are counter-based
  (`00000000-0000-4000-8000-%012d`) and fixed-epoch stepping. **`Date.now()`,
  `Math.random()`, and `crypto.randomUUID()` are banned in core and enforced
  by an ESLint rule (or a grep gate in ci-gate) — not convention.**
- Canonical serialization for all byte-compares: `canonicalJson()` — sorted
  keys, `\n` line terminators, no trailing whitespace. Event-log dumps and
  projection serializations both use it.
- Map/Set iteration must never leak ordering into output; projections sort
  explicitly on serialize.

## Core interfaces (the contract — implementers do not redesign these)

```typescript
// ——— events ———
interface EventInput { stream: string; type: string; payload: unknown }

interface EventRecord {
  eventId: string;      // from IdSource
  seq: number;          // per-stream monotonic, starts at 1
  stream: string;       // appSessionId | 'system' | 'usage' | 'tasks'
  ts: string;           // from Clock
  type: string;
  payload: unknown;     // bodies INLINE (D12)
}

// I12: no update, no delete — the interface admits none.
interface EventStore {
  append(events: EventInput[]): EventRecord[]; // atomic: one txn, all-or-nothing
  read(stream: string, fromSeq: number, toSeq?: number): EventRecord[];
  head(stream: string): number;                // 0 when stream empty
  streams(): string[];
}

// ——— fan-out (I13: append commits BEFORE any subscriber sees anything) ———
type OnEvent = (e: EventRecord) => void;
interface EventRouter {
  emit(events: EventInput[]): EventRecord[];   // store.append() → then notify
  subscribe(stream: string, lastSeq: number, cb: OnEvent): () => void;
  // subscribe: replay lastSeq+1..head synchronously from store, then live.
  // One path, any gap length (I2). No buffering anywhere but the log.
}

// ——— projections ———
interface Projection<S> {
  id: string;                                  // 'sessions' | 'tasks' | 'meters'
  init(): S;
  apply(state: S, e: EventRecord): S;          // pure
  serialize(state: S): string;                 // canonicalJson, sorted
}
interface SnapshotStore {                      // NOT the event log; overwrite allowed
  save(s: ProjectionSnapshot): void;
  load(projectionId: string): ProjectionSnapshot | null;
}
// boot = load snapshot → replay events with seq > lastAppliedSeq[stream]
// I6 (harness assertion, not boot path): from-empty ≡ snapshot+tail, byte-identical
```

`SessionRecord`, `ProjectionSnapshot`, `TaskRecord`, `MeterRecord`,
`AchievementProgress` land verbatim from spec §5 as zod schemas + inferred
types. `schema_version` = 1 in a `meta` table (sqlite) / field (memory).

## Liveness × attention (D9 — the exact edge set)

Liveness edges (anything else is a rejected transition, and the rejection is
itself evented as `transition_rejected`):
`spawning→running`, `spawning→interrupted` (D13), `spawning→dead`,
`running→dormant`, `running→interrupted`, `running→dead`, `dormant→spawning`,
`dormant→dead`, `interrupted→spawning`, `interrupted→dead`.

Attention (I5):
- **Set** only by: `gate`, `question`, `run_completed`, `watchdog_stale`,
  `task_quarantined` events → `needsAttention: {reason, since}`. Every set
  emits `notification_trigger` in the same `emit()` batch.
- **`seen` event** sets `seenAt` only. Never touches `needsAttention`.
- **Clear** only by: `attention_cleared {cause: 'gate_answered' | 'dismissed'
  | 'run_resumed'}`. Restart never clears (cold-restart scenario asserts
  byte-identical attention after reload).

## JSONL tail parser (core, pure)

`class TranscriptTail { push(chunk: string): TailOutput[] }` — chunk-fed,
line-buffered (partial trailing line held until its newline arrives).
Outputs: `{kind:'record', json}` | `{kind:'quarantined', raw, reason}` (I8 —
malformed JSON, oversize line ⟨tune 1 MB PREVIEW⟩) | `{kind:'rotation',
newClaudeSessionId}` when the record's sessionId differs from the last seen
(I1 — consumer appends to `claudeSessionIds[]` mapping; nothing else changes).
Unknown record types pass through as records (loose by design, rule 0.6).
Never throws on input.

## Fixtures (synthetic, real-shaped)

Committed fixtures are **synthetic but shape-verified**: the generator's field
layout is checked against one real transcript from this box during
development (rule 0.7), but no real session content is committed. Pinned with
the Claude Code version they were shaped against.
`fixtures/transcripts/`: `baseline.jsonl`, `rotation.jsonl` (sessionId changes
mid-file), `hostile.jsonl` (truncated line, interleaved partial write, unknown
types, absurd token counts, a 2 MB line). Adapter feeds (scripted SDK
streams, PTY transcript chunks) live as typed TS data modules inside the core
harness — core stays fs-free; only transcripts are files, read daemon-side
(amended at step-4 launch).

## Scenario harness

A scenario is a deterministic script over a `World` = `{clock, ids, store,
router, projections, snapshots, fakeSdk, fakePty, registry}`. Steps: advance
clock, feed adapter script, client ops (`subscribe(lastSeq)` / `disconnect` /
`seen` / `clear` / `resumeAttempt`), `restart` (drop everything in-memory,
reload from store+snapshots — simulates daemon death), checkpoint asserts.
**Restart semantics (settled in step-2 review):** the `restart` step preserves
the World's `Clock` and `IdSource` instances — the world's physics survive a
daemon death; only in-memory state drops. In production the daemon injects a
crypto-UUID source (determinism-exempt, daemon-side only, never in core), so
eventId uniqueness across real restarts comes from the source, not the store.
Output artifact per run: canonicalJson event-log dump + all projection
serializations. The six profiles from spec §7 land verbatim (calibration.md
table). **budget-wall note:** dispatcher is a stub whose only slice-0 duty is
refusing on `requireHeadroom` vs the meters projection and honoring
`deferUntilReset` against the injected clock — enough for the profile to
complete; I10 hardens in slice 5.

`--report`: run all profiles, print observed counts/sizes (events per stream,
replay window sizes, quarantine counts, snapshot sizes), **zero assertions**.
`replay --to <projection>` (daemon CLI): rebuild one projection from a log,
print serialized state — the debug tool I6 makes trustworthy.

CI gate (`scripts/ci-gate`): typecheck → unit tests → each profile **twice**
→ byte-compare the two artifacts → grep gate for banned nondeterminism.

## Build order (sequential agents; I verify + gate between each)

| # | Step | Model | Delivers | Assertions brought under test |
|---|---|---|---|---|
| 1 | Scaffold | sonnet | workspaces, tsconfig strict ESM, vitest, .nvmrc/engines, allow-scripts approval, empty packages compiling, ci-gate skeleton, .gitignore | — (toolchain green) |
| 2 | Event spine | opus | zod schemas (§5 verbatim) + `schema_version`; EventStore iface; memory impl (core) + sqlite impl (daemon: WAL, `(stream,seq)` unique index, **UPDATE/DELETE-raising triggers on `events`**); EventRouter | I2, I12 (type-level + trigger probe), I13 (instrumented-store ordering test + crash-between-commit-and-broadcast sim) |
| 3 | Domain model | opus | `canonicalJson()` in core (daemon's local serializer swaps to it); domain event vocabulary (zod payloads); liveness edge machine + attention rules; sessions projection; meters/tasks stub projections; SnapshotStore iface + memory impl + tail replay (sqlite snapshots wait for their consumer — the boot path, slice 1); TranscriptTail parser + record→event mapper; three hand-written fixtures | I1, I5, I6, I8 |
| 4 | Harness | opus | fake SDK/PTY adapters + feeds; ownership registry + orphan scan; scenario runner; six profiles; `--report`; `replay --to`; ci-gate completed (double-run byte-compare + grep gate) | I4 + all six profiles green twice |

**Cross-stream commutativity (settled in step-3 review):** replay/boot fold
streams in sorted-grouped order (`readAllStreamsGrouped`); live application
folds in emit order. Therefore every projection's final state MUST be
independent of cross-stream interleaving (per-stream order is guaranteed;
cross-stream order is not). Step 4 asserts this directly: fold each profile's
log in grouped order AND in reversed-stream-grouped order → byte-identical
serialize() for every projection. A projection that needs cross-stream
ordering is a rule-0.1 finding.

**Attention batch rule (settled in step-2 review):** the attention-setting
event and its `notification_trigger` are emitted adjacently in ONE append
batch; the I5 log assertion is "every attention-setting event at seq N has
`notification_trigger` at seq N+1 on the same stream." Guarded edges are
enforced at the *emitter* (registry/world — rule 0.3); projections stay total
consumers of whatever the log says; the I5 edge assertion is a scan over the
log, not a projection-side rejection.

Fixes found in my verification go to a fresh agent, not my hands. Commit
boundaries after each verified step — **commits made when Wes asks** (git
discipline). Checkpoint file per agent in its job tmp dir.

## What would be a finding (not a bug to patch)

Sqlite trigger enforcement conflicting with WAL/txn behavior; replay-from-log
unable to satisfy I2 without an in-memory buffer after all; attention state
not surviving the restart step byte-identically; the six profiles requiring
network or fs beyond the daemon package; canonical serialization unable to make
double-runs byte-identical (hidden nondeterminism). Any of these: halt, dated
decision record, then continue.
