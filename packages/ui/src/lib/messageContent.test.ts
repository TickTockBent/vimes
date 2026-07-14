import { describe, expect, it } from 'vitest';
import { extractTextBlocks } from './messageContent.js';

describe('extractTextBlocks', () => {
  it('wraps a plain string as a single block', () => {
    expect(extractTextBlocks('hello')).toEqual(['hello']);
  });

  it('drops an empty string', () => {
    expect(extractTextBlocks('')).toEqual([]);
  });

  it('extracts text blocks from an array, in order', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(extractTextBlocks(content)).toEqual(['first', 'second']);
  });

  it('ignores non-text block types without throwing', () => {
    const content = [
      { type: 'tool_use', id: 't1', input: {} },
      { type: 'text', text: 'kept' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'image', source: {} },
    ];
    expect(extractTextBlocks(content)).toEqual(['kept']);
  });

  it('ignores malformed block entries', () => {
    const content = [null, 42, 'raw-string-entry', { type: 'text' }, { text: 'no-type' }, { type: 'text', text: 123 }];
    expect(extractTextBlocks(content)).toEqual([]);
  });

  it('returns an empty array for unknown/unsupported shapes', () => {
    expect(extractTextBlocks(null)).toEqual([]);
    expect(extractTextBlocks(undefined)).toEqual([]);
    expect(extractTextBlocks(42)).toEqual([]);
    expect(extractTextBlocks({ weird: 'object' })).toEqual([]);
  });
});
