# Small queued items (dispatch-ready, waiting on a free slot / no conflict)

*Q1 SHIPPED 2026-07-23. Entry kept until the next compaction, then delete.*

Work items, not design records — decisions live in `decisions.md`, design in
`design-directions.md`. Kept in `docs/` (not `scratchpad/`, which is gitignored
working space) so the queue is durable and reachable from the phone, the same
reason `slice-6-test-plan.md` lives here. Delete an entry when it ships.

---

## Q1 — "New session" belongs at the TOP of the mobile session list

*(Wes, 2026-07-23: "put 'new session' at the top rather than forcing the user to
scroll past every historical session.")*

**File:** `packages/ui/src/views/SessionListView.vue` (575 lines). The spawn
`<form>` currently sits at the BOTTOM, after the session `<ul>`.

✅ **UNBLOCKED 2026-07-23** — step 9 landed (`115e728`) and did touch this file,
adding the board nav entry, exactly as predicted. Dispatch against that HEAD.

### The design question, decided when dispatched

The literal reorder moves a **four-row** form (label · cwd input · SDK/PTY radios
· submit) above the list, which pushes every session below the fold on a phone.
That trades "scroll to reach New Session" for "scroll to reach your sessions" —
the same cost, relocated.

**Recommended instead: a collapsed `+ New session` affordance at the top that
expands the form inline.** One row instead of four; New Session is the first
thing you see; the list stays visible. Same intent, no trade.

✅ **DECIDED 2026-07-23 (Wes): the collapsed affordance.** Context he gave —
*"right now I have a few dozen sessions on the list and it takes quite a scroll
to start a new one. Fine in testing, not a great quality of life for actual
use."* So the target is **reaching New Session without scrolling at all**, while
keeping the list itself immediately visible.

### ⚠ The stale string that must move with it

`SessionListView.vue:543` — the empty state reads *"No sessions yet — spawn one
**below**, or Discover terminal-started ones."* That sentence becomes **wrong**
the moment the form moves up. Update it in the same change; a UI that tells you
to look in the wrong place is a small lie, and this project does not ship those.

### Also check while in there
- The form keeps its `min-h-[44px]` touch targets (phone-first).
- Collapsed state must not hide a **failed spawn's** refusal message — a refusal
  that arrives while the form is collapsed still has to reach the operator.
- Dark-mode classes preserved.

**Lift:** small — one view, plus a test if any pure logic falls out (collapse
state is component state; probably nothing for `lib/`).


---

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
