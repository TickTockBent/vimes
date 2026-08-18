# Slice 13 — the alias tail: one vocabulary on the wire

**Status: CLOSED, 2026-08-12 — all five units built, gated, committed, and
deployed IN ONE DAY (signature → deploy #2 same day); human gate PASSED
same day, and the Move-3 live oracle FIRED on unstaged real traffic.**

> **HUMAN GATE (2026-08-12, ~14:57).** Better than the staged version: an
> EXTERNAL orchestrator (Johnny's) created instance
> `c731f61a-387b-4d15-8cf0-8aededb5ec1e` through the generic route — live
> proof external callers work post-U4, alias-dead — and Wes moved it
> backlog→planning from the board. Readonly-DB verification (tasks stream):
> seq 112 `instance_created` (createdBy orchestrator, node backlog, workflow
> ref `vimes-tasks/software/1.0.0` recorded); **seq 113 `instance_moved`**
> (fromNode backlog, toNode planning, `proposedBy:"human"` — the F1 origin-
> attribution rider live — `manualReviewRequired:false`, no reason field on
> the accepted path): **the first real declaration adjudication in
> production**; seq 114 `instance_run_attached` (dispatcher fired downstream,
> session attached in planning). Create → adjudicate → record → dispatch,
> end to end, on traffic this session did not stage.

> **CLOSE BLOCK (2026-08-12).** Units: U1 `f5564b0` (reason split, two
> channels, provenance-guaranteed) → U2 `99fb575` (q25 ref-keyed
> introspection, immutable-cached) → **U2b `dbcca0e`** (added mid-slice:
> `GET /api/workflows` discovery index — recon found the ref-keyed routes
> had no discovery half, a §2 capability regression at zero instances) →
> U3 `12ab202` (UI speaks generic: 7 families, instances shape, sentence
> map carries both spelling families forever, manual-review exclusion moved
> client-side with a named guard) → U4 `28b335a` (alias death; q24 CLOSED).
> Deploy #1 (restart, 09:56) put U1+U2+U2b live under the legacy UI;
> deploy #2 (ci-gate ships generic UI 10:46, restart 10:47) closed the
> window. Suite 3254 green (agent ran it twice byte-consistently; ci-gate's
> scenario double-runs byte-identical); every unit gated with diff-read +
> census-0 + my own suite run + sabotage-verify (six sabotages total, every
> guard bit its own line).
>
> **Conditionals resolved honestly at U4:** `legacyTasksViewOf` and
> `readTasksAsLegacyView` SURVIVE with one consumer — the writer-side
> `readTasks` path (4 takers), which slice-11's "exactly two consumers"
> header had bundled into the alias-route accounting. Death trigger now
> Move 4, named in both headers. S13-A7 succession: the replay test pins
> the instances serialization against a NEW third frozen file
> (`tasks-state-instances.json`); both original frozen files
> byte-untouched. (An inline-literal pin was tried first per the S12·U3
> precedent and REJECTED because the fixture's historical payload content
> contains the dead route substring — data tripping the A5 grep gate.
> Fixture files live outside the gate's scanned paths; that is why.)
>
> **FINDING, recorded not patched (rule 0.1):** S11-A4's "the alias set
> and its generic twins are ONE handler and cannot answer differently" was
> FALSE for exactly one case its parity suite never exercised: a REAL
> dispatch-triggering move. The alias envelope carried the writer's return
> (frozen before dispatch, never showing the new session); the generic
> envelope re-reads the projection and shows the attached session. The
> parity suite compared the surfaces only under a faked dispatchResult.
> Pre-existing, discovered by U4's test migration; the divergent surface is
> now DELETED and the surviving behavior is the designed I12 posture (the
> record a client receives is the record the log produced). No live
> consequence; noted here as the honest correction to S11-A4's claim.
> Lesson for future parity proofs: parity under fakes is parity of the
> fakes — at least one real-path case per surface pair.
>
> Loose ends leaving this slice: the accepted cosmetic ordering delta
> (move-sheet buttons follow declaration order now); TaskBoardView.vue's
> pre-existing stale "Every stage is offered." copy (pre-2026-07-24,
> already false, left because visible copy is a rendering change — D70-face
> era fixes it); D84 queued (the gate's deploy side effect); D73 still open
> (drift now .224 vs .228 — FOUR bumps in six days).
Orchestrator-authored. Closes the migration's tail: **q24** (the alias window)
and **q25** (declaration introspection), plus the reason-vocabulary
generalisation that slice 12 explicitly deferred to "the alias-death deploy."

> **This slice is INVISIBLE to the operator by design.** The screens look the
> same afterward. Its value is that it retires the last place where two
> spellings of one fact are live at once, and it unblocks the D70 face — which
> is a separate design pass and its own later slices. Nobody should expect a
> usability change from this slice; expecting one is how it gets judged a
> disappointment for succeeding.

---

## §0. What recon found (2026-08-11, before any code was written)

Five facts reshaped this from "swap 22 URLs" into a four-unit slice. They are
recorded because each one is a place the naive version would have failed.

1. **Two routes have NO generic twin.** `GET /api/tasks/stage-edges` and
   `GET /api/tasks/work-order-schema` moved *verbatim* in Move 2, old paths
   only. `instanceApi.ts`'s own header says why: generalising them is q25
   declaration introspection, which "needs pinned workflow/node declarations to
   introspect — Move 3+, not here." **Move 3 shipped 2026-08-10, so that
   precondition is now met** — but the endpoints do not exist. The UI switch is
   *blocked* on building them. This is why q25 is in this slice and not a later
   one.
2. **A SEVENTH route family was missed in the first count.**
   `/api/projections/tasks` (4 UI call sites) does not match a grep for
   `api/tasks`. Real scope is **26 call sites across 7 families**, not 22
   across 6.
3. **That seventh family is not a URL alias — it is a SHAPE alias.** It is
   served by `legacyTasksViewOf`, a pure derivation reconstructing the old
   `projections/tasks.ts` fold from instances state. So the UI does not just
   change a path; **it learns a new record shape.** That is the largest single
   piece of work in the slice and the reason U3 is not mechanical.
4. **`legacyTasksViewOf` is a deliberate NARROWING, and the dropped fields are
   the point.** It hides `nodeHistory`, `edgeTraversalCounts`, `attemptsPerNode`
   and `workflow` because a legacy view that leaked new fields would change the
   bytes the frozen fixture pins. **Consequence: switching the UI off it is an
   UNLOCK, not just a migration** — four fields the board has never been able to
   see become available, including Move 3's pinned `workflow` ref. Surfacing
   them is explicitly NOT this slice (see §2); this slice only stops hiding them.
5. **The legacy view cannot survive tenant #2, and it says so in its own
   comments.** Its two `as TaskStage` casts are sound only for instances whose
   stage the compiled task enum already validated; an instance on a node outside
   that enum "is by definition unable to be described" by it. So the alias is
   not merely untidy — it is a **forcing function with a deadline set by Book
   Genesis.**

**A sixth fact, found on the write path and already anticipated in code.** The
engine validates every refusal reason through `transitionRejectionReasonSchema`
— a **closed enum that contains a tenant's string** (`quarantined-cannot-complete`)
alongside four generic-but-tenant-spelled ones (`unknown-stage`, `same-stage`,
`terminal-stage`, `illegal-edge`). Post-Move-3, forbidden rows carry *declared*
reasons, so **a second tenant declaring any novel forbidden reason throws on
parse.** `instanceWriter.ts:395-403` names this exactly ("a NOVEL declared
reason arriving here before the vocabulary generalises is a DISAGREEMENT… it
SHOULD throw loudly") and schedules the fix for "the alias-death deploy" — i.e.
this slice. It is not a new discovery; it is a scheduled debt coming due.

---

## §1. Scope

1. **U1 — the reason vocabulary generalises** (core + daemon). Engine reasons
   become node-spelled and closed; *declared* reasons become an open pass-through
   channel, so a tenant's forbidden-row string reaches the record without the
   engine enumerating it.
2. **U2 — q25 declaration-introspection endpoints** (daemon). Generic twins for
   `stage-edges` and `work-order-schema`, serving the pinned workflow
   declaration and the payload schema.

   > **U2b, added 2026-08-12 at U3 recon (orchestrator finding).** The ref-keyed
   > endpoints have no DISCOVERY half: at zero instances a client holds no ref
   > to key them with, so after U4 kills the legacy routes, a fresh client on an
   > empty board could not render its create sheet — a capability REGRESSION,
   > which §2 forbids more strongly than it forbids additions. Fix is the index
   > route `GET /api/workflows` → `{ workflows: [{ ref }] }` — the declarations
   > this daemon resolves, today exactly the boot ref. No cache header (the SET
   > changes across deploys — only the per-ref responses are immutable). No
   > tenant opinion involved (kill criterion 2 untouched); the array shape is
   > the rule-0.5 reservation for the multi-workflow future. Must ride DEPLOY
   > #1 with U2 — caught before that deploy happened, so no extra deploy owed.
3. **U3 — the UI speaks generic** (UI). All 26 call sites across 7 families;
   adopt the instances record shape in place of the legacy narrowing; consume
   U2's endpoints.
4. **U4 — alias death** (daemon + core). Delete the four write aliases, the two
   read aliases, `/api/projections/tasks`, `legacyTasksView.ts`, and
   `WIRE_STAGE_EDGE_ORDER` (whose documented lifespan is "dies with q25's
   generic twin"). q24 closes here.

## §2. Explicitly out

- **The D70 face.** Tree home surface, panel restructure, per-client grammar,
  extension surfaces, meters-as-chrome. That is the design pass running in
  parallel and its own later slices. **No screen gains a new capability here.**
- **Surfacing the four unlocked fields** (`nodeHistory`, `edgeTraversalCounts`,
  `attemptsPerNode`, `workflow`). U3 stops hiding them; rendering them is a
  later unit with its own design. A board that grows new columns in this slice
  has failed §2.
- **Move 4** (`packages/ext-tasks/` + the mechanical import boundary).
  Independent of the alias tail; do not entangle them.
- **Tenant 2 / Book Genesis.** U1 makes a novel declared reason *possible*;
  proving it with a second tenant is not this slice.
- **The WS op vocabulary** and every session/terminal route. Untouched.
- **Retiring `manualReviewRequired`** (F1 of slice 12 — bounded-loop activation,
  its own D-record) and the transitional vocabulary module's other tenant
  spellings beyond the reason enum.

## §3. Decisions needing Wes's signature (F1–F5)

**F1 — The reason vocabulary splits into two channels, not one wider enum.**
Engine-owned refusals stay a closed enum, respelled node-generic
(`unknown-node`, `same-node`, `terminal-node`, `illegal-edge`); tenant-declared
refusals become an open string channel the engine passes through and records
without enumerating. *Rationale:* one wider enum would require the engine to
know every tenant's refusal strings forever — a #16 violation that grows with
each tenant. *Alternative rejected:* keep the closed enum and require tenants to
choose from it, which makes the engine the author of the tenant's prose.
**Wire-visible: yes** (the recorded `reason` and the 409 body change spelling).

> **⟨signed 2026-08-12, strengthened⟩ — open to tenants, closed per workflow.**
> Not "open string the engine passes through": a runtime-invented reason would
> be unvalidatable, unlocalizable, unrenderable. The declared channel is
> **bounded by the declaration** — the manifest declares the refusal reasons a
> workflow may emit, and the engine still enumerates nothing. Recon finding
> R1: **this is already the architecture, by provenance rather than
> validation** — the manifest's forbidden rows carry a required `reason` string
> (node-kit §1.4.4, `ParsedForbiddenEdge`), and the refusal reason NEVER
> arrives from the caller: `adjudicateAgainstDeclaration` produces it from
> either the engine's own vocabulary or the pinned declaration's forbidden
> row. An agent cannot invent a reason mid-run because no caller-supplied
> string ever reaches the record. Consequently U1 adds **no** record-time
> membership check (that would re-derive adjudication, which the writer
> explicitly delegates); the static "was this reason declared" check belongs
> to the validator work stream (vimes doctor), where HA's
> declaration-is-under-test discipline already places it.
> **Rider 1 (origin attribution): free by join.** `instance_move_rejected`
> carries `instanceId`; Move 3 pins `extension`/`workflow`/`rev` on every
> instance at creation — two tenants emitting the same string are
> distinguishable in the log through the instance. No payload change
> (principle 9: the ref is a fact of the instance, not of the move). Nuance
> recorded: the join names the instance's pinned rev while the reason was
> authored by the BOOT declaration's row; exact-rev attribution rides the
> widened-view item already parked in `instanceWriter.ts`'s F2 comment.
> **Rider 2 (historical readers): one exists and it is already safe.** The
> complete reader inventory for reason strings is (a) the writer's schema
> parse — the thing U1 changes — and (b) the UI sentence maps in
> `taskBoard.ts`, whose `describeRejectionReason` was built with an explicit
> unknown-reason fallback ("a reason added to core after this UI shipped must
> NOT produce an empty error"). No projection folds on reason content
> (verified by grep). The q21-style permanent read-side treatment is
> therefore cheap and lands in U3: **add** the node-spelled entries, **keep**
> the legacy-spelled entries forever — old spellings persist in the log, and
> the sentence-map rows are their permanent read-side alias (assertion A9).

**F2 — `quarantined-cannot-complete` stays exactly as spelled, and moves
channels.** It is *tenant content* declared in the manifest's forbidden row, not
engine vocabulary — so it is not respelled, it simply stops being an enum member
and becomes a declared string. **Consequence that matters: the shipped manifest
asset and the frozen migration fixture are NOT touched, no agreement tripwire
fires, and no dated amendment is owed.** Respelling it *would* diverge the
shipped manifest from the frozen fixture and cost an amendment for no gain.

> **⟨signed 2026-08-12⟩ — the classification test, made explicit and
> reusable:** the move that saves the amendment is the *classification*, not
> the spelling. The test for the next borderline item: **would a different
> tenant plausibly declare a different string in this row?** Yes → tenant
> content → don't respell. (Recon finding R4: F1's strengthened form costs F2
> nothing — the manifest schema already requires `reason` on every forbidden
> row, and `quarantined-cannot-complete` is already declared content there.
> No schema addition, no manifest edit, no fixture touch.)
> **The mixed log is CORRECT, permanently.** After F1+F2 the log contains
> legacy-spelled engine reasons (history), node-spelled engine reasons (new),
> and tenant-spelled task-flavoured declared reasons — side by side, forever.
> This inconsistency is the *designed outcome*, not an incomplete migration.
> Recorded here so a future reader — or an agent doing cleanup — does not
> "fix" it. History is never rewritten (q21).

**F3 — q25's endpoints are workflow-keyed, not instance-keyed.** A route serving
the pinned workflow declaration and a route serving the payload schema, both
addressed by the declaration's identity (`extension`/`workflow`/`rev` — the ref
Move 3 already stamps on every instance), not by an instance id. *Rationale:*
q25's stated purpose is that "both clients need the generic form to render an
extension they have never seen," which is a property of the *declaration*, not
of one instance. Instance-keyed would make N identical reads for N instances of
one workflow and would tie introspection to instance lifetime.

> **⟨signed 2026-08-12⟩ — two properties to exploit, one dependency to name.**
> (1) A response keyed by `extension`/`workflow`/`rev` is **immutable for that
> key** → serve with immutable cache headers; clients may cache across
> sessions. This matters most on the phone over the tunnel. (2) Clients
> **dedupe fetches by ref**: N instances of M workflows means M declaration
> fetches, never N (U3's work order carries this). (3) **F3 is the mechanism
> D76 depends on** — the unknown-workflow generic fallback works precisely
> because a client can fetch a declaration by ref and render from it alone;
> instance-keyed introspection would make D76's rendering do N reads to
> answer one question about a workflow. Linked in both records.

**F4 — U3 adopts the instances shape and swaps the URLs in ONE unit.**
*Rationale:* `/api/projections/tasks` **is** the board's data source, so a split
leaves the board reading the legacy shape from one route and generic records
from another simultaneously — two shapes live in one component, which is the
coexistence hazard this whole slice exists to end. **Cost accepted:** U3 is the
biggest unit in the slice and the only one touching `.vue` files (so it carries
the `vue-tsc` gate, per the CLAUDE.md gotcha).

> **⟨signed 2026-08-12⟩ — a command-kind acceptance criterion, because the
> characteristic failure of a shape migration is partial completion that
> looks complete.** Some call sites swapped, others not, page renders fine —
> decidable by grep, not judgment. U3's acceptance is therefore
> **command-shaped**: (a) no legacy URL string anywhere in `packages/ui/src`
> (assertion A6, run at the U3 gate, not deferred to U4); (b) **no legacy
> shape field referenced** — a grep list of the legacy-view field names that
> must be extinct (`stage` as the record's shape-level key where the generic
> shape spells it otherwise, and every field the mapping table renames; the
> exact list lives in the work order's shape map). Second rider: **U3 is the
> likeliest unit to bounce, so its work order carries the legacy→instances
> shape mapping EXPLICITLY** — a fresh fixer under D46 must not re-derive the
> migration from the diff.

**F5 — Two deploys, in a fixed order, and the order is a correctness
constraint.** U1+U2 land and **deploy (daemon restart)** BEFORE U3's gate runs.
*Rationale, and this is the D37-class trap:* `scripts/ci-gate.sh` ships
`packages/ui/dist` as a side effect, and that directory is what the live daemon
serves. So **gating U3 deploys the new UI whether or not we intend it** — and a
UI asking for endpoints an un-restarted daemon does not serve is exactly the
failure that once rendered an honest-looking empty state over 23k rows of real
data. U4 then deploys second, closing the aliases under a UI that no longer
needs them. **The alias window is what makes this survivable, which is the
whole reason q24 created it.**

> **⟨signed 2026-08-12⟩ — ordering is the fix for THIS slice; the defect is
> durable and now has its own record.** The gate has a deploy side effect
> that is not part of gating, and the trap re-arms on every future slice
> where UI and daemon change together — in the UI era, most of them. Queued
> as **D84** (open-questions): lean is a declared **API-version floor on the
> UI bundle, checked by the daemon on serve** — a loud mismatch banner
> instead of a silent wrong render (the version-floor discipline from the
> extension decomps, applied one layer out; the AoE context-reset instinct).
> Known accepted window inside this slice: between DEPLOY #1 and U3's gate,
> the live UI's sentence map does not yet know the node spellings, so an
> engine refusal renders the map's honest fallback sentence — degraded
> prose, never a wrong render, and refusals are operator-rare.

## §4. Assertions

- **S13-A1** — the engine reason enum contains no node names and no tenant
  strings; declared reasons round-trip verbatim through refusal → record →
  read model, including a reason string that appears nowhere in engine source.
- **S13-A2** — a novel declared forbidden reason (one not in any enum) is
  recorded without throwing. *This is the assertion that would have failed
  before this slice*, and it is the one to write first.
- **S13-A3** — q25's declaration endpoint serves the same edge membership the
  adjudicator reads, for the pinned rev; a divergence is a finding, never a
  reconciliation.
- **S13-A4** — the q25 payload-schema endpoint serves the same schema the
  create door validates against (one source of record, principle 9).
- **S13-A5** — no `/api/tasks/*`, no `/api/projections/tasks`, and no
  `legacyTasksView` reference survives anywhere in `packages/daemon` or
  `packages/core` (grep gate, comments included, the S12·U3 pattern).
- **S13-A6** — no `api/tasks` or `api/projections/tasks` string survives in
  `packages/ui/src` (grep gate).
- **S13-A7** — the frozen migration fixture still replays byte-identically, and
  the fixture test now pins the **instances** serialization (the planned
  succession recorded in `legacyTasksView.ts`'s header).
- **S13-A8** — prior assertions green: S12-A1…A6, S11's, S10's (rule 0.4).
- **S13-A9** *(added at signature, F1 rider 2)* — `describeRejectionReason`
  renders a plain-words sentence for BOTH spelling families — the legacy
  engine spellings (which persist in the log forever) and the node-generic
  ones — and its engineered fallback still catches an arbitrary unknown
  string. The legacy sentence-map rows are the q21-style permanent read-side
  alias; deleting them is a regression, not a cleanup.

## §5. Exit gate (machine, plus one human confirmation)

Machine: A1–A8 green; full suite green **twice, byte-identically**; both grep
gates empty; fixture replay green. Human: after the U4 deploy, Wes loads the
board and confirms it renders and moves a task correctly — which **also fires
the still-outstanding Move-3 live oracle** (verified 2026-08-11: zero
task/instance events in production since the Move-3 deploy, so no real move has
yet been adjudicated against the declaration).

## §6. Kill criteria

1. **The instances record shape cannot serve the board without new fields.** If
   U3 finds the generic shape is missing something the legacy view supplied,
   that is a finding about q13's signed core/payload split — halt, decision
   record, do not widen the shape mid-unit.
2. **q25's declaration endpoint cannot be served without the engine holding a
   tenant opinion.** If introspection needs the engine to know what a "stage" is
   in order to describe it, the carve-out test is failing and the endpoint shape
   is wrong — halt rather than special-case.
3. **The reason split forces a payload-schema migration.** If open declared
   reasons cannot be recorded without rewriting historical events, stop: history
   is never rewritten (open question 21).

## §7. Build order

Skeleton (done) → **F1–F5 signature (Wes — ✅ 2026-08-12, refinements
inline above)** → U1 → gate → U2 → gate →
**DEPLOY #1 (daemon restart, U1+U2 live)** → U3 → gate (incl. `vue-tsc`) →
U4 → gate → **DEPLOY #2 (aliases die)** → close block.

One agent per unit, sequential, opus for U1/U3 (vocabulary and shape work are
subtle), sonnet viable for U2/U4 if their skeletons are exact. Control-byte
census on every touched file at every gate.
