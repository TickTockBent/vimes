import { describe, expect, it } from 'vitest';
import { decideMountReady, decideStartRoot } from './terminalStart.js';

describe('decideStartRoot', () => {
  it('yields a visible error (not a silent no-op) when nothing is selected and no root is offered', () => {
    const decision = decideStartRoot('', undefined);
    expect(decision).toEqual({ ok: false, error: 'Select a workspace root first.' });
  });

  it('falls back to the first offered root when none is explicitly selected', () => {
    const decision = decideStartRoot('', '/home/wes/projects');
    expect(decision).toEqual({ ok: true, root: '/home/wes/projects' });
  });

  it('prefers an explicitly selected root over the first offered one', () => {
    const decision = decideStartRoot('/home/wes/other', '/home/wes/projects');
    expect(decision).toEqual({ ok: true, root: '/home/wes/other' });
  });
});

describe('decideMountReady', () => {
  // This is the deadlock case: the mount target lives behind v-else, so before
  // the fix it was NEVER available when start() checked it. Proving the
  // false path still surfaces a visible error (not a silent return) matters
  // as much as proving the true path proceeds.
  it('surfaces a visible error when the mount target still is not in the DOM after nextTick', () => {
    const decision = decideMountReady(false);
    expect(decision).toEqual({ ok: false, error: 'Could not prepare the terminal — try again.' });
  });

  it('proceeds once the mount target has rendered (the fixed post-nextTick path)', () => {
    const decision = decideMountReady(true);
    expect(decision).toEqual({ ok: true });
  });
});
