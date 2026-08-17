# Slice 15 — the tree home surface

**Status: MACHINE GATE CLOSED, ALL UNITS DEPLOYED (2026-08-13). ⟨Wes⟩ THE
HUMAN GATE REMAINS: drive the tree as home from the phone — decide an
attention item from its card, create the FIRST production node, attach a
session, spawn from a node (directory prefill), watch another tab update
live (U3b's nodes stream). Judgment items: F3's short id on rows, the
invented unseen-dot `•`. On PASS → CLOSED; on FAIL → rule 0.1 + §6 kill
criteria.** U3 `9303ee8` (write surface) + U3b `9581a82` (nodes-stream
subscribe, closes S15-F4) landed after the paragraph below was written;
final suite 3461; second ci-gate deploy ~12:55, no restart (UI-only). Flags F1–F5
signed as written. Units landed, gated, committed, DEPLOYED (ci-gate ALL
PROFILES + restart 12:40, ancestry-checked; parity 47/47 on the new
payload; D73 datum #6 at boot): U1 `d635d58` (lib layer) → U1b+U1c
`289f02e` (D87 riders + addendum guard) → U4 `bdc9b92` (S15-F3
createdAt) → U2 `7c69bfc` (TreeView + home cutover — **the tree is live on
the public hostname**). Findings F1/F2/F3 all signed+closed same day. U3
(write surface + spawn prefill) dispatched, in flight. Human gate after
U3: drive the tree from the phone, decide an attention item from it,
create the first node. First UI slice of the tree era; first slice whose
work orders cite `ui-doctrine.md` (signed 2026-08-13).

The mockups' settled item #1, finally buildable: *"the tree of work replaces
both today's session list and the board as the landing surface."* Slice 14
serves the data (`GET /api/tree`, 47/47 parity, human-gated 2026-08-13); this
slice puts a face on it.

---

## §0. Recon findings (read before the work orders)

- **The delta story already exists and is house pattern.** `vimesStore.ts`
  maintains `SESSIONS_AFFECTING_TYPES`: events seen on subscribed WS streams
  schedule a **throttled REST re-fetch** — never local projection patching.
  The tree rides the identical mechanism with a `TREE_AFFECTING_TYPES`
  superset (sessions set + `node_created`, `node_closed`,
  `session_attached_to_node`, + the project-registry events
  `project_created` / `project_updated` / `project_archived`). No new WS shape
  is needed; slice 14's decision not to invent a tree-delta frame was
  consistent with this pattern, and kill criterion K3 below is the tripwire if
  the pattern proves insufficient.
- **⚠ Filename collision hazard: `lib/treeNode.ts` is the FILE tree** (the
  `/api/files/tree` derivation), not the session tree. Same-spelling-
  different-facts at the filename layer. Every new lib file in this slice
  carries the `sessionTree`/`sessionSeverity` prefix; a work order or agent
  that touches `treeNode.ts` has wandered into the wrong subsystem — stop
  condition, not a merge.
- **The payload does the thinking.** `TreeResponse` arrives with estate-scoped
  `shortId`, precomputed `severity`, declared sibling ordering, rollups that
  count processes, `seenAt` and `needsAttention` as two fields, and reserved
  empty `overlays` maps on every session/node. The client renders; it does not
  re-derive (U8). Client-side sorting of siblings is a defect by definition.
- **Home today:** route view `sessionList` is the default; `PanelHost` renders
  the SAME `SessionListView` as the mobile home frame and the desktop sidebar
  (stack[0]) — one component, two layouts. The tree inherits exactly that
  slot-shape.
- **Reusable rungs:** `lib/sessionLabel.ts` (identity ladder incl. the
  8-char fallback distinguisher — the S14-F1 exemption), `lib/seenOnView.ts`,
  the theme machinery, panel-stack. The WOs point at them by name so agents
  extend rather than reinvent.
- **Write path:** `POST /api/nodes` (create), `POST /api/nodes/:id/close`,
  `POST /api/nodes/:id/sessions` (attach); all refusals are 409
  `{error:'conflict', reason}` over the closed 11-reason vocabulary. **No
  production node event exists yet** — this slice's U3 will fire the first
  ones (closing slice 14's recorded loose end).

## §1. Scope

- **`TreeView.vue` becomes the home surface** — mobile home frame AND desktop
  sidebar, taking `SessionListView`'s slot-shape. Roots (projects +
  `unfiled` last), nodes, session leaves with severity glyph+tone, short id,
  identity-ladder name, rollup counts on collapsed branches.
- **Store wiring:** `fetchTree` + `TREE_AFFECTING_TYPES` throttled re-fetch +
  reconnect re-fetch. Served order rendered verbatim.
- **Severity display doctrine** (`ui-doctrine.md` §3 mapping) as a total,
  tested lib derivation: tone + typographic glyph per `AttentionSeverity`.
- **Expand/collapse** with rollups honest on collapsed branches (a collapsed
  branch with a gate under it must read loud — pillar 5 / U5).
- **The write surface (U3):** create node, attach session, close node, from
  the tree — refusals rendered honestly from the closed reason vocabulary.
- **Spawn-from-tree** with E3-a's payoff: spawning from a node prefills the
  node's `directory` as the cwd default (directory = spawn default, never
  containment).
- **Navigation:** tapping a session leaf opens its stream (the existing
  route); the tree is a navigator on the phone, a persistent sidebar on
  desktop.

## §2. Explicitly out

- **Panes/board work** (D75⇄D77) — the board-as-pane is a later slice; no
  `[[panes]]` client machinery here.
- **Overlay RENDERING** — the render slot is reserved (props carry
  `overlays` through), but no generic overlay renderer ships before its first
  producer (rule 0.5 discipline; F5).
- **Node rename / reopen / move / detach** — none exist in the engine (E2-a);
  the UI must not draw affordances for them.
- **Drag-and-drop attach** — tap/click flows only; DnD is polish and the
  phone needs the tap flow anyway.
- **`SessionListView` deletion** — see F1; it survives this slice
  route-reachable and dies next slice after the human gate.
- **TUI client, `vmx`, extension surfaces, E2-c git, seen/unread counters
  beyond what already renders.**
- **Any daemon/core change.** This slice is genuinely UI-only — ci-gate ships
  it, no restart (the good half of the partial-deploy mechanism). If any unit
  finds it needs a daemon change, that is a finding on slice 14's payload, not
  a quiet edit.

## §3. Design flags — ⟨Wes⟩ review before dispatch

- **F1 — Home-swap strategy: cutover with a route fallback.** Route default
  becomes the tree; `sessionList` stays reachable at its route for exactly
  this slice as the escape hatch while the tree survives real daily use
  (the MVP-line discipline). Its deletion is the opening unit of the next UI
  slice, after the human gate. Alternative (rejected): delete in-slice —
  saves nothing and removes the fallback exactly when the new home is
  youngest.
- **F2 — Writes ship in-slice (U3), not read-only-first.** A tree home
  without create/attach renders "user-defined grouping" as a fiction — no
  human can define a group. U3 is sequenced last so the read surface is
  gate-able even if U3 slips a day.
- **F3 — Short ids visible on web tree rows** (dimmed, mono). The web mockup
  shows no ids anywhere; D79 has since made short ids the estate handle, and
  the instrument identity says readouts label their needles. Divergence from
  the drawing, deliberate — judged at the human gate.
- **F4 — Spawn-from-node prefill is in scope.** Small (the spawn flow exists;
  this adds a default), and it is E3-a's entire payoff — without it, node
  `directory` is a stored fact nothing reads.
- **F5 — Overlays: slot reserved, renderer waits.** Props pass `overlays`
  through untouched end-to-end (asserted), so the first producer needs no
  plumbing; no generic renderer is built against zero producers. The
  D76-alien-tenant render test belongs to the slice that ships the first
  producer.

## §3b. Severity → display (doctrine §3 made concrete; glyphs are the WO's pick within these bounds)

| severity | tone token | glyph class | notes |
|---|---|---|---|
| `gate_fired` | `warn`-or-louder, distinct from plain waiting | `!` | loudest non-error; decidable from the row (U3) |
| `error` | `crit` | `×` | |
| `waiting_input` | `warn` | `?` | |
| `working` | `accent`-family activity | `*` | activity, never alarm |
| `idle` | `ink-dim` | `·` | quiet by design |

Typographic glyphs only (U7, no emoji); exact codepoints are the unit's call,
totality over `AttentionSeverity` is not. Rollup on a collapsed branch renders
the branch's `worst` in the same vocabulary — one mapping, used twice.

## §4. Assertions (S15-A#; lib-level per the house rule — `.vue` is diff-read + human gate)

- **A1** `sessionTreeRows` flattening preserves served sibling order VERBATIM
  — fixture with deliberately non-lexicographic, non-chronological-looking
  order; any client-side sort reddens it (U8).
- **A2** Severity display mapping is TOTAL over `AttentionSeverity`
  (compile-time `never` + runtime test), and collapsed-branch rendering uses
  the same mapping on `rollup.worst`.
- **A3** `TREE_AFFECTING_TYPES` completeness: declared list asserted to
  contain the sessions set PLUS all three node event types plus the
  project-registry types; sabotage = remove `node_created`, its own test
  reddens.
- **A4** Attention styling derives from `severity`/`needsAttention` and
  NEVER from `seenAt` (D83/U5): fixture where `seenAt` is set and a gate is
  live must style loud; the seen indicator is a separate channel.
- **A5** Refusal rendering is a CLOSED total mapping over the 11 engine
  reasons — unknown reason renders the engine string verbatim rather than
  throwing or hiding (forward-compat without invention).
- **A6** Overlays pass through untouched: fixture with a populated overlays
  map arrives at the render-slot props byte-identical (F5's guarantee).
- **A7** Route: tree is the default view; `sessionList` remains parseable and
  reachable (F1); deep-link `?root=` round-trips through the route codec if
  the unit adds scoped views (else the codec explicitly rejects it — decided,
  not accidental).
- **A8** Spawn-from-node derivation: node with `directory` → prefilled cwd;
  node without → project root default; `unfiled` → no prefill (it is not a
  place on disk).
- **A9** Empty states are honest: zero-node project renders its sessions;
  empty `unfiled` renders nothing rather than a mascot; a tree fetch failure
  renders last-known data with a staleness treatment, never a spinner over
  nothing (doctrine §5).
- **A-prior** All slice ≤14 assertions stay green (0.4); vue-tsc green
  (`.vue` gotcha); census 0 on every touched file.

## §5. Units (sequential; every WO cites `ui-doctrine.md` + its U-numbers)

- **U1 — the lib layer** *(sonnet; precise spec, no `.vue`)*:
  `lib/sessionTreeRows.ts` (+fixture tests: A1, A4 derivation halves, A9
  data shapes), `lib/sessionSeverityDisplay.ts` (A2),
  `TREE_AFFECTING_TYPES` + completeness test (A3), refusal message mapping
  (A5). Naming per §0 (never touch `treeNode.ts`).
- **U2 — TreeView + home cutover** *(opus; the big visible unit)*: the view,
  store `fetchTree` + throttled refresh + reconnect wiring, route default
  swap with `sessionList` fallback (A7), expand/collapse with rollups, both
  themes × three viewports, mobile frame + desktop sidebar. Read-only.
- **U3 — the write surface + spawn prefill** *(opus)*: create/attach/close
  flows with refusal rendering (A5 wired), spawn-from-node prefill (A8, F4).
  Fires the first production node events — the WO says so, so the agent
  treats the first 201 against the live daemon as an event worth logging in
  its checkpoint file, and slice 14's loose end closes with a pointer here.
- Fix units, if findings: fresh agents per D46, stop-condition tripwires in
  the fix WOs per the slice-14 pattern.

## §5b. FINDINGS

**S15-F1 (2026-08-13, U1, SIGNED + CLOSED same day → D87: option (a) with
three riders — type-only grep-assertable guard, payload-contract types only
with existing mirrors staying put, dependency declared in ui/package.json.
Fix unit U1b dispatched; halt lifted on its gate.)**
The UI package has a standing no-`@vimes/core` policy the U1 work order
violated on the orchestrator's bad recon.** `lib/types.ts`'s header (and
`gateCard.ts`, `correctionStatus.ts`) declare "@vimes/core is not a
sanctioned dependency of this package" — the narrow-mirroring idiom, held
across every lib module to date. The U1 WO cited those very files as
precedent FOR importing, because the orchestrator's recon grep matched them
by filename without reading the matches (the matches were the ban itself).
The agent executed as ordered, the imports work (type-only, workspace
resolution, zero config changes), and the agent correctly reported the
contradiction rather than patching either side. The ban's original rationale
points at a checkpoint file that no longer exists; the surviving rationale is
the idiom: the client re-declares narrowly the wire shapes it actually reads.

Options: **(a)** sanction TYPE-ONLY imports of served payload types
(`TreeResponse` family, `AttentionSeverity`) — one source of record for a
large recursive shape; hand-mirror drift is now the bigger risk than the
coupling the ban prevented; D85's hello floor is the runtime guard for deploy
skew either way; stale comments updated; decision record. **(b)** keep the
ban — a fix unit replaces U1's imports with narrow mirrors in `lib/types.ts`
(the biggest mirror yet, and it must track core's tree.ts by hand forever).
Orchestrator lean: **(a)**, type-only, payload-types-only (runtime imports
stay banned; core internals stay banned) — recorded as a D# on sign-off.

**S15-F2 (2026-08-13, U1b, SIGNED same day: ⟨Wes⟩ "Approved" → option (a),
recorded as the D87 ADDENDUM in decisions.md; fix unit U1c encodes the
test-file exemption in the guard).** Original record: The D87 rider-1 policy guard, built
exactly to spec, immediately caught pre-existing real code:
`sessionTreeRefresh.test.ts:2` VALUE-imports `EVENT_TYPES` from
`@vimes/core` — the U1 work order itself ordered that cross-check ("assert
the literals against `EVENT_TYPES.nodeCreated`…"), and U1's checkpoint
rationalized it as test-only, but no test-file exception exists in D87 as
signed. The U1b agent correctly left the violation in place (its constraints
forbade touching U1 files) and reported. Options: **(a)** amend D87 (dated
addendum, append-only): rider 1 binds SHIPPED source; `.test.ts` files may
value-import core — they run in node and never enter the bundle, so intent 1
is untouched, and the literal-vs-`EVENT_TYPES` cross-check is genuine drift
protection worth keeping; the policy test encodes the distinction (it
already does). **(b)** strict D87: fix unit strips the import and the
cross-check, literals stand alone. Orchestrator lean: **(a)** — the guard
caught exactly the kind of thing it exists to catch, and the answer is that
this instance is the sanctioned shape of the exception, not a violation.

**S15-F3 (2026-08-13, U2, SIGNED same day: ⟨Wes⟩ → option (a); unit U4
adds `TreeSession.createdAt` + threads it into the TreeView ladder;
converts the slice to daemon-affecting — restart in the deploy).**
Original record:
`TreeSession` carries no creation instant, so the identity ladder's bottom
rung renders without its timestamp — a nameless session row reads as two
hex strings side by side (`1a2b3c4d` fallback + `1a2b` short id). 6 of 13
live sessions hit that rung today. Options: **(a)** additive `createdAt`
on `TreeSession` (small core+daemon unit: `treeOf` copies the field the
fold already holds; restart required — the first daemon change of the
slice, converting it from UI-only). **(b)** accept double-hex rows and
judge legibility at the human gate on real data. Orchestrator lean: (a) —
the ladder's date rung exists precisely for the nameless case, and K1
(density/legibility) is the slice's sharpest kill criterion.

**U2 orchestrator-gate record (2026-08-13):** typecheck + vue-tsc clean,
3433/3434 (the 1 red is F2's deliberate policy assertion), daemon/core diff
EMPTY, census 0 × 8 files, TreeView + route + PanelHost diffs read. U2
agent findings triaged: the `#/sessions` escape hatch accepted (U10 — a
justified small addition, recorded); the INVENTED unseen-dot marker (`•`,
ink-toned) goes on the human gate's judgment list — the WO cited an idiom
that does not exist (orchestrator recon error #2 of the day); the stale
`meterAlerts.ts` comment is a loose end for the next daemon-touching unit;
the `panelStack.test.ts` expectation edits were 0.4-forced and correct.
COMMITS HELD (U1b + U2) until F2 resolves — the suite must be green at a
commit, and the red is F2's to clear.

**S15-F4 (2026-08-13, U3, IN-MANDATE RESOLUTION — fix unit U3b).** The U3
WO's premise "after a 2xx the refresh rides the WS event" was FALSE as the
client stood: the daemon emits the three node events on the `nodes` stream,
which no client ever subscribed (the store subscribes session streams + the
literal `tasks` only). Orchestrator premise error — the A3 completeness
test proved the SET contains the events, not that the events REACH anyone.
U3's agent used the house post-write idiom (2xx → throttled refetch,
acting tab covered) and reported rather than patching. Resolution is
completing signed intent (U9/A3), not a fork: U3b subscribes the `nodes`
stream on the `tasks`-stream precedent, giving other tabs/phones live node
propagation. Lesson attached to [[grep-hits-are-not-endorsements]]'s
family: asserting a set's membership is not asserting the plumbing behind
it.

**S15-F5 (2026-08-14, HUMAN GATE, SIGNED + CLOSED same day — ⟨Wes⟩ "Zap
that bug" → fix unit U5 `3abc41f`, deployed; ⟨Wes⟩ live-confirmed "every
tested session opens as expected").** During ⟨Wes⟩'s gate walk, sessions opened from the tree
rendered a BLANK body on first open, then "healed" on later opens —
looking exactly like replay lag. The full evidence chain exonerates every
data layer: daemon replay is instant and complete (tcpdump on loopback
during the live clicks: full 150KB replay pushed <3ms after the subscribe
ack, zero backpressure closes, no tunnel errors), client→daemon ops land
(`seen` events in the log from the same clicks), the UI's own
`parseServerEnvelope` drops nothing (133/133 against the real bytes), and
every lib derivation is total over every PREFIX of every one of the 47
production streams (7,156 prefixes, 0 throws — replay arrives
incrementally, so prefixes are the honest test). The break is
PRESENTATION: with a "blank" panel open, merely opening devtools makes
the missing text POP into view as the tiles re-lay out (⟨Wes⟩, observed
live). Content is in the DOM; a layout/paint state that any reflow
(resize, remount) repairs is hiding it. Symptom profile: first-open with
async replay fill = blank; re-open from filled store = fine; tiny streams
(2949f798, 5 messages) = fine. Suspect territory is the S15·U2 panel-tile
rewiring around the tree home (StreamView's own scroller idiom
`min-h-0 flex-1 overflow-y-auto` predates S15 and its follow logic reads
correct).

**MECHANISM PINNED (2026-08-14, ⟨Wes⟩'s inspector probe: blank `<main>`
has normal geometry, `scrollHeight`=`clientHeight`, `innerText:""` — the
event list renders EMPTY, it is not hidden).** The chain:
`PanelHost.vue` renders `StreamView` with **no `:key`** (the EditorView
branch one `v-if` above carries `:key="editorRoute.path"` — the idiom
exists in-file and StreamView missed it), and App.vue keys PanelHosts by
`trueIndex`. `openPanelFrom` replaces a stack slot's route in ONE update
(truncate+push), so opening session B while a stream panel occupies that
slot REUSES the mounted StreamView with a swapped `appSessionId` prop —
and `onMounted` (the ONLY site of `store.subscribe` + `markSeen`) never
re-runs. B's stream is never subscribed; no replay is ever requested; the
events computed reads an empty store entry reactively forever. Every
observation maps: fresh mounts work (page-load remembered panels, first
push at a new index); opening devtools narrows the viewport, flips the
desktop-stack↔phone layout arm, REMOUNTS the views → subscribe fires →
the "missing" text pops in "as the tiles adjust"; "healing" is
`subscribedStreams` accumulating per page-session (once any mount
subscribed a stream, its events persist in the store and later
reuse-opens render instantly — and reconnect resubscribes replay them
all, so heals arrive in batches); the phone arm was mostly immune because
back-pops unmount panels (two renders → real remounts). LATENT SINCE THE
D39–D41 DESKTOP STACK; surfaced hard by S15 because driving from the
persistent tree replaces the adjacent panel constantly. The daemon, the
tunnel, the WS protocol, the parser, and every lib derivation were
exonerated by direct evidence before the client was opened.

**Proposed resolution (fix unit, awaiting ⟨Wes⟩ sign-off):**
`:key="streamRoute.appSessionId"` on the StreamView branch in
PanelHost.vue — the in-file EditorView precedent; a remount resets
exactly the per-session state (scroll follow, seen-on-view, composer)
that SHOULD reset when the session changes. The unit also lands the
FIRST component-mount test (@vue/test-utils + happy-dom sit unused in
devDependencies): mount PanelHost at stream(A), swap the route to
stream(B), assert the store saw subscribe(B); sabotage = drop the `:key`
→ test reddens. Same-trap audit of the sibling keyless branches
(FileTreeView/initialDir at minimum) rides along as a REPORT, not a
blanket fix (S14-F1 lesson). Machine-gate escape is structural: nothing
in the gates mounts a `.vue`; this unit closes that hole with the first
mounted assertion. Rule 0.1: the human gate HALTS here until the fix
lands and ⟨Wes⟩ re-walks the tree flow.

**S15-F6 (2026-08-14, HUMAN GATE step 2, OPEN — ⟨Wes⟩ FAIL verdict,
design fork awaiting the call).** ⟨Wes⟩ opened the first `?`-wearing
session in the tree (f35a77dd, a plan session that delivered its plan
2026-07-28) and ruled: "the session needed no attention but was emitting
an attention signal." The machine is faithful to §3b as signed:
`run_completed` set `needsAttention{reason:'completed'}`, `completed`
ranks `waiting_input` ("a finished run is a decision — somebody has to
acknowledge the result"), seen never clears it (D83), and nothing ever
acknowledged it — so it has shouted `?` for 17 days, alongside ~40
siblings. The human gate's verdict is that this PRICING, lived in, reads
as noise: `?` semantically claims "waiting on your input" and a delivered
plan is not. Fork (no code until signed): **(a) debt-sweep only** — keep
§3b, one-time evented `attention_cleared` backfill for pre-tree history;
future completions still demand manual acknowledgment forever (the exact
experience just failed). **(b) reprice `completed` → idle** — §3b
amendment + severity-order version bump; the fold is pure so ALL debt
quiets instantly with zero migration; loss: the tree no longer
distinguishes finished-unreviewed from idle (push notification + the
run_completed row in the stream remain the completion evidence). **(c)
`seen` clears `completed` (only)** — viewing the result IS receiving it;
CONTRADICTS SIGNED D83, so it is a true flag if chosen. Orchestrator
lean: (b), with (c) as the runner-up if ⟨Wes⟩ wants "opened it = done
with it" semantics. Gate walk HALTED at step 2 per rule 0.1.
**SIGNED same day → D88 (option (b), grounded deeper by ⟨Wes⟩: attention
marks work asking for input; completion is a terminal fact; the
ask-shaped residue of a finished run belongs to the deliverable, not the
session). Fix unit U6; the pure join means the whole debt quiets on
deploy with zero migration; walk resumes at step 2 after the core
deploy + restart.**

**S15-F8 (2026-08-14, HUMAN GATE, SIGNED same day → D90 — the tree
ignores the tab's project scope).** The walk found the vimes tab
rendering the ENTIRE forest — every project's sessions, expand-all-once,
served order across projects — so vimes+johnny ran the estate off the
screen and a third project's attention glyph could scroll out of sight
entirely. Root cause is an orchestrator gap: the S15·U2 fetch comment
recorded "scoping is expand/collapse state in the view" as the design,
but no unit ever implemented the scoping half — the skeleton never
priced it, and the daemon's `?root=` filter (S14-A10) sits consumed by
nobody. ⟨Wes⟩'s ruling (verbatim intent): one project per tab; the tree
shows THIS project's estate in full, other roots as rows-without-
sessions wearing their rollup glyphs; the human opens that project's own
tab to look inside. Full decision + accepted consequences (unfiled
unreachable from scoped tabs until slice-16 prices its home) in D90.
Fix unit U7 (client-only; the whole-forest fetch stays). Walk findings
tally: F5 (blank panels), F6 (completed pricing), F8 (scope) — three
structural catches in one gate walk; the gate is earning its keep.

**S15-F9 (2026-08-17, HUMAN GATE step 5, OPEN — spawn-from-node does not
attach).** ⟨Wes⟩ spawned from the first production node: directory
prefill PASSED (log-verified: `session_created` cwd is the project dir),
but the session landed at the project ROOT, not under the node — no
`session_attached_to_node` was ever proposed. As built this matches the
U3 work order (F4/A8 priced the prefill only); the gate says the
INTENT is bigger: spawning FROM a node should parent the session there.
Fork: (i) UI chains the existing attach verb after the `spawned` ack —
client-only, two honest proposals, a raced refusal renders per house
idiom; (ii) the spawn op grows a `nodeId` — atomic but a daemon/protocol
change. Orchestrator lean: (i) now, (ii) recorded for the day atomicity
matters. **SIGNED 2026-08-17 ⟨Wes⟩: option (i)** — "If I click a node
and 'spawn a session' I expect it to spawn attached to that node.
Otherwise what's the point of that button. I could spawn an unattached
session any other way." Fix unit U9.

**S15-F10 (2026-08-17, HUMAN GATE step 5, OPEN — timestamps render UTC
digits as if local).** The tree said "Aug 17 12:02" for a session
spawned 08:02 EDT. `lib/sessionLabel.ts` is DELIBERATELY locale-free
(deterministic, no Date/Intl — the right property for a tested lib) and
renders the ISO string's UTC digits verbatim — so every timestamp the
label ladder shows is off by the viewer's UTC offset. Fix shape, house
style (rule 0.3 — inject at the boundary): the formatter takes an
injected offset-minutes parameter (tests pass fixed offsets,
deterministic), the view passes the browser's real offset. Small unit;
sweep any other label-ladder consumers for the same verbatim rendering.
**SIGNED 2026-08-17 ⟨Wes⟩: go.** Fix unit U8.

**Walk observation, NOT a finding (2026-08-17):** the spawned session
ANSWERED "~" when asked its current folder — but the infra is truthful
end-to-end: `session_created` records the project cwd, and the CLI
child's transcript landed in the cwd-keyed directory
(`-home-ticktockbent-projects-infrastructure-vimes/`), which proves the
process genuinely ran there. The "~" was the model's answer, not the
process's location. Step 2's old session writing to `~` is the same
class: session-context behavior, not estate state.

**Walk notes, judgment items RULED (2026-08-17, ⟨Wes⟩):** short id on
rows stays (F3 judged fine), the invented unseen-dot `•` stays, the
remembered `#/sessions` panel stays — "not interested in messing with a
UI we're about to totally revamp." For the revamp's notebook: the ⋯
action sheet dismisses only by tapping ⋯ again — not discoverable; a
small explicit close (an ×) would read better. The `~` observation is
fully closed: ⟨Wes⟩ had the session run `pwd` and it reported the
project directory — false signal confirmed.

## §6. Gates & kill criteria

**Machine gate:** suite green ×2 (prior slices included), vue-tsc green,
ci-gate ALL PROFILES, census 0. ci-gate run = the deploy (UI-only; no
restart — verified by the §2 diff rule `git diff --name-only <base>..HEAD --
packages/daemon packages/core` being EMPTY, checked at my gate, every unit).

**Human gate (judgment half, ⟨Wes⟩):** drive a real work session with the
tree as home — including from the phone: see an attention item in the tree,
decide it from there (U3 doctrine test); create a node, attach a session,
spawn from a node with the prefill; watch severities move live under the
throttled refresh. PASS = the tree matched reality the whole time and the
phone let you decide, not just watch. F3's short-id call is judged here too.

**Kill criteria:**
- **K1 (density).** Real data (47 sessions, 21 unfiled) is illegible or
  chrome-bound on a phone → halt, revisit the row design against U1/U2 —
  never push the sweep through (the 6b precedent).
- **K2 (payload).** A unit can only make the tree usable by re-deriving or
  re-sorting served facts client-side → halt; that is a finding on slice 14's
  payload shape, not a client workaround (U8).
- **K3 (liveness).** The throttled-refetch pattern leaves the home surface
  visibly stale under normal traffic → halt; the WS tree-delta question
  reopens as a decision, not a patch (U9).
