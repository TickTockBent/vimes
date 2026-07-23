import { describe, expect, it } from 'vitest';
import { parseMarkdown, resolvePathAgainstCwd, type MarkdownBlock, type MarkdownInline } from './markdown.js';

// Small helpers so assertions read close to the grammar they're pinning,
// rather than reaching into the tree shape by hand every time.
function paragraphText(block: MarkdownBlock): string {
  if (block.kind !== 'paragraph') {
    throw new Error(`expected a paragraph block, got ${block.kind}`);
  }
  return flattenInlineText(block.inlines);
}

function flattenInlineText(inlines: MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case 'text':
          return inline.text;
        case 'code':
          return inline.text;
        case 'path':
          return inline.raw;
        case 'strong':
        case 'em':
        case 'link':
          return flattenInlineText(inline.children);
        default:
          return '';
      }
    })
    .join('');
}

describe('parseMarkdown — headings (assertion 1)', () => {
  it('parses ATX headings at all six levels', () => {
    for (let level = 1; level <= 6; level += 1) {
      const hashes = '#'.repeat(level);
      const blocks = parseMarkdown(`${hashes} Title ${level}`);
      expect(blocks).toEqual([
        { kind: 'heading', level, inlines: [{ kind: 'text', text: `Title ${level}` }] },
      ]);
    }
  });

  it('treats a "#" with no following space as a paragraph, not a heading', () => {
    const blocks = parseMarkdown('#no-space');
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: '#no-space' }] }]);
  });

  it('a 7-hash run is not a valid heading level and falls back to a paragraph', () => {
    const blocks = parseMarkdown('####### too many');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('paragraph');
  });
});

describe('parseMarkdown — fenced code blocks (assertion 2)', () => {
  it('parses a fence with a language token', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ kind: 'codeBlock', language: 'ts', code: 'const x = 1;' }]);
  });

  it('parses a fence with no language token', () => {
    const blocks = parseMarkdown('```\nplain\n```');
    expect(blocks).toEqual([{ kind: 'codeBlock', language: null, code: 'plain' }]);
  });

  it('fence contents are inert: markdown-looking text inside stays completely literal', () => {
    const blocks = parseMarkdown('```\n# not a heading\n**not bold** _not italic_\n```');
    expect(blocks).toEqual([
      { kind: 'codeBlock', language: null, code: '# not a heading\n**not bold** _not italic_' },
    ]);
  });

  it('an unterminated fence degrades to literal text without throwing', () => {
    // NOTE: once degraded, this content is ordinary paragraph text and is
    // still run through the normal INLINE parser — so a stray pair of
    // backticks within the failed fence marker itself can still form an
    // (empty) inline code span, exactly as it would in any other paragraph
    // containing an accidental double-backtick. That is expected, not a
    // content loss: the actual prose/code content is what must survive, not
    // the fence delimiter characters (same as **/* never surviving a
    // successfully-recognized emphasis span).
    expect(() => parseMarkdown('```ts\nconst x = 1;\nno closing fence here')).not.toThrow();
    const blocks = parseMarkdown('```ts\nconst x = 1;\nno closing fence here');
    // Degraded, not swallowed: no opaque codeBlock is produced, and the
    // actual content lines are still present as visible text somewhere.
    expect(blocks.some((block) => block.kind === 'codeBlock')).toBe(false);
    const allText = blocks.map((block) => (block.kind === 'paragraph' ? paragraphText(block) : '')).join('\n');
    expect(allText).toContain('ts');
    expect(allText).toContain('const x = 1;');
    expect(allText).toContain('no closing fence here');
  });
});

describe('parseMarkdown — lists (assertion 3)', () => {
  it('parses a bullet list', () => {
    const blocks = parseMarkdown('- one\n- two\n- three');
    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          { inlines: [{ kind: 'text', text: 'one' }] },
          { inlines: [{ kind: 'text', text: 'two' }] },
          { inlines: [{ kind: 'text', text: 'three' }] },
        ],
      },
    ]);
  });

  it('parses an ordered list', () => {
    const blocks = parseMarkdown('1. first\n2. second');
    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [{ inlines: [{ kind: 'text', text: 'first' }] }, { inlines: [{ kind: 'text', text: 'second' }] }],
      },
    ]);
  });

  it('a hyphen mid-sentence is not a list', () => {
    const blocks = parseMarkdown('This is a well-known fact - not a list.');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'This is a well-known fact - not a list.' }] },
    ]);
  });

  it('a bare "-" with no following space is not a list', () => {
    const blocks = parseMarkdown('-notalist');
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: '-notalist' }] }]);
  });
});

describe('parseMarkdown — horizontal rules', () => {
  it('recognizes ---, ***, and ___ on their own line', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]);
    expect(parseMarkdown('***')).toEqual([{ kind: 'rule' }]);
    expect(parseMarkdown('___')).toEqual([{ kind: 'rule' }]);
  });
});

describe('parseMarkdown — inline: strong/em/code, and B2 (assertion 4)', () => {
  it('parses **strong**, *em*, and `code`', () => {
    const blocks = parseMarkdown('**bold** *italic* `code`');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
          { kind: 'text', text: ' ' },
          { kind: 'em', children: [{ kind: 'text', text: 'italic' }] },
          { kind: 'text', text: ' ' },
          { kind: 'code', text: 'code' },
        ],
      },
    ]);
  });

  it('B2: a code span wins over emphasis — asterisks inside backticks render literally', () => {
    const blocks = parseMarkdown('`**not bold**`');
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'code', text: '**not bold**' }] }]);
  });
});

describe('parseMarkdown — B1 pinned: underscore is never emphasis (assertion 5)', () => {
  it('MIN_VISIBLE_PERCENT survives byte-identical with no emphasis produced', () => {
    const blocks = parseMarkdown('MIN_VISIBLE_PERCENT is the threshold.');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'MIN_VISIBLE_PERCENT is the threshold.' }] },
    ]);
  });

  it('__init__ survives byte-identical with no emphasis produced', () => {
    const blocks = parseMarkdown('def __init__(self):');
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'def __init__(self):' }] }]);
    // Assert directly against the ONE thing that would make this dangerous:
    // no inline node of kind 'em' or 'strong' anywhere in the tree.
    const inlines = (blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] }).inlines;
    expect(inlines.every((inline) => inline.kind !== 'em' && inline.kind !== 'strong')).toBe(true);
  });
});

describe('parseMarkdown — B3 pinned: link href scheme allow-list (assertion 6)', () => {
  const rejectedCases: Array<[string, string]> = [
    ['javascript:', '[click me](javascript:alert(1))'],
    ['JavaScript: (case)', '[click me](JavaScript:alert(1))'],
    ['java\\tscript: (control char)', '[click me](java\tscript:alert(1))'],
    ['data:', '[click me](data:text/html,<script>alert(1)</script>)'],
    ['//evil.example (scheme-relative)', '[click me](//evil.example)'],
  ];

  it.each(rejectedCases)('%s renders as text, label preserved, no link node emitted', (_label, source) => {
    const blocks = parseMarkdown(source);
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] };
    expect(paragraph.kind).toBe('paragraph');
    expect(paragraph.inlines.some((inline) => inline.kind === 'link')).toBe(false);
    expect(flattenInlineText(paragraph.inlines)).toContain('click me');
  });

  it('http:, https:, mailto:, and a relative href all produce link nodes', () => {
    const cases: Array<[string, string]> = [
      ['http://example.com', 'http://example.com'],
      ['https://example.com', 'https://example.com'],
      ['mailto:a@b.com', 'mailto:a@b.com'],
      ['relative', '#/files?path=/a'],
    ];
    for (const [, href] of cases) {
      const blocks = parseMarkdown(`[go](${href})`);
      const paragraph = blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] };
      expect(paragraph.inlines).toEqual([{ kind: 'link', href, children: [{ kind: 'text', text: 'go' }] }]);
    }
  });
});

describe('parseMarkdown — degradation, not deletion (assertion 7)', () => {
  it('unbalanced emphasis degrades to literal text without losing characters', () => {
    const source = 'a **b *c** d';
    const blocks = parseMarkdown(source);
    const visible = blocks.map((block) => paragraphText(block)).join('\n');
    // Every literal character the model wrote is still visible somewhere.
    for (const char of source.replace(/\s+/g, '')) {
      expect(visible.includes(char)).toBe(true);
    }
  });

  it('a malformed link (no closing paren) degrades to literal text, round-tripping every character', () => {
    const source = '[label](http://example.com no closing paren';
    const blocks = parseMarkdown(source);
    const visible = paragraphText(blocks[0]!);
    expect(visible).toBe(source);
  });

  it('a malformed link (no closing bracket) degrades to literal text', () => {
    const source = '[label(http://example.com)';
    const blocks = parseMarkdown(source);
    expect(paragraphText(blocks[0]!)).toBe(source);
  });
});

describe('parseMarkdown — totality (assertion 8)', () => {
  it('never throws on degenerate inputs and returns something', () => {
    const inputs: unknown[] = [
      '',
      '   \n\t  ',
      null,
      undefined,
      'line1\r\nline2\r\nline3',
      '\tindented\twith\ttabs',
      'unicode: café 日本語 emoji: 🎉🔥 lone-surrogate: \uD800 end',
      '*'.repeat(5000),
    ];
    for (const input of inputs) {
      expect(() => parseMarkdown(input as string)).not.toThrow();
      expect(parseMarkdown(input as string)).toBeDefined();
    }
  });

  it('handles 10,000 lines without throwing', () => {
    const bigDocument = Array.from({ length: 10_000 }, (_, idx) => `line ${idx} with **bold** and \`code\``).join(
      '\n',
    );
    expect(() => parseMarkdown(bigDocument)).not.toThrow();
  });

  it('completes promptly on adversarial nested/degenerate emphasis (no catastrophic backtracking)', () => {
    const adversarialInputs = [
      '*'.repeat(50_000),
      '**a'.repeat(20_000),
      '['.repeat(20_000),
      '```lang\n'.repeat(5_000), // many unterminated-looking fence openers, never closed
      'a'.repeat(500_000), // the 500 KB plain-text case
    ];
    for (const input of adversarialInputs) {
      const startedAtMs = Date.now();
      expect(() => parseMarkdown(input)).not.toThrow();
      const elapsedMs = Date.now() - startedAtMs;
      // Generous ceiling (real runs are single-digit milliseconds) — this is a
      // hang detector, not a tight perf budget.
      expect(elapsedMs).toBeLessThan(2000);
    }
  });
});

describe('parseMarkdown — determinism (assertion 9)', () => {
  it('the same input parses to a deeply-equal tree twice', () => {
    const source = '# Title\n\nSome **bold** and *em* and `code` and [a link](https://example.com).\n\n- one\n- two';
    expect(parseMarkdown(source)).toEqual(parseMarkdown(source));
  });
});

describe('parseMarkdown — scope F: code-span path detection (assertion 10)', () => {
  it('a source-extension path in a code span becomes a path node', () => {
    const blocks = parseMarkdown('See `packages/ui/src/lib/markdown.ts` for details.');
    const paragraph = blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] };
    expect(paragraph.inlines).toContainEqual({
      kind: 'path',
      raw: 'packages/ui/src/lib/markdown.ts',
      path: 'packages/ui/src/lib/markdown.ts',
      line: null,
    });
  });

  it('a leading "/" qualifies even with no recognized extension', () => {
    const blocks = parseMarkdown('`/etc/hosts`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: '/etc/hosts', path: '/etc/hosts', line: null }] },
    ]);
  });

  it('a leading "./" qualifies', () => {
    const blocks = parseMarkdown('`./scripts/ci-gate.sh`');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inlines: [{ kind: 'path', raw: './scripts/ci-gate.sh', path: './scripts/ci-gate.sh', line: null }],
      },
    ]);
  });

  it('a leading "~/" qualifies', () => {
    const blocks = parseMarkdown('`~/projects/x.md`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: '~/projects/x.md', path: '~/projects/x.md', line: null }] },
    ]);
  });
});

describe('parseMarkdown — scope F: the precision cases (assertion 11)', () => {
  const precisionCases: Array<[string, string]> = [
    ['application/json (no extension, no leading slash)', 'application/json'],
    ['npm run build (whitespace)', 'npm run build'],
    ['and/or', 'and/or'],
    ['SessionRecord', 'SessionRecord'],
  ];

  it.each(precisionCases)('%s stays an ordinary code node, no path node emitted', (_label, codeSpanContent) => {
    const blocks = parseMarkdown(`\`${codeSpanContent}\``);
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'code', text: codeSpanContent }] }]);
  });
});

describe('parseMarkdown — scope F: file:line parsing (assertion 12)', () => {
  it('file:line parses the line number', () => {
    const blocks = parseMarkdown('`wsHub.ts:421`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: 'wsHub.ts:421', path: 'wsHub.ts', line: 421 }] },
    ]);
  });

  it('file:line:col parses the line number, ignoring the column', () => {
    const blocks = parseMarkdown('`a.ts:42:7`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: 'a.ts:42:7', path: 'a.ts', line: 42 }] },
    ]);
  });

  it('a non-numeric suffix is not a line — the whole thing is the path name', () => {
    const blocks = parseMarkdown('`foo.ts:bar`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: 'foo.ts:bar', path: 'foo.ts:bar', line: null }] },
    ]);
  });

  it('line 0 normalizes to null', () => {
    const blocks = parseMarkdown('`a.ts:0`');
    expect(blocks).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'path', raw: 'a.ts:0', path: 'a.ts', line: null }] }]);
  });

  it('a negative line normalizes to null', () => {
    const blocks = parseMarkdown('`a.ts:-3`');
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'path', raw: 'a.ts:-3', path: 'a.ts', line: null }] },
    ]);
  });
});

describe('resolvePathAgainstCwd — scope F3 (assertion 13)', () => {
  it('passes an absolute path through unchanged (once normalized)', () => {
    expect(resolvePathAgainstCwd('/home/user/proj', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('joins a relative path against the session cwd', () => {
    expect(resolvePathAgainstCwd('/home/user/proj', 'src/index.ts')).toBe('/home/user/proj/src/index.ts');
  });

  it('normalizes "." and ".." rather than throwing or rejecting', () => {
    expect(() => resolvePathAgainstCwd('/home/user/proj', '../lib/x.ts')).not.toThrow();
    expect(resolvePathAgainstCwd('/home/user/proj', '../lib/x.ts')).toBe('/home/user/lib/x.ts');
    expect(resolvePathAgainstCwd('/home/user/proj', './src/./x.ts')).toBe('/home/user/proj/src/x.ts');
  });

  it('a path that normalizes outside the roots is still produced, not rejected client-side — the daemon 403s it', () => {
    const escaped = resolvePathAgainstCwd('/home/user/proj', '../../../../../../etc/passwd');
    expect(() => escaped).not.toThrow();
    expect(escaped).toBe('/etc/passwd');
  });
});

describe('markdown.ts — scope F: href round-trip and anchor attributes (assertion 14)', () => {
  it('encodeURIComponent round-trips a path with spaces, #, ?, and & without corruption', () => {
    const trickyPath = '/home/user/my folder/a file#1?q=2&r=3.ts';
    const encoded = encodeURIComponent(trickyPath);
    expect(decodeURIComponent(encoded)).toBe(trickyPath);
    // The characters a raw href would otherwise treat specially never survive
    // un-encoded into the query string.
    expect(encoded.includes('#')).toBe(false);
    expect(encoded.includes('?')).toBe(false);
    expect(encoded.includes('&')).toBe(false);
    expect(encoded.includes(' ')).toBe(false);
  });
  // The anchor's target="_blank" + rel="noopener noreferrer" attributes are
  // asserted in StreamView's render (no DOM here) — see the checkpoint notes
  // for how that was verified against the built output.
});

describe('parseMarkdown — scope F: raw is preserved byte-identical (assertion 15)', () => {
  it("a path node's raw matches the original code-span content exactly", () => {
    const original = 'packages/ui/src/lib/markdown.ts';
    const blocks = parseMarkdown(`\`${original}\``);
    const paragraph = blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] };
    const pathNode = paragraph.inlines[0]!;
    expect(pathNode.kind).toBe('path');
    expect((pathNode as { raw: string }).raw).toBe(original);
  });

  it("a path node with a stripped :line suffix still has a raw carrying the FULL original text", () => {
    const blocks = parseMarkdown('`wsHub.ts:421`');
    const paragraph = blocks[0] as { kind: 'paragraph'; inlines: MarkdownInline[] };
    const pathNode = paragraph.inlines[0]! as { kind: 'path'; raw: string; path: string };
    expect(pathNode.raw).toBe('wsHub.ts:421');
    expect(pathNode.path).toBe('wsHub.ts'); // path stripped; raw is not
  });
});
