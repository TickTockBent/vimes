import { describe, expect, it } from 'vitest';
import {
  deriveRoots,
  deriveTreeRows,
  effectiveRoots,
  formatSize,
  initialTreeDir,
  joinPath,
  parentDir,
  parseRootsPayload,
  type RawTreeEntry,
} from './treeNode.js';
import type { SessionRecord } from './types.js';

describe('joinPath / parentDir', () => {
  it('joins without doubling separators', () => {
    expect(joinPath('/a/b', 'c')).toBe('/a/b/c');
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c');
  });

  it('walks up to parents and stops at the root', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
    expect(parentDir('/a/b/')).toBe('/a');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBeNull();
  });
});

describe('formatSize', () => {
  it('labels files and omits labels for dirs/symlinks', () => {
    expect(formatSize(512, 'file')).toBe('512 B');
    expect(formatSize(2048, 'file')).toBe('2 KB');
    expect(formatSize(1_572_864, 'file')).toBe('1.5 MB');
    expect(formatSize(4096, 'dir')).toBe('');
    expect(formatSize(10, 'symlink')).toBe('');
  });
});

describe('deriveTreeRows', () => {
  const entries: RawTreeEntry[] = [
    { name: 'zeta.ts', type: 'file', size: 100, mtime: 1, hidden: false },
    { name: 'src', type: 'dir', size: 0, mtime: 1, hidden: false },
    { name: 'link', type: 'symlink', size: 0, mtime: 1, hidden: false },
    { name: 'Alpha.ts', type: 'file', size: 2048, mtime: 1, hidden: false },
    { name: 'assets', type: 'dir', size: 0, mtime: 1, hidden: false },
  ];

  it('orders dirs, then symlinks, then files, alphabetical within group', () => {
    const rows = deriveTreeRows('/root', entries);
    expect(rows.map((r) => r.name)).toEqual(['assets', 'src', 'link', 'Alpha.ts', 'zeta.ts']);
  });

  it('attaches absolute path and size label', () => {
    const rows = deriveTreeRows('/root', entries);
    const alpha = rows.find((r) => r.name === 'Alpha.ts')!;
    expect(alpha.absolute).toBe('/root/Alpha.ts');
    expect(alpha.sizeLabel).toBe('2 KB');
  });

  // NATURAL ordering: digit runs compare as numbers. Lexicographically this list
  // reads chapter-1, chapter-10, chapter-11, chapter-2 — which is how a chapters
  // directory stops being readable the moment it passes nine files.
  it('sorts embedded numbers NUMERICALLY, so chapter-2 precedes chapter-10', () => {
    const chapters: RawTreeEntry[] = [
      { name: 'chapter-10.md', type: 'file', size: 1, mtime: 1, hidden: false },
      { name: 'chapter-2.md', type: 'file', size: 1, mtime: 1, hidden: false },
      { name: 'chapter-1.md', type: 'file', size: 1, mtime: 1, hidden: false },
      { name: 'chapter-11.md', type: 'file', size: 1, mtime: 1, hidden: false },
      { name: 'chapter-9.md', type: 'file', size: 1, mtime: 1, hidden: false },
    ];
    expect(deriveTreeRows('/root', chapters).map((row) => row.name)).toEqual([
      'chapter-1.md',
      'chapter-2.md',
      'chapter-9.md',
      'chapter-10.md',
      'chapter-11.md',
    ]);
  });

  it('applies numeric ordering to directories too, and keeps dirs before files', () => {
    const mixed: RawTreeEntry[] = [
      { name: 'part-10', type: 'dir', size: 0, mtime: 1, hidden: false },
      { name: 'part-2', type: 'dir', size: 0, mtime: 1, hidden: false },
      { name: 'chapter-10.md', type: 'file', size: 1, mtime: 1, hidden: false },
      { name: 'chapter-2.md', type: 'file', size: 1, mtime: 1, hidden: false },
    ];
    expect(deriveTreeRows('/root', mixed).map((row) => row.name)).toEqual([
      'part-2',
      'part-10',
      'chapter-2.md',
      'chapter-10.md',
    ]);
  });
});

// Returning from the editor must land in the folder you were editing in. The tree
// is unmounted while the editor is open, so its own currentDir cannot survive the
// trip — the route carries the directory and this picks it up.
describe('initialTreeDir', () => {
  const roots = ['/home/ticktockbent/projects', '/home/ticktockbent/content'];

  it('prefers the requested directory over the first root', () => {
    expect(initialTreeDir('/content/death/manuscript/chapters', roots)).toBe(
      '/content/death/manuscript/chapters',
    );
  });

  it('falls back to the first root when no directory is requested', () => {
    expect(initialTreeDir(null, roots)).toBe('/home/ticktockbent/projects');
    expect(initialTreeDir('', roots)).toBe('/home/ticktockbent/projects');
  });

  it('returns null when nothing is requested and there are no roots yet', () => {
    expect(initialTreeDir(null, [])).toBeNull();
  });

  it('still honours a requested directory before any root has landed', () => {
    expect(initialTreeDir('/a/b', [])).toBe('/a/b');
  });
});

describe('deriveRoots', () => {
  function session(overrides: Partial<SessionRecord>): SessionRecord {
    return {
      appSessionId: overrides.appSessionId ?? 'id',
      channel: 'sdk',
      cwd: overrides.cwd ?? '/home/wes/proj',
      liveness: overrides.liveness ?? 'running',
      needsAttention: null,
      name: null,
      createdAt: '2026-07-20T00:00:00Z',
      ...overrides,
    };
  }

  it('returns distinct live-session cwds, sorted, excluding dead ones', () => {
    const sessions: Record<string, SessionRecord> = {
      a: session({ appSessionId: 'a', cwd: '/home/wes/b', liveness: 'running' }),
      b: session({ appSessionId: 'b', cwd: '/home/wes/a', liveness: 'dormant' }),
      c: session({ appSessionId: 'c', cwd: '/home/wes/b', liveness: 'interrupted' }),
      d: session({ appSessionId: 'd', cwd: '/home/wes/dead', liveness: 'dead' }),
    };
    expect(deriveRoots(sessions)).toEqual(['/home/wes/a', '/home/wes/b']);
  });

  it('is empty when there are no live sessions', () => {
    expect(deriveRoots({})).toEqual([]);
  });
});

describe('parseRootsPayload', () => {
  it('accepts a well-formed { roots: string[] } body', () => {
    expect(parseRootsPayload({ roots: ['/a', '/b'] })).toEqual(['/a', '/b']);
  });

  it('accepts an empty roots array (a legitimately empty allowlist)', () => {
    expect(parseRootsPayload({ roots: [] })).toEqual([]);
  });

  it('degrades to null on a malformed body rather than throwing', () => {
    expect(parseRootsPayload(null)).toBeNull();
    expect(parseRootsPayload(undefined)).toBeNull();
    expect(parseRootsPayload('nope')).toBeNull();
    expect(parseRootsPayload({})).toBeNull();
    expect(parseRootsPayload({ roots: 'not-an-array' })).toBeNull();
    expect(parseRootsPayload({ roots: [1, 2] })).toBeNull();
  });
});

describe('effectiveRoots', () => {
  function session(overrides: Partial<SessionRecord>): SessionRecord {
    return {
      appSessionId: overrides.appSessionId ?? 'id',
      channel: 'sdk',
      cwd: overrides.cwd ?? '/home/wes/proj',
      liveness: overrides.liveness ?? 'running',
      needsAttention: null,
      name: null,
      createdAt: '2026-07-20T00:00:00Z',
      ...overrides,
    };
  }

  it('prefers the fetched roots once populated, even over live-session cwds', () => {
    const sessions: Record<string, SessionRecord> = { a: session({ cwd: '/home/wes/from-session' }) };
    expect(effectiveRoots(['/home/wes/configured'], sessions)).toEqual(['/home/wes/configured']);
  });

  it('honors a legitimately empty fetched list rather than falling back', () => {
    const sessions: Record<string, SessionRecord> = { a: session({ cwd: '/home/wes/from-session' }) };
    expect(effectiveRoots([], sessions)).toEqual([]);
  });

  it('falls back to deriveRoots(sessions) only while nothing has been fetched yet (null)', () => {
    const sessions: Record<string, SessionRecord> = { a: session({ cwd: '/home/wes/from-session' }) };
    expect(effectiveRoots(null, sessions)).toEqual(['/home/wes/from-session']);
  });
});
