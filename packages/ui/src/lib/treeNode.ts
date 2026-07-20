// Pure derivation for the file tree: turns a raw /api/files/tree listing into
// sorted, display-ready rows, and derives the set of navigable roots from the
// sessions projection. No fetch, no DOM — the FileTreeView owns those and feeds
// results through here.
//
// NOTE (roots gap): there is no /api/files/roots endpoint on the daemon, and
// adding one is out of scope for this UI-only step. Roots are therefore derived
// from the live sessions' cwds only. Consequence: a configured projectRoot with
// no live session in it is not offered as a starting point. Documented as a gap
// for the orchestrator; a trivial GET /api/files/roots would close it.

import type { SessionRecord } from './types.js';

export type FileEntryType = 'dir' | 'file' | 'symlink';

// One raw entry from GET /api/files/tree (packages/daemon/src/fileApi.ts).
export interface RawTreeEntry {
  name: string;
  type: FileEntryType;
  size: number;
  mtime: number;
  hidden: boolean;
}

// A display row: the raw entry plus the absolute path it resolves to and a
// human-readable size. `absolute` is what the editor/download endpoints take.
export interface TreeRow {
  name: string;
  type: FileEntryType;
  size: number;
  mtime: number;
  hidden: boolean;
  absolute: string;
  sizeLabel: string;
}

// Join a directory and a child name into an absolute path (POSIX; the daemon
// runs on Linux). Collapses a trailing slash on the directory so we never emit
// a doubled separator.
export function joinPath(directory: string, name: string): string {
  const base = directory.endsWith('/') ? directory.slice(0, -1) : directory;
  return `${base}/${name}`;
}

// The parent directory of an absolute path, or null at the filesystem root.
// Used for up-navigation; the daemon's allowlist check is what actually decides
// whether the parent is reachable (a 403 means we hit the workspace boundary).
export function parentDir(directory: string): string | null {
  const base = directory.endsWith('/') ? directory.slice(0, -1) : directory;
  const slashIndex = base.lastIndexOf('/');
  if (slashIndex <= 0) {
    return slashIndex === 0 && base.length > 1 ? '/' : null;
  }
  return base.slice(0, slashIndex);
}

// Human-readable byte size. Directories/symlinks pass size 0 → '' (no label).
export function formatSize(bytes: number, type: FileEntryType): string {
  if (type !== 'file') {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

// Sort: directories first, then symlinks, then files; alphabetical within a
// group, case-insensitive. Hidden entries sort with their peers (not hoisted).
const TYPE_ORDER: Record<FileEntryType, number> = { dir: 0, symlink: 1, file: 2 };

export function deriveTreeRows(directory: string, entries: readonly RawTreeEntry[]): TreeRow[] {
  return entries
    .map((entry) => ({
      ...entry,
      absolute: joinPath(directory, entry.name),
      sizeLabel: formatSize(entry.size, entry.type),
    }))
    .sort((a, b) => {
      const typeDelta = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      if (typeDelta !== 0) {
        return typeDelta;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    });
}

// Distinct live-session cwds, sorted, as the offered navigation roots. Dead
// sessions are excluded — their cwd may no longer be in the daemon's allowlist
// (the allowlist is config roots ∪ LIVE cwds), so offering it would only 403.
const LIVE_LIVENESS = new Set(['spawning', 'running', 'dormant', 'interrupted']);

export function deriveRoots(sessions: Record<string, SessionRecord>): string[] {
  const roots = new Set<string>();
  for (const session of Object.values(sessions)) {
    if (LIVE_LIVENESS.has(session.liveness) && session.cwd.length > 0) {
      roots.add(session.cwd);
    }
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}
