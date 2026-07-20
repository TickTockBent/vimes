import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_BUFFER_BYTES, TerminalRingBuffer } from './ringBuffer.js';

// Deterministic byte stream: byte i = i mod 256. Lets every assertion be an exact
// byte-value check, not a length tolerance.
function scriptedBytes(count: number, startAt = 0): Uint8Array {
  const out = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    out[index] = (startAt + index) % 256;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('TerminalRingBuffer — I9 byte conservation across reconnect', () => {
  it('a reconnecting observer replays a byte-IDENTICAL sequence to a never-disconnected one (within window)', () => {
    // Window comfortably larger than the whole stream so nothing is evicted — the
    // pure reconnect-identity property.
    const buffer = new TerminalRingBuffer(1_000_000);

    // The full scripted stream B, delivered as many uneven appends.
    const appendSizes = [1, 7, 40, 3, 256, 19, 100, 5, 2, 71, 33, 128];
    const streamB = scriptedBytes(appendSizes.reduce((sum, size) => sum + size, 0));

    // The never-disconnected observer sees every append, in order.
    const neverDisconnected: number[] = [];
    // The reconnecting observer disconnects after k bytes; on reconnect it replays
    // from k, THEN continues receiving every live append (accumulated here).
    const disconnectAfter = 51;
    let bytesFedSoFar = 0;
    let hasReconnected = false;
    const reconnectObserved: number[] = [];

    let cursor = 0;
    for (const size of appendSizes) {
      const slice = streamB.subarray(cursor, cursor + size);
      cursor += size;
      buffer.append(slice);
      for (const byte of slice) {
        neverDisconnected.push(byte);
      }
      bytesFedSoFar += size;
      // At the moment we cross the disconnect point, the reconnecting client comes
      // back and asks for everything from offset k (one-shot replay).
      if (!hasReconnected && bytesFedSoFar >= disconnectAfter) {
        hasReconnected = true;
        const replay = buffer.replayFrom(disconnectAfter);
        expect(replay.lost).toBe(false);
        for (const byte of replay.bytes) {
          reconnectObserved.push(byte);
        }
      } else if (hasReconnected) {
        // Now live: it receives each subsequent append exactly as it lands.
        for (const byte of slice) {
          reconnectObserved.push(byte);
        }
      }
    }

    // The reconnecting observer's post-offset sequence == the never-disconnected
    // observer's tail from the same offset. Exact, byte for byte.
    const neverDisconnectedTail = neverDisconnected.slice(disconnectAfter);
    expect(reconnectObserved).toEqual(neverDisconnectedTail);
    // And the whole stream is conserved from offset 0.
    expect(Array.from(buffer.replayFrom(0).bytes)).toEqual(Array.from(streamB));
    expect(buffer.totalBytesSeen).toBe(streamB.length);
  });

  it('live-continuation after reconnect stays byte-identical: replay(k) ++ live == never-disconnected', () => {
    const buffer = new TerminalRingBuffer(1_000_000);
    const firstHalf = scriptedBytes(300, 0);
    const secondHalf = scriptedBytes(300, 300);

    // Feed the first half; a client that never left has seen all 300.
    buffer.append(firstHalf);

    // A client that disconnected at offset k reconnects and replays.
    const k = 128;
    const replayed = buffer.replayFrom(k);
    expect(replayed.lost).toBe(false);
    expect(replayed.nextOffset).toBe(300);

    // Now more output arrives live; both clients receive it identically.
    buffer.append(secondHalf);
    const liveTail = buffer.replayFrom(replayed.nextOffset);
    expect(liveTail.lost).toBe(false);

    const reconnectFullTail = concat([replayed.bytes, liveTail.bytes]);
    const neverDisconnectedTail = concat([firstHalf, secondHalf]).subarray(k);
    expect(Array.from(reconnectFullTail)).toEqual(Array.from(neverDisconnectedTail));
  });

  it('a disconnect longer than the window returns lost:true with the remaining tail (never a silent skip)', () => {
    const windowBytes = 100;
    const buffer = new TerminalRingBuffer(windowBytes);

    // A client saw the first 40 bytes, then disconnected.
    buffer.append(scriptedBytes(40, 0));
    const goodReconnect = buffer.replayFrom(40);
    expect(goodReconnect.lost).toBe(false);
    expect(goodReconnect.bytes.length).toBe(0); // caught up, nothing new yet

    // While gone, 500 more bytes stream — far past the 100-byte window. Offset 40
    // is long evicted (windowStart is now 540 - 100 = 440).
    buffer.append(scriptedBytes(500, 40));
    expect(buffer.totalBytesSeen).toBe(540);
    expect(buffer.bufferedBytes).toBe(windowBytes);

    const lostReconnect = buffer.replayFrom(40);
    expect(lostReconnect.lost).toBe(true);
    // The honest tail: the last `windowBytes` of the stream (offsets 440..539).
    expect(lostReconnect.bytes.length).toBe(windowBytes);
    expect(Array.from(lostReconnect.bytes)).toEqual(Array.from(scriptedBytes(windowBytes, 440)));
    expect(lostReconnect.nextOffset).toBe(540);

    // A reconnect from exactly the window boundary is served WITHOUT loss.
    const boundary = buffer.replayFrom(440);
    expect(boundary.lost).toBe(false);
    expect(Array.from(boundary.bytes)).toEqual(Array.from(scriptedBytes(windowBytes, 440)));
  });

  it('evicts oldest bytes exactly to the cap, boundary chunk trimmed (byte-exact)', () => {
    const buffer = new TerminalRingBuffer(10);
    buffer.append(scriptedBytes(6, 0)); // 0..5
    buffer.append(scriptedBytes(6, 6)); // 6..11 → total 12, over cap by 2
    expect(buffer.totalBytesSeen).toBe(12);
    expect(buffer.bufferedBytes).toBe(10);
    // windowStart = 2; retained bytes are offsets 2..11.
    const all = buffer.replayFrom(2);
    expect(all.lost).toBe(false);
    expect(Array.from(all.bytes)).toEqual(Array.from(scriptedBytes(10, 2)));
    // Offset 1 is evicted → lost.
    expect(buffer.replayFrom(1).lost).toBe(true);
  });

  it('a single append larger than the window keeps only its last maxBytes', () => {
    const buffer = new TerminalRingBuffer(8);
    buffer.append(scriptedBytes(20, 0)); // 0..19
    expect(buffer.totalBytesSeen).toBe(20);
    expect(buffer.bufferedBytes).toBe(8);
    const tail = buffer.replayFrom(12);
    expect(tail.lost).toBe(false);
    expect(Array.from(tail.bytes)).toEqual(Array.from(scriptedBytes(8, 12)));
    expect(buffer.replayFrom(11).lost).toBe(true);
  });

  it('empty appends are no-ops; a fresh buffer replays empty without loss', () => {
    const buffer = new TerminalRingBuffer();
    buffer.append(new Uint8Array(0));
    expect(buffer.totalBytesSeen).toBe(0);
    const replay = buffer.replayFrom(0);
    expect(replay.lost).toBe(false);
    expect(replay.bytes.length).toBe(0);
    expect(replay.nextOffset).toBe(0);
  });

  it('offset past totalBytesSeen returns an empty, non-lost slice at the live head', () => {
    const buffer = new TerminalRingBuffer(100);
    buffer.append(scriptedBytes(30, 0));
    const ahead = buffer.replayFrom(999);
    expect(ahead.lost).toBe(false);
    expect(ahead.bytes.length).toBe(0);
    expect(ahead.nextOffset).toBe(30);
  });

  it('exposes a 2 MB default window', () => {
    expect(DEFAULT_TERMINAL_BUFFER_BYTES).toBe(2 * 1024 * 1024);
    const buffer = new TerminalRingBuffer();
    // Fits well under the default — nothing evicted.
    buffer.append(scriptedBytes(1000));
    expect(buffer.bufferedBytes).toBe(1000);
    expect(buffer.replayFrom(0).lost).toBe(false);
  });
});
