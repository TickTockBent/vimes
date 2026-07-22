# VIMES — design documentation

The operating record for the design. Each file has one job:

| File | Job |
|---|---|
| [vimes-design-spec.md](vimes-design-spec.md) + [vimes-tech-stack.md](vimes-tech-stack.md) | **The founding documents** (design spec draft 2 + stack recommendation draft 2, both 2026-07-13). Frozen at kickoff; superseded in detail by the living suite, cited by it forever. **The external-dependency risk register lives in the spec (§6)** until it needs to grow. The harness/invariants (§7), budgets (§8), and slice plan (§9) also live there. |
| [decisions.md](decisions.md) | **The decision record.** Every settled design call, dated, numbered `D#`, with rationale. Append-only; a reversal is a new entry, never an edit. Numbering continues the spec's: D2 and D9 arrived resolved; the rest are in open-questions until decided. |
| [open-questions.md](open-questions.md) | **What still needs a call.** Each entry carries its **trigger** (the slice/event that forces it) and the **current lean**. When decided it **moves** to decisions.md as a `D#`. Seeded with the spec's open decision records, keeping their `D#` numbers. |
| [design-principles.md](design-principles.md) | **The design constitution** — the ground rules (0.x) and design pillars, seeded from the spec. Checked before recommending anything that touches their territory. |
| [calibration.md](calibration.md) | **The measurement record** — pinned budgets and bands, probe/spike results, and the methods that produced them. Bands are pinned *with their assumptions*. Every ⟨tune⟩ number in the spec resolves here, and only here. |
| [risk-register.md](risk-register.md) | **Delta register** (spun up 2026-07-19): external-surface rows added/changed since the spec froze. The founding table stays in spec §6. |
| [design-directions.md](design-directions.md) | Planned/parked systems not yet scheduled into a slice (spun up 2026-07-19; first tenant: the D12 growth revisit). |
| [decomposition/](decomposition/README.md) | Prior-art decomposition series + the unified carry-over tracker (what's applied vs pending). |
| [architecture.md](architecture.md) | **Standing constraints** (spun up 2026-07-22): system-shaping structures the spec didn't pin. First tenant: projections are stream-local (D34) — read it before writing any projection fold. |
| _slice-N.md_ | *(per slice)* A slice's signed-off design as an operational plan: scope, build order, assertion list. |

Working rules that span the suite:
- **Rule 0** — no behavior-shaping change ships without evidence + sign-off.
- **Gate-D** — budgets and bands are never pinned unreviewed; calibrate first,
  sign off, then pin in a deliberate commit.
- Decisions get **dated, numbered entries** when made; open-questions entries
  **move** here rather than being edited in place. Numbering is preserved
  forever, even across a file split (retrieve retired docs via `git show`).
