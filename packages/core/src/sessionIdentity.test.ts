import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  extractMessageText,
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
  HARNESS_WRAPPER_TITLE_PREFIXES,
  SESSION_TITLE_MAX_LENGTH,
} from './sessionIdentity.js';

// ─── Q3 assertions 3, 4, 5, 8, 10, 11 — the derivation and the ladder ─────────

describe('extractMessageText: content is LOOSE, and an unknown shape contributes nothing', () => {
  it('a plain string is itself', () => {
    expect(extractMessageText('Review the current codebase')).toBe('Review the current codebase');
  });

  it('an array of text blocks concatenates', () => {
    expect(
      extractMessageText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first second');
  });

  // Assertion 4. This is the LIVE shape, not a hypothetical: `tool_result`
  // arrives as a `role:'user'` message, and 9 of the 13 sessions in the live
  // event log have them. Stringifying one would title a session with a wall of
  // JSON or `[object Object]`.
  it.each([
    ['tool_result', [{ type: 'tool_result', content: 'total 120\ndrwxr-xr-x 9 …', tool_use_id: 'toolu_01' }]],
    ['image', [{ type: 'image', source: { data: 'AAAA' } }]],
    ['a block with no type', [{ text: 'orphan' }]],
    ['a null block', [null]],
    ['a primitive block', [42, 'loose']],
    ['a text block whose text is not a string', [{ type: 'text', text: { nested: true } }]],
  ])('%s contributes nothing and never throws', (_label, content) => {
    expect(extractMessageText(content)).toBe('');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a bare object', { role: 'user' }],
  ])('%s yields the empty string rather than throwing (I8)', (_label, content) => {
    expect(extractMessageText(content)).toBe('');
  });

  it('a mixed array keeps only the text blocks', () => {
    expect(
      extractMessageText([
        { type: 'tool_result', content: 'noise' },
        { type: 'text', text: 'the actual ask' },
      ]),
    ).toBe('the actual ask');
  });
});

describe('deriveSessionTitle: the skip rules are recognized SHAPES, one case each', () => {
  it('a real first prompt becomes the title', () => {
    expect(deriveSessionTitle('Look at the development plan and write next-steps.md')).toBe(
      'Look at the development plan and write next-steps.md',
    );
  });

  // Assertion 3 — empty.
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['content with no text blocks', [{ type: 'tool_result', content: 'x' }]],
  ])('%s yields null (absent, not an empty title)', (_label, content) => {
    expect(deriveSessionTitle(content)).toBeNull();
  });

  // Assertion 3 — the bare slash command. `/compact` is 1 of the 13 live
  // sessions' first user messages.
  it.each(['/compact', '/clear', '/context-usage', '  /compact  '])(
    'the bare slash command %s yields null',
    (command) => {
      expect(deriveSessionTitle(command)).toBeNull();
    },
  );

  it('a slash command with real words after it is a REAL title, not a skip', () => {
    expect(deriveSessionTitle('/compact the docs and tell me what changed')).toBe(
      '/compact the docs and tell me what changed',
    );
  });

  // Assertion 3 — every harness-wrapper prefix, one case each. Driven off the
  // exported constant so adding a prefix without a case is impossible.
  it.each(HARNESS_WRAPPER_TITLE_PREFIXES)('the harness wrapper %s yields null', (wrapperPrefix) => {
    expect(deriveSessionTitle(`${wrapperPrefix} whatever follows it`)).toBeNull();
  });

  it('every wrapper prefix in the list is actually exercised above', () => {
    expect(HARNESS_WRAPPER_TITLE_PREFIXES.length).toBe(5);
  });

  // Assertion 5 — whitespace collapse + truncation at the bound.
  it('collapses whitespace to a single line', () => {
    expect(deriveSessionTitle('  Fix   the\n\nledger\ttitles  ')).toBe('Fix the ledger titles');
  });

  it('strips control bytes rather than smuggling them into a label', () => {
    const withEscape = `Compacted \u001b[2mnow\u001b[22m`;
    const title = deriveSessionTitle(withEscape)!;
    // The ESC becomes a space (then collapses) — the SGR payload is left as
    // ordinary text rather than being interpreted; nothing here parses ANSI.
    expect(title).toBe('Compacted [2mnow [22m');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(title)).toBe(false);
  });

  it(`truncates at ${SESSION_TITLE_MAX_LENGTH} — the same bound renameSession enforces on a human name`, () => {
    const longPrompt = 'w'.repeat(400);
    const title = deriveSessionTitle(longPrompt)!;
    expect(title).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(title).toBe('w'.repeat(SESSION_TITLE_MAX_LENGTH));
  });

  it('truncation happens AFTER collapse, so padding never eats the bound', () => {
    const paddedPrompt = `${' '.repeat(200)}${'x'.repeat(130)}`;
    expect(deriveSessionTitle(paddedPrompt)).toBe('x'.repeat(SESSION_TITLE_MAX_LENGTH));
  });
});

describe('the fallback rung: deterministic, locale-free, and DISTINGUISHING', () => {
  it('formats an ISO instant as it was written — UTC, from the string', () => {
    expect(formatSessionTimestamp('2026-07-19T23:25:51.371Z')).toBe('Jul 19 23:25');
    expect(formatSessionTimestamp('2026-01-06T04:05:00.000Z')).toBe('Jan 06 04:05');
    expect(formatSessionTimestamp('2026-12-31T00:00:00.000Z')).toBe('Dec 31 00:00');
  });

  it.each([
    ['not a timestamp at all', 'yesterday'],
    ['a month out of range', '2026-13-01T00:00:00.000Z'],
    ['a month of zero', '2026-00-01T00:00:00.000Z'],
    ['a date with no time', '2026-07-19'],
    ['null', null],
    ['undefined', undefined],
  ])('%s yields null rather than NaN or "Invalid Date"', (_label, isoTimestamp) => {
    expect(formatSessionTimestamp(isoTimestamp)).toBeNull();
  });

  it('the fallback carries BOTH halves', () => {
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6-7890', '2026-07-19T23:25:51.371Z')).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  // Assertion 10, at the unit level: two sessions created one MILLISECOND apart
  // (the real `101609cc` / `6e8b0f55` pair from the live log).
  it('distinguishes two sessions created a millisecond apart', () => {
    const first = formatSessionFallbackLabel('101609cc-06b4-4db4', '2026-07-21T21:36:46.099Z');
    const second = formatSessionFallbackLabel('6e8b0f55-dc21-4aa3', '2026-07-21T21:36:46.100Z');
    expect(first).not.toBe(second);
    expect(first).toBe('Jul 21 21:36 · 101609cc');
    expect(second).toBe('Jul 21 21:36 · 6e8b0f55');
  });

  it('degrades to the short id with no timestamp — never a fabricated time', () => {
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6', null)).toBe('a1b2c3d4');
  });

  it('never renders blank, even with no id at all', () => {
    expect(formatSessionFallbackLabel('', null)).toBe('<unknown-session>');
    expect(formatSessionFallbackLabel('   ', '2026-07-19T23:25:00.000Z')).toBe(
      'Jul 19 23:25 · <unknown-session>',
    );
  });

  it('contains no control bytes', () => {
    const label = formatSessionFallbackLabel('a1b2c3d4', '2026-07-19T23:25:00.000Z');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(label)).toBe(false);
  });

  // Assertion 11.
  it('is identical under every ambient TZ and locale', () => {
    const originalTimeZone = process.env.TZ;
    const originalLanguage = process.env.LANG;
    try {
      const labels = [
        ['UTC', 'en_US.UTF-8'],
        ['Pacific/Kiritimati', 'de_DE.UTF-8'],
        ['America/Los_Angeles', 'ja_JP.UTF-8'],
        ['Asia/Kolkata', 'C'],
      ].map(([timeZone, language]) => {
        process.env.TZ = timeZone!;
        process.env.LANG = language!;
        return formatSessionFallbackLabel('a1b2c3d4-e5f6', '2026-07-19T23:25:51.371Z');
      });
      expect(new Set(labels).size).toBe(1);
      expect(labels[0]).toBe('Jul 19 23:25 · a1b2c3d4');
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
      if (originalLanguage === undefined) {
        delete process.env.LANG;
      } else {
        process.env.LANG = originalLanguage;
      }
    }
  });
});

describe('resolveSessionLabel: the ladder, and the rung that is NOT in it', () => {
  // Assertion 8.
  it('name beats derivedTitle beats the fallback', () => {
    const inputs = {
      sessionId: 'a1b2c3d4-e5f6',
      earliestActivityAt: '2026-07-19T23:25:00.000Z',
    };
    expect(resolveSessionLabel({ ...inputs, name: 'the ledger rewrite', derivedTitle: 'auto' })).toBe(
      'the ledger rewrite',
    );
    expect(resolveSessionLabel({ ...inputs, name: null, derivedTitle: 'auto' })).toBe('auto');
    expect(resolveSessionLabel({ ...inputs, name: null, derivedTitle: null })).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  it('a blank at any rung falls through rather than rendering empty', () => {
    expect(
      resolveSessionLabel({
        sessionId: 'a1b2c3d4-e5f6',
        name: '   ',
        derivedTitle: '\t\n',
        earliestActivityAt: '2026-07-19T23:25:00.000Z',
      }),
    ).toBe('Jul 19 23:25 · a1b2c3d4');
  });

  it('trims a padded name rather than rendering the padding', () => {
    expect(resolveSessionLabel({ sessionId: 'x', name: '  named  ' })).toBe('named');
  });

  // ⚠ THE REGRESSION PIN at the ladder itself (assertion 9). `resolveSessionLabel`
  // takes NO cwd — the type has no place to put one. Reintroducing the rung would
  // require widening this signature, which is exactly the friction intended.
  it('takes no cwd at all: the ladder cannot read one even if someone passes it', () => {
    const label = resolveSessionLabel({
      sessionId: 'a1b2c3d4-e5f6',
      name: null,
      derivedTitle: null,
      earliestActivityAt: '2026-07-19T23:25:00.000Z',
      // A caller trying to sneak the deleted rung back in through the object.
      ...({ cwd: '/home/ticktockbent/projects/content/death' } as Record<string, unknown>),
    });
    expect(label).not.toBe('death');
    expect(label).toBe('Jul 19 23:25 · a1b2c3d4');
  });
});
