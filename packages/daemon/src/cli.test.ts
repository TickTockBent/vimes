import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  SteppingClock,
  livenessChanged,
  sessionCreated,
} from '@vimes/core';
import { SqliteEventStore } from './sqliteEventStore.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('daemon CLI', () => {
  let scratchDir: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'vimes-cli-test-'));
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('scenarios --check runs the double-run gate and exits 0', () => {
    const result = runCli(['scenarios', '--check']);
    expect(result.stdout).toContain('ALL PROFILES PASS');
    expect(result.status).toBe(0);
  });

  it('replay --to sessions rebuilds the projection from a seeded sqlite log', () => {
    const dbPath = join(scratchDir, 'seed.db');
    const store = new SqliteEventStore({
      path: dbPath,
      clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    });
    store.append([
      sessionCreated({
        appSessionId: APP_SESSION_ID,
        channel: 'sdk',
        cwd: '/home/wes/proj',
        name: 'seeded',
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    store.append([livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'spawn' })]);
    store.dispose();

    const result = runCli(['replay', '--to', 'sessions', '--db', dbPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(APP_SESSION_ID);
    expect(result.stdout).toContain('"liveness":"running"');
    expect(result.stdout).toContain('"channel":"sdk"');
  });
});
