# Slice 9 — the signing packet (S9·6)

**Assembled overnight 2026-08-05→06 (the night shift). For Wes, over coffee.**
Everything below is proposed; nothing builds until you sign. Contest anything —
a rejection with rationale is an exit gate too (slice-9.md).

The night ran under the four rules you set: local commits only (nothing
pushed), stop-on-finding, nothing user-visible (no deploy, no ci-gate, no
pings), TOML. All four held. The kill criterion was tested and **not tripped**.

---

## 0. The one-screen summary

Four design docs and one schema reservation landed, each gated and committed
separately:

| Unit | Deliverable | Commit | Gate result |
|---|---|---|---|
| N1 (S9·2) | `extension-model.md` §1–4 — D66 + the manifest | `6dc943f` | passed after 1 fix (deprecated-event subscription) |
| N2 (S9·3) | `extension-model.md` §5 — D67 + capabilities + confinement | `cb0b164` | passed clean |
| N3 (S9·4) | `node-kit.md` — the kit + BOTH tenant mappings | `a12e9fe` | **kill criterion NOT tripped**; passed after 2 fixes (wildcard semantics) |
| N4 (S9·5) | `migration-map.md` — map + seam-first + client contract | `a23386b` | passed clean |
| N5 | tree-spine schema reservation (`packages/core`) | *(see §6)* | *(see §6)* |

**What you are signing, in one sentence each — details in §1–§5:**

1. **D66**: two tiers, one vocabulary — in-process first-party modules and
   external processes declare the SAME manifest; Tier 1 is a placement
   optimization, never a privileged vocabulary.
2. **D67**: v1 is first-party-only, but the grant machinery (hash-pinned
   grants, unknown-capability reject, re-approval on widening, lockfile) is
   built day one.
3. **The verdict**: the node kit hosts both tenants with zero engine
   carve-outs — ten named bends, no breaks.
4. **Seam-first migration**, because it is the only order in which the
   recorded behaviour stays a test.
5. **The E1–E3 settlements** you walked on 2026-08-05, now ready to become
   D-records, plus **D62** (the ACP posture) and **principle #16**'s proposed
   text.

**The three biggest calls hiding in the pass — walk these first (§7):**

- **The workflow-instance store** (q13): the engine gains a generic
  instance record (core fields + opaque payload). It is E4's ninth item and
  the one place the extension model makes the engine bigger.
- **Retiring `offered_when`** (q14): the exposure predicate dissolves into
  node-declared tools + entity grants. No grammar, ever — if you agree.
- **The event-kind rename** (q21): `task_*` kinds get generic siblings and a
  PERMANENT versioned alias table; history is never rewritten. This is q8
  ("are event kinds public API?") arriving with a bill.

---

## 1. Proposed D66 — the tier boundary

**Read:** `extension-model.md` §1 (the proposal), §1.4 (the herdr fork
analysis), §1.5 (every E4 surface's declaration home).

Two tiers, one vocabulary. Tier 1 = in-process TypeScript modules in the
daemon build (first-party only, spine-speed, may register write-path
projections, no failure isolation). Tier 2 = external processes over the
public HTTP/WS/MCP surface (herdr's model; #15 made literal; full crash
isolation; capability-gated). Both declare the same TOML manifest; the tier is
one `[runtime].kind` field whose privileged value only builtin trust may hold.
The **Tier-2-completeness rule** guards #15: any manifest surface must be
servable over the public API, and a Tier-1-only capability is a bug with a
D-record, not a shrug. Placement: tasks → Tier 1, Book Genesis → Tier 2 (the
deliberate proof that Tier 2 is real), drive verbs → content of their owner,
future ACP face → Tier 2.

The named cost, accepted knowingly: Tier 1 has no failure isolation — "an
extension crash cannot corrupt engine state" is true by review discipline at
Tier 1 and by architecture at Tier 2. The day a Tier-1 slot is offered to
unreviewed code, D66 reopens.

## 2. Proposed D67 — trust

**Read:** `extension-model.md` §5.1 (the proposal), §5.2 (threat framing),
§5.3 (the taxonomy), §5.4 (confinement).

v1 is first-party-only (trust by authorship; no install path exists at all),
and the grant machinery is built anyway: grants pinned to the manifest hash,
unknown capability → reject never grant, widened grant → re-approval pinned to
exact content, `extensions.lock`. The threat framing is honest about the
class: this daemon holds Access-authenticated reach into every project and is
tunnel-published — agenc's threat class, not herdr's laptop. The taxonomy
grades by effect (`session.read` is HIGH — the exfiltration grant;
`session.unattended` is HIGH and never implied; `terminal.create` is RCE by
design), and the doc says plainly that **capabilities without OS enforcement
are informed consent, not containment** — coherent exactly while author ==
consenter, dead the moment someone else's extension loads. That sentence is
D67's load-bearing conditional and its reopening trigger.

`confinement = { mode, paths }` is reserved on the dispatch spec with agenc's
mode vocabulary — **off by default** per your E3 settlement, which diverges
from agenc's default-on. Flagged for your conscious signature (q12), not
because the default is in doubt.

## 3. The kill-criterion verdict

**Read:** `node-kit.md` §4 (the verdict), §2 and §3 (the mapping tables — 30
task rows, 31 Book Genesis rows).

**Both tenants map. No engine carve-outs. The criterion is not tripped.** The
verdict's logic: every place Book Genesis strained turned out to have a
task-machine sibling (bounded loops, withheld briefings, fan-out) — two
tenants wanting the same missing thing means the thing is vocabulary; one
tenant alone would have meant narrowing the engine. The standing rule that
makes the verdict assertable forever: **the engine's source may not contain a
tenant's word** — a grep of `packages/core`, post-migration, is the test.

The kit: node kinds as property bundles (closed mechanics vocabulary, open
kind names — `work`/`review`/`hold` are the tasks extension's words, not the
engine's), declared edge tables adjudicated against manifest-hash-pinned
revisions, channel-stamped proposer allow-lists matched positively, bounded
loops with engine-owned counters, briefings as composer + input allow-list
(denial is the complement — a composition guarantee, honestly not
containment), six acceptance kinds including rubric AND scalar side by side.

Ten bends go to you (§4's table): the sharpest are `manualReviewRequired`
becoming a node or an overlay (A-11), the capture catalogue being closed with
one entry (A-12), watchdog bands as clamped per-workflow ⟨tune⟩s (A-22), and
fan-out/join living in extension code for v1 (B-15). The verification story
you should know: the declared edge table was mechanically diffed against
`TASK_STAGE_EDGES` — the agent's first draft failed that diff (lost two
edges, invented two), which is the best argument for the kit ever written; I
re-ran the diff independently at the gate and it now matches exactly.

## 4. Seam-first migration

**Read:** `migration-map.md` §2 (the argument), §1 (the map), §1.7 (eight
orphans the E5 seed missed).

Seam-first, because the recorded behaviour (the trial's event log, seq
101–111, plus the 3132-test suite) is the migration fixture, and only
seam-first keeps it meaningful at every step — migrate-last makes every
rewrite land unverified and turns the fixture into a post-mortem. The
differential test the node kit demands (declared edges vs `TASK_STAGE_EDGES`)
mechanically requires the parser to exist before the migration. First moves:
**0** freeze the fixture into a repo file, **1** parser + registry with zero
consumers, **2** the instance store as `projections/tasks.ts` +
`taskWriter` + `taskApi` generalised (riskiest step, deliberately early while
the old code still stands as reference), **3** adjudication reads the pinned
declaration and `TASK_STAGE_EDGES` dies. The coexistence rule: **the seam
moves, the state does not** — never dual-write the spine; each step deletes
what it replaces in the same unit. Untouched until you sign: every route, the
whole UI (the ci-gate partial-deploy hazard makes that a hard line), MCP
names, the orchestrator founding, Book Genesis.

## 5. The client contract, D62, and principle #16

**Read:** `migration-map.md` §3; `scratchpad/s9-0a-acp-read.md` §5 (the D62
lean, verified 2026-08-05).

**Client contract:** shared IA, per-client grammar; no shared widget code —
clients may disagree about rendering, never about truth. E4's nine items each
land with an API surface, a manifest section, and a web + TUI line. Four ACP
steals, all vocabulary never protocol: gate OPTION FAMILIES (v1 emits
allow/deny as a list; `allow_always` kinds reserved without rule storage),
restricted question schemas, tool-call `kind`/`status`/`locations` (derived
from the structured stream — 0.8), capability hello with
omitted-means-unsupported. Blocks degrade to text on the TUI; PTY panes frame
in xterm on the web; every block element must have a text rendering or it is
not admitted. Usage meters are engine chrome no extension may re-source,
"directly above the sessions they fund" (your v2 mockups).

**Proposed D62** (moves from open-questions to decisions on your signature):
keep the private seam on both faces. ACP becomes: (a) a validated external
vocabulary now (the four steals), (b) one `AcpAgentAdapter` behind the
existing D18 seam at the provider-#2 trigger, (c) a possible ACP *face* as a
Tier-2 extension on its own trigger (v2 + remote transports stabilize, or
real editor demand) — an external process speaking ACP outward so the engine
never learns it. The plan boundary (D48 deny-and-harvest) has no ACP
expression and stays private regardless.

**Scope 7 (drive verbs) — covered, confirm sufficiency:** promote / move /
dispatch / amend exist as two-faced `[[verbs]]` declarations in the tasks
manifest (`extension-model.md` §3.1) with their input schemas, D65 family
homes, and #13 parse rules; the node kit's §1.9 carries their edge/proposer
semantics. No separate drive-verb doc was written — flag if you want one.

**Proposed principle #16** (scope 9 — ratify, amend, or reject):

> **16. The engine makes zero assumptions about how people work.** Custody,
> the spine, the session tree, gates and questions, blobs, dispatch, and the
> instance store are the whole engine; every workflow noun — task, stage,
> review, chapter, phase — reaches the engine as a declaration it validates,
> an id it stores, or a payload it fans out unread. The assertable form: the
> engine's source may not contain a tenant's word (node-kit §1.10).

## 6. The tree-spine schema reservation (N5)

**Read:** the commit `74dfe4b` diff; `packages/core/src/projections/nodes.ts`
and `nodeRollup.ts` (the comments carry the design).

The settled E2 vocabulary is now reserved code (rule 0.5 — nothing emits it
yet): `node_created` / `node_closed` / `session_attached_to_node` on a new
`nodes` stream, write-once provenance (`null` stays `null` forever; there is
deliberately no `node_moved` and no reopen event — each awaits its own
D-record), `directory` nullable per E3-a, `nodeConfig` reserved as
required-null. The `nodes` projection holds the four E2 invariants
structurally — unknown-parent and self-parent creations are dropped (the
forest invariant), the duplicate-create guard is what makes write-once
unforgeable, one parent per session, and closure sets one boolean with
effective closure derived at read time. `nodeRollup` is the ONE definition of
"worst": `ATTENTION_SEVERITY_ORDER_VERSION = 1` over
`idle < working < waiting_input < gate_fired < error`, counting **processes,
not open nodes** (there is no closed filter and the comment says there must
never be one), with `null ≠ idle` kept distinct.

Suite: 3132 → **3185 tests** (130 files), typecheck clean. My gate ran the
full suite twice and sabotage-verified both load-bearing guards myself:
disabling the duplicate-create guard reddened exactly the write-once family
(including the no-reopen test, which correctly depends on it); adding a
`closed` filter to the rollup reddened exactly the processes-not-nodes
family. Both restores verified byte-identical with `cmp`.

One implementation choice to bless: `nodeConfig` is a **required** key that
accepts only `null` — every create must say `nodeConfig: null` explicitly.
That is the skeleton taken verbatim; it makes the reservation loud at every
call site, and loosening it to optional later is non-breaking.

## 7. Every open question, sorted for your morning

The pass accumulated **29 numbered open questions** across
`extension-model.md` §4.2 (1–12), `node-kit.md` §5.2 (13–20), and
`migration-map.md` §4.2 (21–29). Every one carries a DEFAULT TAKEN so the
docs are internally consistent. Sorted by what they need from you:

**Walk-first (the calls that shape the engine — §0's three plus two):**

| # | Question | Default taken |
|---|---|---|
| 6+13 | Extension records / the workflow-instance store — E4's ninth item | option (a): namespaced spine events + engine core fields + opaque payload |
| 14 | Retire `offered_when`? | yes — node tools + entity grants; no predicate grammar ever |
| 21 | Event-kind renames + permanent alias table | generic siblings are new kinds; history never rewritten |
| 12 | `confinement` off by default (diverges from agenc) | off — your E3 settlement, conscious signature requested |
| 8 | Are engine event kinds public API? | versioned allowlist; deprecated kinds warn (the `meter_threshold_crossed` near-miss is the evidence) |

**Confirm-batch (defaults that follow from settled things — a nod each):**
1 (Tier-2 projections: no, asymmetry named) · 2 (Tier-1 imports host
interface only) · 3 (verb `target` engine-enforced) · 4 (scalar overlays) ·
5 (activation in-repo) · 7 (superseded by 14) · 9 (first-party enforced by
absence + source check) · 10 (declare-vs-do: `events.subscribe` +
`verbs.register` need grants) · 11 (Tier-2 credential daemon-minted,
per-extension, capability-scoped; mechanism stays D63) · 15 (watchdog bands
declarable, engine-clamped, values unpinned per 0.2) · 16 (refuse plan-mode ×
non-empty tools at parse, naming D55) · 17 (proposer vocabulary
+`watchdog`+`extension`) · 18 (payload edit mints a rev) · 19 (workflow
api_version inherits from manifest) · 20 (fan-out deferred, D11) · 22
(fixture exported before Move 1) · 23 (new modules: core=deterministic,
daemon=I/O) · 24 (`/api/tasks/*` aliases live one deploy) · 25 (introspection
endpoints generalise) · 26 (capability hello on WS + `/api/health`) · 27
(reserved gate-option kinds without rule storage) · 28 (compaction steward
stays engine; its nudge prose is yours to call doctrine) · 29 (tasks
extension into `packages/ext-tasks/`).

**Flagged by the units as quiet growth (not questions, but say-out-louds):**
`deriveReviewOutcome` becomes a *generic engine rubric evaluator*
(migration-map §1.2) — a second engine growth beside the instance store;
and dissolving guards (`recordReview`/`recordCompletion`) must be **proven**
unreachable, never just deleted.

## 8. What the E-settlements become on signature

E1-a (ledger engine / policy extension), E1-b (blob service, per-extension
namespacing), E1-c (mounting engine / verbs extension), E1-d (dispatch
primitive cut), E1-e (persistent-chat primitive / persona extension), E2-a
(one node kind, write-once provenance), E2-b (engine aggregation projection,
versioned severity order, processes-not-nodes), E2-c (both creators one API,
engine does git, create≠open, removal gated), E3-a (directory optional, three
meanings kept separate) — each becomes a dated D-record in `decisions.md` at
sign-off, with D66, D67, D62, the verdict, the sequencing, and #16 alongside.
The DRAFT banners drop from `architecture.md`, `extension-model.md`,
`node-kit.md`, and `migration-map.md` when you sign; `slice-9.md`'s exit gate
closes; the build era (slice 10, seam-first Move 0) opens on the fresh usage
week.

## 9. Suggested read order (≈90 minutes total)

1. **This packet** (you are here).
2. `node-kit.md` §4 — the verdict and its bends (10 min). The pass lives or
   dies here; everything else is machinery around it.
3. `extension-model.md` §1 + §5.1–5.2 — D66 and D67's proposals (20 min).
4. `migration-map.md` §2 — the sequencing argument (10 min).
5. The walk-first questions (§7 above) against their sections (20 min).
6. Skim the two tenant manifests (`extension-model.md` §3) and the tasks
   workflow TOML (`node-kit.md` §1.9) — the concrete artifacts everything
   above abstracts (15 min).
7. The confirm-batch (§7) — one nod each (10 min).

Contest anything. The night's fixes (a deprecated-event subscription, two
wildcard-semantics gaps) are all in the committed diffs; nothing was patched
silently.
