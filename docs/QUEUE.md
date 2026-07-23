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
