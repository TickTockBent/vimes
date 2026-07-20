import { describe, expect, it } from 'vitest';
import {
  advanceOffset,
  deframeTerminalOutput,
  frameTerminalInput,
  frameTerminalInputText,
} from './terminalFraming.js';

describe('terminalFraming', () => {
  it('frames input bytes with the tag as the leading byte', () => {
    const frame = frameTerminalInput(3, new Uint8Array([0x61, 0x62]));
    expect(Array.from(frame)).toEqual([3, 0x61, 0x62]);
  });

  it('frames keystroke text as UTF-8 after the tag', () => {
    const frame = frameTerminalInputText(0, 'ls\r');
    expect(frame[0]).toBe(0);
    expect(new TextDecoder().decode(frame.subarray(1))).toBe('ls\r');
  });

  it('masks the tag to a single byte', () => {
    const frame = frameTerminalInput(258, new Uint8Array([9]));
    expect(frame[0]).toBe(258 & 0xff); // 2
  });

  it('deframes a server frame into tag + payload', () => {
    const result = deframeTerminalOutput(new Uint8Array([7, 0x68, 0x69]));
    expect(result).not.toBeNull();
    expect(result!.tag).toBe(7);
    expect(new TextDecoder().decode(result!.payload)).toBe('hi');
  });

  it('deframe/frame round-trips the payload bytes', () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const round = deframeTerminalOutput(frameTerminalInput(5, payload));
    expect(round).not.toBeNull();
    expect(Array.from(round!.payload)).toEqual(Array.from(payload));
  });

  it('returns null for an empty frame (dropped silently)', () => {
    expect(deframeTerminalOutput(new Uint8Array(0))).toBeNull();
  });

  it('advances the offset by the consumed byte count', () => {
    expect(advanceOffset(0, 5)).toBe(5);
    expect(advanceOffset(5, 3)).toBe(8);
    expect(advanceOffset(8, 0)).toBe(8);
  });
});
