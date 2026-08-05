# Slice 9 — the extension-engine design pass (D70)

Opened 2026-08-05 on Wes's sign-off of D70. **A design pass, not a build
slice**: its outputs are decisions, reserved schemas, and signed specs.
Nothing builds until Wes signs the assembled pass. Absorbs the former D51
node-kit pass.

## Scope (the questions this pass must answer)

1. **The engine/extension boundary, precisely** (decides **D66**): which
   tiers exist (in-process modules over the spine vs external processes over
   the public API — the herdr fork, decomp §Q1), what each tier may touch,
   and the hard rule inherited from D70: extensions propose, the engine's
   deterministic core decides (0.3, principle 13).
2. **The session-tree engine primitive**: worktree-backed child sessions
   with git-checkout provenance, grouped under a parent (herdr model,
   primary source cited in design-directions). Must subsume trial findings
   1 (dispatch isolation) and 5 (staleness guard: work referencing symbols
   absent at the checkout base fails loud at dispatch). Transcript-level
   forking explicitly NOT designed for (D70), but not precluded.
3. **The extension manifest** (schema reserved, 0.5): identity, version,
   `min_vimes_version` floors (incl. data artifacts), actions/events/panes/
   link-handler declarations (herdr taxonomy as prior art), per-extension
   state isolation, per-project declaration ("this project loads these
   extensions, these versions").
4. **The trust model** (decides **D67**): v1 lean is first-party-only, but
   the manifest must make preview-before-install and pinning possible day
   one. The daemon holds Access-authenticated reach into every project —
   what an extension may do is a security design, not a convention.
5. **The node kit** (ex-D51): the workflow-definition shape extensions use —
   node kinds (work/review/hold), stage briefings, acceptance shapes,
   auto-dispatch flags (finding 2's future). Proven on paper against BOTH
   tenants before it is signed.
6. **The migration map**: how today's task machine (core state machine,
   dispatcher, vimes_board MCP, board UI) becomes tenant #1, and the
   sequencing decision — seam-first vs migrate-last — made explicitly.
7. **The drive-verb drop-in spec**: promote/move/dispatch/amend as extension
   content over the public API, carrying the standing riders (herdr
   skill-file discipline; principle-13 check).
8. **The client contract**: web and terminal as co-equal API consumers
   (#15); the extension UI contract client-agnostic or gracefully degrading
   (a `[[pane]]` on a TUI). Informed by the D62 ACP read.
9. **Principle #16 ratification**: "the engine makes zero assumptions about
   how people work" — proposed text for Wes.

## Inputs (all staged)

- D70 (the mandate) · D66/D67 open entries (triggers + leans) · #15, #10,
  #13, 0.3 (the constitution's constraints).
- `docs/decomposition/references/` — all seven products' source, herdr
  worktree/plugin/manifest docs foremost.
- `~/projects/content/book-genesis` — tenant #2's actual repo.
- The D62 ACP read (research unit, this pass).
- Trial findings 1–6 (slice-8.md) — the seam's known pressure points.

## Explicitly OUT

Any implementation. Third-party marketplace mechanics. Extension
hot-reload/update mechanics beyond what the manifest reserves. Transcript
forking. Book Genesis's own content work. Home-page/UI reshuffles.

## Build order (design-pass phases)

- **S9·0 research**: (a) D62 ACP spec read → mapping report; (b) references
  deep-read (herdr plugin host + socket API; jinn/agenc for trust prior
  art) → prior-art brief. Agent units; reports to scratchpad, conclusions
  into the pass docs.
- **S9·1 engine core + session trees** (scope 2, half of 1) — design doc.
- **S9·2 manifest + tiers** (scope 1, 3) → D66 proposed.
- **S9·3 trust** (scope 4) → D67 proposed.
- **S9·4 node kit + both tenant mappings on paper** (scope 5) — the kill
  criterion's test lives here.
- **S9·5 migration map + drive-verb spec + client contract** (scope 6–8).
- **S9·6 assembly** → Wes reads the whole pass, ratifies #16, signs D66/D67
  and the pass itself.

## Exit gate (human)

Wes signs the assembled pass: D66 + D67 decided, manifest + project
declaration schemas reserved, migration map with sequencing, node kit
validated on paper against both tenants, #16 ratified (or rejected with
rationale — that too is an exit).

## Kill criterion

If the extension model cannot host BOTH named tenants — the task machine
and Book Genesis — without tenant-specific carve-outs in the engine, the
abstraction is wrong: STOP, write the finding, and re-scope (the likely
fallback is a narrower engine that admits it is a software-workflow host,
which is itself a legitimate D-record). Two tenants is the floor because
one tenant proves nothing about generality (define at first instance,
generalize at second).
