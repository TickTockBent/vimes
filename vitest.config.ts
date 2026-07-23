import { defineConfig } from 'vitest/config';

// ─── Root vitest config: the suite is `packages/*/src`, and ONLY that ─────────
//
// Added 2026-07-23 after a concurrent-agent run produced a gate result that was
// worse than wrong — it was *plausible*.
//
// When two units are built concurrently, implementation agents run in isolated
// git worktrees created INSIDE this repo at `.claude/worktrees/<agent>/`. Each
// is a full checkout with its own `node_modules` and its own copy of every
// `*.test.ts`. With no root config, `vitest run` walked them:
//
//   • the suite reported **3301 tests** instead of 1675 — every file counted
//     twice, so any before/after comparison silently became meaningless; and
//   • worse, an agent MID-EDIT has a legitimately red tree, so the run reported
//     **21 failures belonging to a different unit of work**. A gate that fails
//     for reasons outside the diff under review is exactly the kind of result
//     someone "fixes" in the wrong file.
//
// ⚠ **WHY AN `include` ALLOW-LIST AND NOT AN `exclude` PATTERN.** The obvious
// repair is to exclude the worktrees. Two reasons it is the weaker one:
//
//   1. An exclusion only removes what someone thought of. Any future stray
//      checkout, vendored copy, or harness scratch directory is admitted by
//      default and has to be discovered the same painful way. An allow-list
//      fails CLOSED: something new is out of the suite until deliberately added.
//   2. Excluding `**/worktrees/**` specifically is a trap IN THIS REPO, because
//      "worktree" is domain vocabulary here — VIMES manages git worktrees
//      (`worktreePaths.test.ts`, `worktreeManager.test.ts`). The day someone
//      groups those into a `worktrees/` directory, that pattern would silently
//      stop running the tests for the worktree subsystem. A guard that quietly
//      stops measuring is the failure mode this project treats as a finding.
//
// So: name the suite. Every test file today lives in `packages/*/src` (90 of
// them, verified against `git ls-files`). A new package is picked up
// automatically; anything outside `packages/` is not a test this suite runs.
//
// `exclude` restates vitest's defaults because supplying `include` does not
// change them, and a future CLI `--exclude` would override them wholesale.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
