// Pure. Given an Enter keypress's relevant flags, decide whether it SENDS or
// inserts a NEWLINE. No DOM, no matchMedia here — the .vue reads live
// event/environment state and passes booleans in (same lib/ posture as the
// other helpers). This encodes: desktop Enter sends, Shift+Enter is always a
// newline, mobile Enter is always a newline (send is the button there), and an
// IME composition Enter is never a send (it is committing a candidate).

export interface ComposerEnterParams {
  shiftKey: boolean;
  isComposing: boolean;
  isDesktop: boolean;
}

export type ComposerEnterAction = 'send' | 'newline';

export function decideComposerEnter(params: ComposerEnterParams): ComposerEnterAction {
  // An IME candidate commit fires as an Enter keydown too — never let that
  // count as a send, on desktop OR mobile. Checked first: composition state
  // outranks every other flag.
  if (params.isComposing) {
    return 'newline';
  }
  // Mobile/touch has no separate newline key on the on-screen keyboard, so
  // Enter must stay a newline there — send is the button.
  if (!params.isDesktop) {
    return 'newline';
  }
  // Desktop: Shift+Enter is the explicit "insert a newline" chord.
  if (params.shiftKey) {
    return 'newline';
  }
  return 'send';
}
