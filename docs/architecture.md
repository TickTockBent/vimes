# Architecture

System-shaping structures the design spec did not fully pin: module boundaries,
state lineage, and the constraints that are *not* obvious from reading any single
file. Spun up 2026-07-22, when D34 produced the first constraint that a future
reader would otherwise have to rediscover the hard way.

Entries here are **standing constraints and observations**, not decisions —
decisions live in `decisions.md` and are cited from here.

---

## Projections are STREAM-LOCAL — no projection may fold another stream's events

**Constraint. Established by D34 (2026-07-22), which cost a halted build step.**

`bootFromSnapshot` (`projection.ts:107`) and `readAllStreamsGrouped`
(`projection.ts:53`) fold **each stream to completion before starting the next**,
and `streams()` is alphabetical (`ORDER BY stream ASC` in SQLite, `.sort()` in
memory). There is **no global ordering column in the event log**: `seq` is
per-stream (`UNIQUE(stream, seq)`), and `ts` is not guaranteed unique or
monotonic across streams.

Consequences, in the order they will bite someone:

1. **A projection can only reason about events on the stream(s) it owns.** Folding
   another stream's event is not "slightly out of order" — it is folded in a
   *different phase entirely*, typically before the records that give it meaning
   exist.
2. **Whether it appears to work depends on stream NAMES.** Session streams are
   UUIDv4s, so they sort before `'tasks'`. A prototype using a `zzzz…` stream id
   will pass and the real thing will fail.
3. **It silently breaks I6.** Boot-from-snapshot and replay-from-empty diverge,
   because a tail record folded after a snapshot sees state that a from-empty
   replay has not built yet.
4. **The existing I6 helper does not catch it.** `assertBootEqualsReplayAtCuts`
   cuts an *already-grouped* array, so its cut points cannot reproduce the
   snapshot-contains-the-attach shape a live daemon produces constantly. Treat a
   green I6 as evidence about single-stream folds only.

**If you need a fact from another stream:** put the fact on a record in the stream
that already owns it, and read it from there (this is what D34 chose — the
watchdog's heartbeat lives on the session record, because "when did this session
last append" is a fact about a *session*). Principle 9 points the same way: one
source of record per fact, held where its stream already is.

**If cross-stream folding ever becomes genuinely necessary**, the honest fix is a
global ordering for the log plus a replay that honours it — an event-store
migration touching snapshot semantics under every projection. That is **its own
slice**, never a step inside one.

---

## Module decomposition — watch list

**Observation, not yet a decision. Raised by Wes 2026-07-22 in review.**

| File | Lines (2026-07-22) |
|---|---|
| `packages/daemon/src/sessionHost.ts` | 1236 |
| `packages/daemon/src/app.ts` | 1089 |
| `packages/daemon/src/wsHub.ts` | 791 |

These are the daemon's three largest modules and the most likely to need
splitting. **Deliberately NOT acted on during slice 6:** `sessionHost.ts` is
exactly what steps 6–8 build on, and refactoring it underneath in-flight work
would mix a large mechanical diff with behaviour changes — precisely the shape
that hides a regression.

**Trigger: the slice-6 / slice-7 boundary.** Slice 7's MCP surface is a second
consumer of the same machinery, and a second consumer is what makes the real
seams visible rather than guessed. Decompose then, against two known callers,
with the harness green on both sides of the change.
