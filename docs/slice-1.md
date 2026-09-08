# Ranks slice 1 — the loop, headless, on one real task

**STATUS: SKELETON rev 1 — 2026-09-08, awaiting ⟨Wes⟩'s sign (and Sol's
rounds if he runs them; expect redpens — that is the process working).
Nothing dispatched. Rides D1 in the same push as the slice-20 merge.**

The first Ranks slice and the MVP line (design-principles #7). It does
not build the product in the founding note; it takes the loop Vimes
already runs — planning → implementing → review, declaration-driven since
V-S20 — strips everything that is not the loop, adds the two contract
pieces the note's room needs and Vimes never had (a path-scoped **grant**
and **`command`** acceptance), seats the **performer** seam D1 ruling 4
requires, and puts the whole thing under ⟨Wes⟩'s hands for one real task.
The exit gate is that task. Every later slice is earned by a real run's
pull, not by this plan.

## §0. Recon (2026-09-08, orchestrator-verified at `f1f4fd4` + the docs archive move)

1. **The loop exists and is declaration-driven.** The shipped manifest
   `packages/daemon/extensions/vimes-tasks/vimes-extension.toml` declares
   the `software` workflow (`[[workflows]]` :208; nodes :258–; per-node
   `[workflows.nodes.briefing]` :266/:283 and `[workflows.nodes.acceptance]`
   :271/:288 — planning `artifact`, implementing `report`, review `rubric`
   per the V-S20 recon). It is parsed ONCE at boot (`app.ts:449`
   `loadShippedWorkflow`) and the same object is handed to the writer,
   the API, preflight, and the dispatcher (`:584/:639/:689` — V-F2's
   one-boot-declaration law). Outcome routing is `evaluateAcceptance`
   (`packages/core/src/extensions/acceptance.ts:128`, pure/total,
   exhaustive over five kinds) through `acceptanceRouting.ts` into
   `instanceWriter.proposeMove` (V-I7's single choke point).
2. **Fresh session per attempt already holds** (V-D46 is the dispatcher's
   behaviour); attempt identity rides `report_filed` / `capture_recorded`
   (`packages/core/src/events.ts:406–407`).
3. **The report door is one seam, and half-observed.** Report tools are
   mounted as SDK MCP servers in exactly one place —
   `sessionHost.ts:2141–2220` `buildReportMcpServers`, the only touch of
   the SDK's `tool`/`createSdkMcpServer` — with zod payload schemas in
   `packages/core/src/schemas.ts:271` (review) / `:301` (completion).
   **Unobserved:** what happens to a schema-invalid report call (SDK
   refusal before the handler? model retry?) — risk-register row 2,
   SP1·1(b).
4. **The permission seam exists; path scoping does not.** `canUseTool`
   (`sessionHost.ts:167/:726/:2244`) fires for built-in tools (observed
   V-D48/V-S7·0); MCP tools bypass it (observed, `:1900`). Dispatched
   sessions run a CLOSED tool allowlist plus a sub-agent spawn denylist
   (`DISPATCHED_SESSION_TOOLS` / `SUBAGENT_SPAWN_TOOLS`, `:737`, V-D50).
   **No grant of any shape exists in the manifest** — the only node
   tables are `briefing` (keys `composer/inputs/tools/capture/
   permission_mode`, `manifest.ts:1572`) and `acceptance`; `by` and
   `max_traversals` live on EDGES (`manifest.ts:2025–2101`).
5. **No performer field exists.** Grep of `manifest.ts` for
   `model`/`effort`/`performer`: none. Model selection is compiled into
   the adapter/dispatcher, never declared or varied per node.
6. **No operator surface survives the cut.** `packages/daemon/src/cli.ts`
   is the harness CLI (`scenarios`/`replay`, `:172–192`); no package
   declares a `bin`; no stdio MCP server exists (grep
   `StdioServerTransport`: none). Task creation today is
   `POST /api/instances` (`instanceApi.ts:958`) + `/dispatch` (`:994`),
   driven by the UI or by a daemon-spawned orchestrator session
   (`orchestratorApi.ts` + `createTaskTool.ts`). **"Layer on Claude Code"
   therefore starts as a thin CLI over the existing HTTP API**
   (design-principles #11/#15), not as an MCP bridge — the bridge waits
   for a pull.
7. **Acceptance kinds are five** (rubric / scalar / human-gate / artifact
   / report); **`command` does not exist.** Under rule 0.5 it is a shape
   plus a pure evidence field; execution is the daemon's.
8. **Sizes** (non-test source lines): core 19,251 · daemon 23,368 · ui
   19,133 · ext-tasks 774 · ext-host 16. The UI is 30% of the tree with
   zero role in this slice. `scripts/ci-gate.sh` builds it
   (`npm run build -w @vimes/ui`, `vue-tsc`, `check-build-manifest`) —
   those steps leave with it, and with them the "ci-gate is a partial
   deploy" hazard.
9. **A room's workspace exists.** A dispatched attempt already runs in a
   worktree checkout (`checkoutCoordinator.ts` 978 lines +
   `gitAdapter.ts` 919, V-S17/E2-c). The grant's `write` scope is relative
   to it.
10. **Differential guards to keep green through the cut** (D1 rider c):
    the V-S19 host differential (`briefingDeclarations`), the V-S20
    `acceptanceRouting.differential.test.ts` (26 tests, frozen image),
    the V-S18 stem test, and the `tenantBoundary` grep gate.
11. **Transcripts of attempts are retrievable today only as CLI-written
    JSONL** under `~/.claude/projects/<slug>/` — the pillar-1 forensics
    exception ("nothing to watch, everything inspectable after") needs a
    stored reference per attempt. SP1·1(c) measures whether the SDK
    channel exposes the path reliably (the archive's slug-drift row says
    computing it is fragile).

## §1. Scope

Build order: **S1·0 → SP1·1 → Gate-D → S1·1 → S1·2 → S1·3 → S1·4 (the
gate) → S1·5.** One agent at a time; the orchestrator gates each.

- **S1·0 — the cut, first order.** Delete `packages/ui` and the daemon
  surfaces that have no importer once the UI and the PTY channel are gone.
  Bounded by a rule, not a list: *delete only what nothing on the dispatch
  path imports; refactor nothing.* Candidates the recon names (the agent
  confirms each by importer grep before deleting): `terminalHost.ts`,
  `tailer.ts` + `transcriptPaths.ts` (PTY tailing), `pushService.ts` /
  `pushPipeline.ts` / `pushSubscriptions.ts` / `meterAlerts.ts`,
  `fileApi.ts`, `search.ts`, the static-file serving in `app.ts`
  (`readStaticFile`, `VIMES_STATIC_DIR`), the UI steps in `ci-gate.sh`,
  `node-pty` from the dependency tree. **Kept unexamined until S1·5:**
  `wsHub.ts`, `auth.ts`, `orchestratorApi.ts`, the usage/cost stack,
  `hookIngress.ts`. The tree typechecks, every surviving suite is green,
  the scenario gate is byte-identical ×2, the differential guards are
  unmoved.
- **SP1·1 — the spike (verify-rows, data not code).** Four observations
  on the current SDK + vendored CLI, versions recorded: **(a)**
  path-scoped denial through `canUseTool` for `Read/Edit/Write/Bash` and
  what `Glob/Grep` expose; **(b)** a schema-invalid report at the door
  (three malformed shapes) and the model's next turn; **(c)** whether an
  attempt's transcript path is exposed on the SDK channel; **(d)**
  per-query `model`/effort honoured or not. Deliverable: the four
  risk-register rows filled, `calibration.md` §Spike results.
- **⟸ Gate-D pause.** ⟨Wes⟩ prices `retry_bound` (Q10) and the grant
  default (§3.1) against SP1·1, and names the real task (S1·4) so the
  shipped manifest's slice-1 grants can be written for it.
- **S1·1 — the contract (core, pure).** The three declaration shapes
  (§3.1–3.3) parsed with refusals; the `Performer` interface and
  harness-capability table (§3.4–3.5); `command` in `evaluateAcceptance`;
  the harness-aware grant-check. No daemon change.
- **S1·2 — enforcement (daemon).** Grant enforcement in the SDK adapter's
  `canUseTool`, fail-closed, `grant_refused` recorded (§3.6); `command`
  acceptance executed in the attempt's checkout with exit codes handed to
  the evaluator; schema rejection as `report_rejected` feeding a fresh
  attempt with the error appended to the brief, bounded (§3.7); the
  transcript reference stored per attempt if SP1·1(c) allows.
- **S1·3 — the operator surface (daemon, mechanical).** A `bin` in the
  daemon package — working name `ranks` — as a thin client of the
  existing HTTP API: `task new` (brief file + criteria → `POST
  /api/instances` + `/dispatch`), `status`, `show <instance>` (reports,
  verdicts, rejections, attempt transcript refs, as text), `halt`. No
  new API routes unless the CLI proves one missing.
- **S1·4 — the real task (the gate).** ⟨Wes⟩ runs the task he named at
  Gate-D through implementing → review → verdict, entering only to author
  the brief and criteria and to read the verdict. The orchestrator is
  Fable in a plain Claude Code session (full read — Q1 is not forced).
- **S1·5 — the second prune (after the gate passes).** Delete what S1·0
  kept and the real run did not use; price `auth.ts` and `wsHub.ts` on
  evidence. Also mechanical.

## §2. Explicitly out

The canvas and any UI; an orchestrator room or product-mounted
orchestrator grant (Q1); `transform` rooms (Q3); fan-out/join (Q2); Codex
or OpenRouter IN (shapes and the capability table only — Q9); the
`node`→`room` rename (Q8); a `human` room kind (the existing `human-gate`
acceptance kind stays dormant); brief-schema typing beyond the existing
work-order shape (edges as a type system wait for a second room kind);
push and attention; auto-dispatch (`by`) as a per-declaration move (D1
rider a); an MCP stdio bridge for external Claude Code sessions (waits
for a pull); any change to edge legality or the shipped workflow's
topology.

## §3. Design decisions (in-mandate; ⟨Wes⟩ signs at rev sign-off)

3.1 **Grant shape.** A per-node table:

```toml
[workflows.nodes.grant]
read  = ["src/**", "docs/**"]      # globs, relative to the attempt's checkout
write = ["src/auth/**"]
exec  = [["npm", "test"], ["git", "diff"]]   # argv-prefix allowlist
```

Parse refusals: non-glob/absolute/`..` paths (`grant-path-escapes`);
empty `exec` entries; unknown keys. **Absent grant = today's behaviour**
(closed tool allowlist, unscoped paths) — unset-means-status-quo, not
unset-means-deny, because flipping every existing node to deny is a
behaviour change with no run behind it. The shipped manifest's
implementing node gets an explicit grant for the real task at Gate-D.
The flip to deny-by-default is a later slice's decision, made from
evidence.

3.2 **Performer shape.** `[workflows.nodes.performer] harness = "claude-code"
model = "…" effort = "…"`. `harness` is a closed vocabulary read from the
capability table (§3.5): `claude-code` (available), `codex`, `native`
(declared, **not available**). A node naming an unavailable harness is
**refused at parse** (`performer-harness-unavailable`) — unlike V-S20's
dormant acceptance kinds, an unrunnable performer is a guaranteed runtime
failure, so it fails at the door. Absent performer = compiled defaults
(status quo). `model`/`effort` pass through the adapter only; a field
the harness cannot set (SP1·1(d)) is a parse refusal for that harness,
never a silent default.

3.3 **`command` acceptance.** Sixth kind:

```toml
[workflows.nodes.acceptance]
kind = "command"
criteria = [{ id = "tests", run = ["npm", "test"] }, { id = "lint", run = ["npm", "run", "lint"] }]
on_pass = "done"
on_fail = "implementing"
```

The evaluator's evidence gains `commandExits: Record<criterionId, number>`;
every declared id present and zero → `route(on_pass)`; any non-zero →
`route(on_fail)`; any declared id missing → `unevaluable` (reason
`command-not-run`). Pure — the daemon runs the commands in the attempt's
checkout and hands in exit codes. `on_pass`/`on_fail` obey the existing
ghost-target refusal; unset `on_fail` means rest (V-S20 §3.4 carries).

3.4 **The `Performer` interface (core, types only).**

```ts
interface Performer {
  readonly harness: HarnessId;
  run(input: { brief: Brief; grant: ParsedGrant; report: ReportContract }):
    Promise<
      | { kind: 'report'; report: unknown; usage: Usage; transcriptRef?: string }
      | { kind: 'rejected'; validationError: ReportValidationError; usage: Usage; transcriptRef?: string }
      | { kind: 'blocked'; reason: string; usage: Usage; transcriptRef?: string }
    >;
}
```

The daemon's SDK adapter implements it for `claude-code`. Nothing in
core imports an SDK; nothing above the adapter branches on `harness`.

3.5 **Harness-capability table** (core, data): per harness — `available`,
`grant.read` / `grant.write` (`path-scoped` | `none`), `grant.exec`
(`allowlist` | `none`), `performer.model` / `performer.effort`
(`settable` | `fixed`). Slice 1 fills the `claude-code` row from SP1·1
and marks `codex`/`native` unavailable with every capability `unknown`.
The **grant-check** refuses a node whose grant or performer needs a
capability its harness lacks, naming the gap
(`grant-unenforceable-on-harness`).

3.6 **Enforcement is fail-closed and recorded.** In `canUseTool`: a
built-in tool whose path input resolves outside `read`/`write` (per the
tool's mode) or whose argv is not prefixed by an `exec` entry is denied
with a structured reason; a path that cannot be resolved is denied; every
denial is a `grant_refused` event `{instance, node, attempt, tool,
reason}`. Report MCP tools are unaffected (they bypass the seam — observed
— and are the room's door, not its walls). The honest limit (Q4) is
stated in the manifest docs: the wall is authority, not knowledge.

3.7 **Rejection ≠ failure, structurally.** A report failing its schema
emits `report_rejected` `{instance, node, attempt, validationError}` and
schedules a fresh attempt whose brief carries the error verbatim as a
delta, up to `retry_bound` (node field, ⟨tune⟩ v0 = 2, Q10). Exhausting
`retry_bound` is terminal failure for the node (`attention: failed`,
pillar 6). This is distinct from edge exhaustion (`max_traversals`,
routing) and both are asserted distinct (A4).

3.8 **No vocabulary change.** `node`, `instance`, `attempt`, `report`,
`verdict` — the code's words stay (D1 ruling 6). "Room" appears in docs
only.

## §4. Assertions

Code assertions (rule 0.4 binds the code; they are not the slice's gate):

- **A1 (parse).** Each new shape parses on the shipped manifest unchanged
  (byte-identical `ParsedWorkflow` for nodes that declare none — the
  V-S19/V-S20 differential idiom); each refusal code fires on its
  malformed control **and the generic/wrong codes are asserted absent**
  on the same input; a negative control proves the general rule still
  fires on a genuine case. Unavailable harness refused; grant exceeding
  capability refused with the gap named.
- **A2 (evaluator).** `command` is exhaustive (pass / fail / missing →
  unevaluable); the five existing kinds are byte-unchanged (the V-S20
  frozen-image differential stays green untouched).
- **A3 (enforcement, injected fake SDK).** Outside-grant `Read` denied +
  `grant_refused` emitted; inside allowed with no event; `Bash` argv not
  in `exec` denied; report tools unaffected; unresolvable path denied.
  Sabotage-verified: hard-code the grant and confirm the right test
  reddens.
- **A4 (rejection).** Schema-invalid report → `report_rejected` + a fresh
  attempt whose brief contains the error; `retry_bound` respected;
  reaching it is terminal, not a routing move — asserted by checking that
  no `proposeMove` occurred **and** that the edge-exhaustion path did
  not fire.
- **A5 (performer-blindness).** `packages/core` contains no
  `@anthropic-ai` import (extend the tenant-boundary grep gate); nothing
  outside the SDK adapter reads `performer.harness`.
- **A6 (the cut).** After S1·0 and again after S1·5: typecheck green,
  every surviving suite green, scenario gate byte-identical ×2, the four
  differential guards unmoved, `ci-gate.sh` exits 0 with the UI steps
  removed.
- **A7 (the gate — human).** §6.

## §5. Units

| Unit | Model | Deliverable | Orchestrator gate |
|---|---|---|---|
| S1·0 cut | sonnet | deletion inventory (file → importer proof → deleted/kept) + the commit-ready tree | A6; diff read; inventory checked against §1's kept list |
| SP1·1 spike | opus | four observations with versions, as risk-register + calibration text; no code merged | rows filled by observation, not docs; kill: a needed capability absent on Claude Code → finding |
| Gate-D | ⟨Wes⟩ | `retry_bound`, grant default, the real task named, the implementing node's grant written | — |
| S1·1 contract | opus | shapes + refusals + capability table + `command` arm + `Performer` type | A1, A2, A5; sabotage |
| S1·2 enforcement | opus | `canUseTool` grant, `command` execution, `report_rejected` loop, transcript ref | A3, A4; sabotage; differentials unmoved |
| S1·3 CLI | sonnet | `ranks` bin over the existing API | typecheck; a scripted run against a fake daemon |
| S1·4 real task | ⟨Wes⟩ | the verdict, and his answer to §6 | — |
| S1·5 prune | sonnet | second inventory | A6 |

Every agent keeps a checkpoint file in the session scratchpad; agents
never run ci-gate, commit, push, or restart the service; fixes go to a
new agent.

## §6. Exit gate and kill criterion

**Exit gate — human, and the only one.** ⟨Wes⟩ ran a real task (named at
Gate-D; something he would otherwise have opened plain Claude Code for
that week) through the loop, touched it only to author the brief and
criteria and to read the verdict, and answers yes to: *would you use it
again tomorrow?* No machine gate at the slice level.

**Kill criterion.** ⟨Wes⟩ reached for plain Claude Code mid-task to
finish the work. The slice halts, a decision record says why, and the
question of whether the loop is the product either is answered in a
week rather than four months (D1 ruling 2).

**Findings that halt (0.1):** SP1·1 shows a grant cannot be enforced
through `canUseTool` on the current build; a schema-invalid report is
swallowed silently by the SDK; the cut cannot be bounded without
refactoring (the kept list grows past §1's) — each earns a record
before work continues.

## §7. Deploy

`packages/daemon` and `packages/core` both change, so every unit from
S1·0 on requires a daemon restart under the standing dev-phase clearance
(V-D memory, 2026-08-12). The ancestry check (Vimes CLAUDE.md, the
recursion hazard) applies until S1·0 removes the possibility of a Claude
Code session running *inside* the daemon — after which the only sessions
the daemon parents are rooms, and a restart mid-attempt is the room
failing terminally, which the event spine records.
