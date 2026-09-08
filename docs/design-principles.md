# Design principles

The project's design constitution. When a proposal touches one's territory,
check it against the principle before recommending. Opened 2026-09-08 at
the pivot (D1): the ground rules carry from Vimes **unchanged**; the
pillars are Ranks's own, seeded from the founding note; the established
principles that survive the cut are carried with their provenance, and the
ones that do not are listed as retired so nobody re-derives them.

## Ground rules (0.x — non-negotiable; violating one is wrong, not a judgment call)

- **0 (umbrella).** No behavior-shaping change ships without **evidence +
  ⟨Wes⟩'s sign-off.**
- **0.1 — Findings, not patches.** Any structural flaw discovered by tests,
  spikes, or runs is a *finding*: it halts the slice and earns a dated
  decision record before work continues. Never quietly patched or tuned.
- **0.2 — Gate-D.** ⟨tune⟩ numbers are placeholders. They may not become
  FAIL-able assertions until calibrate-then-pin has run and ⟨Wes⟩ has
  priced them against measurements. Never pin and pass in one unreviewed
  step.
- **0.3 — Deterministic headless core.** Pure logic with clocks, randomness,
  and I/O injected at the boundary. Performers, UIs, and external callers
  consume state and propose transitions — never own either. The engine
  owns the graph's state; rooms and orchestrators propose.
- **0.4 — Green stays green.** Every slice ships its assertion set green
  with all prior assertions still green. A regression is a finding.
- **0.5 — Reserve schema early.** Slices may stub systems but must land
  data shapes, event schemas, and contracts. Data shapes, not tooling —
  machinery with no live consumer waits for its first consumer. **Applied
  to the product as well as the code from D1 on** (pillar 7).
- **0.6 — External surfaces drift.** Every uncontrolled surface gets a
  risk-register entry and a fragile-adapter boundary; nothing outside the
  adapter depends on the surface's specifics. Verify-rows are spikes,
  front-loaded — never built against documentation alone. Every performer
  harness is such a surface (D1 ruling 4).
- **0.7 — Observed truth over declared truth.** Wherever a harness's or
  provider's behavior matters, classify by runtime observation, never by
  documentation. This now spans Anthropic, OpenAI, and any OpenRouter
  model alike.
- **0.8 — Never parse the screen.** Structured data comes from typed
  channels only — report tool calls, SDK streams, JSONL transcripts. A
  transcript is evidence, stored and inspectable; it is never regexed for
  meaning.

## Pillars (Ranks)

1. **The product is the graph, not the agents.** A room is a pure function
   from a brief to a report, executed by a fresh session, with its walls
   enforced by the engine rather than by the agent's cooperation. What a
   human sees is the graph, the reports crossing its edges, and the
   verdicts at its checkpoints. *(Note §0–§1.)*
2. **The declaration is the authority; everything else is a view.** The
   graph is data the engine validates; a canvas, a CLI, or an orchestrator
   authors only through the same tool surface and never through its own
   semantics. The moment a view is a second source of truth, a room's
   walls have a hole. *(Note §5; V-D76 carried.)*
3. **Rebuild, never steer.** A room cannot be injected into, resumed, or
   nudged. The only correction is rebuilding the room and running it
   again. One attempt = one fresh session, identity
   `(workflowRev, roomId, attempt)`. *(V-D46 promoted from a rule about
   stages to the definition of a room.)*
4. **Shape is enforced; the limit on truth is stated.** The engine
   validates that a report exists and covers every criterion by id; it
   cannot know the reviewer read the diff. `command` acceptance is
   preferred wherever a criterion is decidable by an exit code; `rubric`
   acceptance is a review room with its own performer. What the engine
   cannot decide it isolates, structures, and bounds — and says so.
   *(V-S9·4's boundary, carried.)*
5. **The human is a room.** A structured brief (what must be decided, with
   evidence attached) and a structured report (the decision, in a declared
   shape). It is the only place a human enters the graph during a run.
   *(V-D53 and V-D78 collapse into this.)*
6. **Attention has three words.** A room failed terminally; a human room
   awaits a report; the graph completed (or its verification recipe
   failed). No gates, no permission prompts, no seen/unseen. *(Note §6.)*
7. **Real use is the gate.** The exit gate for slice 1 is ⟨Wes⟩ using it
   for a real task and wanting to again; no slice after it earns its build
   without a real run pulling for it. The MVP line is slice 1. *(D1
   ruling 2 — the discipline change that would have saved Vimes.)*
8. **No vocabulary churn.** A rename, re-shape, or migration earns its
   build only when a real run asks for it; until then the old word stays
   (`node`, not `room`, in code). *(D1 ruling 6; ⟨Wes⟩: "we kept changing
   things.")*
9. **Performer-blind above the adapter.** Nothing above the `Performer`
   interface knows which harness ran a room. Grants are declared once and
   enforced per harness; a grant a harness cannot enforce is refused at
   validation, never downgraded. *(D1 ruling 4.)*

## Established in use — carried from Vimes

*(Numbering continues from the pillars; each carries its Vimes provenance.
Anything not listed here was retired at the pivot — see the retired list.)*

10. **One source of record per fact.** *(V-#9, codor decomp.)* No fact is
    ingested from two sources without an explicit dedupe boundary. Being
    accidentally *both* is the only losing position.
11. **An MCP server is a thin client of the engine's API — never a second
    writer to the store.** *(V-#10, ata decomp.)* Two writers is how file
    locks happen. The report tools and any future stdio bridge for an
    external Claude Code session obey this.
12. **Completion is an explicit event, never inferred from output.**
    *(V-#12, agentswarms decomp.)* A room is done when a report says so —
    never because output exists, and never not-done because output was
    empty.
13. **No tool or API parameter may assert a decision the engine should
    read from the record.** *(V-#13, agentswarms decomp.)* Authority
    derives from persisted state — the filed report, the evaluated
    verdict, the human room's decision — never from a payload field
    claiming the decision happened. Embodied by `evaluateAcceptance`
    reading the filed report; binding on every future tool surface.
14. **Unattended means fail closed.** *(V-#14 narrowed.)* Vimes selected
    fail-open vs fail-closed by session class; Ranks rooms are always
    unattended, so a stale meter, a missing grant table, or an
    unevaluable acceptance means STOP, never proceed.
15. **The engine's public API is the extension API.** *(V-#15, herdr.)*
    No second SDK. The CLI, the report tools, and any future view dogfood
    the same surface, so the contract cannot silently rot.
16. **The engine makes zero assumptions about how people work.**
    *(V-#16, V-D70.)* Every workflow noun reaches the engine as a
    declaration it validates, an id it stores, or a payload it fans out
    unread. Assertable form: the engine's source may not contain a
    tenant's word (the tenant-boundary grep gate carries).
17. **Engine states describe the PROCESS; overlays describe the WORK.**
    *(V-#17, V-D82.)* Attempt status is engine state; what an attempt
    means for the work is the report and the verdict. A proposed state
    that cannot be decomposed this way is smuggling workflow into the
    engine.

## Retired at the pivot (D1) — listed so they are not re-derived

- V-pillar 1 (the session list is the home screen), V-pillar 2
  (reconnecting is not resuming), V-pillar 3 (the agent is the refactor
  engine — no editor exists to refactor in), V-pillar 7's PTY half
  (escape hatches beside abstractions — the raw sibling was the terminal),
  V-#8 (tunnel to any depth), V-#11 (real estate to content, not chrome).
- The standing consequence "security is core, not product — the PTY
  endpoint is RCE as designed": void with the PTY channel. The auth choke
  point survives S1·0 unexamined and is priced at S1·5.
- "The MVP line is slice 3" → **the MVP line is slice 1** (pillar 7).

## Standing consequences that carry

- **The event log is the replay buffer**: persist-before-broadcast (V-I13)
  + replay-from-log (V-I2) is one path for every gap length.
- **Precision policy:** counted quantities assert exact; measured
  quantities assert within stated tolerance — relative-epsilon, never
  exact equality.
- **Pure core, deterministic harness:** the scenario harness and its
  byte-identical twice-run gate survive the cut and gate every slice's
  *code* (0.4) — they are not the *product's* gate (pillar 7).
