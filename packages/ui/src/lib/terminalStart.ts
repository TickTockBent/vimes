// Pure decision logic for TerminalView's start() flow
// (packages/ui/src/views/TerminalView.vue).
//
// Split into two phases because of a real deadlock bug: the mount target
// (`<div ref="terminalElement">`) lives behind `v-else` in the template (only
// rendered once `started === true`). The original code read
// `terminalElement.value` BEFORE ever setting `started` — so the ref was
// always null, and start() returned silently. Nothing happened; no error.
//
// The fix: decide root-availability FIRST (phase 1, before `started` flips —
// can fail visibly with no silent no-op), flip `started`, `await nextTick()`
// so the v-else branch actually renders, THEN decide mount-readiness
// (phase 2 — can also fail visibly if the ref still isn't there for some
// other reason, rather than returning without a trace).

export interface TerminalStartError {
  ok: false;
  error: string;
}

export interface TerminalStartRoot {
  ok: true;
  root: string;
}

export type TerminalStartRootDecision = TerminalStartRoot | TerminalStartError;
export type TerminalMountDecision = { ok: true } | TerminalStartError;

// Phase 1 — is there a root to open the shell at? selectedRoot wins when set;
// otherwise the first offered root. A missing root must surface a visible
// message, never a silent return.
export function decideStartRoot(selectedRoot: string, firstRoot: string | undefined): TerminalStartRootDecision {
  const root = selectedRoot.length > 0 ? selectedRoot : firstRoot;
  if (root === undefined || root.length === 0) {
    return { ok: false, error: 'Select a workspace root first.' };
  }
  return { ok: true, root };
}

// Phase 2 — after `started` flips true and nextTick() lets the mount target
// render, is it actually in the DOM? A false here must also surface a visible
// error rather than the old silent return.
export function decideMountReady(elementAvailable: boolean): TerminalMountDecision {
  if (!elementAvailable) {
    return { ok: false, error: 'Could not prepare the terminal — try again.' };
  }
  return { ok: true };
}
