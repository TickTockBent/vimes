import { describe, expect, it } from 'vitest';
import {
  initialKillConfirmState,
  isConfirmingKill,
  reduceKillConfirm,
} from './killConfirm.js';

describe('reduceKillConfirm — tap-again confirm', () => {
  it('first tap arms the row without firing', () => {
    const result = reduceKillConfirm(initialKillConfirmState, { type: 'tap', appSessionId: 'a' });
    expect(result.fire).toBe(false);
    expect(result.state.confirmingId).toBe('a');
    expect(isConfirmingKill(result.state, 'a')).toBe(true);
  });

  it('a second tap on the SAME armed row fires and disarms', () => {
    const armed = reduceKillConfirm(initialKillConfirmState, { type: 'tap', appSessionId: 'a' }).state;
    const result = reduceKillConfirm(armed, { type: 'tap', appSessionId: 'a' });
    expect(result.fire).toBe(true);
    expect(result.state).toEqual(initialKillConfirmState);
  });

  it('a tap on a DIFFERENT row re-arms to it and never fires', () => {
    const armed = reduceKillConfirm(initialKillConfirmState, { type: 'tap', appSessionId: 'a' }).state;
    const result = reduceKillConfirm(armed, { type: 'tap', appSessionId: 'b' });
    expect(result.fire).toBe(false);
    expect(result.state.confirmingId).toBe('b');
    expect(isConfirmingKill(result.state, 'a')).toBe(false);
  });

  it('reset disarms without firing', () => {
    const armed = reduceKillConfirm(initialKillConfirmState, { type: 'tap', appSessionId: 'a' }).state;
    const result = reduceKillConfirm(armed, { type: 'reset' });
    expect(result.fire).toBe(false);
    expect(result.state).toEqual(initialKillConfirmState);
  });
});
