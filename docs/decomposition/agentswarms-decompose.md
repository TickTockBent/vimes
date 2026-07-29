# Decomposition: AgentSwarms-fyi/agentswarms → Vimes
**Date:** 2026-07-29 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/AgentSwarms-fyi/agentswarms (source-available, Elastic License 2.0)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes docs in this repo. Fifth in the series (jinn, agent-teams-ai, codor, agenc-core, this); cross-corroborations flagged. Nothing here self-applies.

> **Licensing note.** ELv2 is *source-available, not open source* — it forbids providing the software to third parties as a managed service and forbids circumventing its license-key functionality. Pattern mining is unaffected (ideas aren't copyrightable), but **no code may be copied into Vimes**, and this matters more than usual given Vimes's own possible commercial future. See §7 — the repo is also a live specimen of the business model Vimes would most plausibly adopt.

---

## 1. Landscape

AgentSwarms is a self-hostable agentic AI **and business-intelligence** platform: agent chat, a visual multi-agent swarm canvas (XYFlow), RAG knowledge bases, warehouse connectors, dashboards, IAM, budgets, guardrails/evals, and sandboxed Python notebooks. Stack is React 19 / TanStack Start on Supabase (Postgres + Auth + Storage), Docker or Cloudflare Workers, bring-your-own-keys across ~12 providers. Actively developed, feature-dense, with a hosted counterpart at agentswarms.fyi.

**Why it matters to Vimes:** almost none of the product overlaps — no coding harness, no session ownership, no transcript handling. The overlap is one subsystem: the **swarm execution engine**, which is a graph runner with checkpointing, human-approval parking, LLM-as-judge evaluation, and budget gating. That subsystem is a preview of D51's destination (task stages as a graph rather than a line) and it contributes the single most useful artifact in this decomposition — a documented anatomy of *what a paused multi-step run must remember*. It also supplies a sharp philosophical contrast with AgenC's admission kernel that resolves into a Vimes-specific synthesis (§2.4).

## 2. Patterns worth lifting

### 2.1 Checkpoint anatomy — the resumability checklist for D51's graph
**Where:** `src/lib/swarmCheckpoint.ts` (pure module, no DB/server imports, explicitly so the round-trip is unit-testable).

```ts
// shape, not code
type SwarmCheckpoint = {
  ctx: Record<string,string>;      // variable map every node reads/writes
  lastOutput: string;              // fallback for an unconnected downstream node
  completedNodeIds: string[];      // never re-run: side effects are not idempotent
  skippedNodeIds: string[];        // ruled out by a condition/router
  deadEdgeIds: string[];           // edges a condition/router killed
  levelIndex: number;              // index into topological levels — where to resume
  suspendedNodeId?: string | null; // the node it parked at, for an approval
};
```

Three findings are documented inline, each of which is a bug someone paid for:
- **Losing routing decisions resumes into branches the run had already ruled out.** Skipped nodes and dead edges are *part of the state*, not derivable after the fact.
- **Losing the completed set re-runs agent calls and HTTP POSTs that already happened.** Side effects are not idempotent.
- **`completed` is passed explicitly rather than inferred from the context map** — because *a node whose output happened to be an empty string is still done*, and inferring from the variable map would silently re-run it.
- Order matters on restore: dead edges are replayed **before** skipped nodes, so the tracker's own invariant (a node is skipped *because* its routes died) holds during reconstruction.

**Vimes adaptation:** Vimes doesn't need to *store* checkpoints — the event spine can derive one, which is strictly better (I6, one source of truth). What this gives you is **the derivation checklist**, and one warning that lands directly on Vimes's design: derivation is only safe if completion is recorded as *an explicit event*, never inferred from the presence of output. Vimes is already well-positioned here (`report_completion` is an explicit event, and the D53 taxonomy distinguishes outcomes), but the moment D51's graph lands — parallel stages, conditional stages, a review that routes to one of several destinations — "which stages are done, which were ruled out, and which edges are dead" becomes state that a naive resume would lose. Reserve it as a projection shape now; it's a rule-0.5 call and it's cheap while the machine is still linear.

### 2.2 Approval parks the run — and the decision is read, never passed
**Where:** `src/utils/swarmResume.functions.ts`, `approval` node type in `swarmRuntime.ts`.

An approval node suspends the run at `suspendedNodeId` and writes an approvals row; resume reads the recorded decision **from the row**, deliberately not from a caller-supplied flag, with the reason stated: *accepting an `approved` flag from the caller would let anyone who can reach this function approve anything.*

**Vimes adaptation:** this is an auth finding dressed as an ergonomics detail, and it applies squarely to the slice-7 MCP surface and the board API. Every state-advancing call — promote, dispatch, clear-attention, review verdict — must derive its authority from the persisted record (the task's stage, the reviewer's filed report, the gate's own decision), never from a payload field asserting the decision was made. Vimes is already mostly here by construction (`deriveReviewOutcome` reads the filed report; the dispatcher owns transitions), but the MCP surface is exactly where a convenience parameter would sneak in. Worth an explicit line in the tool-surface design: **no tool accepts a parameter that asserts a decision the daemon should be reading.**

### 2.3 Risk-tiered approvals with optional timeouts
**Where:** node config — `approvalTitle`, `approvalRisk: 'low'|'medium'|'high'`, `approvalTimeoutMs` (0/undefined = never times out), plus approver user/group routing.

Multi-operator routing collapses to nothing for single-operator Vimes. **The risk tier does not.** Vimes's attention model currently treats gates as uniform: any `needsAttention` fires a push. A risk tier lets the same model express "this one can wait for the morning" vs "buzz the phone now" — and, once unattended operation matters, "a low-risk gate may auto-proceed after N minutes; a high-risk gate never times out." That's a small addition to the attention reason/urgency shape and it's the natural companion to the auto-mode work already landed.

### 2.4 Budget gate, fail-**open** — and the synthesis with AgenC's fail-closed kernel
**Where:** `src/utils/budgetGuard.server.ts`. Explicitly opt-in (`ENFORCE_BUDGET_CAP`), month-to-date spend cached with a 60s TTL, and the stated rule: *returns not-over when enforcement is disabled, no cap is set, or anything fails — this gate must never be the reason a legitimate call breaks.* The opt-in rationale is equally honest: the default cap was a tiny placeholder, so enabling enforcement by default would immediately start refusing calls on instances whose cap was never meant to bite.

This is the **exact inverse** of AgenC's admission kernel (deny on unpriced models, `held_unknown` charges worst case, provider overrun cancels the subtree). Neither is wrong — they encode different assumptions about who is watching:

| | Fail-open (AgentSwarms) | Fail-closed (AgenC) |
|---|---|---|
| Assumes | A human is present and will notice | Nobody is watching |
| Worst case | Overspend | Legitimate work blocked |
| Right when | Attended, interactive | Unattended, autonomous |

**The Vimes synthesis — and it's new, because neither project needs it:** Vimes is *both*, and knows which at runtime. An interactive session with the operator on the board should fail **open** (a stale meter must never block the human's own work). A dispatched stage run in an unattended orchestration queue at 3am should fail **closed** (a stale meter means stop, because the 5-hour window is the human's tomorrow). The same budget gate, two failure semantics, selected by *whether a human is attending the run* — which Vimes already models via the attention dimension and session class. Record it as a rule; it costs one branch and it's the difference between "meters that lie" (pillar 4's stated fear) and "meters that annoy."

### 2.5 Eval scorecards as the quality-trend layer above the verdict
**Where:** `src/lib/evalScorecard.ts` + the `evaluate` node. An LLM-as-judge node scores upstream output against a rubric and emits `{ metrics: { <id>: { score 0..1, reason } }, overall_score, pass, summary }`; the parser is aggressively defensive (`looseJson` tries direct parse → fenced block → outermost brace span) *because models drift — code fences, leading prose, a missing field* — and an unparseable scorecard is skipped, never thrown, so one bad row can't break the quality view.

Two lifts and one contrast:
- **The contrast (worth recording as vindication):** their judge output rides in a text field and needs three parsing strategies. Vimes's reviewer files a typed tool payload against real criterion UUIDs — no `looseJson`, no drift, no "the model wrapped it in a fence today." The bounce-path test's *"reviewer reported all 5 REAL criterion UUIDs"* is exactly the failure class this module exists to survive. Different verdict shapes, and Vimes's is structurally immune.
- **The lift:** per-criterion *scores over time* is a layer Vimes doesn't have and could get almost free from the spine. Which acceptance criteria fail most often? Which model produces plans whose implementations bounce? What's the first-pass rate per stage, per work-order author (human vs orchestrator)? That's the insights/gamification layer with genuine operational value — and it's the empirical feedback loop for D43 (are the work-order fields producing better outcomes?) and for the orchestrator-as-author pivot criterion.
- **The defensive-parsing discipline** still transfers to any place Vimes must read model-shaped text it doesn't control: skip the row, never throw, never let one malformed artifact break an aggregate view.

### 2.6 Loop node with `maxIters` — the convergence bound
**Where:** `loop` node — re-runs the agent body until a check passes or `max_iters`.

Vimes has attempt identity and D53's no-chaining rule, so today every retry costs a human click and the bound is implicit (the human gets bored). The moment unattended fix loops are allowed, the explicit bound is required: max attempts before the task quarantines with `done+manual-review-required` — which the task state machine already reserves. Fourth appearance of convergence-bounded rework in the series (Jinn's convergence-aware review exit, ATA's retry-then-quarantine, AgenC's deadline propagation, this).

## 3. Patterns to skip (with reasons)

- **The BI half of the product** (dashboards, data catalog, warehouse connectors, ontologies, SQL workbench, cross-filtering, PDF export). Different product entirely.
- **Supabase-as-backend, multi-tenant IAM, RLS, per-user provider keys.** Vimes is a single-operator local daemon behind Access; multi-tenancy is the architecture it deliberately doesn't have. Their model is the right one *for a hosted product* — which makes it a reference for a hypothetical future Vimes SaaS, and an anti-pattern for the current one.
- **RAG / knowledge bases / embeddings.** The Vimes analog is the planned code map + repo wiki, which is a generated-and-regenerable artifact rather than a vector store — a deliberate and better fit for a codebase that changes under you.
- **Notebook sandbox runtime.** One hygiene note travels though: *no provider key ever exists inside the sandbox* — model and KB calls are brokered by the platform. That's the right posture for the Vimes-builds-Vimes sandbox rule when workers run against sandbox projects (credential brokering, not credential handoff), and it composes with the per-worker scoped tokens already on the roadmap.
- **Multi-provider breadth (~12 providers).** Sixth corroboration of the abstraction bill. Same conclusion: seam, not layer.
- **XYFlow canvas + React/TanStack/Supabase stack.** Not Vimes's stack. XYFlow is, however, the obvious reference if D51's graph ever wants a visual editor — noted for the horizon, not now.
- **Guardrails suite (prompt-injection tests, PII redaction).** Multi-tenant concerns; Vimes's threat model is one operator on their own box behind Access.

## 4. Feature gap analysis

| Feature | In AgentSwarms as | Vimes priority | Notes |
|---|---|---|---|
| Checkpoint anatomy (completed / skipped / dead-edges / level / suspended) | `swarmCheckpoint.ts` | **High (design)** | D51's resumability checklist; derive from spine, don't store |
| Completion recorded explicitly, never inferred from output | checkpoint comment | **High (rule)** | Guards the derived-checkpoint approach |
| Decision read from the record, never from the caller | `resumeApprovedSwarmRun` | **High (rule)** | Slice-7 MCP surface + board API |
| Attended/unattended failure semantics for budget gates | fail-open guard (contrast w/ AgenC) | **High (rule)** | The synthesis neither project needed |
| Risk-tiered gates (+ optional timeout on low risk) | `approvalRisk`, `approvalTimeoutMs` | Medium | Refines attention urgency; enables unattended auto-proceed |
| Per-criterion quality trends over time | eval scorecards | Medium | Free from the spine; empirical D43 feedback |
| Explicit convergence bound (max attempts → quarantine) | `maxIters` | Medium | Required before unattended fix loops |
| Defensive parsing for model-shaped text | `looseJson` | Low | Only where Vimes must read untyped model output |
| Credential brokering into sandboxes | notebook runtime | Low | For the Vimes-builds-Vimes sandbox rule |

## 5. Open questions

1. **Derived checkpoint vs stored checkpoint.** Recommendation above is derived (spine is the single source, I6 holds). The open part is whether every stage outcome is currently evented with enough fidelity to reconstruct "ruled out" as distinct from "not yet reached" — a distinction that doesn't exist in a linear machine and becomes load-bearing on the first conditional edge. Worth checking against the current event taxonomy *before* D51 is decided, since the answer may add one event type rather than a subsystem.
2. **Risk tiers for a single operator — worth it now?** Argument for: it's the mechanism that makes unattended operation tolerable (low-risk gates auto-proceed, high-risk always wait), which is the phase-two blocker. Argument against: with 0 gates on auto-mode legs, there may be nothing left to tier. Probably resolves as *"tier the attention reasons, not the gates"* — urgency on the notification, not permission on the call.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Reserve the checkpoint projection shape (completed / ruled-out / dead-edge / resume-point / suspended-at) as a spine projection; verify the event taxonomy can distinguish "ruled out" from "not yet reached" | low (design) | D51 prep |
| 2 | Rule: completion is an explicit event, never inferred from output presence or emptiness | trivial (rule) | event schema note |
| 3 | Rule: no tool or API call accepts a parameter asserting a decision the daemon should read from the record | trivial (rule) | slice-7 MCP surface |
| 4 | Rule: budget/meter gates fail **open** for attended interactive sessions, **closed** for unattended dispatched runs; select by session class | low | slice 5–7 |
| 5 | Add urgency/risk tier to attention reasons; low-risk may auto-proceed after a bound when unattended, high-risk never does | low | attention model |
| 6 | Explicit convergence bound on fix loops (max attempts → `done+manual-review-required`) before unattended operation | low | slice 7 |
| 7 | Per-criterion outcome aggregation over the spine: failure rates by criterion, stage, model, and work-order author | low | insights layer |
| 8 | Defensive-skip discipline wherever Vimes parses model-shaped text it doesn't control (skip the row, never throw) | trivial | as encountered |

## 7. Non-technical: this repo is a specimen of the Vimes commercial model

Worth noting separately because it bears on the monetization conversation rather than the build. AgentSwarms ships **exactly the packaging shape that best fits Vimes**: source-available under ELv2, fully self-hostable, bring-your-own-keys and bring-your-own-infrastructure, with the trademark and the hosted service explicitly retained by the author, and a README table drawing a clean line between "run it yourself" and "the hosted thing we sell." No SaaS obligation, no code custody, no multi-tenancy tax on the self-hosted path.

If Vimes ever goes commercial, this is a working reference for *how the line gets drawn* — license choice, what stays in the repo, what the hosted product adds, and how the split is communicated without souring the self-host audience. Their split (self-host = the platform; hosted = the learning/classroom product) is unusual and probably not the Vimes split, but the structural pattern is the one to study. Zero action now; file for the day the question stops being hypothetical.

---
*End of decomposition. Cross-corroborations across the five-repo series: convergence-bounded rework (4th); human approval as a first-class parked state (4th); per-spawner/per-user budgets (5th); multi-provider abstraction cost (6th). New here: the checkpoint anatomy with its three paid-for findings, the fail-open/fail-closed contrast that resolves into an attended/unattended rule, and quality-trend aggregation above the verdict. Notably absent from this repo and present in Vimes: any structural guarantee that a reviewer's verdict covers the acceptance criteria — their judge emits prose-wrapped JSON parsed three ways; Vimes's files typed criterion UUIDs. The verdict-integrity gap remains Vimes's clearest lead in the field.*
