// ─── TerminalRingBuffer — the I9 byte-conservation mechanism (pure, headless) ──
//
// Holds the raw output bytes of ONE terminal in a bounded window so a reconnecting
// client can replay exactly what a never-disconnected client saw (spec §3.4, I9).
// PTY bytes are relayed verbatim — this buffer only counts and stores them, never
// parses them (rule 0.8). Fully deterministic: no clocks, no randomness, no I/O.
//
// Byte accounting:
//   totalBytesSeen  — every byte ever appended (monotonic; survives eviction).
//   buffered        — bytes currently retained (== totalBytesSeen once nothing has
//                     been evicted; caps at maxBytes thereafter).
//   windowStart     — totalBytesSeen - buffered — the offset of the oldest byte
//                     still replayable. Anything before it has been evicted.
//
// replayFrom(offset) is the honest reconnect contract: within the window it
// returns the EXACT bytes from `offset` onward; if `offset` fell out of the window
// (a disconnect longer than the buffer) it returns whatever remains flagged
// `lost: true` — never a silent skip.

// ⟨tune 2 MB PREVIEW⟩ — the per-terminal reconnect window (spec §3.4). A plain
// default; nothing asserts this number (rule 0.2).
export const DEFAULT_TERMINAL_BUFFER_BYTES = 2 * 1024 * 1024;

export interface TerminalReplay {
  // The retained bytes from the requested offset onward (empty when caught up).
  bytes: Uint8Array;
  // The offset a caller has now consumed to — i.e. totalBytesSeen at call time.
  // A reconnecting client continues live from here.
  nextOffset: number;
  // True when the requested offset had already been evicted: `bytes` is only the
  // remaining tail of the window, and output between `offset` and windowStart was
  // dropped. The client MUST surface this (§3.2 resync philosophy) — never hide it.
  lost: boolean;
}

export class TerminalRingBuffer {
  private readonly maxBytes: number;
  // Retained bytes as a list of chunks (append is O(1) amortized; front-eviction
  // trims/drops chunks; replay concatenates the needed suffix only on demand).
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private total = 0;

  constructor(maxBytes: number = DEFAULT_TERMINAL_BUFFER_BYTES) {
    // A non-positive cap would make the window meaningless; clamp to at least 1.
    this.maxBytes = maxBytes > 0 ? maxBytes : 1;
  }

  // Every byte ever appended (monotonic across evictions). This is the offset a
  // live subscriber has reached after consuming everything.
  get totalBytesSeen(): number {
    return this.total;
  }

  // Bytes currently retained (replayable without loss). == totalBytesSeen until
  // the first eviction, then bounded by maxBytes.
  get bufferedBytes(): number {
    return this.buffered;
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    this.chunks.push(bytes);
    this.buffered += bytes.length;
    this.total += bytes.length;
    this.evictOverflow();
  }

  // Drop oldest bytes until the window is within cap. Whole leading chunks are
  // released; the boundary chunk is trimmed to its tail so `buffered` lands
  // exactly on maxBytes (a single append larger than the window keeps only its
  // last maxBytes — the earliest bytes are honestly lost).
  private evictOverflow(): void {
    while (this.buffered > this.maxBytes) {
      const firstChunk = this.chunks[0]!;
      const bufferedWithoutFirst = this.buffered - firstChunk.length;
      if (bufferedWithoutFirst >= this.maxBytes) {
        this.chunks.shift();
        this.buffered = bufferedWithoutFirst;
      } else {
        const overflow = this.buffered - this.maxBytes;
        this.chunks[0] = firstChunk.subarray(overflow);
        this.buffered = this.maxBytes;
      }
    }
  }

  // Replay from an absolute byte offset. See TerminalReplay for the loss contract.
  replayFrom(offset: number): TerminalReplay {
    const windowStart = this.total - this.buffered;
    if (offset < windowStart) {
      // The requested offset was evicted — return the whole retained tail, flagged
      // lost. (Covers negatives / absurd offsets too: they are honestly "before
      // the window".)
      return { bytes: this.concatFrom(0), nextOffset: this.total, lost: true };
    }
    // offset >= windowStart: serve exactly from offset. An offset at/after
    // totalBytesSeen yields an empty (already caught up) slice.
    const skip = offset - windowStart;
    if (skip >= this.buffered) {
      return { bytes: new Uint8Array(0), nextOffset: this.total, lost: false };
    }
    return { bytes: this.concatFrom(skip), nextOffset: this.total, lost: false };
  }

  // Concatenate retained bytes starting `skip` bytes into the window.
  private concatFrom(skip: number): Uint8Array {
    const out = new Uint8Array(this.buffered - skip);
    let remainingSkip = skip;
    let writeAt = 0;
    for (const chunk of this.chunks) {
      if (remainingSkip >= chunk.length) {
        remainingSkip -= chunk.length;
        continue;
      }
      const from = remainingSkip;
      remainingSkip = 0;
      out.set(chunk.subarray(from), writeAt);
      writeAt += chunk.length - from;
    }
    return out;
  }
}
