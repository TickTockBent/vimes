import { isAbsolute, resolve, dirname, basename, sep } from 'node:path';
import { realpathSync } from 'node:fs';

// ─── Path-safety core (spec §3.11 — the arbitrary-file-API threat wall) ───────
//
// EVERY file operation in the File API and Search resolves its request-derived
// path THROUGH resolveWithinRoots BEFORE any fs touch. A path that does not land
// strictly within an allowed root is refused (403 at the REST boundary). This is
// load-bearing security, not a convenience: an authenticated caller with a
// traversal or symlink-escape path must never read or write outside the roots.
//
// The allowlist is `config.projectRoots ∪ live-session cwds` — the CALLER passes
// it in (composition owns the union); this module never reaches into the host.
//
// Pure except the realpath probe, which is injected (a deterministic fake in unit
// tests, the real fs in the integration + hostile tests). realpath is what
// catches a symlink escaping a root: we resolve the longest existing ancestor of
// the requested path through the real filesystem, so a symlink anywhere in the
// existing prefix is followed to its true target BEFORE the containment check.

export interface ResolveOk {
  ok: true;
  absolute: string;
}
export interface ResolveFail {
  ok: false;
  reason: string;
}
export type ResolveResult = ResolveOk | ResolveFail;

// Injected realpath probe. Returns the canonical absolute path (symlinks
// resolved) or THROWS when the path does not exist (mirrors fs.realpathSync's
// ENOENT). Sync by contract — the File API handlers resolve synchronously before
// any read/write.
export type RealpathProbe = (path: string) => string;

// The real-fs probe (determinism-exempt: fs boundary, rule 0.3). Production and
// the integration/hostile tests use this; pure unit tests inject a fake.
export const realpathProbe: RealpathProbe = (path) => realpathSync(path);

// Resolve the longest existing ancestor of `absolutePath` through the realpath
// probe, then re-append the trailing segments that do not exist yet. A new file
// (whole leaf absent) still gets its EXISTING parent chain canonicalized, so a
// symlinked parent directory cannot be used to escape a root on write. The
// non-existing tail carries no symlink risk (it is not yet a filesystem entry).
function realpathLongestExistingPrefix(absolutePath: string, realpath: RealpathProbe): string {
  const trailingSegments: string[] = [];
  let currentPath = absolutePath;
  for (;;) {
    try {
      const canonicalPrefix = realpath(currentPath);
      // Re-attach the non-existing tail (outermost segment was pushed last).
      return trailingSegments.reduceRight((accumulated, segment) => resolve(accumulated, segment), canonicalPrefix);
    } catch {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        // Reached the filesystem root without any existing ancestor — return the
        // lexically-resolved path (nothing to canonicalize). Practically
        // unreachable, since the fs root always exists.
        return absolutePath;
      }
      trailingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

// True when `candidateAbsolute` is the root itself or sits strictly beneath it.
// The `root + sep` guard makes the boundary EXACT: `/root-evil` must NOT match
// the root `/root` (a bare startsWith(root) would wrongly accept it).
function isWithinRoot(candidateAbsolute: string, rootAbsolute: string): boolean {
  return candidateAbsolute === rootAbsolute || candidateAbsolute.startsWith(rootAbsolute + sep);
}

// Canonicalize an allowed root through realpath so the containment comparison is
// symlink-consistent on BOTH sides (a root that is itself a symlink still matches
// paths that realpath into its true target). A root that does not exist is
// dropped from the comparison rather than throwing.
function canonicalizeRoot(root: string, realpath: RealpathProbe): string | null {
  const resolvedRoot = resolve(root);
  try {
    return realpath(resolvedRoot);
  } catch {
    return null;
  }
}

// The one gate every request-derived path passes through. Returns the canonical
// absolute path when it is provably within an allowed root; otherwise a refusal
// with a classified reason (never a path echo — callers map every failure to a
// 403 with zero product bytes).
//
// - null byte anywhere → refuse (a NUL truncates C-string fs calls).
// - empty allowlist → refuse ALL (matches the spawn path-traversal discipline).
// - absolute input → resolved lexically (collapses `..`), then realpath-checked.
// - relative input → resolved against EACH allowed root; the first root that
//   contains the result wins (a relative path is interpreted relative to the
//   root it belongs to). Traversal that climbs out (`../../etc/passwd`) lands
//   outside every root and is refused.
export function resolveWithinRoots(
  requestedPath: string,
  allowedRoots: readonly string[],
  realpath: RealpathProbe = realpathProbe,
): ResolveResult {
  if (requestedPath.includes('\0')) {
    return { ok: false, reason: 'null-byte' };
  }
  if (allowedRoots.length === 0) {
    return { ok: false, reason: 'no-roots' };
  }

  const canonicalRoots: Array<{ resolved: string; canonical: string }> = [];
  for (const root of allowedRoots) {
    const canonical = canonicalizeRoot(root, realpath);
    if (canonical !== null) {
      canonicalRoots.push({ resolved: resolve(root), canonical });
    }
  }
  if (canonicalRoots.length === 0) {
    return { ok: false, reason: 'no-roots' };
  }

  // Build the set of candidate absolute paths. Absolute input → one candidate.
  // Relative input → one candidate per (lexically-resolved) root.
  const candidates: string[] = isAbsolute(requestedPath)
    ? [resolve(requestedPath)]
    : canonicalRoots.map((root) => resolve(root.resolved, requestedPath));

  for (const candidate of candidates) {
    const canonicalCandidate = realpathLongestExistingPrefix(candidate, realpath);
    for (const root of canonicalRoots) {
      if (isWithinRoot(canonicalCandidate, root.canonical)) {
        return { ok: true, absolute: canonicalCandidate };
      }
    }
  }

  return { ok: false, reason: 'outside-roots' };
}
