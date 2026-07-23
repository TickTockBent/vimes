// Q2 (docs/QUEUE.md) — the pure, tested split behind the session list's
// "age out" disclosure. DISPLAY ONLY: this never removes a row from anywhere,
// it only decides which of the caller's already-loaded rows render by default
// (`visible`) versus behind a "Show N older sessions" tap (`older`). No store,
// event, projection, or wire touches this file — see the Q2 work order's hard
// boundary. `.vue` is not unit-tested here (house rule), so ALL of the age-out
// logic — including the empty-list floor, below — lives in this one pure
// function rather than being reimplemented (and re-tested) inside the view.
//
// Deterministic and locale-free (same posture as the neighbouring libs,
// cacheBadge.ts/meterDisplay.ts): `nowMs` is INJECTED (rule 0.3), never a
// `Date.now()` read inside. No `Intl`.

// Epoch ms for an ISO timestamp, or null when absent/unparseable. Never
// throws — mirrors the small private `parseIsoToEpochMs` each of
// cacheBadge.ts/meterDisplay.ts/correctionStatus.ts carries its own copy of;
// this file follows the same "no shared export, one line, one owner" posture
// rather than pulling in a cross-file dependency for a single expression.
function parseIsoToEpochMs(isoTimestamp: string): number | null {
  const epochMs = Date.parse(isoTimestamp);
  return Number.isFinite(epochMs) ? epochMs : null;
}

// A row's age in ms against the injected clock. An unparseable `createdAt`
// (e.g. a hand-built test fixture, or a projection predating the field) reads
// as infinitely old rather than throwing — it can still surface via the
// `minVisible` floor or an `isAlwaysVisible` override, it just never counts
// as "recent" on its own.
function ageMs(createdAt: string, nowMs: number): number {
  const createdAtMs = parseIsoToEpochMs(createdAt);
  return createdAtMs === null ? Number.POSITIVE_INFINITY : nowMs - createdAtMs;
}

export interface SessionListPartitionConfig<T> {
  // A row is `visible` by recency alone when its age is STRICTLY LESS than
  // this window (age === recencyWindowMs lands in `older` — same "< cutoff is
  // the recent side" convention cacheBadge.ts's warmth boundary uses, so the
  // two "how stale is this row" readings in this view agree with each other).
  readonly recencyWindowMs: number;
  // The empty-list guard (see module doc): even when every row is older than
  // the window, at least `minVisible` of the most-recent rows still render by
  // default. A dormant two-week-old list must never present as empty behind a
  // disclosure — that is worse than the scroll it replaced.
  readonly minVisible: number;
  // Optional override: a row this returns `true` for is ALWAYS `visible`,
  // regardless of age — e.g. a live session or one flagged for attention
  // (Pillar 5 — attention is scarce, age-out must never hide a session that is
  // asking for input). Kept as a caller-supplied predicate rather than a
  // hardcoded field name so this function stays generic over the row shape.
  readonly isAlwaysVisible?: (row: T) => boolean;
}

export interface SessionListPartition<T> {
  readonly visible: T[];
  readonly older: T[];
}

/**
 * Splits already newest-first-sorted rows into what shows by default
 * (`visible`) and what hides behind "show older" (`older`). Order is
 * preserved (newest-first) within both partitions — this function never
 * re-sorts, it only filters the caller's order into two buckets.
 *
 * A row lands in `visible` when it is recent (`age < recencyWindowMs`), OR
 * `isAlwaysVisible` says so, OR the `minVisible` floor needs to promote it
 * (the floor promotes the most-recent not-yet-included rows, in input order,
 * until `minVisible` is met or the rows run out — so the floor always keeps
 * the FRESHEST tail available, never an arbitrary one).
 */
export function partitionSessionsByRecency<T extends { createdAt: string }>(
  rows: readonly T[],
  nowMs: number,
  config: SessionListPartitionConfig<T>,
): SessionListPartition<T> {
  const { recencyWindowMs, minVisible, isAlwaysVisible } = config;

  const included = new Array<boolean>(rows.length).fill(false);
  let includedCount = 0;

  // Pass 1: recency + the always-visible override.
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const isRecent = ageMs(row.createdAt, nowMs) < recencyWindowMs;
    const isForced = isAlwaysVisible?.(row) ?? false;
    if (isRecent || isForced) {
      included[index] = true;
      includedCount += 1;
    }
  }

  // Pass 2: the floor. Promote the most-recent remaining rows, IN INPUT
  // ORDER (newest-first), until `minVisible` is satisfied or rows run out.
  if (includedCount < minVisible) {
    for (let index = 0; index < rows.length && includedCount < minVisible; index += 1) {
      if (!included[index]) {
        included[index] = true;
        includedCount += 1;
      }
    }
  }

  const visible: T[] = [];
  const older: T[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    (included[index] ? visible : older).push(rows[index]!);
  }
  return { visible, older };
}
