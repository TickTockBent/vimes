# Ranks — open questions

What still needs a call. Each entry carries its **trigger** (the slice or
event that forces the decision) and the **current lean**. When decided it
**moves** to [`decisions.md`](decisions.md) as a `D#` — it is not edited
in place. Numbering is `Q#`; entries carried from the Vimes record cite
their `V-D#` origin. Seeded 2026-09-08 from the founding note's §9 and
the two Vimes questions still alive after D1.

## Q1 — Does the orchestrator read the repo? (carried from V-D92; contradicted by the note's §4)

*(V-D92 was raised 2026-08-17 out of the nac decomposition and leaned
**read yes, write/exec no**, on evidence from Vimes work orders: the
precision that makes a work order a contract came from the orchestrator
reading the file first. The founding note's §4 leans the other way —
codemap and wiki only, never raw source — and calls grounding
sufficiency a prerequisite (§9.4). Both leans are recorded; neither is
decided. Note also that in slice 1 the orchestrator is not a room or a
product surface at all — it is Fable in a plain Claude Code session with
full read, authoring briefs by hand — so the question is not forced.)*

**Trigger:** the first design of an orchestrator *room* or a
product-mounted orchestrator session grant — after slice 1, and only
when a real run pulls for it.

**Lean:** **read yes until the generated artifacts exist and have been
shown sufficient.** The separation that keeps the orchestrator the cheap
layer is staying out of the *editor*, not out of the files. Before
adopting the note's stricter form, run the grounding spike the note's
§9.4 implies: author one real brief from codemap + wiki alone and
measure what it got wrong. If the codemap-only orchestrator writes
insufficient briefs, §4's grant collapses back to read-yes and that is a
finding, not a failure.

## Q2 — Fan-out joins: inferred from source references, or a declared `collect`? (carried from V-D93; note §9.1)

**Trigger:** the validator's type-check, when it is written — a `collect`
node has a schema and an inferred join does not, so this must be
decided before that pass exists. Not in slice 1 (no fan-out).

**Lean:** **inferred join**, with the canvas (when there is one) drawing
the implied join. Materially simpler, composes with attempt anatomy (a
waiting room is one whose sources are incomplete), and inspectability is
satisfied by the source references themselves. Rider from V-D93: an
inferred join is structure that exists only in dependency data, so
adopting it creates a *rendering* obligation, not a schema one.

## Q3 — What does a `transform` room run? (note §9.2)

**Trigger:** the first edge whose report schema and brief schema do not
match — i.e. the second room kind with a distinct report shape.

**Lean:** pure function where expressible, model-backed room otherwise.
"Pure function as a room kind" is a new idea needing its own contract;
do not design it speculatively.

## Q4 — How much of the tool grant is enforceable on each harness? (note §9.3)

*(The wall is **authority, not knowledge**: path-scoped read/write and
command allowlists are enforceable through a harness's permission
hooks; "cannot know other files exist" is not, on any harness.)*

**Trigger:** SP1·1 (slice 1's spike) answers this for Claude Code by
observation; each later harness answers it at its own verify-row before
it goes IN.

**Lean:** state the limit in the design and in the validator's
harness-capability table, so nobody expects more. A grant a harness
cannot enforce is refused at validation with the gap named (D1 ruling 4).

## Q5 — Grounding sufficiency of generated artifacts (note §9.4)

**Trigger:** Q1's decision — this is its evidence.

**Lean:** a spike before a build. The documentation-standard work
(generated, regenerable, hash-pinned, provenance-marked) becomes a
prerequisite only if the note's §4 form is adopted.

## Q6 — When does a standalone surface earn its build? (note §9.5, narrowed by D1 ruling 3)

*(D1 made "layer on Claude Code" the default, which answers the note's
larger question. The residual: the canvas, the human-room phone card, and
a product-mounted orchestrator chat are all deferred, not refused.)*

**Trigger:** a real run that ⟨Wes⟩ finds himself unable to follow from
files and the CLI — the concrete pull.

**Lean:** build the smallest view that answers the pull; the declaration
stays the authority and any view authors only through the same tool
surface (note §5).

## Q7 — Free sessions (note §9.6)

**Trigger:** none expected.

**Lean:** that is what Claude Code is for. Ranks does not host
interactive sessions, and resisting that is how it stays small.

## Q8 — When does `node` become `room` in code and manifests?

**Trigger:** a real run whose declaration reads wrong with the old word —
concretely, the third declaration where the author reaches for "room."

**Lean:** never as a slice of its own. If it happens, it is a mechanical
rename under V-D71's Move-3 choreography, riding a slice that has a
reason to touch the manifest anyway (D1 ruling 6).

## Q9 — Codex goes IN

**Trigger:** ⟨Wes⟩ wants a real task run on Codex — a pull, not a plan.

**Lean:** verify-rows first (risk-register): headless invocation, MCP
support for the report channel or structured final output as the
fallback, permission-hook granularity for the grant, behavior on a
schema-refused report. Then a second `Performer` implementation behind
the D1 ruling-4 interface, and nothing above it changes. OpenRouter
follows the same path as an API-backed family member, which additionally
requires owning the tool loop — the expensive one; it earns its build
last.

## Q10 — `retry_bound` for schema-rejected reports (⟨tune⟩)

**Trigger:** Gate-D in slice 1, after SP1·1 has observed how a fresh
attempt behaves with the validation error appended to its brief.

**Lean:** v0 relative weight **2** (the original attempt plus one
error-guided retry) for measurement only; pinned by ⟨Wes⟩ against the
spike's evidence. Distinct from edge exhaustion (`max_traversals`), which
is a routing bound, not a shape bound.
