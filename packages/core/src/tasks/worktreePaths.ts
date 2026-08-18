// ─── slice 6 step 8 → slice 17 U3 — where a CHECKOUT lives (PURE) ────────────
//
// Two names have to come out of an id before any git command can be built: the
// BRANCH the checkout uses and the DIRECTORY NAME it lives under. Both are
// derived here, and here only.
//
// Everything in this module is PURE and TOTAL (rule 0.3): no clock, no I/O, no
// randomness, and NOTHING THROWS. It is in `packages/core` rather than beside the
// coordinator on purpose — a name that decides where a worker's files go is a fact
// the board, a future GC and any replay must be able to re-derive without a daemon.
//
// ⚠ **THE ID IS TREATED AS UNTRUSTED INPUT.** Today every nodeId is minted by the
// engine from an injected uuid source, so the hostile cases in the tests are not
// reachable from the current code. That is exactly why the sanitiser is written
// while it is free: the output of this module becomes A FILESYSTEM PATH and A GIT
// REF, and the propose routes are a caller with an outside surface. A traversal
// (`../../etc`), a separator (`a/b`) or a leading dash (`-rf`, which git would
// read as an OPTION rather than an operand) must be impossible by construction
// here, not by a check somewhere downstream.
//
// ⚠ **THE TASK-DERIVED PAIR THAT STOOD HERE IS GONE (S17·U3, slice-17.md §3.11).**
// `TASK_WORKTREE_BRANCH_PREFIX` / `TASK_WORKTREE_DIR_PREFIX` /
// `taskWorktreeBranch` / `taskWorktreeDirName` derived a `vimes/task-<taskId>`
// branch and a `task-<taskId>` directory, and their determinism WAS the old
// idempotence: a re-dispatched task landed back in the directory it already had.
// §3.6 replaced the tenant word (`task` appears in neither name any more) and
// §3.10 replaced the re-use (the engine never silently opens an existing
// checkout). U1 added the node pair BESIDE the task pair so no intermediate
// deploy could derive `vimes/node-*` from a task id; U3 switched the dispatcher
// and deleted the task pair in the same unit. The escaper, the fingerprint and
// the length cap below survived that swap VERBATIM — they were always about the
// id being untrusted, never about what kind of id it was.

// The conservative charset a derived name may contain VERBATIM. Everything else is
// escaped (below). Chosen to be simultaneously safe as a path component on every
// filesystem we care about and legal inside a git ref: no dot (so `..` and a
// `.lock` suffix are unreachable), no slash, no whitespace, no shell
// metacharacter, no `~^:?*[\` (git's own ref-name refusals), no control byte.
const SAFE_CHARACTER_PATTERN = /^[A-Za-z0-9-]$/;

// How long the escaped slug may get before it is truncated and fingerprinted.
// A path component has a hard OS limit (255 bytes on ext4) and a worktree path is
// that component plus a root plus everything git creates underneath it, so an
// unbounded id would produce ENAMETOOLONG at `git worktree add` time — a failure
// that would surface as an unexplained worktree-failed rather than as the "your id
// is absurd" it actually is. 64 is generously above any id we mint (a uuid escapes
// to 36 characters) and comfortably below the limit.
const MAX_SLUG_LENGTH = 64;

// FNV-1a, 32-bit, over UTF-16 code units. A pure, dependency-free, deterministic
// fingerprint — NOT a security primitive and never used as one. Its only job is to
// keep two ids that share a 64-character prefix from collapsing onto one worktree
// after truncation. `>>> 0` keeps every step an unsigned 32-bit value.
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
function fingerprint(rawValue: string): string {
  let hashValue = FNV_OFFSET_BASIS_32;
  for (let characterIndex = 0; characterIndex < rawValue.length; characterIndex += 1) {
    hashValue ^= rawValue.charCodeAt(characterIndex);
    hashValue = Math.imul(hashValue, FNV_PRIME_32) >>> 0;
  }
  return hashValue.toString(16).padStart(8, '0');
}

/**
 * Escape an id into the safe charset, INJECTIVELY.
 *
 * ⚠ The injectivity is the point, and it is why this STRIPS NOTHING. A sanitiser
 * that deleted unsafe characters would map `a/b` and `ab` onto the same directory,
 * i.e. two different checkouts would silently share one worktree and edit each
 * other's files — the precise hazard this whole step exists to remove,
 * reintroduced by the function that was supposed to prevent it. So every unsafe
 * character is ESCAPED rather than dropped: `_` followed by the 4-hex-digit UTF-16
 * code unit. `_` is itself outside the safe charset, so it is escaped too and the
 * encoding stays unambiguous.
 *
 * Total: a lone surrogate, a NUL, a control byte and an empty string all encode.
 */
function escapeToSafeCharset(rawId: string): string {
  let escaped = '';
  for (const character of Array.from(rawId)) {
    // Array.from iterates by CODE POINT, so an astral character arrives whole; it
    // is then escaped as its individual code units, which round-trips fine because
    // we only ever need the mapping to be one-way and injective.
    if (character.length === 1 && SAFE_CHARACTER_PATTERN.test(character)) {
      escaped += character;
      continue;
    }
    for (let unitIndex = 0; unitIndex < character.length; unitIndex += 1) {
      escaped += `_${character.charCodeAt(unitIndex).toString(16).padStart(4, '0')}`;
    }
  }
  return escaped;
}

// ─── slice 17, unit 1 — node-derived checkout names (§3.6, §3.11) ────────────
//
// Every engine-created checkout is a NODE (E2-a — one node kind, worktree-ness
// carried as a `provenance` property), so its branch and directory derive from
// the NODE's id. The derivation pipeline above — `escapeToSafeCharset` + the
// FNV-1a `fingerprint` + the length-capped slug — is the one the retired
// task-derived pair used, reused VERBATIM (§0's recon: it survives the move
// unchanged); only the prefix and the input id ever differed.
//
// ⚠ **DERIVED FROM `nodeId` ALONE.** Identical nodeId ⇒ identical branch and
// directory name, every time (§3.7's derivation property). Note what that does
// NOT buy any more: because every `create` mints a FRESH nodeId, determinism here
// is a replay property, not an idempotence one — nothing re-enters an existing
// checkout by re-deriving its name (§3.10, pin 1).

// The branch every node-derived checkout checks out. Namespaced under `vimes/` so
// a human's `git branch` output separates VIMES's bookkeeping from their own work
// at a glance, and so a future cleanup can enumerate ours without guessing;
// `node-` is the stem (§3.6: the tenant word `task` appears in neither name).
export const NODE_CHECKOUT_BRANCH_PREFIX = 'vimes/node-';

// The directory-name prefix. The SAME `node-` stem as the branch, so a worktree
// on disk and a branch in the repo are recognisably the same object.
export const NODE_CHECKOUT_DIR_PREFIX = 'node-';

// The escaped-and-length-bounded stem shared by the node branch and directory
// name. Over-long ids keep a readable 64-character head and gain a fingerprint of
// the WHOLE id, so truncation cannot merge two distinct checkouts.
function nodeCheckoutSlug(nodeId: string): string {
  const escaped = escapeToSafeCharset(nodeId);
  if (escaped.length <= MAX_SLUG_LENGTH) {
    return escaped;
  }
  return `${escaped.slice(0, MAX_SLUG_LENGTH)}-${fingerprint(nodeId)}`;
}

/**
 * The git branch this node's checkout uses — e.g.
 * `vimes/node-node-aaaa-0001`.
 *
 * Pure, total, deterministic. The `vimes/node-` prefix also guarantees the ref
 * can never begin with `-` no matter what the id was, so it can never be read
 * as a git option even if a future caller forgets the `--` guard.
 */
export function nodeCheckoutBranch(nodeId: string): string {
  return `${NODE_CHECKOUT_BRANCH_PREFIX}${nodeCheckoutSlug(nodeId)}`;
}

/**
 * The directory NAME (never a full path) for this node's checkout — e.g.
 * `node-node-aaaa-0001`. The coordinator joins it onto the configured worktree
 * root (U2); this module deliberately knows nothing about that root, so it
 * stays free of any filesystem or configuration dependency.
 *
 * Pure, total, deterministic, and never `.`, `..`, empty-after-prefix-stripping,
 * or dash-leading.
 */
export function nodeCheckoutDirName(nodeId: string): string {
  return `${NODE_CHECKOUT_DIR_PREFIX}${nodeCheckoutSlug(nodeId)}`;
}
