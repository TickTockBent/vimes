# Slice 10 — the seam foundation (D72 Moves 0 + 1)

Opened 2026-08-06 on the slice-9 pass signature (D71/D72). First build slice
of the extension-engine era. **Zero behavior change by design**: everything
this slice lands is a fixture, a parser, a registry, and tests — nothing
activates, nothing routes, no consumer exists (rule 0.5's posture carried
into build).

## Scope

- **Move 0 — freeze the fixture.** Export the production `tasks` stream
  (111 events, seq 1–111 — the Gate-2 trial's complete recorded behavior)
  and the `projections/tasks.ts` state it folds to into repository fixture
  files, plus a replay test: fixture events → today's fold → byte-identical
  (canonicalJson) to the frozen state. This is the test that keeps every
  later migration step honest (D72: "refactors are free, behaviour is the
  test").
- **Move 1a — the manifest parser/validator** (`packages/core/src/
  extensions/manifest.ts`): parse + validate `vimes-extension.toml` per the
  signed schema (extension-model §2, node-kit §1) — identity grammar,
  semver-validated `version`, `api_version` per-field gating, static
  sections (verbs two-faced w/ the #13 authority-property refusals, overlays
  w/ declared attention ranks, panes, events allowlist-warn), capabilities
  (unknown → reject), `[[node-kinds]]` + `[[workflows]]` per the kit
  (edges/forbidden/wildcard expansion w/ self-edge exclusion, briefing,
  acceptance kinds, the plan-mode × non-empty-tools refusal). Parse, list,
  refuse — never execute. Plus the **real `vimes-tasks` manifest** as a
  fixture (node-kit §1.9 + extension-model §3.1 made literal), and **the
  differential test**: declared edges, expanded, minus forbidden ==
  `TASK_STAGE_EDGES` exactly (manual-review family the declared-only
  addition).
- **Move 1b — the registry** (`packages/daemon/src/extensionRegistry.ts`):
  installed set (in-build + operator-named local dirs only — D67),
  source provenance, enabled flag, re-parse-on-use with
  listed-with-warning degrade, `<project>/.vimes/extensions.toml`
  resolution with version-range matching. Zero consumers: nothing calls it
  but its tests.

## Explicitly OUT

Moves 2–3 (instance store, adjudication cut-over). Any activation or
loading of extension code. The extension host (Tier 1 interface, Tier 2
supervisor). Capability grant *enforcement* (the registry stores granted
sets; nothing checks them). `extensions.lock` writing. Daemon routes, WS
ops, UI — all untouched (D72's hard line). Book Genesis. The blocks
vocabulary.

## Assertions (this slice's, on top of all prior — 0.4)

- **S10-A1** Fixture replay: the frozen 111 events fold to byte-identical
  projected state, twice, deterministically.
- **S10-A2** Differential: the parsed vimes-tasks manifest's expanded edge
  table equals `TASK_STAGE_EDGES` edge-for-edge (the declared `manual-review`
  edges the only additions).
- **S10-A3** Refusals refuse: unknown capability, authority-named input
  property, non-semver version, too-new `api_version` field use ("requires
  api_version >= N"), plan-mode × non-empty tools, duplicate section ids,
  self-parent wildcard fallout — each a distinct named parse error, each
  tested.
- **S10-A4** Degrades degrade: unknown event kind → warning not error;
  broken manifest → listed-with-warning in the registry, never a throw.
- **S10-A5** Parse is pure: no I/O inside `packages/core` parsing (TOML text
  in, result out); the registry owns all disk access (0.3).

## Exit gate (machine)

`npm run typecheck` + full suite green **twice** with byte-identical fixture
serialization; S10-A1..A5 all present and green; prior 3185 stay green.

## Kill criteria

- **Move 0**: the frozen fixture does NOT replay byte-identical through
  today's fold → the fold is nondeterministic → rule-0.1 finding, slice
  halts.
- **Move 1** (from D72, verbatim): the vimes-tasks manifest cannot be
  written without amending the signed kit **more than once** → stop, write
  the finding, take it back to the pass. One amendment is a discovered
  detail; two is a wrong abstraction.

## Notes

- New dependency: `smol-toml` (TOML 1.0, TS-native) in `packages/core` —
  the one dependency this slice adds.
- The fixture contains real trial content (work-order prose, plan text).
  Reviewed for secrets/credentials before commit (log-is-forever applies to
  fixtures too).
- Build order: Move 0 → my gate → Move 1a → my gate → Move 1b → my gate →
  exit gate. One agent per move, sequential.
