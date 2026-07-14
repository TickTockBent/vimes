import { describe, expect, it } from 'vitest';
import { extractContentBlocks } from './messageContent.js';

describe('extractContentBlocks', () => {
  it('wraps a plain string as a single text block', () => {
    expect(extractContentBlocks('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('drops an empty string', () => {
    expect(extractContentBlocks('')).toEqual([]);
  });

  it('extracts text blocks from an array, in order', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(extractContentBlocks(content)).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ]);
  });

  it('classifies a thinking block with no content', () => {
    const content = [{ type: 'thinking', thinking: 'hmm, let me consider this' }];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'thinking' }]);
  });

  it('classifies a tool_use block with a truncated input preview', () => {
    const content = [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } }];
    expect(extractContentBlocks(content)).toEqual([
      { kind: 'tool', name: 'Read', inputPreview: JSON.stringify({ file_path: '/a/b.ts' }) },
    ]);
  });

  it('truncates a long tool_use input to ~80 chars with an ellipsis', () => {
    const longInput = { command: 'x'.repeat(200) };
    const content = [{ type: 'tool_use', name: 'Bash', input: longInput }];
    const blocks = extractContentBlocks(content);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toMatchObject({ kind: 'tool', name: 'Bash' });
    if (block !== undefined && block.kind === 'tool') {
      expect(block.inputPreview.length).toBe(81); // 80 chars + ellipsis
      expect(block.inputPreview.endsWith('…')).toBe(true);
      expect(JSON.stringify(longInput).startsWith(block.inputPreview.slice(0, -1))).toBe(true);
    }
  });

  it('defaults a missing tool_use input to an empty object', () => {
    const content = [{ type: 'tool_use', name: 'Glob' }];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'tool', name: 'Glob', inputPreview: '{}' }]);
  });

  it('ignores a tool_use block without a name', () => {
    const content = [{ type: 'tool_use', input: {} }];
    expect(extractContentBlocks(content)).toEqual([]);
  });

  it('flattens a plain-string tool_result into a preview', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents here' }];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'toolResult', preview: 'file contents here' }]);
  });

  it('flattens a nested-block tool_result into a joined preview', () => {
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'x',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      },
    ];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'toolResult', preview: 'line one line two' }]);
  });

  it('truncates a long tool_result preview to ~120 chars with an ellipsis', () => {
    const content = [{ type: 'tool_result', content: 'y'.repeat(500) }];
    const blocks = extractContentBlocks(content);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.kind).toBe('toolResult');
    if (block !== undefined && block.kind === 'toolResult') {
      expect(block.preview.length).toBe(121); // 120 chars + ellipsis
      expect(block.preview.endsWith('…')).toBe(true);
    }
  });

  it('produces an empty preview for a tool_result with unrecognized content shape', () => {
    const content = [{ type: 'tool_result', content: 42 }];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'toolResult', preview: '' }]);
  });

  it('ignores non-text/thinking/tool_use/tool_result block types without throwing', () => {
    const content = [
      { type: 'image', source: {} },
      { type: 'text', text: 'kept' },
      { type: 'redacted_thinking', data: 'xyz' },
    ];
    expect(extractContentBlocks(content)).toEqual([{ kind: 'text', text: 'kept' }]);
  });

  it('classifies a mixed assistant turn in order', () => {
    const content = [
      { type: 'thinking', thinking: 'considering' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'done' },
    ];
    expect(extractContentBlocks(content)).toEqual([
      { kind: 'thinking' },
      { kind: 'tool', name: 'Bash', inputPreview: JSON.stringify({ command: 'ls' }) },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('ignores malformed block entries', () => {
    const content = [null, 42, 'raw-string-entry', { type: 'text' }, { text: 'no-type' }, { type: 'text', text: 123 }];
    expect(extractContentBlocks(content)).toEqual([]);
  });

  it('returns an empty array for unknown/unsupported shapes', () => {
    expect(extractContentBlocks(null)).toEqual([]);
    expect(extractContentBlocks(undefined)).toEqual([]);
    expect(extractContentBlocks(42)).toEqual([]);
    expect(extractContentBlocks({ weird: 'object' })).toEqual([]);
  });
});
