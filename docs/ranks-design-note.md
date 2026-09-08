# RANKS (working title — see §10)
### The Watch in ranks: agents as rooms, work as a typed graph
**Design note — draft 1 — 2026-09-08 — written during the Vimes park, to be re-read after two weeks on someone else's tool**

> Vimes let every agent wander the city with a full kit and a long memory, then tried to check its report afterward. This forms the Watch into ranks: every agent is a room with one door in and one door out, both doors have a shape, anything that doesn't fit the shape is refused at the door, and no one is ever spoken to mid-patrol. The product is not the agents. The product is the graph they stand in, and the conversation that builds it.

---

## §0. The cut

Vimes was two products stapled together. One was a session manager — sessions that outlive terminals, mobile steering, push, a tree, a status bar — and that race was lost to eight well-made competitors before it began. The other was a verification loop — work-orders with acceptance criteria, plans crossing agent boundaries as hashed artifacts, fresh implementers, verdicts that cannot be talked around — and nineteen decompositions found it nowhere else. The session manager was the part that never got finished. The loop was the part that worked on its first real run.

Ranks is the loop, alone, taken to its limit. **We do not care about sessions. We work on the project.**

Three consequences follow immediately, and they are the reason this is a smaller product rather than Vimes with fewer screens:

1. **There are no runtime permission gates.** A room's authority is declared in the graph at design time. Nothing is approved mid-run because everything approvable was approved when the graph was built. The entire attention-and-push apparatus collapses to three events (§6).
2. **There is nothing to steer.** A room cannot be injected into, resumed, or nudged. The only correction is rebuilding the room and running it again. The input lease, the PTY guard, admission timing — all void, because there is no input.
3. **There is nothing to watch.** No terminal to mirror, no transcript to stream. What a human sees is the graph, the reports crossing its edges, and the verdicts at its checkpoints.

## §1. The room

A room is one node of the graph. It is a **pure function from a brief to a report**, executed by a fresh agent session, with its walls enforced by the engine rather than by the agent's cooperation.

```
room:
  id                 stable, engine-issued
  kind               extension-declared (research / implement / review / transform / human / …)
  brief_schema       what comes in — validated before dispatch; the room never sees anything else
  report_schema      what comes out — validated at the door; anything else is refused
  tool_grant         declared authority: readable paths, writable paths, runnable commands
  acceptance         per-criterion, each `command` (exit code decides) or `rubric` (a review room decides)
  retry_bound        max attempts before the room fails terminally
  performer          model, effort, harness — declared per room, so review can differ from work
```

Runtime rules, none of them optional:

- **One attempt = one fresh session.** Identity is `(workflowRev, roomId, attempt)`. Never resumed. The anchoring argument (D46) stops being a rule about stages and becomes the definition of a room.
- **The brief is the entire context.** No project history, no prior transcript, no memory. What the room needs, the brief carries — by value or by artifact reference. The orchestrator's job is to make briefs sufficient; the room's job is to be honest about what was insufficient (a structured `blocked` report is a valid shape).
- **The tool grant is enforced, not requested.** A room with `read: [src/auth/**]` cannot open `src/billing/`. Not "should not" — cannot. The grant is the room's wall on the side the schema can't cover: tool results are the one channel of unstructured reality into the room, and the grant is what bounds it.
- **The report is validated at the door.** A report that fails `report_schema` is not a failed room; it is a **rejected attempt**. The rejection is itself structured (the validation error) and becomes the brief delta for a fresh attempt, up to `retry_bound`. Compiler semantics: the error is the fix.
- **Rejection ≠ failure.** Schema rejection retries. Criterion failure routes along a declared edge (§3). Terminal failure (retry bound hit, or a `blocked` report) surfaces to the human (§6). Three distinct outcomes, three distinct edges, never conflated.

The Vimes machinery that survives unchanged into this contract: the work-order schema becomes `brief_schema` for implement rooms; `report_completion` with its worklog (decisions, paths-rejected, exact commands, known-good/known-broken, next starting point) becomes the canonical implement `report_schema`; the plan artifact from ExitPlanMode interception is simply a research room's report; `deriveReviewOutcome` is a review room's acceptance function and does not change by one line.

## §2. The human is a room

A `human` room has the same contract: a structured brief (what must be decided, with the evidence attached) and a structured report (the decision, in a declared shape). It is the **only** place a human enters the graph during a run.

This is the whole of the mobile story. The phone renders human rooms awaiting a report and nothing else. Every decision arrives with enough context to be made from its own card, because the brief schema for that room said so at design time. D78 ("mobile is for deciding") is no longer a pillar to protect; it is the only thing the phone can do.

## §3. The edges are a type system

An edge connects one room's `report_schema` to another room's `brief_schema`. **The graph is valid only if every edge type-checks** — the schemas match, or a declared `transform` room sits between them. This is the entire source of the design's rigor and the entire source of its authoring difficulty.

- **Conditional edges** are predicates over the *report*, evaluated by the engine — never by an agent's judgment. `verdict.allPass == true → next; else → fix`. The predicate language is deliberately small.
- **Fan-out and join.** A room that names N source rooms waits for all N — the join is inferred from data dependency (nac's shape), not declared as a node. Best-of-N is an emergent pattern: N independent rooms with identical briefs, one synthesis room that names them all. *(Open: whether an explicit `collect` is needed for inspectability — §9.)*
- **Cycles are rejected at validation time**, with the cycle path in the error. Loops are expressed as bounded retry edges with a declared ceiling the graph cannot raise — prompter's three-layer bound.
- **Workflow-level verification** is a declared recipe at the graph level, distinct from per-room acceptance: "when all of this is done, *this* is how you know the whole thing works." Command-kind wherever decidable.

The validator is therefore load-bearing, not tooling: a graph that does not type-check does not run. It is a dependency-ordered pass set (parse → expand → type-check → cycle-check → grant-check), it runs without a live engine, and it is **exposed as a tool the orchestrator calls** (§4). The Home Assistant / Grafana / Backstage decompositions were about extension authoring; they turn out to have been about this.

## §4. The orchestrator

A frontier-model conversation at the bottom of the screen, with exactly one job: build and inspect the graph. Its tool grant is the product's most important declaration.

```
orchestrator tools:
  graph.create_room / update_room / delete_room
  graph.connect / disconnect
  graph.validate                → the validator, as a tool
  graph.run / halt
  inspect.report(roomId, attempt)
  inspect.verdict(roomId, attempt)
  inspect.artifact(hash)
  read.codemap / read.wiki      → generated project artifacts, hash-pinned
```

What it does **not** have: file read, file write, exec, and any way to address a running room. Three rules, each enforced by the grant rather than the prompt:

- **Grounding through artifacts, not the repo.** The orchestrator reads the code map and the repo wiki — generated, regenerable, hash-pinned — never raw source. If it needs to know something those don't cover, it builds a `research` room and reads the report. This keeps the orchestrator's context clean (nac's argument) without making it blind (the objection to nac's stricter form).
- **Rebuild, never steer.** It may halt a run, change a room's brief, grant, or schema, and run again. It may not reach into an attempt in flight. This is D46 one level up, and it is the rule most likely to be tested first, because the chat is the most tempting back door for chat-and-steer.
- **Proposals, not transitions.** The engine owns the graph's state; the orchestrator proposes changes that are validated and applied, or refused with a reason. A graph edit that would break a type-check is refused at the tool boundary — the same compiler semantics as a rejected report.

Authoring loop: the orchestrator drafts a graph, calls `validate`, reads structured diagnostics, fixes, repeats — then the human signs, then it runs. The human's part of authoring is conversational ("I want the auth module tested against the three failure modes in the incident doc") and the orchestrator's part is structural. Neither hand-authors YAML.

## §5. The canvas

An n8n-shaped view: rooms as nodes, edges typed and coloured by validity, reports inspectable on each edge, verdicts visible at each checkpoint, live attempt status per room.

One rule, and the one most likely to be violated because drag-and-drop is seductive: **the declaration is the authority; the canvas is a view.** If the canvas ever authors, it authors through the same tool surface the orchestrator uses — one schema, N consumers — and never through its own semantics. The moment the canvas is a second source of truth, the room's walls have a hole in them. OpenCompany's incomplete migration from client-side node knowledge to a served registry is the cautionary specimen; D76's "render an unknown kind from its declaration alone" is the rule, and it is easier here than it was in Vimes because every kind *is* a schema.

The canvas is a desk surface. The phone gets the human rooms (§2) and the attention list (§6) and nothing else.

## §6. Attention

Exactly three things can want a human:

1. A room **failed terminally** — retry bound reached, or it filed a `blocked` report.
2. The graph reached a **human room** awaiting a report.
3. The graph **completed** (or the workflow-level verification recipe failed).

That is the whole vocabulary. No gates, no permission prompts, no "waiting for input" on a running agent, no seen/unseen. Push fires on 1 and 2. The liveness×attention model from Vimes reduces to per-room attempt status plus this list.

## §7. Verification is structural, and its limit is stated

The engine enforces *shape*, never *truth* — a verdict must exist and must cover every criterion by ID, but the engine cannot know the reviewer read the diff. This was S9·4's honest boundary in Vimes and it does not move. What moves is how much lives on the decidable side of it:

- `command` acceptance is preferred wherever a criterion can be decided by an exit code. "The CHANGELOG entry exists" is a grep, not a judgment.
- `rubric` acceptance is a **review room**: brief = diff + criteria (+ worklog), report = per-criterion verdict, performer declared separately from the implement room (cheap model implements, strong model reviews — cost lever and independence lever in one field).
- A review room's report is validated like any other: a verdict that omits a criterion or invents one is *rejected at the door*, before `deriveReviewOutcome` ever sees it.

Acceptance validates shape. Verification recipes and command criteria validate truth where truth is decidable. The rest is a reviewer's judgment, isolated, structured, and bounded — which is the most any system can honestly offer.

## §8. What survives from Vimes, and what dies

| Survives (mostly unchanged) | Dies (deleted, not deferred) |
|---|---|
| Event spine, persist-before-broadcast (I13), append-only store | PTY channel and everything on it (guard, lease, admission timing) |
| Artifact store, hash-pinned artifacts | Session surface, tree home, short ids (D79), seen/unseen (D83) |
| Attempt identity → `(workflowRev, roomId, attempt)` | Mobile steering, interactive sessions in-product |
| Work-order schema → implement `brief_schema` | Runtime permission gates and the push apparatus around them |
| `report_completion` worklog → implement `report_schema` | Custody model for foreign sessions (D10) — no foreign sessions |
| `deriveReviewOutcome` and criterion-coverage semantics | Liveness×attention as a session model (becomes room attempt status) |
| Extension engine: a room *kind* is an extension | Session status bar chrome (usage meters survive; per-session chrome does not) |
| Validator work (HA/Grafana/Backstage carry-overs) — now load-bearing | The board as a session-adjacent surface (becomes the canvas) |
| SDK channel as the only channel | Multi-provider *session* concerns (performer is a room field instead) |
| Usage meters, single-source usage math, cache observations | |

Roughly: the engine survives, the session manager dies, and the loop is promoted from a tenant to the product.

## §9. Open questions

1. **Inferred join vs declared `collect`.** nac's inferred join is simpler and equally inspectable via source references; a declared join renders more legibly on the canvas and is checkpointable. Lean: inferred, with the canvas drawing the implied join. Decide before the validator's type-check is written, since a `collect` node has a schema and an inferred join does not.
2. **What does a `transform` room run?** A schema-to-schema adapter could be a pure function (no agent), a cheap model, or either by declaration. Lean: pure function where expressible, model-backed room otherwise — but "pure function as a room kind" is a new idea and needs its own contract.
3. **How much of the tool grant is enforceable on today's harness?** Path-scoped read/write is enforceable via the SDK's permission callbacks; command allowlists are enforceable; "cannot see other files" in the sense of the model *knowing they exist* is not. The wall is authority, not knowledge — state it so nobody expects more.
4. **Grounding sufficiency.** If the orchestrator reads only generated artifacts, the code map and wiki must be good enough to author briefs from. That makes the documentation-standard work (generated, regenerable, hash-pinned, provenance-marked per nac's compaction rule) a *prerequisite*, not a feature.
5. **Platform risk, named.** Anthropic's Managed Agents multiagent orchestration plus Outcomes is converging on this shape. The differentiator is local, your repo, your subscription, typed edges, and verdicts you can read — not the concept. If Claude Code ships typed-graph orchestration with graded outcomes natively, the right form of Ranks is a Claude Code extension that supplies the graph and the verification, not a product beside it. Watch for it; don't wait for it.
6. **Free sessions.** Sometimes you want to just open Claude Code and poke. Lean: that's what Claude Code is for. Ranks does not host interactive sessions, and resisting that is how it stays small.

## §10. Relationship to the Vimes record

Decisions that carry forward with their reasoning intact: D46 (fresh dispatch — now the definition of a room), D48 (plan as artifact — now a report), D53 (no chaining without a human — now the human room), D67 (capability model — now `tool_grant`), D70/D72 (engine vs tenant — a room kind is an extension), D82's principle (process vs work — attempt status vs report), and the S9·4 shape-not-truth boundary. The decomposition library carries whole; nac, prompter, and the three authoring-loop decompositions become the primary references.

Decisions void by construction: D10, D78-as-a-pillar (it is now the whole phone), D79, D81, D83, and every D-record about the session surface, the tree, or PTY hosting.

**Working title.** *Ranks* — the Watch in formation. Vimes was the copper who walked every street himself; this is the same Watch, drilled. Rename at will.

---
*This note exists to be re-read after the park, not to start a build. If it still reads right in two weeks on a competitor's tool, the cut is correct. If it reads as a rebuild fantasy, that is also useful to know.*
