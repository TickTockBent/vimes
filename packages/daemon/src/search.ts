import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IdSource } from '@vimes/core';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';
import { writeFileAtomic } from './fileApi.js';

// ─── Search + preview-gated replace (spec §3.4; protocol v0.4) ────────────────
//
// ripgrep `--json` is a fragile external surface (rule 0.6): the parser tolerates
// unknown event types and missing fields. ripgrep itself is an INJECTABLE seam
// (like the SDK/PTY factories) — the daemon spawns `rg` from PATH by default, but
// CI injects a fake, because real Claude never runs in the harness AND (observed
// on this box) a spawnable `rg` binary is not guaranteed present. A one-time
// preflight decides availability; when rg is absent, search ops return a
// structured `search_error` reason 'ripgrep-unavailable' rather than spawning.
//
// Every `root` is validated through resolveWithinRoots BEFORE rg is spawned — a
// root outside the allowlist is refused, never searched.

// The injectable ripgrep child. onStdoutLine delivers one --json line at a time.
export interface RipgrepProcess {
  onStdoutLine(callback: (line: string) => void): void;
  onClose(callback: (code: number | null) => void): void;
  onError(callback: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
}

export type RipgrepSpawner = (args: string[], cwd: string) => RipgrepProcess;
// Cached at daemon start; true when a spawnable `rg` exists.
export type RipgrepPreflight = () => boolean;

export interface SearchFlags {
  caseInsensitive?: boolean;
  word?: boolean;
  regex?: boolean;
}

// Build rg args. Default treats the query as a LITERAL (`-F`); flags.regex opts
// into rg's regex engine. Case/word flags map to `-i`/`-w`. The `--` guard keeps
// a query that starts with `-` from being read as a flag.
function buildRipgrepArgs(query: string, rootAbsolute: string, flags: SearchFlags | undefined): string[] {
  const args = ['--json'];
  if (flags?.regex !== true) {
    args.push('-F');
  }
  if (flags?.caseInsensitive === true) {
    args.push('-i');
  }
  if (flags?.word === true) {
    args.push('-w');
  }
  args.push('--', query, rootAbsolute);
  return args;
}

// ── the default (real) ripgrep seams — determinism-exempt (process boundary) ──
export const defaultRipgrepSpawner: RipgrepSpawner = (args, cwd) => {
  const child = spawn('rg', args, { cwd });
  let lineCallback: ((line: string) => void) | undefined;
  let closeCallback: ((code: number | null) => void) | undefined;
  let errorCallback: ((error: NodeJS.ErrnoException) => void) | undefined;
  let buffer = '';
  const flushLine = (line: string): void => {
    if (line.length > 0) {
      lineCallback?.(line);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      flushLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  child.on('error', (error: NodeJS.ErrnoException) => errorCallback?.(error));
  child.on('close', (code) => {
    flushLine(buffer);
    buffer = '';
    closeCallback?.(code);
  });
  return {
    onStdoutLine: (callback) => {
      lineCallback = callback;
    },
    onClose: (callback) => {
      closeCallback = callback;
    },
    onError: (callback) => {
      errorCallback = callback;
    },
    kill: () => {
      child.kill();
    },
  };
};

// Default preflight: spawn `rg --version` synchronously ONCE at daemon start.
// Injectable so CI controls availability without touching PATH.
export function createRipgrepPreflight(): RipgrepPreflight {
  let cached: boolean | undefined;
  return () => {
    if (cached !== undefined) {
      return cached;
    }
    try {
      const result = spawnSync('rg', ['--version']);
      cached = result.error === undefined && result.status === 0;
    } catch {
      cached = false;
    }
    return cached;
  };
}

// The message sink bound to one WS connection (the hub's sendControl).
export type SearchSend = (message: Record<string, unknown>) => void;

interface PreviewFile {
  path: string;
  newContent: Buffer;
  previewHash: string;
}
interface PreviewRecord {
  previewId: string;
  files: PreviewFile[];
}
interface ConnectionState {
  searches: Map<string, { process: RipgrepProcess; cancelled: boolean }>;
  previews: Map<string, PreviewRecord>;
}

interface RipgrepMatch {
  file: string;
  line: number;
  col: number;
  submatches: Array<{ start: number; end: number; text: string }>;
}

// Loose parse of one rg --json line into a match (rule 0.6 — tolerate unknown
// event types and shape drift; a line that is not a well-formed `match` returns
// null and is ignored).
function parseRipgrepMatchLine(line: string): RipgrepMatch | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) {
    return null;
  }
  const typed = frame as { type?: unknown; data?: unknown };
  if (typed.type !== 'match' || typeof typed.data !== 'object' || typed.data === null) {
    return null;
  }
  const data = typed.data as {
    path?: { text?: unknown };
    line_number?: unknown;
    submatches?: unknown;
  };
  const file = typeof data.path?.text === 'string' ? data.path.text : undefined;
  const line_number = typeof data.line_number === 'number' ? data.line_number : undefined;
  if (file === undefined || line_number === undefined || !Array.isArray(data.submatches)) {
    return null;
  }
  const submatches: RipgrepMatch['submatches'] = [];
  for (const raw of data.submatches) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const submatch = raw as { start?: unknown; end?: unknown; match?: { text?: unknown } };
    if (typeof submatch.start === 'number' && typeof submatch.end === 'number') {
      submatches.push({
        start: submatch.start,
        end: submatch.end,
        text: typeof submatch.match?.text === 'string' ? submatch.match.text : '',
      });
    }
  }
  const col = submatches.length > 0 ? submatches[0]!.start : 0;
  return { file, line: line_number, col, submatches };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface SearchServiceDeps {
  getAllowedRoots: () => readonly string[];
  spawner?: RipgrepSpawner;
  preflight: RipgrepPreflight;
  ids: IdSource;
  realpath?: RealpathProbe;
  // Wall-clock for elapsedMs (measured, reported to the UI — never asserted
  // exactly). Injected so it stays out of the deterministic core.
  now?: () => number;
}

export class SearchService {
  private readonly getAllowedRoots: () => readonly string[];
  private readonly spawner: RipgrepSpawner;
  private readonly preflight: RipgrepPreflight;
  private readonly ids: IdSource;
  private readonly realpath: RealpathProbe;
  private readonly now: () => number;
  private readonly connections = new Map<string, ConnectionState>();

  constructor(deps: SearchServiceDeps) {
    this.getAllowedRoots = deps.getAllowedRoots;
    this.spawner = deps.spawner ?? defaultRipgrepSpawner;
    this.preflight = deps.preflight;
    this.ids = deps.ids;
    this.realpath = deps.realpath ?? realpathProbe;
    // determinism-exempt: measured wall time at the daemon boundary.
    this.now = deps.now ?? (() => Date.now());
  }

  private stateFor(connectionId: string): ConnectionState {
    let state = this.connections.get(connectionId);
    if (state === undefined) {
      state = { searches: new Map(), previews: new Map() };
      this.connections.set(connectionId, state);
    }
    return state;
  }

  // Validate a requested root against the allowlist; the resolved absolute is the
  // rg search path. Returns null (and the caller emits search_error) when refused.
  private resolveRoot(root: string): string | null {
    const resolved = resolveWithinRoots(root, this.getAllowedRoots(), this.realpath);
    return resolved.ok ? resolved.absolute : null;
  }

  startSearch(
    connectionId: string,
    request: { searchId: string; root: string; query: string; flags?: SearchFlags },
    send: SearchSend,
  ): void {
    if (!this.preflight()) {
      send({ op: 'search_error', searchId: request.searchId, reason: 'ripgrep-unavailable' });
      return;
    }
    const rootAbsolute = this.resolveRoot(request.root);
    if (rootAbsolute === null) {
      send({ op: 'search_error', searchId: request.searchId, reason: 'root-outside-allowlist' });
      return;
    }
    const state = this.stateFor(connectionId);
    // One in-flight search per searchId: replace an existing one.
    const existing = state.searches.get(request.searchId);
    if (existing !== undefined) {
      existing.cancelled = true;
      existing.process.kill();
    }
    let matched = 0;
    const files = new Set<string>();
    const startedAt = this.now();
    const child = this.spawner(buildRipgrepArgs(request.query, rootAbsolute, request.flags), rootAbsolute);
    const record = { process: child, cancelled: false };
    state.searches.set(request.searchId, record);

    child.onStdoutLine((line) => {
      const match = parseRipgrepMatchLine(line);
      if (match === null) {
        return;
      }
      matched += 1;
      files.add(match.file);
      send({
        op: 'search_result',
        searchId: request.searchId,
        file: match.file,
        line: match.line,
        col: match.col,
        submatches: match.submatches,
      });
    });
    child.onError((error) => {
      state.searches.delete(request.searchId);
      const reason = error.code === 'ENOENT' ? 'ripgrep-unavailable' : 'ripgrep-failed';
      send({ op: 'search_error', searchId: request.searchId, reason });
    });
    child.onClose(() => {
      const wasCancelled = record.cancelled;
      state.searches.delete(request.searchId);
      if (wasCancelled) {
        return; // a cancelled search reports no done frame
      }
      send({
        op: 'search_done',
        searchId: request.searchId,
        stats: { matched, files: files.size, elapsedMs: this.now() - startedAt },
      });
    });
  }

  cancelSearch(connectionId: string, request: { searchId: string }): void {
    const state = this.connections.get(connectionId);
    const record = state?.searches.get(request.searchId);
    if (record === undefined) {
      return;
    }
    record.cancelled = true;
    record.process.kill();
    state!.searches.delete(request.searchId);
  }

  // Compute per-file replacement hunks in memory (rg finds the files; the server
  // applies the replacement). Literal replacement (matches the `-F` default);
  // flags.regex opts into a regex replace. Nothing is written here.
  replacePreview(
    connectionId: string,
    request: { searchId: string; root: string; query: string; replacement: string; flags?: SearchFlags },
    send: SearchSend,
  ): void {
    if (!this.preflight()) {
      send({ op: 'search_error', searchId: request.searchId, reason: 'ripgrep-unavailable' });
      return;
    }
    const rootAbsolute = this.resolveRoot(request.root);
    if (rootAbsolute === null) {
      send({ op: 'search_error', searchId: request.searchId, reason: 'root-outside-allowlist' });
      return;
    }
    const matchedFiles = new Set<string>();
    const child = this.spawner(buildRipgrepArgs(request.query, rootAbsolute, request.flags), rootAbsolute);
    child.onStdoutLine((line) => {
      const match = parseRipgrepMatchLine(line);
      if (match !== null) {
        matchedFiles.add(match.file);
      }
    });
    child.onError((error) => {
      const reason = error.code === 'ENOENT' ? 'ripgrep-unavailable' : 'ripgrep-failed';
      send({ op: 'search_error', searchId: request.searchId, reason });
    });
    child.onClose(() => {
      void this.buildPreview(connectionId, request, [...matchedFiles], send);
    });
  }

  private async buildPreview(
    connectionId: string,
    request: { query: string; replacement: string; flags?: SearchFlags },
    matchedFiles: string[],
    send: SearchSend,
  ): Promise<void> {
    const previewId = this.ids.uuid();
    const previewFiles: PreviewFile[] = [];
    const wireFiles: Array<{
      path: string;
      hunks: Array<{ line: number; before: string; after: string }>;
      previewHash: string;
    }> = [];
    for (const filePath of matchedFiles.sort()) {
      // Re-validate every file against the allowlist before reading it.
      const resolved = resolveWithinRoots(filePath, this.getAllowedRoots(), this.realpath);
      if (!resolved.ok) {
        continue;
      }
      let current: Buffer;
      try {
        current = await readFile(resolved.absolute);
      } catch {
        continue;
      }
      const currentText = current.toString('utf8');
      const newText = applyReplacement(currentText, request.query, request.replacement, request.flags);
      if (newText === currentText) {
        continue;
      }
      const hunks = computeLineHunks(currentText, newText);
      const previewHash = sha256(current);
      previewFiles.push({ path: resolved.absolute, newContent: Buffer.from(newText, 'utf8'), previewHash });
      wireFiles.push({ path: resolved.absolute, hunks, previewHash });
    }
    this.stateFor(connectionId).previews.set(previewId, { previewId, files: previewFiles });
    send({ op: 'replace_preview_result', previewId, files: wireFiles });
  }

  // Re-validate each file's CURRENT hash against the preview before applying;
  // ANY drift → refuse the whole apply (no blind apply). Applies atomically.
  async replaceApply(connectionId: string, request: { previewId: string }, send: SearchSend): Promise<void> {
    const state = this.connections.get(connectionId);
    const preview = state?.previews.get(request.previewId);
    if (preview === undefined) {
      send({ op: 'replace_error', previewId: request.previewId, reason: 'unknown-preview' });
      return;
    }
    // First pass: verify NOTHING changed since the preview.
    for (const file of preview.files) {
      const resolved = resolveWithinRoots(file.path, this.getAllowedRoots(), this.realpath);
      if (!resolved.ok) {
        send({ op: 'replace_error', previewId: request.previewId, reason: 'file-changed' });
        return;
      }
      let current: Buffer;
      try {
        current = await readFile(resolved.absolute);
      } catch {
        send({ op: 'replace_error', previewId: request.previewId, reason: 'file-changed' });
        return;
      }
      if (sha256(current) !== file.previewHash) {
        send({ op: 'replace_error', previewId: request.previewId, reason: 'file-changed' });
        return;
      }
    }
    // Second pass: apply atomically.
    for (const file of preview.files) {
      await writeFileAtomic(file.path, file.newContent);
    }
    state!.previews.delete(request.previewId);
    send({ op: 'replace_applied', previewId: request.previewId, filesChanged: preview.files.length });
  }

  // Kill every in-flight search for a connection and drop its previews (called on
  // socket close so a dropped client leaves no orphaned rg processes).
  disposeConnection(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (state === undefined) {
      return;
    }
    for (const record of state.searches.values()) {
      record.cancelled = true;
      record.process.kill();
    }
    this.connections.delete(connectionId);
  }
}

// Literal (or regex) global replacement of `query` with `replacement` in `text`.
function applyReplacement(text: string, query: string, replacement: string, flags: SearchFlags | undefined): string {
  if (flags?.regex === true) {
    try {
      const regexFlags = flags.caseInsensitive === true ? 'gi' : 'g';
      return text.replace(new RegExp(query, regexFlags), replacement);
    } catch {
      return text; // an invalid regex changes nothing
    }
  }
  // Literal global replace via split/join (no regex-metacharacter surprises).
  if (query.length === 0) {
    return text;
  }
  return text.split(query).join(replacement);
}

// Line-aligned hunks: for each line index that differs, record before/after. A
// mobile-legible per-line diff (the UI renders it; the server just computes it).
function computeLineHunks(
  before: string,
  after: string,
): Array<{ line: number; before: string; after: string }> {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const hunks: Array<{ line: number; before: string; after: string }> = [];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const beforeLine = beforeLines[index] ?? '';
    const afterLine = afterLines[index] ?? '';
    if (beforeLine !== afterLine) {
      hunks.push({ line: index + 1, before: beforeLine, after: afterLine });
    }
  }
  return hunks;
}
