import { describe, expect, it } from 'vitest';
import { basenameOf, groupResultsByFile, type SearchResultLine } from './searchGroup.js';

function line(file: string, lineNo: number): SearchResultLine {
  return { file, line: lineNo, col: 0, submatches: [{ start: 0, end: 3, text: 'foo' }] };
}

describe('groupResultsByFile', () => {
  it('groups matches under their file, preserving first-seen file order', () => {
    const groups = groupResultsByFile([line('/a.ts', 1), line('/b.ts', 2), line('/a.ts', 5)]);
    expect(groups.map((g) => g.file)).toEqual(['/a.ts', '/b.ts']);
    expect(groups[0]!.matches.map((m) => m.line)).toEqual([1, 5]);
    expect(groups[1]!.matches.map((m) => m.line)).toEqual([2]);
  });

  it('returns an empty array for no results', () => {
    expect(groupResultsByFile([])).toEqual([]);
  });
});

describe('basenameOf', () => {
  it('returns the last path segment', () => {
    expect(basenameOf('/home/wes/app.ts')).toBe('app.ts');
    expect(basenameOf('app.ts')).toBe('app.ts');
  });
});
