# Small queued items (dispatch-ready, waiting on a free slot / no conflict)

Work items, not design records — decisions live in `decisions.md`, design in
`design-directions.md`. Kept in `docs/` (not `scratchpad/`, which is gitignored
working space) so the queue is durable and reachable from the phone, the same
reason `slice-6-test-plan.md` lives here. Delete an entry when it ships.

---

## ▶ NEXT SESSION STARTS HERE (2026-07-24)

Slice 6 is **at the exit gate.** T1 ✅, board ✅, **T2 works** (confirmed live —
see Finding 1), and the **stage-instruction seam is now filled** (verified, NOT yet
deployed). Critical path, in order:

1. **DEPLOY THE DAEMON** (a restart is owed — the ONE gating step). It activates
   `composeStageInstruction` (workers finally told the Wes-approved minimal
   instruction) AND `latestContextTokens` (session `ctx —` → real number). Uncommitted
   core/daemon changes not yet live. Pre-flight: sessions AND pty children AND
   in-flight stage runs + the `/proc` ancestry check; **don't restart from inside a
   vimes terminal** (recursion hazard). ⚠ Consider **committing first** — 5 verified
   units + docs are uncommitted (one commit per unit).
2. **T7 — the slice-6 human exit gate.** "One real feature, backlog → done through
   the board, corrected mid-run." Reachable right after the deploy — it's what
   everything has been rehearsal for.
3. **T6** — the 2.1.218 fixture check; now ALSO carries the **Finding 2** slug fix
   (`encodeCwdForProjects` no longer matches the CLI's `_`→`-` slugging; latent, PTY+
   underscore only).

**Findings this session:** F1 (correction tracking) was **RETRACTED** — it works via
the `run_completed` clear on SDK; F2 (CLI slug drift `_`→`-`) is **recorded**
(risk-register, folds into T6). Full context in `scratchpad/HANDOFF.md`.

**Slice-7 openers (parked, do NOT build in slice 6):** D42 (project-centric reframe +
its open security sub-decision), D43/D44 (task spec source + plan hand-off), the
project history read-model, the AgenC admission-kernel internal-allocation rules.

**Fable can take solo:** slice-6 **step 10** (watchdog scenario profile + six→seven
assertion); the `@hono/node-server` bump (Windows-only, we run Linux); D40 panel
follow-ups.

**Other ⟨Wes⟩ items:** flip `VIMES_WORKTREE_ISOLATION` (still `off`) · `removeWorktree`
wired to NOTHING pending policy · Gate-D ⟨tune⟩s blocking step 5c · Q2 retention half ·
Q4 relocation · the board-as-sidebar end-state trigger.

**Deploy state:** UI units LIVE via the gate; **daemon restart owed** for
`latestContextTokens` + `composeStageInstruction` (both uncommitted, not deployed).


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

