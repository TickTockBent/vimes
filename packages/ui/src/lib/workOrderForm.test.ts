import { describe, expect, it } from 'vitest';
import { buildWorkOrderBody, type WorkOrderFormModel } from './workOrderForm.js';

// S7·3 — the pure body builder. This is where ABSENT-STAYS-ABSENT is enforced
// (the .vue is manual per house rule), so these tests are the guard that a blank
// box never becomes an empty-string field on the birth record.

function formModel(overrides: Partial<WorkOrderFormModel> = {}): WorkOrderFormModel {
  return {
    scope: '',
    explicitlyOut: [],
    acceptanceCriteria: [],
    killCriterion: '',
    ...overrides,
  };
}

describe('buildWorkOrderBody', () => {
  it('a fully-authored form yields the full fragment, criteria mapped to { text }', () => {
    const body = buildWorkOrderBody(
      formModel({
        scope: 'fold the authoring form onto the board',
        explicitlyOut: ['the amend path', 'the plan tools'],
        acceptanceCriteria: ['both suites pass', 'ids minted server-side'],
        killCriterion: 'the descriptor cannot be served without importing core',
      }),
    );

    expect(body).toEqual({
      scope: 'fold the authoring form onto the board',
      explicitlyOut: ['the amend path', 'the plan tools'],
      acceptanceCriteria: [{ text: 'both suites pass' }, { text: 'ids minted server-side' }],
      killCriterion: 'the descriptor cannot be served without importing core',
    });
  });

  it('an all-empty form yields {} — an unauthored create, byte-identical to a title-only POST', () => {
    const body = buildWorkOrderBody(formModel());
    expect(body).toEqual({});
    // No key present at all — not even set to undefined (which would change the
    // serialized bytes the store spreads).
    expect('scope' in body).toBe(false);
    expect('explicitlyOut' in body).toBe(false);
    expect('acceptanceCriteria' in body).toBe(false);
    expect('killCriterion' in body).toBe(false);
  });

  it('a list with blank rows keeps only the non-blank rows', () => {
    const body = buildWorkOrderBody(
      formModel({
        explicitlyOut: ['   ', 'kept one', '', '  kept two  '],
        acceptanceCriteria: ['', 'a real criterion', '   '],
      }),
    );

    expect(body.explicitlyOut).toEqual(['kept one', 'kept two']);
    expect(body.acceptanceCriteria).toEqual([{ text: 'a real criterion' }]);
  });

  it('an all-blank list is OMITTED entirely, never sent as []', () => {
    const body = buildWorkOrderBody(
      formModel({ explicitlyOut: ['', '   ', '\t'], acceptanceCriteria: [''] }),
    );
    expect('explicitlyOut' in body).toBe(false);
    expect('acceptanceCriteria' in body).toBe(false);
  });

  it('a whitespace-only prose field is OMITTED, never sent as ""', () => {
    const body = buildWorkOrderBody(formModel({ scope: '   \n\t ', killCriterion: '  ' }));
    expect('scope' in body).toBe(false);
    expect('killCriterion' in body).toBe(false);
  });

  it('prose fields are trimmed, not sent with surrounding whitespace', () => {
    const body = buildWorkOrderBody(
      formModel({ scope: '  build the thing  ', killCriterion: '\tstop if X\n' }),
    );
    expect(body.scope).toBe('build the thing');
    expect(body.killCriterion).toBe('stop if X');
  });

  it('only the authored fields appear — a partial form omits the rest', () => {
    const body = buildWorkOrderBody(formModel({ scope: 'just a scope' }));
    expect(body).toEqual({ scope: 'just a scope' });
  });
});
