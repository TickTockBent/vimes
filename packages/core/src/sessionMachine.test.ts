import { describe, expect, it } from 'vitest';
import type { EventRecord } from './schemas.js';
import {
  LIVENESS_EDGES,
  assertAttentionBatchRule,
  assertLogRespectsEdges,
  canTransition,
} from './sessionMachine.js';
import { CountingIdSource, SteppingClock } from './ids.js';
import { MemoryEventStore } from './memoryEventStore.js';
import {
  gateFired,
  livenessChanged,
  sessionCreated,
  withNotificationTrigger,
  type Liveness,
} from './events.js';

const ALL_LIVENESS: Liveness[] = ['spawning', 'running', 'dormant', 'interrupted', 'dead'];

const DEFINED_EDGES: Array<[Liveness, Liveness]> = [
  ['spawning', 'running'],
  ['spawning', 'interrupted'],
  ['spawning', 'dead'],
  ['running', 'dormant'],
  ['running', 'interrupted'],
  ['running', 'dead'],
  ['dormant', 'spawning'],
  ['dormant', 'dead'],
  ['interrupted', 'spawning'],
  ['interrupted', 'dead'],
];

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

describe('sessionMachine liveness edges', () => {
  it('allows every defined edge', () => {
    for (const [from, to] of DEFINED_EDGES) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('refuses a sample of undefined edges (everything not in the defined set)', () => {
    const definedSet = new Set(DEFINED_EDGES.map(([from, to]) => `${from}->${to}`));
    const refused: Array<[Liveness, Liveness]> = [];
    for (const from of ALL_LIVENESS) {
      for (const to of ALL_LIVENESS) {
        if (!definedSet.has(`${from}->${to}`)) {
          refused.push([from, to]);
        }
      }
    }
    // Includes dead->anything, self-loops, spawning->dormant, running->spawning, etc.
    expect(refused.length).toBeGreaterThan(0);
    for (const [from, to] of refused) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it('dead is terminal — no outgoing edges', () => {
    expect(LIVENESS_EDGES.get('dead')?.size).toBe(0);
  });
});

describe('assertLogRespectsEdges', () => {
  it('passes on a log of only defined transitions', () => {
    const store = makeStore();
    const appSessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
    store.append([
      sessionCreated({
        appSessionId,
        channel: 'sdk',
        cwd: '/home/user/project',
        name: null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    store.append([livenessChanged({ appSessionId, to: 'running', cause: 'spawned' })]);
    store.append([livenessChanged({ appSessionId, to: 'dormant', cause: 'idle' })]);
    store.append([livenessChanged({ appSessionId, to: 'spawning', cause: 'resume' })]);

    const records = store.read(appSessionId, 1);
    expect(assertLogRespectsEdges(records).violations).toEqual([]);
  });

  it('catches a planted illegal transition (dormant->running is undefined)', () => {
    const store = makeStore();
    const appSessionId = 'aaaaaaaa-0000-4000-8000-000000000002';
    store.append([
      sessionCreated({
        appSessionId,
        channel: 'sdk',
        cwd: '/home/user/project',
        name: null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    store.append([livenessChanged({ appSessionId, to: 'running', cause: 'spawned' })]);
    store.append([livenessChanged({ appSessionId, to: 'dormant', cause: 'idle' })]);
    // Illegal: dormant -> running is not a defined edge.
    store.append([livenessChanged({ appSessionId, to: 'running', cause: 'bogus' })]);

    const result = assertLogRespectsEdges(store.read(appSessionId, 1));
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ from: 'dormant', to: 'running' });
  });

  it('flags a liveness_changed with no prior session_created start', () => {
    const store = makeStore();
    const appSessionId = 'aaaaaaaa-0000-4000-8000-000000000003';
    store.append([livenessChanged({ appSessionId, to: 'running', cause: 'orphan' })]);
    const result = assertLogRespectsEdges(store.read(appSessionId, 1));
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ from: null, to: 'running' });
  });
});

describe('assertAttentionBatchRule', () => {
  const appSessionId = 'aaaaaaaa-0000-4000-8000-000000000004';

  it('passes when every setter is immediately followed by notification_trigger (helper-built)', () => {
    const store = makeStore();
    store.append([
      sessionCreated({
        appSessionId,
        channel: 'sdk',
        cwd: '/home/user/project',
        name: null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    store.append(withNotificationTrigger(gateFired({ appSessionId, prompt: 'approve?' })));

    const records = store.read(appSessionId, 1);
    expect(assertAttentionBatchRule(records).violations).toEqual([]);
  });

  it('fails when a setter lacks its adjacent notification_trigger (hand-built)', () => {
    const store = makeStore();
    store.append([
      sessionCreated({
        appSessionId,
        channel: 'sdk',
        cwd: '/home/user/project',
        name: null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    // Setter with NO trigger following it.
    store.append([gateFired({ appSessionId, prompt: 'approve?' })]);

    const records = store.read(appSessionId, 1);
    const result = assertAttentionBatchRule(records);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ followedByType: null });
  });
});
