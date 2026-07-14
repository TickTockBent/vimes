import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { watch, type FSWatcher, type ChokidarOptions } from 'chokidar';
import {
  EventRouter,
  TranscriptTail,
  mapTranscriptOutputs,
} from '@vimes/core';
import { defaultProjectsRoot, transcriptDirFor } from './transcriptPaths.js';
import type { SessionTailer } from './sessionHost.js';

// ─── The JSONL tailer: the structured channel for PTY sessions (rule 0.8) ────
//
// chokidar watches ONLY the transcript dirs of registered sessions (never all of
// ~/.claude/projects — that would enroll thousands of files and blow inotify
// limits, spec §3.2). Each watched *.jsonl file gets a per-file TranscriptTail
// fed the bytes appended since the last offset; its outputs map to vocabulary
// events on the owning session's stream.
//
// Correlation (slice 1): SDK-channel files are SKIPPED (the SDK stream is their
// source — single source per session, dedupe); PTY files correlate by
// newest-file-created-after-spawn within the dir (D7's fallback; the `claude -n`
// key is the slice-2 spike).

interface WatchedPtySession {
  appSessionId: string;
  dir: string;
  spawnedAtMs: number;
}

interface FileTailState {
  appSessionId: string;
  offset: number;
  tail: TranscriptTail;
}

export interface JsonlTailerDeps {
  router: EventRouter;
  projectsRoot?: string;
  // chokidar overrides.
  watchOptions?: Partial<ChokidarOptions>;
  // Internal size-poll backstop interval (ms). ⟨tune 100 PREVIEW⟩ — see FINDING
  // below: chokidar drops the trailing append of a rapid burst on this box, so
  // event delivery alone is not trustworthy; the poll guarantees eventual reads.
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;

export class JsonlTailer implements SessionTailer {
  private readonly router: EventRouter;
  private readonly projectsRoot: string;
  private readonly watcher: FSWatcher;
  private readonly dirRefcount = new Map<string, number>();
  private readonly ptySessions = new Map<string, WatchedPtySession>();
  private readonly skipPaths = new Set<string>();
  private readonly fileStates = new Map<string, FileTailState>();
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(deps: JsonlTailerDeps) {
    this.router = deps.router;
    this.projectsRoot = deps.projectsRoot ?? defaultProjectsRoot();
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.watcher = watch([], {
      persistent: true,
      ignoreInitial: false,
      // Only files directly in the transcript dir — not the `memory/` or
      // per-session subdirs Claude Code also writes.
      depth: 0,
      ...deps.watchOptions,
    });
    // chokidar drives the low-latency fast path; the size-poll (started on first
    // watched session) is the reliability backstop for the appends chokidar drops.
    this.watcher.on('add', (path) => this.onFileEvent(path));
    this.watcher.on('change', (path) => this.onFileEvent(path));
  }

  // ── SessionTailer surface (called by the host) ─────────────────────────────
  watchSession(session: { appSessionId: string; cwd: string }): void {
    if (this.closed) {
      return;
    }
    const dir = transcriptDirFor(this.projectsRoot, session.cwd);
    // Date.now(): runtime correlation state, never entered into the event log —
    // determinism-exempt daemon boundary.
    this.ptySessions.set(session.appSessionId, { appSessionId: session.appSessionId, dir, spawnedAtMs: Date.now() });
    const priorRefcount = this.dirRefcount.get(dir) ?? 0;
    this.dirRefcount.set(dir, priorRefcount + 1);
    if (priorRefcount === 0) {
      this.watcher.add(dir);
    }
    this.ensurePolling();
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null || this.closed) {
      return;
    }
    this.pollTimer = setInterval(() => this.scanWatchedDirs(), this.pollIntervalMs);
    // Never keep the process alive on the tailer's account.
    this.pollTimer.unref?.();
  }

  // Backstop: read every *.jsonl in every watched dir to EOF. Idempotent — the
  // per-file offset means an already-consumed file yields nothing.
  private scanWatchedDirs(): void {
    if (this.closed) {
      return;
    }
    for (const dir of this.dirRefcount.keys()) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // dir not created yet — a future poll will find it.
      }
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          this.onFileEvent(join(dir, entry));
        }
      }
    }
  }

  markSdkJsonl(jsonlPath: string): void {
    this.skipPaths.add(jsonlPath);
    this.fileStates.delete(jsonlPath);
  }

  unwatchSession(appSessionId: string): void {
    const session = this.ptySessions.get(appSessionId);
    if (session === undefined) {
      return;
    }
    this.ptySessions.delete(appSessionId);
    const remaining = (this.dirRefcount.get(session.dir) ?? 1) - 1;
    if (remaining <= 0) {
      this.dirRefcount.delete(session.dir);
      this.watcher.unwatch(session.dir);
    } else {
      this.dirRefcount.set(session.dir, remaining);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.watcher.close();
  }

  // ── internals ────────────────────────────────────────────────────────────
  private onFileEvent(path: string): void {
    if (this.closed || !path.endsWith('.jsonl') || this.skipPaths.has(path)) {
      return;
    }

    let state = this.fileStates.get(path);
    if (state === undefined) {
      const appSessionId = this.correlate(path);
      if (appSessionId === undefined) {
        return;
      }
      state = { appSessionId, offset: 0, tail: new TranscriptTail() };
      this.fileStates.set(path, state);
    }

    let sizeBytes: number;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      return;
    }
    // Defensive truncation handling: a shrunk file resets the offset and the
    // line buffer (rule 0.6 — the filesystem is not trusted to only grow).
    if (sizeBytes < state.offset) {
      state.offset = 0;
      state.tail = new TranscriptTail();
    }
    if (sizeBytes <= state.offset) {
      return;
    }

    const appended = readByteRange(path, state.offset, sizeBytes);
    state.offset = sizeBytes;
    if (appended.length === 0) {
      return;
    }
    const outputs = state.tail.push(appended);
    const events = mapTranscriptOutputs(state.appSessionId, outputs, path);
    if (events.length > 0) {
      this.router.emit(events);
    }
  }

  // Assign a file to a PTY session in its dir: newest spawn-before-birth wins; a
  // lone session in the dir takes it outright (n=1 slice-1 path).
  private correlate(path: string): string | undefined {
    const dir = dirname(path);
    const candidates = [...this.ptySessions.values()].filter((session) => session.dir === dir);
    if (candidates.length === 0) {
      return undefined;
    }
    if (candidates.length === 1) {
      return candidates[0]!.appSessionId;
    }
    let birthMs: number;
    try {
      const stats = statSync(path);
      birthMs = stats.birthtimeMs || stats.ctimeMs;
    } catch {
      birthMs = Date.now();
    }
    const eligible = candidates.filter((session) => session.spawnedAtMs <= birthMs);
    const pool = eligible.length > 0 ? eligible : candidates;
    return pool.reduce((newest, session) => (session.spawnedAtMs > newest.spawnedAtMs ? session : newest)).appSessionId;
  }
}

// Read bytes [offset, endByte) from a file as UTF-8. Multibyte sequences split at
// a read boundary are rare for JSONL (ASCII-dominant) and are absorbed by the
// tail's line buffering across the next read.
function readByteRange(path: string, offset: number, endByte: number): string {
  const length = endByte - offset;
  if (length <= 0) {
    return '';
  }
  const fileDescriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fileDescriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fileDescriptor);
  }
}
