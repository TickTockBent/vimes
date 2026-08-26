# Slice 20 — the acceptance declaration goes LIVE (second per-declaration move)

**STATUS: rev 5 SIGNED ⟨Wes⟩ 2026-08-26 — build clear to dispatch.
Skeleton rebuilt through four Sol rounds (5/5, 4/4, 3/3 + a test cell,
1/1 — thirteen findings, thirteen CONFIRMED, §7).**

The second post-Move-4 per-declaration move, in the migration map's kit
order (migration-map.md:492). `[workflows.nodes.acceptance]` stops being
descriptive and starts GOVERNING outcome routing — which node a filed
report satisfies, how the verdict is derived, and where the instance goes
on pass/fail — via Move-3 choreography (differential beside → flip →
delete-and-freeze). Slice 19 is the worked template; this slice follows
its §5 unit shape deliberately.

## §0. Recon (2026-08-26 rev 5, orchestrator-verified at `dc3ef53`)

1. **The manifest declares acceptance on exactly 3 of its 11 nodes**
   (vimes-extension.toml:271–274 planning `artifact`, :288–291
   implementing `report`, :300–307 review `rubric`) — and that is TOTAL
   coverage of the compiled outcome edges: the dispatcher proposes
   exactly three moves on its own authority (recordPlan, recordReview,
   recordCompletion), one per declared table. Every other node rests
   (node-kit §1.8.4 (f) NONE) and nothing compiled routes it.
2. **The parser already validates all five kinds** — per-kind key
   allow-lists (manifest.ts:1700–1714), closed vocabularies for
   coverage/unlisted_ids/aggregate (manifest.ts:191–195), producing
   `ParsedAcceptance` (:313–328) on every node (:337) — **and the parse
   result has ZERO runtime consumers** (repo grep: no `.acceptance`
   read outside manifest.ts and tests). Same starting position as
   S19's briefing: declared, validated, inert.
3. **The compiled halves are three hard-coded routings** in
   `taskDispatcher.ts`, each ending in `instanceWriter.proposeMove`
   with `proposedBy: 'dispatcher'` (I7's choke point, unchanged by
   this slice): recordPlan → `'plan-ready'` (:952), recordReview →
   `deriveReviewOutcome(...)` then propose (:1032/:1036),
   recordCompletion → `'review'` (:1132).
4. **`deriveReviewOutcome` (reviewOutcome.ts:22) is ROW-FOR-ROW the
   declared rubric**: any fail → implementing; every task criterion
   covered by a pass → done; extra reported ids ignored (bend A-17);
   bare task vacuously covered. `coverage = "all-criteria-pass"` and
   `unlisted_ids = "ignore"` are already one-member closed enums —
   the equivalence is checkable, not aspirational.
5. **The report→node binding is hard-coded stage literals today, in
   FOUR occurrence classes per path** (Sol round-2 P1b completed the
   inventory): (a) the reverse-lookup key (`sessionRef.stage ===` at
   :904, :995, :1091); (b) the ATTEMPT-COUNT filter over the same
   literal (:916–918, :1005–1007, :1104–1106) — an uncounted twin
   whose divergence from a derived lookup would yield `attempt: 0`,
   which `report_filed`'s schema forbids (positive int,
   events.ts:1411); (c) the emitted identity `node:` (:942, :1019,
   :1118); (d) plan-only: the artifact envelope's
   `taskRef.stage: 'planning'` (:926). The declaration carries the
   SAME binding as data: `acceptance.report` names the verb,
   `requires = ["capture:plan"]` names the capture. Derived, the
   values are identical bytes — and ALL FOUR classes must derive from
   the one resolved node id or the identity is internally
   inconsistent under perturbation (§3.3).
6. **The one-boot-declaration seam exists and is the pattern to
   extend**: `briefingDeclarations.ts` takes an injected
   `ParsedWorkflow` (F2's law restated at :10–31); app.ts resolves the
   shipped workflow ONCE at boot and hands the same object to writer,
   API, and preflight. The acceptance read becomes the fourth reading
   of that one object — no second resolution.
7. **Edge legality already covers every declared target with
   `by = ["dispatcher"]`** (toml :225 planning→plan-ready, :230
   implementing→review, :231 review→done, :233 review→implementing
   with `max_traversals = 3`, `on_exhausted = "manual-review"`).
   Exhaustion is the WRITER's, not the evaluator's: the declared
   `on_fail` proposes, the writer routes exhausted traversals to
   manual-review exactly as today. No edge change needed; §2 forbids
   one.
8. **Acceptance routing targets ARE already parse-validated** —
   `on_pass`, `on_fail`, AND `on_answer` each refuse
   `unknown-node-reference` against the declared node set
   (manifest.ts:2196–2221, "Acceptance routing targets are part of the
   graph, not decoration"), and reachability spans them
   (manifest.test.ts:733). *(Rev 1 claimed the opposite from a
   truncated grep — Sol P0, §7. One probe is not a refutation.)* The
   genuine gaps are narrower: **(a)** no DIRECT refusal test targets a
   ghost acceptance target (the one `unknown-node-reference` test,
   :782, exercises `initial`/edges); **(b)** `criteria_from` is a bare
   `readString` (:1773–1779) — an unsupported value parses clean and
   would surface only after a report had already been filed.
9. **No cross-check ties `acceptance.report` to the SAME node's
   `briefing.tools`** (the only briefing/acceptance cross-validation
   is `plan-mode-with-tools`, manifest.ts:2315). The shipped manifest
   holds the invariant by hand (review mounts `report_review` :302 and
   declares it :302; implementing likewise :290–291) — but a manifest
   that mounts a verb on one node while declaring its acceptance on
   another parses clean today, and under declaration-governed binding
   that report would resolve a node the filing session never attached
   to: a silent no-op (Sol P1a).
10. **The kit's artifact contract is WIDER than the shipped case**:
    §1.8.4 (d) admits multiple `requires` entries and ordinary paths
    (node-kit.md:503–508), while Tier 1 ships exactly one entry of the
    `capture:<name>` form. A pure evaluator (no filesystem) cannot
    probe path existence — live artifact evaluation must narrow to the
    capture-ref form explicitly (Sol P1b, §3.6).
11. **Neither human-gate NOR scalar has a genuine invocation path at
    Tier 1.** Human-gate is answered through `on_answer` via the
    engine's gate surface (node-kit §1.8.4 (c)), not by a filed
    report — no report verb ever binds to it, and its consumer is
    §2-out. And scalar has NO report channel: `report_filed` is a
    CLOSED two-member discriminated union — `review` (criteria) and
    `completion` (worklog) bodies only (events.ts:1407–1424) — and
    the daemon's only filing paths are the typed
    recordReview/recordCompletion callbacks. A scalar declaration
    reusing an engine verb would file a rubric-shaped body never
    validated against the scalar's dimensions, violating node-kit
    property 2 ("the report is validated, never trusted"). Both kinds
    are DORMANT vocabulary (Sol round-1 P2a split them; round-2 P1c
    rejoined them on the correct line — reachability, not report-
    backedness). §3.5 gives both the dormant posture and the parse
    rule that keeps them dormant honestly.
12. **The parser already has an INJECTION idiom for engine-known
    vocabularies**: `ParseManifestOptions` (manifest.ts:396–400)
    injects `hostApiVersion` and `fieldVocabulary` with engine
    defaults (:2493–2497). **And the engine verb catalogue ALREADY
    EXISTS with a documented single-source contract**:
    `ENGINE_REPORT_TOOL_NAMES`/`ENGINE_REPORT_TOOL_IDS`
    (briefingDeclarations.ts:121–130, daemon) — S19's comment pins
    "the ONE place the id set is written in the declaration path" and
    ties it to the session host by the A2 differential (a real
    `SessionHost` per stage, mounted ids compared against the
    constant), so a second copy in core would break a signed
    invariant, not just risk drift (Sol round-3 P1b). §3.5 RELOCATES
    the constant rather than shadowing it.
13. **Instruments inherited**: the 37-golden briefing byte set (S19
    A1) — acceptance routing never touches composer bytes, so it must
    stay untouched; taskDispatcher.test.ts holds the outcome behavior
    tests that become the differential's reference; S19's frozen
    differential and the S18-F4 stem test ride along unchanged.
14. **Scalar and human-gate have no Tier-1 consumer** (the manifest
    declares only artifact/report/rubric); Book Genesis is tenant 2
    and stays a paper mapping (migration-map §2.4). Rule 0.5: the
    shapes are parsed (landed), the machinery waits for its first
    consumer.

## §1. Scope

- The generic acceptance evaluator (node-kit §1.8.4, migration-map:255):
  pure, total, engine-side — `packages/core/src/extensions/acceptance.ts`.
- The three dispatcher routings read the boot declaration: binding,
  derivation, and targets from `[workflows.nodes.acceptance]`; at the
  flip, the `deriveReviewOutcome` call and EVERY literal occurrence in
  §0.5's four-class inventory (lookup key, attempt filter, emitted
  `node:`, plan envelope `taskRef.stage`) plus the three target
  literals — deleted per U3's checked-off inventory, never a sweep.
- The engine report-verb catalogue RE-HOMED to core (one source:
  §3.5), daemon re-exporting; parser, preflight, and the host
  differential all reading the one constant.
- Parse-time fail-closed ADDITIONS (the genuine gaps, §0.8b/§0.9/
  §0.11): `criteria_from` closed vocabulary; report-binding
  uniqueness; the EXACTLY-ONE-MOUNT invariant (§3.3(b)); the injected
  engine report-verb catalogue with unknown-verb and kind/body-
  mismatch refusals (§3.5). Plus DIRECT test coverage for the
  already-existing ghost-target refusal (§0.8a — coverage, not new
  behavior).
- Live artifact evaluation NARROWED to the capture-ref form (§3.6).
- Move-3 choreography: differential beside → flip → delete + freeze.

## §2. Explicitly out

Auto-dispatch (`by`), isolation, watchdog bands, verbs, overlays,
panes (each its own move); scalar/human-gate EVALUATION machinery
(parsed shapes stay, first consumer pays); the artifact-existence
probe for path-form `requires` (waits with tenant 2, §3.6); any new
manifest vocabulary beyond the named refusals; report-body validation
beyond what evaluation itself reads (evidence_required is scalar's,
waits with scalar); q14's standing-entity/grants half; all
UI/routes/WS wire vocabulary; the edge table and the writer's
adjudication (legality, exhaustion, rejection eventing — all
untouched); InputLease/D81 build.

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

**3.1 — The evaluator is ENGINE, pure, and total.**
`core/src/extensions/acceptance.ts` exports one function: given a
node's `ParsedAcceptance` plus typed evidence (a filed report's body /
the instance's recorded captures) plus instance context (the criterion
ids), return `{ route: <node-id> } | { rest: true } |
{ unevaluable: <reason> }`. No clock, no IO, no filesystem, never
throws (rule 0.3). Kinds live: rubric, report, and artifact in its
capture-ref form (§3.6). The tenant's criterion MEANING stays tenant
content; the pass/fail derivation is engine because acceptance is kit
vocabulary (migration-map:99).

**3.2 — Rubric semantics move by REWRITE-equivalence, and
`criteria_from` refuses AT PARSE.** The rubric arm reproduces
`deriveReviewOutcome` row-for-row under the declared
`coverage`/`unlisted_ids` (both one-member vocabularies, §0.4).
`criteria_from` becomes a PARSE-TIME closed vocabulary of exactly one
value (`"instance.acceptanceCriteria"`) with a named refusal — the
value is manifest-known, so an unsupported one must fail before any
report is ever filed, not after (Sol P2b); negative + positive
controls. A lookup key, NOT a path language (new vocabulary is
§2-out). `reviewOutcome.ts` deletes at the flip, its test re-pointed
at the evaluator — the `core/src/tasks/` directory's first
per-declaration death (migration-map §(i)).

**3.3 — The report→node binding follows the declaration, and the
binding must be MOUNTED where it is declared.** A filed report
satisfies the acceptance of the node whose `acceptance.report` equals
the verb id, resolved from the SAME boot declaration the writer
adjudicates against (F2's one-boot-declaration law, S19 §3.3
precedent). Two parse-time invariants make the binding total:
**(a) uniqueness** — two nodes declaring the same report verb refuse;
**(b) the EXACTLY-ONE-MOUNT invariant (Sol round-1 P1a, tightened
round-2, SCOPED round-3)** — a CATALOGUE verb named in a LIVE-kind
(`rubric`/`report`) node's `acceptance.report` must be mounted on
EXACTLY that node's `briefing.tools` and NO other node's: the
declaring node must mount it (the split-manifest case refuses), and
no second node may mount it (the extra-mount case refuses — a session
at the extra node could file against a node it never attached to: a
silent no-op, and q14's property is "mounted only into the node that
declared it", migration-map:178). A DORMANT kind's non-catalogue verb
is EXEMPT from must-mount — it has no channel to mount, and S19's
preflight already fail-closes any attempt to mount an unknown id
(round-3 coherence fix: requiring a dormant verb mounted would refuse
the very manifests §3.5 declares parseable). The no-extra-mount half
still binds every CATALOGUE verb everywhere. Negative controls for
both directions plus the shipped-manifest positive control. *(Lean;
alternative — derive tool mounting FROM acceptance — rejected lean:
it would reopen S19's signed §3.6 seam, and `briefing.tools`
legitimately carries non-report tools.)*
ALL FOUR literal classes of §0.5 derive from the one resolved node
id — the reverse-lookup key, the attempt-count filter, the emitted
`node:`, and the plan envelope's `taskRef.stage` — identical bytes
today, one source tomorrow; a partial derivation is the internally
inconsistent identity Sol round-2 P1b names, and U3's deletion
inventory carries all four per path.
Capture binding: the captured artifact satisfies
`requires = ["capture:<name>"]` on the node that armed the capture
(declaration-keyed since S19 §3.7); the session's own node ref
supplies it, as today.

**3.4 — Targets come from the declaration, and UNSET means REST.**
`on_pass`/`on_fail` replace the three TARGET literals ('plan-ready',
'review', done/implementing — the targets alone; the identity-bearing
literals are §3.3's four-class inventory). A declaration that
leaves them unset gets NO proposal — the report/capture still records
(fact before consequence, the record* ordering contract), the node
rests, and something else proposes the move (node-kit §1.8.4 property
4: anything richer stays a proposal). The writer keeps everything it
owns today: legality, `max_traversals` exhaustion → manual-review,
evented rejections.

**3.5 — Scalar AND human-gate are both DORMANT, the catalogue's
refusal matrix is KIND-AWARE, and the catalogue has ONE home (Sol
round-2 P1c; round-3 P1a/P1b).** `report_filed` is a closed
review/completion union (§0.11), so a scalar declaration could only
ever file a MIS-SHAPED body through a borrowed verb, violating
node-kit property 2. Rev 3's blanket unknown-verb refusal
over-corrected: scalar's `report` key is REQUIRED
(manifest.ts:1799–1801), so refusing every unknown verb made scalar
syntactically unparseable while §3.5 claimed it parses — a
contradiction Sol round-3 P1a caught. The rule is KIND-AWARE:

  • **LIVE kinds (`rubric`, `report`)**: `acceptance.report` MUST
    name a catalogue verb the kind is COMPATIBLE with — and
    compatibility is ASYMMETRIC (Sol round-4): `rubric` DERIVES from
    contents, so it requires a criteria-capable body
    (`report_review`); `report` is EXISTENCE-ONLY — node-kit
    §1.8.4 (e), "a valid report of the declared kind was filed; no
    verdict is derived from its contents", the degenerate case of
    rubric (node-kit.md:511) — so it accepts ANY catalogue report
    body (the tool's own schema validates the body; acceptance
    deliberately ignores it). Unknown verb, or `rubric` on a
    non-criteria body, refuses at parse.
  • **A kind naming a CATALOGUE verb it is INCOMPATIBLE with** (a
    scalar borrowing either current body): refuses at parse — the
    borrowed-verb mis-shape is the thing being prevented, and no
    current body carries dimensions.
  • **A DORMANT kind (`scalar`) naming a catalogue-UNKNOWN verb**:
    PARSES, dormant — its verb has no channel (the closed union) and
    can never mount (S19 preflight fail-closes unknown ids), so
    dormancy is enforced by construction, not by prose.

Both dormant kinds parse (the kit's §1.8.4 admits them as vocabulary;
refusing the KIND outright would make the parser lie about the kit),
their evaluator arms exist (exhaustive switch, typed `unevaluable`)
and are unit-tested PURE, and the runtime claim for both is an
ABSENCE assertion (no invocation path), never a fabricated runtime
cell. The generic filing path and the scalar schema arrive with their
first consumer (tenant 2, rule 0.5).

**The catalogue's single source (round-3 P1b):** the constant
RE-HOMES from `briefingDeclarations.ts:121–130` to core (beside the
body schemas it maps to, which already live in core — events.ts /
workOrder.ts), gaining the `{ verbId → body kind }` mapping; the
daemon RE-EXPORTS it (imports from core, its S19 "one place" comment
re-pointed, its A2 host differential UNCHANGED and still green — the
machine check now guards the relocated constant). Parser default,
preflight validation, and the host differential all read the ONE
constant; a second spelling anywhere is the drift S19's comment
forbids. *(Leans; alternatives — activation-time validation instead
of parse-time (loses the earliest-refusal property for live kinds);
a generic report channel this slice (a new event body with no live
consumer, exactly what 0.5 defers) — both rejected.)*

**3.6 — Live artifact evaluation is the CAPTURE-REF form, narrowed
explicitly (Sol P1b).** The kit's (d) admits multiple `requires`
entries and ordinary paths (node-kit.md:503); a pure evaluator cannot
probe path existence. Live: a `requires` list whose EVERY entry is
`capture:<name>` evaluates against the instance's recorded captures —
ALL present → `on_pass`; SOME missing → **REST** (Sol round-2 P2:
absent evidence is not failure, the node awaits its remaining
captures; a declared `on_fail` on an artifact table is LEGAL BUT
INERT at Tier 1 — nothing produces negative existence evidence — and
that inertness is STATED and unit-tested, not left undefined, even
though v1's one-entry catalogue makes the partial case degenerate).
v1's catalogue has one entry, so the shipped `["capture:plan"]` is
the whole live domain. ANY path-form entry → typed `unevaluable`
(the capture records, nothing routes, one warning); the existence
probe waits for its first consumer (rule 0.5, §2-out). The narrowing is
STATED here rather than discovered later — the kit's honesty-line
style (node-kit §1.8.3).

**3.7 — Move-3 choreography.** Declared routing built BESIDE compiled;
the differential drives BOTH paths over the outcome matrix — review:
any-fail / coverage-miss / all-pass / extra-id-ignored / bare-task;
completion: valid worklog; plan: capture — and asserts identical
proposals AND identical emitted payloads (the full D46 identity tuple:
node, attempt, payloadRev). At the flip the `deriveReviewOutcome` call and every occurrence in
§0.5's four-class inventory delete — the checked-off U3 inventory,
so the differential can never be read more narrowly than the
deletion; the differential freezes against the deleted code's image
(Move-3/S19 precedent).

## §4. Assertions (S20-A#)

- **A1** Inherited instruments untouched: 37/37 briefing goldens
  byte-identical; S19 frozen differential green; S18-F4 stem test
  green; boundary checker clean; ext-host surface.json unchanged
  (or STOP — it is signed).
- **A2** The differential: declared ≡ compiled over the §3.7 outcome
  matrix — proposals, event payloads, AND the plan path's
  artifact-envelope identity (`taskRef.stage`, rev, kind — §0.5(d))
  — frozen at the flip.
- **A3** The declaration GOVERNS (perturbation, S19's lesson that a
  correlated manifest proves nothing): a perturbed copy with
  `on_pass`/`on_fail` pointed at a DIFFERENT legal node routes per
  the perturbation, not the deleted literals. Ghost-target refusal is
  BASELINE (manifest.ts:2196–2221) — asserted by NEW DIRECT negative
  controls (`on_pass`, `on_fail`, `on_answer` each naming a non-node
  → `unknown-node-reference`), closing §0.8a's coverage gap without
  claiming new behavior.
- **A4** Rest, dormant, unevaluable (§3.5/§3.6): unset `on_pass` →
  report files, no proposal; unset `on_fail` on a FAILING rubric →
  report files, no proposal (rest — the complement cell, Sol round
  3); a partially satisfied capture-ref list →
  REST, and artifact `on_fail` provably inert (the degenerate-today
  unit, §3.6); a path-form artifact `requires` → capture records,
  typed unevaluable, no proposal, exactly one warning; scalar AND
  human-gate → pure arms unit-tested + the ABSENCE assertion (no
  runtime invocation path — no channel exists post-§3.5), never a
  fabricated runtime cell.
- **A5** Binding invariants (§3.3/§3.5): the same-verb-on-two-nodes
  manifest refuses at parse; the split-manifest (verb mounted on node
  X, acceptance declared on node Y) refuses at parse; the EXTRA-MOUNT
  manifest (declared+mounted on Y, ALSO mounted on X) refuses at
  parse; a LIVE kind naming an unknown verb, a `rubric`
  on a non-criteria body (`report_completion`), and a scalar
  borrowing either current body each refuse at parse; a `report`
  naming `report_review` PARSES (existence-only compatibility, the
  asymmetry's positive control); a scalar naming a catalogue-unknown
  verb PARSES (the dormancy-preserving cell, §3.5); the shipped manifest parses
  as the positive control; a
  report verb no node declares → total runtime no-op (the guard
  preserved, not dissolved — it still guards spurious calls).
- **A6** `criteria_from` (§3.2): unsupported value refuses at parse
  (negative control) and the shipped value parses (positive control).
- **A7** Suite green ×2, zero behavioral pins changed, Move-0 fixture
  untouched, all prior slice assertions green (rule 0.4).

## §5. Units (sequential; skeleton → Sol → ⟨Wes⟩ signs → dispatch)

- **U1 (opus):** the evaluator (§3.1/3.2/3.6, pure, with the
  deriveReviewOutcome equivalence suite run against BOTH while both
  are alive) + the parse-time refusals (§3.2 criteria_from, §3.3
  uniqueness + exactly-one-mount, §3.5 kind-aware catalogue rules) +
  the catalogue re-home core←daemon (§3.5 — daemon re-exports, S19
  host differential stays green as the guard) + the §0.8a direct
  ghost-target controls + the
  acceptance read on the declaration seam (briefingDeclarations.ts
  sibling or extension — same injected-workflow law). No dispatcher
  change.
- **U2 (opus):** declaration path BESIDE compiled in the three
  record* methods + A2 differential + A3 perturbations + A4/A5
  runtime cells. Nothing flips.
- **U3 (sonnet):** the flip — the derive call deleted plus ALL FOUR
  literal classes per path (§0.5: lookup key, attempt filter, emitted
  `node:`, plan envelope `taskRef.stage` — a checked-off inventory,
  not a sweep); `reviewOutcome.ts` deleted, test re-pointed;
  differential frozen; A1 re-run live.
- Fixes to NEW agents; one at a time; checkpoints to the session
  scratchpad's FULL path (S18 lesson).

## §6. Gates, kill criterion, deploy

**Exit gate (machine):** suite ×2, ci-gate all profiles, A1–A7
evidence per assertion, checker clean. No human gate.

**Kill criterion:** an outcome-routing fact with no declaration home
that is not degenerate; any declared table unable to reproduce
compiled routing exactly (proposal or payload); or a binding
ambiguity the two §3.3 invariants cannot resolve without new manifest
vocabulary. Each → STOP, back to the pass (rule 0.1).

**Deploy note:** daemon + core (+ parser) change ⇒ restart at close;
standing clearance applies (dev-phase ruling 2026-08-12).

## §7. Outside-review triage record (Sol)

*(Method note, ⟨Wes⟩ 2026-08-26: Sol is deliberately context-cleared
before every round — it reasons from docs + repo alone with no memory
of prior rounds or of the orchestrator's session, while the
orchestrator carries full session context and memory. The instruments
fail differently on purpose; running both against each rev is the
point.)*

**Round 1 (2026-08-26, against rev 1 at `dc3ef53`): five findings,
five CONFIRMED, verdict redpen — rev 2 is the rebuild.**

- **P0 — "on_pass/on_fail not validated" was a RECON ERROR.**
  Validation exists at manifest.ts:2196–2221 (on_pass/on_fail/
  on_answer, `unknown-node-reference`). Rev 1's §0.8 claimed absence
  from a `head`-truncated grep — the exact one-sided-probe failure
  the house rule names ("assert absence as well as presence; one
  probe is not a refutation"). Scope replaced with the genuinely
  missing DIRECT test coverage (§0.8a, A3) and the genuinely missing
  `criteria_from` validation (§0.8b, §3.2).
- **P1a — report-mount invariant missing: CONFIRMED** (only
  briefing/acceptance cross-check is `plan-mode-with-tools`, :2315).
  → §3.3(b), A5; parse-refusal lean over derive-mounting (would
  reopen S19's signed seam).
- **P1b — artifact contract wider than one capture: CONFIRMED**
  (node-kit.md:503 admits multiple/path `requires`). → §3.6 narrows
  live evaluation to the capture-ref form; path-form unevaluable;
  probe waits for its consumer.
- **P2a — human-gate "report still files" unreachable: CONFIRMED**
  (no report verb binds; answer surface §2-out). → §3.5 splits
  scalar (unsupported-reachable) from human-gate (dormant, absence
  assertion).
- **P2b — criteria_from refusal timing: CONFIRMED** (bare readString
  :1773–1779). → §3.2 parse-time, named refusal, A6 controls.

**Round 2 (2026-08-26, against rev 2): four findings, four CONFIRMED,
verdict redpen — rev 3 is the rebuild.**

- **P1a′ — mount invariant one-way: CONFIRMED.** Rev 2 required the
  declaring node to mount its verb but let OTHER nodes mount it too
  (silent no-op from the extra node; q14's property is exclusive
  mounting, migration-map:178). → §3.3(b) exactly-one-mount, both
  negative controls in A5.
- **P1b′ — deletion inventory incomplete: CONFIRMED.** The
  attempt-count filters (:916/:1005/:1104) and the plan envelope's
  `taskRef.stage` (:926) are two more literal classes; a partial
  derivation could emit `attempt: 0` against a positive-int schema
  (events.ts:1411). → §0.5 four-class inventory, §3.3 one-source
  rule, U3 checked-off inventory, A2 envelope identity.
- **P1c′ — scalar not genuinely reachable: CONFIRMED.**
  `report_filed` is a closed review/completion union
  (events.ts:1407–1424); rev 2's "scalar report files then
  unevaluable" would file a mis-shaped body through a borrowed verb,
  violating node-kit property 2. → §3.5: scalar joins human-gate as
  DORMANT; the injected report-verb catalogue (ParseManifestOptions
  idiom, §0.12) parse-refuses unknown-verb and kind/body-mismatch
  bindings; the generic filing path waits for tenant 2 (rule 0.5).
- **P2′ — unsatisfied capture set undefined: CONFIRMED.** Rev 2 gave
  all-present and path-form but not the partial case. → §3.6:
  SOME-missing → REST (absent evidence is not failure); artifact
  `on_fail` stated as legal-but-inert with its own degenerate-today
  unit (A4).

**Round 3 (2026-08-26, against rev 3): three findings, three
CONFIRMED, plus one added test cell — rev 4 is the rebuild.**

- **P1a″ — catalogue made scalar unparseable: CONFIRMED.** Scalar's
  `report` key is REQUIRED (manifest.ts:1799–1801), so rev 3's
  blanket unknown-verb refusal contradicted its own dormant-
  vocabulary claim. → §3.5's kind-aware matrix: live kinds require a
  matched catalogue verb; any kind mismatching a catalogue verb
  refuses; a dormant kind's catalogue-unknown verb parses (dormancy
  by construction — no channel, unmountable). §3.3(b)'s must-mount
  half scoped to live kinds for the same coherence.
- **P1b″ — catalogue single source unstated: CONFIRMED.**
  `ENGINE_REPORT_TOOL_NAMES`/`_IDS` already live in
  briefingDeclarations.ts:121–130 under S19's documented "one place"
  contract with a machine-check differential. → §3.5 re-homes the
  constant to core (beside the body schemas it maps), daemon
  re-exports, differential unchanged as the guard; parser/preflight/
  host all read one constant.
- **P2″ — stale "three literals" statements: CONFIRMED** (§1 scope
  and §3.7 still said "three" after §0.5/U3 went to the four-class
  inventory). → both re-pointed at the checked inventory.
- **Addition:** A4 gains the unset-`on_fail`-on-failing-rubric →
  rest cell, complementing unset-`on_pass`.

**Round 4 (2026-08-26, against rev 4): one finding, CONFIRMED —
rev 5 is the (surgical) rebuild. Everything else declared coherent.**

- **P1‴ — `report` over-restricted to the completion body:
  CONFIRMED.** Node-kit §1.8.4 (e) defines `kind = "report"` as
  EXISTENCE of a schema-valid report of the declared verb, contents
  ignored — rubric's degenerate case (node-kit.md:511) — so
  `report` + `report_review` is safe and legal; rev 4's symmetric
  verb↔kind mapping wrongly refused it. → §3.5's compatibility is
  now ASYMMETRIC (rubric needs a criteria-capable body; report
  accepts any catalogue body; scalar borrows nothing), and A5 gains
  the `report`-naming-`report_review` positive control alongside the
  retained scalar mismatch refusals.
