# Small queued items (dispatch-ready, waiting on a free slot / no conflict)

Work items, not design records — decisions live in `decisions.md`, design in
`design-directions.md`. Kept in `docs/` (not `scratchpad/`, which is gitignored
working space) so the queue is durable and reachable from the phone, the same
reason `slice-6-test-plan.md` lives here. Delete an entry when it ships.

---

## ▶ NEXT SESSION STARTS HERE (2026-07-23, end of day)

Slice 6's build steps **0–9 are done** (step 9 = the board). It is **one test away
from its exit gate.** The critical path, in order:

1. **⟨Wes⟩ stage-instruction prompt content — a real blocker.** A dispatched worker
   is currently **told NOTHING** (`slice-6-test-plan.md` → T4: "the dispatched
   session will be told NOTHING — deferred to you"). T7 needs a worker to actually
   do work, so this gates the exit gate. Unblock this first.
2. **T2 — the correction path end-to-end.** Unblocked since D35, still untested.
   Gates T7.
3. **T7 — the slice-6 human exit gate.** "One real feature you actually wanted,
   moved backlog → done through the board, where you corrected a worker mid-run and
   the correction landed without killing the run." T1 ✅, board ✅ — so after 1 & 2
   this is reachable, and it is what everything so far has been rehearsal for.

**Fable can take solo, no sign-off needed:** slice-6 **step 10** (watchdog scenario
profile + the six→seven assertion change — the last build step); the
`@hono/node-server` <2.0.5 bump (Windows-only vector, we run Linux); D40's panel
follow-ups (git→editor→back diff-refresh, the override-picker UI).

**Other ⟨Wes⟩ items:** flip `VIMES_WORKTREE_ISOLATION` (still `off`; it changes
where real work executes) · `removeWorktree` is built and wired to NOTHING pending
a disk-vs-preserved-context policy · the Gate-D ⟨tune⟩s keeping step 5c
(quarantine + retry) blocked · Q2's retention half · Q4's relocation (parked to
slice close) · the board-as-sidebar / orchestration-chat end-state trigger
(`design-directions.md`).

**Deploy state at close:** daemon current — no restart owed. Everything after Q4
was UI-only and already live via the gate's dist rebuild.


## Q2 — Session list scale: retention, and demoting it from a first-class surface

*(Wes, 2026-07-23, after Q1 shipped: "I agree generally. We shouldn't persist
every single old session. I have thoughts about that too, but this session list
isn't a first class interface going forward. Let's make a note to revisit it
after the running agent lands.")*

**Trigger: after the routing-extraction unit lands.** ⟨Wes⟩ has thoughts to
contribute before this is scoped — do not design it without him.

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

