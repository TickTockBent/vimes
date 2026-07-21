import { describe, expect, it } from 'vitest';
import {
  decideGitRoot,
  deriveGitStatusRow,
  deriveGitStatusRows,
  diffLineStyle,
  groupStatusRows,
  summarizeDiffStat,
  type GitFileDiff,
  type GitStatusEntry,
} from './gitReview.js';

function entry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return {
    kind: 'ordinary',
    path: 'src/app.ts',
    origPath: null,
    staged: '',
    unstaged: 'M',
    xy: '.M',
    score: null,
    ...overrides,
  };
}

describe('deriveGitStatusRow', () => {
  it('labels a purely worktree-modified file as Modified, unstaged only', () => {
    const row = deriveGitStatusRow(entry({ staged: '', unstaged: 'M' }));
    expect(row).toEqual({
      path: 'src/app.ts',
      pathTail: 'app.ts',
      origPath: null,
      statusLabel: 'Modified',
      group: 'unstaged',
      hasStaged: false,
      hasUnstaged: true,
    });
  });

  it('labels a staged-only added file as Added, staged group', () => {
    const row = deriveGitStatusRow(entry({ staged: 'A', unstaged: '', xy: 'A.' }));
    expect(row.statusLabel).toBe('Added');
    expect(row.group).toBe('staged');
    expect(row.hasStaged).toBe(true);
    expect(row.hasUnstaged).toBe(false);
  });

  it('marks a partially-staged file (index M + worktree M) as staged with BOTH flags set', () => {
    const row = deriveGitStatusRow(entry({ staged: 'M', unstaged: 'M', xy: 'MM' }));
    expect(row.group).toBe('staged');
    expect(row.hasStaged).toBe(true);
    expect(row.hasUnstaged).toBe(true);
    // The staged letter wins for the label (what will commit).
    expect(row.statusLabel).toBe('Modified');
  });

  it('derives a rename with its source path and Renamed label', () => {
    const row = deriveGitStatusRow(
      entry({ kind: 'renamed', path: 'src/new.ts', origPath: 'src/old.ts', staged: 'R', unstaged: '', xy: 'R.', score: 'R100' }),
    );
    expect(row.statusLabel).toBe('Renamed');
    expect(row.origPath).toBe('src/old.ts');
    expect(row.pathTail).toBe('new.ts');
    expect(row.group).toBe('staged');
  });

  it('treats an untracked file as its own bucket, stageable but not unstageable', () => {
    const row = deriveGitStatusRow(entry({ kind: 'untracked', path: 'notes.txt', staged: '', unstaged: '', xy: '?' }));
    expect(row.statusLabel).toBe('Untracked');
    expect(row.group).toBe('untracked');
    expect(row.hasUnstaged).toBe(true);
    expect(row.hasStaged).toBe(false);
  });

  it('surfaces an unmerged conflict under unstaged (needs resolution before commit)', () => {
    const row = deriveGitStatusRow(entry({ kind: 'unmerged', path: 'src/conflict.ts', staged: 'U', unstaged: 'U', xy: 'UU' }));
    expect(row.statusLabel).toBe('Unmerged');
    expect(row.group).toBe('unstaged');
    expect(row.hasStaged).toBe(false);
    expect(row.hasUnstaged).toBe(true);
  });

  it('labels a deletion from the worktree letter when the index is clean', () => {
    expect(deriveGitStatusRow(entry({ staged: '', unstaged: 'D', xy: '.D' })).statusLabel).toBe('Deleted');
  });
});

describe('deriveGitStatusRows', () => {
  it('preserves order and does not mutate its input', () => {
    const input = [entry({ path: 'b.ts' }), entry({ path: 'a.ts' })];
    const snapshot = input.map((each) => each.path);
    const rows = deriveGitStatusRows(input);
    expect(rows.map((row) => row.path)).toEqual(['b.ts', 'a.ts']);
    expect(input.map((each) => each.path)).toEqual(snapshot);
  });
});

describe('groupStatusRows', () => {
  it('splits into staged / unstaged / untracked, each path-sorted for a stable order', () => {
    const grouped = groupStatusRows([
      entry({ path: 'z-staged.ts', staged: 'M', unstaged: '', xy: 'M.' }),
      entry({ path: 'a-staged.ts', staged: 'A', unstaged: '', xy: 'A.' }),
      entry({ path: 'worktree.ts', staged: '', unstaged: 'M', xy: '.M' }),
      entry({ kind: 'untracked', path: 'new.txt', staged: '', unstaged: '', xy: '?' }),
    ]);
    expect(grouped.staged.map((row) => row.path)).toEqual(['a-staged.ts', 'z-staged.ts']);
    expect(grouped.unstaged.map((row) => row.path)).toEqual(['worktree.ts']);
    expect(grouped.untracked.map((row) => row.path)).toEqual(['new.txt']);
  });

  it('keeps a partially-staged file in the staged bucket (single row, not duplicated)', () => {
    const grouped = groupStatusRows([entry({ path: 'partial.ts', staged: 'M', unstaged: 'M', xy: 'MM' })]);
    expect(grouped.staged).toHaveLength(1);
    expect(grouped.unstaged).toHaveLength(0);
    expect(grouped.staged[0]!.hasUnstaged).toBe(true);
  });
});

describe('diffLineStyle', () => {
  it('maps add → "+" with the add class', () => {
    expect(diffLineStyle('add')).toEqual({ sign: '+', className: 'diff-line-add' });
  });
  it('maps del → "-" with the del class', () => {
    expect(diffLineStyle('del')).toEqual({ sign: '-', className: 'diff-line-del' });
  });
  it('maps context → a space with the context class', () => {
    expect(diffLineStyle('context')).toEqual({ sign: ' ', className: 'diff-line-context' });
  });
});

describe('summarizeDiffStat', () => {
  function file(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
    return {
      path: 'src/app.ts',
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      changeKind: 'modified',
      binary: false,
      hunks: [],
      ...overrides,
    };
  }

  it('counts additions, deletions, and files across all hunks (context lines ignored)', () => {
    const stat = summarizeDiffStat([
      file({
        path: 'a.ts',
        hunks: [
          {
            header: '@@ -1,3 +1,4 @@',
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            section: '',
            lines: [
              { kind: 'context', content: 'ctx', oldLineNumber: 1, newLineNumber: 1 },
              { kind: 'del', content: 'gone', oldLineNumber: 2, newLineNumber: null },
              { kind: 'add', content: 'new-a', oldLineNumber: null, newLineNumber: 2 },
              { kind: 'add', content: 'new-b', oldLineNumber: null, newLineNumber: 3 },
            ],
          },
        ],
      }),
      file({ path: 'b.ts', hunks: [] }),
    ]);
    expect(stat).toEqual({ filesChanged: 2, additions: 2, deletions: 1 });
  });

  it('is zero for an empty diff', () => {
    expect(summarizeDiffStat([])).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });
});

describe('decideGitRoot — repo picker + free-text escape hatch', () => {
  it('prefers the free-text field over the selected repo', () => {
    expect(decideGitRoot('/home/wes/projects/other/repo', '/home/wes/projects/infrastructure/vimes')).toEqual({
      ok: true,
      root: '/home/wes/projects/other/repo',
    });
  });

  it('trims the free-text field', () => {
    expect(decideGitRoot('  /home/wes/projects/a/repo  ', '')).toEqual({ ok: true, root: '/home/wes/projects/a/repo' });
  });

  it('falls back to the selected repo when the field is empty or whitespace', () => {
    const selectedRepoPath = '/home/wes/projects/infrastructure/vimes';
    expect(decideGitRoot('', selectedRepoPath)).toEqual({ ok: true, root: selectedRepoPath });
    expect(decideGitRoot('   ', selectedRepoPath)).toEqual({ ok: true, root: selectedRepoPath });
  });

  it('reports a visible problem when neither a field value nor a selection exists', () => {
    const decision = decideGitRoot('', '');
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error.length > 0).toBe(true);
  });

  // The daemon owns the boundary: a traversal or an out-of-roots path is passed
  // through UNCHANGED and refused server-side (surfacing via gitError). The
  // helper must NOT invent a second, weaker client-side wall.
  it('passes hostile-looking paths through untouched — the daemon is the wall', () => {
    expect(decideGitRoot('../../etc', '/home/wes/projects')).toEqual({ ok: true, root: '../../etc' });
    expect(decideGitRoot('/etc/shadow', '')).toEqual({ ok: true, root: '/etc/shadow' });
  });
});
