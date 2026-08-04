import { describe, expect, it } from 'vitest';
import { deriveWorkOrderDisplay, type WorkOrderDisplayRecord } from './workOrderDisplay.js';

// ─── S8·6b — the work-order inspection surface's pure core ────────────────────
//
// House rule: the `.vue` is untested; every DECISION this unit makes lives
// here. `null` on no-fields, per-field absence, criterion id+text passthrough
// (and malformed-entry skip), and workOrderRev in both directions are the
// four assertion families the work order names — one describe block each.

function record(overrides: Partial<WorkOrderDisplayRecord> = {}): WorkOrderDisplayRecord {
  return { ...overrides };
}

describe('deriveWorkOrderDisplay — null on no-fields', () => {
  it('an empty record (a record predating slice 7) is null', () => {
    expect(deriveWorkOrderDisplay(record())).toBeNull();
  });

  it('a record whose four content fields are all blank/empty/malformed is still null', () => {
    expect(
      deriveWorkOrderDisplay(
        record({
          scope: '   ',
          killCriterion: '',
          explicitlyOut: [],
          acceptanceCriteria: [{ id: 'crit-1' }, { text: 'no id' }, null, 'not an object'],
        }),
      ),
    ).toBeNull();
  });

  it('a bare workOrderRev with no content is STILL null — rev alone is not authorship', () => {
    expect(deriveWorkOrderDisplay(record({ workOrderRev: 3 }))).toBeNull();
  });

  it('any ONE content field present is enough to produce a model', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 'do the thing' }))).not.toBeNull();
    expect(deriveWorkOrderDisplay(record({ killCriterion: 'give up if X' }))).not.toBeNull();
    expect(deriveWorkOrderDisplay(record({ explicitlyOut: ['not this'] }))).not.toBeNull();
    expect(
      deriveWorkOrderDisplay(record({ acceptanceCriteria: [{ id: 'crit-1', text: 'passes' }] })),
    ).not.toBeNull();
  });
});

describe('deriveWorkOrderDisplay — per-field absence', () => {
  it('scope: absent/wrong-type/blank all read as null; present reads back UNTRIMMED', () => {
    expect(deriveWorkOrderDisplay(record({ killCriterion: 'k' }))?.scope).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 42, killCriterion: 'k' }))?.scope).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: '   ', killCriterion: 'k' }))?.scope).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: '  fold the doors  ', killCriterion: 'k' }))?.scope).toBe(
      '  fold the doors  ',
    );
  });

  it('killCriterion: absent/wrong-type/blank all read as null; present reads back UNTRIMMED', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 's' }))?.killCriterion).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', killCriterion: [] }))?.killCriterion).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', killCriterion: '\n  ' }))?.killCriterion).toBeNull();
    expect(
      deriveWorkOrderDisplay(record({ scope: 's', killCriterion: 'the contract drifts\n' }))?.killCriterion,
    ).toBe('the contract drifts\n');
  });

  it('explicitlyOut: absent/non-array/all-non-string reads as null (omitted, not a fabricated empty list)', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 's' }))?.explicitlyOut).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', explicitlyOut: 'not an array' }))?.explicitlyOut).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', explicitlyOut: [] }))?.explicitlyOut).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', explicitlyOut: [1, null, {}] }))?.explicitlyOut).toBeNull();
  });

  it('explicitlyOut: present strings pass through, mixed-type arrays drop non-strings', () => {
    expect(
      deriveWorkOrderDisplay(record({ scope: 's', explicitlyOut: ['a', 2, 'b', null] }))?.explicitlyOut,
    ).toEqual(['a', 'b']);
  });

  it('acceptanceCriteria: absent/non-array/all-malformed reads as null (omitted, not a fabricated empty list)', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 's' }))?.acceptanceCriteria).toBeNull();
    expect(
      deriveWorkOrderDisplay(record({ scope: 's', acceptanceCriteria: 'not an array' }))?.acceptanceCriteria,
    ).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', acceptanceCriteria: [] }))?.acceptanceCriteria).toBeNull();
  });

  it('workOrderRev: absent/wrong-type reads as null; a real number passes through', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 's' }))?.workOrderRev).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', workOrderRev: '3' }))?.workOrderRev).toBeNull();
    expect(deriveWorkOrderDisplay(record({ scope: 's', workOrderRev: 0 }))?.workOrderRev).toBe(0);
    expect(deriveWorkOrderDisplay(record({ scope: 's', workOrderRev: 3 }))?.workOrderRev).toBe(3);
  });
});

describe('deriveWorkOrderDisplay — criterion id+text passthrough', () => {
  it('a fully-formed criterion carries BOTH its id and its text through', () => {
    const display = deriveWorkOrderDisplay(
      record({ acceptanceCriteria: [{ id: 'crit-1', text: 'both suites pass' }] }),
    );
    expect(display?.acceptanceCriteria).toEqual([{ id: 'crit-1', text: 'both suites pass' }]);
  });

  it('several criteria keep their own id+text pairs, in order', () => {
    const display = deriveWorkOrderDisplay(
      record({
        acceptanceCriteria: [
          { id: 'crit-1', text: 'first' },
          { id: 'crit-2', text: 'second' },
        ],
      }),
    );
    expect(display?.acceptanceCriteria).toEqual([
      { id: 'crit-1', text: 'first' },
      { id: 'crit-2', text: 'second' },
    ]);
  });

  it('a malformed criterion (missing id, missing text, wrong type, or not an object) is SKIPPED, never guessed at', () => {
    const display = deriveWorkOrderDisplay(
      record({
        acceptanceCriteria: [
          { id: 'crit-1', text: 'kept' },
          { text: 'no id' },
          { id: 'crit-3' },
          { id: 7, text: 'wrong id type' },
          { id: 'crit-5', text: 8 },
          null,
          'not an object',
        ],
      }),
    );
    expect(display?.acceptanceCriteria).toEqual([{ id: 'crit-1', text: 'kept' }]);
  });
});

describe('deriveWorkOrderDisplay — workOrderRev, both directions', () => {
  it('absent workOrderRev on an otherwise-authored record reads as null', () => {
    const display = deriveWorkOrderDisplay(record({ scope: 'do the thing' }));
    expect(display).not.toBeNull();
    expect(display?.workOrderRev).toBeNull();
  });

  it('present workOrderRev on an authored record reads through, including 0', () => {
    expect(deriveWorkOrderDisplay(record({ scope: 's', workOrderRev: 0 }))?.workOrderRev).toBe(0);
    expect(deriveWorkOrderDisplay(record({ scope: 's', workOrderRev: 2 }))?.workOrderRev).toBe(2);
  });
});
