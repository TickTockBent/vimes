# Ranks — the decision record

Append-only. Every settled design call gets a dated, numbered `D#` entry
with its rationale; a reversal is a new dated entry, never an edit.
Opened 2026-09-08 at the pivot; numbering restarts at D1. The Vimes record
(D1–D95, 2026-07-13 → 2026-09-08) is archived whole at
[`vimes/decisions.md`](vimes/decisions.md) and cited from here as `V-D#`
(slices as `V-S#`). Its D95 is the tombstone pointing at this file.

## D1 — The pivot: Vimes ends; Ranks is the verification loop alone — DECIDED 2026-09-08

*(Raised ⟨Wes⟩ 2026-09-08 — "I think it's time. We've been plugging away
at this for weeks and it's not passing the gate" — with
[`ranks-design-note.md`](ranks-design-note.md) (draft 1, ⟨Wes⟩, written
during the slice-20 park) as the founding document. Discussed and signed
⟨Wes⟩ 2026-09-08 in conversation, with two departures from the
orchestrator's first lean recorded below (multi-performer; same repo).
Builds as [`slice-1.md`](slice-1.md).)*

### The finding (rule 0.1)

Vimes's human exit gate was never *failed* — it was never **attempted**.
Across eight weeks, twenty slices, and ninety-four decision records, the
system hosted tests and only tests: ⟨Wes⟩ — "I haven't used vimes for one
bit of real work really, just tests and tests. Mostly because it's
unfinished and we kept changing things." The MVP line (V-spec slice 3)
was crossed on paper in July and never in use, so every slice after it
built on a product promise nobody had tested. The orchestration
discipline gated each slice's *code* rigorously — Sol rounds before code,
byte-identical scenario gates, differential freezes — and never once
gated the *product* on use. Rule 0.5 ("machinery with no live consumer
waits for its first consumer") was applied to data shapes and never to
the product itself. The orchestrator owns a share of that.

### The diagnosis, checked against the record

The note's §0 says Vimes was two products stapled together — a session
manager (a race lost before it began) and a verification loop (found
nowhere else in nineteen decompositions). The record supports the cut
empirically: the work that kept slipping, parking, or growing hazard
documentation is almost exactly the note's "dies" column — the input
lease and admission timing (V-D81, parked, never built), the PTY guard,
seen/unseen (V-D83), the steering surface, and the deploy-recursion
hazard that exists *only because* Vimes hosts interactive sessions. The
work that shipped on schedule and worked on first contact is the
"survives" column — the event spine, the artifact/hash machinery, the
extension engine, and the acceptance loop. V-S19 and V-S20 (declarations
governing briefings, then outcome routing) were Ranks being built inside
Vimes without the name: each per-declaration move took behavior from
compiled to declared, which is the note's graph-as-authority principle
one verb at a time.

### Errata to the founding note (the note stays unedited)

- §1 and §8 say `deriveReviewOutcome` "does not change by one line." It
  was **deleted** in V-S20·U3 (2026-08-26). What replaced it is *more*
  Ranks-shaped than the note remembers: `evaluateAcceptance`
  (`packages/core/src/extensions/acceptance.ts:128`) is a pure, total,
  five-kind evaluator driven by a **parsed declaration**, with parse-time
  binding invariants and fail-closed routing. The survives column reads
  "the acceptance declaration + `evaluateAcceptance`."
- §1's report catalogue: `report_completion`'s worklog shape and the verb
  catalogue were re-homed to core in V-S20·U1
  (`packages/core/src/extensions/reportVerbs.ts`). The bridge is further
  along than the note claims.

### Rulings

1. **The cut.** Vimes-the-session-manager ends. Ranks is the loop alone:
   rooms as pure functions from a brief to a report, typed edges, verdicts
   at checkpoints. The note's line is the product statement: *we do not
   care about sessions; we work on the project.*
2. **The exit gate for slice 1 is human, and it is the only one.**
   ⟨Wes⟩ used it for one real task — something he would otherwise have
   opened plain Claude Code for that week, not a Ranks test — and would
   use it again tomorrow. There is no machine exit gate at the slice
   level (unit assertions stay, rule 0.4 still binds the code). This is
   the discipline change: the gate discipline turned on the product
   instead of the code. **Kill criterion:** if ⟨Wes⟩ reaches for plain
   Claude Code mid-task to finish the work, the slice is killed and a
   decision record says why — in a week, not four months.
3. **Layer on Claude Code, not beside it.** The substrate the note wants
   (fresh agent sessions, schema-typed reports, deterministic
   orchestration) exists in Claude Code today; what does not is the typed
   graph, per-room grants, declared acceptance with routing, and readable
   verdicts — the survives column. Building a second daemon and UI to
   host what Claude Code already hosts is what ate Vimes. So: the engine
   survives *shrunk*; `packages/ui` dies; slice 1 has **no UI** and its
   operator surface is a small CLI; the note's §9.5 is answered now
   rather than watched for. A standalone product, canvas, or orchestrator
   chat is decided later, from a position of having used the thing.
4. **Multi-performer is designed in; one performer is built** (⟨Wes⟩'s
   departure: "build against Codex as well so they're both options, with
   an ability to loop in openrouter"). Under rule 0.6 each harness is an
   external surface behind one adapter interface —
   `Performer.run(brief, grant, reportSchema) → report | rejected |
   blocked`, each with usage and a transcript reference — and nothing
   above it knows which harness ran. Two performer *families*, not three
   performers: **harness-backed** (Claude Code, Codex CLI — the performer
   brings its own agent loop and tools; grants are enforced through its
   permission hooks) and **API-backed** (OpenRouter — a model, not an
   agent; we would own the tool loop). `performer = { harness, model,
   effort }` is a node field; the validator's grant-check is
   harness-aware (a room declaring a grant its harness cannot enforce is
   refused with the gap named, never silently downgraded). Claude Code is
   the only harness IN for slice 1; Codex and OpenRouter are
   risk-register verify-rows and go IN only by observation (rule 0.7),
   never from documentation.
5. **Same repo, history whole** (⟨Wes⟩'s departure from the orchestrator's
   fresh-repo lean, and the right call: this suite's append-only
   convention *depends* on `git show`, and the public showcase value is
   the record — a history that shows a product, its unattempted gate,
   and the cut). The Vimes suite is archived at `docs/vimes/` by `git mv`
   (this commit); the fresh suite starts here. The code cut is one
   bounded commit (S1·0: `packages/ui` and the first-order dead surfaces,
   nothing that the dispatch path imports) plus a second prune *after*
   the real run has shown what the runner actually used (S1·5). Repo and
   directory rename to `ranks` are ⟨Wes⟩'s (GitHub redirects hold).
6. **No vocabulary churn.** "Room" is the design word; `node` stays the
   code and manifest word until a real run pulls for the rename. This is
   the direct answer to "we kept changing things": no rename, re-shape,
   or migration earns its build in Ranks without a real run asking for
   it (design-principles #8).
7. **Ordering.** The slice-20 branch (the acceptance evaluator — the most
   Ranks-shaped code in the repo) merges in the same push as this record
   → S1·0 cut → SP1·1 spike → Gate-D → units → the real task.

### Carried and void (from the note's §10, confirmed against the record)

**Carried with reasoning intact:** V-D46 (fresh dispatch — now the
definition of a room), V-D48 (plan as artifact — a research room's
report), V-D53 (no chaining without a human — the human room), V-D67
(capability model — `tool_grant`), V-D70/V-D72 (engine vs tenant — a room
kind is an extension), V-D82's principle (process vs work — attempt
status vs report), the V-S9·4 shape-not-truth boundary, and V-D71's
Move-3 choreography (differential beside → flip → delete-and-freeze) as
the method for any future compiled→declared move. The decomposition
library carries whole (untracked, `docs/decomposition/`).

**Carried as open questions** (re-numbered in
[`open-questions.md`](open-questions.md)): V-D92 (orchestrator read
grant — note that the note's §4 lean *contradicts* V-D92's lean; both
are recorded, neither is decided), V-D93 (inferred join), and the note's
§9.1–9.6.

**Void by construction:** V-D10 (custody of foreign sessions), V-D78 as
a pillar (it is the whole phone now), V-D79, V-D81, V-D83, V-D94 (there
is no tree), and every V-D about the session surface, the tree, or PTY
hosting.

### Binding riders

- **(a)** The per-declaration migration series stops at move 2.
  Auto-dispatch (`by`), the queued move 3, is no longer scheduled; if a
  real run pulls for declared performer selection it returns as a Ranks
  slice under ruling 4's `performer` field.
- **(b)** Publication posture carries unchanged (archive
  [`vimes/README.md`](vimes/README.md) §Publication): `docs/` is public,
  `docs/decomposition/` stays untracked, nothing written here may carry
  credentials, client data, or third-party private content.
- **(c)** The cut is not a behavior change to the surviving loop. The
  V-S19 host differential, the V-S20 `acceptanceRouting` differential,
  the V-S18 stem test, and the tenant-boundary grep gate stay green
  through S1·0 and S1·5, byte-identical where they compare bytes.
- **(d)** The archive is read-only by convention. Corrections are new
  entries here citing `V-D#`.
- **(e)** Code comments cite the Vimes suite by its old path
  (`docs/slice-18.md`, `docs/calibration.md` …). Those now resolve under
  `docs/vimes/`; the comments are historical citations and are **not**
  rewritten (ruling 6).
