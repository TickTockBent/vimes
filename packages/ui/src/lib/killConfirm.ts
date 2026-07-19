// Kill confirm-state reducer (tap-again, not a browser confirm()). A single
// appSessionId is "armed" at a time: the first tap on a row arms it; a second tap
// on the SAME row fires the kill and disarms; a tap on a DIFFERENT row re-arms to
// that row (never fires). An explicit reset (navigating away, timeout, success)
// disarms. Pure so the UI keeps no ad-hoc confirm logic.

export interface KillConfirmState {
  // The row currently armed for kill (awaiting the confirming second tap), or null.
  confirmingId: string | null;
}

export const initialKillConfirmState: KillConfirmState = { confirmingId: null };

export type KillConfirmAction =
  | { type: 'tap'; appSessionId: string }
  | { type: 'reset' };

export interface KillConfirmResult {
  state: KillConfirmState;
  // True only when this tap is the confirming second tap on an armed row — the
  // caller should issue the kill exactly then.
  fire: boolean;
}

export function reduceKillConfirm(
  state: KillConfirmState,
  action: KillConfirmAction,
): KillConfirmResult {
  if (action.type === 'reset') {
    return { state: initialKillConfirmState, fire: false };
  }
  // action.type === 'tap'
  if (state.confirmingId === action.appSessionId) {
    // Second tap on the armed row — fire and disarm.
    return { state: initialKillConfirmState, fire: true };
  }
  // First tap, or a tap on a different row — arm this row, do not fire.
  return { state: { confirmingId: action.appSessionId }, fire: false };
}

// Whether a given row is currently armed (its kill button should show the
// "tap again to confirm" state).
export function isConfirmingKill(state: KillConfirmState, appSessionId: string): boolean {
  return state.confirmingId === appSessionId;
}
