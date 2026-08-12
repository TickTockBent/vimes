import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveShortSessionId,
  shortSessionIds,
  SHORT_SESSION_ID_BASE_LENGTH,
} from './sessionShortIds.js';
import { formatSessionFallbackLabel, FALLBACK_LABEL_ID_LENGTH } from './sessionIdentity.js';

// ─── S14-A6 / S14-A12 — D79 short ids ────────────────────────────────────────
//
// The pin under test is F4's, in Wes's words: **"stable" means NEVER RE-POINTS,
// not never lengthens.** So the collision fixture below is the centre of this
// file: two ids that share the base prefix both extend, and the four-character
// form somebody memorised BEFORE the collision keeps resolving for as long as it
// names one session — and refuses loudly, with candidates, the moment it names
// two. What it never does is quietly name the other one.

// A deliberately hostile little corpus. `ALPHA` and `ALPHA_TWIN` share the first
// SIX characters, two more than the base width, so a single extension is not
// enough and the group has to keep going.
const ALPHA = 'abcd12-3456-7890';
const ALPHA_TWIN = 'abcd12-9999-0000';
const BRAVO = 'abce-0000-0000';
const CHARLIE = 'zzzz-1111-2222';

describe('shortSessionIds: rendering, and what a collision does to it', () => {
  it('renders the base width when nothing collides', () => {
    const rendered = shortSessionIds([BRAVO, CHARLIE]);
    expect(rendered.get(BRAVO)).toBe('abce');
    expect(rendered.get(CHARLIE)).toBe('zzzz');
    for (const short of rendered.values()) {
      expect(short).toHaveLength(SHORT_SESSION_ID_BASE_LENGTH);
    }
  });

  it('extends EVERY member of a colliding group, together, until the group is distinct', () => {
    const rendered = shortSessionIds([ALPHA, ALPHA_TWIN, BRAVO, CHARLIE]);
    // The colliding pair shares 'abcd12-' and diverges at index 7, so both need
    // eight characters — and BOTH get them, not just the second one to arrive.
    expect(rendered.get(ALPHA)).toBe('abcd12-3');
    expect(rendered.get(ALPHA_TWIN)).toBe('abcd12-9');
    // A group that did not collide is untouched by its neighbour's problem.
    expect(rendered.get(BRAVO)).toBe('abce');
    expect(rendered.get(CHARLIE)).toBe('zzzz');
  });

  it('renders a handle for every id, all distinct, and each a real prefix of its id', () => {
    const estate = [ALPHA, ALPHA_TWIN, BRAVO, CHARLIE];
    const rendered = shortSessionIds(estate);
    expect(rendered.size).toBe(estate.length);
    expect(new Set(rendered.values()).size).toBe(estate.length);
    for (const [fullId, shortId] of rendered) {
      expect(fullId.startsWith(shortId)).toBe(true);
    }
  });

  it('is a pure function of the id SET: order in, same handles out', () => {
    const forwards = shortSessionIds([ALPHA, ALPHA_TWIN, BRAVO, CHARLIE]);
    const backwards = shortSessionIds([CHARLIE, BRAVO, ALPHA_TWIN, ALPHA]);
    for (const id of [ALPHA, ALPHA_TWIN, BRAVO, CHARLIE]) {
      expect(backwards.get(id)).toBe(forwards.get(id));
    }
  });

  it('collapses duplicates rather than fabricating a collision out of one session', () => {
    const rendered = shortSessionIds([ALPHA, ALPHA, ALPHA]);
    expect(rendered.size).toBe(1);
    // One session cannot collide with itself, so it keeps the base width.
    expect(rendered.get(ALPHA)).toBe('abcd');
  });

  it('is total on the edges: an empty estate, and an id shorter than the base width', () => {
    expect(shortSessionIds([]).size).toBe(0);
    expect(shortSessionIds(['ab']).get('ab')).toBe('ab');
  });

  it('separates the awkward pair where one id is a strict PREFIX of another', () => {
    // Unreachable for the uniform-width ids the engine mints; handled rather
    // than assumed away. The handles are distinct, and the shorter one being a
    // prefix of the longer one is survivable because the resolver's exact-match
    // rule covers it (asserted below).
    const rendered = shortSessionIds(['abcd', 'abcdef']);
    expect(rendered.get('abcd')).toBe('abcd');
    expect(rendered.get('abcdef')).toBe('abcde');
    expect(resolveShortSessionId(['abcd', 'abcdef'], 'abcd')).toEqual({
      outcome: 'resolved',
      appSessionId: 'abcd',
    });
    expect(resolveShortSessionId(['abcd', 'abcdef'], 'abcde')).toEqual({
      outcome: 'resolved',
      appSessionId: 'abcdef',
    });
  });
});

describe('resolveShortSessionId: any unambiguous prefix, at any length (S14-A12)', () => {
  const ESTATE = [ALPHA, ALPHA_TWIN, BRAVO, CHARLIE];

  it('resolves the rendered handle', () => {
    expect(resolveShortSessionId(ESTATE, 'abcd12-3')).toEqual({
      outcome: 'resolved',
      appSessionId: ALPHA,
    });
    expect(resolveShortSessionId(ESTATE, 'zzzz')).toEqual({
      outcome: 'resolved',
      appSessionId: CHARLIE,
    });
  });

  // ⚠ THE STABILITY PIN, ASSERTED. Before ALPHA_TWIN existed, ALPHA rendered as
  // 'abcd'. That form is now AMBIGUOUS rather than pointing somewhere new —
  // which is the whole promise: a resolved id never re-points, it only ever
  // starts asking for more characters.
  it('an id that was rendered SHORTER before the collision now refuses — with candidates', () => {
    const beforeTheTwinArrived = shortSessionIds([ALPHA, BRAVO, CHARLIE]);
    expect(beforeTheTwinArrived.get(ALPHA)).toBe('abcd');
    expect(resolveShortSessionId([ALPHA, BRAVO, CHARLIE], 'abcd')).toEqual({
      outcome: 'resolved',
      appSessionId: ALPHA,
    });
    const afterwards = resolveShortSessionId(ESTATE, 'abcd');
    expect(afterwards.outcome).toBe('ambiguous');
    expect(afterwards).toEqual({ outcome: 'ambiguous', candidates: [ALPHA, ALPHA_TWIN] });
    // …and it never silently became the other one.
    expect(afterwards).not.toEqual({ outcome: 'resolved', appSessionId: ALPHA_TWIN });
  });

  it('accepts a prefix LONGER than anything rendered, and a stale-but-still-unique shorter one', () => {
    // Longer than the eight characters the collision made it render.
    expect(resolveShortSessionId(ESTATE, 'abcd12-3456')).toEqual({
      outcome: 'resolved',
      appSessionId: ALPHA,
    });
    // Shorter than BRAVO's rendered handle would need to be if it ever collided,
    // and unique today, so it resolves today.
    expect(resolveShortSessionId(ESTATE, 'abce-')).toEqual({
      outcome: 'resolved',
      appSessionId: BRAVO,
    });
  });

  it('resolves a full id even when it is also a prefix of a longer one', () => {
    expect(resolveShortSessionId(['abcd', 'abcdef'], 'abcd')).toEqual({
      outcome: 'resolved',
      appSessionId: 'abcd',
    });
  });

  it('refuses what it does not recognize, and refuses the empty string', () => {
    expect(resolveShortSessionId(ESTATE, 'nope')).toEqual({ outcome: 'unknown' });
    expect(resolveShortSessionId(ESTATE, '')).toEqual({ outcome: 'unknown' });
    expect(resolveShortSessionId([], 'abcd')).toEqual({ outcome: 'unknown' });
  });

  it('names every candidate it was torn between, deterministically', () => {
    const forwards = resolveShortSessionId([ALPHA, ALPHA_TWIN], 'abcd');
    const repeated = resolveShortSessionId([ALPHA, ALPHA_TWIN], 'abcd');
    expect(forwards).toEqual(repeated);
    expect(forwards).toEqual({ outcome: 'ambiguous', candidates: [ALPHA, ALPHA_TWIN] });
  });

  // The round trip, over a corpus large enough that collisions are certain:
  // every rendered handle resolves back to the session it was rendered for.
  it('every rendered handle round-trips, across a corpus built to collide', () => {
    const corpus: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      // Deliberately narrow leading alphabet: 16 distinct base prefixes for 200
      // ids, so almost every one of them has to extend.
      corpus.push(`ab${(index % 4).toString()}${(index % 4).toString()}-${String(index).padStart(4, '0')}`);
    }
    const rendered = shortSessionIds(corpus);
    expect(rendered.size).toBe(corpus.length);
    for (const [fullId, shortId] of rendered) {
      expect(resolveShortSessionId(corpus, shortId)).toEqual({
        outcome: 'resolved',
        appSessionId: fullId,
      });
    }
  });
});

// ─── S14-A6, the CORE half — and the THIRD EXEMPTION (S14-F1, signed) ────────
//
// §3c narrows recon's "five call sites": `founding.ts` shortens TASK ids (out of
// D79's scope, untouched), the UI pair migrates when it consumes the tree wire
// shape, and the daemon straggler is U3's.
//
// The third exemption, signed 2026-08-12 after U2 tried the migration and broke
// the rung: `sessionIdentity.ts`'s fallback slice is a DISPLAY DISTINGUISHER
// handed one session and no estate. It cannot collision-extend, so it is not a
// D79 handle and keeps its own width under its own name. What A6 actually
// forbids is a SECOND SPELLING OF THE HANDLE — not a second constant with a
// different job — and the dead name is the tell.

const SESSION_IDENTITY_SOURCE_PATH = fileURLToPath(new URL('./sessionIdentity.ts', import.meta.url));

describe('S14-A6 (core half): the handle has one spelling, the label is not the handle', () => {
  it('the old five-spellings name stays dead in sessionIdentity.ts', () => {
    const source = readFileSync(SESSION_IDENTITY_SOURCE_PATH, 'utf8');
    // Gone — not renamed back, not shadowed. The width that lives there now
    // answers a different question and says so in its name.
    expect(source).not.toMatch(/const SHORT_SESSION_ID_LENGTH/);
    expect(source).toContain('export const FALLBACK_LABEL_ID_LENGTH = 8');
    expect(source).toContain('sessionId.slice(0, FALLBACK_LABEL_ID_LENGTH)');
  });

  it('the label rung does NOT read the D79 handle width — the two are independent', () => {
    const source = readFileSync(SESSION_IDENTITY_SOURCE_PATH, 'utf8');
    // No import of this module at all: a display label must not move because a
    // collision somewhere else made the addressable handle wider or narrower.
    expect(source).not.toContain("from './sessionShortIds.js'");
    expect(FALLBACK_LABEL_ID_LENGTH).not.toBe(SHORT_SESSION_ID_BASE_LENGTH);
  });

  it('the fallback label distinguishes ids that share the D79 base prefix', () => {
    // The exact pair from the finding: at width 4 both render `sess` and the
    // rung stops doing its only job.
    const first = formatSessionFallbackLabel('sess-unnamed', null);
    const second = formatSessionFallbackLabel('sess-blank', null);
    expect(first).not.toBe(second);
    expect(first).toBe('sess-unn');
    expect(second).toBe('sess-bla');
    expect(first).toHaveLength(FALLBACK_LABEL_ID_LENGTH);
  });
});
