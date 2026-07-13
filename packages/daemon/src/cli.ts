import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_PROFILES,
  CountingIdSource,
  SteppingClock,
  canonicalJson,
  metersProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  runScenario,
  sessionsProjection,
  tasksProjection,
  type Projection,
  type ScenarioArtifact,
  type ScenarioProfile,
} from '@vimes/core';
import { SqliteEventStore } from './sqliteEventStore.js';

// Hand-rolled CLI (no new deps): `scenarios --check`, `scenarios --report`,
// `replay --to <projectionId> --db <path>`.

const PROJECTIONS_BY_ID: Record<string, Projection<unknown>> = {
  [sessionsProjection.id]: sessionsProjection as Projection<unknown>,
  [metersProjection.id]: metersProjection as Projection<unknown>,
  [tasksProjection.id]: tasksProjection as Projection<unknown>,
};

// The comparable blob for the double-run gate: event-log dump + projection
// serializations + observed counters. Byte-identical across both runs is the gate.
function comparableArtifact(artifact: ScenarioArtifact): string {
  return canonicalJson({
    eventLog: artifact.eventLog,
    projections: artifact.projections,
    counters: artifact.counters,
  });
}

function runProfileToFile(profile: ScenarioProfile, path: string): ScenarioArtifact {
  const artifact = runScenario(profile);
  writeFileSync(path, comparableArtifact(artifact), 'utf8');
  return artifact;
}

// scenarios --check : each profile twice, artifacts written and byte-compared.
function scenariosCheck(): number {
  const scratchDir = mkdtempSync(join(tmpdir(), 'vimes-scenarios-'));
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];
  try {
    for (const profile of ALL_PROFILES) {
      const firstPath = join(scratchDir, `${profile.name}.run1.json`);
      const secondPath = join(scratchDir, `${profile.name}.run2.json`);
      try {
        runProfileToFile(profile, firstPath);
        runProfileToFile(profile, secondPath);
        const firstBytes = readFileSync(firstPath, 'utf8');
        const secondBytes = readFileSync(secondPath, 'utf8');
        const identical = firstBytes === secondBytes;
        results.push({
          name: profile.name,
          pass: identical,
          detail: identical ? 'byte-identical' : 'ARTIFACTS DIFFER between runs',
        });
      } catch (thrown) {
        results.push({
          name: profile.name,
          pass: false,
          detail: `threw: ${(thrown as Error).message}`,
        });
      }
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const nameWidth = Math.max(...results.map((result) => result.name.length), 8);
  process.stdout.write('scenarios --check (double-run byte-compare)\n');
  for (const result of results) {
    process.stdout.write(
      `  ${result.pass ? 'PASS' : 'FAIL'}  ${result.name.padEnd(nameWidth)}  ${result.detail}\n`,
    );
  }
  const allPassed = results.every((result) => result.pass);
  process.stdout.write(allPassed ? 'ALL PROFILES PASS\n' : 'ONE OR MORE PROFILES FAILED\n');
  return allPassed ? 0 : 1;
}

// scenarios --report : run once, print observations. ZERO assertions.
function scenariosReport(): number {
  const rows = ALL_PROFILES.map((profile) => {
    const artifact = runScenario(profile);
    const perStream = artifact.counters.eventsPerStream;
    const totalEvents = Object.values(perStream).reduce((sum, count) => sum + count, 0);
    const maxStreamEvents = Object.values(perStream).reduce((max, count) => Math.max(max, count), 0);
    return {
      name: profile.name,
      totalEvents,
      streams: Object.keys(perStream).length,
      replayWindow: maxStreamEvents,
      quarantines: artifact.counters.quarantines,
      rawBytes: artifact.counters.rawBytes,
      snapshotBytes: artifact.counters.snapshotBytes,
    };
  });

  const columns: Array<{ header: string; value: (row: (typeof rows)[number]) => string }> = [
    { header: 'profile', value: (row) => row.name },
    { header: 'events', value: (row) => String(row.totalEvents) },
    { header: 'streams', value: (row) => String(row.streams) },
    { header: 'replay-window', value: (row) => String(row.replayWindow) },
    { header: 'quarantines', value: (row) => String(row.quarantines) },
    { header: 'raw-bytes', value: (row) => String(row.rawBytes) },
    { header: 'snapshot-bytes', value: (row) => String(row.snapshotBytes) },
  ];

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
  );

  process.stdout.write('PREVIEW — nothing pinned; see docs/calibration.md\n\n');
  const headerLine = columns.map((column, index) => column.header.padEnd(widths[index]!)).join('  ');
  process.stdout.write(`${headerLine}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) {
    const line = columns.map((column, index) => column.value(row).padEnd(widths[index]!)).join('  ');
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

// replay --to <projectionId> --db <path> : rebuild one projection from a log file.
function replay(args: string[]): number {
  let projectionId: string | undefined;
  let dbPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--to') {
      projectionId = args[index + 1];
      index += 1;
    } else if (args[index] === '--db') {
      dbPath = args[index + 1];
      index += 1;
    }
  }
  if (projectionId === undefined || dbPath === undefined) {
    process.stderr.write('usage: replay --to <projectionId> --db <path>\n');
    return 1;
  }
  const projection = PROJECTIONS_BY_ID[projectionId];
  if (projection === undefined) {
    process.stderr.write(
      `unknown projection '${projectionId}' (known: ${Object.keys(PROJECTIONS_BY_ID).join(', ')})\n`,
    );
    return 1;
  }
  // Read-only use: the clock/ids are required by the store constructor but only
  // consumed on append, which replay never does.
  const store = new SqliteEventStore({
    path: dbPath,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  try {
    const state = replayFromEmpty(projection, readAllStreamsGrouped(store));
    process.stdout.write(`${projection.serialize(state)}\n`);
    return 0;
  } finally {
    store.dispose();
  }
}

function main(argv: string[]): number {
  const command = argv[2];
  if (command === 'scenarios') {
    const mode = argv[3];
    if (mode === '--check') {
      return scenariosCheck();
    }
    if (mode === '--report') {
      return scenariosReport();
    }
    process.stderr.write('usage: scenarios --check | scenarios --report\n');
    return 1;
  }
  if (command === 'replay') {
    return replay(argv.slice(3));
  }
  process.stderr.write('usage: <scenarios --check|--report> | <replay --to <projectionId> --db <path>>\n');
  return 1;
}

process.exit(main(process.argv));
