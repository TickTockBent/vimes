import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

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

// ─── `scripts/**` joins the allow-list (S18·U1, 2026-08-25) ─────────────────
//
// scripts/check-ext-boundary.mjs is a gate script, not a workspace package —
// it has no `packages/*/src` home and never will (it SCANS packages/*/src).
// Its tests earn the same allow-list discipline as everything else here: the
// line below names exactly `scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)`, so a
// future stray script test is admitted only if someone deliberately widens
// this pattern — the same fail-closed posture the block above argues for.

// ─── The `.vue` transform (S15·U5, 2026-08-14) ───────────────────────────────
//
// Added so the suite can MOUNT a component. Until S15-F5 nothing in any gate
// mounted a `.vue`, so this config needed no plugins — and that hole is exactly
// what let a missing `:key` on PanelHost's StreamView branch ship (a keyless
// in-place route swap reused the mounted view, so `onMounted`/subscribe never
// re-ran; see docs/slice-15.md S15-F5). `@vitejs/plugin-vue` is the same
// plugin `packages/ui/vite.config.ts` builds with; it touches ONLY `.vue` files,
// so every pre-existing pure-TS test transforms exactly as before.
//
// Per-file `// @vitest-environment happy-dom` pragmas stay the DOM mechanism —
// the suite is overwhelmingly headless and pure, and a global DOM environment
// would slow all of it down to serve a handful of mount tests.
export default defineConfig({
  plugins: [vue()],
  test: {
    include: [
      'packages/*/src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
