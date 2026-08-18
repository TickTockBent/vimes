// ─── slice 17, unit 1 — the ref-name grammar (§3.9's API-boundary half) ──────
//
// This is the engine's git vocabulary's first CORE-side tenant (a new `git/`
// directory). The adapter's other half — running a candidate through git's own
// `check-ref-format` semantics — is U2's, deliberately not here: this module
// never shells out, never reads a repository, and never asks git anything. It
// is the CONSERVATIVE, EXPLICIT grammar §3.9 signed, checked BEFORE a candidate
// is ever allowed near a subprocess.
//
// Rule 0.3: pure and total. `validateRefName` NEVER THROWS — every input,
// including control bytes, unpaired surrogates and the empty string, maps to a
// value, never an exception. A validator that could itself blow up on hostile
// input would defeat the point of writing one.

// The closed vocabulary of refusal reasons. Kebab-case, chosen to read as
// FACTS about the candidate rather than as error codes — the API layer (U4)
// maps these onto HTTP refusal statuses (slice-17.md §3.5); nothing outside
// this module should ever need to invent a new one.
export type RefNameRefusalReason =
  | 'empty'
  | 'outside-grammar'
  | 'leading-dash'
  | 'dot-dot'
  | 'trailing-slash'
  | 'lock-suffix'
  | 'too-long';

export type RefNameValidationResult =
  | { ok: true }
  | { ok: false; reason: RefNameRefusalReason };

// The accepted charset, signed verbatim (slice-17.md §3.9): letters, digits,
// dot, underscore, slash, dash. Anything outside it — a control byte, a
// confusable unicode slash (U+2044, U+FF0F), an RTL override, an emoji, plain
// whitespace — refuses as `outside-grammar` rather than earning its own
// reason, because the grammar is the coarse gate: only a candidate that is
// ALREADY inside it is fine-grained enough to fail for a more specific,
// structural reason below.
const REF_GRAMMAR_PATTERN = /^[A-Za-z0-9._/-]+$/;

// The length cap, PINNED here (not left to whatever git or the filesystem
// would tolerate) with a stated rationale: our own longest derived name today
// (a `vimes/node-<64-char-slug>-<8-hex-fingerprint>` branch, worktreePaths.ts)
// lands well under 100 characters, so 200 is generously above anything we
// mint while staying comfortably under filesystem path-component limits
// (255 bytes on ext4) once a project root and worktree root are joined on.
// An unbounded cap would let an absurd candidate travel all the way to
// `git worktree add` before failing, surfacing as an unexplained git error
// instead of the "your ref name is absurd" refusal it actually is — the same
// reasoning `MAX_SLUG_LENGTH` in worktreePaths.ts already applies one layer
// down. Lean: 200. (⟨Wes⟩: revise if a real candidate needs more room.)
export const MAX_REF_NAME_LENGTH = 200;

/**
 * Validate a candidate git ref name against the SIGNED conservative grammar
 * (slice-17.md §3.9). Pure, total, never throws — every string maps to a
 * result.
 *
 * This is the API-boundary half only: it never runs git. A candidate that
 * passes here still goes through the adapter's `check-ref-format` check
 * (U2) before it is trusted as a real git ref — this module's job is to
 * refuse the obviously-hostile cases (traversal, option-shaped, control
 * bytes, out-of-grammar unicode) BEFORE a candidate is ever built into a
 * command line.
 */
export function validateRefName(candidate: string): RefNameValidationResult {
  if (candidate.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (candidate.length > MAX_REF_NAME_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (!REF_GRAMMAR_PATTERN.test(candidate)) {
    return { ok: false, reason: 'outside-grammar' };
  }
  if (candidate.startsWith('-')) {
    return { ok: false, reason: 'leading-dash' };
  }
  if (candidate.includes('..')) {
    return { ok: false, reason: 'dot-dot' };
  }
  if (candidate.endsWith('/')) {
    return { ok: false, reason: 'trailing-slash' };
  }
  if (candidate.endsWith('.lock')) {
    return { ok: false, reason: 'lock-suffix' };
  }
  return { ok: true };
}
