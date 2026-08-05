# The extension model — tiers + manifest (S9·2)

**DRAFT — proposed, awaiting pass sign-off (S9·6).**

Written 2026-08-05 as the S9·2 deliverable of the slice-9 extension-engine
design pass (D70). It answers pass scope questions 1 (the engine/extension
boundary → **D66, proposed here**) and 3 (the extension manifest → **schema
reserved here, rule 0.5**).

It builds on `architecture.md` S9·1 (E1–E3 settled with Wes; E4 is the handoff
this document receives) and on the verified prior-art brief (herdr as parsed,
agent-of-empires as shipped, agenc, jinn). **Nothing here builds anything.**
Every schema element is a reservation; every boundary claim is a proposal for
Wes to sign, reject, or amend in S9·6.

Prior art is cited by path into the local clones under
`docs/decomposition/references/` — the clones are the authority (rule 0.7
applied to our own artifacts), and every field a schema decision rests on was
spot-checked against source while writing.

---

## §0. The one rule everything else serves

Carried verbatim from D70, rule 0.3 and principle 13:

> **Extensions propose, the engine's deterministic core decides.**

Two consequences bind every line below:

1. **Every manifest surface must be expressible as a proposal the engine
   validates.** A declaration that the engine cannot validate without running
   extension code is not a declaration — it is a plugin API by another name.
   The test applied to each section of §2: *can the daemon parse this, check
   it, list it, and refuse it without executing anything the extension
   shipped?*
2. **Authority is never carried in a payload.** The engine stamps who
   proposed a transition from the channel the proposal arrived on; it never
   reads a payload field claiming the decision happened (#13). The task
   machine already does exactly this — `transitionProposedBySchema =
   'human' | 'orchestrator' | 'dispatcher'`
   (`packages/core/src/tasks/taskStateMachine.ts:147`) — and §2.4 turns it
   into a manifest validation rule rather than an authoring convention.

---

## §1. The tier boundary — Proposed D66

### 1.1 The proposal

**Proposed D66: two tiers, one vocabulary.**

- **Tier 1 — in-process modules over the spine.** First-party only. The
  module is TypeScript shipped inside the daemon build, loaded into the
  daemon process at boot, and reached through a declared extension-host
  interface. It gets spine-speed access: it may register projections and
  reducers that run inside the persist-before-broadcast path. It gets no
  failure isolation whatsoever — a Tier-1 crash is a daemon crash.
- **Tier 2 — external processes over the public API.** herdr's fork, and
  principle 15 made literal: a directory with a manifest, invoked as argv
  commands and/or one supervised long-running worker, speaking the same
  HTTP+WS (and MCP) surface any client speaks. It gets language freedom and
  real crash isolation; it gets exactly the API the public surface carries,
  gated by capability grants (S9·3).

**The tier is a deployment property, not a vocabulary.** Both tiers declare
themselves with the *same* manifest, contribute the *same* section kinds, and
are validated by the *same* parser. Which tier an extension runs in is
decided by one field (`[runtime].kind`, §2.3) whose privileged value the host
grants only to builtin-trust extensions — trust is host-assigned, never
manifest-declared (`agent-of-empires/aoe-plugin-api/src/capability.rs`,
`TrustLevel::{builtin,community}`).

**The completeness rule that keeps #15 honest:**

> **Tier-2 completeness.** Any manifest surface must be servable over the
> public API. Tier 1 is a latency-and-composition optimization, never a
> privileged vocabulary. A capability Tier 1 can express and Tier 2 cannot is
> a bug against principle 15, and gets a decision record — not a shrug.

One exception is named now rather than discovered later: **in-line
projections** (a reducer that runs inside the write path) are Tier 1 only;
Tier 2 consumes projections by subscription. Whether a Tier-2 extension may
*define* a new projection is left open (§4.2, open question 1) because the
answer is either "a new engine service" or "an admitted asymmetry", and both
are Wes-level calls.

### 1.2 What each tier may touch

| | **Tier 1 (in-process)** | **Tier 2 (external process)** |
|---|---|---|
| Reaches the engine via | the declared extension-host interface (in-process; same operations as the public API, plus projection registration) | HTTP + WS + MCP — the public API, unchanged |
| May append to the spine | yes, through the engine's validated append path (never `store.append` directly) | yes, through the same path, over the API |
| May run a reducer in the write path | yes | no (subscribes instead) |
| Language | TypeScript, in the daemon build | anything that can speak HTTP/WS |
| Loaded by | daemon boot (code) + manifest re-read per entry point | manifest re-read per entry point; worker supervised, commands spawned per invocation |
| Failure isolation | **none** — a throw in the write path is a daemon incident | full — process death is an observable event; the spine is untouched |
| Concurrency limits | none (it is the daemon's event loop) | capped command pool + one supervised worker per extension (§2.9) |
| Version coupling | daemon build **and** `api_version` | `api_version` (+ optional `vimes_version` range) |
| Who may author | first party, under the same gate discipline as engine code | whoever the trust model admits — v1 lean: first-party only (D67) |
| Capability grants | auto-granted (builtin trust), still **declared** so the manifest stays the inspectable truth | prompted/pinned per D67 |

Two properties of Tier 1 are non-negotiable in the proposal, because they are
the only things that keep "in-process" from meaning "unbounded":

- **A Tier-1 module imports the extension-host interface, not engine
  internals.** If Tier 1 may reach into `packages/core` at will, then the
  extension API is "whatever the daemon happens to export this week", #15
  quietly dies, and the tasks extension's migration proves nothing about
  generality. (DEFAULT TAKEN — §4.2, open question 2.)
- **A Tier-1 module still proposes.** Direct spine writes, direct projection
  mutation, and direct transition decisions stay engine-owned. The privilege
  Tier 1 buys is *placement and latency*, not *authority*.

### 1.3 Where each known consumer lands

| Consumer | Tier | Why |
|---|---|---|
| **The tasks extension** (board, stages, dispatch policy, review, drive verbs) | **Tier 1** | It is already in-daemon TypeScript with a deterministic state machine that clients read at spine speed; moving it out-of-process *and* re-homing it in one step is two risks at once. Its verbs and overlays are declared in the same manifest a Tier-2 extension would use, so the seam is proven even though the deployment is in-process. |
| **Book Genesis** | **Tier 2** | Its performers are Claude Code sessions the engine dispatches; its logic is briefings, artifacts and thresholds. Nothing in it wants the write path. It is deliberately the tenant that proves Tier 2 is real — the kill criterion's actual test (slice-9.md). |
| **Drive verbs** (promote / move / dispatch / amend) | tier of their owner | They are *content of the tasks extension* (D70), declared as two-faced verbs in its manifest. Nothing about a drive verb is tier-specific: the same declaration in a Tier-2 manifest yields the same two faces. |
| **A future ACP face** | **Tier 2** | Per the S9·0a read §5: an external process consuming the public API and speaking ACP outward, so the engine never learns ACP at all. Tenant-shaped, engine-ignorant, on a trigger. |
| **The web UI / the future CLI client** | *not extensions* | They are clients of the same API (#15). Extensions contribute to what clients render; they are not themselves a client tier. Session hosting is engine, never a listed extension (design-directions, mockups §3). |

### 1.4 Rationale — the herdr fork, analyzed

The fork D66 opened (open-questions.md) was: herdr's plugins are external
processes; VIMES's first extensions are in-process TypeScript modules; those
are different things wearing one word.

The corpus resolves it rather than splitting the difference:

- **herdr chose pure-external and got crash isolation for free by having
  nothing to crash into.** No supervised long-running plugin process exists:
  build/startup hooks are one-shot, actions and event hooks are short-lived
  argv commands, panes are ordinary PTY panes
  (`herdr/src/app/api/plugins/runtime.rs`, `.../panes.rs`). Communication is
  argv + env + callback-through-the-public-CLI (`.../env.rs`) — "the entire
  Herdr CLI is the plugin API" is literally true in their code. That is the
  purest expression of #15 available, and it is why Tier 2 is the *reference*
  tier here.
- **agent-of-empires chose one supervised worker per plugin with capability
  middleware on every RPC** (`aoe-plugin-api/src/manifest.rs` `RuntimeSpec`;
  `src/plugin/host_api.rs` `PluginRpcContext::require`). It shows an external
  tier can carry real, long-lived, stateful extensions without becoming
  in-process — and that the price is a supervision story, not an API split.
- **Neither ships an in-process tier at all.** So Tier 1 must justify itself
  on VIMES-specific grounds, and it does, on exactly two: (a) the first tenant
  already lives there and its determinism is load-bearing (0.3 — the state
  machine adjudicates without network or UI), and (b) projections that run
  inside persist-before-broadcast (I13) cannot be an out-of-process round
  trip without changing the spine's ordering guarantees.
- **Nobody in the corpus lets the privileged tier have a private
  vocabulary.** AoE's builtins declare the same manifest and the same
  capabilities as community plugins; they are merely auto-granted. That is
  the property Tier-2 completeness copies, and it is what makes the tasks
  extension's migration a *test* of the seam rather than a rename.

The cost of the two-tier answer, stated plainly: Tier 1 has no failure
isolation, so "an extension crash can never corrupt or stall engine state"
(D70) is true by *review discipline* at Tier 1 and true by *architecture* at
Tier 2. The proposal accepts that asymmetry only because Tier 1 is
first-party-and-in-build; the day a Tier-1 slot is offered to code we did not
review, D66 is reopened, not stretched.

### 1.5 Every E4 surface gets a declaration home

E4 (architecture.md) enumerated what the engine API must carry. This is the
mapping the work order demands — each item's home in the manifest, and the
tier posture:

| E4 item | Declared in | Runtime access gated by |
|---|---|---|
| 1. Tree CRUD + subscription | `[[events]]` (subscription) | `tree.read` / `tree.write` capabilities |
| 2. State overlays on engine objects | `[[overlays]]` (§2.5) | `overlay.write` |
| 3. Verb registration, two faces | `[[verbs]]` (§2.4) | invocation-time: the verb's own declared capabilities |
| 4. Panes (declarative blocks; PTY escape hatch) | `[[panes]]` (§2.6) | none for `kind="blocks"`; `pty` inherits terminal posture |
| 5. Per-project activation (+ reserved per-node) | the project declaration file (§2.8), `nodeConfig` reserved | n/a (activation is a project act, not an extension capability) |
| 6. Blob/artifact service (E1-b) | nothing — namespace is host-assigned | `blob.read` / `blob.write` |
| 7. Dispatch primitive (E1-d) | referenced from `[[verbs]]` / `[[node-kinds]]` | `session.dispatch`, and separately `session.unattended` |
| 8. Reserved: session-spec confinement (E3's third meaning) | reserved field on the dispatch spec, named `confinement` | S9·3 |

Item 6 is deliberately *not* a manifest section: the engine assigns each
extension its blob namespace from its id, so there is nothing for a manifest
to declare and nothing for an extension to claim (§2.9).

---

## §2. The manifest — reserved schema (rule 0.5)

Format is **TOML** (Wes-settled). One file per extension at its root:
**`vimes-extension.toml`** (herdr: `herdr-plugin.toml`; AoE:
`aoe-plugin.toml` — same convention, our name).

### 2.1 The annotated example

```toml
# ── identity ────────────────────────────────────────────────────────────────
id          = "vimes-tasks"      # ≤120 chars, ASCII alnum + : . _ -  (trimmed)
name        = "Tasks"            # non-empty after trim
version     = "1.4.0"            # SEMVER-VALIDATED (see 2.2 — differs from herdr)
api_version = 1                  # manifest vocabulary version (integer)
description = "Work orders, stages, dispatch and review."

# Optional: a semver RANGE over the vimes daemon's own version. Distinct from
# api_version: api_version gates the manifest SHAPE, vimes_version gates host
# BEHAVIOUR. Absent = no constraint.
vimes_version = ">=0.9, <2"

# ── runtime resource access (trust-gated; taxonomy finished in S9·3) ────────
# Top-level keys come BEFORE any table header — TOML binds bare keys to the
# most recently opened table, so `capabilities` after [runtime] would silently
# become `runtime.capabilities`. The ordering is load-bearing in every example
# below.
capabilities = [
  "tree.read", "tree.write",
  "session.dispatch", "session.unattended",
  "blob.read", "blob.write",
  "overlay.write",
]

# ── how it runs ─────────────────────────────────────────────────────────────
[runtime]
kind = "in-process"              # "in-process" (Tier 1, builtin trust only)
                                 # | "command"  (Tier 2, argv per invocation)
                                 # | "worker"   (Tier 2, one supervised process)
# For "command"/"worker" only:
# command = [".venv/bin/worker", "--serve"]   # argv; argv[0] extension-relative
# system  = false                             # opt in to PATH resolution

# ── static contributions (declarative; no trust grant needed) ───────────────
[[verbs]]
id          = "promote"
title       = "Promote task"
description = "Move a task to its next stage."
target      = "task"                       # engine-enforced object kind (2.4)
input       = "schemas/promote.json"       # extension-relative JSON Schema

  [verbs.agent]                            # face 1 — the agent tool
  server = "vimes_board"                   # D65 verb-family server; engine mounts
  tool   = "promote_task"                  # model sees mcp__vimes_board__promote_task
  offered_when = "stage in [plan-ready, review]"   # RESERVED predicate (2.4)

  [verbs.human]                            # face 2 — the human command
  command = "promote"                      # `:promote review`; palette entry
  args = [
    { name = "to_stage", required = true, from = "input.toStage" },
  ]

[[overlays]]
id      = "task-stage"
target  = "session"            # "session" | "node"
key     = "stage"              # engine namespaces it as ext.vimes-tasks.stage
type    = "enum"               # "enum" | "scalar"  (2.5)
values  = ["planning", "plan-ready", "implementing", "review", "quarantined"]
# DECLARED mapping into E2-b's versioned total order over attention states
attention = [
  { value = "review",      rank = "attention.v1.needs-human" },
  { value = "quarantined", rank = "attention.v1.blocked" },
]

[[panes]]
id        = "board"
title     = "Board"
kind      = "blocks"           # "blocks" (default, client-agnostic) | "pty"
scope     = "project"          # "project" | "node" | "session"
placement = "main"             # "main" | "context" | "sidebar" | "overlay"
source    = "panes/board"      # host calls this to fetch the block tree
degrade   = "link"             # what a client that cannot render it does

[[events]]
on      = "run_completed"      # allowlist-validated; UNKNOWN = warning, not error
deliver = "worker"             # "worker" | "command"
# command = ["bin/on-run-completed"]        # for deliver = "command"

# ── RESERVED: the node kit (S9·4 designs it; see node-kit.md) ───────────────
[[node-kinds]]
# id / kind (work|review|hold) / briefing / acceptance / auto_dispatch — the
# table shape is reserved here and specified in S9·4. A manifest declaring
# node-kinds against api_version 1 parses, lists, and is refused at activation
# with "node-kinds require api_version >= 2".
```

### 2.2 Identity and versions

| Field | Required | Enforced shape | Provenance |
|---|---|---|---|
| `id` | yes | trimmed, non-empty, ≤120 chars, ASCII alnum + `:` `.` `_` `-` | herdr's grammar verbatim (`manifest.rs:592-601`, `normalize_identifier`) |
| `name` | yes | non-empty after trim | herdr |
| `version` | yes | **valid semver** | *diverges from herdr* — see below |
| `api_version` | yes | integer ≥ 1, ≤ host's `API_VERSION` | AoE (`aoe-plugin-api/src/manifest.rs:24`) |
| `description` | no | empty-after-trim dropped | herdr |
| `vimes_version` | no | semver *range* over the daemon version | AoE's `aoe_version` (`manifest.rs:101-107`) |

Local ids inside sections (`verbs.id`, `overlays.id`, `panes.id`) use herdr's
**local**-id grammar — the same charset minus `.` (`manifest.rs:602-611`) —
because the engine composes qualified names with dots
(`vimes-tasks.promote`), and a dot inside a local id makes that composition
ambiguous. Duplicate ids within a section are a hard error (herdr).

**Why `version` is semver-validated when herdr's is free text.** The brief's
[doc≠code] finding 2: herdr validates `min_herdr_version` strictly but leaves
plugin `version` an arbitrary string — the host protects its own comparison
and not the plugin's identity. VIMES cannot afford that: the project
declaration pins extensions by version *range* (§2.8), and a range cannot be
resolved against a version that does not compare. Non-semver `version` is a
parse error, not a warning.

### 2.3 `api_version`, not a version floor

The manifest declares **the vocabulary version it was written against**, and
the host validates **field by field**: a field introduced at vocabulary 3
present in a manifest declaring `api_version = 1` is refused with
`"<field> requires api_version >= 3"`, exactly as AoE does
(`aoe-plugin-api/src/manifest.rs:1061`, `:1237-1300`). Two properties fall
out that a single `min_vimes_version` floor does not give:

1. **A too-new manifest fails with "upgrade vimes", not parse noise.**
   `api_version` is pre-parsed permissively before the rest of the document
   is deserialized (`manifest.rs:889-896`), so the error names the real
   problem.
2. **New capability strings do not bump the vocabulary.** Capabilities are
   open strings validated against a known list (§2.7); adding one is not a
   schema change. AoE's split, kept.

`vimes_version` stays available for the *other* kind of constraint — "this
extension needs daemon behaviour that only ≥0.9 has" — and is checked at
activation, not only at install (herdr's stricter-than-documented behavior,
brief [doc≠code] finding 3: a downgrade must disable a too-new extension).

**Data artifacts ride on the same field.** D66's original note asked for
`min_vimes_version` floors on data artifacts too — work-order schemas, golden
fixtures, node-kit definitions, exported board templates. The proposal:
those artifacts carry `api_version` (not a daemon-version floor) in their own
envelope, validated by the same comparison, because what an artifact needs is
*vocabulary* compatibility, not a binary floor. An old fixture against a new
core then fails with one sentence naming the field it used, which was the
whole point of the herdr lift.

### 2.4 `[[verbs]]` — two-faced, one authority

The mockups' settlement (design-directions, base-VIMES mockups §5): **every
extension verb is exposed BOTH as an agent tool AND as a human command** —
same verb, same principle-13 authority derivation, different invoker. This is
how one workflow extension serves a fully-agentic shop and a fully-
human-gated shop without forking.

| Field | Meaning |
|---|---|
| `id`, `title`, `description` | identity; engine qualifies as `<ext-id>.<verb-id>` |
| `target` | the engine object kind the verb acts on (`task`, `session`, `node`, `project`, or an extension record kind). **Engine-enforced**, not client advice — see below |
| `input` | extension-relative JSON Schema path; the engine validates every invocation against it before the verb sees it |
| `[verbs.agent].server` | the D65 verb-family server this tool mounts under (`vimes_board`, `vimes_report`, …) |
| `[verbs.agent].tool` | the tool name inside that family; the model sees `mcp__<server>__<tool>` |
| `[verbs.agent].offered_when` | **RESERVED** exposure predicate (D55: report tools are *offered per stage*, not to every dispatched session). Predicate vocabulary is S9·4's (§4.2, open question 7) |
| `[verbs.human].command` | the command name (`:promote` in the TUI, palette entry on the web) |
| `[verbs.human].args` | positional/named argument shape, each entry mapping to a path in `input` |

**The #13 validation rule, made mechanical.** Two parse-time checks, both
cheap and both refusals:

1. **A verb's `input` schema may not declare a property named `proposed_by`,
   `approved`, `authority`, `actor`, or any name on the engine's reserved
   authority list.** The engine stamps the proposer from the invocation
   channel — human command, agent tool call, extension worker — exactly as
   `transitionProposedBySchema` (`human | orchestrator | dispatcher`) does
   today (`packages/core/src/tasks/taskStateMachine.ts:147`).
2. **Both faces share one `input` schema.** A verb cannot offer the agent a
   richer payload than the human, or vice versa; if the two faces could
   diverge, "same verb, same authority derivation" is a slogan rather than a
   property.

**`target` is enforced, and that is a deliberate divergence from herdr.**
Their `contexts` field is documented as scoping where an action is offered
and the invoke path never checks it (brief [doc≠code] finding 1) — it is
client-side advice. VIMES enforces `target` at invocation and lets clients
*also* use it for offering. **DEFAULT TAKEN** (§4.2, open question 3): the
finding said "decide explicitly which side enforces", and the fail-closed
side is the engine.

**Namespacing and collisions.** Verb-family server names (`vimes_board`) are
engine-owned, not extension-chosen: they are the exposure matrix's units — a
family the doctrine does not grant simply is not mounted (D65). Two activated
extensions declaring the same `tool` inside the same family is an
**activation error** for that project, named loudly (both ids, the family,
the tool), never a silent last-writer-wins.

### 2.5 `[[overlays]]` — extension state painted on engine objects

The mockups' §6: the tasks extension puts `review` on a session row; the
engine object knows nothing about tasks. An overlay is a **declared, closed
decoration** — the engine stores and fans it out, and never interprets it.

- `target` — `session` or `node` (the two engine objects clients render).
- `key` — namespaced by the engine as `ext.<id>.<key>`; extensions cannot
  collide with each other or with engine fields.
- `type` — `enum` (a closed value vocabulary) or **`scalar`** (a number with
  a display `format` and optional `bands`). The scalar variant exists because
  tenant 2 needs it: a Genesis floor of 7.4 is not an enum, and AoE's
  `RowColumn` slot carries "optional sort/filter scalars"
  (`aoe-plugin-api/src/manifest.rs:711-713`) as prior art. **DEFAULT TAKEN**
  (§4.2, open question 4).
- `attention` (enum overlays) / `bands` (scalar overlays) — the mapping from
  an overlay value or numeric band into **E2-b's explicit, versioned total
  order over attention states**. The severity is **declared, never computed**: the engine's total
  order is authoritative, and the overlay only says which existing rank a
  value claims.

**Unknown attention rank is a hard error, not a warning** — and this is the
one place we deliberately break herdr's degrade posture. E2-b's pin (1) says
every reserved or future attention reason declares its severity rank *at
reservation*, "or the rollup silently misorders the day it lands". An unknown
event kind (§2.6) merely means a hook never fires; an unknown attention rank
means the rollup is wrong while looking right. Loud beats degraded exactly
when silence is the failure mode.

### 2.6 `[[panes]]` and `[[events]]`

**Panes.** `kind = "blocks"` is the default and the client-agnostic contract:
the extension returns a host-rendered block tree (AoE's model — `section`,
`row`, `action`, `callout`, `bar`, `columns`; `aoe-plugin-api/src/manifest.rs`
`UiSlot`/blocks vocabulary), which the web renders as DOM and the TUI renders
as text. `kind = "pty"` is the terminal-first escape hatch (herdr's model:
the pane *is* a real PTY pane, `herdr/src/app/api/plugins/panes.rs`) — pillar
7's raw sibling beside the abstraction, and honest about the cost: a PTY pane
does not degrade onto a web panel for free.

- `scope` — `project | node | session`: what the pane is rendered *about*.
- `placement` — `main | context | sidebar | overlay`: the shared placement
  vocabulary both clients understand (web = panel stack per D39; TUI = window
  strip). Per-client rendering is S9·5's; the vocabulary is reserved here.
- `degrade` — `omit | link`: what a client that cannot render this pane kind
  does. Declaring the degradation is what makes "client-agnostic or gracefully
  degrading" (pass scope 8) checkable instead of aspirational.
- The **block vocabulary itself is reserved, not specified here** — S9·5 owns
  the client contract; §2 owns the fact that a pane declares which vocabulary
  it speaks.

**Events.** `on` is validated against the engine's event-kind allowlist —
today's real kinds (`packages/core/src/events.ts`): `session_created`,
`liveness_changed`, `run_completed`, `gate_fired`, `question_asked`,
`notification_trigger`, `dispatch_refused`, `meter_alert`,
`session_adopted`, plus the E2 tree kinds (`node_created`, `node_closed`,
`session_attached_to_node`) when they land. **An unknown kind is a warning
attached to the extension record, not a parse failure** (herdr's forward-
compatible degrade, `PLUGIN_HOOK_EVENT_KINDS`): a manifest written for a
newer engine still loads, and the hook that cannot fire says so in the
listing.

`deliver = "worker"` sends the event to the supervised worker (Tier 2) or
calls the module's handler (Tier 1); `deliver = "command"` spawns argv per
event (Tier 2 only, herdr's shape) and is subject to the command-pool caps of
§2.9.

### 2.7 `capabilities` — reserved array, taxonomy owed by S9·3

```toml
capabilities = ["session.dispatch", "session.unattended", "blob.write"]
```

Reserved here with three rules and a candidate list; **S9·3 finishes the
taxonomy and owns every trust question** (grants, prompting, pinning,
preview, re-approval).

The rules, all lifted from AoE and stated now because they shape the schema:

1. **Unknown capability → reject the manifest, never silently grant**
   (`capability.rs:40`, `KNOWN_CAPABILITIES`). The failure message names the
   host's supported set and says "upgrade vimes".
2. **Static contributions need no grant.** `[[verbs]]`, `[[overlays]]`,
   `[[panes]]`, `[[events]]` are declarative and inspectable without running
   code; only *runtime resource access* is capability-gated. This split IS
   the D66 boundary expressed inside a single manifest (brief §3, synthesis 3).
3. **Trust level is host-assigned, never manifest-declared.** A manifest asks
   for capabilities; it never claims to be trusted.

Candidate strings, risk-graded per AoE's worked example (read split from
write; effects, not APIs). **This list is a starting position, not the
taxonomy:**

| Candidate | Why it is its own grant |
|---|---|
| `tree.read` / `tree.write` | reading the session tree ≠ creating/closing nodes (E2) |
| `session.read` | transcripts and stream content are the most sensitive read in the product |
| `session.send` | steering a session a human is talking to |
| `session.dispatch` | E1-d's primitive: spawn a session with a briefing and clamps |
| `session.unattended` | dispatch with **no human present** — a distinct, high-severity grant, **never implied** by `session.dispatch` (AoE's exact rule, and principle 14's fail-closed branch lives here) |
| `session.kill` | custody's destructive edge |
| `blob.read` / `blob.write` | the E1-b artifact service, per-extension namespaced |
| `overlay.write` | painting state onto engine objects other clients render |
| `ledger.read` | cost/usage windows (pillar 4: budgets are readable by anything that schedules work) |
| `notify` | attention triggers and push — the scarce resource (pillar 5) |
| `terminal.create` | a raw PTY is RCE by design (standing consequence) |
| `fs.read` / `fs.write` | filesystem outside the extension's own dirs |
| `net` | outbound network |
| `process.spawn` | OS subprocesses beyond the declared worker |
| `extension.manage` | installing/enabling other extensions — the grant that grants grants |

Two VIMES-specific notes handed forward to S9·3 rather than settled here: the
daemon holds Access-authenticated reach into every project under
`VIMES_PROJECT_ROOTS`, so these grants are not a single laptop's blast radius;
and E3's third meaning of "directory" (opt-in per-session path confinement,
agenc's `sandbox_mode` + fail-closed broker as prior art) is the reserved
field on the dispatch spec that `session.dispatch` will eventually carry.

### 2.8 Per-project activation

**Two questions, two files, deliberately.**

- **What is installed on this box** — the daemon-side registry: id, source
  provenance (repo/ref/resolved commit), the parsed-manifest cache, and the
  enabled flag. herdr's `plugins.json` shape (`src/persist/plugin_registry.rs`:
  lock file, atomic tmp+rename, corrupt registry → empty list with a warning,
  strict reads on mutation so an update cannot truncate it). D67 owns its
  trust fields.
- **What this project loads** — an in-repo declaration:

```toml
# <project>/.vimes/extensions.toml
api_version = 1

[[extension]]
id      = "vimes-tasks"
version = ">=1.2, <2"      # semver RANGE, resolved against what is installed
enabled = true

[extension.config]         # RESERVED: opaque to the engine, validated against
                           # the extension's own declared settings schema
                           # (settings declaration itself: reserved, S9·5)

# RESERVED — E3-a's `nodeConfig` hook (per-node extension loading, option
# (iii)). Named here so the shape exists; DESIGNED BY NOBODY YET. A real
# tenant pulls it into existence (first-consumer rule, D11).
# [[node]]
# id         = "…"
# extensions = ["…"]
```

**DEFAULT TAKEN** (§4.2, open question 5): activation lives in the repo, not
in the daemon registry, because a project's workflow is a property of the
project — reviewable in a diff, versioned with the code, and portable to
another box that has the same extensions installed. The trust consequence is
named rather than solved: *anyone who can commit to a project can activate an
already-installed extension there.* That is S9·3's to price (it is the same
shape as agenc's "trusted by installation", one level down).

### 2.9 State isolation, blobs, and what an extension gets handed

**Directories, per extension, host-assigned** (herdr `src/plugin_paths.rs`):

- a **config** dir (user-editable) and a **state** dir (runtime-owned), kept
  separate on purpose;
- ids encoded collision-free — percent-encoding of anything outside
  `[a-z0-9._-]`, case preserved via encoding, reserved-stem escaping, >120-char
  ids truncated with a content-hash suffix (their unit test asserts the
  collision properties; we copy the property, not the code);
- created at install and **ensured again before every invocation**;
- the extension's own install root is **not** durable state — a managed
  checkout gets replaced on update;
- **state survives uninstall.** Removing an extension removes the registry
  entry and (for a managed checkout) the code; it never deletes user data.

**No cross-extension storage API exists.** Isolation is by construction, not
by policy check — v1 has no engine-mediated "read another extension's state"
call, and adding one later is a D-record, not a convenience.

**The blob service (E1-b) is the engine-mediated alternative** for anything
that must be *shared, replayed, or rendered by a client*: content-addressed
artifacts, namespaced per extension by the engine from its id, reached with
`blob.read` / `blob.write`. The rule that keeps it honest: a state dir is for
what only the extension needs; a blob is for what the product needs (plans,
review reports, manuscripts, evaluations — the tasks extension and Book
Genesis both live on this).

**What a Tier-2 process is handed at invocation** (herdr's env model,
`.../env.rs`, names ours): `VIMES_EXTENSION_ID`, `VIMES_EXTENSION_ROOT`,
`VIMES_EXTENSION_CONFIG_DIR`, `VIMES_EXTENSION_STATE_DIR`, `VIMES_API_URL`,
`VIMES_ENV=1`, plus a per-invocation context JSON (the target object, the
project, the invoking face) and the credential that authenticates it back to
the daemon. **That credential is a hole, named not filled**: D63 (how a
local/terminal client authenticates) and S9·3 own it together; nothing here
invents a token story.

**Runtime limits for Tier 2** (herdr's numbers as the starting position, all
⟨tune⟩ under 0.2 — calibrate before pinning): stdout/stderr captured with an
explicit truncation marker, a capped concurrent-command pool, a bounded
command-log ring queryable through the API. Exit codes are **recorded, never
interpreted**.

### 2.10 Lifecycle — re-parse on use, registry as cache

herdr's property, adopted whole (`src/app/api/plugins/mod.rs`,
`refresh_installed_plugins` → `reload_manifests`): **every entry point
re-reads the manifest from disk** — listing, verb invocation, event delivery,
pane open — preserving only `enabled` and source provenance from the stored
entry. Consequences we want:

- Nothing can be stale; the world-model is rebuilt from declarations on every
  use, which is exactly the inspectability D67 needs.
- A broken manifest degrades that extension to **listed-with-warning**: it is
  visible, its problem is named, and it is not runnable. Never a blocked
  daemon start, never a silent disappearance.
- **No hot-reload machinery in v1** — none is needed for declarations, and
  Tier-1 *code* is in the daemon build, so a Tier-1 change is a deploy (with
  the recursion-hazard pre-flight CLAUDE.md already documents). Tier-2 worker
  restart-on-change is deliberately out of scope (slice-9 explicitly-out).

The asymmetry is worth stating once: **declarations are re-read per use in
both tiers; code is loaded once per daemon boot at Tier 1 and once per
worker/command spawn at Tier 2.** A Tier-1 manifest that drifts from its
compiled module is therefore possible in exactly one direction, and the
activation check ("every declared verb resolves to a registered handler")
catches it loudly at project load.

---

## §3. Worked examples — both tenants

Skeleton-level and deliberately honest: each ends with *what the manifest
alone cannot yet express*, which is the input S9·4 (the node kit) needs and
the evidence the pass's kill criterion will be judged on.

### 3.1 `vimes-tasks` — the task machine as a manifest

Names grounded in the real code: nine stages
(`packages/core/src/schemas.ts:225-233`), the dispatchable subset
(`packages/core/src/tasks/dispatchDecision.ts:47`), the shipped tools
(`packages/daemon/src/createTaskTool.ts:188`,
`packages/daemon/src/sessionHost.ts:850,874`).

```toml
id          = "vimes-tasks"
name        = "Tasks"
version     = "1.0.0"
api_version = 1
description = "Work orders, stages, dispatch, review — VIMES's first workflow."

capabilities = [
  "tree.read", "tree.write",                # worktree nodes for isolated runs
  "session.dispatch", "session.unattended", # stage runs, no human present
  "session.read", "session.kill",
  "blob.read", "blob.write",                # plans, review reports (D43)
  "overlay.write", "notify", "ledger.read",
]

[runtime]
kind = "in-process"                        # Tier 1 (builtin trust)

# ── verbs: seven, each two-faced ────────────────────────────────────────────
# (compact form: `agent`/`human` written as inline tables — same data as the
#  [verbs.agent] / [verbs.human] sub-tables of §2.1)
[[verbs]]
id     = "create_task"                     # SHIPPED today
title  = "Create task"
target = "project"
input  = "schemas/create-task.json"
agent  = { server = "vimes_board", tool = "create_task" }
human  = { command = "task new" }

[[verbs]]
id     = "promote"
title  = "Promote"
target = "task"
input  = "schemas/promote.json"
agent  = { server = "vimes_board", tool = "promote_task", offered_when = "task.stage in [plan-ready, review]" }   # offered_when RESERVED
human  = { command = "promote" }

[[verbs]]
id     = "move"
title  = "Move"
target = "task"
input  = "schemas/move.json"
agent  = { server = "vimes_board", tool = "move_task" }
human  = { command = "move" }

[[verbs]]
id     = "dispatch"
title  = "Dispatch stage run"
target = "task"
input  = "schemas/dispatch.json"
agent  = { server = "vimes_board", tool = "dispatch_task" }
human  = { command = "dispatch" }

[[verbs]]
id     = "amend"
title  = "Amend work order"
target = "task"
input  = "schemas/amend.json"
agent  = { server = "vimes_board", tool = "amend_work_order" }
human  = { command = "amend" }

[[verbs]]
id     = "report_review"                   # SHIPPED today
title  = "File review"
target = "session"
input  = "schemas/report-review.json"
agent  = { server = "vimes_report", tool = "report_review", offered_when = "session.stage == review" }   # D55
human  = { command = "review file" }

[[verbs]]
id     = "report_completion"               # SHIPPED today
title  = "Report completion"
target = "session"
input  = "schemas/report-completion.json"
agent  = { server = "vimes_report", tool = "report_completion", offered_when = "session.stage in [planning, implementing]" }
human  = { command = "complete" }

# `submit_plan` is NOT a verb: D48 captures the plan by intercepting
# ExitPlanMode (deny-and-harvest), so the payload schema is reserved and reused
# by `plan_submitted` while no tool is offered. Recorded here because an
# extension model that cannot express "an engine interception feeds my record"
# would have quietly lost it.

# ── overlays: the stage glyph the mockups' TUI shows on a session row ───────
[[overlays]]
id     = "task-stage"
target = "session"
key    = "stage"
type   = "enum"
values = ["backlog", "planning", "plan-ready", "implementing", "review",
          "done", "blocked-external", "quarantined", "cancelled"]
attention = [
  { value = "review",      rank = "attention.v1.needs-human" },
  { value = "quarantined", rank = "attention.v1.blocked" },
]

[[overlays]]
id     = "task-stage-node"        # a worktree node carries its task's stage
target = "node"
key    = "stage"
type   = "enum"
values = ["…same vocabulary…"]

# ── the board ───────────────────────────────────────────────────────────────
[[panes]]
id        = "board"
title     = "Board"
kind      = "blocks"
scope     = "project"
placement = "main"
source    = "panes/board"
degrade   = "link"

[[panes]]
id        = "work-order"
title     = "Work order"
kind      = "blocks"
scope     = "session"
placement = "context"
source    = "panes/work-order"
degrade   = "omit"

# ── events ──────────────────────────────────────────────────────────────────
[[events]]
on = "run_completed"                       # fold the outcome into the task
deliver = "worker"

[[events]]
on = "liveness_changed"                    # watchdog input (D-era watchdogStale)
deliver = "worker"

[[events]]
on = "dispatch_refused"
deliver = "worker"

[[events]]
on = "meter_alert"                         # principle 14's unattended branch
deliver = "worker"

# ── RESERVED (S9·4): work / review / hold, stage briefings, acceptance ──────
[[node-kinds]]
# work:   planning, implementing        — auto_dispatch = true
# review: review                        — acceptance = criterion-UUID rubric
# hold:   plan-ready, blocked-external, quarantined
```

**What the manifest alone cannot express (S9·4 input):**

1. **The state machine itself** — `TASK_STAGE_EDGES`, `isLegalTaskEdge`, the
   `done`/`quarantined` terminal rules. Today it is module code; the node kit
   is the declarative form, and until it exists a Tier-2 workflow extension
   cannot have a legality table the engine adjudicates.
2. **Dispatch policy** — which stages dispatch (`DISPATCHABLE_TASK_STAGES`),
   the per-task in-flight lock (D54), fresh-vs-resume (D46). The manifest
   declares a *capability* to dispatch; it cannot yet declare *when*.
3. **The exposure matrix** — `offered_when` is written above as a predicate
   string with no defined grammar (D55's per-stage offering is real and
   shipped). Reserved, and the strain is real (§4.2, question 7).
4. **`deriveReviewOutcome`** — reading the filed report to derive the verdict
   is #13's embodiment and pure extension logic; it is code in both tiers,
   and the manifest's only job is to guarantee no `approved` field can reach
   it. That guarantee §2.4 does give.
5. **Where the task record lives.** Overlays decorate; they do not store a
   work order. See §4.2, question 6 — the largest thing this draft adds.

### 3.2 `book-genesis` — the second tenant, deliberately Tier 2

Names grounded in the real repo (`~/projects/content/book-genesis`):
six phases and twelve skills (`README.md`), the orchestrator's two human
checkpoints and `STATE.yaml` shape (`agents/book-orchestrator.md`), the
7-dimension Genesis floor plus CVI-Launch/CVI-Legacy, and the writer/evaluator
context isolation that is the pipeline's core architectural claim.

```toml
id          = "book-genesis"
name        = "Book Genesis"
version     = "5.0.0"
api_version = 1
description = "Idea → publish-ready manuscript in six phases."

capabilities = [
  "tree.read", "tree.write",                # a node per book, worktree per volume
  "session.dispatch", "session.unattended", # phase 3 writes chapters unattended
  "session.read",
  "blob.read", "blob.write",                # manuscripts, evaluations, foundation
  "overlay.write", "notify",
]

[runtime]
kind    = "worker"                          # Tier 2 — external, supervised
command = ["bin/book-genesis", "--serve"]   # argv[0] extension-relative

# ── verbs ───────────────────────────────────────────────────────────────────
[[verbs]]
id     = "start_book"
title  = "Start a book"
target = "project"
input  = "schemas/start-book.json"         # idea, genre, language, word target
agent  = { server = "vimes_board", tool = "start_book" }
human  = { command = "book new" }

[[verbs]]
id     = "run_phase"
title  = "Run phase"
target = "node"
input  = "schemas/run-phase.json"          # phase: 1..6, chapters?: [n]
agent  = { server = "vimes_board", tool = "run_book_phase" }
human  = { command = "book phase" }

[[verbs]]
id     = "evaluate"
title  = "Evaluate"
target = "node"
input  = "schemas/evaluate.json"           # chapter range
agent  = { server = "vimes_report", tool = "evaluate_chapters", offered_when = "session.role == evaluator" }
human  = { command = "book evaluate" }

[[verbs]]
id     = "revise"
title  = "Revise"
target = "node"
input  = "schemas/revise.json"
agent  = { server = "vimes_board", tool = "revise_chapters" }
human  = { command = "book revise" }

[[verbs]]
id     = "deliver"
title  = "Deliver"
target = "node"
input  = "schemas/deliver.json"
agent  = { server = "vimes_board", tool = "deliver_book" }
human  = { command = "book deliver" }

# NOTE — there is no `approve_foundation` verb, on purpose. Both of the
# pipeline's human checkpoints (after phase 2, after phase 4) are ENGINE GATES:
# the extension proposes "hold here"; the human's answer arrives as the gate's
# own decision, which the engine records. A verb taking `approved = true` would
# be principle 13's exact violation, and §2.4's parse rule refuses it.

# ── overlays ────────────────────────────────────────────────────────────────
[[overlays]]
id     = "phase"
target = "node"
key    = "phase"
type   = "enum"
values = ["research", "foundation", "write", "evaluate", "revise", "deliver"]
attention = [
  { value = "foundation", rank = "attention.v1.needs-human" },  # checkpoint 1
  { value = "evaluate",   rank = "attention.v1.needs-human" },  # checkpoint 2
]

[[overlays]]
id     = "chapter-status"
target = "session"
key    = "chapter"
type   = "enum"
values = ["draft", "evaluated", "revised", "final"]

[[overlays]]
id     = "genesis-floor"                    # the WEAKEST of seven dimensions
target = "node"
key    = "floor"
type   = "scalar"
format = "0.0"                              # 0.0–10.0
bands  = [ { below = 7.0, rank = "attention.v1.needs-human" } ]

# ── panes ───────────────────────────────────────────────────────────────────
[[panes]]
id        = "manuscript"
title     = "Manuscript"
kind      = "blocks"
scope     = "node"
placement = "main"
source    = "panes/manuscript"
degrade   = "link"

[[panes]]
id        = "genesis-score"
title     = "Genesis Score"
kind      = "blocks"
scope     = "node"
placement = "context"
source    = "panes/score"
degrade   = "omit"

# ── events ──────────────────────────────────────────────────────────────────
[[events]]
on = "run_completed"                       # a chapter or skill run finished
deliver = "worker"

[[events]]
on = "gate_fired"                          # a checkpoint reached the human
deliver = "worker"

[[events]]
on = "session_created"
deliver = "worker"

# ── RESERVED (S9·4): the shape this tenant most needs ───────────────────────
[[node-kinds]]
# work   → chapter write (performer: prose-craft; inputs ALLOW-LISTED)
# review → beta-reader evaluation (performer runs in a FRESH context)
# hold   → checkpoint 1 / checkpoint 2 (human answer required)
```

**What the manifest alone cannot express (S9·4 input) — and this list is the
more interesting of the two:**

1. **Briefing DENIAL, not just briefing composition.** The pipeline's central
   claim is that the writer must never see the scoring rubric and the
   evaluator must never see the writing instructions. A node kit that
   declares "what a performer is given" is not enough; this tenant needs
   "what a performer is *withheld*", and it needs it to be as inspectable as
   a capability grant. Nothing in today's task machine has an analogue.
2. **Bounded loops.** *Max 2 revision cycles, then the problem is structural
   — go back to the foundation.* A counted loop with a declared structural
   fallback is a first-class need here; the task machine's review→implementing
   edge is unbounded by comparison.
3. **Scalar acceptance.** Acceptance is "floor ≥ threshold on the weakest of
   seven dimensions, each with a textual citation, with a −0.8 calibration
   and a +0.5-per-cycle improvement cap." The task machine's acceptance is a
   criterion-UUID rubric with pass/fail. Both are acceptance shapes; the node
   kit must carry both or it has been designed for one tenant.
4. **Phase-internal sequencing.** Phase 2 runs three skills in a fixed order
   with data dependencies (personas → foundation → voice DNA). The manifest
   has verbs and nodes; it has no dependency vocabulary.
5. **Optional performers.** entity-tracker / continuity-guardian /
   series-architect run "when needed, not every project" — a conditional node,
   which is `offered_when`'s sibling problem one level up.

Points 1–3 are the honest answer to "can the abstraction host both tenants":
*not yet, and here is exactly what is missing.* None of them requires a
tenant-specific carve-out in the **engine** — they are all node-kit
vocabulary — which is why this reads as work for S9·4 rather than a kill.

---

## §4. Closing

### 4.1 What this reserves vs what this builds

**Builds: nothing.** Rule 0.5 framing, explicitly:

- **Reserved (data shapes, landed now):** the manifest file name and its
  section taxonomy; identity + version + `api_version` semantics; the
  `[runtime]` kinds; the `capabilities` array and its three rules; the
  `[[verbs]]` two-face shape and its #13 parse rules; `[[overlays]]` with
  enum and scalar types plus declared attention ranks; `[[panes]]` with the
  blocks/pty split and placement/degradation vocabulary; `[[events]]` with
  allowlist-plus-warning; the `[[node-kinds]]` section *name and table slot*;
  the project declaration file with version ranges and the `nodeConfig` hook;
  the per-extension config/state/blob isolation model; the re-parse-on-use
  lifecycle.
- **Deferred by design:** the capability taxonomy's final list, grants,
  preview, pinning and re-approval (S9·3 / D67); the node-kit contents
  (S9·4); the block vocabulary and per-client rendering (S9·5); the migration
  sequencing (S9·5); Tier-2 credentials (D63 + S9·3); marketplace anything
  (pass explicitly-out).
- **Not built, and not to be built until the pass signs:** any parser, any
  loader, any registry, any host. The first line of implementation code is a
  slice-10 question.

The reservation earns its place the same way D11 does: data shapes land now
because retrofitting them is expensive; machinery waits for its first
consumer.

### 4.2 Open questions raised by this draft

Each carries the default this draft took, so the document is internally
consistent; each needs Wes (or a later unit) to confirm or overturn.

1. **May a Tier-2 extension define a projection?** The draft says no —
   in-line reducers are Tier 1 only, Tier 2 subscribes. That is an admitted
   vocabulary asymmetry against Tier-2 completeness (§1.1) and therefore
   against #15. **DEFAULT TAKEN:** no, with the asymmetry named. The
   alternative — an engine-hosted declarative projection (a fold declared in
   the manifest, executed by the engine) — is a real design, and it belongs
   to whoever first needs it.
2. **What exactly does a Tier-1 module import?** **DEFAULT TAKEN:** a
   declared extension-host interface mirroring the public API plus projection
   registration — never `@vimes/core` internals ad hoc. Without this, Tier 1
   has no boundary and #15 erodes silently.
3. **Who enforces a verb's `target`?** **DEFAULT TAKEN:** the engine, at
   invocation (clients may also use it for offering). herdr's `contexts` is
   offered-not-enforced and the brief flagged the choice as ours.
4. **Scalar overlays.** **DEFAULT TAKEN:** `type = "scalar"` with `format`
   and banded attention mapping, because tenant 2 needs it. It extends E2-b's
   "declared severity" rule from values to bands — an extension of a settled
   element, flagged rather than assumed.
5. **Where does per-project activation live?** **DEFAULT TAKEN:**
   in-repo `<project>/.vimes/extensions.toml`, with the daemon registry
   holding the installed set. Consequence handed to S9·3: commit access to a
   project becomes activation authority there.
6. **⚠ Where does an extension's own RECORD live?** The largest gap this
   draft found. Overlays decorate an engine object with one value; they
   cannot hold a work order, a chapter's score history, or a task's audit
   trail. Options: (a) an engine **extension-record store** — namespaced
   spine events (`ext.<id>.*`) whose payload schema the manifest declares,
   which the engine validates for *shape, authority and ordering* while never
   interpreting *meaning*, projected generically and subscribable by clients;
   or (b) each extension keeps its own store in its state dir, in which case
   the record is not replayable, not subscribable, and no client can render
   it without a bespoke round trip. **DEFAULT TAKEN: (a)** — it is the only
   option under which Book Genesis's board is renderable by an engine client
   at all. This is an **addendum candidate to E4's list** (a ninth item), not
   a contradiction of any E-settlement, and it should be walked with Wes
   explicitly because it decides how much engine the extension model implies.
7. **`offered_when` predicate grammar.** D55's per-stage tool offering is
   shipped behavior with no declarative form. **DEFAULT TAKEN:** reserve the
   field as an opaque string in api_version 1 and hand the grammar to S9·4
   (it is the same question as node-kind conditions). Strained: a predicate
   over *extension* state that the *engine* must evaluate to decide what to
   mount is exactly the kind of thing that grows into a language.
8. **Do engine event kinds constitute stable API?** `[[events]]` names
   internal event kinds. **DEFAULT TAKEN:** the allowlist is versioned with
   `api_version`, unknown kinds warn, and renaming a kind is a vocabulary
   bump — but this makes the spine's internal names into a public contract,
   which deserves a conscious yes. This draft's own near-miss is the evidence:
   an earlier revision subscribed to `meter_threshold_crossed`, a kind that is
   RETAINED for historical validation but **deprecated with zero producers**
   (`packages/core/src/events.ts:66-78` — "DO NOT EMIT IT. Emit `meterAlert`
   instead"), so the subscription would have waited forever — which means the
   allowlist must carry deprecation state and **warn on a deprecated kind
   exactly as it warns on an unknown one**, or the versioning story ships the
   silent failure it exists to prevent.

*(A ninth, noted without a default because it is squarely S9·3's: nothing
here says how a Tier-2 process authenticates back to the daemon. The env
model reserves the slot; D63 and the trust unit fill it.)*
