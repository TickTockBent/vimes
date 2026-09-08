# Ranks — design documentation

The operating record for the design, opened 2026-09-08 at the pivot from
Vimes ([`decisions.md`](decisions.md) D1). Each file has one job:

| File | Job |
|---|---|
| [ranks-design-note.md](ranks-design-note.md) | **The founding document** (draft 1, ⟨Wes⟩, 2026-09-08). Frozen; superseded in detail by the living suite, cited by it forever. Its two factual errata are recorded in D1, not edited into the note. |
| [decisions.md](decisions.md) | **The decision record.** Every settled call, dated, numbered `D#`, with rationale. Append-only; a reversal is a new entry. Numbering restarted at D1 at the pivot. |
| [open-questions.md](open-questions.md) | **What still needs a call.** Each entry carries its **trigger** and the **current lean**; when decided it **moves** to decisions.md. Seeded from the note's §9 and the two live Vimes questions. |
| [design-principles.md](design-principles.md) | **The constitution** — the ground rules (0.x, carried from Vimes unchanged) and the Ranks pillars. Checked before recommending anything in their territory. |
| [calibration.md](calibration.md) | **The measurement record** — ⟨tune⟩ placeholders and, once measured, pinned bands *with their assumptions*. Nothing is pinned yet. |
| [risk-register.md](risk-register.md) | External surfaces (rule 0.6): the performer harnesses first. Vimes rows for surfaces that survive (the Agent SDK channel, CLI auto-update, git) stay **live** in the archive and are referenced, not copied. |
| _slice-N.md_ | *(per slice)* A slice's signed design as an operational plan. [slice-1.md](slice-1.md) is the first: the loop, headless, on one real task. |
| [vimes/](vimes/README.md) | **The Vimes archive** — the whole prior suite, frozen at the pivot, moved with `git mv` so history follows. Read-only by convention. |
| decomposition/ | Prior-art decomposition series + the carry-over tracker. **Untracked** (third-party repo analyses), shared by both eras. |

## Citation conventions

- A bare `D#` or `S#` means **this** suite. The Vimes record is cited as
  **`V-D#`** (decisions) and **`V-S#`** (slices); `V-spec` is the Vimes
  design spec (`vimes/vimes-design-spec.md`).
- **Code comments still cite the Vimes suite by its old path**
  (`docs/slice-18.md`, `docs/calibration.md`, `docs/decisions.md D37`).
  Those files now live under `docs/vimes/`. The comments are historical
  citations and are deliberately not rewritten (D1 rider e).
- "Room" is the design word for a node of the graph; `node` remains the
  code and manifest word until a real run pulls for the rename (D1
  ruling 6).

## Publication

This suite is **public** and tracked — the posture carries from Vimes
unchanged (archive [`vimes/README.md`](vimes/README.md) §Publication for
the full rules): no credentials, ever; no client data (describe workloads
generically); third-party repo analyses stay in `decomposition/`, untracked
via `.git/info/exclude`; personal machine paths are accepted exposure.

## Working rules that span the suite

- **Rule 0** — no behavior-shaping change ships without evidence + ⟨Wes⟩'s
  sign-off.
- **Gate-D** — ⟨tune⟩ numbers are never pinned unreviewed; calibrate,
  sign off, then pin in a deliberate commit.
- **Real use is the gate** (design-principles #7) — the product's exit
  gate is a real task run by ⟨Wes⟩, and no slice after slice 1 earns its
  build without a real run pulling for it.
- Decisions get dated, numbered entries; open questions **move** rather
  than being edited in place. Numbering is preserved forever (retrieve
  retired text via `git show`).
