# Architecture — the engine core + session trees (S9·1, DRAFT)

Spun up 2026-08-05 for the slice-9 extension-engine design pass (D70). This
document is the S9·1 skeleton: each numbered element carries its proposal
and its open **DECISION** points, walked with Wes element by element. When
the pass is signed, the DECISION markers become D-records or die, and this
file becomes the standing architecture reference.

Status: **DRAFT — walking with Wes.** Nothing here builds anything.

---

## E1. The engine inventory — what IS the engine

D70 says "session-handling architecture only, zero workflow assumptions."
This element makes that a module-by-module claim over what exists today.

**Uncontested engine (stays, unchanged in kind):**
- **Process custody**: spawn/resume/kill/adopt, SDK + PTY adapters, the
  D18 adapter seam (`AdapterCapabilities`), dormant/live lifecycle,
  liveness projection, the recursion-hazard-aware deploy story.
- **The event spine**: append-only store, persist-before-broadcast (I13),
  seq-cursor replay (I2), projections, snapshots.
- **Gates + questions**: gate_fired/gate_response, D68 question surface,
  attention (needsAttention, notification triggers, push).
- **Auth choke point** (spec §3.11): Access team-domain/aud, hook secret,
  the 401-by-default posture.
- **Terminals**: raw PTY relay, rule 0.8, term_* ops.
- **Runtime observation**: CLI/SDK version drift checks, JSONL tailer,
  transcript correlation (D7) — the engine's observed-truth organs.

**Engine, with a decision inside:**
- **Cost ledger / usage windows** — pillar 4 says budgets are first-class
  domain objects "readable by anything that schedules work." Extensions
  schedule work ⇒ the LEDGER is engine; budget *policy* (decline/defer
  rules) is the scheduler-extension's.
  **DECISION E1-a** *(walked 2026-08-05: accepted as proposed, pending pass sign-off)*: confirm ledger = engine, policy = extension.
- **The artifact store** (content-addressed blobs, today holding plans and
  review reports for the task machine) — generalizes cleanly to an engine
  blob service any extension can use (Book Genesis: manuscripts, scores).
  **DECISION E1-b** *(walked 2026-08-05: accepted as proposed, pending pass sign-off)*: artifact store = engine service with per-extension
  namespacing, or migrates out with the task machine?
- **MCP verb-family servers** (D65 `vimes_report`, `vimes_board`) — the
  HOSTING mechanism (mount a tool server into a session) is engine; the
  VERBS are extension content.
  **DECISION E1-c** *(walked 2026-08-05: accepted as proposed, pending pass sign-off)*: confirm the split — engine provides "mount declared
  tools into sessions," extensions declare the tools.

**Leaves the engine (becomes the tasks extension / others):**
- Task state machine, stages, transitions, `deriveReviewOutcome`.
- The board UI, work-order schema, promotion gates.
- The dispatcher's *policy* half (what to run when a task enters a stage).
- **DECISION E1-d** *(walked 2026-08-05: accepted as proposed, pending pass sign-off)* **— the dispatcher split**: the generic half ("spawn a
  session with this briefing/clamps/isolation, report its completion") is
  an engine capability every workflow needs; the task-machine half (stage
  routing) is extension. Where exactly is the cut — proposal: engine owns
  `dispatch(sessionSpec) → completion events`; extension owns everything
  that decides WHAT and WHEN.
- **DECISION E1-e** *(walked 2026-08-05: accepted as proposed, pending pass sign-off)* **— the standing orchestrator**: the mockups list
  "Orchestration" as an extension. The founding/briefing/notes MACHINERY
  (persistent per-project chat with doctrine) smells engine-adjacent
  ("project-scoped chats with the orchestrator" is in the 2026-07-20
  platform vision), but its DOCTRINE is pure workflow. Proposal: the
  persistent-chat primitive = engine; the orchestrator persona, doctrine
  briefing, and grants = extension content.

---

## E2. The session tree — the new engine primitive

The engine's data model grows exactly one new spine concept: sessions live
in a **tree**, not a list.

**Node kinds (proposal):**
- `project` — a D21 root. Tree root; already exists as a concept.
- `group` — the mockups' middle layer ("frontend/checkout"): user-defined
  subproject grouping. See E3 for what it may carry.
- `worktree` — a git-worktree-backed child (herdr model): checkout
  provenance (branch, base ref, resolved commit, path), explicit lifecycle
  (create/open/remove; branch never deleted; force gated on dirty), child
  sessions run IN the checkout.
- `session` — leaf. Today's session, unchanged in identity (I3/I11), plus
  a parent-node reference.

**DECISION E2-a** *(walked 2026-08-05: SETTLED — one kind, with Wes's
write-once sharpening)*. ONE node table, `provenance: null | {worktree...}`.
Worktree-ness is a property, not an identity: the moment a worktree wants
what groups carry (E3's context/rules/docs), one kind gives it for free
where two kinds force duplication or awkward nesting; and the event
vocabulary collapses to one `node_created` shape instead of parallel
families. **Provenance is WRITE-ONCE-AT-CREATION**: set in `node_created`
or never — `null` stays `null` forever. "Converting" a group means creating
a worktree CHILD under it (a new node), which closes the mutation loophole
("I didn't edit a checkout, I added one") while keeping the single table.

**Tree semantics (walked 2026-08-05, sharpened):**
- Tree shape is ENGINE STATE, event-sourced (`node_created`, `node_closed`,
  `session_attached_to_node`) — not display sugar. Clients render the same
  tree (the mockups' shared IA). **No `node_moved` in v1**: moves are
  banned until someone actually wants one (then a D-record — the forest
  invariant would need its preservation clause, and provenance-bearing
  nodes make cross-project moves genuinely weird: disk path divorces from
  tree position).
- Closing a parent closes engine state for the subtree, deletes nothing on
  disk (herdr's rule, verbatim).
- Status/attention/cost AGGREGATE up the tree.
- **DECISION E2-b** *(walked 2026-08-05: SETTLED — engine projection,
  emphatically)*. Clients aren't the only consumers: attention debounce,
  unattended-era escalation policy, and extensions asking "is anything
  under this node red" all read subtree state — the projection is the ONE
  place "worst" gets defined. Two pins the projection spec must carry:
  (1) "worst" requires an EXPLICIT, VERSIONED total order over attention
  states — every reserved/future reason (rate-limited, brake, …) declares
  its severity rank AT RESERVATION, or the rollup silently misorders the
  day it lands; (2) **rollups count PROCESSES, not open nodes** — a closed
  node can still have living processes under it (see the three axes
  below), and a rollup that filters by node-open-state turns
  closed-but-alive sessions into invisible spend, exactly the
  going-silently-dark failure the attention system exists to prevent.

**What the tree buys immediately (why this is the right primitive):**
- Trial finding 1: dispatched stages get isolation by running in a
  `worktree` node instead of the project root.
- Trial finding 5: the staleness guard becomes a node property — work
  referencing symbols absent at the node's checkout base fails loud at
  dispatch.
- Parallel exploration (two approaches on two worktree nodes under one
  group) falls out for free.
- **DECISION E2-c** *(walked 2026-08-05: SETTLED — both creators, one API,
  engine does git)*. This is **principle 13 applied to the filesystem**:
  the extension never touches git — it PROPOSES a checkout; the engine's
  one injection-guarded GitAdapter path decides and performs. Two pinned
  edges: (1) `create` when the branch already exists **fails loud and
  points at `open`** — attach-to-existing is a DIFFERENT verb with
  different provenance semantics (the resolved commit differs); silently
  merging the two is how provenance lies. (2) Removal interacts with the
  SP8·2 observed fact that `--resume` requires an exact cwd match:
  sessions whose transcripts live against a worktree path lose
  resumability when the checkout is removed — so `remove` is gated (or
  loudly warned) on "resumable sessions exist here."

**The three orthogonal axes (the complete pillar-2 lineage):**
1. **Closure is tree-state.** Closing a node never kills a process.
2. **Kill is process-state.** Killing a process never closes its node —
   a dead session's node persists, holding transcript and provenance for
   archaeology. (Both directions stated so no asymmetric reading lets a
   crash quietly reap the node.)
3. **Removal is disk-state.** `worktree remove` destroys the one thing
   the event spine cannot replay — the checkout and, via cwd-exact
   resume, the resumability of its sessions. It is its own named,
   explicit, gated act — never a side effect of closure or kill.

**Invariant candidates (I# to pin in the pass):**
- Every session has exactly one parent node; nodes form a forest rooted in
  projects (no cycles, no orphans; trivially preserved while moves are
  banned).
- Provenance is write-once-at-creation; `null` stays `null` forever; a new
  checkout is a new node.
- The three axes are independent: no transition on one axis implies a
  transition on another; every cross-axis act is its own explicit event.
- Aggregation counts processes, not open nodes.

---

## E3. Subprojects — what a `group` node may carry (RAW, from the mockups)

Wes's concept: "/frontend/checkout" may have its own context, rules,
documentation, workflow. Three escalating options:

- **(i) Label-only** (v1-cheap): grouping + aggregation, nothing else.
- **(ii) Directory-scoped**: node maps to a directory; sessions spawned
  under it default their cwd there; context files (CLAUDE.md-style)
  discovered by existing CLI mechanics — the engine adds NOTHING, the
  grouping just changes spawn cwd. Zero new config machinery.
- **(iii) Node-scoped config**: per-node extension loading, rules,
  briefings — real machinery, real power, real complexity.

**DECISION E3-a** *(walked 2026-08-05: SETTLED — (ii), directory
OPTIONAL)*: ship (ii) as the v1 semantics, with the group's `directory`
field NULLABLE (like `provenance`): a label-only group scopes nothing and
just aggregates; a directory-bearing group defaults spawn cwd. RESERVE the
schema field for (iii) (`nodeConfig: reserved`, 0.5), and let a real
tenant need pull (iii) into existence (first-consumer rule, D11). Per-node
WORKFLOW (different extension per subproject) is (iii) territory — defer
until Book Genesis or a real project demands it.

**The three meanings of "directory" (Wes, closing the element — kept
deliberately separate):**
1. **Tree position is ORGANIZATION.** Where a session appears is a human
   labeling choice and never claims containment — a session filed under
   `/infrastructure/vimes` may reach into any repo its work needs (that is
   the tool's real capability; requiring directories would fight it).
2. **A group's directory is a SPAWN DEFAULT** — where work begins (cwd +
   context-file discovery), never where it may go.
3. **Containment is its own explicit, OPT-IN session property** — "this
   session may touch ONLY these paths." Not a tree concept: a reserved
   session-spec confinement field, designed in S9·3 (trust) with
   agenc-core's `sandbox_mode` + fail-closed execution broker as the
   named prior art. Off by default, matching the tools' native reach.

---

## E4. What the engine API must carry (handoff to S9·2)

Consequences #15 + the mockups establish, enumerated here and designed in
S9·2 (manifest) / S9·5 (client contract):

1. Tree CRUD + subscription (the home surface in both clients).
2. Extension **state overlays** on engine objects (the tasks extension
   painting `review` onto a session row).
3. Extension **verb registration with two faces** — agent tool + human
   command — same verb, same principle-13 authority derivation.
4. Extension **panes**: declarative host-rendered blocks (AoE model) as
   the client-agnostic default; PTY panes as the terminal-first escape
   hatch (pillar 7).
5. Per-project (and reserved: per-node) extension activation.
6. Blob/artifact service (E1-b: engine, per-extension namespacing).
7. Dispatch primitive (E1-d: engine owns `dispatch(sessionSpec)`).
8. Reserved: session-spec confinement field (E3's third meaning — designed
   in S9·3 with the agenc broker as prior art).

---

## E5. Migration map seed (elaborated in S9·5)

| Today | Under D70 |
|---|---|
| `packages/core` events/projections/schemas (session, gate, terminal, cost) | engine |
| `packages/core` tasks/* (state machine, watchdog, dispatchDecision) | tasks extension |
| `daemon/sessionHost.ts` | engine |
| `daemon/taskDispatcher.ts` | SPLIT per E1-d |
| `daemon` artifact store | pending E1-b |
| `vimes_report` / `vimes_board` MCP servers | verbs → tasks extension; mounting → engine |
| `ui` board/work-order surfaces | tasks extension contributions |
| `ui` session list/stream/terminal/editor | engine client (evolves toward the mockups) |
| orchestrator founding/briefing/notes | persistent-chat primitive → engine; persona/doctrine → extension (pending E1-e) |

---

## Walk order with Wes

E1 (inventory + its five decisions) → E2 (tree + three decisions) → E3
(subprojects, one decision) → E4/E5 are consequences, reviewed once E1–E3
settle. Each settled DECISION becomes a D-record or folds into the pass
sign-off; this doc's DRAFT banner drops when S9·6 signs.
