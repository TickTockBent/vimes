# Slice 16 — sessionList dies; sessions get names

**Status: SIGNED 2026-08-17 ⟨Wes⟩ — "signed as written, keep rolling."
All ten §3 decisions signed at skeleton review; D73 and D91 moved to
decisions.md same day. Units dispatch sequentially per §5.** Sequenced 2026-08-17 (⟨Wes⟩-approved order): slice 16 →
E2-c → Move 4; InputLease parked until briefings are scheduled.

The tree became home in slice 15; this slice deletes the surface it
replaced (`#/sessions` + SessionListView) and pays the two debts that
deletion calls due: D90's accepted "unfiled unreachable from scoped tabs
until slice-16 prices its home," and D91's sea of "You are a worker
session that…". Principle 9: after this slice, ONE surface claims to be
the session record.

Inputs: `sessionlist-deletion-map-2026-08-13.md` (the seven-decision
recon), D90, D91 (open-questions), D73 (open-questions, RIPE at five
identical warnings), ui-doctrine.md.

---

## §0. Recon reconciliation (2026-08-17, orchestrator-verified at HEAD `b225c20`)

Deltas against the 08-13 map — verified today, not assumed:

- **killConfirm SURVIVES.** The map's ⚠ resolved itself: slice-15 U3's
  TreeView consumes `reduceKillConfirm`/`isConfirmingKill` for close-node.
  Only `sessionListPartition.ts` (+test) still dies with the view.
- **The spawn wire already carries `name?: string`** (`wsHub.ts`
  spawnEnvelopeSchema) and the `rename` op is shipped
  (`renameEnvelopeSchema`, case 'rename'). D91 prongs (i)/(iii) need NO
  protocol work.
- **Prong (i)'s exact site:** `taskDispatcher.ts` (~line 595) builds
  spawnOptions with NO `name`; `orchestratorApi.ts` already names its
  session ("Orchestrator — …"). The asymmetry is the bug.
- **`sessionRow.ts` imports confirmed:** only `sessionLabel.test.ts:8`
  and the dying view. (Other grep hits are unrelated identifiers.)
- **The five nav intents** (`openFiles/openTerminal/openGit/openCost/
  openTasks`) are app-chrome BUTTONS in SessionListView (lines ~470–510),
  not per-session affordances. Their only producer dies with the view.
- **`store.renameSession` exists** (vimesStore.ts:1601), currently
  orphaned-in-waiting; `spawnSession` already rehomed (U3, slice 15).

## §1. Scope

- Delete SessionListView.vue, the `#/sessions` route + variant +
  expandMeters + `#/meters` buildHash, `sessionListPartition.ts` (+test),
  `sessionRow.ts` (ladder assertion re-anchored first).
- Rehome every orphan the map names: rename (⋯ sheet), push bell,
  meters-strip residuals, nav intents, cold-open panel default.
- D91 naming, all three prongs.
- D73 pin (floor + last-verified), riding the slice's one daemon unit.
- Attach-picker scoping (the unruled slice-15 U7 flag — dies here).
- Unfiled's interim reachable surface (D90's floor).

## §2. Explicitly out

- Real unfiled TRIAGE UI — extension-era tenant per ⟨Wes⟩'s lean
  (deletion-map seventh decision). This slice ships only the floor.
- E2-c, Move 4, InputLease/D81 (sequenced after; see status line).
- D89 attention-mechanism, F7 conclude-mirror verb (parked, unhurried).
- Any UI revamp cosmetics (⋯-sheet ×, spawn-button wording — notebook).
- Migration of historical session names: prong (ii) is a DERIVATION over
  existing data; no events are rewritten (spine is append-only).

## §3. The decisions (⟨Wes⟩ signs each; leans are the orchestrator's)

1. **Meters-strip residuals.** LEAN: relocate the MANUAL REFRESH button
   and the "polling disabled" notice into the UsageGauge pulldown (they
   are the only UI for `refreshUsage`/`usageRefreshInFlight`); ACCEPT
   LOSS of the per-meter freshness word (the gauge already shows age).
2. **`/#/meters` deep link (daemon-owned, meterAlerts.ts).** LEAN:
   retarget `METER_ALERT_DEEP_LINK` to bare `/` — the gauge is
   persistent chrome on every surface, so the alert lands somewhere the
   meters are always one tap away. Rides the daemon unit (U1), which
   also fixes the stale comment at meterAlerts.ts:173-176.
3. **`sessionRow.ts` fate.** LEAN: delete; re-anchor sessionLabel.test's
   ladder assertion directly (the test asserts the ladder, not the row).
4. **Orphaned store actions.** `spawnSession` done (S15·U3). LEAN:
   `renameSession` → ⋯ sheet (D91 prong iii); `killSession` → session
   ⋯ sheet (same sheet, kill-confirm idiom already in the file — D10
   custody refusals render verbatim); `discover` → **U4's top-bar
   chrome** *(AMENDED 2026-08-17 at U3 authoring, in-mandate: the
   signed lean mis-slotted it per-session, but `store.discover()` is a
   parameterless GLOBAL rescan — `sendEnvelope({op:'discover'})` — so a
   per-row placement would be a lie about its scope)*; `togglePush` →
   decision 6; `refreshUsage` → decision 1. No store action is deleted;
   every survivor has a caller by slice end (grep-gated).
5. **Nav intents.** LEAN: the five buttons move to top-bar app chrome
   (beside the UsageGauge) — they are app-level navigation and always
   were; parking them per-view was an accident of the old home. TreeView
   emits nothing new.
6. **Push bell.** LEAN: top-bar chrome with the existing
   `isBellActionable`/`pushStateLabel` derivations intact (tested lib
   survives; only the mount moves).
7. **Unfiled's home (D90's floor).** LEAN: the interim surface is the
   bare-`/` project picker — it gains an "unfiled" row (rollup glyph +
   count, sessions listed on tap, read-only) served by the already-shipped
   unfiled root in `GET /api/tree`. Real triage stays extension-era.
   Verify-first: if the picker already renders the full forest, this
   may be a styling pass, not a feature.
8. **Cold-open panel default** (App seeds stack[0] = `#/sessions` today —
   implied by the map, called out here). LEAN: cold open shows the tree
   with an EMPTY panel + one-line hint ("open a session from the tree").
   The remembered-panel behavior ⟨Wes⟩ ruled stays; this is only the
   nothing-remembered case. Honest over busy.
9. **D73 pin (Gate-D — sign before U1 builds).** Replace exact-equality
   warn with: **floor `2.1.224`** (warn only when observed < floor;
   forward auto-updates go silent) + **last-verified marker `2.1.224`**
   (boot line reports "N releases ahead of evidence" as INFO, not a
   warning). Both values move only by deliberate re-pin at verification
   spikes. On sign-off D73 moves to decisions.md.
10. **D91 naming, three prongs** (on sign-off D91 moves to decisions.md):
    (i) `taskDispatcher.ts` passes the task/stage title as spawn `name`
    (the slot exists; orchestratorApi already does this); (ii)
    `resolveSessionLabel` learns a boilerplate-skipping fallback — skip
    known briefing prefixes ("You are a worker session…") to the first
    distinguishing line (tested lib, pure derivation, U8's offset
    threading untouched); (iii) rename affordance in the ⋯ sheet wired
    to the shipped `rename` op.

## §4. Assertions (S16-A#; lib-level per house rule)

- A1: `resolveSessionLabel` boilerplate fallback — briefing-prefixed
  fallback text yields the first distinguishing line; non-boilerplate
  text unchanged (byte-equality passthrough test); named sessions
  bypass the fallback entirely.
- A2: route fallback — every dead hash (`#/sessions`, `#/meters`,
  variants) lands on the home route; ROUTE_PRECEDENCE re-pinned; no
  route in the table renders a deleted view.
- A3: `METER_ALERT_DEEP_LINK` re-pin (meterAlerts.test.ts) to `/`.
- A4: D73 — floor comparison warns on observed < floor, silent on
  observed ≥ floor; last-verified line is info-class. (Sabotage: set
  floor above observed → warning appears.)
- A5: dispatcher names — dispatched spawnOptions carry the task title;
  orchestrator naming unchanged (existing test re-read, not re-pinned).
- A6: attach-picker scoping — picker offers only the tab's project's
  nodes (foreign roots absent; lib test).
- A7: grep gate — *(REFRAMED 2026-08-17 at the U5 gate, in-mandate: the
  literal form was unsatisfiable by construction — the remembered-layout
  degradation test REQUIRED the dead `#/sessions` string, dist/ holds
  stale build artifacts until the next build, and historical comments
  legitimately narrate the deletion)* — over `packages/*/src`, excluding
  comments and test literals: zero IMPORTS, zero MOUNTS, zero live
  references to SessionListView / sessionListPartition / sessionRow;
  zero live `href`/navigation to `#/sessions`/`#/meters`; every
  surviving store action has ≥1 non-test caller. Verified independently
  at the orchestrator gate, not only by the agent.
- Prior suites green (0.4). Final count expected > 3486.

## §5. Units (sequential; skeleton → sign-off → dispatch)

- **U1 (daemon, ONE restart owed):** name-at-dispatch (prong i) + D73
  floor/last-verified in config.ts + METER_ALERT_DEEP_LINK retarget +
  meterAlerts.ts:173-176 comment fix. Restart with ancestry check.
- **U2 (lib):** prong (ii) label fallback (sessionLabel.ts + test).
- **U3 (UI):** ⋯ sheet grows rename (prong iii) + kill + discover per
  decision 4; attach-picker scoping (A6). vue-tsc leg.
- **U4 (UI):** top-bar chrome — nav intents + push bell + gauge-pulldown
  residuals (decisions 1/5/6). vue-tsc leg.
- **U5 (UI, THE DELETION):** re-anchor label test off sessionRow; delete
  view/route/partition/sessionRow; cold-open default (decision 8);
  unfiled picker row (decision 7); route re-pins (A2). vue-tsc leg.
- **U5b (UI, follow-up):** U5's one STOP — TreeView's S15·U10
  "Sessions ›" escape hatch still linked the dead route (the agent
  correctly held the TreeView STOP constraint rather than fix it
  in-place); U5b removes the link + rewrites two stale comments
  (App.vue seeding note, panelStack.ts). Gate working as designed,
  not a rule-0.1 finding: an in-slice sequencing artifact, caught
  before deploy.
- Deploys: U1 = ci-gate + restart (DONE 2026-08-17 12:13 — D73's first
  clean boot); U2–U5b ride ONE ci-gate (UI-only, no restart) —
  bundling per gate discipline, Wes owns awareness (D19).

**Unit ledger (2026-08-17):** U1 `7899e41` (deployed, restart 12:13) ·
U2 `71f27e4` · U3 `8271c60` (+ decision-4 amendment: discover is
global) · U4 `e5c568b` · U5 `38e4a76` (decision 8 verified
already-built; cold open seeds [tree] + hint) · U5b `ba8b4fb`.
**Machine gate PASSED 2026-08-17: suite green ×2 (3493/147), ci-gate ALL
PROFILES, live-code grep clean; U2–U5b deployed in one ci-gate run
(UI-only, no restart). Human gate WALKED 2026-08-17 (§7): 8/9 clean,
HALTED on S16-F1 (§8) pending ⟨Wes⟩'s ruling.**

## §7. Human-gate walk record (⟨Wes⟩, 2026-08-17)

1. Cold open → tree + hinted empty panel: **PASS**.
2. Dispatched session arrives named, lands inside the node: **PASS**.
3. Historical labels: ALL old sessions render timestamp·shortId; only
   the newest (a direct prompt, not a dispatch briefing) shows prompt
   text. **Expected a distinguishing task line → S16-F1 (§8).**
4. Rename **PASS** (spine: `session_renamed` 17:59:39Z), attach
   **PASS**; kill LOOKED inert from the phone but **VERIFIED WORKED on
   the spine**: `liveness_changed cause:"killed" → dormant` at
   17:59:21.595Z with the session's own `hook_session_end` 18 ms later
   (the process confirming its death). The only UI signal is the
   liveness glyph flip — a killed session stays in the tree, correctly
   (it is still a fact). *Cosmetic note, no action this slice: kill has
   no acknowledgment moment; note-and-proceed per the momentum
   calibration.* Correct refusals observed: attach-to-current-node and
   node-to-node move both refused (current design). Orchestrator
   attach-immunity raised → **D94** (open-questions).
5. Header chrome: **PASS** ("look good").
6. Gauge pulldown: **PASS**.
7. Dead bookmarks (`#/sessions`, `#/meters`): both land home silently,
   no error: **PASS**.
8. Unfiled reachable via bare-`/` picker: **PASS**.
9. Boot line (D73 floor semantics): **PASS**.

## §8. Findings

### S16-F1 — prong (ii) is a structural no-op for its entire target population: the core title cap truncates BEFORE the `Task:` marker in every real briefing variant (2026-08-17, human gate step 3)

**Observed:** every historical dispatched session renders the
timestamp·shortId rung, never a distinguishing task line.

**Evidence chain (orchestrator, spine read-only + source):**
- The spine's historical briefings DO carry real content after a
  `Task:` marker (events 2026-08-05 → 08-12, all three variants:
  implement / REVIEW / PLAN — e.g. "Task: getMany(ids) — …").
- Core caps the derived title FIRST: `deriveSessionTitle` returns
  `singleLineText.slice(0, SESSION_TITLE_MAX_LENGTH)` with
  `SESSION_TITLE_MAX_LENGTH = 120` (sessionIdentity.ts:26,128).
- Measured `Task:` positions in the three real briefing preambles
  (whitespace-collapsed): implement **178**, REVIEW **182**, PLAN
  **160** — ALL beyond 120. The capped derivedTitle therefore NEVER
  contains the marker, for any real dispatch, ever.
- U2's UI stripper matches the stem, finds no `Task:` in the capped
  input, returns null → ladder falls to the timestamp rung. That is
  its designed drift-inert degradation — firing 100% of the time.

**Why the machine gate missed it:** A1's fixture placed `Task:` within
120 chars — shorter than every real briefing preamble. The lib test
proved the mechanism, not the population. (Same lesson-family as
"verify guards by breaking them": fixtures must be drawn from the real
data shape, not a convenient one.)

**Kill-criterion check:** NOT triggered — no fix candidate rewrites
events; both are pure derivation/display.

**Options for ⟨Wes⟩'s ruling:**
- **(a) Accept the loss.** Historical dispatched sessions keep
  timestamp·shortId (still strictly better than the boilerplate sea —
  the suppression half of prong (ii) works). D91 prong (i) names every
  FUTURE dispatch, so the affected population is fixed and closed. Zero
  work; U2's stripper stays as defense-in-depth.
- **(b) Fix in core (orchestrator LEAN).** `deriveSessionTitle` learns
  the dispatch-boilerplate skip BEFORE capping: stem match → text after
  first `Task:` → cap at 120. Pure derivation over the append-only
  spine; projection replay updates history; no event rewrites. One
  small core unit + restart. The work order must (1) check snapshot
  staleness (the snapshots table may pin old derivedTitles — verify
  rebuild semantics first), (2) restate that the UI stripper becomes a
  passthrough for these inputs (kept, per defense-in-depth), (3) draw
  its fixtures from the three REAL briefing preambles verbatim.

**RULED 2026-08-17 ⟨Wes⟩: "Fix in core 100%" — option (b). Fix unit is
S16·U6 (NEW agent per discipline).** Orchestrator recon pinned the fix
shape before dispatch:
- The briefing composer is CORE's `stageInstruction.ts` — four
  byte-stable opening variants sharing the stem, each building a
  `Task:      ${label}` line — so the skip logic couples to the REAL
  stems via a core test (the UI stripper's "drift risk, stated" comment
  becomes a machine-checked invariant).
- Snapshot staleness has a designed answer: D86 versioning
  (`projection.ts:131` discards a version-mismatched snapshot → full
  replay). Sessions projection bumps 1 → 2, licensed by D86's
  "re-meant" clause: `derivedTitle` changes meaning from "capped head
  of first message" to "the task line, for dispatch briefings". The
  bump IS the history migration — replay re-derives every historical
  title; no event rewrites (kill criterion still not triggered).
- Core sees the RAW multi-line content, so it takes the `Task:` LINE's
  remainder (exactly the label) rather than the UI's
  everything-after-marker (which would drag `Stage:`/`Directory:`
  along). Stem without a marker → null (consistent with the
  wrapper-prefix treatment; ladder falls to timestamp as today).
- UI stripper KEPT untouched as defense-in-depth (per the ruling's
  option text); one daemon restart owed (core change + snapshot
  discard/replay verified at the orchestrator gate).

## §6. Gates & kill criteria

- **Machine gate:** full suite green ×2, ci-gate ALL PROFILES, grep gate
  (A7) empty.
- **Human gate (⟨Wes⟩, phone):** cold open lands on the tree with the
  hinted empty panel; dispatched sessions arrive NAMED; a historical
  boilerplate session shows a distinguishing label; rename a session
  from ⋯ and watch a second tab update; find and toggle the push bell;
  fire a meter alert and follow its deep link home; reach an unfiled
  session via the bare-`/` picker; U1 boot line shows the D73 floor
  semantics (no drift warning at current CLI).
- **Kill criteria:** any daemon/core reference to the dying surface that
  the map didn't predict (halt, rule 0.1 — the map claimed daemon/core
  clean); a route-fallback change that breaks a REMEMBERED panel
  (⟨Wes⟩ ruled remembered panels stay); prong (ii) requiring event
  rewrites (it may not — derivation only).
