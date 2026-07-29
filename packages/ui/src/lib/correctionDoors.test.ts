import { describe, expect, it } from 'vitest';
import {
  buildAmendmentBody,
  correctionDoors,
  correctionDoorsAvailable,
  seedAmendFormModel,
  type AmendableTaskRecord,
  type AmendFormModel,
} from './correctionDoors.js';

// ─── S7·8 — the two correction doors' pure core (D46/D53) ─────────────────────
//
// House rule: the `.vue` is untested; everything that DECIDES anything lives
// here. The diff builder is the heart of the unit — it is the client-side
// mirror of the amendments route's own `empty-amendment` refusal, and it is
// the ONLY place ABSENT-STAYS-ABSENT is enforced for the amend path.

function record(overrides: Partial<AmendableTaskRecord> = {}): AmendableTaskRecord {
  return { taskId: 'task-1', ...overrides };
}

function formModel(overrides: Partial<AmendFormModel> = {}): AmendFormModel {
  return {
    scope: '',
    explicitlyOut: [],
    acceptanceCriteria: [],
    killCriterion: '',
    ...overrides,
  };
}

describe('seedAmendFormModel', () => {
  it('absent scope/killCriterion seed as empty strings, absent lists as []', () => {
    const seed = seedAmendFormModel(record());
    expect(seed).toEqual({ scope: '', explicitlyOut: [], acceptanceCriteria: [], killCriterion: '' });
  });

  it('a fully-authored record round-trips, criteria carrying their REAL ids', () => {
    const seed = seedAmendFormModel(
      record({
        scope: 'fold the doors onto the board',
        explicitlyOut: ['the orchestrator door'],
        acceptanceCriteria: [
          { id: 'crit-1', text: 'both suites pass' },
          { id: 'crit-2', text: 'no daemon change' },
        ],
        killCriterion: 'the contract looks different than documented',
      }),
    );
    expect(seed).toEqual({
      scope: 'fold the doors onto the board',
      explicitlyOut: ['the orchestrator door'],
      acceptanceCriteria: [
        { id: 'crit-1', text: 'both suites pass' },
        { id: 'crit-2', text: 'no daemon change' },
      ],
      killCriterion: 'the contract looks different than documented',
    });
  });

  it('a malformed criterion (missing id or text) is skipped, not guessed at', () => {
    const seed = seedAmendFormModel(
      record({
        acceptanceCriteria: [
          { id: 'crit-1', text: 'kept' },
          { text: 'no id' },
          { id: 'crit-3' },
          null,
          'not an object',
        ],
      }),
    );
    expect(seed.acceptanceCriteria).toEqual([{ id: 'crit-1', text: 'kept' }]);
  });

  it('a non-array explicitlyOut/acceptanceCriteria degrades to [] rather than throwing', () => {
    const seed = seedAmendFormModel(record({ explicitlyOut: 'not an array', acceptanceCriteria: 42 }));
    expect(seed.explicitlyOut).toEqual([]);
    expect(seed.acceptanceCriteria).toEqual([]);
  });
});

describe('buildAmendmentBody', () => {
  it('an untouched form (edited === seed) yields null — the empty-amendment mirror', () => {
    const seed = formModel({ scope: 'existing scope', explicitlyOut: ['a'], killCriterion: 'stop at X' });
    const edited = formModel({ scope: 'existing scope', explicitlyOut: ['a'], killCriterion: 'stop at X' });
    expect(buildAmendmentBody(seed, edited)).toBeNull();
  });

  it('an all-blank seed and an all-blank edit yields null, not an empty {}-shaped change', () => {
    expect(buildAmendmentBody(formModel(), formModel())).toBeNull();
  });

  it('one changed field omits every other field, and fixes amendedBy: human', () => {
    const seed = formModel({ scope: 'old scope', killCriterion: 'old kill' });
    const edited = formModel({ scope: 'new scope', killCriterion: 'old kill' });
    const body = buildAmendmentBody(seed, edited);
    expect(body).toEqual({ amendedBy: 'human', scope: 'new scope' });
  });

  it('a whitespace-only prose edit is OMITTED as unchanged, never sent as a clear', () => {
    const seed = formModel({ scope: 'kept scope' });
    const edited = formModel({ scope: '   \n\t ' });
    expect(buildAmendmentBody(seed, edited)).toBeNull();
  });

  it('prose fields are trimmed before comparison and before sending', () => {
    const seed = formModel({ scope: 'kept scope' });
    const edited = formModel({ scope: '  kept scope  ' });
    // Trims to the SAME value as the seed → unchanged, omitted.
    expect(buildAmendmentBody(seed, edited)).toBeNull();

    const editedChanged = formModel({ scope: '  a new scope  ' });
    expect(buildAmendmentBody(seed, editedChanged)).toEqual({ amendedBy: 'human', scope: 'a new scope' });
  });

  it('emptying a previously non-empty list is a REAL clear — sent as []', () => {
    const seed = formModel({ explicitlyOut: ['keep this out'] });
    const edited = formModel({ explicitlyOut: [''] });
    expect(buildAmendmentBody(seed, edited)).toEqual({ amendedBy: 'human', explicitlyOut: [] });
  });

  it('clearing an already-empty list is unchanged — omitted, not sent as []', () => {
    const seed = formModel({ explicitlyOut: [] });
    const edited = formModel({ explicitlyOut: ['', '   '] });
    expect(buildAmendmentBody(seed, edited)).toBeNull();
  });

  it('a genuinely changed list is sent trimmed with blank rows dropped', () => {
    const seed = formModel({ explicitlyOut: ['one'] });
    const edited = formModel({ explicitlyOut: ['one', '  two  ', '', 'three'] });
    expect(buildAmendmentBody(seed, edited)).toEqual({
      amendedBy: 'human',
      explicitlyOut: ['one', 'two', 'three'],
    });
  });

  it('rewording a criterion keeps its id — the wire carries {id, text}', () => {
    const seed = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'old wording' }] });
    const edited = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'new wording' }] });
    expect(buildAmendmentBody(seed, edited)).toEqual({
      amendedBy: 'human',
      acceptanceCriteria: [{ id: 'crit-1', text: 'new wording' }],
    });
  });

  it('a new row (id: null) is sent as {text} — never `id: null` on the wire', () => {
    const seed = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'existing' }] });
    const edited = formModel({
      acceptanceCriteria: [
        { id: 'crit-1', text: 'existing' },
        { id: null, text: 'brand new criterion' },
      ],
    });
    const body = buildAmendmentBody(seed, edited);
    expect(body).toEqual({
      amendedBy: 'human',
      acceptanceCriteria: [
        { id: 'crit-1', text: 'existing' },
        { text: 'brand new criterion' },
      ],
    });
    expect(body!.acceptanceCriteria![1]).not.toHaveProperty('id');
  });

  it('dropping a row shrinks the list — a real change, sent without it', () => {
    const seed = formModel({
      acceptanceCriteria: [
        { id: 'crit-1', text: 'keep' },
        { id: 'crit-2', text: 'drop' },
      ],
    });
    const edited = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'keep' }] });
    expect(buildAmendmentBody(seed, edited)).toEqual({
      amendedBy: 'human',
      acceptanceCriteria: [{ id: 'crit-1', text: 'keep' }],
    });
  });

  it('an edit that only adds a blank row cleans away to nothing — still null', () => {
    const seed = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'keep' }] });
    const edited = formModel({
      acceptanceCriteria: [
        { id: 'crit-1', text: 'keep' },
        { id: null, text: '   ' },
      ],
    });
    expect(buildAmendmentBody(seed, edited)).toBeNull();
  });

  it('clearing all criteria on a task that had some is a real clear — sent as []', () => {
    const seed = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: 'only one' }] });
    const edited = formModel({ acceptanceCriteria: [{ id: 'crit-1', text: '  ' }] });
    expect(buildAmendmentBody(seed, edited)).toEqual({ amendedBy: 'human', acceptanceCriteria: [] });
  });

  it('reordering rows counts as a change — the comparison is order-sensitive', () => {
    const seed = formModel({ explicitlyOut: ['first', 'second'] });
    const edited = formModel({ explicitlyOut: ['second', 'first'] });
    expect(buildAmendmentBody(seed, edited)).toEqual({
      amendedBy: 'human',
      explicitlyOut: ['second', 'first'],
    });
  });
});

describe('correctionDoors', () => {
  it('rev defaults to 0 when workOrderRev is absent', () => {
    const doors = correctionDoors(record());
    expect(doors).toEqual([
      { kind: 'steer', title: 'Steer — same work-order', detail: 'rev 0, fresh attempt — dispatches now' },
      {
        kind: 'amend',
        title: 'Amend — revise the work-order',
        detail: 'writes rev 1 — dispatch is a separate step',
      },
    ]);
  });

  it('rev N reads through both doors\' detail strings, steer first', () => {
    const doors = correctionDoors(record({ workOrderRev: 3 }));
    expect(doors[0]).toEqual({
      kind: 'steer',
      title: 'Steer — same work-order',
      detail: 'rev 3, fresh attempt — dispatches now',
    });
    expect(doors[1]).toEqual({
      kind: 'amend',
      title: 'Amend — revise the work-order',
      detail: 'writes rev 4 — dispatch is a separate step',
    });
  });

  it('a malformed workOrderRev (non-number) falls back to 0 rather than throwing', () => {
    const doors = correctionDoors(record({ workOrderRev: 'not a number' }));
    expect(doors[0]!.detail).toBe('rev 0, fresh attempt — dispatches now');
  });
});

describe('correctionDoorsAvailable', () => {
  it('false for a task with no sessionRefs at all', () => {
    expect(correctionDoorsAvailable(record())).toBe(false);
  });

  it('false for a task with an empty sessionRefs array — nothing has run yet', () => {
    expect(correctionDoorsAvailable(record({ sessionRefs: [] }))).toBe(false);
  });

  it('true once the task has run at least once', () => {
    expect(correctionDoorsAvailable(record({ sessionRefs: [{ appSessionId: 's-1', stage: 'implementing' }] }))).toBe(
      true,
    );
  });

  it('a malformed (non-array) sessionRefs reads as not-available rather than throwing', () => {
    expect(correctionDoorsAvailable(record({ sessionRefs: 'not an array' }))).toBe(false);
  });
});
