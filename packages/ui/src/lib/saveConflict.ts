// Pure state machine for the editor's save/conflict flow. The EditorView holds
// one of these and drives it with actions; all the branching (dirty tracking,
// mtime precondition, 409 overwrite-or-reload) lives here so it is unit-testable
// without a daemon or a DOM.
//
// Lifecycle:
//   clean ──edit──▶ dirty ──save──▶ saving ─┬─ save_ok ──────▶ clean (or dirty
//                     ▲                      │                   if edited mid-save)
//                     └── save_error ────────┤
//                                            └─ save_conflict ─▶ conflict
//   conflict ──overwrite──▶ saving   (re-PUT with the fresh mtime from the 409)
//   conflict ──reloaded───▶ clean    (refetched content wins; no write)
//
// `mtime` is the mtimeMs the client PUTs as expectedMtime. On a 409 the daemon
// returns the CURRENT on-disk mtime; we stash it as `conflictMtime` so an
// overwrite can re-PUT with a precondition that will now succeed.

export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict';

export interface SaveConflictState {
  status: SaveStatus;
  // The content last persisted (or last loaded) — the baseline for dirtiness.
  savedContent: string;
  // The editor's current buffer content.
  currentContent: string;
  // The buffer snapshot captured when the in-flight save started, so that a
  // save_ok marks exactly what was written as saved (not any edits made since).
  savingContent: string | null;
  // The mtime the next save will send as expectedMtime (null for a not-yet-
  // existing file — this step only ever edits existing files, so it starts set).
  mtime: number | null;
  // The fresh on-disk mtime reported by a 409, used by an overwrite re-PUT.
  conflictMtime: number | null;
}

export type SaveConflictAction =
  | { type: 'edit'; content: string }
  | { type: 'save' }
  | { type: 'save_ok'; mtime: number }
  | { type: 'save_conflict'; mtime: number }
  | { type: 'save_error' }
  | { type: 'overwrite' }
  | { type: 'reloaded'; content: string; mtime: number };

export function initialSaveConflictState(content: string, mtime: number | null): SaveConflictState {
  return {
    status: 'clean',
    savedContent: content,
    currentContent: content,
    savingContent: null,
    mtime,
    conflictMtime: null,
  };
}

// True whenever the buffer differs from what's on disk — the dirty dot. Derived
// (not stored) so it can never drift from the content fields.
export function isDirty(state: SaveConflictState): boolean {
  return state.currentContent !== state.savedContent;
}

function statusForBuffer(saved: string, current: string): SaveStatus {
  return current === saved ? 'clean' : 'dirty';
}

export function reduceSaveConflict(state: SaveConflictState, action: SaveConflictAction): SaveConflictState {
  switch (action.type) {
    case 'edit': {
      // An edit while saving still updates the buffer (the in-flight PUT carries
      // the snapshot in savingContent); status stays 'saving' until it resolves.
      const currentContent = action.content;
      if (state.status === 'saving') {
        return { ...state, currentContent };
      }
      return { ...state, currentContent, status: statusForBuffer(state.savedContent, currentContent) };
    }
    case 'save': {
      // Only a dirty buffer is worth saving; anything else is a no-op.
      if (state.status !== 'dirty') {
        return state;
      }
      return { ...state, status: 'saving', savingContent: state.currentContent };
    }
    case 'save_ok': {
      // The write landed: what was PUT (savingContent) becomes the saved
      // baseline, and the held mtime advances. If the user typed during the
      // save the buffer is now dirty again against that new baseline.
      const savedContent = state.savingContent ?? state.currentContent;
      return {
        ...state,
        status: statusForBuffer(savedContent, state.currentContent),
        savedContent,
        savingContent: null,
        mtime: action.mtime,
        conflictMtime: null,
      };
    }
    case 'save_conflict': {
      return { ...state, status: 'conflict', savingContent: null, conflictMtime: action.mtime };
    }
    case 'save_error': {
      // Network/other failure: fall back to dirty so the user can retry.
      return { ...state, status: 'dirty', savingContent: null };
    }
    case 'overwrite': {
      // Re-PUT with the fresh mtime from the 409 as the new precondition.
      if (state.status !== 'conflict' || state.conflictMtime === null) {
        return state;
      }
      return {
        ...state,
        status: 'saving',
        savingContent: state.currentContent,
        mtime: state.conflictMtime,
        conflictMtime: null,
      };
    }
    case 'reloaded': {
      // Refetched content replaces the buffer wholesale; nothing is dirty.
      return {
        status: 'clean',
        savedContent: action.content,
        currentContent: action.content,
        savingContent: null,
        mtime: action.mtime,
        conflictMtime: null,
      };
    }
  }
}
