#!/usr/bin/env node
// ─── weekly cost snapshot (deliberately NOT fancy) ─────────────────────────
//
// Reads the durable cost ledger (~/.vimes/cost-ledger.db, READ-ONLY — this
// script never writes to it) and appends/refreshes one JSON line per session
// in ~/.vimes/cost-history.jsonl, keyed idempotently by sessionId. Rows come
// straight from the store, which is already deduped by the daemon's ingest —
// this script does NOT re-run dedupeUsageRowsGlobally.
//
// INVARIANT: a session's line always reflects that session's ENTIRE row
// history, and lines are NEVER removed. Every run re-aggregates every
// session in the ledger from ALL of its rows (no windowed/partial query) —
// the DB is tiny (dozens of sessions, tens of thousands of rows), so a full
// recompute costs milliseconds and windowing buys nothing but the risk of a
// partial aggregate silently overwriting and destroying a session's earlier
// history. A session already on disk that the current ledger no longer
// produces (e.g. after a prune/rotation) is left untouched, never dropped —
// that's the whole point of keeping this file.
//
// Prices with the SHIPPED pipeline (priceUsageRow + SLICE_5B_PRICE_TABLE from
// packages/core/dist/index.js) — no hand-rolled arithmetic. Every line carries
// the RAW TOKEN fields plus priceTableDate: D31 leaves the Opus rate under a
// known unresolved 3x uncertainty, so history must stay re-priceable from raw
// tokens if that rate is ever corrected. A line carrying only dollars would be
// worthless the moment the rate moves. Pillar 4: a non-priced row still counts
// toward statusCounts and token totals — it just never contributes a dollar,
// never a silent $0.
//
// Usage:
//   node scripts/cost-snapshot.mjs               full recompute (every run, cron or manual)
//   node scripts/cost-snapshot.mjs --all         same thing, spelled out explicitly
//   node scripts/cost-snapshot.mjs --out <path>  override the data file
//
// There is no windowed/"--since-days" mode: every run recomputes every
// session from its full history, so a time window would only add code for
// zero benefit (see INVARIANT above).
//
// Weekly cron (Monday 03:00 local, Node 24 via nvm). NOT installed by this
// script — paste into `crontab -e` yourself after review:
//   0 3 * * 1 /bin/bash -lc '. ~/.nvm/nvm.sh && nvm use 24 >/dev/null && node /home/ticktockbent/projects/infrastructure/vimes/scripts/cost-snapshot.mjs' >> ~/.vimes/cost-snapshot.log 2>&1

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDirectory);

const WEEKLY_CRON_LINE =
  "0 3 * * 1 /bin/bash -lc '. ~/.nvm/nvm.sh && nvm use 24 >/dev/null && node " +
  path.join(repoRoot, 'scripts/cost-snapshot.mjs') +
  "' >> ~/.vimes/cost-snapshot.log 2>&1";

function parseCommandLineArguments(argv) {
  let outputPath = path.join(os.homedir(), '.vimes/cost-history.jsonl');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--all') {
      // Every run is already a full recompute — this flag is accepted for
      // explicitness/backward-compat but changes nothing. See INVARIANT above.
    } else if (argument === '--out') {
      index += 1;
      outputPath = argv[index];
      if (!outputPath) throw new Error('--out needs a path');
    } else {
      throw new Error(`unrecognized argument: ${argument}`);
    }
  }
  return { outputPath };
}

function emptyTokenAndDollarFields() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    pricedNanoDollars: 0,
  };
}

async function main() {
  console.log('weekly cron line (NOT installed — paste into `crontab -e` yourself after review):');
  console.log(WEEKLY_CRON_LINE);

  const { outputPath } = parseCommandLineArguments(process.argv.slice(2));

  // better-sqlite3 is not a new dependency: resolve it from the daemon's own
  // node_modules rather than adding a root-level install.
  const daemonRequire = createRequire(path.join(repoRoot, 'packages/daemon/package.json'));
  const Database = daemonRequire('better-sqlite3');

  // The shipped pricing pipeline, from the built dist — never hand-rolled.
  const coreEntryPointUrl = pathToFileURL(path.join(repoRoot, 'packages/core/dist/index.js')).href;
  const { priceUsageRow, SLICE_5B_PRICE_TABLE, PRICE_TABLE_EFFECTIVE_DATE, formatUsd } =
    await import(coreEntryPointUrl);

  const ledgerDatabasePath = path.join(os.homedir(), '.vimes/cost-ledger.db');
  const ledgerDatabase = new Database(ledgerDatabasePath, { readonly: true });

  const SELECT_COLUMNS = `
    sessionId, projectSlug, projectCwd, timestamp, model,
    inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
    cacheCreation5mInputTokens, cacheCreation1hInputTokens, speed, serviceTier, inferenceGeo
  `;
  // Always the FULL row history, never a windowed subset — see INVARIANT in
  // the header comment. This is the fix for the data-corruption bug where a
  // windowed aggregate used to replace (and silently truncate) a session's
  // full-history line.
  const usageRows = ledgerDatabase
    .prepare(`SELECT ${SELECT_COLUMNS} FROM cost_usage_rows ORDER BY sessionId, timestamp`)
    .all();
  ledgerDatabase.close();

  const rowsMissingSessionId = usageRows.filter((row) => row.sessionId === null);
  if (rowsMissingSessionId.length > 0) {
    console.warn(
      `warning: skipping ${rowsMissingSessionId.length} row(s) with no sessionId ` +
        '(this snapshot is per-session; none were observed in the live ledger as of 2026-07-22)',
    );
  }

  const sessionsById = new Map();
  for (const row of usageRows) {
    if (row.sessionId === null) continue;

    let session = sessionsById.get(row.sessionId);
    if (session === undefined) {
      session = {
        sessionId: row.sessionId,
        projectSlug: row.projectSlug,
        projectCwd: row.projectCwd,
        firstTimestamp: row.timestamp,
        lastTimestamp: row.timestamp,
        rowCount: 0,
        byModel: {},
        totals: emptyTokenAndDollarFields(),
        statusCounts: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 },
      };
      sessionsById.set(row.sessionId, session);
    }
    if (row.timestamp < session.firstTimestamp) session.firstTimestamp = row.timestamp;
    if (row.timestamp > session.lastTimestamp) session.lastTimestamp = row.timestamp;
    session.rowCount += 1;

    let modelBucket = session.byModel[row.model];
    if (modelBucket === undefined) {
      modelBucket = emptyTokenAndDollarFields();
      session.byModel[row.model] = modelBucket;
    }

    const pricedRow = priceUsageRow(
      {
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        cacheCreation5mInputTokens: row.cacheCreation5mInputTokens,
        cacheCreation1hInputTokens: row.cacheCreation1hInputTokens,
        speed: row.speed,
        serviceTier: row.serviceTier,
        inferenceGeo: row.inferenceGeo,
      },
      SLICE_5B_PRICE_TABLE,
    );
    session.statusCounts[pricedRow.status] += 1;

    // Raw tokens always accumulate, priced or not (pillar 4). Only a 'priced'
    // status ever adds to pricedNanoDollars — never a silent $0 substitute.
    for (const tokenBucket of [modelBucket, session.totals]) {
      tokenBucket.inputTokens += row.inputTokens;
      tokenBucket.outputTokens += row.outputTokens;
      tokenBucket.cacheReadInputTokens += row.cacheReadInputTokens;
      tokenBucket.cacheCreation5mInputTokens += row.cacheCreation5mInputTokens;
      tokenBucket.cacheCreation1hInputTokens += row.cacheCreation1hInputTokens;
      if (pricedRow.status === 'priced' && pricedRow.amountNanoDollars !== null) {
        tokenBucket.pricedNanoDollars += pricedRow.amountNanoDollars;
      }
    }
  }

  const snapshotAt = new Date().toISOString();
  const sessionsWrittenThisRun = [...sessionsById.values()].map((session) => ({
    ...session,
    totals: { ...session.totals, usd: formatUsd(session.totals.pricedNanoDollars) },
    priceTableDate: PRICE_TABLE_EFFECTIVE_DATE,
    snapshotAt,
  }));

  // Idempotent by sessionId: read whatever is already on disk, key it by
  // sessionId, let this run's sessions replace the matching keys, rewrite the
  // whole file. The file is small (dozens of sessions), so a full rewrite is
  // the simplest correct thing — no append-and-hope.
  const recordsBySessionId = new Map();
  if (fs.existsSync(outputPath)) {
    for (const line of fs.readFileSync(outputPath, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      recordsBySessionId.set(record.sessionId, record);
    }
  }
  for (const session of sessionsWrittenThisRun) {
    recordsBySessionId.set(session.sessionId, session);
  }

  const allRecordsSortedByFirstTimestamp = [...recordsBySessionId.values()].sort((a, b) =>
    a.firstTimestamp < b.firstTimestamp ? -1 : a.firstTimestamp > b.firstTimestamp ? 1 : 0,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    allRecordsSortedByFirstTimestamp.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );

  const totalPricedNanoDollarsThisRun = sessionsWrittenThisRun.reduce(
    (sum, session) => sum + session.totals.pricedNanoDollars,
    0,
  );
  console.log(
    `wrote ${sessionsWrittenThisRun.length} session line(s) this run ` +
      `(${allRecordsSortedByFirstTimestamp.length} total now in ${outputPath}); ` +
      `this run priced ${formatUsd(totalPricedNanoDollarsThisRun)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
