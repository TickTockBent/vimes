// Pure framing for raw-terminal binary WS frames (docs/slice-3.md §Raw terminal;
// packages/daemon/src/wsHub.ts is the wire authority). A frame is
// `[uint8 terminalTag][...payloadBytes]`: the leading byte routes to a terminal on
// this connection, the rest is verbatim PTY bytes. NOTHING here parses the payload
// for meaning (rule 0.8) — it only prepends/strips the tag byte and counts bytes.

export interface DeframedOutput {
  tag: number;
  payload: Uint8Array;
}

const textEncoder = new TextEncoder();

// Prepend the terminal tag to raw input bytes → the wire frame the daemon expects.
export function frameTerminalInput(tag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = tag & 0xff;
  frame.set(payload, 1);
  return frame;
}

// Convenience: frame keystroke TEXT (what xterm's onData yields) as UTF-8 bytes.
export function frameTerminalInputText(tag: number, text: string): Uint8Array {
  return frameTerminalInput(tag, textEncoder.encode(text));
}

// Split a server binary frame into its tag + payload. Returns null for an empty
// frame (nothing to route) so the caller can drop it silently.
export function deframeTerminalOutput(frame: Uint8Array): DeframedOutput | null {
  if (frame.length < 1) {
    return null;
  }
  return { tag: frame[0]!, payload: frame.subarray(1) };
}

// Advance the client's byte offset by however many payload bytes it just consumed.
// The running total mirrors the daemon's totalBytesSeen, so a reconnect
// re-subscribes with exactly this offset (I9 byte conservation).
export function advanceOffset(currentOffset: number, consumedBytes: number): number {
  return currentOffset + consumedBytes;
}
