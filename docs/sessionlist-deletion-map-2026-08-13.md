# SessionListView deletion map (recon 2026-08-13 — slice-16 §0 input)

*(Read-only inventory for the deletion unit F1 schedules next slice. Line
numbers for in-flight files (route.ts, PanelHost.vue, App.vue, vimesStore.ts)
are HEAD-relative; treat as "site exists," reconcile at skeleton time.)*

**Mount/coupling:** PanelHost.vue is the ONLY mount (+7 event wires); App.vue
seeds stack[0]; route.ts carries the variant + expandMeters + buildHash
'#/meters'. Nothing outside packages/ui references the view or route (daemon/
core/scripts/deploy clean). No component tests exist anywhere (no
@vue/test-utils) — all breakage is route/lib unit tests.

**DIES WITH THE VIEW:** lib/sessionListPartition.ts (+test) — sole consumer;
lib/killConfirm.ts (+test) — sole consumer (⚠ but slice-15 U3's close-node
confirm plans to USE killConfirm — check before deleting!). Emits openFiles/
openTerminal/openGit/openCost/openTasks.

**MUST SURVIVE:** sessionLabel (4 consumers), cacheBadge, projectContext,
meterDisplay (usageGauge/StreamView/UsageGauge/store — EXCEPT refreshNotice/
RefreshNoticeTone: strip-only), pushState (store uses derivePushState; but
isBellActionable/pushStateLabel are strip-only), sessionRow.ts (kept alive
ONLY by sessionLabel.test.ts:8 asserting the ladder through it).

**Meters strip vs UsageGauge (facts for the redundancy call):** UsageGauge
(persistent top bar, pulldown, all constraints, reset/burn/projection/age,
honest-empty) covers everything EXCEPT: per-meter freshness word, the
freshnessBandMissing "polling disabled" notice, and the MANUAL REFRESH button
— the only UI for store.refreshUsage/usageRefreshInFlight/lastUsageRefresh/
meterDisplay.refreshNotice. Store-side usage fetches also ride the sessions
refresh, so the gauge keeps data without the view.

**NEEDS A DECISION (six, for the slice-16 skeleton):**
1. Meters-strip residual content: the three non-redundant pieces above — relocate
   (gauge pulldown?) or accept loss.
2. `/#/meters` deep link is DAEMON-owned (meterAlerts.ts:177
   METER_ALERT_DEEP_LINK + its test) — retargeting is a daemon change; a
   UI-only deletion leaves push notifications landing on the default view.
3. sessionRow.ts fate (test-only survivor — move the ladder assertion?).
4. Orphaned store actions: spawnSession (→TreeView per slice-15 U3),
   killSession, renameSession, discover, togglePush, refreshUsage — five have
   NO stated new home.
5. Nav intents openFiles/openTerminal/openGit/openCost/openTasks: their ONLY
   producer app-wide is the dying view — TreeView must re-emit or navigation
   to Files/Terminal/Git/Cost/Tasks disappears.
6. Push bell: isBellActionable/pushStateLabel/togglePush exist only here —
   the "enable push" gesture needs a new home.

**Test blast radius:** route.test.ts (fallback table, ROUTE_PRECEDENCE,
round-trips, navigateHome), panelStack.test.ts (empty-hash identity case),
the two dying lib test files, meterAlerts.test.ts pins '/#/meters'.

## Post-D90 addition (2026-08-14): unfiled's home — SEVENTH decision for the skeleton

D90 (tree gated by tab scope) knowingly made unfiled sessions unreachable
from every scoped tab — reachable today only through `#/sessions`, which
this map deletes. The skeleton must price unfiled's home BEFORE the list
dies. **⟨Wes⟩'s lean, same day:** don't assume core UI owns this — "we
could easily build an extension that handles nonscoped sessions" — i.e.
unfiled triage may be the extension model's first real UI tenant
(principle #15; same neighborhood as D89's attention-mechanism edge and
D75's surface placement). Core's floor if the extension route is chosen:
the data stays served (unfiled root + rollup in `GET /api/tree`), and
SOME reachable surface must exist before deletion — even if that surface
is "the picker at bare `/` still shows the full forest" as the interim.
