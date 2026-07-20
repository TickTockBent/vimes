import { describe, expect, it } from 'vitest';
import { decideMountReady, decideStartCwd, decideStartRoot } from './terminalStart.js';

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

describe('decideStartCwd', () => {
  it('uses a non-empty free-text field verbatim (a subpath below the root)', () => {
    const decision = decideStartCwd('/home/wes/projects/vimes/packages', '/home/wes/projects', '/home/wes/projects');
    expect(decision).toEqual({ ok: true, cwd: '/home/wes/projects/vimes/packages' });
  });

  it('trims surrounding whitespace off the field value', () => {
    const decision = decideStartCwd('  /home/wes/projects/vimes  ', '/home/wes/projects', '/home/wes/projects');
    expect(decision).toEqual({ ok: true, cwd: '/home/wes/projects/vimes' });
  });

  it('falls back to the selected root when the field is empty (or whitespace only)', () => {
    expect(decideStartCwd('', '/home/wes/projects', undefined)).toEqual({ ok: true, cwd: '/home/wes/projects' });
    expect(decideStartCwd('   ', '/home/wes/projects', undefined)).toEqual({ ok: true, cwd: '/home/wes/projects' });
  });

  it('falls back through to the first offered root when the field is empty and nothing is selected', () => {
    expect(decideStartCwd('', '', '/home/wes/projects')).toEqual({ ok: true, cwd: '/home/wes/projects' });
  });

  it('surfaces the root error when the field is empty and there is no root at all', () => {
    expect(decideStartCwd('', '', undefined)).toEqual({ ok: false, error: 'Select a workspace root first.' });
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
