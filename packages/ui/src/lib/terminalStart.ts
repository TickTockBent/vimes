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

export interface TerminalStartCwd {
  ok: true;
  cwd: string;
}

export type TerminalStartRootDecision = TerminalStartRoot | TerminalStartError;
export type TerminalStartCwdDecision = TerminalStartCwd | TerminalStartError;
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

// Compose the cwd a new shell opens at from the editable free-text field, with
// the selected root as the fallback. A non-empty (trimmed) field wins — this is
// how the user opens a shell at a SUBPATH, not only at a root. An empty field
// falls back to the selected root (phase-1 root decision). NO client-side path
// validation beyond non-empty: the daemon's term_open routes the cwd through
// resolveWithinRoots and refuses anything outside the allowlist — that server
// wall is the single authoritative boundary (we do not duplicate it here).
export function decideStartCwd(
  cwdFieldValue: string,
  selectedRoot: string,
  firstRoot: string | undefined,
): TerminalStartCwdDecision {
  const trimmedCwd = cwdFieldValue.trim();
  if (trimmedCwd.length > 0) {
    return { ok: true, cwd: trimmedCwd };
  }
  const rootDecision = decideStartRoot(selectedRoot, firstRoot);
  return rootDecision.ok ? { ok: true, cwd: rootDecision.root } : rootDecision;
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
