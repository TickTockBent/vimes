import type { Hono, Context } from 'hono';
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';
import {
  GitAdapter,
  type GitRunner,
  type GitStatus,
  type GitFileDiff,
  type GitBranch,
  type GitWorktree,
  type GitOpError,
} from './gitAdapter.js';

// ─── Git API (REST, behind the auth wall on the product port) ─────────────────
//
// Powers the review panel (spec §3.4 — reviewing agent diffs is the primary human
// job). Scoped to `projectRoots ∪ live-session cwds` (the caller supplies the
// union via getAllowedRoots, the SAME union the file API/search/terminal use).
//
// Injection safety is the headline risk — a git service is arbitrary-command-
// adjacent. The defense is layered here and in gitAdapter.ts:
//   1. EVERY request-derived `root` passes through resolveWithinRoots BEFORE any
//      git runs — an out-of-roots root is refused (403) with no git touch.
//   2. The discovered repo toplevel (`git rev-parse --show-toplevel`) is ITSELF
//      resolveWithinRoots-checked — a repo whose .git sits above the allowlisted
//      root has a toplevel outside the roots and is refused. A git op reachable
//      outside the allowlist would be a halting finding; this is the guard.
//   3. Any request-derived `path` passes through resolveWithinRoots too, and is
//      handed to git as an absolute operand after a `--` guard.
//   4. The adapter uses execFile with ARRAY args (never a shell) — nothing is
//      interpolated. See gitAdapter.ts.
//
// Human-initiated through the UI (behind Access auth, I14) → NO permission-gate
// card (gate cards are for agent tool calls, not the operator's own taps).

export interface GitApiDeps {
  // The live allowlist union (config.projectRoots ∪ host.liveSessionCwds()), read
  // fresh per request — mirrors FileApiDeps.
  getAllowedRoots: () => readonly string[];
  // Injected realpath probe (fs boundary). Defaults to the real one.
  realpath?: RealpathProbe;
  // Injected git runner (subprocess boundary). Defaults to the real execFile
  // runner; CI injects a fake returning canned output.
  runner?: GitRunner;
}

// ── the API contract (rule 0.5 — reserved now, the UI consumes it in step 3) ──

export interface GitStatusResponse {
  repoRoot: string;
  status: GitStatus;
}
export interface GitDiffResponse {
  repoRoot: string;
  files: GitFileDiff[];
}
export interface GitBranchesResponse {
  repoRoot: string;
  branches: GitBranch[];
}
export interface GitWorktreesResponse {
  repoRoot: string;
  worktrees: GitWorktree[];
}
export interface GitStageResponse {
  repoRoot: string;
  ok: true;
  path: string;
}
export interface GitCommitResponse {
  repoRoot: string;
  ok: true;
}
// One discovered repository: an ALLOWLIST-VERIFIED absolute path plus a short
// label for the picker (the path relative to the root it was found under, or the
// basename when the repo IS a root).
export interface GitRepoEntry {
  path: string;
  name: string;
}
export interface GitReposResponse {
  repos: GitRepoEntry[];
}
// A clean 4xx/5xx refusal — a classified reason, never a path echo, never a 500.
export interface GitRefusalResponse {
  error: string;
  detail?: string;
}

// Map an adapter op error to an HTTP status. Out-of-roots / non-repo are clean
// 4xx (never a 500); git-unavailable is a 503 (infrastructure, not the caller).
function statusForOpError(error: GitOpError): 400 | 404 | 503 {
  switch (error) {
    case 'git-unavailable':
      return 503;
    case 'not-a-repo':
      return 404;
    case 'git-failed':
      return 400;
    default:
      return 400;
  }
}

// The resolution spine every route runs: validate the requested root against the
// allowlist, discover the repo toplevel, then validate the toplevel too. Returns
// the verified repoRoot to run git in, or a ready-to-send refusal.
interface RepoResolution {
  ok: true;
  repoRoot: string;
}
interface RepoRefusal {
  ok: false;
  httpStatus: 400 | 403 | 404 | 503;
  body: GitRefusalResponse;
}

async function resolveRepoRoot(
  rootParam: string,
  deps: GitApiDeps,
  adapter: GitAdapter,
  realpath: RealpathProbe,
): Promise<RepoResolution | RepoRefusal> {
  if (rootParam === '') {
    return { ok: false, httpStatus: 400, body: { error: 'missing-root' } };
  }
  const allowedRoots = deps.getAllowedRoots();
  // (1) the requested root must land within the allowlist.
  const resolvedRoot = resolveWithinRoots(rootParam, allowedRoots, realpath);
  if (!resolvedRoot.ok) {
    return { ok: false, httpStatus: 403, body: { error: 'root-outside-allowlist' } };
  }
  // (2) discover the enclosing repo's toplevel.
  const toplevelResult = await adapter.repoRootFor(resolvedRoot.absolute);
  if (!toplevelResult.ok) {
    return { ok: false, httpStatus: statusForOpError(toplevelResult.error), body: { error: toplevelResult.error } };
  }
  // (3) the toplevel itself must sit within the allowlist — a repo whose .git is
  // ABOVE an allowlisted root would escape it. This is the halting-finding guard.
  const resolvedToplevel = resolveWithinRoots(toplevelResult.value, allowedRoots, realpath);
  if (!resolvedToplevel.ok) {
    return { ok: false, httpStatus: 403, body: { error: 'repo-outside-allowlist' } };
  }
  return { ok: true, repoRoot: resolvedToplevel.absolute };
}

// Resolve an optional request-derived path against the allowlist. Returns the
// absolute path (handed to git as a `--`-guarded operand), null when absent, or a
// refusal when the path escapes the roots.
function resolvePathParam(
  pathParam: string | undefined,
  deps: GitApiDeps,
  realpath: RealpathProbe,
): { ok: true; absolute: string | undefined } | RepoRefusal {
  if (pathParam === undefined || pathParam === '') {
    return { ok: true, absolute: undefined };
  }
  const resolved = resolveWithinRoots(pathParam, deps.getAllowedRoots(), realpath);
  if (!resolved.ok) {
    return { ok: false, httpStatus: 403, body: { error: 'path-outside-allowlist' } };
  }
  return { ok: true, absolute: resolved.absolute };
}

// ── repo discovery (GET /api/git/repos) ──────────────────────────────────────
//
// The configured project root is typically a CONTAINER of repos (D21:
// VIMES_PROJECT_ROOTS = ~/projects), not a repo itself — so the review panel
// needs the set of repos BENEATH the allowlist, not the allowlist. This walk is
// pure fs (no git subprocess): a directory is a repo when it contains a `.git`
// ENTRY, which may be a directory OR a FILE (worktrees and submodules write a
// `.git` file holding a gitdir: pointer).
//
// Bounds, deliberately conservative — this runs on every panel mount:
//   • depth ≤ MAX_REPO_SCAN_DEPTH levels BELOW each root (roots/a/b/c is found,
//     one level deeper is not).
//   • once a repo is found we do NOT descend into it (nested submodules are not
//     listed as separate top-level repos, and a repo's own tree is never walked).
//   • `node_modules`, `.git` and every dot-directory are skipped entirely.
//   • only real directories are descended (a symlinked entry reports
//     isDirectory() === false), so the walk cannot loop through a symlink cycle.
//   • an unreadable or vanished directory (EACCES/ENOENT) is SKIPPED, never
//     thrown — discovery degrades to fewer results, never to a 500.
//
// EVERY returned path is re-verified through resolveWithinRoots before it enters
// the response, exactly like a request-derived root: nothing is handed back that
// was not proven to sit within the allowlist.
const MAX_REPO_SCAN_DEPTH = 3;
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);

async function scanDirectoryForRepos(
  directoryPath: string,
  remainingDepth: number,
  rootCanonicalPath: string,
  allowedRoots: readonly string[],
  realpath: RealpathProbe,
  discoveredByPath: Map<string, GitRepoEntry>,
): Promise<void> {
  let directoryEntries;
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    // EACCES / ENOENT / ENOTDIR — skip this branch of the tree entirely.
    return;
  }

  // A `.git` entry of ANY type (dir or file) marks a repository.
  const containsGitEntry = directoryEntries.some((entry) => entry.name === '.git');
  if (containsGitEntry) {
    // Allowlist-verify before recording — never return an unverified path.
    const verifiedRepo = resolveWithinRoots(directoryPath, allowedRoots, realpath);
    if (verifiedRepo.ok && !discoveredByPath.has(verifiedRepo.absolute)) {
      const relativeLabel = relative(rootCanonicalPath, verifiedRepo.absolute);
      discoveredByPath.set(verifiedRepo.absolute, {
        path: verifiedRepo.absolute,
        name: relativeLabel === '' ? basename(verifiedRepo.absolute) : relativeLabel,
      });
    }
    // Do not descend INTO a repository.
    return;
  }

  if (remainingDepth <= 0) {
    return;
  }
  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    await scanDirectoryForRepos(
      join(directoryPath, entry.name),
      remainingDepth - 1,
      rootCanonicalPath,
      allowedRoots,
      realpath,
      discoveredByPath,
    );
  }
}

export async function discoverGitRepos(
  allowedRoots: readonly string[],
  realpath: RealpathProbe,
): Promise<GitRepoEntry[]> {
  const discoveredByPath = new Map<string, GitRepoEntry>();
  for (const root of allowedRoots) {
    // The root itself goes through the same gate (a root that no longer exists,
    // or that canonicalizes outside the allowlist, is simply not scanned).
    const verifiedRoot = resolveWithinRoots(root, allowedRoots, realpath);
    if (!verifiedRoot.ok) {
      continue;
    }
    await scanDirectoryForRepos(
      verifiedRoot.absolute,
      MAX_REPO_SCAN_DEPTH,
      verifiedRoot.absolute,
      allowedRoots,
      realpath,
      discoveredByPath,
    );
  }
  // Path-sorted for a stable, jitter-free picker order between fetches.
  return [...discoveredByPath.values()].sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
  );
}

async function readJsonBody(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await context.req.json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function registerGitApi(app: Hono, deps: GitApiDeps): void {
  const realpath = deps.realpath ?? realpathProbe;
  const adapter = new GitAdapter({ runner: deps.runner });

  // GET /api/git/repos — the repos discovered beneath the allowlist. Pure fs
  // (no git subprocess), so there is no op-error surface: an unreadable subtree
  // yields fewer repos, never a failure.
  app.get('/api/git/repos', async (context) => {
    const repos = await discoverGitRepos(deps.getAllowedRoots(), realpath);
    const response: GitReposResponse = { repos };
    return context.json(response);
  });

  // GET /api/git/status?root=<r>
  app.get('/api/git/status', async (context) => {
    const rootParam = context.req.query('root') ?? '';
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const statusResult = await adapter.status(resolution.repoRoot);
    if (!statusResult.ok) {
      return context.json(
        { error: statusResult.error, detail: statusResult.detail },
        statusForOpError(statusResult.error),
      );
    }
    const response: GitStatusResponse = { repoRoot: resolution.repoRoot, status: statusResult.value };
    return context.json(response);
  });

  // GET /api/git/diff?root=<r>&path=<p>&staged=1
  app.get('/api/git/diff', async (context) => {
    const rootParam = context.req.query('root') ?? '';
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const pathResolution = resolvePathParam(context.req.query('path'), deps, realpath);
    if (!pathResolution.ok) {
      return context.json(pathResolution.body, pathResolution.httpStatus);
    }
    const staged = context.req.query('staged') === '1';
    const diffResult = await adapter.diff(resolution.repoRoot, pathResolution.absolute, staged);
    if (!diffResult.ok) {
      return context.json(
        { error: diffResult.error, detail: diffResult.detail },
        statusForOpError(diffResult.error),
      );
    }
    const response: GitDiffResponse = { repoRoot: resolution.repoRoot, files: diffResult.value };
    return context.json(response);
  });

  // GET /api/git/branches?root=<r>
  app.get('/api/git/branches', async (context) => {
    const rootParam = context.req.query('root') ?? '';
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const branchesResult = await adapter.branches(resolution.repoRoot);
    if (!branchesResult.ok) {
      return context.json(
        { error: branchesResult.error, detail: branchesResult.detail },
        statusForOpError(branchesResult.error),
      );
    }
    const response: GitBranchesResponse = { repoRoot: resolution.repoRoot, branches: branchesResult.value };
    return context.json(response);
  });

  // GET /api/git/worktrees?root=<r>
  app.get('/api/git/worktrees', async (context) => {
    const rootParam = context.req.query('root') ?? '';
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const worktreesResult = await adapter.worktrees(resolution.repoRoot);
    if (!worktreesResult.ok) {
      return context.json(
        { error: worktreesResult.error, detail: worktreesResult.detail },
        statusForOpError(worktreesResult.error),
      );
    }
    const response: GitWorktreesResponse = { repoRoot: resolution.repoRoot, worktrees: worktreesResult.value };
    return context.json(response);
  });

  // Shared handler for stage/unstage: both take { root, path } and differ only in
  // the adapter method they call.
  const handleStageOp = async (
    context: Context,
    apply: (repoRoot: string, path: string) => ReturnType<GitAdapter['stage']>,
  ): Promise<Response> => {
    const body = await readJsonBody(context);
    if (body === null) {
      return context.json({ error: 'bad-request' } satisfies GitRefusalResponse, 400);
    }
    const rootParam = typeof body.root === 'string' ? body.root : '';
    const pathParam = typeof body.path === 'string' ? body.path : '';
    if (pathParam === '') {
      return context.json({ error: 'missing-path' } satisfies GitRefusalResponse, 400);
    }
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const pathResolution = resolvePathParam(pathParam, deps, realpath);
    if (!pathResolution.ok) {
      return context.json(pathResolution.body, pathResolution.httpStatus);
    }
    // pathResolution.absolute is defined here (pathParam was non-empty).
    const opResult = await apply(resolution.repoRoot, pathResolution.absolute!);
    if (!opResult.ok) {
      return context.json(
        { error: opResult.error, detail: opResult.detail },
        statusForOpError(opResult.error),
      );
    }
    const response: GitStageResponse = { repoRoot: resolution.repoRoot, ok: true, path: pathResolution.absolute! };
    return context.json(response);
  };

  // POST /api/git/stage { root, path }
  app.post('/api/git/stage', (context) => handleStageOp(context, (repoRoot, path) => adapter.stage(repoRoot, path)));

  // POST /api/git/unstage { root, path }
  app.post('/api/git/unstage', (context) => handleStageOp(context, (repoRoot, path) => adapter.unstage(repoRoot, path)));

  // POST /api/git/commit { root, message }
  app.post('/api/git/commit', async (context) => {
    const body = await readJsonBody(context);
    if (body === null) {
      return context.json({ error: 'bad-request' } satisfies GitRefusalResponse, 400);
    }
    const rootParam = typeof body.root === 'string' ? body.root : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (message.trim() === '') {
      return context.json({ error: 'empty-message' } satisfies GitRefusalResponse, 400);
    }
    const resolution = await resolveRepoRoot(rootParam, deps, adapter, realpath);
    if (!resolution.ok) {
      return context.json(resolution.body, resolution.httpStatus);
    }
    const commitResult = await adapter.commit(resolution.repoRoot, message);
    if (!commitResult.ok) {
      return context.json(
        { error: commitResult.error, detail: commitResult.detail },
        statusForOpError(commitResult.error),
      );
    }
    const response: GitCommitResponse = { repoRoot: resolution.repoRoot, ok: true };
    return context.json(response);
  });
}
