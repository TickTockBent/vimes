# Slice 12 — D72 Move 3: adjudication reads the declaration

**Status: CLOSED 2026-08-10.** F1–F5 signed by Wes as written (morning
review, no amendments). Three units, three commits, sequential opus
agents, orchestrator gate + commit between each:

- **U1 `d01a03b`** — `extensions/proposeMove.ts` (pure, total,
  tenant-blind, decision-only) + S12-A1: 1458 count-pinned parity
  comparisons vs the then-living `proposeTransition`, the named-refusal
  belt, both tenth-node divergences pinned as knowledge, principle #16 as
  an executable grep test. Sabotage both ways (precedence swap; injected
  tenant word).
- **U2 `0d2f6ca`** — shipped manifest asset (byte-copy of the frozen
  fixture; edge-set tripwire), `shippedManifest.ts` boot fail-fast (A5),
  writer flip + pinned refs + all three creation doors on
  `workflow.initial` (A6), stage-edges derived from the declaration with
  frozen wire order (A4, byte-identity verified against compiled dist).
  Two unit-level calls inside signed F-text: `workflowRefSchema.rev`
  corrected int→semver string BEFORE first producer (skeleton's "rev:
  manifest version"; rule 0.5's cheap moment, zero producers verified);
  F4's byte-stability implemented as `WIRE_STAGE_EDGE_ORDER`, a
  route-local frozen PRESENTATION order (the declaration's intent-grouped
  row order provably differs from the wire's hand-ordered arrays) with a
  both-directions completeness tripwire — dies with q25's generic twin.
- **U3 `0ab7b44`** — the deletion (incl. `INITIAL_TASK_STAGE`: zero code
  consumers after U2, settled per the skeleton's note);
  `taskStateMachine.ts` reduced to the transitional vocabulary module
  (F5 banner naming both retirements); differential and parity re-pointed
  at frozen images of the deleted table so both pins outlive their
  subject; prose swept (UI comments-only, verified). Machine tests
  148→23, every removal accounted.

**Exit gate: met.** A1–A6 green; fixture replay green throughout; suite
green TWICE byte-identically un-piped (3237/135 both runs);
`grep -rn TASK_STAGE_EDGES packages/*/src` empty (comments included, all
three packages); census 0 at every gate. Kill criteria: neither
approached (zero parity findings; zero UI code edits). The S11 fence's
`manualReviewRequired → Move 3` pointer carries its F1 dated amendment
(slice-11.md); migration-map §2.3 Move 3 marked DONE.

**Not yet deployed.** The live daemon runs slice-11 code; the Move-3
deploy is a daemon deploy (restart) and awaits explicit clearance. It
does NOT close the q24 alias window. Live-oracle check after that deploy
(non-blocking, per the gate): a real move adjudicates and records
identically; new instances carry pinned refs `{vimes-tasks, software,
1.0.0}`.

Sources: migration-map §2.3 Move 3, node-kit §0/§1.4/§1.9, the S10
differential test (`manifest.test.ts` S10-A2), slice-11's close block.

The move, in the map's words: *"`proposeTransition` stops reading
`TASK_STAGE_EDGES` and reads the instance's pinned workflow revision;
move 1's differential test becomes the guard that the two agree, and then
the compiled table is deleted. Exit gate: fixture green, differential test
green, `TASK_STAGE_EDGES` gone from `packages/core`."*

The discipline is Move 2's, reused: **the seam moves; the behavior does
not.** This slice changes WHERE the legality table lives (compiled engine
data → the extension's declaration), not WHAT it says. Every
behavior-shaping property the declaration carries *beyond* today's table
(`by` allow-lists, `max_traversals`/`on_exhausted`, the `watchdog`
proposer class, the `manual-review` node's reachability) is explicitly
out, each waiting on its own D-record per migration-map's
"everything after move 3 is per-declaration."

## Scope

1. **The shipped manifest.** `vimes-tasks/vimes-extension.toml` becomes a
   runtime asset at `packages/daemon/extensions/vimes-tasks/` — initially a
   byte-copy of the frozen fixture (`fixtures/extensions/vimes-tasks/`,
   which stays frozen and untouched forever). The two are expected to
   diverge in later moves; a test pins their edge-table agreement until a
   dated amendment says otherwise.
2. **Boot-time resolution.** The daemon parses the shipped manifest at
   boot (`parseManifest`), resolves workflow `software`, and **fails the
   boot loudly** if it cannot — a daemon that cannot read its own
   in-build declaration is misbuilt, not degraded.
3. **The core adjudicator.** New pure module: `proposeMove(current node,
   proposal, workflow: ParsedWorkflow)` — TOTAL, tenant-blind, no throw.
   Refusal precedence preserved from `proposeTransition` (the order is
   load-bearing, its comment ports): unknown-node → same-node →
   terminal (a node with an EMPTY declared out-edge set) → **forbidden
   rows, echoing the row's declared `reason`** (node-kit §1.4.4) → the
   declared edge table. Reason strings are UNCHANGED this slice
   (`illegal-edge`, `terminal-stage`, `same-stage`, `unknown-stage`;
   `quarantined-cannot-complete` now arrives as declared data, not
   engine code). The adjudicator returns a DECISION only; it does not
   compute the next record (see F5).
4. **The writer flip.** `instanceWriter` adjudicates via `proposeMove`
   against the boot-resolved declaration; creation reads
   `workflow.initial` instead of `INITIAL_TASK_STAGE` and **stamps the
   pinned ref** (`{extension, workflow, rev: manifest version}`) instead
   of `null` — the 0.7 condition ("no pinned definition governs
   adjudication") ends this slice, so the null stamp ends with it.
   Existing null-workflow instances adjudicate against the same
   declaration (F2).
5. **The deletion.** `TASK_STAGE_EDGES`, `isLegalTaskEdge`,
   `taskStageEdgesRecord`, `proposeTransition`, `isKnownStage` die.
   `GET /api/tasks/stage-edges` re-derives its response from the
   declaration (F4). The differential test is re-pointed (see
   assertions). Grep gate: `TASK_STAGE_EDGES` has ZERO hits in
   `packages/` source after this slice — the comment references in
   `dispatchDecision.ts`, `watchdogDecision.ts`, `taskBoard.ts`,
   `vimesStore.ts`, `instanceWriter.ts`, `instanceApi.ts` are swept in
   the deletion unit (prose-only edits).

## Flagged decisions (Wes reviews before any agent runs)

- **F1 — `manualReviewRequired` does NOT retire this slice.** Slice-11's
  transitional-core fence pointed it at Move 3. Retiring it means
  activating the bounded loop (`max_traversals`/`on_exhausted` routing to
  the `manual-review` node) — a behavior-shaping change AND a fixture
  hazard (the frozen legacy view carries the flag). It retires with the
  bounded-loop activation move, own D-record. The S11 fence entry gets a
  dated amendment note, not a silent edit.
- **F2 — one boot-resolved declaration; pinned-ref mismatch is
  defensive.** Adjudication uses the declaration resolved at boot. The
  instance's pinned ref is recorded truth for replay; a live instance
  whose ref names anything the boot declaration is not joins the
  disagreement-error family (it cannot occur through any reachable path:
  this daemon stamps every ref from that same declaration, and null means
  pre-Move-3). Per-move re-resolution against multiple stored revisions
  waits until multiple revisions can exist.
- **F3 — direct `parseManifest` at boot; the extensionRegistry stays
  unwired.** The registry's job is project-declared discovery +
  provenance; wiring it here would fake an activation story Move 3 does
  not have. Its first live consumer is the activation move. (The
  in-build source kind it already carries is the landing pad for that
  day.)
- **F4 — `stage-edges` stays wire-stable.** The route's response is
  derived from the declaration but RESTRICTED to the record vocabulary's
  nine stages, target sets ordered to match today's bytes — so the
  deployed UI sees an unchanged contract mid-alias-window. Serving the
  full ten-node declared table (manual-review's out-edges included) is
  deferred to q25's generalisation, where the route itself gets its
  generic twin.
- **F5 — the convergence-flag rule stays beside the old vocabulary, not
  in the adjudicator.** `nextManualReviewRequired` hardcodes `done` — a
  tenant word the new adjudicator must not contain (principle #16,
  grep-assertable). `proposeMove` returns accept/reject only; the
  next-record computation (node write + flag rule) stays in the
  transitional vocabulary module (F1's fence banner on it, named with
  its retiring move). `taskStateMachine.ts` survives this slice as that
  vocabulary module (stages, proposers, rejection reasons, the flag
  rule) with the machine deleted from it; its re-home rides the
  de-tenanting move.

## Explicitly OUT

- `by` allow-list enforcement; `max_traversals`/`on_exhausted`
  activation; the `watchdog` proposer class; `manualReviewRequired`
  retirement (F1). Each is behavior-shaping, each gets its own D-record.
- Node-vocabulary relaxation: the record/event schemas keep the 9-stage
  enum (`taskStageSchema`); `manual-review` remains unreachable upstream
  of the adjudicator by schema fencing — which is exactly what keeps
  this slice behavior-identical.
- Rejection-reason respelling (`terminal-stage` → `terminal-node` etc.):
  wire-visible; rides the alias-death respelling deploy.
- Registry activation/enablement wiring (F3). Anything in `packages/ui`.
  Alias removal (needs the UI switch first — separate slice per q24).
  q25's generic stage-edges/work-order-schema twins (trigger is now
  half-armed: a pinned declaration exists after this slice; the route
  shape question remains).

## Assertions

- **S12-A1 (parity, the heart).** While both machines stand: for the
  FULL cross product (9 from-stages × 9 to-stages × 3 proposers ×
  flag on/off), `proposeMove(software declaration)` and
  `proposeTransition` produce identical outcomes — same accept/reject,
  same reason, and (through the writer) same recorded next state. This
  is the differential's edge-set promise upgraded to a behavioral proof,
  run at the moment it is cheapest (the old machine still standing as
  reference — Move 2's exact trick).
- **S12-A2 (standing).** The frozen fixture replays byte-identical
  through instances → legacyTasksViewOf. Untouched and green throughout.
- **S12-A3 (the differential, re-pointed).** After deletion the fixture
  manifest's expanded edge table is compared against a LITERAL frozen
  edge-set written into the test (the image of the deleted
  `TASK_STAGE_EDGES`, with provenance comment) — the guard survives its
  reference's death. Plus: the SHIPPED manifest's edge table equals the
  fixture manifest's (the divergence tripwire).
- **S12-A4.** `GET /api/tasks/stage-edges` serves byte-identical JSON
  before and after the flip (F4).
- **S12-A5.** A daemon booted against an unparsable/absent shipped
  manifest refuses to start, with the parse errors in the boot output.
- **S12-A6 (pinning).** A created instance's `instance_created` payload
  carries the resolved ref; replayed pre-Move-3 events (null workflow)
  fold and adjudicate identically to before.

## Exit gate (machine)

Fixture replay green; S12-A1..A6 green; full suite green TWICE
byte-identically from repo root, un-piped exit codes; `grep -rn
TASK_STAGE_EDGES packages/*/src` returns nothing; census 0 on every
touched file. Live-oracle (after the NEXT cleared deploy, not blocking
the slice close): a real move adjudicates and records identically, and
new instances carry pinned refs.

## Kill criteria

1. **Parity unreachable without amending the kit or the manifest** — the
   S10 differential's promise failing at the behavioral level. Halt,
   finding, back to the pass (rule 0.1). Do not tune the adjudicator
   into agreement.
2. **The deletion forces a `packages/ui` edit** (an import, not a
   comment). Verified comments-only at skeleton time; if reality
   disagrees, halt — the alias-window ordering (q24) is at stake.

## Build order

- **U1 (core, opus):** the `proposeMove` adjudicator + S12-A1 parity
  suite + cross-product port. Old machine untouched and still the
  runtime path — this unit adds the new machine and PROVES agreement.
- **U2 (daemon, opus):** shipped manifest asset + boot parse/fail-fast +
  writer flip (adjudication, `initial`, ref stamping) + stage-edges
  re-derivation + S12-A4/A5/A6.
- **U3 (core+sweep, opus):** the deletion — table, machine, record
  helper, index exports; differential re-point (S12-A3);
  `taskStateMachine.ts` reduced to the vocabulary module (F5); comment
  sweep across the six prose-reference files; grep gate.

Sequential, one agent per unit, checkpoint files, my gate + commit
between each.

## Notes

- The vocabulary module keeps `TASK_STAGES`, `INITIAL_TASK_STAGE`'s
  consumers must be re-pointed or the constant retained — U3's work
  order settles it from the actual consumer list, never by guessing.
- The daemon resolves the shipped manifest path relative to its own
  module (`import.meta.url`), never cwd — systemd's working directory is
  not a contract.
- The deploy that ships this slice is a daemon deploy (routes unchanged,
  emissions unchanged except the workflow ref stamp — additive, already
  in schema). It does NOT close the q24 alias window; that still waits
  for the UI switch.
