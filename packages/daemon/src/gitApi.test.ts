import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { GitRunner, GitRunResult } from './gitAdapter.js';
import type {
  GitReposResponse,
  GitStatusResponse,
  GitDiffResponse,
  GitBranchesResponse,
  GitCommitResponse,
  GitRefusalResponse,
} from './gitApi.js';

// ─── Git API over a live daemon with an INJECTED fake git runner ──────────────
//
// The runner is the injected seam — the happy-path tests feed canned OBSERVED-
// shape output (captured from real git 2.43.0) so the parse + route wiring is
// exercised deterministically without a real git subprocess. The hostile-input
// tests prove the allowlist wall: an out-of-roots root, and a real-fs repo whose
// toplevel escapes the roots, are both refused BEFORE any op runs.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-gitapi-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `gitapi-${databaseFileCounter}.db`);
}

function makeRoot(label: string): string {
  return realpathSync(mkdtempSync(join(temporaryDirectory, `${label}-`)));
}

function buildConfig(projectRoots: string[]): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: nextDatabasePath(),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots,
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
  };
}

// A fake runner keyed on the git subcommand. `--version` reports present; each
// other command returns its canned output. rev-parse resolves --show-toplevel to
// the runner's cwd by default (i.e. the repo IS the requested root), so the
// toplevel re-check passes for in-roots repos and fails for out-of-roots ones.
interface FakeGitControls {
  toplevelFor?: (cwd: string) => string;
  canned?: Record<string, GitRunResult>;
  calls: string[][];
}

function makeFakeRunner(controls: FakeGitControls): GitRunner {
  return async (args, cwd) => {
    controls.calls.push(args);
    const command = args[0] ?? '';
    if (command === '--version') {
      return { stdout: 'git version 2.43.0', stderr: '', exitCode: 0 };
    }
    if (command === 'rev-parse') {
      const toplevel = controls.toplevelFor ? controls.toplevelFor(cwd) : cwd;
      return { stdout: `${toplevel}\n`, stderr: '', exitCode: 0 };
    }
    const canned = controls.canned?.[command];
    if (canned !== undefined) {
      return canned;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

function startDaemon(config: DaemonConfig, gitRunner: GitRunner): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier: permissiveVerifier,
    gitRunner,
  });
  return daemon.start().then(() => daemon);
}

interface FetchInit {
  method?: string;
  body?: string;
}
function apiFetch(daemon: Daemon, path: string, init: FetchInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN, 'content-type': 'application/json' },
  });
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const STATUS_STDOUT =
  [
    '# branch.oid 29c6f6731985353342e28fc176745ed0dc2f9ed2',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 0c2aa38 0c2aa38 tracked.txt',
    '? untracked.txt',
  ].join(String.fromCharCode(0)) + String.fromCharCode(0);

const DIFF_STDOUT = `diff --git a/tracked.txt b/tracked.txt
index 9864d22..06db466 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,3 +1,3 @@
 line one
-line two
+line two CHANGED
 line three
`;

describe('Git API — happy path with a fake runner', () => {
  it('GET /api/git/status parses porcelain v2 into the response shape', async () => {
    const root = makeRoot('status');
    const controls: FakeGitControls = { calls: [], canned: { status: { stdout: STATUS_STDOUT, stderr: '', exitCode: 0 } } };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, `/api/git/status?root=${encodeURIComponent(root)}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GitStatusResponse;
      expect(body.repoRoot).toBe(root);
      expect(body.status.branch.head).toBe('main');
      expect(body.status.entries.map((entry) => entry.path)).toEqual(['tracked.txt', 'untracked.txt']);
      // The status command ran with the porcelain v2 -z --branch args.
      const statusCall = controls.calls.find((call) => call[0] === 'status');
      expect(statusCall).toEqual(['status', '--porcelain=v2', '-z', '--branch']);
    } finally {
      await daemon.stop();
    }
  });

  it('GET /api/git/diff parses hunks and passes the --/staged guards', async () => {
    const root = makeRoot('diff');
    const controls: FakeGitControls = { calls: [], canned: { diff: { stdout: DIFF_STDOUT, stderr: '', exitCode: 0 } } };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, `/api/git/diff?root=${encodeURIComponent(root)}&staged=1`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GitDiffResponse;
      expect(body.files).toHaveLength(1);
      expect(body.files[0]!.path).toBe('tracked.txt');
      const diffCall = controls.calls.find((call) => call[0] === 'diff');
      // --staged is present, and the operand guard `--` is always emitted.
      expect(diffCall).toEqual(['diff', '--no-color', '--staged', '--']);
    } finally {
      await daemon.stop();
    }
  });

  it('GET /api/git/diff for a specific path resolves it and guards it after --', async () => {
    const root = makeRoot('diffpath');
    const controls: FakeGitControls = { calls: [], canned: { diff: { stdout: DIFF_STDOUT, stderr: '', exitCode: 0 } } };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const targetPath = join(root, 'tracked.txt');
      const response = await apiFetch(
        daemon,
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(targetPath)}`,
      );
      expect(response.status).toBe(200);
      const diffCall = controls.calls.find((call) => call[0] === 'diff');
      // The resolved absolute path is the LAST operand, after the `--` guard.
      expect(diffCall).toEqual(['diff', '--no-color', '--', targetPath]);
    } finally {
      await daemon.stop();
    }
  });

  it('GET /api/git/branches parses for-each-ref output', async () => {
    const root = makeRoot('branches');
    const controls: FakeGitControls = {
      calls: [],
      canned: { 'for-each-ref': { stdout: 'main 3b9a17a origin/main\nfeature 1122334 \n', stderr: '', exitCode: 0 } },
    };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, `/api/git/branches?root=${encodeURIComponent(root)}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GitBranchesResponse;
      expect(body.branches).toEqual([
        { name: 'main', oid: '3b9a17a', upstream: 'origin/main' },
        { name: 'feature', oid: '1122334', upstream: null },
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /api/git/stage resolves the path and runs add -- <abs>', async () => {
    const root = makeRoot('stage');
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const targetPath = join(root, 'tracked.txt');
      const response = await apiFetch(daemon, '/api/git/stage', {
        method: 'POST',
        body: JSON.stringify({ root, path: targetPath }),
      });
      expect(response.status).toBe(200);
      const addCall = controls.calls.find((call) => call[0] === 'add');
      expect(addCall).toEqual(['add', '--', targetPath]);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /api/git/commit runs commit -m <message> -- and returns ok', async () => {
    const root = makeRoot('commit');
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/commit', {
        method: 'POST',
        body: JSON.stringify({ root, message: 'review: apply' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as GitCommitResponse;
      expect(body.ok).toBe(true);
      const commitCall = controls.calls.find((call) => call[0] === 'commit');
      // The message is a bound value of -m (never an option); -- guards the operand.
      expect(commitCall).toEqual(['commit', '-m', 'review: apply', '--']);
    } finally {
      await daemon.stop();
    }
  });

  it('a git op that exits non-zero becomes a clean 400 refusal, never a 500', async () => {
    const root = makeRoot('failcommit');
    const controls: FakeGitControls = {
      calls: [],
      canned: { commit: { stdout: '', stderr: 'nothing to commit, working tree clean', exitCode: 1 } },
    };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/commit', {
        method: 'POST',
        body: JSON.stringify({ root, message: 'nothing staged' }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('git-failed');
      expect(body.detail).toContain('nothing to commit');
    } finally {
      await daemon.stop();
    }
  });
});

// ─── Repo-relative request paths (the acceptance-test finding) ────────────────
//
// `git status --porcelain=v2` emits REPO-RELATIVE paths and the UI hands them
// straight back. The bug: they were resolved against the ALLOWLIST ROOT, so a
// repo NESTED below the root (~/projects/content/vesh under ~/projects) lost its
// `content/vesh/` prefix and the diff read ENOENT. Every test below nests the
// repo below the allowlisted root so the old behavior would reproduce.

describe('Git API — repo-relative request paths', () => {
  // Allowlist the container; the repo lives two levels below it.
  function makeNestedRepository(): { containerRoot: string; repositoryRoot: string } {
    const containerRoot = makeRoot('relpath');
    const repositoryRoot = join(containerRoot, 'content', 'vesh');
    mkdirSync(join(repositoryRoot, 'manuscript'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'manuscript', 'chapter-01.md'), 'chapter one\n', 'utf8');
    return { containerRoot, repositoryRoot };
  }

  it('GET /api/git/diff resolves a repo-relative path against the REPO ROOT, not the allowlist root', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [], canned: { diff: { stdout: DIFF_STDOUT, stderr: '', exitCode: 0 } } };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(
        daemon,
        `/api/git/diff?root=${encodeURIComponent(repositoryRoot)}&path=${encodeURIComponent('manuscript/chapter-01.md')}`,
      );
      expect(response.status).toBe(200);
      const diffCall = controls.calls.find((call) => call[0] === 'diff');
      expect(diffCall).toEqual(['diff', '--no-color', '--', join(repositoryRoot, 'manuscript', 'chapter-01.md')]);
      // The regression: the container-root resolution dropped `content/vesh/`.
      expect(diffCall![3]).not.toBe(join(containerRoot, 'manuscript', 'chapter-01.md'));
    } finally {
      await daemon.stop();
    }
  });

  it('POST /api/git/stage resolves a repo-relative path against the REPO ROOT', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/stage', {
        method: 'POST',
        body: JSON.stringify({ root: repositoryRoot, path: 'manuscript/chapter-01.md' }),
      });
      expect(response.status).toBe(200);
      const expectedAbsolutePath = join(repositoryRoot, 'manuscript', 'chapter-01.md');
      const addCall = controls.calls.find((call) => call[0] === 'add');
      expect(addCall).toEqual(['add', '--', expectedAbsolutePath]);
      // The response echoes the RESOLVED absolute path.
      const body = (await response.json()) as { path: string };
      expect(body.path).toBe(expectedAbsolutePath);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /api/git/unstage resolves a repo-relative path against the REPO ROOT', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/unstage', {
        method: 'POST',
        body: JSON.stringify({ root: repositoryRoot, path: 'manuscript/chapter-01.md' }),
      });
      expect(response.status).toBe(200);
      const resetCall = controls.calls.find((call) => call[0] === 'reset' || call[0] === 'restore');
      expect(resetCall![resetCall!.length - 1]).toBe(join(repositoryRoot, 'manuscript', 'chapter-01.md'));
    } finally {
      await daemon.stop();
    }
  });

  it('still accepts an ABSOLUTE path unchanged', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [], canned: { diff: { stdout: DIFF_STDOUT, stderr: '', exitCode: 0 } } };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const absolutePath = join(repositoryRoot, 'manuscript', 'chapter-01.md');
      const response = await apiFetch(
        daemon,
        `/api/git/diff?root=${encodeURIComponent(repositoryRoot)}&path=${encodeURIComponent(absolutePath)}`,
      );
      expect(response.status).toBe(200);
      const diffCall = controls.calls.find((call) => call[0] === 'diff');
      expect(diffCall).toEqual(['diff', '--no-color', '--', absolutePath]);
    } finally {
      await daemon.stop();
    }
  });

  it('still REFUSES a repo-relative traversal that climbs out of the allowlist (403, no git op)', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(
        daemon,
        `/api/git/diff?root=${encodeURIComponent(repositoryRoot)}&path=${encodeURIComponent('../../../etc/passwd')}`,
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('path-outside-allowlist');
      expect(controls.calls.some((call) => call[0] === 'diff')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('still REFUSES a repo-relative traversal on stage (403, no add)', async () => {
    const { containerRoot, repositoryRoot } = makeNestedRepository();
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/stage', {
        method: 'POST',
        body: JSON.stringify({ root: repositoryRoot, path: '../../../etc/passwd' }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('path-outside-allowlist');
      expect(controls.calls.some((call) => call[0] === 'add')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});

describe('Git API — hostile input (extends I14 / traversal posture)', () => {
  it('refuses a root OUTSIDE the allowlist with 403 and never runs git', async () => {
    const root = makeRoot('inroots');
    const outsideRoot = makeRoot('outside'); // a real dir, but not in projectRoots
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, `/api/git/status?root=${encodeURIComponent(outsideRoot)}`);
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('root-outside-allowlist');
      // No git ran at all — not even the preflight or rev-parse.
      expect(controls.calls).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a traversal root that climbs out of the allowlist with 403', async () => {
    const root = makeRoot('travroot');
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      // An absolute path with a traversal that resolves outside every root.
      const escaping = join(root, '..', '..', 'etc', 'passwd');
      const response = await apiFetch(daemon, `/api/git/status?root=${encodeURIComponent(escaping)}`);
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('root-outside-allowlist');
      expect(controls.calls).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses when the discovered repo TOPLEVEL escapes the allowlist (403), even if the root is in-roots', async () => {
    const root = makeRoot('escaperepo');
    const outsideRoot = makeRoot('escapetoplevel');
    // The requested root is allowlisted, but rev-parse reports a toplevel that
    // sits OUTSIDE the roots — a repo whose .git is above the allowlisted dir.
    // This is the halting-finding guard: the toplevel is re-checked.
    const controls: FakeGitControls = { calls: [], toplevelFor: () => outsideRoot };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, `/api/git/status?root=${encodeURIComponent(root)}`);
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('repo-outside-allowlist');
      // rev-parse ran (to discover the toplevel), but the status op never did.
      expect(controls.calls.some((call) => call[0] === 'rev-parse')).toBe(true);
      expect(controls.calls.some((call) => call[0] === 'status')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a non-repo path with a clean 404 (not a 500)', async () => {
    const root = makeRoot('nonrepo');
    // rev-parse exits 128 (not a git repository).
    const controls: FakeGitControls = {
      calls: [],
      canned: { 'rev-parse': { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } },
    };
    // Route rev-parse through canned by overriding: the fake returns canned when
    // present, so seed it here.
    const runner: GitRunner = async (args, cwd) => {
      controls.calls.push(args);
      if (args[0] === '--version') {
        return { stdout: 'git version 2.43.0', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const daemon = await startDaemon(buildConfig([root]), runner);
    try {
      const response = await apiFetch(daemon, `/api/git/status?root=${encodeURIComponent(root)}`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('not-a-repo');
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a stage path outside the allowlist with 403', async () => {
    const root = makeRoot('stageguard');
    const outsideRoot = makeRoot('stageoutside');
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/stage', {
        method: 'POST',
        body: JSON.stringify({ root, path: join(outsideRoot, 'secret.txt') }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('path-outside-allowlist');
      // The add never ran — the path was refused before the op.
      expect(controls.calls.some((call) => call[0] === 'add')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses an empty root with 400', async () => {
    const root = makeRoot('emptyroot');
    const controls: FakeGitControls = { calls: [] };
    const daemon = await startDaemon(buildConfig([root]), makeFakeRunner(controls));
    try {
      const response = await apiFetch(daemon, '/api/git/status');
      expect(response.status).toBe(400);
      const body = (await response.json()) as GitRefusalResponse;
      expect(body.error).toBe('missing-root');
    } finally {
      await daemon.stop();
    }
  });
});

// ─── Repo discovery (GET /api/git/repos) ──────────────────────────────────────
//
// The gate finding this fixes: VIMES_PROJECT_ROOTS points at a CONTAINER of
// repos (~/projects), so a picker offering the roots themselves can never reach
// a repository. Discovery walks a bounded depth below each allowlisted root and
// returns only allowlist-verified repo paths.

// Mark `directoryPath` as a repository. `asFile` writes a `.git` FILE (the
// worktree/submodule shape) instead of a `.git` DIRECTORY — both must count.
function makeRepositoryAt(directoryPath: string, asFile = false): void {
  mkdirSync(directoryPath, { recursive: true });
  const gitEntryPath = join(directoryPath, '.git');
  if (asFile) {
    writeFileSync(gitEntryPath, 'gitdir: /elsewhere/.git/worktrees/w\n', 'utf8');
  } else {
    mkdirSync(gitEntryPath, { recursive: true });
  }
}

async function fetchDiscoveredRepos(daemon: Daemon): Promise<GitReposResponse> {
  const response = await apiFetch(daemon, '/api/git/repos');
  expect(response.status).toBe(200);
  return (await response.json()) as GitReposResponse;
}

describe('Git API — repo discovery under the allowlist', () => {
  it('discovers nested repos (.git as DIRECTORY and as FILE) and labels them relative to the root', async () => {
    const containerRoot = makeRoot('discover');
    makeRepositoryAt(join(containerRoot, 'infrastructure', 'vimes'));
    makeRepositoryAt(join(containerRoot, 'games', 'dongfu'), true);
    // A plain directory with no .git is not a repo.
    mkdirSync(join(containerRoot, 'notes'), { recursive: true });

    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos).toEqual([
        { path: join(containerRoot, 'games', 'dongfu'), name: 'games/dongfu' },
        { path: join(containerRoot, 'infrastructure', 'vimes'), name: 'infrastructure/vimes' },
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it('lists a root that is itself a repo, under its basename', async () => {
    const repoRoot = makeRoot('rootisrepo');
    makeRepositoryAt(repoRoot);
    const daemon = await startDaemon(buildConfig([repoRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos).toEqual([{ path: repoRoot, name: basename(repoRoot) }]);
    } finally {
      await daemon.stop();
    }
  });

  it('never returns a repo outside the allowlisted roots', async () => {
    const insideRoot = makeRoot('inside');
    const outsideRoot = makeRoot('outside');
    makeRepositoryAt(join(insideRoot, 'mine'));
    makeRepositoryAt(join(outsideRoot, 'theirs'));

    const daemon = await startDaemon(buildConfig([insideRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos.map((repo) => repo.path)).toEqual([join(insideRoot, 'mine')]);
      expect(body.repos.some((repo) => repo.path.startsWith(outsideRoot))).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('bounds the walk at 3 levels below the root', async () => {
    const containerRoot = makeRoot('depth');
    makeRepositoryAt(join(containerRoot, 'one', 'two', 'three'));
    makeRepositoryAt(join(containerRoot, 'one', 'two', 'threeb', 'four'));

    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos.map((repo) => repo.name)).toEqual(['one/two/three']);
    } finally {
      await daemon.stop();
    }
  });

  it('does not descend into a discovered repo, and skips node_modules and dot-directories', async () => {
    const containerRoot = makeRoot('nodescend');
    makeRepositoryAt(join(containerRoot, 'outer'));
    // A submodule INSIDE the discovered repo must not be listed separately.
    makeRepositoryAt(join(containerRoot, 'outer', 'vendor', 'submodule'));
    // Noise that must never be walked.
    makeRepositoryAt(join(containerRoot, 'node_modules', 'somepackage'));
    makeRepositoryAt(join(containerRoot, '.cache', 'hiddenrepo'));

    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos.map((repo) => repo.name)).toEqual(['outer']);
    } finally {
      await daemon.stop();
    }
  });

  it('skips an unreadable directory instead of throwing', async () => {
    const containerRoot = makeRoot('unreadable');
    makeRepositoryAt(join(containerRoot, 'readable'));
    const lockedDirectory = join(containerRoot, 'locked');
    // No repo inside the locked directory, so the expectation holds whether or
    // not the test user can bypass the mode bits.
    mkdirSync(join(lockedDirectory, 'plain'), { recursive: true });
    chmodSync(lockedDirectory, 0o000);

    const daemon = await startDaemon(buildConfig([containerRoot]), makeFakeRunner({ calls: [] }));
    try {
      const body = await fetchDiscoveredRepos(daemon);
      expect(body.repos.map((repo) => repo.name)).toEqual(['readable']);
    } finally {
      chmodSync(lockedDirectory, 0o755);
      await daemon.stop();
    }
  });
});
