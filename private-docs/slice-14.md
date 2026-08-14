# Slice 14 — the tree: serve the home surface's data

**Status: CLOSED, 2026-08-13 — both gates green.** Machine gate closed
2026-08-12 (skeleton signed, three findings found/signed/closed IN-SLICE,
all units built, gated, committed, DEPLOYED same day). Human gate passed
2026-08-13: Wes hit the live daemon — `/api/health` PASS
(`apiVersion:1, capabilities:[]`, no UI mismatch banner) and `/api/tree`
PASS on spot checks (forest matches reality; no anomalies surfaced).
Mechanical half re-ran green same day on the grown log: 24,528 events
(was 23,841 at machine-gate close), 47/47 sessions exactly-once, unfiled
still exactly the 21 sessions F2's live-data finding predicted.

> **Post-close loose end — the production write path has never fired.**
> The node routes (`POST /api/nodes`, close, attach) are green under the
> full assertion suite + sabotage verification, but no nodeCreated/
> nodeClosed/sessionAttachedToNode event exists in the production log yet.
> A localhost probe was attempted 2026-08-13 and correctly 401'd — I14
> (auth in front of everything) has no local bypass, which is itself the
> right behavior. First production firing will come from Wes (an
> Access-authenticated curl) or naturally from the tree UI slice. Not a
> gate criterion; recorded so nobody mistakes "tested" for "fired live."

> **CLOSE BLOCK (2026-08-12).** Units: U1 `d735d18` (capability hello +
> D84→D85 version floor, reordered FIRST per F5) → U2+U2b+U2c `224b62b`
> (the tree read model in core, committed WHOLE after three findings:
> S14-F1 label-ladder exemption; S14-F2 durable createdAt; S14-F3→D86
> snapshot versioning — the fixer's halt at "there is nothing to bump" was
> the slice's best moment) → U3 `3a271f4` (NodeWriter = the FIRST emitter
> of the E2 events, tree routes, parity script; pushService went the
> honest estate-aware D79 way). Suite 3267 → 3374. Sabotages: 13 by
> agents, 4 orchestrator-run (hello null-case, hello-first frame,
> version-bump guards, attached-elsewhere) — every guard reddened exactly
> its own line. Deploy: ancestry-checked restart booted hello + D86 + tree
> routes under the old UI (safe: hello dropped by the stale parser, routes
> additive); ci-gate ALL PROFILES PASS then shipped the banner-capable UI.
> The known D73 drift warning appeared again at boot (2.1.228 vs pin
> 2.1.224 — datum #5). D86's first real replay of `projects` happens
> lazily on the first read. Loose ends riding forward: the tree UI slice
> (needs the UI doctrine doc first, ui-face-pass §4); the E2-c worktree
> git unit; D84's candidate (a) still open; daemon
> `orchestratorDisplayName` folds into core's `projectDisplayName` when
> next touched.

The §2 face-pass daemon slice: the first BUILD after the D70-face pass, and
deliberately **not** a UI slice — the tree home surface cannot be built by any
UI agent until this ships, and the UI doctrine doc (ui-face-pass §4)
interleaves before those agents run.

---

## §0. What recon found (2026-08-12) — the slice is smaller than the pass feared

The core half of E2 is **already built and tested**: `projections/nodes.ts`
(one node table, `provenance` write-once nullable, `directory` nullable,
`closed`, attachment-ordered `sessionIds`; serialize; derived subtree-closure —
never recorded), `projections/nodeRollup.ts` (versioned
`ATTENTION_SEVERITY_ORDER_VERSION = 1`, ranks idle/working/waiting_input/
gate_fired/error; counts processes on closed nodes, per E2-b), and all three
events (`node_created`, `node_closed`, `session_attached_to_node`) on the
`nodes` stream with constructors, registry entries, and tests. `node_moved`
does not exist and its absence is load-bearing (acyclicity).

What does NOT exist — the actual scope:

1. **Nothing emits the three events.** No node writer (no analogue of
   `projectWriter`/`instanceWriter`), zero non-test callers.
2. **The daemon serves none of it.** `nodesProjection` is not in
   `DAEMON_PROJECTIONS`; there is no `/api/tree` (confirmed; the only "tree"
   route is `/api/files/tree`, unrelated).
3. **The severity mapping is unwritten.** `rollupNode` takes a per-session
   severity callback nobody implements — nothing maps
   liveness + `needsAttention` → `AttentionSeverity`. Three vocabularies
   exist; the join is the missing piece, and E2-b says the projection is the
   ONE place "worst" gets defined.
4. **Overlays are design-only.** The manifest parser is real
   (`ParsedOverlay`, targets `session|node`, attention ranks, the
   `overlay-values-not-unique` validations); there is no store, no event, no
   read path, no `overlay.write` enforcement site.
5. **No `queued` anywhere** — liveness is exactly
   `spawning|running|dormant|interrupted|dead`, and the dispatcher is
   deliberately not a queue ("a loser waits for nothing — it returns").
6. **Short ids are five scattered 8-char `slice(0, 8)`s** (core
   sessionIdentity, a deliberate UI restatement, founding.ts, plus two ad-hoc
   stragglers) with no collision handling — D79 signed 4-char-prefix +
   git-style extension, engine-owned, one place.
7. **Seen already works at session level** (`seen` event → `seenAt` on the
   sessions projection, never touching `needsAttention` — D9's split is
   already in the fold). D83 costs this slice a wire shape + an assertion,
   not machinery.
8. **The WS spine needs nothing new.** Per-event fan-out over per-stream
   cursors; the UI's established pattern is stream-local trigger → REST
   refetch. A `nodes`-stream subscription works the day the events exist.

## §1. Scope

- **U-shape:** land the node writer + node API (create / close / attach),
  serve the composed tree read model at `GET /api/tree?project=`, register
  `nodesProjection` at `/api/projections/nodes`, and implement the
  liveness+attention → severity mapping in core so `rollupNode` has its one
  authoritative caller.
- The tree wire shape carries, per node: the E2 core fields, the E2-b rollup
  (`worst`, `processCount`, order version), and per session leaf: engine
  state, `seenAt` AND `needsAttention` as two distinct facts (D83), the D79
  short id, and an **`overlays` field reserved as an empty map** (0.5 — the
  shape lands, the first producer arrives when tasks becomes an extension).
- WS: clients subscribe `{stream:'nodes'}`; no new envelope work expected.
- Contract per migration-map §3.2 item 1; **no `node_moved`** is offered.

## §2. Explicitly out

- **All UI.** No store subscription, no components — the tree home surface is
  the next slice and cites the doctrine doc.
- `node_moved` (banned until a D-record, E2-a).
- Worktree **git** operations (E2-c GitAdapter checkout propose/create/open,
  SP8·2-gated removal). Creating a provenance-BEARING node through the API is
  therefore also out: v1 of the writer creates provenance-null nodes only;
  provenance arrives with the E2-c unit that actually does git. (Provenance
  stays write-once in schema; nothing changes there.)
- Per-node config / (iii) machinery — `nodeConfig` stays required-null (D11).
- Overlay producers, the overlay store, `overlay.write` enforcement.
- Attention-severity vocabulary changes (extending the versioned order is a
  D-record; this slice only maps INTO order version 1).
- Any dispatch-queue machinery (see flag F3).
- Board / panes / D75-D77 anything.

## §3. Skeleton decisions — all five flags ⟨signed⟩ 2026-08-12, with refinements

**F1 ⟨signed⟩ — Project roots are VIRTUAL, composed from the projects
projection.** No `node_created` backfill. Principle 9: project identity has
one source of record. **Rider (Wes): virtual roots carry a SYNTHETIC,
NAMESPACED, DETERMINISTIC id** — `project:<projectId>`, plus the singleton
`unfiled` root from F2 — so clients can address, expand, and select them,
and the namespace (`:`-prefixed forms real engine-generated nodeIds can never
take) makes collision with a real nodeId structurally impossible. Without
this the root is unaddressable and the first client invents its own
convention. The id grammar is part of the wire contract and gets its own
assertion (S14-A10).

**F2 ⟨signed, hole found + closed⟩ — Default attachment is a LONGEST-PREFIX
PATH DERIVATION, not a lookup.** The skeleton's draft assumed a session
knows its project; `SessionRecord` has no `projectId` — sessions carry
`cwd`, projects carry `root`. The machinery already exists and is the
authority: **`projectForCwd(state, cwd)`** (core `projections/projects.ts`)
— longest-prefix-wins over non-archived projects, nesting is a feature,
ties structurally impossible (`duplicate-root` refused at write). Its return
type is `ProjectRecord | null`: **the orphan case exists in the signature
today.** Two consequences, both binding on U-core:
- The derivation is a NAMED, fixture-tested function in the core unit —
  never an incidental join inside `treeOf`.
- **The orphan answer, decided by live data (readonly db, 2026-08-12): the
  UNFILED virtual root.** 21 of 47 live sessions (45%) resolve to no
  project — `~/projects` itself ×7, `games/dongfu` ×7, `games/1e9999` ×6,
  `games/space_industry` ×1 (live roots: vimes, johnny, content/death). The
  alternative ("stated invariant that every cwd resolves") is falsified by
  history before it could be written. Unfiled sessions hang under the
  singleton virtual root `unfiled`, rendered honestly — visible, never
  silently dropped (the going-dark failure the attention system exists to
  prevent). Explicit attachment always overrides the derivation.

**F3 ⟨signed⟩ — `queued` is NOT reserved in this slice.** Wes's sharpening:
an enum member no code path can enter is the **inert-reservation
anti-pattern** (reserved-but-unhonoured shape that looks like capability),
and E2-b pin 1 would force an unpriced severity rank. The usual
counterargument — adding a state later breaks old clients — **is precisely
what F5's capability hello exists to handle**, so with F5 landed the
deferral is strictly safer than the reservation. `queued` arrives with the
dispatch-queue's first consumer; #17 binds this slice's vocabulary either
way.

**F4 ⟨signed, language pinned⟩ — D79 lands here: 4-char prefix, git-style
extension, ONE core derivation, five call sites consolidated.** The pin
(Wes): **"stable" means NEVER RE-POINTS, not never lengthens** — a short id
may need more characters after a collision; it may never mean a different
session. Three consequences, binding on U-core:
- **Rendering and resolution are DIFFERENT functions.** Rendering:
  ids-in-scope → shortId map (collision-extended). Resolution: accept ANY
  unambiguous prefix, not just the currently-rendered length — or a stale
  4-char id typed from muscle memory fails after a collision. The TUI
  command grammar needs the resolver; both land in core now.
- **Scope is declared: WHOLE-ESTATE**, not per-project — otherwise the same
  four chars mean different sessions after a project switch and the command
  grammar becomes unsafe.
- The 8→4 rendering change is cosmetic fallout the UI absorbs later.

**F5 ⟨signed, REORDERED TO FIRST⟩ — the capability hello + D84 version
floor open the slice instead of closing it.** Two refinements (Wes):
- **Recorded explicitly: this protects FUTURE slices, not this one.** Every
  route in slice 14 is additive, so no degraded window exists here for the
  banner to cover — stated so nobody later assumes it did.
- As the last unit it is the natural drop candidate under budget pressure,
  **which inverts its purpose**. It is independent of the other units, so it
  goes FIRST at no cost (§5's order is the record). D84 closes at U1, and
  every later unit in this and future slices ships under the floor.

### §3b. The severity mapping table (addendum 2026-08-12, orchestrator-proposed)

The `sessionSeverityOf` join, U2's first deliverable — PROPOSED, proceeding
under standing momentum; ⟨Wes⟩ may re-price ranks any time before the UI era
renders them (the order is versioned; changing a row later is a reviewed act,
not a migration).

**Attention overrides liveness.** When `needsAttention` is present:

| attention reason | severity | note |
|---|---|---|
| `gate` | `gate_fired` | the eponymous rank |
| `question` | `waiting_input` | |
| `completed` | `waiting_input` | a finished run awaiting acknowledgment is a decision, not an error |
| `stale` | `error` | |
| `quarantined` | `error` | |
| `rate-limited` *(reserved, no emitter)* | `error` | E2-b pin 1: reserved reasons rank AT reservation; loud beats quiet — re-priced in the unit that gives it an emitter |
| `brake` *(reserved, no emitter)* | `error` | same rule |

**No attention → liveness maps:** `spawning` → `working`, `running` →
`working`, `dormant` → `idle`, `interrupted` → `waiting_input` (an
interrupted session awaits a human resume decision), `dead` → `idle`
(archaeology; and E2-b's processCount, not severity, is what keeps dead-
session estates honest). Totality per S14-A4; unknown input HARD-errors.

### §3c. Short-id consolidation scope (addendum 2026-08-12, corrects A6)

Recon's "five call sites" divide on inspection: `founding.ts` shortens TASK
ids, not session ids — out of D79's scope, untouched. The UI pair
(`sessionLabel.ts`, `StreamView.vue`) cannot import core (deliberate
restatement precedent) and migrates when the UI consumes the tree wire shape
(`shortId` rides the leaf) — next slice. This slice consolidates the CORE
site (`sessionIdentity.ts`) in U2 and the daemon straggler (`pushService.ts`)
in U3. S14-A6's grep covers core+daemon now, UI at the tree-UI slice.
**Third exemption (S14-F1, signed):** the label ladder's fallback slice in
`sessionIdentity.ts` is a display distinguisher handed ONE session and no
estate — not a D79 handle. It keeps width 8 under its own named constant.
D79's handle is the wire's collision-extended `shortId`, nothing else.

## §4. Assertion candidates (numbering final at unit dispatch)

- **S14-A1 (forest):** every session resolves to exactly one parent node
  (explicit attach or F2 default); nodes form a forest rooted in (virtual)
  project roots; no cycles, no orphans. Exact counts (counted quantity).
- **S14-A2 (provenance):** write-once at creation; null stays null under
  replay; the v1 API cannot create a provenance-bearing node.
- **S14-A3 (rollup):** counts processes, not open nodes — a closed node with
  a living session under it stays visible; parity against a fixture forest.
- **S14-A4 (severity totality):** the liveness+attention → severity mapping
  is total — every combination maps; an unknown input is a HARD error, never
  a silent `idle` (E2-b pin 1's spirit at the join). **Totality includes the
  EMPTY NODE** (Wes): a node with no sessions is a real state on day one for
  every freshly created node — its rollup is `worst: null`, declared as the
  wire meaning of "nothing to report", never coerced to `idle`.
- **S14-A5 (seen ≠ handled):** the wire shape carries `seenAt` and
  `needsAttention` as distinct facts; folding `seen` never clears attention
  (already true in core — asserted at the new surface).
- **S14-A6 (short ids):** derivation deterministic; collisions extend
  git-style; no registry, no recycling; the five legacy call sites are gone
  (grep).
- **S14-A7 (tenant-blind):** the tree payload and the engine session-status
  enum contain no tenant word — the #16 grep extended to the new wire shape.
  Workflow state may reach this surface ONLY through the reserved `overlays`
  map (the retracted-Conflict-2 assertion, made real).
- **S14-A8 (determinism):** same fixture streams → byte-identical
  `/api/tree` payload, twice (CI double-run).
- **S14-A9 (hello):** a bundle with a floor above the daemon's declared
  version renders the mismatch banner; omitted capability reads as
  unsupported, never assumed.
- **S14-A10 (virtual id grammar):** virtual root ids are deterministic and
  namespaced (`project:<projectId>`, singleton `unfiled`); a real
  engine-generated nodeId can never take a virtual form; resolution of a
  virtual id is exact, never prefix-matched (F1 rider).
- **S14-A11 (sibling ordering DECLARED, not incidental — Wes):** child nodes
  render in creation order (stream seq); sessions in attachment order
  (already recorded); virtual project roots in project-creation order,
  `unfiled` last. Declared in the wire contract and asserted directly — A8's
  double-run catches nondeterminism only if the fixtures happen to expose
  it; this pins the order itself.
- **S14-A12 (short-id resolution):** the resolver accepts any unambiguous
  prefix regardless of rendered length; an ambiguous prefix refuses with the
  candidates; a resolved id NEVER re-points (F4's stability pin, asserted).

## §5. Unit breakdown (sequential, one agent each; F5-first per §3)

- **U1 (daemon+ui, sonnet):** capability hello on WS connect +
  `/api/health` mirror; bundle-declared API-version floor + loud mismatch
  banner. **D84 closes here.** Additive; protects every later unit.
- **U2 (core, opus):** severity mapping (`sessionSeverityOf`), tree
  read-model composition (`treeOf(projects, nodes, sessions)` → wire shape,
  virtual roots per F1's id grammar, F2's NAMED longest-prefix default-
  attachment function over `projectForCwd`, `unfiled` root, reserved
  `overlays`, declared sibling ordering), D79 short-id rendering + resolver
  as two functions, whole-estate scope, five call sites consolidated. Pure,
  fixture-tested, deterministic.
- **U3 (daemon, opus):** node writer + routes (`POST /api/nodes`, close,
  attach; refusal vocabulary engine-spelled), `GET /api/tree?project=`,
  register `nodesProjection`. Contract tests against the U2 fixtures.

## §5b. FINDINGS — U2 (2026-08-12, rule 0.1: slice HALTED pending ⟨Wes⟩)

U2 delivered (65 new tests, four self-sabotage verifications) but surfaced
two findings; the suite is RED (one daemon test) and U2 sits UNCOMMITTED
until both are decided. Verified independently by the orchestrator.
**⟨Wes⟩ BOTH RESOLUTIONS SIGNED same day: F1 → option (a), F2 → option
(a). Fix unit U2b dispatched to a fresh agent (D46).**

**S14-F1 — the fallback label is not a D79 handle, and narrowing it broke
its purpose.** The U2 work order ordered `sessionIdentity.ts` migrated onto
the D79 base width — an ORCHESTRATOR ERROR of the same class §3c already
caught for `founding.ts` task ids: the label ladder's fallback slice is a
DISPLAY DISTINGUISHER handed one session and no estate, not an addressable
handle. At 4 chars with no collision context it stopped distinguishing
(`sess-unnamed` and `sess-blank` both render `sess`); the agent had to
weaken two fixture assertions, and `costExitGate.test.ts` Q3 ("the ladder's
absence degrades honestly") is red. Options: (a) the ladder keeps 8 under
its OWN named constant, documented as not-a-D79-handle (§3c extended to a
third exemption); (b) accept 4 and the weakened assertions; (c) hand the
ladder an estate (structurally impossible — it receives one session).
**Orchestrator recommendation: (a).** D79's real handle is the wire's
collision-extended `shortId`; the ladder was never it.

**S14-F2 — S14-A11's "creation order" is not durable for projects or
nodes.** Neither `ProjectRecord` nor `NodeRecord` carries a timestamp, so
creation order exists only as projection-map insertion order — exact on a
fresh fold (the A11 tests pass), but `sqliteSnapshotStore` serializes
through `canonicalJson` (deep key sort) and the daemon boots projections
from snapshots, so in production root/node order silently degrades to
lexicographic-by-id after the first snapshot round-trip. Session order IS
durable (`SessionRecord.createdAt`; `treeOf` sorts on it, with a
round-trip test proving it). Options: (a) fold the birth event's `ts` into
both records as `createdAt` (SessionRecord precedent) — a projection
change, snapshot schema-version bump, replay-deterministic; (b) declare
root/node ordering lexicographic-by-id (durable and declared, but the
order carries no meaning). **Orchestrator recommendation: (a)** — A11's
spirit was "declared AND honest"; lexicographic is declared but lies about
nothing in particular.

**S14-F3 (U2b, 2026-08-12) — there is NO snapshot-invalidation mechanism;
fix 2 halted at its own tripwire, correctly.** ⟨Wes⟩ NEEDS A CALL.
The `snapshots` table is `projectionId / lastAppliedSeq / state / savedAt`
— no version column, no migration, no delete path; `Projection<T>` carries
no version; `bootFromSnapshot` has no compatibility check that could fail;
`store.schemaVersion()` on /api/health is the EVENT LOG's version and
nothing branches on it. The only precedented invalidation is renaming the
projection id (S11: 'tasks'→'instances' — load(newId) misses → init() →
full replay), and the id is public API surface. The fixer wrote NO fix-2
code rather than tolerate it: a snapshot's old records never re-fold their
birth events (they sit behind `lastAppliedSeq`), so `createdAt` added to
the fold today NEVER reaches an existing `ProjectRecord` — sorting on it
would be the F2 ordering lie with `undefined` in the comparator,
self-healing never. Verified by the orchestrator against the store source.
Options: **(a) build the mechanism** — a per-projection integer `version`
on `Projection<T>` (default 1), stored beside the snapshot, mismatch on
load = treat as absent (init + full replay + overwrite); projects bumps to
2 with the `createdAt` fold; D11-clean because the first consumer has
ARRIVED. **(b) rename the projection id** — precedented but spends public
API surface to avoid a version field. **(c) tolerant comparator** —
refused above, recorded only to name it dead.
**Orchestrator recommendation: (a).** This is 0.5's "reserve schema early"
arriving with its bill; the mechanism is small, deterministic, and every
future record-shape change needs it.
**⟨Wes⟩ SIGNED (a), same day — recorded as D86 in decisions.md; fix unit
U2c dispatched fresh.**
**CLOSED same day: U2c landed both halves (version seam in core's
`bootFromSnapshot`, one place; sqlite additive column DEFAULT 1; projects
→ v2, nodes stays 1 with its why; createdAt folds; both tree sort levels
durable). Suite 3352. The whole tree read model committed as ONE unit:
U1 `d735d18`, U2+U2b+U2c `224b62b`. Orchestrator gate: full diff read,
own suite run, independent sabotage (version-bump guards), census 0 ×26.
⚠ RESTART REQUIRED before U3's routes ship — first boot full-replays the
projects stream once (version 1 snapshot → mismatch → rebuild).
`DAEMON_API_VERSION` deliberately NOT bumped: createdAt is additive,
D85's safe direction.**

*(U2 design decisions taken within its mandate, recorded: the tree option
is `rootId` in the F1 grammar (U3's `?project=` maps to it); nodes carrying
an ARCHIVED project's id hang under `unfiled` rather than vanishing —
one rule shared with `projectForCwd`; collision extension is
group-lockstep width; exact-id input short-circuits the resolver; root
rollups compose child rollups without a second walk.)*

## §6. Exit gate + kill criterion

- **Machine gate:** S14 assertions green, all prior green (0.4), CI
  double-run byte-identical, census 0.
- **Human gate, mechanical half (command-kind, Wes):** a script against the
  LIVE db (readonly): every session in the sessions projection appears
  EXACTLY ONCE in the `/api/tree` payload — S14-A1 run against reality
  rather than fixtures; the one place real data gets checked.
- **Human gate, judgment half:** ⟨Wes⟩ hits `/api/tree` against the live
  daemon and the forest matches reality — the vimes and johnny estates hang
  where they should, the unfiled root holds exactly the games/scratch
  sessions §3-F2 enumerated, rollups plausible against the board's own
  evidence.
- **Kill criterion:** if serving the tree requires the daemon to learn a
  tenant word, requires a second source of record for project identity, or
  requires rewriting history to make the forest legal (backfill events for
  old sessions) — STOP. That is a finding about the spine, not a serving
  problem to patch around.
