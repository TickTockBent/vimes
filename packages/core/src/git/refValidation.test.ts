import { describe, expect, it } from 'vitest';
import { MAX_REF_NAME_LENGTH, validateRefName } from './refValidation.js';

// ─── slice 17, unit 1, assertion A5 — the ref-name grammar is hostile-proof ───
//
// This is the API-boundary half of §3.9 only (never runs git — see the
// module's own docblock). Every case below is either a real exploit against a
// git ref/path if it were allowed through unescaped, or a happy-path shape
// this module MUST accept because U2's helpers and real branch names produce
// it.

describe('validateRefName — accepts the signed grammar', () => {
  const ACCEPTED: ReadonlyArray<string> = [
    'main',
    'feature/x-1',
    'vimes/node-abc-1a2b3c4d',
    'v1.2.3',
  ];

  for (const candidate of ACCEPTED) {
    it(`accepts '${candidate}'`, () => {
      expect(validateRefName(candidate)).toEqual({ ok: true });
    });
  }

  it('accepts a name exactly at the length cap', () => {
    const atCap = 'a'.repeat(MAX_REF_NAME_LENGTH);
    expect(atCap.length).toBe(MAX_REF_NAME_LENGTH);
    expect(validateRefName(atCap)).toEqual({ ok: true });
  });
});

describe('validateRefName — refuses the hostile menagerie, and never throws', () => {
  // Each entry names the closed-vocabulary reason it must earn. Control bytes,
  // unicode outside the grammar and whitespace are all coarse `outside-grammar`
  // refusals BY DESIGN (see the module docblock: the grammar is the coarse
  // gate; only an in-grammar candidate is fine-grained enough to fail for a
  // more specific structural reason).
  const HOSTILE: ReadonlyArray<{ name: string; candidate: string; reason: string }> = [
    { name: 'empty string', candidate: '', reason: 'empty' },
    // Written as escapes, never as literal bytes — a real NUL/ESC in a source
    // file is invisible in a diff and would make this test lie about itself.
    { name: 'NUL byte', candidate: 'a\u0000b', reason: 'outside-grammar' },
    { name: 'ESC byte', candidate: 'a\u001bb', reason: 'outside-grammar' },
    { name: 'newline', candidate: 'a\nb', reason: 'outside-grammar' },
    { name: 'option-shaped short flag', candidate: '-rf', reason: 'leading-dash' },
    { name: 'option-shaped long flag', candidate: '--force', reason: 'leading-dash' },
    { name: 'traversal, rooted', candidate: '../../etc', reason: 'dot-dot' },
    { name: 'traversal, mid-path', candidate: 'a/../b', reason: 'dot-dot' },
    { name: 'bare dot-dot', candidate: '..', reason: 'dot-dot' },
    { name: 'emoji (astral, outside grammar)', candidate: 'a\u{1f642}b', reason: 'outside-grammar' },
    {
      name: 'confusable slash U+2044 (FRACTION SLASH)',
      candidate: 'a\u2044b',
      reason: 'outside-grammar',
    },
    {
      name: 'confusable slash U+FF0F (FULLWIDTH SOLIDUS)',
      candidate: 'a\uff0fb',
      reason: 'outside-grammar',
    },
    { name: 'RTL override', candidate: 'a\u202eb', reason: 'outside-grammar' },
    { name: 'whitespace', candidate: 'a b', reason: 'outside-grammar' },
    { name: 'reflog-shaped @{', candidate: 'a@{b', reason: 'outside-grammar' },
    { name: 'backslash', candidate: 'a\\b', reason: 'outside-grammar' },
    { name: 'trailing slash', candidate: 'refs/heads/', reason: 'trailing-slash' },
    { name: 'trailing .lock suffix', candidate: 'branch.lock', reason: 'lock-suffix' },
    {
      name: 'one over the length cap',
      candidate: 'a'.repeat(MAX_REF_NAME_LENGTH + 1),
      reason: 'too-long',
    },
  ];

  for (const { name, candidate, reason } of HOSTILE) {
    it(`${name}: refuses as '${reason}', and does not throw`, () => {
      let result: ReturnType<typeof validateRefName> | undefined;
      expect(() => {
        result = validateRefName(candidate);
      }, `${name} must not throw — this function is TOTAL`).not.toThrow();
      expect(result).toEqual({ ok: false, reason });
    });
  }
});
