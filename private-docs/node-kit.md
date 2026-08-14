# The node kit — the workflow-definition shape (S9·4)

**SIGNED 2026-08-06 (D71) — the standing reference.**

Written 2026-08-05 as the S9·4 deliverable of the slice-9 extension-engine
design pass (D70). It answers pass scope question 5 — the node kit, absorbed
from the former D51 pass — and it is where **the pass's kill criterion is
tested**: the kit is proven on paper against BOTH named tenants before it is
signed, because one tenant proves nothing about generality (slice-9.md).

It builds on three settled things and adds nothing to them:

- **architecture.md E1-d** — the engine owns `dispatch(sessionSpec) → completion
  events`; the extension owns everything that decides WHAT and WHEN.
- **architecture.md E2** — one node table, write-once provenance, the three
  orthogonal axes (closure / kill / removal), aggregation counting processes.
- **extension-model.md §2** — the manifest. This document fills its reserved
  `[[node-kinds]]` slot (§2.1) and is bound by every rule in it: everything the
  kit declares must be parseable, listable and refusable **without executing
  anything the extension shipped**, and no declaration may carry authority.

**Nothing here builds anything.** Every schema element is a reservation; every
boundary claim is a proposal for Wes to sign, reject or amend in S9·6.

The tenant mappings are graded against the real repos, cited by path:
`packages/core/src/tasks/*` + `packages/daemon/src/taskDispatcher.ts` for tenant
1, and `~/projects/content/book-genesis` for tenant 2. Both were read in full
while writing (rule 0.7 applied to our own artifacts — the code and the skills
are the authority, not the summaries).

---

## §0. What a workflow is, in one paragraph

A **workflow** is a named graph of **nodes** and **edges** that an extension
declares. An **instance** of that workflow (a task, a book, a chapter) sits at
exactly one node at a time, pins the workflow revision it was created under, and
moves only by a **proposal** the engine adjudicates against the pinned
definition. A node may hand its work to a **dispatched session** — the engine
spawns it (E1-d), the node's declaration says what briefing and which tools it
gets, and the node's **acceptance** says what "satisfied" looks like when the
run reports back. That is the whole vocabulary. Everything below is the shape of
those declarations and the proof that both tenants fit inside them.

The one rule carried in from D70 and §0 of the manifest, restated because the
kit is where it is easiest to break:

> **Extensions propose, the engine's deterministic core decides.**

Applied here it has a sharp consequence: **the legality table is engine-owned
data, not extension code.** Today `proposeTransition`
(`packages/core/src/tasks/taskStateMachine.ts:222`) adjudicates against
`TASK_STAGE_EDGES` (`:86`) — a table compiled into the engine. The kit's whole
job is to move that table out of the engine's source and into an extension's
declaration **without moving the adjudication with it**.

---

## §1. The kit

### 1.1 Three declarations, and why they are three

| Declaration | What it is | Where it lives |
|---|---|---|
| `[[node-kinds]]` | reusable **property bundles** — the mechanics a node may compose | the extension's manifest |
| `[[workflows]]` + `[[workflows.nodes]]` | the graph's vertices: each names a kind and overrides it | the extension's manifest |
| `[[workflows.edges]]` | the legality table: who may propose which move | the extension's manifest |

D51's sketch (open-questions.md, 2026-07-29, Wes + Fable) pinned the shape this
follows: *"Nodes pick from a KIT OF KINDS; config supplies the rest… Custom
nodes cannot invent mechanics — they compose them."* The kit takes that
literally:

> **Mechanics are a CLOSED vocabulary; kind names are OPEN.** The engine
> validates a fixed set of node *properties* (does a session attach, does entry
> dispatch, what acceptance shape, which tools, which isolation). It has no
> opinion about what an extension calls a bundle of them. `work`, `review` and
> `hold` are the names the **tasks extension** declares (D51's lineage); Book
> Genesis declares its own and gets identical mechanics.

This is what keeps the engine tenant-blind. An engine that shipped a `review`
*kind* would know a tenant word; an engine that ships `acceptance.kind =
"rubric"` knows only that some workflows judge structured reports.

### 1.2 `[[node-kinds]]` — the property bundle

```toml
[[node-kinds]]
id                = "review"
attaches_session  = true        # does entering this node run a performer?
terminal          = false       # may an instance rest here forever with no out-edge?
dispatch_on_entry = { enabled = false }        # see 1.5
isolation         = "inherit"   # "inherit" | "shared" | "worktree"  (see 1.6)
permission_mode   = "default"   # engine-known spawn mode; "plan" opts into capture
attention         = "attention.v1.needs-human" # E2-b rank claimed while resting here
```

Every field is optional with a **fail-closed default**: a kind that declares
nothing attaches no session, dispatches nothing, is not terminal, inherits
isolation, and claims no attention rank. A property the engine does not
recognise is a manifest error, exactly as an unknown capability is (§5.3 rule 1)
— a node kind is the one place where "degrade quietly" would mean running work
under mechanics nobody declared.

**`attaches_session` is the load-bearing one.** It is the difference between a
node that spends the operator's usage window and a node that waits. `hold` nodes
(`plan-ready`, `blocked-external`, a book's checkpoint) attach nothing; the
engine will refuse a dispatch proposal into them with the generic reason
`node-attaches-no-session` — today's `stage-not-dispatchable`
(`dispatchDecision.ts:137`) with the tenant word taken out.

### 1.3 `[[workflows]]` and `[[workflows.nodes]]`

```toml
[[workflows]]
id       = "software"
title    = "Software task"
initial  = "backlog"                      # where a new instance starts
record   = "schemas/task-record.json"     # the instance payload's schema (1.7)

[[workflows.nodes]]
id      = "implementing"
kind    = "work"                          # from [[node-kinds]]; properties inherited
title   = "Implementing"
# any [[node-kinds]] property may be overridden here; nothing else may appear
```

**A workflow revision is minted from the manifest hash.** D51's sketch asked for
event-sourced workflow definitions with instances pinning the rev they were
created under, so that redefining a workflow never orphans a mid-flight
instance. That machinery already exists one layer up: §5.1's grant model pins
approval **to the exact manifest content hash**. The proposal is to reuse it —
the engine mints `workflow_rev` when an activated extension's manifest hash
changes, and an instance stores `(extension_id, workflow_id, workflow_rev)`.
Nothing new to build; the same property (`workOrderRev`,
`workOrder.ts:48`) that already keeps a stage run honest about which revision it
was dispatched against.

**Adjudication is against the PINNED rev, always.** An in-flight instance is
judged by the definition it was created under, never by the one on disk today.
This is the same discipline as the manifest re-parse rule (§2.10) pointed at a
different hazard: re-reading declarations per use is right for *what an
extension offers*; pinning is right for *what an instance is being judged by*.

### 1.4 `[[workflows.edges]]` — the legality table, declared

```toml
[[workflows.edges]]
from = "implementing"
to   = "review"
by   = ["dispatcher"]      # WHO may propose this move — engine-stamped, never payload

[[workflows.edges]]
from = "review"
to    = "implementing"
by    = ["dispatcher", "human", "orchestrator"]
max_traversals = 3                       # bounded loop (1.4.2)
on_exhausted   = "manual-review"

[[workflows.edges]]
from = "*"                               # wildcard source (1.4.3)
to   = "cancelled"
except_from = ["done"]
by   = ["human", "orchestrator"]
```

*(Encoding note: `[[workflows.edges]]` headers and an `edges = [ {…}, … ]` array
of inline tables under `[[workflows]]` are the same data, and §1.9 uses the
second because a legality table wants to be read as a table. The bare-key form
must sit before the `[[workflows.nodes]]` run or TOML binds it to the last node —
the ordering hazard §2.1 of the manifest already calls out for `capabilities`.)*

**1.4.1 `by` is the #13 rule made structural.** The engine stamps the proposer
from the channel the proposal arrived on — human command, agent tool call,
extension worker, engine-internal dispatcher — exactly as
`transitionProposedBySchema` does today (`taskStateMachine.ts:147`). `by` is
therefore an **allow-list matched against a value the caller cannot set**, and
it is matched positively, never as a negation. That is not a style note: the
comment at `dispatchDecision.ts:99` records why — *"the negated form reads
identically today and fails open tomorrow"* — and a declarative edge table makes
that failure mode cheaper to introduce and harder to see. Positive matching is
pinned here as a kit property, not left to each author.

**1.4.2 Bounded loops.** `max_traversals` counts, per instance, how many times
this edge has been taken; on the count being exhausted the proposal is refused
and the engine routes to `on_exhausted` instead. **The counter is engine-owned**
— an extension counting its own cycles and reporting "cycle 3, escalate" would
be authority in a payload. Both tenants want this (§2 A-11, §3 B-9), which is
why it is in the kit rather than in one of them.

**1.4.3 Wildcards.** `from = "*"` with `except_from` exists because the honest
alternative is seven identical rows: `cancelled` is reachable from every
non-`done` stage today (`taskStateMachine.ts:90-120`). A wildcard row is
expanded at parse time and listed expanded, so the inspectable artifact is still
the full table.

**Expansion never yields a self-edge (`from == to`)**, and this is a parse-time
property rather than a runtime one: self-moves are refused by the `same-node`
precedence rule regardless (`taskStateMachine.ts:238`), but a wildcard that
expanded into `cancelled → cancelled` would put a phantom edge in the *listed*
table, and the listing is the artifact a reviewer reads. Pinned here because
§1.9's exact match against `TASK_STAGE_EDGES` depends on it.

**1.4.4 Forbidden edges carry their own reason.** An absent edge refuses with
the generic `illegal-edge`. That is right for a typo and **wrong for a safety
rule**: `quarantined → done` is deliberately absent and its refusal is
`quarantined-cannot-complete`, precedence-ordered above the generic table lookup
so that *"the safety rule that keeps a quarantined run from silently passing
would report as a bland `illegal-edge`, indistinguishable from a typo"*
(`taskStateMachine.ts:210-217`). The kit keeps that property:

```toml
[[workflows.forbidden]]
from   = "quarantined"
to     = "done"
reason = "quarantined-cannot-complete"
```

A forbidden row is checked **before** the edge table, and its `reason` is the
refusal the engine records. The engine still does not know what "quarantined"
means; it knows that this workflow named this refusal.

### 1.5 Auto-dispatch — the flag is the extension's, the execution is the engine's

```toml
dispatch_on_entry = { enabled = true, by = ["human", "orchestrator"] }
```

Trial finding 2 (slice-8.md) recorded the future this fills: *"Review does not
auto-dispatch, BY DESIGN (D53 anti-chaining)… future = D51's per-node
auto-dispatch flag, the extension author's choice."*

The declaration has two halves and **both are needed**, because D53's rule is
not "does this node dispatch" but "does this node dispatch *when entered this
way*":

- `enabled` — entering this node starts its work.
- `by` — which **proposer classes** trigger it. This is where "no chaining"
  lives: `dispatcher` (an outcome the work reported about itself) is absent, so
  a completion report never starts a reviewer and a bounced verdict never starts
  a fixer. Today that is `shouldDispatchOnTransition`
  (`dispatchDecision.ts:120`); under the kit it is two names in a list, matched
  positively (1.4.1).

**Principle 13 in both directions** (design-principles #13; the work order's
phrasing): the extension owns the *decision to flag it*; the engine owns
*whether it happens now* — meter gates, the live-run guard, the per-instance
in-flight lock (D54) and the isolation resolution all stay engine-side and can
still refuse. A node that declares `dispatch_on_entry` is asking, not
instructing. `decideDispatch` (`dispatchDecision.ts:259`) survives the migration
almost verbatim: its refusal vocabulary (`already-running`,
`headroom-insufficient`, `headroom-unknown`) is workflow-blind already, and only
`stage-not-dispatchable` needs the rename of 1.2.

**What is NOT declarable, deliberately:** the in-flight lock's existence and
granularity (one live run per instance — `taskDispatcher.ts:387`, D54) and the
no-fallback rule on failed isolation (`taskDispatcher.ts:474ff`: an isolated run
that quietly executes in the shared root is the hazard isolation exists to
remove). Both are engine invariants; an extension that could switch them off
could reintroduce a double-spawn or a silent shared-tree run, and neither is a
workflow opinion.

### 1.6 Binding to the tree, isolation, and the staleness guard

**One instance, one tree node.** A workflow instance is bound at creation to an
E2 node under its project; every run the instance dispatches attaches as a
session leaf under it. Aggregation (E2-b) then works on instances for free, and
it counts processes, not open nodes — unchanged.

**Isolation is a proposal, and the engine does git** (E2-c, principle 13 applied
to the filesystem):

```toml
isolation = "worktree"     # "inherit" (default) | "shared" | "worktree"
```

A node declaring `worktree` causes the engine, at dispatch, to create a
**worktree-backed child node** under the instance's node — write-once
provenance, `create`-vs-`open` kept distinct, removal gated on resumable
sessions. The extension never issues a git command and never names a path; it
names an intent. `shared` means the instance's own node directory, which is
today's `projectRootWorkingDirectory` (`taskDispatcher.ts:94`).

**The staleness guard (trial finding 5) is an engine dispatch-time check against
node provenance**, and the kit gives it its input as a **dispatch-spec field**,
not as extension payload:

```toml
# on the dispatch spec (E1-d), beside the reserved `confinement` table (§5.4)
requires_paths = ["src/MemoryService.ts", "src/index.ts"]
```

Finding 5's shape, restated: a task declared `isolation: worktree` for code that
existed only as uncommitted work; had isolation been built, the dispatcher would
have checked out HEAD and *"the task's subject would not exist"*. The finding
put the guard **in the dispatcher, not in authoring doctrine**, because the
authoring orchestrator cannot be blamed for a field that is schema-boilerplate
to it. The kit honours that placement exactly: `requires_paths` is a list the
proposer supplies, and the **engine** resolves it against the node's checkout
base and **fails loud before spawning**. The engine is answering a git question
about a checkout it created — the one thing it is unambiguously the authority
on. It never learns why those paths matter.

Symbol-level checking ("`searchMany()` is absent at HEAD") is **explicitly out
of v1**: paths are a git-native question, symbols are a language question, and
an engine that parses TypeScript to grade a dispatch is an engine that has
learned a tenant's language. Named here so the narrower guard is understood as a
choice.

### 1.7 Records — what the kit forces into existence (advances §4.2 q6)

The manifest's largest open question was *"where does an extension's own RECORD
live?"* — overlays decorate an engine object with one value and cannot hold a
work order. The kit cannot be specified without answering it, because a workflow
instance IS a record. The answer proposed here is **q6 option (a), narrowed to
three shapes**:

| Shape | Owner | Engine's knowledge of it |
|---|---|---|
| **Workflow definition** | the manifest (pinned by hash, 1.3) | full — it is kit vocabulary |
| **Workflow instance** | the engine's **core fields** + an extension **payload** | core fields fully; payload only as a shape it validates |
| **Reports** | the acceptance evidence a run files (1.8) | validated against the node's declared acceptance shape; never interpreted |

**The instance's engine-owned core** is exactly what adjudication and generic
rendering need, and nothing more:

```
instance_id · project · tree node · workflow (extension id, workflow id, rev)
current node · node history (with proposer + timestamp per move)
edge traversal counts (1.4.2) · attempt counter per node · payload rev
attached sessions · created_by (channel-stamped) · closed/terminal state
```

**The payload is opaque and schema-declared** (`record = "schemas/…json"`). The
engine validates it on write, versions it (the `workOrderRev` pattern
generalised: a payload edit mints a rev; runs pin the rev they were dispatched
against — `workOrder.ts:48`), fans it out, and never reads a field of it to
decide anything.

Why option (a) rather than "each extension keeps its own store": a board that no
client can render without a bespoke round trip is not a board. Book Genesis's
`STATE.yaml` (`agents/book-orchestrator.md:281-343`) is the worked case —
phase, chapter list with per-chapter status, score dimensions, revision-cycle
count. Half of that is instance core (current node, attempt/cycle counts, node
history) and half is payload (genre, language, comp titles, engagement type).
Under option (b) the whole thing is invisible to every client. Under (a) the
core renders generically and the payload renders through the extension's own
pane (§2.6).

**This is an addendum candidate to E4's list (a ninth item)**, as §4.2 q6 says —
and it is the single place the node kit makes the engine bigger. It should be
walked with Wes explicitly, because it decides how much engine the extension
model implies.

### 1.8 Stage briefings and acceptance

**1.8.1 The briefing is a declared INPUT SET plus an extension composer.**

```toml
[workflows.nodes.briefing]
composer = "briefings/implementing"        # extension entry point (Tier 1 handler / Tier 2 route)
inputs   = [
  "instance.record",                       # the payload at its pinned rev
  "artifact:plan",                         # a blob the instance references
  "report:last-review",                    # the last filed report of a named kind
  "report:last-completion",
  "doctrine/implementing.md",              # an extension-relative artifact
]
tools    = ["vimes_report.report_completion"]
permission_mode = "default"
capture  = []                              # or ["plan"] — see 1.8.3
```

The split is deliberate and it is the opposite of the obvious design:

- **The prose is code.** `composeStageInstruction`
  (`stageInstruction.ts:163`) is 500 lines of load-bearing English with
  byte-stable prefixes and suffixes maintained for prompt-cache hits
  (`:74`, `:102`, `:125`, `:133`, `:141`, `:153`), an absent-stays-absent
  degrade rule, and a fix-seed whose ordering is fixed so two dispatches of one
  task stay comparable. Making that declarative would destroy the artifact and
  gain nothing: nobody diffs a briefing template for security.
- **The INPUTS are the security surface.** What a performer is *handed* is
  exactly what tenant 2 needs to be inspectable (§3.2 point 1: briefing DENIAL).
  So `inputs` is a **closed allow-list from a closed vocabulary of input kinds**
  — the engine hands the composer these and nothing else, and a reader of the
  manifest can see what a node's performer can possibly have been given.

**Denial is the complement of an allow-list, and that is the whole trick.** Book
Genesis's central architectural claim is that the writer never sees the scoring
rubric and the evaluator never saw the writing instructions
(`skills/beta-reader/SKILL.md:6-31`; `agents/book-orchestrator.md:84-103`).
There is no `withhold` field in the kit, because a deny-list is unfalsifiable
and an allow-list is not. Two honest limits, stated rather than discovered:

1. **This is a composition guarantee, not containment.** A dispatched session
   holds a real tool with real filesystem reach; nothing stops a writer session
   from reading `skills/beta-reader/SKILL.md` off disk. Containment is the
   reserved `confinement` field (§5.4), **off by default**. The kit's allow-list
   makes withholding *declared and reviewable*; only confinement would make it
   *enforced*. Same class as the `fs.*`/`net` honesty note in §5.3 and named for
   the same reason.
2. **Tier matters.** At Tier 2 the input set is what crosses the process
   boundary, so the allow-list is mechanically enforced by the engine handing
   over nothing else. At Tier 1 an in-process module can reach anything the
   daemon can. Tenant 2 — the tenant that needs denial — is the Tier-2 tenant
   (§1.3 of the manifest), so it gets the enforced half. That is luck expressed
   as a property, and it should be recorded as a reason to keep Book Genesis at
   Tier 2 rather than "promoting" it later.

**1.8.2 `tools` retires the `offered_when` predicate (advances §4.2 q7).**

D55 is shipped behaviour: report tools are offered **per stage**, because an
offered tool under plan mode fires a human gate and an unattended planner then
waits forever. §2.4 reserved `offered_when` as an opaque predicate string and
flagged the strain: *"a predicate over extension state that the engine must
evaluate to decide what to mount is exactly the kind of thing that grows into a
language."*

**The proposal: there is no predicate, and there never needs to be one.** Every
real exposure decision in either tenant resolves into one of two facts, both of
which the engine already holds without evaluating anything:

- **A dispatched session** gets the tools its node declared (`briefing.tools`).
  The engine mounts them at spawn because it just spawned the session into that
  node. D55's matrix — planning → nothing, implementing → `report_completion`,
  review → `report_review` — becomes three `tools` lists. The fail-open-to-
  guarded fallback for an unrecognised stage disappears with the condition that
  needed it.
- **A standing entity or a human client** gets the verbs it was **granted**
  (D56: *"verbs are GRANTS on the standing entity"*; §5.3's `verbs.register`
  gates the agent face). A grant is a stored fact, not a predicate.

**DEFAULT TAKEN:** retire `offered_when` from `[[verbs]]` and let node-declared
`tools` + entity grants carry the whole job. This is an **amendment to a
reserved field in §2.4** and therefore Wes's call, not this document's — but
answering "what grammar?" with "none, and here is why the question dissolves" is
the answer S9·4 was handed the question to produce.

**1.8.3 `capture` — opting into an engine interception.**

D48's plan boundary is not a tool call. The engine intercepts `ExitPlanMode` at
the `canUseTool` seam, hashes `input.plan` into the artifact store, and **denies
the tool to stop the session cleanly** — deny-and-harvest. That is an engine
capability (it lives below the adapter line, in the same territory as rule 0.8),
and the kit's job is to let a node opt into it:

```toml
permission_mode = "plan"
capture         = ["plan"]      # from a CLOSED, engine-shipped catalogue
```

A captured artifact satisfies an `artifact` acceptance (1.8.4 (d)) through the
reserved `capture:<name>` reference — which is why the planning node in §1.9
needs no acceptance kind of its own, and why the kit does not grow a
`kind = "capture"` for one tenant's boundary.

The honest note: **the catalogue is engine surface, and v1 has exactly one entry
in it.** An extension can opt into an interception; it cannot add one. That is a
real limit and it is recorded as a bend (A-4) rather than sold as generality.

**1.8.4 Acceptance shapes.** Four kinds, plus none. This is where the two
tenants diverge hardest and where the kit either carries both or has been
designed for one.

Six alternative bodies for **one** `[workflows.nodes.acceptance]` table — a node
declares exactly one of them:

```toml
# (a) RUBRIC — criterion-keyed structured report; the task machine's shape
[workflows.nodes.acceptance]
kind          = "rubric"
report        = "vimes_report.report_review"
criteria_from = "instance.acceptanceCriteria"    # where the criterion ids live
coverage      = "all-criteria-pass"              # closed vocabulary
unlisted_ids  = "ignore"                         # see below
on_pass       = "done"
on_fail       = "implementing"
```

```toml
# (b) SCALAR — named dimensions, an aggregation, a threshold; Book Genesis's shape
[workflows.nodes.acceptance]
kind       = "scalar"
report     = "book_report.evaluation"
dimensions = ["originality","theme","characters","prose_voice","pacing","emotion","dimension_7"]
aggregate  = "min"                # "min" IS the floor rule
threshold  = 7.5                  # the EXTENSION's number, not an engine band
evidence_required = true          # every dimension must carry a non-empty citation
on_pass    = "deliver"
on_fail    = "revise"
```

```toml
# (c) HUMAN-GATE — the engine's own gate/question surface answers it
[workflows.nodes.acceptance]
kind      = "human-gate"
prompt    = "briefings/checkpoint-1.md"
on_answer = { approve = "write", revise = "foundation" }
```

```toml
# (d) ARTIFACT — declared outputs exist
[workflows.nodes.acceptance]
kind     = "artifact"
requires = ["research/market-research.md", "research/bestseller-dna.md"]
on_pass  = "personas"
```

```toml
# (e) REPORT — a valid report of the declared kind was filed; no verdict is
#     derived from its contents. The degenerate case of (a), and D53's
#     "outcomes are reports": implementing → review is satisfied by the
#     existence of a schema-valid report_completion, not by judging it.
[workflows.nodes.acceptance]
kind    = "report"
report  = "vimes_report.report_completion"
on_pass = "review"
```

**(f) NONE** — the table is absent entirely: the node rests, and something
proposes the move (every hold node, and `[[workflows.nodes]] id = "review"`'s
holding-pen sibling before a reviewer is dispatched).

Four properties make these safe under 0.3 and #13:

1. **The engine evaluates the DECLARED shape and routes.** `deriveReviewOutcome`
   (`reviewOutcome.ts:22`) becomes `kind = "rubric"` with
   `coverage = "all-criteria-pass"`: any reported `fail` → `on_fail`; every task
   criterion covered by a reported `pass` → `on_pass`; a bare instance with no
   criteria is vacuously covered. `unlisted_ids = "ignore"` pins the nuance that
   an extra reported id neither blocks nor forces completion — an option in the
   vocabulary because leaving it implicit changes behaviour silently.
2. **The report is validated, never trusted.** The report verb's `input` schema
   already may not carry `approved` / `authority` / `proposed_by` (§2.4 rule 1).
   The acceptance shape adds the second half: the engine checks the report has
   the declared dimensions/criteria and, where declared, non-empty evidence. It
   checks **shape, not truth** — see the limit in §4.
3. **Thresholds are extension content, not engine ⟨tune⟩s.** `threshold = 7.5`
   is Book Genesis's own number (`skills/book-genesis/SKILL.md:242-249`), and
   rule 0.2's calibrate-then-pin discipline binds *engine* bands (the watchdog's
   staleness window, backoff curves), not a tenant's editorial bar. Stated
   because a reviewer seeing a bare number in a manifest should know which kind
   it is.
4. **Anything richer stays a proposal.** A workflow may leave `on_pass`/`on_fail`
   unset and let its extension propose the move instead. The engine then
   adjudicates the **edge** rather than the **verdict** — which is the correct
   fallback for every judgement too rich to declare (§3, B-4).

### 1.9 The reserved `[[node-kinds]]` slot, filled — the tasks extension in full

This is the concrete TOML the manifest's §2.1 stub reserved. Compare against
`taskStateMachine.ts:86` — the table is the same table.

**Checked mechanically while writing, and the check found four errors in the
first draft.** The block below was parsed as TOML, its wildcard rows expanded,
its `[[workflows.forbidden]]` row subtracted, and the result diffed against
`TASK_STAGE_EDGES`: it now reproduces the shipped table **exactly**, node for
node and edge for edge, with `manual-review` — and its three out-edges, one of
which arrives through the cancel wildcard — as the only addition. The first
draft silently lost `planning → backlog` and `plan-ready → backlog` and silently
invented `blocked-external → quarantined` and `cancelled → blocked-external` —
which is the honest argument for the kit as a whole, and against hand-writing
edge tables: a legality table written as prose *looks* right while being wrong,
and only a diff against the machine says otherwise. Whatever ships as the
migration must carry that diff as a test.

```toml
# ── node kinds: the property bundles this extension composes ────────────────
[[node-kinds]]
id = "work"
attaches_session  = true
dispatch_on_entry = { enabled = true, by = ["human", "orchestrator"] }
isolation         = "worktree"

[[node-kinds]]
id = "review"
attaches_session  = true
dispatch_on_entry = { enabled = false }     # D53: review is a HOLDING PEN
isolation         = "inherit"
attention         = "attention.v1.needs-human"

[[node-kinds]]
id = "hold"
attaches_session  = false

[[node-kinds]]
id = "closed"
attaches_session  = false
terminal          = true

# ── the workflow ────────────────────────────────────────────────────────────
[[workflows]]
id      = "software"
title   = "Software task"
initial = "backlog"
record  = "schemas/task-record.json"

# ── edges: TASK_STAGE_EDGES, declared ───────────────────────────────────────
# ⚠ THE PLACEMENT IS LOAD-BEARING. These are bare keys, so they bind to the most
# recently opened table — they must sit HERE, under [[workflows]], and never
# after the [[workflows.nodes]] run below, where they would silently become
# properties of the LAST node. Same TOML hazard §2.1 of the manifest calls out
# for `capabilities`. Written as arrays of inline tables because the edge table
# is the artifact a reviewer reads (`taskStateMachine.ts:47-51`); a run of
# [[workflows.edges]] headers carries identical data.
edges = [
  # the spine
  { from = "backlog",      to = "planning",     by = ["human", "orchestrator"] },
  { from = "planning",     to = "plan-ready",   by = ["dispatcher"] },
  { from = "planning",     to = "backlog",      by = ["human", "orchestrator"] },
  { from = "plan-ready",   to = "implementing", by = ["human", "orchestrator"] },
  { from = "plan-ready",   to = "planning",     by = ["human", "orchestrator"] },
  { from = "plan-ready",   to = "backlog",      by = ["human", "orchestrator"] },
  { from = "implementing", to = "review",       by = ["dispatcher"] },
  { from = "review",       to = "done",         by = ["dispatcher", "human"] },
  # the review/fix loop, bounded — its exhaustion is the convergence exit
  { from = "review", to = "implementing", by = ["dispatcher", "human", "orchestrator"], max_traversals = 3, on_exhausted = "manual-review" },
  # quarantine: reachable ONLY from nodes that attach a session, because the
  # watchdog governs live runs and nothing else (WATCHDOG_GOVERNED_LIVENESS)
  { from = "planning",     to = "quarantined",  by = ["watchdog"] },
  { from = "implementing", to = "quarantined",  by = ["watchdog"] },
  { from = "review",       to = "quarantined",  by = ["watchdog"] },
  { from = "quarantined",  to = "backlog",      by = ["human", "orchestrator"] },
  { from = "quarantined",  to = "planning",     by = ["human", "orchestrator"] },
  { from = "quarantined",  to = "implementing", by = ["human", "orchestrator"] },
  # the park, permissive by design: unblocking NAMES the node to resume into
  { from = "*", to = "blocked-external", except_from = ["done", "cancelled", "manual-review"], by = ["human", "orchestrator"] },
  { from = "blocked-external", to = "*", except_to = ["done", "blocked-external", "quarantined", "manual-review"], by = ["human", "orchestrator"] },
  # the give-up that can be undone
  { from = "*", to = "cancelled", except_from = ["done"], by = ["human", "orchestrator"] },
  { from = "cancelled", to = "backlog", by = ["human", "orchestrator"] },
  # the convergence exit's own out-edges (the one node this table adds)
  { from = "manual-review", to = "done",         by = ["human"] },
  { from = "manual-review", to = "implementing", by = ["human", "orchestrator"] },
]

forbidden = [
  { from = "quarantined", to = "done", reason = "quarantined-cannot-complete" },
]

# ── the nodes ───────────────────────────────────────────────────────────────
[[workflows.nodes]]
id = "backlog"
kind = "hold"

[[workflows.nodes]]
id = "planning"
kind = "work"
permission_mode = "plan"                    # D48
  [workflows.nodes.briefing]
  composer = "briefings/planning"
  inputs   = ["instance.record", "doctrine/planning.md"]
  tools    = []                             # D55: planning is offered NOTHING
  capture  = ["plan"]                       # deny-and-harvest at the plan boundary
  [workflows.nodes.acceptance]
  kind     = "artifact"                     # the captured plan IS the deliverable
  requires = ["capture:plan"]               # satisfied by 1.8.3's interception
  on_pass  = "plan-ready"

[[workflows.nodes]]
id = "plan-ready"
kind = "hold"                                # awaits a promotion DECISION

[[workflows.nodes]]
id = "implementing"
kind = "work"
  [workflows.nodes.briefing]
  composer = "briefings/implementing"
  inputs   = ["instance.record", "artifact:plan",
              "report:last-review", "report:last-completion",
              "doctrine/implementing.md"]
  tools    = ["vimes_report.report_completion"]
  [workflows.nodes.acceptance]
  kind    = "report"                        # the report IS the outcome (D53)
  report  = "vimes_report.report_completion"
  on_pass = "review"

[[workflows.nodes]]
id = "review"
kind = "review"
  [workflows.nodes.briefing]
  composer = "briefings/review"
  inputs   = ["instance.record", "doctrine/review.md"]
  tools    = ["vimes_report.report_review"]
  [workflows.nodes.acceptance]
  kind          = "rubric"
  report        = "vimes_report.report_review"
  criteria_from = "instance.acceptanceCriteria"
  coverage      = "all-criteria-pass"
  unlisted_ids  = "ignore"
  on_pass       = "done"
  on_fail       = "implementing"

[[workflows.nodes]]
id = "done"
kind = "closed"

[[workflows.nodes]]
id = "manual-review"                        # the convergence exit (see A-11)
kind = "hold"
attention = "attention.v1.needs-human"

[[workflows.nodes]]
id = "blocked-external"
kind = "hold"

[[workflows.nodes]]
id = "quarantined"
kind = "hold"
attention = "attention.v1.blocked"

[[workflows.nodes]]
id = "cancelled"
kind = "hold"
```

Three things to notice, because they are the migration's real content:

- **`manual-review` has no in-edge, and that is correct.** It is reachable only
  through `on_exhausted` on the bounded review/fix loop — a route the engine
  takes when a proposal is refused, not a move anyone may propose. Which means
  the kit needs one validation rule it would otherwise lack: **reachability is
  checked over edges *plus* `on_exhausted`/`on_pass`/`on_fail` targets**, or a
  perfectly correct workflow lists as having an orphan node.
  Its out-edges are three, not the two written explicitly: **`manual-review →
  cancelled` arrives through the `* → cancelled` wildcard, and it is kept
  deliberately** — the give-up that can be undone applies to the convergence
  exit too, and a task that failed to converge is exactly the kind a human
  abandons. Named here rather than left as wildcard fallout, because an edge
  nobody declared is an edge nobody reviewed.

- **`by=["watchdog"]` is a proposer class that does not exist today.** The
  watchdog currently emits `task_quarantined` through the dispatcher's proposer
  value. Under the kit it needs its own stamp, or the fail-closed promoter match
  (`dispatchDecision.ts:99`, "a fourth `TransitionProposedBy` … would start
  spawning Claude processes the moment it was added to the enum") becomes a live
  hazard rather than a documented one. Naming the class in the edge table is
  what makes the addition reviewable.
- **The vocabulary that survives the migration unchanged** is larger than the
  part that moves: refusal precedence (`unknown-node`, `same-node`,
  `terminal-node`, forbidden, illegal-edge), the never-throw totality rule, the
  never-mutate rule, and the requirement that a rejection is **evented** — *"an
  unrecorded rejection is, as far as I7 is concerned, a rejection that never
  happened"* (`taskStateMachine.ts:12`). All of it is workflow-blind already.

### 1.10 The carve-out test, stated as a standing rule

The kill criterion asks whether either tenant needs the engine to know something
tenant-specific. The rule that makes that checkable after this pass, not only
during it:

> **The engine's source may not contain a tenant's word.** No `task`, no
> `chapter`, no `review`, no `Genesis`. Every workflow noun reaches the engine as
> a declaration it validates, an id it stores, or a payload it fans out
> unread. A grep of `packages/core` for a tenant's vocabulary, post-migration,
> is the assertable form of this document's verdict.

---

## §2. Tenant mapping A — the task machine, complete

Graded against the shipped code, not against the docs' description of it.

| # | Today's feature | Kit expression | Fit |
|---|---|---|---|
| A-1 | Nine stages (`schemas.ts:225-233`) | nine `[[workflows.nodes]]` over four kinds | **clean** |
| A-2 | `TASK_STAGE_EDGES` + `isLegalTaskEdge` (`taskStateMachine.ts:86,125`) | `[[workflows.edges]]`, adjudicated against the pinned rev | **clean** |
| A-3 | `done` terminal; reopening mints a new task | `kind = "closed"`, `terminal = true`, no out-edges | **clean** |
| A-4 | `quarantined → done` absent with its own named refusal (`:248`) | `[[workflows.forbidden]]` with `reason` (1.4.4) | **bends** — needed a kit field that exists only because this refusal exists |
| A-5 | `cancelled` reachable from 7 stages, recovers only to `backlog` | one wildcard row + `except_from` | **bends** — clean only because 1.4.3 added wildcards; seven rows otherwise |
| A-6 | `blocked-external` is a permissive park | wildcard `to = "*"` with `except_to` | **clean** |
| A-7 | `DISPATCHABLE_TASK_STAGES` (`dispatchDecision.ts:47`) | `attaches_session` per node; complement derived | **clean** |
| A-8 | `shouldDispatchOnTransition` — active stage × promoter (`:120`) | `dispatch_on_entry = { enabled, by }` (1.5) | **clean** — including the fail-closed positive match |
| A-9 | D53: review is a holding pen; no chaining | `review` kind with `dispatch_on_entry.enabled = false` | **clean** |
| A-10 | D53 manual review dispatch (the orchestrator's explicit call) | the `dispatch` verb proposing a run into a node whose entry does not dispatch | **clean** |
| A-11 | `manualReviewRequired` — a flag on the transition INTO `done`, meaningless elsewhere (`taskStateMachine.ts:189`) | a distinct `manual-review` hold node reached via `on_exhausted`, **or** an overlay written on the instance | **bends** — the kit has no vocabulary for "a flag that is valid on exactly one edge and ignored on all others"; both expressions change the shape of the fact |
| A-12 | D48 plan capture: intercept `ExitPlanMode`, hash, deny-to-stop | `permission_mode = "plan"` + `capture = ["plan"]` (1.8.3) | **bends** — works only because the engine ships the interception; extensions cannot add one |
| A-13 | D55 per-stage tool exposure (planning → none) | `briefing.tools` per node (1.8.2) | **clean** — and it retires the `offered_when` predicate |
| A-14 | `composeStageInstruction` incl. the fix-seed (`stageInstruction.ts:163`) | extension composer + declared `inputs` (`report:last-review`, `report:last-completion`) | **clean** |
| A-15 | Byte-stable prefix/suffix cache discipline (`:74`, `:102`) | untouched — it lives in the composer, which stays code | **clean** |
| A-16 | `deriveReviewOutcome` (`reviewOutcome.ts:22`) | `acceptance.kind = "rubric"`, `coverage = "all-criteria-pass"` | **clean** |
| A-17 | Extra reported criterion ids are ignored for coverage (`:20`) | `unlisted_ids = "ignore"` | **bends** — a real behaviour that must be pinned in the vocabulary or it changes silently |
| A-18 | D46: every stage run is a fresh spawn; `resolveStageRunner` (`stageRunner.ts:103`) | nothing to declare — the engine always spawns fresh; a future second mode is a kit field then, not now | **clean** |
| A-19 | Run identity `(taskId, stage, attempt, workOrderRev)` (`workOrder.ts:48`) | `(instance, node, attempt, payload rev)` — instance core (1.7) | **clean** |
| A-20 | Work-order revisions + the `amend` verb | payload rev on the instance record; `amend` is an ordinary `[[verbs]]` entry | **clean** |
| A-21 | The watchdog's three D30 conditions (`watchdogDecision.ts`) | engine-owned assessment; verdict proposes the workflow's declared quarantine edge (`by = ["watchdog"]`) | **clean** |
| A-22 | Watchdog ⟨tune⟩s: `staleAfterMs`, `maxStaleRetries`, `retryBackoffMs` (`:235`) | per-workflow declaration with engine clamps | **bends** — a workflow that can widen its own staleness band can disable the guard that kills its runaway runs; clamps are proposed but their values are a Gate-D question, not this document's |
| A-23 | D54 per-task in-flight lock (`taskDispatcher.ts:387`) | engine invariant, not declarable (1.5) | **clean** |
| A-24 | Meter gates: `requireHeadroom` / `deferUntilReset` (`dispatchDecision.ts:275-319`) | instance payload fields the engine reads through a declared gate binding; refusal vocabulary is already workflow-blind | **clean** |
| A-25 | Worktree isolation (D32, `VIMES_WORKTREE_ISOLATION`) + no-fallback rule | `isolation = "worktree"` proposes; engine does git; the no-fallback rule stays an engine invariant | **clean** |
| A-26 | Trial finding 5's staleness guard (not yet built) | `requires_paths` on the dispatch spec (1.6) | **clean** — and it lands as engine vocabulary, where the finding said it belongs |
| A-27 | D56 author grant: `create_task` with server-forced fields (`workOrder.ts:163`) | a `[[verbs]]` entry with `creates = "software"`; the engine forces initial node, project and `created_by` from the channel | **clean** — §2.4's #13 parse rules already refuse the alternative |
| A-28 | The board pane + work-order pane | `[[panes]]` reading the instance core + payload (1.7) | **clean** |
| A-29 | Stage glyph on a session row | `[[overlays]]` (already reserved) keyed to the instance's current node | **clean** |
| A-30 | D51's open complaint: "the linear pipeline is not the right model" | the graph is the extension's; `backlog → implementing` is one declared edge away for a workflow that wants it | **clean** — the kit is the answer to the complaint that opened it |

**Six bends, no breaks.** The three sharpest (A-4, A-11, A-17) share one shape:
they are places where the shipped machine encodes a *fact about a specific edge*
rather than a fact about the graph. That is exactly the sediment a declarative
kit exposes, and each was cheap to carry — but each was carried by adding kit
vocabulary earned by one tenant, which is the honest thing to notice.

**One migration hazard the mapping surfaced**, recorded because D51's own
sketch named it as the pass's opening inventory item (*"semantics leakage —
behaviors that look per-stage but are load-bearing invariants"*): the surviving
leak after this kit is **`permission_mode` + `capture` + `tools` moving as a
set**. D55 exists *because* plan mode gates MCP tools; a workflow that declares
`permission_mode = "plan"` and a non-empty `tools` list has built the exact stall
D55 was written to remove. **Proposed: the engine refuses that combination at
parse time**, with the reason naming D55's observed incident. It costs one
validation rule and it is the only place in this document where the engine
enforces a relationship between two declarations rather than validating each.

---

## §3. Tenant mapping B — Book Genesis, complete

Graded against the real repo (`~/projects/content/book-genesis`), naming its
real phases, skills and gates. The pipeline is six phases and twelve skills with
two human checkpoints (`README.md:39-50`; `agents/book-orchestrator.md:37-48`),
and its architectural claim is context isolation between writer and evaluator
(`agents/book-orchestrator.md:84-103`).

**The workflow decomposition proposed.** Two workflows in one extension, because
the repo has two loops running at different rates:

- **`book`**: `research → personas → foundation → voice-dna → checkpoint-1 →
  write → evaluate-manuscript → checkpoint-2 → revise → deliver → delivered`
- **`chapter`**: `write → evaluate → revise → final`

| # | Real feature (cited) | Kit expression | Fit |
|---|---|---|---|
| B-1 | Six phases (`book-orchestrator.md:37-48`) | nodes; a phase with several skills becomes several nodes (see B-2) | **clean** |
| B-2 | Phase 2 runs three skills in a fixed order with data dependencies: personas → foundation → voice-dna (`:120-167`) | three nodes with linear edges; the dependency IS the edge | **clean** — and it removes §3.2's asserted need for a "dependency vocabulary" |
| B-3 | "Phase" as a first-class concept the user sees, and `phase.current: 1-6` in STATE.yaml (`:300-303`) | a `group` label on nodes + an `[[overlays]]` value | **bends** — the tenant's own top-level noun becomes a grouping attribute; its checkpoint attaches to the last node of the group rather than to the phase |
| B-4 | 12 skills as phase briefings (`skills/*/SKILL.md`) | `briefing.composer` + `inputs` naming the SKILL.md as an extension artifact | **clean** |
| B-5 | Writer isolation: writer gets foundation/outline/voice-dna/prev chapter and **not** the rubric (`:88-94`) | the write node's `inputs` allow-list; denial is its complement (1.8.1) | **clean as a declaration**, with the containment limit named (B-14) |
| B-6 | Evaluator isolation: evaluator never saw the writing instructions (`beta-reader/SKILL.md:6-31`) | the evaluate node's `inputs` allow-list, disjoint from the write node's | **clean** — and mechanically enforced at Tier 2 |
| B-7 | Agents as performers, dispatched per skill (`:84-103`) | dispatched sessions (E1-d); one session per node run | **clean** — and an upgrade: today's sub-agent dispatch is what D50 forbids inside VIMES, so each skill becoming its own session is a *fix*, not a compromise |
| B-8 | Checkpoint 1 (after foundation) and Checkpoint 2 (after evaluation) — *"the ONLY times you pause"* (`:23-35`) | `acceptance.kind = "human-gate"`, answered by the engine's gate/question surface (D68), routed by `on_answer` | **clean** — and it is why no `approve_foundation` verb exists (§3.2's note; a verb taking `approved = true` is refused by §2.4) |
| B-9 | Max 2 revision cycles, then the problem is structural → back to Phase 2 (`:264`; `book-genesis/SKILL.md:250-254`) | `max_traversals = 2` + `on_exhausted = "foundation"` on the revise→evaluate edge (1.4.2) | **clean** — engine-counted, which is what keeps it out of a payload |
| B-10 | Genesis floor: 7 dimensions, score = the **weakest** (`README.md:132-145`) | `acceptance.kind = "scalar"`, `aggregate = "min"` | **clean** |
| B-11 | Every score requires a textual citation (`README.md:150`) | `evidence_required = true` — the engine checks each dimension carries a non-empty citation | **clean** (shape only — see §4's limit) |
| B-12 | Phase gates as checklists: floor ≥ 7.5, CVI-Launch ≥ 7.0 (`book-genesis/SKILL.md:242-260`) | one scalar acceptance per gated node; a second threshold is a second dimension entry | **clean** |
| B-13 | −0.8 calibration; the anti-inflation protocol (`beta-reader/SKILL.md:33-47`) | briefing doctrine — extension content the performer applies | **clean placement**, honest limit: the engine cannot verify it was applied |
| B-14 | The isolation mandate as an architectural guarantee | declared, reviewable, and (Tier 2) mechanically fed — but **not contained**: a session can read the rubric off disk while `confinement` defaults off (§5.4) | **bends** — the tenant's central claim is a composition guarantee, not an enforced one |
| B-15 | Writing all N chapters (25 in *The Source Code*) | **`chapter` workflow instances**, one per chapter, created by the extension; the book's `write` node is a hold released when the extension observes all children terminal | **bends** — the largest bend in the document; see below |
| B-16 | *"Run skills in parallel when they don't depend on each other"* (`:365`) | falls out of B-15 (sibling instances are independent) — but is undeclared and unscheduled by the engine | **bends**, same bend as B-15 |
| B-17 | Regression detection: per-dimension deltas, oscillation over two cycles (`book-genesis/SKILL.md:288-303`) | extension code reading its own reports, proposing a transition the engine adjudicates | **bends** — acceptance declares thresholds, never trajectories |
| B-18 | Near-miss protocol (miss the floor by ≤0.5 on one dimension → one targeted revision) (`:305-307`) | same as B-17 | **bends** |
| B-19 | Systemic pattern detection (an issue in 3+ chapters is fixed at source, not per chapter) (`:309-327`) | extension logic across sibling instances, proposing edits to shared artifacts | **bends** — and it is the clearest case for B-15's join being declared rather than coded |
| B-20 | Loop-back: *"Casual Reader 'would not keep reading' overrides all other scores"* (`:566-572`) | a second scalar acceptance with `threshold` on one dimension, evaluated before the floor | **clean** |
| B-21 | Revision taxonomy: structural > connective > prose > factual (`:615-627`) | payload content passed into the revise node's briefing | **clean** |
| B-22 | Optional performers: entity-tracker BUILD after Phase 2 (`entity-tracker/SKILL.md:36-48`) | an optional node with `dispatch_on_entry.enabled = false`, reachable by proposal | **clean** |
| B-23 | entity-tracker UPDATE every 3–5 chapters (`:50-66`) | **not a node** — an `[[events]]` subscription on `run_completed`; the extension proposes a maintenance dispatch | **clean** — and it resolves §3.2's "conditional node" worry into two different mechanisms rather than one fuzzy one |
| B-24 | continuity-guardian / series-architect ("when needed, not every project") | same split as B-22/B-23 | **clean** |
| B-25 | `STATE.yaml` (`:281-343`) | split: instance **core** (current node, history, cycle counts, chapter statuses via child instances) + **payload** (genre, language, comp titles, engagement type, word target) — 1.7 | **clean** |
| B-26 | `ENTITY_STATE.yaml` — *"the single source of truth that other skills consume"* | **the blob service** (E1-b), not the state dir: it is read by other performers' briefings, must be replayable, and a client may render it. §2.9's rule decides it — a state dir is for what only the extension needs | **clean** |
| B-27 | `next_step` free text written at session end (`book-genesis/SKILL.md:598-613`) | payload field; the engine renders it, never reads it | **clean** |
| B-28 | Error handling: *"if a skill fails, retry once"* (`:354-360`) | the instance's per-node `attempt` counter + a `max_attempts` declaration (same machinery as 1.4.2) | **clean** |
| B-29 | Three entry modes (cold / warm / resume) (`book-genesis/SKILL.md:25-78`) | `create_instance` verb variants; resume is "an instance exists and sits at a node" — the kit's normal state | **clean** — resume stops being a mode at all |
| B-30 | The `book-orchestrator` agent itself (`agents/book-orchestrator.md`) | **dissolves into three things**: the workflow definition (phase sequencing, gates), the extension's worker (feedback synthesis, regression policy), and — optionally — the standing orchestrator (E1-e) holding granted verbs | **clean**, and it is the D70 boundary drawn through a real tenant's central artifact |
| B-31 | `maxTurns: 200` on the orchestrator agent | disappears: work is spread across dispatched sessions, each with its own budget, metered by the ledger | **clean** |

**B-15, in full, because it is the one that could have been a break.**

*The Source Code* is 25 chapters (`README.md:110`). Each is written, evaluated,
possibly revised twice — a per-chapter state machine running 25 times inside one
book. The kit has no fan-out/join vocabulary: no node says "instantiate one
child per item and complete when all children are terminal."

It is nevertheless **expressible today, with zero engine changes**: the
extension proposes 25 `chapter` instances (an ordinary `create_instance` verb),
binds them as tree children of the book's node (E2 gives that for free, and
E2-b's rollup already aggregates them), and the book's `write` node is a hold
whose release the extension proposes once it observes every child terminal. The
engine adjudicates the release edge exactly as it adjudicates any other.

So the cost is precise and small: **the join condition lives in extension code
rather than in a declaration.** Nothing about it is tenant-shaped — the task
machine wants the same shape the day a task fans out two worktree children to
try two approaches, which architecture.md already names as falling out of the
tree for free. A declared `fan_out` node is therefore a **good candidate for the
kit's second version, on a first-consumer trigger** (D11), and deliberately not
v1 vocabulary invented ahead of two consumers.

---

## §4. THE VERDICT

**Both tenants map. Neither requires an engine carve-out. The kill criterion is
not tripped.**

Stated in the criterion's own terms: there is nothing in either tenant that the
engine must *know about that tenant* in order for the tenant to work. Every
workflow noun in both mappings reaches the engine as (a) a declaration it
validates against the kit's closed vocabulary, (b) an id it stores, or (c) a
payload it fans out unread. The five gaps §3.1 listed and the five §3.2 listed
all resolve into node-kit vocabulary or into a named bend — none into a special
case in `packages/core`.

**The one thing that grew the engine** is §1.7's instance record (open question
6's option (a), narrowed): the engine gains a generic workflow-instance store
with engine-owned core fields. It is tenant-blind — the same fields serve a task
and a book — but it is honestly *more engine* than the manifest alone implied,
and §4.2 q6 already flagged that it decides how much engine the extension model
means. **It should be walked with Wes as its own thing, not swallowed inside a
verdict.**

### What is CLEAN

Stage briefings as composer-plus-declared-inputs; per-node tool exposure (which
retires the `offered_when` predicate entirely); rubric and scalar acceptance
side by side, with `min` as the floor rule; human checkpoints as engine gates
with no `approved` field anywhere; auto-dispatch with D53's fail-closed proposer
allow-list and review kept a holding pen; bounded loops with engine-owned
counters (both tenants want them); worktree isolation as a proposal with the
engine doing git; the staleness guard as a dispatch-spec field; optional
performers split cleanly into optional nodes versus event-driven maintenance
runs; blobs versus state dirs decided by §2.9's own rule; and — the result that
most surprised the mapping — Book Genesis's phase-internal sequencing needing no
dependency vocabulary at all, because a data dependency *is* an edge.

### What BENDS (expressible but awkward — each goes to Wes)

| Bend | Tenant | What is awkward |
|---|---|---|
| **A-4** forbidden-edge reasons | tasks | a named safety refusal for an *absent* edge needs its own declaration or degrades to `illegal-edge` |
| **A-5** wildcard edges | tasks | `cancelled`'s seven sources need a wildcard the kit added for them |
| **A-11** `manualReviewRequired` | tasks | a flag valid on exactly one edge has no kit vocabulary; it becomes a node or an overlay, and either changes the shape of the fact |
| **A-12** plan capture | tasks | works only via an engine-shipped, closed interception catalogue with one entry; extensions opt in, never add |
| **A-17** unlisted criterion ids | tasks | a real coverage nuance that must be pinned in the vocabulary or it changes behaviour silently |
| **A-22** watchdog bands | tasks | per-workflow ⟨tune⟩s let a workflow widen the guard that kills its own runaway runs; engine clamps proposed, values unpinned |
| **B-3** "phase" | Book Genesis | the tenant's top-level noun becomes a grouping label |
| **B-14** isolation mandate | Book Genesis | declared withholding is a *composition* guarantee, not containment (`confinement` off by default) |
| **B-15/16/19** fan-out/join | Book Genesis | 25 chapters are expressible as child instances, but the join lives in extension code; no declared fan-out in v1 |
| **B-17/18** trajectory policy | Book Genesis | acceptance declares thresholds, never trajectories; regression, oscillation and near-miss stay extension code proposing edges |

### The limit both tenants share, and neither gets from the engine

**Acceptance validates SHAPE, never TRUTH.** The engine can require that a
review reports a verdict per criterion, or that every Genesis dimension carries a
non-empty citation — it cannot know whether the reviewer actually read the diff
or whether the evaluator actually subtracted 0.8. That boundary is correct (an
engine that graded judgement would be a second judge), but it means both tenants'
quality guarantees rest on **briefing doctrine and performer behaviour**, with
the engine holding only the ledger of what was claimed. Neither tenant asked for
more; it is recorded so nobody later mistakes a validated report for a verified
one.

### The narrower-engine fallback — not taken, and why it is worth naming anyway

Had either mapping broken, the fallback slice-9.md names is *an engine that
admits it is a software-workflow host*. This document did not reach for it, and
the reason is specific rather than optimistic: the places Book Genesis strained
(scalar acceptance, bounded loops, withheld briefings, fan-out) all turned out to
have **task-machine siblings** — the `manualReviewRequired` convergence exit is a
bounded loop, D55's per-stage exposure is a withheld briefing, parallel worktree
exploration is a fan-out. Two tenants wanting the same missing thing is the
signal that the thing is vocabulary; one tenant wanting it alone would have been
the signal to narrow the engine. That test, not the absence of friction, is what
this verdict rests on.

---

## §5. Closing

### 5.1 What this reserves vs what this builds

**Builds: nothing.** In rule 0.5's framing:

- **Reserved (data shapes, landed now):** `[[node-kinds]]` as property bundles
  with a closed mechanics vocabulary and open kind names; `[[workflows]]` /
  `[[workflows.nodes]]` / `[[workflows.edges]]` / `[[workflows.forbidden]]`;
  `by` as a channel-stamped proposer allow-list; `max_traversals` +
  `on_exhausted`; wildcard rows; the briefing block (`composer`, `inputs`,
  `tools`, `permission_mode`, `capture`); the acceptance kinds (`rubric`,
  `scalar`, `human-gate`, `artifact`, `report`, none) with `coverage`, `unlisted_ids`,
  `aggregate`, `threshold`, `evidence_required`, `on_pass` / `on_fail` /
  `on_answer`; `isolation`; `requires_paths` on the dispatch spec; the workflow
  instance's engine-owned core fields and its manifest-declared payload schema;
  `workflow_rev` minted from the manifest hash.
- **Proposed (needs Wes's signature, S9·6):** the verdict itself; the
  record-store answer (§1.7, q6 option (a) narrowed); retiring `offered_when`
  (§1.8.2, an amendment to a §2.4 reserved field); the
  `permission_mode = "plan"` × non-empty `tools` parse refusal (§2's migration
  hazard); a `watchdog` proposer class in the transition vocabulary;
  reachability validated over edges **plus** `on_exhausted` / `on_pass` /
  `on_fail` targets (§1.9); and the migration carrying the declared-table-vs-
  `TASK_STAGE_EDGES` diff as a test rather than as a reading.
- **Deferred by design:** declared fan-out/join (first-consumer trigger, D11);
  symbol-level staleness checking; any second `resolveStageRunner` mode; the
  engine clamps' actual numbers (Gate-D, rule 0.2); the migration sequencing
  (S9·5); per-client rendering of workflow surfaces (S9·5).
- **Not built, and not to be built until the pass signs:** any parser, any
  workflow store, any adjudicator, any migration of `TASK_STAGE_EDGES` out of
  `packages/core`.

### 5.2 Open questions raised by this draft

Each carries the default this draft took, so the document is internally
consistent; each needs Wes (or a later unit) to confirm or overturn. Numbering
continues extension-model.md §4.2 (which ends at 12).

13. **⚠ Does the engine gain a workflow-instance store?** §1.7 says yes: engine
    core fields (current node, history, counters, attempts, pins) plus an opaque
    manifest-declared payload. This is q6's option (a), narrowed, and it is the
    single place the node kit makes the engine bigger. **DEFAULT TAKEN:** yes,
    with the core field list above as the exhaustive bound. Flagged loudly
    because it is an addendum candidate to E4's list and it decides how much
    engine the extension model implies.
14. **Is `offered_when` retired?** §1.8.2 argues the predicate grammar S9·4 was
    handed dissolves: dispatched sessions get their node's `tools`, standing
    entities get their grants. **DEFAULT TAKEN:** retire the field. It is an
    amendment to a reserved field in a settled section, so it needs an explicit
    yes rather than silence.
15. **May a workflow declare its own watchdog bands?** A-22. **DEFAULT TAKEN:**
    yes, clamped by engine-owned bounds — because tenant 2's human-gated waits
    (a checkpoint can sit for a day) and tenant 1's 15-minute machine-work band
    are genuinely different regimes, and one band cannot serve both. The clamps'
    values are ⟨tune⟩ and **unpinned** (rule 0.2): this reserves the shape only.
16. **Does the engine refuse `permission_mode = "plan"` with a non-empty
    `tools` list?** **DEFAULT TAKEN:** yes, at parse time, naming D55's observed
    incident in the message. It is the only cross-declaration validation rule in
    the kit, so it should be a conscious yes; the alternative is rediscovering
    D55 in a tenant nobody was watching.
17. **What proposer classes exist after the migration?** The edge table needs
    `watchdog` as its own stamp (§1.9), and `extension` as distinct from
    `orchestrator` is an open question the moment a Tier-2 worker proposes.
    **DEFAULT TAKEN:** the vocabulary is
    `human | orchestrator | dispatcher | watchdog | extension`, engine-stamped
    from the channel, matched positively everywhere. Flagged because
    `dispatchDecision.ts:99` already records what a silently-added value costs.
18. **Does an instance's payload edit mint a rev unconditionally?** **DEFAULT
    TAKEN:** yes — every payload write is a new rev and runs pin the rev they
    were dispatched against, generalising `workOrderRev`. The cost is rev churn
    on trivial edits; the alternative (author-declared revisions) puts a
    correctness-bearing decision in a payload, which is where #13 says it must
    not be.
19. **Where does a workflow definition's own `api_version` live?** §2.3 says
    data artifacts carry `api_version` in their own envelope. A workflow
    declared *inside* the manifest inherits the manifest's. **DEFAULT TAKEN:**
    inherit; an exported/importable workflow definition (a board template) is a
    separate artifact with its own envelope when someone first needs one.
20. **Declared fan-out.** §3 B-15. **DEFAULT TAKEN:** not in v1 — child
    instances plus an extension-coded join, because two tenants want the shape
    but only one needs it now, and D11 says the machinery waits for its
    consumer. Recorded as the kit's most likely v2 addition so that when it
    lands it is an addition, not a discovery.

    > **ANNOTATED 2026-08-11 (mateclaw-decompose §2.4; prior art, not a
    > reopening).** MateClaw ships this vocabulary as `fan_out` + **`collect`**
    > in a linear workflow DSL. Two things it contributes to the v2 addition
    > this item already anticipates:
    >
    > 1. **Shape:** the join is a *separate declared step*, not a property of
    >    the fan-out node. This item says "a declared `fan_out` node"
    >    (singular); the shipped pair is two nodes. Take the two-node shape —
    >    a `collect` that is its own node is addressable, and a fan-out whose
    >    join is a field on itself cannot express a join over children created
    >    by anything but that fan-out.
    > 2. **A cost this default did not price.** The default reads the cost as
    >    "the join condition lives in extension code rather than in a
    >    declaration… precise and small." That pricing omitted resumability:
    >    an extension-coded join is **invisible to the checkpoint projection**
    >    (the AgentSwarms carry-over's completed / ruled-out / dead-edge /
    >    resume-point anatomy, annotated onto D51). A declared `collect` is
    >    inspectable, checkpointable and resumable; an extension-coded one is
    >    none of the three. MateClaw's own framing is the sharp version:
    >    *adding a node kind later is cheap, but retrofitting resumability to
    >    extension-owned joins is not.*
    >
    > This **sharpens the D11 first-consumer trigger rather than overturning
    > the default** — the trigger should now read "the first consumer, *or*
    > the first time a fanned-out run needs to survive a resume," whichever
    > comes first. `RELEASES_DEPENDENTS` from mateclaw §2.2 ("failed does NOT
    > release dependents") lands with this same addition and is a correctness
    > property, not a convenience.

---

*Read next: `docs/extension-model.md` §2 (the manifest this fills), §5 (trust —
the capability grades every dispatch here is gated by), and `architecture.md`
E1-d / E2 (the primitives every node in this kit stands on).*
