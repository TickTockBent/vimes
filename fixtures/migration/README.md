# Migration fixture — S10·Move-0 (D72)

`tasks-stream.jsonl` + `tasks-state.json` are the **migration fixture**
D72/migration-map.md §2.3 calls for as "Move 0 (before anything): freeze the
fixture" (open question 22, DEFAULT TAKEN: exported, before move 1). Every
later seam-first migration step (D72 moves 1-3 — the manifest parser/registry,
the instance-store re-home, adjudication reading the pinned declaration) is
checked against this fixture: "refactors are free, behaviour is the test."

## Source

`~/.vimes/events.db` (better-sqlite3, opened `{ readonly: true }` — never
written to), the `tasks` stream, **exported 2026-08-06**: exactly **111
events, seq 1-111**, contiguous, all `stream: 'tasks'`. This is the Gate-2
trial's complete recorded behaviour on that stream as of the export moment —
the daemon that owns this database is LIVE and keeps appending, so this
fixture is a snapshot, not a live view.

## Files

- **`tasks-stream.jsonl`** — the 111 events verbatim, one JSON object per
  line, ordered by `seq`. Each line is exactly the `EventRecord` shape
  (`packages/core/src/schemas.ts` `eventRecordSchema`): `eventId`, `seq`,
  `stream`, `ts`, `type`, `payload` — the same six columns `PRAGMA
  table_info(events)` reports for the `events` table (confirmed against the
  live DB at export time; no other columns exist, no `ALTER TABLE` migrations
  were found anywhere in the repo). `payload` is `JSON.parse`d from the
  table's TEXT column (mirroring `sqliteEventStore.ts`'s own
  `rowToEventRecord`), not left as a doubly-encoded string.
- **`tasks-state.json`** — the frozen projected state: the 111 events folded
  through `tasksProjection` (`packages/core/src/projections/tasks.ts`) from
  `init()`, then its own `serialize()` (the `canonicalJson` path the
  projection itself uses). The bytes in this file are exactly what
  `serialize()` produced — no reformatting, no added trailing newline.

## Export method (reproducible)

Run from the repo root, node 24 (`. ~/.nvm/nvm.sh && nvm use 24`), against the
**readonly**-opened production database:

```js
// export-tasks-stream.mjs — run as:
//   node --input-type=module - <outPath> < export-tasks-stream.mjs
// (cwd = repo root, so `import Database from 'better-sqlite3'` resolves the
// workspace root's node_modules)
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.vimes', 'events.db');
const db = new Database(dbPath, { readonly: true });

const columns = db.prepare('PRAGMA table_info(events)').all();
const expectedColumns = ['eventId', 'stream', 'seq', 'ts', 'type', 'payload'];
if (JSON.stringify(columns.map((c) => c.name)) !== JSON.stringify(expectedColumns)) {
  console.error('UNEXPECTED events table schema:', columns);
  process.exit(1);
}

const rows = db
  .prepare("SELECT eventId, stream, seq, ts, type, payload FROM events WHERE stream = 'tasks' ORDER BY seq ASC")
  .all();

if (rows.length !== 111) { console.error(`expected 111 rows, got ${rows.length}`); process.exit(1); }
for (let i = 0; i < rows.length; i++) {
  if (rows[i].seq !== i + 1) { console.error(`seq gap at index ${i}: ${rows[i].seq}`); process.exit(1); }
  if (rows[i].stream !== 'tasks') { console.error(`row ${i} has stream ${rows[i].stream}`); process.exit(1); }
}

const lines = rows.map((row) => JSON.stringify({
  eventId: row.eventId,
  seq: row.seq,
  stream: row.stream,
  ts: row.ts,
  type: row.type,
  payload: JSON.parse(row.payload),
}));

writeFileSync(process.argv[2], lines.join('\n') + '\n', 'utf8');
db.close();
```

`tasks-state.json` was produced by loading `tasks-stream.jsonl`, folding it
through `tasksProjection.init()` / `.apply()` (imported from the built
`packages/core` output, current with HEAD at export time per a clean `npm run
typecheck`), and writing `tasksProjection.serialize(state)` verbatim — folded
independently a second time in the same run to confirm determinism before
freezing (the two serializations were byte-identical).

## The byte-identity contract

`packages/core/src/projections/tasksFixtureReplay.test.ts` loads
`tasks-stream.jsonl`, folds it through **today's** `tasksProjection`, and
asserts the result is **byte-identical** to `tasks-state.json` — plus a
determinism check (two independent fold runs of the fixture events must
themselves be byte-identical). This is S10-A1 (`docs/slice-10.md`).

## This fixture is FROZEN

It is **never regenerated to make a test pass.** If
`tasksFixtureReplay.test.ts` ever reddens because the fold no longer
reproduces these exact bytes, that is a **rule-0.1 finding** (an
undocumented behaviour change slipped into the fold) — `docs/slice-10.md`'s
Move-0 kill criterion: "the frozen fixture does NOT replay byte-identical
through today's fold → the fold is nondeterministic → rule-0.1 finding, slice
halts." A legitimate, reviewed, *intentional* change to the projection's
output shape is a new dated fixture with its own decision record, not a
silent re-export over this one.

## Secret scrub

Every payload in `tasks-stream.jsonl` was read before freezing. It contains
real trial content — work-order prose, plan text, and review/completion
reports from three of the operator's own projects the trial's task machine
ran against (`infrastructure/vimes`, `infrastructure/johnny`,
`games/1e9999` — all already-documented cross-project use, see
`fixtures/ask-user-question/README.md`'s "johnny orchestrator transcript"
precedent). Scanned for credentials, API keys, tokens, private-key material,
JWTs, SSH keys, emails, IP addresses, and hostnames: **nothing found.** The
only near-hits were benign: the literal word "token" in "tailwind token" (a
CSS design token, not a credential), two mentions of `.env` in prose about
setting `DATABASE_URL` for an unrelated Prisma project (no value present),
and several 64-hex-character `planArtifactHash` fields (SHA-256 content
hashes, an expected schema field, not secrets).
