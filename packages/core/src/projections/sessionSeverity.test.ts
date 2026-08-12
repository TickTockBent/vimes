import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput } from '../schemas.js';
import { nodeCreated, type AttentionReason, type Liveness } from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { nodesProjection } from './nodes.js';
import { ATTENTION_SEVERITY_RANKS, rollupNode, type AttentionSeverity } from './nodeRollup.js';
import { sessionSeverityOf } from './sessionSeverity.js';

// ─── S14-A4 — the severity join is TOTAL ─────────────────────────────────────
//
// The whole point of this file is that the table has no holes and no silent
// default. Every row of slice-14.md §3b is written out below as DATA and
// compared against the implementation, so a row that is quietly re-priced fails
// here rather than showing up as a subtree that reads amber when it is red.

const EVERY_LIVENESS: readonly Liveness[] = [
  'spawning',
  'running',
  'dormant',
  'interrupted',
  'dead',
];

const EVERY_ATTENTION_REASON: readonly AttentionReason[] = [
  'gate',
  'question',
  'completed',
  'stale',
  'quarantined',
  'rate-limited',
  'brake',
];

// §3b, verbatim. Attention overrides liveness, so this half needs no liveness
// column: every one of the five liveness values must produce the same answer.
const SEVERITY_BY_ATTENTION_REASON: Readonly<Record<AttentionReason, AttentionSeverity>> = {
  gate: 'gate_fired',
  question: 'waiting_input',
  // A finished run awaiting acknowledgment is a decision, not an error.
  completed: 'waiting_input',
  stale: 'error',
  quarantined: 'error',
  // Reserved, no emitter — ranked AT reservation (E2-b pin 1). Loud beats quiet.
  'rate-limited': 'error',
  brake: 'error',
};

// §3b's fallback half: no attention raised.
const SEVERITY_BY_LIVENESS: Readonly<Record<Liveness, AttentionSeverity>> = {
  spawning: 'working',
  running: 'working',
  dormant: 'idle',
  // An interrupted session awaits a human resume decision.
  interrupted: 'waiting_input',
  // Archaeology. E2-b's processCount, not severity, keeps dead estates honest.
  dead: 'idle',
};

const SOME_INSTANT = '2026-08-12T00:00:00.000Z';

describe('sessionSeverityOf: the §3b table, exactly', () => {
  it('maps every attention reason, and attention OVERRIDES liveness in all five states', () => {
    for (const reason of EVERY_ATTENTION_REASON) {
      for (const liveness of EVERY_LIVENESS) {
        expect(
          sessionSeverityOf(liveness, { reason, since: SOME_INSTANT }),
          `${liveness} + ${reason}`,
        ).toBe(SEVERITY_BY_ATTENTION_REASON[reason]);
      }
    }
  });

  it('maps every liveness state when no attention is raised', () => {
    for (const liveness of EVERY_LIVENESS) {
      expect(sessionSeverityOf(liveness, null), liveness).toBe(SEVERITY_BY_LIVENESS[liveness]);
    }
  });

  // ⚠ THE COMBINATION COUNT IS ASSERTED, not implied. 5 liveness states × (7
  // attention reasons + the unattended case) = 40 combinations, every one of
  // which produces a declared rank. A future enum member makes this number wrong
  // AND makes the switch a compile error — two independent tells.
  it('is total across the whole cross product: 40 combinations, every one ranked', () => {
    const observedSeverities: AttentionSeverity[] = [];
    for (const liveness of EVERY_LIVENESS) {
      observedSeverities.push(sessionSeverityOf(liveness, null));
      for (const reason of EVERY_ATTENTION_REASON) {
        observedSeverities.push(sessionSeverityOf(liveness, { reason, since: SOME_INSTANT }));
      }
    }
    expect(observedSeverities).toHaveLength(40);
    for (const severity of observedSeverities) {
      expect(ATTENTION_SEVERITY_RANKS[severity]).toBeTypeOf('number');
    }
  });

  // The join RANGES OVER the whole declared order — no rank is unreachable, so
  // no rank is dead vocabulary and no rank is missing a row that should reach it.
  it('reaches every rank in the declared order, and nothing outside it', () => {
    const reachable = new Set<AttentionSeverity>();
    for (const liveness of EVERY_LIVENESS) {
      reachable.add(sessionSeverityOf(liveness, null));
      for (const reason of EVERY_ATTENTION_REASON) {
        reachable.add(sessionSeverityOf(liveness, { reason, since: SOME_INSTANT }));
      }
    }
    expect([...reachable].sort()).toEqual(
      Object.keys(ATTENTION_SEVERITY_RANKS).sort(),
    );
  });
});

// ⚠ **UNKNOWN INPUT IS A HARD ERROR, NEVER A SILENT `idle`.** `idle` is the
// quietest rank there is, so guessing it for a state nobody declared is exactly
// the going-dark failure the attention system exists to prevent. These calls go
// through `as` because the type system already refuses them — the point is the
// RUNTIME behaviour for callers outside it (a value off the wire, a JS consumer,
// an older snapshot).
describe('sessionSeverityOf: totality is enforced at runtime too (S14-A4)', () => {
  it('throws on an unrecognized liveness', () => {
    expect(() => sessionSeverityOf('queued' as Liveness, null)).toThrow(/unrecognized liveness/);
  });

  it('throws on an unrecognized attention reason', () => {
    expect(() =>
      sessionSeverityOf('running', { reason: 'vibes' as AttentionReason, since: SOME_INSTANT }),
    ).toThrow(/unrecognized attention reason/);
  });

  it('throws rather than falling back to liveness when the attention object is malformed', () => {
    // A present-but-shapeless attention claim is NOT read as "no attention": the
    // session IS asking for something, and we cannot rank what it asked for.
    expect(() =>
      sessionSeverityOf('dormant', {} as { reason: AttentionReason; since: string }),
    ).toThrow(/unrecognized attention reason/);
  });

  it('reads an ABSENT attention key as unattended, because an old snapshot may lack it', () => {
    // The forgiving half, and the boundary between it and the throwing half:
    // absent means "no such fact was ever recorded", which is a state the fold
    // itself produces for records written before a field existed. A malformed
    // PRESENT claim is a different thing and throws (above).
    expect(
      sessionSeverityOf('running', undefined as unknown as null),
    ).toBe('working');
  });

  it('never returns anything outside the declared order', () => {
    for (const liveness of EVERY_LIVENESS) {
      for (const reason of [...EVERY_ATTENTION_REASON, null]) {
        const severity =
          reason === null
            ? sessionSeverityOf(liveness, null)
            : sessionSeverityOf(liveness, { reason, since: SOME_INSTANT });
        expect(Object.keys(ATTENTION_SEVERITY_RANKS)).toContain(severity);
      }
    }
  });
});

// ─── S14-A4's EMPTY-NODE clause ──────────────────────────────────────────────
//
// Wes's addition to A4: a node with no sessions is a real state on day one for
// every freshly created node. Its rollup is `worst: null` — the wire meaning of
// "nothing to report" — and it is never coerced to `idle`, because "nothing is
// happening here" and "everything here is quiet" are different facts and an
// empty node must not impersonate a calm one.

const PROJECT_ID = 'project-aaaa-0001';
const EMPTY_NODE = 'node-empty-0001';

function nodesStateFrom(events: EventInput[]) {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-12T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  if (events.length > 0) {
    store.append(events);
  }
  return replayFromEmpty(nodesProjection, readAllStreamsGrouped(store));
}

describe('the empty node reports NOTHING, not calm (S14-A4, empty-node clause)', () => {
  it('a freshly created node rolls up to worst: null, processCount: 0', () => {
    const nodes = nodesStateFrom([
      nodeCreated({
        nodeId: EMPTY_NODE,
        parentNodeId: null,
        projectId: PROJECT_ID,
        name: 'fresh',
        provenance: null,
        directory: null,
        nodeConfig: null,
      }),
    ]);
    const rollup = rollupNode(nodes, EMPTY_NODE, () => undefined);
    expect(rollup).toEqual({ worst: null, processCount: 0 });
    // Said twice on purpose: `null` is not `'idle'`, and no consumer may read it
    // as the quietest rank.
    expect(rollup.worst).not.toBe('idle');
    expect(rollup.worst).toBeNull();
  });

  it('an unknown node is the same shape — a rollup never throws and never invents', () => {
    const nodes = nodesStateFrom([]);
    expect(rollupNode(nodes, 'node-nobody-ever-made', () => undefined)).toEqual({
      worst: null,
      processCount: 0,
    });
  });
});
