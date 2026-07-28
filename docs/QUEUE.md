# Small queued items (dispatch-ready, waiting on a free slot / no conflict)

Work items, not design records — decisions live in `decisions.md`, design in
`design-directions.md`. Kept in `docs/` (not `scratchpad/`, which is gitignored
working space) so the queue is durable and reachable from the phone, the same
reason `slice-6-test-plan.md` lives here. Delete an entry when it ships.

---

## BUG — task toast's "move to" options don't refresh after a stage move (UI-only)

Observed 2026-07-26 (Wes, during Gate-1 testing). Moving a task from the task toast
(e.g. Implementing → Review) DOES move it, but the toast keeps showing the
destination stages valid for the OLD stage — the "move to" set doesn't refresh to the
new stage's legal edges until the toast is closed and reopened. **Hypothesis:** the
toast computes its destination list once on open (a snapshot of `task.stage`) instead
of deriving it reactively from the live task record in the store, so it goes stale
after the transition streams back. **Fix locus:** make the toast's destination-edge
list a reactive derivation of the current `task.stage` (from `TASK_STAGE_EDGES` /
whatever the UI mirror is), not a value captured at open. UI-only (`packages/ui`),
no daemon change → ships on the next ci-gate, no restart. Small.

## FIX — stage-scope the report tools (planner called report_completion → spurious human gate)

*(Observed 2026-07-28, planner f35a77dd on task 25f9c558.)* Report tools are exposed
to ALL dispatched sessions (S7·6b: "guards make it safe"). The guards DID hold — the
planner's post-plan `report_completion` call no-opped (no implementing ref) — but the
call FIRED A HUMAN GATE first, because of a permission-mode asymmetry the johnny run
couldn't show: `auto` (implementing/review) bypasses `canUseTool` for MCP tools
(handler capture, 0 gates), while **`plan` (planning) routes MCP calls through
`canUseTool`** → gate_fired → phone. Unattended, that's a STALL: a planning session
hanging on a gate nobody answers. **Fix: scope `reportTools` by stage at spawn** —
planning gets NONE (it finishes via ExitPlanMode), implementing gets
`report_completion`, review gets `report_review`. The recordX guards stay as belt.
Daemon change (restart). Small; do before any unattended fleet run.

## CLEANUP — UI dead branches: `resumed`/`resume-failed` dispatch outcomes (post-D46)

*(S7·7b-daemon finding, 2026-07-27.)* D46 removed the resume path; the daemon can no
longer produce the `resumed`/`resume-failed` dispatch outcomes. The UI still handles
them: `taskBoard.ts:682,723` (+ docs at :638, `dispatchFollow.ts:23`, and their
tests). They read the outcome as an untyped string off the HTTP envelope, so nothing
reds — they're just dead. The daemon-side union variants are kept declared, marked
`⚠ UNREACHABLE SINCE D46`, with a comment naming these consumers; **remove the UI
branches and THEN the union variants in one small UI-inclusive unit.** Sonnet-
mechanical. Not scheduled.

## UNIT — dispatch-on-promotion for ACTIVE stages (after S7·7b; decisions.md D53)

*(Wes, 2026-07-27: "The promotion should be the decision. No task moves to an active
stage unless it's ready to begin.")* Entering **planning** or **implementing** via a
promotion triggers the stage dispatch automatically (today: promote + dispatch are two
separate manual clicks). **Review is explicitly excluded** — it's a holding pen (D53):
entering it dispatches nothing; reviewer-vs-bounce stays a decision. Dispatcher-layer
wiring: observe `task_transitioned` into an active stage → run the existing dispatch
path (decideDispatch still guards). Sequenced AFTER S7·7b (touches the same dispatcher).

## POLISH — briefing prose pass: unwrap mid-sentence newlines + degenerate-criteria clause (one golden refresh)

*(Wes, 2026-07-27, after the first full live loop.)* Two prose defects in the
`stageInstruction.ts` briefing constants, one small unit, ONE deliberate golden refresh:

1. **Odd mid-sentence newlines in every briefing.** The constants are template literals
   hard-wrapped at ~80 cols for source readability — template literals preserve those
   newlines verbatim, so prompts ship with wraps like "report_review\ntool" mid-sentence.
   (Orchestrator's own authoring artifact, S7·5c/6a.) Harmless to the model —
   live-proven 2026-07-27 — but reads badly to any human inspecting a prompt. Fix:
   unwrap to real paragraphs (constants stay constants; NO runtime join-transform).
2. **Degenerate-criteria clause (low-priority, observed coping fine).** A task with no
   `acceptanceCriteria` renders no criteria section, but the byte-stable closing still
   says "one entry per criterion (its id…)". The 2026-07-27 live run showed a capable
   model derives its own criteria from scope without floundering — so this is polish,
   not a must-fix. Add one conditional line for the no-criteria case: "no enumerated
   criteria — derive your own from the scope and report each."

⚠ These constants are pinned by golden-string tests AND serve as byte-stable
cache-prefix material — the unit refreshes the goldens **deliberately** (call it out in
the diff) and keeps prefix-stability discipline (stable opening/closing, per-task
middle). Sonnet-mechanical once scoped. Not scheduled.

## ENHANCEMENT — surface a task's dispatched sessions, with click-to-open links (spike-worthy)

*(Wes, 2026-07-27, planning the S7·6 live-test: "it would be good if we kept a list of
each associated session dispatched from a task with easy links in the task itself.
Might be a later enhancement, worth spiking.")*

**The data already exists — this is surfacing + linking, not new capture.** Tasks already
carry **`sessionRefs`** (stage + appSessionId per dispatched session) — that is the exact
record `recordPlan`/`recordReview` reverse-lookup to find a task's owning session by
appSessionId+stage. So the association is durable already; what's missing is a **read-model
surface + a UI affordance** that lists a task's sessions (by stage/attempt) and links each to
its stream/panel (the same click-to-open S9 wired for the dispatch notice —
`vimesStore.ts` dispatch response → route to the session's stream view).

**Why it's still spike-worthy (small design questions before scoping UI):**
- Are `sessionRefs` already in the **tasks read model** the UI consumes, or only in the
  daemon-side task record? If not exposed, surfacing them is a read-model addition (daemon
  change → restart), additive (rule 0.5).
- **Shape:** multiple attempts per stage (a failed review sends it back to implementing → a
  2nd implementing session, then a 2nd review). The list wants to show stage + attempt +
  outcome, not just a flat id soup — so it reads as the task's *history*, not a bag of links.
- **Link target:** today = route to the stream view; under the panel model = open the session
  panel. Same affordance S9 built.
- Overlaps the **session-links** half of Q2/S9 and the eventual project-history read-model —
  worth checking whether this is one surface with those rather than a standalone.

**Deliverable of the spike:** where `sessionRefs` live vs. what the UI is served, the
per-stage/attempt shape, the link-target call, and whether it folds into an existing surface.
Then a small unit surfaces it. **Not scheduled** — a later enhancement, captured now.

## ▶ NEXT SESSION STARTS HERE (updated 2026-07-25 eve — read `scratchpad/HANDOFF.md` first)

**SLICE 6b — DONE** (UI foundation + full re-skin; deployed). **SLICE 7 (task model)
— GATE-1 BUILD SPINE ~COMPLETE, all deployed** (HEAD `6af9ecb`). Built this session:
S7·0 spike, S7·1, S7·2a, S7·3, S7·4, S7·5a, S7·5b-i, S7·5b-ii — **native plan capture
is LIVE end-to-end** (plan-mode planning spawn → ExitPlanMode interception → artifact
store → plan-ready). Gate-D signed off (**D48**: native plan mode adopted, R-a
accepted).

**RESUME AT: `S7·7a`** — the fresh-implementer handoff (`composeStageInstruction` for
`implementing`, seed = work-order + plan-by-hash). It's the LAST Gate-1 build unit;
then **Wes's human exit gate** (one real work-order end-to-end, zero steers) closes
Gate 1. Full detail + resume path in `scratchpad/HANDOFF.md`; unit statuses in
`slice-7.md`. After Gate 1: post-gate units S7·2b / S7·6 / S7·7b / S7·8, then phase
two (orchestrator, S7·9+).

**Parked odds:** **D45** slug fix; liveness-table dedup (tech-debt); advisory-gate pin
(brace-expansion, parked); **usage-endpoint 401/429** observed 2026-07-25 (meters may
read stale — likely a usage-token refresh, ops item). (**T6** pin + **S7·0** spike —
DONE 2026-07-25.)

--- (historical, slice 6 close, 2026-07-24) ---

**SLICE 6 IS CLOSED (2026-07-24).** All machine gates green + committed (HEAD
`7df415d`), deployed; **T7 accepted by Wes** — core dispatch loop validated end-to-end
at the planning stage (see `slice-6-test-plan.md` T7 outcome). Gate reframes to
"validated in real use + continuous daily use going forward" (D20/D22/D25).

**The big finding T7 produced (drives slice 7):** the task model encodes **chat-and-steer**
where the workflow is **spec-and-verify** — see **open-questions D43** (evidence note) +
**D44** (Wes's plan-handoff mechanism). Slice 7's real opener is **task-as-work-order,
plan-as-artifact handoff, and the orchestrator role** — *not* "add a description field."

**Loose ends (not slice-6 blockers):**
1. **T6 — DONE + PIN APPLIED (2026-07-25).** Verify spike ran
   (`spike-t6-cli-2.1.220-FINDINGS.md`), orchestrator-verified. Two outcomes: (a) pin bump
   2.1.217→2.1.220 is SAFE (warn-only) — **APPLIED**: `/etc/vimes/env`
   `VIMES_EXPECTED_CLI_VERSION=2.1.220` (bumped alongside the S7·2a deploy), daemon restarted,
   boot line confirmed drift-warning-free (`pty=2.1.220 sdk=2.1.207`, `auth=configured`);
   (b) the slug check surfaced a real rule-0.1 finding → **D45** below, queued as its own unit.
1b. **Slug fix (D45) — QUEUED, dispatch-ready.** `encodeCwdForProjects` is wrong: the CLI folds
   `_`→`-` (verified: cwd `space_industry` → dir `space-industry`), so transcript tailing +
   discovery silently miss any underscore project. Fix = **approach B (discover, don't compute)**,
   two caller shapes: session-id-known (`sessionHost.ts:425,1064`) → glob `*/<sessionId>.jsonl`;
   cwd-only (`tailer.ts:111`, `discovery.ts:42`) → match each dir's internal `cwd` field. Delete
   the false comment; land a test with an underscore cwd. Full rationale + why-not-a-regex-swap:
   **decisions.md D45**. Sequenced by Wes against the task-model pass.
2. **Advisory-gate pin (PARKED, no urgency)** — `brace-expansion@5.0.8` override; single-root
   cascade, **0/12 runtime-reachable** (all build/dev/test). Needs a lock regen (+56 in-range,
   incl. SDK 0.3.207→0.3.219) + deliberate restart. Full analysis:
   `scratchpad/spike-advisory-gate-FINDINGS.md`. ⟨Wes⟩ approves the regen.
3. **Board Dispatch caption** still says "told NOTHING" — false since the seam-fill deploy.
   One-line UI fix.

**Human-operable board controls (principle 8) — the runnable ones SHIPPED 2026-07-24:**
**S9** ✅ (dispatch→session: live list + click-to-open, `ddf2e8a`), **S8** ✅ (move-modal
filters to daemon-served valid moves, `fb5b3d3`), **S11** ✅ (`cancelled` recoverable stage,
`c618803`) — all deployed. **STILL OPEN: S10** (Resume bypasses stage independence — HELD for
the task-model pass, it's a model call), **S2** (permission footing — see its ✅ SPIKED note;
the `gated`/`plan` half is buildable, `autonomous` reframed → the **classifier-guardrail
spike** is running: automated gating in the `canUseTool` seat, the scalable middle for the
fleet). Plus D42 (project-centric reframe), the project history read-model, AgenC. These are
the "dive to any level" controls the orchestrator layer sits on.

**Fable can take solo:** the advisory pin (on Wes's go); the board Dispatch-caption cleanup.

**Other ⟨Wes⟩ items:** flip `VIMES_WORKTREE_ISOLATION` (still `off`) · `removeWorktree`
wired to NOTHING pending policy · Gate-D ⟨tune⟩s blocking step 5c (quarantine
enforcement) · Q2 retention half · Q4 relocation · the board-as-sidebar end-state
trigger.

**Deploy state:** current — daemon (PID as of 2026-07-24 restart) serves
`latestContextTokens` + `composeStageInstruction`; UI current via the gate. Clean tree
at `7df415d`.


## S — Cost graph hover tooltip — ✅ ALREADY EXISTS (native title); optional polish only

*(Finding, 2026-07-24.)* The bars already carry `:title="${bar.day}: ${bar.usd}"`
(`CostLedgerView.vue:248`), and `bar.usd` is a real `formatMoney`-formatted dollar
string (`costDisplay.ts:315`). Hovering shows the amount TODAY — the native
`title` tooltip just lags ~1s, which reads as "missing." **No build needed.**
Optional deferred polish (Wes, 2026-07-24): swap the sluggish native title for an
**instant** custom popover (desktop-only), paired with a **slight hover effect
that outlines the bar** being pointed at (so the popover and the bar it describes
are visually linked). Not scheduled — a nice-to-have UX upgrade, not a fix.
Original request below, kept for context.

### (original) Cost graph: hover a bar → dollar-amount tooltip (desktop-only)

*(Wes, 2026-07-24: "mousing over the bars on the cost graph should show the dollar
amount… a tiny popover with the formatted number in dollars.cents. Desktop only,
makes no sense on mobile.")*

**Dispatch-ready, UI-only, no restart.** The data is already there — the bars are
drawn from priced cost rows; `costDisplay.ts` already has the dollar formatter to
reuse (do NOT invent one — principle 9). Scope: on **hover** over a cost-graph
bar, show a small popover/title with the bar's value as `$D.CC`. **Desktop-only:**
hover has no mobile equivalent, so gate it on a pointer-fine / non-touch signal (or
simply rely on `:hover`, which touch never fires) — never a tap-toggle that steals
a mobile tap. No layout shift, no new dep, no `v-html`. Find the cost-graph
component (likely under the cost-ledger view), confirm the per-bar value is in
scope, and bind the formatted dollar string. Verify: reuses the existing formatter;
`git diff` is the graph component only; touch behaviour unchanged.

## S2 — SPIKE: per-session / per-task permission footing (what's even available?)

*(Wes, 2026-07-24: "can we set permission footing on sessions/tasks? Some of these
tasks will spawn sessions that need to write files and enter commands so the user
should be able to choose between permission modes but I'm uncertain what is
available. Queue it after the cost mouseover.")*

**This is a SPIKE, not a build — Wes is uncertain what exists. Investigate before
scoping any UI.** Run it AFTER S (cost mouseover). Question: can VIMES set a Claude
Code **permission mode per spawned session / per task**, and what are the options?

- **Classify by runtime observation, not docs (rule 0.7).** Determine what the
  channel VIMES actually spawns through exposes — the Agent **SDK** (D4 default
  channel) and the **PTY** escape hatch may differ. Candidates to confirm exist
  and are settable at spawn: the permission modes (`default` / `acceptEdits` /
  `plan` / `bypassPermissions`), a `canUseTool` / permission callback, per-tool
  allow/deny lists, and the blunt `--dangerously-skip-permissions`. Report which
  are real on OUR spawn path, with citations, and which are unreachable.
- **Where VIMES would wire it:** the session/task spawn path
  (`taskDispatcher.ts` for task-spawned workers, the SDK session launcher, the
  PTY launcher). This is directly relevant to the **slice-6/7 dispatcher** — a
  task that spawns a worker to write files IS the dispatcher's job, so the
  permission footing is a dispatcher concern, not just a UI toggle.
- **Deliverable:** what's available on each channel (cited), where the setting
  would attach, the honest security caveats (bypass = real filesystem/command
  authority granted to an agent), and a recommendation for the per-session /
  per-task control surface. No build, no UI — a findings file + a lean.

⚠ Security-shaped: any "let the agent run commands unprompted" mode is real
authority handed to a model. That framing belongs in the spike's output, and the
eventual control is a ⟨Wes⟩ decision, not a default.

### ✅ SPIKED 2026-07-24 — `scratchpad/spike-permission-footing-FINDINGS.md`

VIMES hardcodes `permissionMode:'default'` (`sessionHost.ts:1228`) because **the
VIMES gate (`canUseTool`→`gateFired`→attention) fires ONLY under `'default'`.** The
crux finding: **autonomy and observability are mutually exclusive** on this mechanism
— any auto-approving mode stops `canUseTool` → no gate → no attention → inspect-and-
steer is lost. `plan` is the safe read-only outlier; PTY has no gate at all. No
`TaskRecord` permission field reserved; adding one is a daemon change (restart),
additive. **Lean:** a coarse `permissionFooting` enum mapped in ONE place (never a
raw mode pass-through) — `gated`→default (safe default), `plan`→plan, `autonomous`→
acceptEdits/bypass (gate-blinding, opt-in, loud). `gated`/`plan` ship free; **⟨Wes⟩:
offer `autonomous` at all? PTY footing (lean: no)? how is an un-gated session made
visible?**

### ✅ SPIKED #2 2026-07-24 — the CLASSIFIER GUARDRAIL (`scratchpad/spike-classifier-guardrail-FINDINGS.md`)

Reframes S2: at fleet scale (dozens of dispatched sessions, nobody watching each)
human-per-tool gating doesn't scale and the SDK's blind auto modes give up
observability. The scalable middle: a **classifier in the `canUseTool` seat** under
`permissionMode:'default'`. **Mechanism confirmed** (sdk.d.ts): `CanUseTool` returns
`Promise<PermissionResult|null>` — a resolved promise decides programmatically
(`{behavior:'allow'|'deny'}`), a pending one escalates (today's `handleGate`). So
allow/deny/escalate all work under `'default'`. **Observation SURVIVES** an auto-allow
(the dissolved tension): tool uses still flow via the SDK message stream + the
PreToolUse hook relay, both independent of `canUseTool` — the whole win over
`acceptEdits`. Seam = first statement inside `handleGate` (`sessionHost.ts:481`).
**Measured (real corpus):** 28.5k tool_uses/702 sessions; mix Bash 40% / Edit-Write
31% / Read 24%. A deterministic RULES floor clears ~85% at $0/0ms (reads; writes via
`resolveWithinRoots`; Bash allow/deny lists); a cheap LLM (Haiku ~$0.0004/call) sees
the ambiguous ~15% (~$1.70 for the whole historical corpus). **FAIL-CLOSED invariant:**
classifier error → escalate, never auto-allow. Rejected the SDK's built-in
`permissionMode:'auto'` (opaque, gives up our rules floor + escalate seam +
observability). **LEAN: smallest first step = a deterministic RULES-ONLY floor,
escalate-everything-else, NO LLM** — reuses `resolveWithinRoots`, harness-testable,
strictly better than today (auto-clears the obvious-safe majority, escalates the rest),
zero billable dependency; add the LLM for the escalate-residual later behind Gate-D.
⚠ Behavior-shaping SECURITY change → needs evidence + a policy calibration + ⟨Wes⟩
sign-off (rule 0). Foundational to the fleet/orchestrator north star, not just a toggle.

### ✅ CLARIFIED 2026-07-24 — Claude Code's OWN `auto` mode (claude-code-guide, per docs)

Wes meant Claude Code's built-in `auto` permission mode (Anthropic's **server-side
classifier**), not a custom one. Decisive facts (verify the load-bearing ones
empirically — rule 0.7): `auto`'s classifier **only approves/denies — NO ask/escalate
path**, and `canUseTool` **never fires** for its decisions (classifier runs before the
callback step). Under `default` you get `canUseTool` (escalation) but no classifier —
so **classifier XOR escalation, mutually exclusive**. In headless, a retried `auto`
denial **aborts the session** (no human fallback). BUT **PreToolUse hooks fire under
every mode (incl. auto) and can `deny` (hard veto, even under bypass) or `allow`** — so
`auto` + VIMES's PreToolUse hook = Anthropic classifier + VIMES hard-deny floor + full
observation, minus approve-and-unblock. **Two-footing model:** `gated` = `default`+
`canUseTool` (supervised, human-in-loop); `auto-guarded` = `auto`+PreToolUse-hard-deny
(the FLEET — escalation doesn't scale anyway, so "classifier denies dangerous, human
reviews failed tasks" is the scalable model, and it's LESS work — no custom LLM); `plan`
= read-only. ⚠ **UNVERIFIED lever worth an empirical spike:** a PreToolUse `defer` in a
HEADLESS `auto` session is undocumented — if it pauses+resumes cleanly it recovers a
VIMES-controlled escalate-to-phone path ON TOP of the classifier (the whole enchilada).
Lean: `auto`+hard-deny-hook for the fleet, `default`+canUseTool for `gated`, spike `defer`.

### ⟨Wes⟩ SETTLED DIRECTION 2026-07-24 — the two-tier footing model

**Human-created sessions:** a permission dropdown **Default / Allow Edits / Auto**
(= `default`+canUseTool / `acceptEdits` / `auto`-classifier), **starting in Default**.
**Dispatched sessions** (when that system is built): **start in `Auto`** so the
classifier keeps them from going off-rails — **PLUS a VIMES PreToolUse hard-deny hook**
(`resolveWithinRoots` on the task's roots), because Anthropic's classifier catches
GENERAL danger but NOT VIMES's boundaries (a worker wandering outside its task's
root/worktree). Auto alone has a hole exactly where a fleet drifts.

- **Plan for the planning stage — PENDING A SPIKE (⟨Wes⟩): `plan` permission mode has
  ADDITIONAL behaviours we want to characterise first.** Easy A/B test: dispatch two
  identical sessions, one in `plan` mode, one not, and diff the behaviour. Queue it.
- **The abort tradeoff → handled by INSTRUCTION, not mechanism (⟨Wes⟩).** Auto has no
  ask-path, so a denied+retried tool aborts a headless session. Rather than fight that,
  the task-type's **initial instruction** (composeStageInstruction, D43/D44) tells the
  worker: *"if you hit a classifier failure/denial, abort and RAISE A FLAG (a tool
  call)."* The **orchestration layer** picks the flagged task up, sees what happened,
  and routes it for human review OR re-dispatches with more specific guidance. So a
  blocked task becomes an orchestrator-handled event, not a silent death. (This is a
  concrete first job for the orchestrator role + the work-order instruction model.)
- Still worth the `defer`-in-headless spike as the *alternative* escalation path, but
  the instruction+flag pattern is the primary plan and needs no undocumented behaviour.

**Folds into the task-model/dispatch design pass** (D43/D44 + S10) — footing is a
dispatcher concern and the abort-flag pattern is an orchestrator + instruction concern.

### ✅ SPIKED #3 2026-07-26 — EMPIRICALLY CONFIRMED on our SDK path (`scratchpad/spike-automode-FINDINGS.md`)

The settled two-footing direction was grounded on our REAL `@anthropic-ai/claude-agent-sdk`
`query()` path (0.3.207, isolated sessions, rule 0.7). **Trigger:** the first Gate-1
implementing run fired **26 permission gates** (~1/tool) — human-per-tool doesn't fit a
dispatched session. **All load-bearing facts GREEN; no KILL.** Orchestrator RE-VERIFIED
the three fail-critical ones against raw transcripts (the SDK type, the Q2 deny side-effect,
the Q3 zero-spawn), not just the agent's summary:
- **`permissionMode:'auto'` is a first-class value** (`sdk.d.ts:2043`: `…|'plan'|'dontAsk'|
  'auto'`), reachable + functional on our path.
- **auto → 0 `canUseTool` gates, tools still execute** (Read/Bash/Edit/Write all ran, 0
  gates) — the direct fix for the gate spam.
- **PreToolUse hook FIRES under auto and its stdout-deny HARD-BLOCKS the tool** — verified
  by SIDE EFFECT (out-of-root `Write` + `FORBIDDEN_MARKER` `Bash` both landed in
  `permission_denials`, the file never created; the allowed in-root write succeeded). Works
  under `default` too. **⇒ This ALSO resolves the D50-deferred backstop question: yes, the
  SDK honors a deny returned via the hook relay's stdout** (see decisions.md D50).
- **D50 `tools` clamp survives auto** — 0 spawn tool_use under a force-fan-out prompt; auto
  does not re-widen the toolset.
- **Observability survives** — full tool-use stream + a hook-fire per tool, 0 approval gates
  (the whole win over `acceptEdits`).
- **Q5 SURPRISE (reassuring), overturns a feared failure mode:** `AskUserQuestion` STILL
  routes through `canUseTool` under auto (ordinary tools do NOT) — so the D50 `canUseTool`
  AskUserQuestion auto-deny does **not** evaporate under auto; the hook is a redundant second
  catch.
- **Q6 (`defer`) RED — non-KILL:** a headless `auto` PreToolUse `defer` silently ends the
  turn (tool doesn't run, NO `permission_denials`, no resume handle) — NOT a usable
  escalate-and-resume path. The "VIMES escalate-to-phone on top of the classifier" idea
  needs a different mechanism.
- **Build notes:** the **PreToolUse hook is the more universal seam** than `canUseTool`
  under auto (it fires for every tool; `canUseTool` only for interactive ones) → use the hook
  for the boundary floor. Dispatched sessions must set `settingSources` deliberately (the
  default loads ambient `CLAUDE.md` and the model wanders). **Zero** classifier-unavailable
  failures this run (no backoff needed). Spend ≈ $1.63 (subscription usage).

**READY TO BUILD (pending ⟨Wes⟩ go — a behavior-shaping security change, rule 0):** dispatched
footing = `permissionMode:'auto'` + a VIMES **PreToolUse hard-deny hook** (`resolveWithinRoots`
on the task's roots) + KEEP the S7·5c D50 `tools`-clamp + KEEP the D50 `canUseTool`
AskUserQuestion auto-deny. Auto's no-ask abort is handled by the abort-and-flag instruction
(worker raises a flag → orchestrator routes it). Human-created sessions keep the
Default/AllowEdits/Auto dropdown, starting Default.

## S3 — Markdown TABLES in the message stream (a v1 scope gap, not a regression)

*(Wes, 2026-07-24, viewing session 769d021c: "most of it lands but tables do not
render properly.")*

**Not a bug — a documented v1 boundary.** `lib/markdown.ts`'s header explicitly
excludes tables (it renders headings, fenced code, one-level lists, rules, inline
marks; "everything else — tables, blockquotes, …" is out by design, to keep the
structured no-`v-html` parser small). A pipe table currently falls through to
paragraphs. Claude emits tables constantly, so this has real value.

**Bounded unit, UI-only, testable pure logic.** Add a `{ kind: 'table' }`
`MarkdownBlock`: parse a GFM pipe table (header row, the `---|:--:|--:` delimiter
row that also carries per-column ALIGNMENT, body rows; a table needs the delimiter
row or it stays paragraphs), cells hold the existing `MarkdownInline[]` so inline
`code`/`**strong**`/links/paths keep working inside cells. Render a real
`<table>`/`<thead>`/`<tbody>` in `MarkdownMessage.vue` — **structured nodes only,
never `v-html`** (the whole reason this lib exists — design-directions "Markdown
rendering… never v-html"). Ragged rows: pad/truncate to the header column count,
don't throw (I8 totality). Add parser tests alongside the existing markdown tests.
No new deps.

## S4 — Stream auto-scroll: follow new text, but don't yank a reader

*(Wes, 2026-07-24, real use: "the window doesn't follow the text. As the agent
replies it doesn't always scroll to the bottom to surface new text and I have to
manually scroll.")*

**Confirmed gap.** StreamView's only `window.scrollTo` (~L80) is the mobile-keyboard
offset, not a content-follow. The page scrolls the DOCUMENT (window /
`documentElement`), not an inner container — the fix mirrors that.

**The honest version — stick-to-bottom, conditional.** On new stream content,
scroll to bottom ONLY if the user is already at/near the bottom; if they've
scrolled UP to read history, leave them exactly where they are (force-scrolling a
reader back down is the anti-pattern to avoid). Pure decision helper
`lib/stickToBottom.ts` — `shouldStick(scrollTop, scrollHeight, clientHeight,
thresholdPx)` → boolean, tested; StreamView watches the events list and, after
`nextTick`, `window.scrollTo(bottom)` only when `shouldStick` was true BEFORE the
new content landed (capture the intent pre-render, act post-render). Optional
(nice, not required): a "jump to latest" affordance when stuck-scrolled-up.
UI-only, no restart.

## S5 — Enter-to-send hotkey on the composer (desktop), Enter stays newline on mobile

*(Wes, 2026-07-24: "no combination of enter or ctrl-enter sends the text on
desktop, only clicking send. I normally expect enter to send, ctrl-enter to
newline, or something like that.")*

**Confirmed gap: no send hotkey exists** — the composer submits only via the Send
button. Add a `@keydown` on the composer textarea.

- **Desktop:** **Enter → send** (default lean, the chat convention), **Shift+Enter
  → newline**. ⟨Wes decides⟩ the alternative — **Ctrl/Cmd+Enter → send, Enter →
  newline** — which is safer for the longer agent-directing messages he writes
  (no accidental sends). Encode whichever he confirms; default to Enter=send if he
  doesn't weigh in.
- **Mobile / touch: Enter STAYS newline** — the on-screen keyboard has no other
  newline key, and send is the button. Gate the send-on-Enter on a
  desktop/pointer-fine signal (matchMedia `(pointer: fine)` or the existing
  layout signal), never on touch.
- **IME:** never send while composing (`event.isComposing` / keyCode 229) — an
  Enter that commits a CJK candidate must not fire a send.

Pure decision helper `lib/composerKey.ts` — `(eventProps, isDesktop) →
'send' | 'newline'`, tested; StreamView wires `@keydown` → on `'send'`,
`preventDefault()` + the existing `submitMessage()`. UI-only, no restart.

## S6 — Session vitals strip stays pinned while scrolling (always-visible context)

*(→ ABSORBED into **slice 6b** (UI foundation, D47): folds in as the frame's fixed
head. Also see the top-bar usage gauge, which makes ACCOUNT usage first-class; this
strip becomes the session-context tier. Build there, not standalone.)*

*(Wes, 2026-07-24: "for sessions can we have the statusbar remain floating at the
top even as we scroll down? Always visible as context if they're in a session.")*

**Small layout change, UI-only.** StreamView's `<header>` is already `sticky
top-0 z-10`; the vitals strip (cache · context · usage, added today) sits just
below it but scrolls away. Make the vitals strip part of the pinned region —
either fold it into the sticky header block or give it its own `sticky` offset
stacked beneath the header (`top-[<header-height>]`), so it stays visible as the
stream scrolls. Watch: the header/strip stack must not eat too much vertical
space on a phone (keep the strip terse); ensure `z-index`/background so stream
content scrolls *under* it cleanly in light+dark. No new deps. Reuses the strip
built today — no logic change, just where it's pinned.

## S7 — Each panel is its own scroll FRAME (independent scroll regions)

*(→ PROMOTED to **slice 6b** (UI foundation, D47) as the structural root of the whole
slice. Spike (2026-07-25, `scratchpad/spike-panel-frames-FINDINGS.md`) found the fix
is small — height not overflow. S4/S6 fold in here as noted below.)*

*(Wes, 2026-07-24: "each panel should be a frame. If I scroll down on a file I'm
editing it shouldn't scroll every other panel. Sometimes I want a file up for
editing while also having the file directory up so I can click into other files —
right now if I scroll down while editing it scrolls off the bottom of the file
directory.")*

**This is the STRUCTURAL ROOT that S4 and S6 patch around.** S4's own note says it:
the app scrolls the **DOCUMENT** (`window` / `documentElement`), not inner
containers — so every panel shares one scroll, and scrolling a file editor scrolls
the file directory (and everything else) with it. The fix is a layout change, not a
per-component one: **each panel becomes a fixed-height scroll frame** — a
viewport-height flex/grid shell whose cells each `overflow-y-auto` independently, so
editor-scroll and directory-scroll never touch each other.

**Aligns with the project-centric PANEL model** (design-directions, "everything a
panel"): panels-as-frames is the layout foundation that model needs anyway — do this
and the panel restructure inherits independent scrolling for free.

⚠ **Bigger than the small S-items — it touches the app shell's scroll model, so it
wants its own design pass**, not a drive-by. Open questions for that pass: which
views become frames; how the viewport-height layout composes on **mobile**, where
vertical space is scarce and there is only one panel; how it interacts with
StreamView's mobile-keyboard offset (the one `window.scrollTo`, S4). **When this
lands, revisit S4 and S6 together** — stick-to-bottom becomes a *container* scroll
and the sticky vitals strip becomes "top of the frame," so both may simplify or
partly dissolve rather than stay as written.

## S8 — The move modal shows ALL stages but the machine refuses most (legibility)

*(Wes, 2026-07-24, running T7: "the move-to modal is really confusing because it's
not clear which states can be moved to from which, or why… I see all of the options
but cannot select some of them. It says it's not valid. So the modal is showing ALL
states but only a few are valid.")*

**Deliberate design, over-applied.** `taskBoard.ts:395` refuses to filter the move
options on purpose — filtering would make the UI "a SECOND AUTHORITY on transition
legality, which rule 0.3 and principle 10 forbid — UIs propose, the machine
decides." So the modal offers every stage, you propose one, the daemon returns 200
or **409 "not valid."** Correct, but illegible: the operator sees options that will
be rejected and learns the pipeline only by hitting the wall.

**⟨Wes ruling, 2026-07-24⟩: show ONLY valid moves — filter, don't grey.** *"Showing
options that will never be valid from the current state is deceptive and unhelpful…
the UI should only show valid state moves."* This reverses `taskBoard.ts:395`'s
stance: that comment conflated "the UI must not be the AUTHORITY on legality" with
"the UI must not REFLECT legality" — only the first is what rule 0.3 / principle 10
require. There is no UX value in offering a move the daemon will 409.

**The one implementation constraint that keeps principle 10 (and 9) intact: the
legal-edge set must be DAEMON-SOURCED, never a UI copy of `TASK_STAGE_EDGES`.** Serve
the edge table from the daemon, or add a per-task `legalMoves` to the tasks read
model, so the UI **reflects** the authoritative table rather than **duplicating** it
(a hand-maintained UI copy drifts from the machine — the real hazard, and how you'd
end up showing a "valid" option that still gets rejected). The daemon **still
enforces on submit** (defense in depth). Filtering is a convenience layer over the
authority, not a second authority. Also separate in the sheet: **Move** (transition)
vs **Dispatch** (spawn a worker) — two different actions that currently blur.

⚠ **Part of a larger finding (see open-questions D43).** This is one symptom of the
board being *correct but illegible* — the task-model design pass (task-as-work-order,
flow-as-loop) that T7 surfaced. If that redesign lands, revisit this item inside it
rather than patching the modal alone.

## S9 — Dispatch→session handoff is unwired (no live list update, no click-to-open)

*(Wes, 2026-07-24, running T7: clicked Dispatch, a session was created, but (1) "I
had to refresh the UI to see the newly created session — it didn't show in the
list" and (2) "I could not click the notification in the task that a session was
created in order to open a panel with the session in it.")*

**Part 1 — the new session isn't live in the list. ROOT CAUSE CONFIRMED.** The
client only receives live events for streams it is **subscribed** to; a brand-new
session's stream isn't subscribed yet, so its `session_created` **is not delivered
live** and the list stays stale until a manual refresh re-fetches. The store already
knows this and already solves it for one path: the WS `'discovered'` case
(`vimesStore.ts:726-733`) calls `scheduleSessionsRefresh()` precisely because *"the
resulting session_created events on unsubscribed streams would not otherwise trigger
a refresh."* The **task-dispatch path never got the same treatment** — `dispatchTask`
(`vimesStore.ts:489`) is a plain HTTP POST that neither subscribes to the returned
`appSessionId`'s stream nor schedules a refresh. **Fix:** on a `spawned` dispatch
response (the body carries the `appSessionId` — the board already shows it), subscribe
to that session's stream AND `scheduleSessionsRefresh()`, mirroring the `'discovered'`
handler. UI-only, no restart.

**Part 2 — the dispatch result should open the session.** `TaskBoardView`'s
`dispatchNotice` renders the new `appSessionId` as inert text. Make it a navigable
affordance: click → route to that session's stream view (the panel). Under the
eventual panel model (design-directions) this is "open the session panel"; today it
is a route to the stream view. UI-only, no restart.

⚠ Both are the same theme as S8 / open-questions D43: the board dispatches correctly
but the **dispatch→session handoff isn't finished for real use.** If the task-model
design pass happens, fold these into it rather than patching in isolation.

## S10 — The session Resume button bypasses stage independence (session vs stage models collide)

*(Wes, 2026-07-24, running T7: after accepting a planning worker's plan — "you say I
can't accidentally continue in this session but I have a Resume button right here on
the session window.")*

**Two affordances, two models, contradicting.** The task-stage machine says the first
implementer is a FRESH session (`resolveStageRunner` rule 3 — never resume the planner,
"a planning session is NOT the author"; independence is a correctness rule). But the
session window's **Resume** is a *session-level* action that knows nothing about task
stages: it reopens THAT `appSessionId`, so resuming a planning stage-session hands back
the planner — wrong role, wrong artifact — the exact misbehavior the fresh-spawn rule
exists to prevent. The board's implementing-Dispatch does the right thing; raw Resume
undoes it.

**This is the session-model ↔ task-stage-model reconciliation, and it resolves UP into
the orchestrator north star (design-directions).** In the target shape the human isn't
driving stage continuation with a raw Resume at all — the **orchestrator** manages
session/stage lifecycle via the API, and Resume-on-a-stage-session is an *override*
surface, not the daily path. So the fix isn't just "hide Resume on stage sessions":
it's deciding what Resume MEANS for a task-attached session (advance-the-stage via the
dispatcher vs. reopen-this-exact-session as an override), which is a task-model design
call. Fold into the D43/D44 task-model pass, not a standalone patch.

## S11 — No way to delete a task (and the broader "human-operable at every level" gap)

*(Wes, 2026-07-24, closing T7: "Delete that test task — I have no way to delete
tasks.")*

**Confirmed: there is no delete.** No `task_deleted`/`cancelled`/`archived` event, no
such stage, no DELETE route (grep clean 2026-07-24). And it can't be a naive delete —
task state is **event-sourced, append-only (I12)**, and the 'tasks' stream's records
carry sequence identity that replay/I6 depend on, so **removing records from the log is
off the table** (it breaks from-empty === snapshot+tail). The correct shape is a
**soft-delete**: a new `task_cancelled` (or `archived`) event the tasks projection folds
to **hide** the task from the board while the log stays intact. Small unit — reserve the
event (rule 0.5), fold it, an API route, a delete/cancel control in the card sheet.
⚠ Destructive-verb naming + whether a cancelled task is recoverable is a ⟨Wes⟩ call.

**The bigger principle behind it (Wes, 2026-07-24):** *"we're building bottom-up because
the human can dive to any level they're comfortable with, so every level must have
human-operable controls — inspect a task directly, make an edit, attach a screenshot."*
Principle 8. The orchestrator north star (design-directions) sits **on top of** these
controls, it does not excuse their absence. So this is one instance of a class:
**direct human-operable task controls** — delete/cancel, edit fields, attach an image
(which also feeds D43's spec-artifact: a task brief may include screenshots). These stay
first-class; the orchestrator layer is additive. Design them as part of the D43/D44
task-model pass.

## Q2 — Session list scale: retention, and demoting it from a first-class surface

*(Wes, 2026-07-23, after Q1 shipped: "I agree generally. We shouldn't persist
every single old session. I have thoughts about that too, but this session list
isn't a first class interface going forward. Let's make a note to revisit it
after the running agent lands.")*

**Trigger: after the routing-extraction unit lands.** ⟨Wes⟩ has thoughts to
contribute before this is scoped — do not design it without him.

**Structural angle (mined from the AgenC-core decomp, 2026-07-24):** the scroll-cost
half has a *structural* fix independent of the retention/demotion calls —
**bounded, cursored control-plane reads.** AgenC makes every list/replay/search
read paginated-by-design (schema-v13 bounded thread-listing) precisely to avoid the
daemon-stalls-under-its-own-history failure class. VIMES serves a phone over a
tunnel, so the session list, event replay, and search endpoints should be
pagination-disciplined regardless of how retention lands. Cheap, and it de-risks
the scroll cost before the harder retention decision is even made.

### What Q1 did and deliberately did NOT fix

Q1 made **New session** reachable without scrolling. It did nothing about the
list's own scroll cost, which is the real complaint: a few dozen sessions today,
unbounded growth ahead. Sorting/filtering/search were explicitly out of Q1's
scope and stay out until this entry is scoped.

### The two halves, and they are different decisions

1. **Retention** — *"we shouldn't persist every single old session."* This is not
   a UI question. Sessions are event-sourced; a dormant session from two weeks
   ago is still a stream in an append-only log (I12). So "don't persist" means
   deciding what **archived** means: hidden from a list, or actually pruned from
   the store? Pruning touches I6 (replay equivalence) and the D12 event-log
   growth item already parked in `design-directions.md` — **those two should be
   decided together, not separately.**
2. **Demotion** — *"this session list isn't a first class interface going
   forward."* This is the concrete form of the 2026-07-20 note *"sessions should
   not be the landing page"*, whose stated trigger was *"revisit when slice 6/7
   UI is designed"*. **The board now exists (`115e728`), so that trigger has
   fired.** Under the panel model, this is a question about the panel stack's
   initial state, not a new view.

### Why they interact

If the board becomes home and sessions become a drill-down, the list's scroll
cost matters far less — it stops being the surface you live in. **Demotion may
substantially dissolve the problem retention was going to solve**, so decide the
demotion first and re-measure the pain before designing archiving.

⚠ Retention is the half with a **destructive** option in it. Anything that
removes events is rule-0.1 territory and earns a decision record before a work
order, not during one.


---


## Q4 — The cache badge is unreadable, and it mixes two time bases

*(Wes, 2026-07-23: "Some sessions have a badge '1h cache - 49%' or whatever.
This isn't clear what it means. Is it saying this session is still inside its 1h
cache window, that it only has a 1h cache? What is the percentage?")*

**The maths is correct; the presentation is not.** Both of Wes's guesses at the
meaning were wrong, and he designed the system — treat that as decisive.

What it actually shows (`lib/cacheBadge.ts`, `cacheClassification.ts`):
- **`1h cache`** — the TTL tier of the **LATEST observed** cache *write*, from
  `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`. Not
  a window state, not a capability.
- **`49%`** — the **CUMULATIVE** hit rate,
  `cacheRead / (cacheRead + cacheCreate + input)`.

⚠ **The real defect: one half is latest-observed and the other is whole-session
cumulative, presented as a single unit.** That is not terseness, it is two
measurements on two time bases wearing one label.

It also omits the operator meaning: cache reads bill at **×0.10** of base input,
1h writes at **×2.00**, 5m at **×1.25** (slice-5b binding rule 6). A high hit
rate is money saved; the tier says what the writes cost.

### Constraints on any fix
- **D24 still binds:** `serviceTier` is passed through raw and must never be
  rendered as a fabricated billing bucket.
- The badge must stay honest about `none` / `mixed` tiers rather than hiding them.
- Whatever is shown, **the two time bases must be distinguishable** — either
  label them, or make both cumulative, or drop one.

### Lift
Small — a labelling change in `lib/cacheBadge.ts` plus the view, with tests. No
new data is needed; everything required is already in the projection.


### Q4, revised 2026-07-23 — replace hit rate with CACHE WARMTH, and relocate the rate

*(Wes: "Cache hit success isn't a useful user metric, what would I do with that
information? Maybe we change it to tell me whether the cache has expired?")*

**Agreed, and the reason is that hit rate is a number the operator cannot move.**
Prompt-cache behaviour is set by the CLI and the prompt structure; a metric with
no lever is trivia, not a control. It is a tuning diagnostic wearing an operator
badge.

**Warmth is the right metric because it drives an actual decision: resume this
session, or spawn a fresh one?** That is not a new idea here — it is D6's cache
economics and step 7's hot-author resume rule, which `resolveStageRunner` already
applies automatically for stage runs. Surfacing warmth gives the human the same
lever the dispatcher already pulls for itself.

⚠ **The honesty constraint, and it is the whole design.** VIMES **cannot observe
cache state** — Anthropic never reports "warm". Any warmth figure is INFERRED
from last-activity age + observed TTL tier, under assumptions that can be wrong:
reads refresh the TTL, the cache is prefix-keyed so a changed prefix misses even
inside the window, and multiple breakpoints exist.

So it must **show its basis, not just a verdict** — observed age and observed
tier, with remaining-warm time as visible arithmetic on them. Exactly the shape
the usage meters already use (observation age and freshness beside the number).
A flat "cache expires in 34m" is a fabricated certainty; "last activity 26m ago ·
1h tier" is observed, and warm/cold styling follows from it. Pillar 4.

**Do not delete the hit rate — RELOCATE it to the cost ledger.** It is useless on
a session row and genuinely useful where the question "why did this cost what it
did" is actually asked: reads bill at ×0.10 of base input, 1h writes at ×2.00,
5m at ×1.25. Move a metric to where its question lives rather than deleting a
correct measurement.

### ⚠ A third hidden time base, found while answering the PTY question

Wes: *"pty sessions do NOT have the cache badge."* Investigated — **not a PTY
gap.** `transcript/mapper.ts:173` emits `usage_block` for any assistant record
carrying `usage`, on either channel. All three PTY sessions in the live log are
`custody: external`, and D10 mirrors an external transcript from **EOF** (history
is signalled by `resync_marker`, never replayed), so none has produced an
assistant turn since discovery: 5 user-role messages and 0 usage blocks between
them. A VIMES-spawned PTY session, or a mirrored one doing real work, gets a badge.

**But it exposes a real defect:** for a mirrored session the "cumulative" rate is
cumulative **since VIMES started watching**, not for the session's life. That is a
third time base hiding in one badge, and any redesign must either scope the
figure honestly ("since adoption") or not present it as whole-session at all.

### ✅ SHIPPED (badge) / ⚠ HALTED (relocation) — 2026-07-23

**The badge is fixed and shipped.** It now shows observed **warmth** — the TTL
tier + how long since the last observed cache write, styled warm (green) / cold
(amber), `unknown` for a pre-field daemon (never a fabricated age), `none` for no
cache. No countdown (pillar 4 — activity re-writes and extends the cache, so an
"expires in" would be a fabricated certainty). Core gained an observed
`latestBlockAt` (the event `ts`, deterministic under replay, I6); the UI ages it
against the meters' own ticking clock (rule 0.3 — clock injected, `cacheWarmth`
is pure). One shared `formatDuration` (extracted to `lib/duration.ts`) now serves
both the meters and the badge (principle 9).

**⚠ The hit-rate RELOCATION halted on a structural finding (rule 0.1).** The cost
ledger cannot join the hit rate without a new session-key mapping:
`costLedgerApi.ts:76-79` — cost rows are keyed by the **Claude transcript session
id**, `cacheObservability` by the VIMES **appSessionId**, and the only bridge is a
title map with a documented **n:1 first-wins ambiguity** (one Claude session seen
under two app sessions). A direct `cacheObservability[sessionId]` lookup would
silently miss. Wiring it needs either a new read-model field or a
claudeSessionId→appSessionId join **plus a decision on the n:1 ambiguity** — a
work order's worth of design, and a ⟨Wes⟩ call, not a patch.

**The hit-rate helper is PRESERVED, not deleted** — moved to `lib/cacheHitRate.ts`
(`cacheHitRatePercent`) with its edge-case tests carried over byte-for-byte, ready
to consume once the join is designed. Its header carries the **"since adoption"**
honesty caveat: for a mirrored/adopted session the cumulative rate is cumulative
since VIMES started watching, so wherever it lands it must read `hit rate
(observed)`, never whole-session lifetime.

**⟨Wes⟩ decides next:** design the claudeSessionId↔appSessionId join (and how to
resolve the n:1 ambiguity — first-wins, or split), then a small unit consumes the
preserved helper into the ledger. Until then the hit rate lives in code only,
which matches your own read that it "isn't a useful user metric" on the row.

**PARKED (Wes, 2026-07-23): low priority — revisit as a CLEANUP after the slice
ends.** Trigger: slice-6 close. Not before. The badge fix already shipped; this
is only the relocation bonus, and the preserved helper waits with its tests.

