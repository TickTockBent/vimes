// Pure grouping of streaming ripgrep results by file. The store accumulates
// flat `search_result` lines as they arrive over the WS; the SearchPanel renders
// them grouped under a per-file header with tap-to-open. Kept pure so the
// grouping (order preservation, dedupe) is unit-testable without a daemon.

// One match line as sent by the daemon (packages/daemon/src/search.ts).
export interface SearchResultLine {
  file: string;
  line: number;
  col: number;
  submatches: Array<{ start: number; end: number; text: string }>;
}

export interface SearchFileGroup {
  file: string;
  matches: SearchResultLine[];
}

// Group results by file, preserving first-seen file order and, within a file,
// arrival order. Ripgrep already streams a file's matches contiguously, but we
// don't rely on that — a file reappearing later merges into its existing group.
export function groupResultsByFile(results: readonly SearchResultLine[]): SearchFileGroup[] {
  const groups = new Map<string, SearchFileGroup>();
  for (const result of results) {
    let group = groups.get(result.file);
    if (group === undefined) {
      group = { file: result.file, matches: [] };
      groups.set(result.file, group);
    }
    group.matches.push(result);
  }
  return [...groups.values()];
}

// The last path segment, for a compact per-file header (the full path shows as
// a secondary line). Returns the whole string when there is no separator.
export function basenameOf(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}
