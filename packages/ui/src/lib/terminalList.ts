// Pure derivation for the terminals-list landing (TerminalView.vue) — the
// visibility that makes persistent shells safe (terminal-lifecycle backlog item).
// No Vue, no DOM, no I/O: every branch is unit-tested without a browser.
//
// A terminal is LIVE-OR-DEAD, never sleepable (its state is a live process tree,
// not a replayable transcript). This list only ever shows shells the daemon still
// has alive; "re-enter" means re-subscribe to a running shell, not resume.

// The byte-free shape GET /api/terminals returns (mirrors the daemon's
// TerminalInfo — never the pty, never buffered bytes, rule 0.8).
export interface TerminalListItem {
  terminalId: string;
  cwd: string;
  lastActivityAt: string;
  resilient: boolean;
  subscriberCount: number;
}

export interface TerminalRow {
  terminalId: string;
  cwd: string;
  cwdTail: string;
  resilient: boolean;
  // Someone else (another tab/phone) is watching this shell right now.
  watched: boolean;
  lastActiveLabel: string;
}

// Last path segment — the human-legible shell label (the full cwd is shown too,
// but the tail is what fits a tight mobile row).
function cwdTail(cwd: string): string {
  const segments = cwd.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : cwd;
}

// Coarse relative time — the list only needs "how stale" at a glance, not a
// precise duration. A future/negative delta (clock skew between the browser and
// the daemon) clamps to "just now" rather than showing a nonsensical value.
export function formatRelativeTime(nowMs: number, lastActivityAt: string): string {
  const thenMs = Date.parse(lastActivityAt);
  if (Number.isNaN(thenMs)) {
    return 'unknown';
  }
  const deltaMs = nowMs - thenMs;
  if (deltaMs < 45_000) {
    return 'just now';
  }
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(deltaMs / 86_400_000);
  return `${days}d ago`;
}

export function deriveTerminalRow(item: TerminalListItem, nowMs: number): TerminalRow {
  return {
    terminalId: item.terminalId,
    cwd: item.cwd,
    cwdTail: cwdTail(item.cwd),
    resilient: item.resilient,
    watched: item.subscriberCount > 0,
    lastActiveLabel: formatRelativeTime(nowMs, item.lastActivityAt),
  };
}

// Rows most-recently-active first — a stable, deterministic order so the list
// does not jitter between fetches. Ties break by terminalId (stable id order).
export function deriveTerminalRows(items: readonly TerminalListItem[], nowMs: number): TerminalRow[] {
  return [...items]
    .sort((a, b) => {
      const activityDelta = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return a.terminalId.localeCompare(b.terminalId);
    })
    .map((item) => deriveTerminalRow(item, nowMs));
}

// Re-enter offset: a fresh page load (or any navigate-away/return) has no local
// byte offset for the shell, so it subscribes from 0 and the ring replays what it
// still holds (term_lost fires if the gap exceeded the window). A caller that DOES
// still hold an offset for this exact terminal passes it through to avoid a
// redundant replay. Null/undefined/negative → 0.
export function decideReenterOffset(storedOffset: number | null | undefined): number {
  if (storedOffset === null || storedOffset === undefined || storedOffset < 0) {
    return 0;
  }
  return storedOffset;
}
