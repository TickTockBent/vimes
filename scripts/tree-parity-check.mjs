#!/usr/bin/env node
// ─── S14 exit gate, mechanical half — the tree against REALITY ───────────────
//
// slice-14.md §6: "a script against the LIVE db (readonly): every session in the
// sessions projection appears EXACTLY ONCE in the /api/tree payload — S14-A1 run
// against reality rather than fixtures; the one place real data gets checked."
//
// Fixtures prove the composition is correct for the shapes somebody thought to
// write down. This proves it against the shapes HISTORY actually produced: a
// log with sessions whose projects were archived, sessions whose cwd resolves
// nowhere, sessions from before half the schema existed. The interesting
// failures live there and nowhere else.
//
// ⚠ **STRICTLY READ-ONLY, AND THIS IS THE ONLY SCRIPT IN THE UNIT THAT OPENS
// THE LIVE DB AT ALL.** The handle is `{ readonly: true }`, so SQLite itself
// refuses a write rather than this file merely promising not to attempt one.
// Nothing here appends, snapshots, migrates or repairs; a violation is REPORTED
// and the exit code carries it. (The db also defends itself — `events` has
// append-only triggers — but a readonly handle is the honest way to ask.)
//
// ⚠ **THE FOLD IS THE SHIPPED ONE.** Projections and `treeOf` are imported from
// packages/core/dist — never re-implemented here. A parity check that
// re-derived the tree would be checking its own arithmetic; this one checks the
// code that actually serves `GET /api/tree`.
//
// Engine words only (#16) — this lands in the public repo.
//
// Usage:
//   node scripts/tree-parity-check.mjs               the live db (~/.vimes/events.db)
//   node scripts/tree-parity-check.mjs --db <path>   a copy, or another host's
//
// Exit codes: 0 = parity holds. 1 = a violation (a session missing from the
// payload, or appearing twice). 2 = the check could not run at all.
//
// Node 24 (nvm): `. ~/.nvm/nvm.sh && nvm use 24 && node scripts/tree-parity-check.mjs`

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDirectory);

function parseCommandLineArguments(argv) {
  let databasePath = path.join(os.homedir(), '.vimes/events.db');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--db') {
      index += 1;
      databasePath = argv[index];
      if (!databasePath) throw new Error('--db needs a path');
    } else {
      throw new Error(`unrecognized argument: ${argument}`);
    }
  }
  return { databasePath };
}

// Every leaf in the payload, with WHERE it was found — the location is what
// turns "this session appears twice" from a number into something a human can
// go and look at.
function collectSessionLeafPlacements(tree) {
  const placements = [];
  const walkNodes = (nodes, trail) => {
    for (const node of nodes) {
      for (const leaf of node.sessions) {
        placements.push({ appSessionId: leaf.appSessionId, at: `${trail} / ${node.name}` });
      }
      walkNodes(node.nodes, `${trail} / ${node.name}`);
    }
  };
  for (const root of tree.roots) {
    for (const leaf of root.sessions) {
      placements.push({ appSessionId: leaf.appSessionId, at: `${root.rootId} (root)` });
    }
    walkNodes(root.nodes, root.rootId);
  }
  return placements;
}

async function main() {
  const { databasePath } = parseCommandLineArguments(process.argv.slice(2));

  // better-sqlite3 is not a new dependency: resolve it from the daemon's own
  // node_modules rather than adding a root-level install (the cost-snapshot.mjs
  // precedent).
  const daemonRequire = createRequire(path.join(repoRoot, 'packages/daemon/package.json'));
  const Database = daemonRequire('better-sqlite3');

  // The SHIPPED core, from the built dist. If this import fails, the dist is
  // stale or absent — run `npm run typecheck` (which builds through project
  // references) first.
  const coreEntryPointUrl = pathToFileURL(path.join(repoRoot, 'packages/core/dist/index.js')).href;
  const {
    treeOf,
    nodesProjection,
    projectsProjection,
    sessionsProjection,
    replayFromEmpty,
    UNFILED_ROOT_ID,
  } = await import(coreEntryPointUrl);

  console.log(`tree parity check — ${databasePath} (READONLY)`);

  // ⚠ READONLY. See the header.
  const eventDatabase = new Database(databasePath, { readonly: true });
  // ORDER BY stream, seq mirrors `readAllStreamsGrouped` exactly (streams in
  // name order, each stream in seq order), so this fold sees the same record
  // sequence the daemon's own reads see. Not an approximation of it — the same
  // order, spelled out.
  const eventRows = eventDatabase
    .prepare('SELECT eventId, stream, seq, ts, type, payload FROM events ORDER BY stream ASC, seq ASC')
    .all();
  eventDatabase.close();

  const eventRecords = eventRows.map((row) => ({
    eventId: row.eventId,
    stream: row.stream,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload: JSON.parse(row.payload),
  }));
  console.log(`  ${eventRecords.length} events across the log`);

  const projects = replayFromEmpty(projectsProjection, eventRecords);
  const nodes = replayFromEmpty(nodesProjection, eventRecords);
  const sessions = replayFromEmpty(sessionsProjection, eventRecords);

  const projectCount = Object.keys(projects.projects).length;
  const liveProjectCount = Object.values(projects.projects).filter(
    (project) => !project.archived,
  ).length;
  const nodeCount = Object.keys(nodes.nodes).length;
  const sessionIds = Object.keys(sessions.sessions);
  console.log(
    `  ${projectCount} projects (${liveProjectCount} live), ${nodeCount} nodes, ${sessionIds.length} sessions`,
  );

  // The payload exactly as `GET /api/tree` serves it — unscoped, so every root
  // is in scope and no session can be missing merely because it was filtered.
  const tree = treeOf(projects, nodes, sessions);
  const placements = collectSessionLeafPlacements(tree);

  // ── the census ────────────────────────────────────────────────────────────
  console.log('');
  console.log('  per-root census (sessions in the subtree / processes counted / worst):');
  for (const root of tree.roots) {
    const rootSessionCount = placements.filter((placement) =>
      placement.at === `${root.rootId} (root)` ? true : placement.at.startsWith(`${root.rootId} /`),
    ).length;
    const marker = root.rootId === UNFILED_ROOT_ID ? ' *' : '  ';
    console.log(
      `${marker} ${root.rootId.padEnd(48)} ${String(rootSessionCount).padStart(4)}  ` +
        `${String(root.rollup.processCount).padStart(4)}  ${root.rollup.worst ?? '-'}`,
    );
  }
  console.log('  * the unfiled root — sessions no LIVE project boundary claims (F2)');

  // ── the assertion: EXACTLY ONCE (S14-A1 against reality) ─────────────────
  const placementCountBySessionId = new Map();
  for (const placement of placements) {
    const existing = placementCountBySessionId.get(placement.appSessionId) ?? [];
    existing.push(placement.at);
    placementCountBySessionId.set(placement.appSessionId, existing);
  }

  const missingSessionIds = sessionIds.filter(
    (appSessionId) => !placementCountBySessionId.has(appSessionId),
  );
  const duplicatedSessionIds = [...placementCountBySessionId.entries()].filter(
    ([, locations]) => locations.length > 1,
  );
  // A leaf for a session the projection does not hold would mean the tree
  // invented one. `treeOf` cannot do it (it renders `null` for an attachment
  // whose record is absent), so observing it here would be a finding about the
  // composition rather than about the data.
  const strangerSessionIds = [...placementCountBySessionId.keys()].filter(
    (appSessionId) => sessions.sessions[appSessionId] === undefined,
  );

  console.log('');
  console.log(
    `  ${sessionIds.length} sessions in the projection, ${placements.length} leaves in the payload`,
  );

  let violationCount = 0;
  for (const appSessionId of missingSessionIds) {
    violationCount += 1;
    const session = sessions.sessions[appSessionId];
    console.error(
      `  VIOLATION missing: ${appSessionId} (cwd ${session.cwd}) appears in NO root of the payload`,
    );
  }
  for (const [appSessionId, locations] of duplicatedSessionIds) {
    violationCount += 1;
    console.error(
      `  VIOLATION duplicate: ${appSessionId} appears ${locations.length}x — ${locations.join(' | ')}`,
    );
  }
  for (const appSessionId of strangerSessionIds) {
    violationCount += 1;
    console.error(`  VIOLATION stranger: ${appSessionId} is a leaf but the sessions fold has no record`);
  }

  if (violationCount > 0) {
    console.error('');
    console.error(`FAIL — ${violationCount} violation(s) of S14-A1 against the live log.`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('OK — every session in the projection appears EXACTLY ONCE in the tree payload.');
}

main().catch((error) => {
  console.error(`tree-parity-check could not run: ${error.message}`);
  process.exitCode = 2;
});
