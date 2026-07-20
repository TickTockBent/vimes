import { describe, expect, it } from 'vitest';
import {
  initialSaveConflictState,
  isDirty,
  reduceSaveConflict,
  type SaveConflictState,
} from './saveConflict.js';

function drive(state: SaveConflictState, ...actions: Parameters<typeof reduceSaveConflict>[1][]): SaveConflictState {
  return actions.reduce(reduceSaveConflict, state);
}

describe('reduceSaveConflict — clean/dirty/saving/conflict/resolved', () => {
  it('starts clean and not dirty', () => {
    const state = initialSaveConflictState('hello', 100);
    expect(state.status).toBe('clean');
    expect(isDirty(state)).toBe(false);
  });

  it('an edit that changes content goes dirty; reverting goes back to clean', () => {
    const start = initialSaveConflictState('hello', 100);
    const dirty = reduceSaveConflict(start, { type: 'edit', content: 'hello!' });
    expect(dirty.status).toBe('dirty');
    expect(isDirty(dirty)).toBe(true);
    const reverted = reduceSaveConflict(dirty, { type: 'edit', content: 'hello' });
    expect(reverted.status).toBe('clean');
    expect(isDirty(reverted)).toBe(false);
  });

  it('save is a no-op unless dirty', () => {
    const clean = initialSaveConflictState('x', 1);
    expect(reduceSaveConflict(clean, { type: 'save' }).status).toBe('clean');
  });

  it('dirty → save → save_ok returns to clean with the new mtime as the baseline', () => {
    const state = drive(
      initialSaveConflictState('a', 100),
      { type: 'edit', content: 'ab' },
      { type: 'save' },
      { type: 'save_ok', mtime: 200 },
    );
    expect(state.status).toBe('clean');
    expect(state.mtime).toBe(200);
    expect(state.savedContent).toBe('ab');
    expect(isDirty(state)).toBe(false);
  });

  it('captures the saving snapshot: an edit during save leaves it dirty against what was written', () => {
    let state = drive(initialSaveConflictState('a', 100), { type: 'edit', content: 'ab' }, { type: 'save' });
    expect(state.status).toBe('saving');
    // User keeps typing while the PUT is in flight.
    state = reduceSaveConflict(state, { type: 'edit', content: 'abc' });
    expect(state.status).toBe('saving');
    // The save of 'ab' lands; buffer is 'abc' so we are dirty again.
    state = reduceSaveConflict(state, { type: 'save_ok', mtime: 200 });
    expect(state.status).toBe('dirty');
    expect(state.savedContent).toBe('ab');
    expect(state.currentContent).toBe('abc');
  });

  it('a 409 goes to conflict and stashes the fresh mtime', () => {
    const state = drive(
      initialSaveConflictState('a', 100),
      { type: 'edit', content: 'ab' },
      { type: 'save' },
      { type: 'save_conflict', mtime: 555 },
    );
    expect(state.status).toBe('conflict');
    expect(state.conflictMtime).toBe(555);
    expect(isDirty(state)).toBe(true);
  });

  it('overwrite from conflict re-enters saving with the fresh mtime as precondition', () => {
    const conflicted = drive(
      initialSaveConflictState('a', 100),
      { type: 'edit', content: 'ab' },
      { type: 'save' },
      { type: 'save_conflict', mtime: 555 },
    );
    const overwriting = reduceSaveConflict(conflicted, { type: 'overwrite' });
    expect(overwriting.status).toBe('saving');
    expect(overwriting.mtime).toBe(555);
    expect(overwriting.conflictMtime).toBeNull();
    const done = reduceSaveConflict(overwriting, { type: 'save_ok', mtime: 600 });
    expect(done.status).toBe('clean');
    expect(done.mtime).toBe(600);
  });

  it('reload from conflict replaces the buffer and clears dirtiness', () => {
    const conflicted = drive(
      initialSaveConflictState('a', 100),
      { type: 'edit', content: 'ab' },
      { type: 'save' },
      { type: 'save_conflict', mtime: 555 },
    );
    const reloaded = reduceSaveConflict(conflicted, { type: 'reloaded', content: 'disk-content', mtime: 555 });
    expect(reloaded.status).toBe('clean');
    expect(reloaded.savedContent).toBe('disk-content');
    expect(reloaded.currentContent).toBe('disk-content');
    expect(reloaded.mtime).toBe(555);
    expect(isDirty(reloaded)).toBe(false);
  });

  it('save_error falls back to dirty for a retry', () => {
    const state = drive(
      initialSaveConflictState('a', 100),
      { type: 'edit', content: 'ab' },
      { type: 'save' },
      { type: 'save_error' },
    );
    expect(state.status).toBe('dirty');
    expect(isDirty(state)).toBe(true);
  });

  it('overwrite is inert when not in conflict', () => {
    const clean = initialSaveConflictState('a', 1);
    expect(reduceSaveConflict(clean, { type: 'overwrite' })).toEqual(clean);
  });
});
