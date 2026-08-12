// ─── S14·U2 — D79 short session ids: RENDERING and RESOLUTION (PURE) ─────────
//
// D79, sharpened by slice-14.md F4 ⟨signed⟩: a session gets a short handle a
// human can type. Before this module the codebase held five scattered
// `slice(0, 8)`s with no collision handling at all — five places that would each
// have to notice, independently, the day two sessions shared a prefix.
//
// **The stability pin, in Wes's words: "stable" means NEVER RE-POINTS, not never
// lengthens.** A short id may need MORE CHARACTERS after a collision; it may
// never come to mean a different session. Everything below follows from that one
// sentence, and the two consequences are why this module exports TWO functions
// rather than one:
//
//   • RENDERING (`shortSessionIds`) answers "what do I print beside this
//     session?" — the shortest prefix that is unambiguous in the scope it is
//     printed in, extended when it collides.
//   • RESOLUTION (`resolveShortSessionId`) answers "what did the operator just
//     type?" — and it accepts ANY unambiguous prefix, not merely the currently
//     rendered length. Collapsing these two into one function is the defect the
//     split exists to prevent: a 4-character id typed from muscle memory must
//     keep working after some OTHER session's arrival lengthened the rendered
//     form, and it does, because the two ids it might have meant are still
//     distinguished by the characters that were typed.
//
// **SCOPE IS THE CALLER'S, AND THE ENGINE'S CALLERS PASS THE WHOLE ESTATE**
// (F4, declared). Not per-project: if the scope were a project, the same four
// characters would name different sessions either side of a project switch, and
// a command grammar built on that is unsafe by construction. Callers that hold
// only a subset (a filtered tree, one node's leaves) must still hand this
// function the whole estate's ids and render the subset from the resulting map.
//
// Rule 0.3: pure. No clock, no randomness, no I/O, no registry, no recycling —
// the map is a function of the id set alone, so two processes holding the same
// estate render the same handles without talking to each other.

// ⚠ **THE ONE PLACE THE WIDTH IS WRITTEN.** Four characters: long enough to be
// unambiguous across an estate of a few hundred UUID-shaped ids (16^4 = 65536
// buckets), short enough to type and to fit a phone row. Collisions are handled
// rather than assumed away — see the extension rule below — so this is a
// STARTING width, not a promise about the rendered length.
export const SHORT_SESSION_ID_BASE_LENGTH = 4;

/**
 * The rendered short id for every id in `ids`, keyed by the full id.
 *
 * The rule, git-style: start at `SHORT_SESSION_ID_BASE_LENGTH`. Ids whose base
 * prefix is unique keep it. **Every member of a colliding group extends
 * together, one character at a time, until every member of that group is
 * distinct** — so siblings that collided render at the same width and a reader
 * can see at a glance that they are the pair that needed the extra characters.
 *
 * (The alternative — a per-id minimal unique length, which is what `git
 * rev-parse --short` computes object by object — was available and was not
 * taken: it renders one member of a three-way collision narrower than the other
 * two, which reads as though only two of them collided. The group is the unit
 * that collided, so the group is the unit that extends.)
 *
 * TOTAL: duplicates in `ids` collapse (one entry, one handle); an empty list
 * yields an empty map; an id shorter than the base width is used whole. Distinct
 * ids ALWAYS render to distinct handles — including the awkward pair where one
 * id is a strict prefix of another (`abcd` / `abcdef` render as `abcd` /
 * `abcde`), where the shorter handle is also a prefix of the longer one. That
 * pair still round-trips through the resolver, because an input that IS an id in
 * full wins outright there; it is unreachable anyway for the uniform-width ids
 * the engine actually mints.
 */
export function shortSessionIds(ids: readonly string[]): ReadonlyMap<string, string> {
  // FIRST-SEEN ORDER, deduplicated. Determinism does not depend on it — the
  // result is keyed by id and the grouping is by prefix — but keeping it makes
  // the iteration order of the returned map a stable function of the input.
  const distinctIds: string[] = [];
  const alreadySeen = new Set<string>();
  for (const candidateId of ids) {
    if (alreadySeen.has(candidateId)) {
      continue;
    }
    alreadySeen.add(candidateId);
    distinctIds.push(candidateId);
  }

  const renderedById = new Map<string, string>();
  for (const collidingGroup of groupByPrefix(distinctIds, SHORT_SESSION_ID_BASE_LENGTH).values()) {
    const groupWidth = widthThatSeparates(collidingGroup);
    for (const memberId of collidingGroup) {
      renderedById.set(memberId, memberId.slice(0, groupWidth));
    }
  }
  return renderedById;
}

// The shortest width at which every member of `group` has a distinct prefix.
// TERMINATION is the longest id in the group: at that width every prefix IS the
// id it came from (a shorter id slices to itself), and the caller already
// deduplicated — so distinct ids are distinct there, and the bound is both a
// guard against an unbounded loop and a correct answer.
function widthThatSeparates(group: readonly string[]): number {
  const longestIdLength = group.reduce((longest, id) => Math.max(longest, id.length), 0);
  for (let width = SHORT_SESSION_ID_BASE_LENGTH; width < longestIdLength; width += 1) {
    if (groupByPrefix(group, width).size === group.length) {
      return width;
    }
  }
  return Math.max(longestIdLength, SHORT_SESSION_ID_BASE_LENGTH);
}

// Ids bucketed by their `width`-character prefix, insertion order preserved.
function groupByPrefix(ids: readonly string[], width: number): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const id of ids) {
    const prefix = id.slice(0, width);
    const bucket = buckets.get(prefix);
    if (bucket === undefined) {
      buckets.set(prefix, [id]);
      continue;
    }
    bucket.push(id);
  }
  return buckets;
}

/**
 * What the operator just typed, as one of three outcomes.
 *
 * `resolved` — exactly one id in scope starts with `input`.
 * `ambiguous` — more than one does, and the candidates come back WITH the
 *   answer: a refusal that does not say what it was torn between makes the
 *   operator guess a second time.
 * `unknown` — none does, or `input` is empty.
 *
 * ⚠ **ANY UNAMBIGUOUS PREFIX RESOLVES, REGARDLESS OF THE RENDERED LENGTH**
 * (F4, S14-A12). That is the resolution half of the stability pin: after a
 * collision lengthens a rendered handle, the SHORTER form the operator memorised
 * still resolves for as long as it names one session, and stops resolving — with
 * candidates, loudly — the moment it names two. What it never does is quietly
 * name a different one.
 *
 * An input that IS an id in full wins outright, even when it is also a prefix of
 * a longer id: the operator typed the whole thing, and reading that as ambiguous
 * would leave a session unaddressable by its own name.
 */
export type ShortSessionIdResolution =
  | { readonly outcome: 'resolved'; readonly appSessionId: string }
  | { readonly outcome: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly outcome: 'unknown' };

export function resolveShortSessionId(
  ids: readonly string[],
  input: string,
): ShortSessionIdResolution {
  // The empty string is a prefix of everything, so accepting it would resolve to
  // the only session in a one-session estate and refuse ambiguously in every
  // other — a rule whose behaviour changes with the size of the estate. It names
  // nothing, and it is read as naming nothing.
  if (input.length === 0) {
    return { outcome: 'unknown' };
  }
  const candidates: string[] = [];
  const alreadyCollected = new Set<string>();
  for (const candidateId of ids) {
    if (candidateId === input) {
      // Exact match short-circuits — see the doc comment above.
      return { outcome: 'resolved', appSessionId: candidateId };
    }
    if (!candidateId.startsWith(input) || alreadyCollected.has(candidateId)) {
      continue;
    }
    alreadyCollected.add(candidateId);
    candidates.push(candidateId);
  }
  if (candidates.length === 0) {
    return { outcome: 'unknown' };
  }
  if (candidates.length === 1) {
    return { outcome: 'resolved', appSessionId: candidates[0]! };
  }
  // FIRST-SEEN ORDER of the caller's list, so the candidate list is a
  // deterministic function of the arguments rather than of a set's iteration.
  return { outcome: 'ambiguous', candidates };
}
