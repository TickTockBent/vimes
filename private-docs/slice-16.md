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
(UI-only, no restart). ⟨Wes⟩'s §6 human gate walk IN PROGRESS.**

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
