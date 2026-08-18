# Spike S7·0 — plan-mode A/B characterization (D44) — FINDINGS

**Kind:** SPIKE (data + fixture, no production code). **Date:** 2026-07-25.
**Confidence overall:** high for (a)/(b)/(c)/(d) core answers; single-run for the
model-behavior edges (noted per item).

## Environment (as run)

- SDK: `@anthropic-ai/claude-agent-sdk` **0.3.207** (resolved from
  `packages/daemon/node_modules`; declared `^0.3`). Same package the daemon
  dynamically imports at `sessionHost.ts:1212`.
- CLI on PATH: `claude` **2.1.220**. Transcript `version` field stamped
  **2.1.207** (minor stamp/binary skew — noted below).
- Node **v24.18.0** (nvm 24). Auth: OAuth `max` subscription in
  `~/.claude/.credentials.json`; no `ANTHROPIC_API_KEY`. Live sessions succeeded.
- Probe: `scratchpad/spike-s7-0/probe.mjs` — real `query()` calls, `canUseTool`
  logs+decides, every stream message dumped as `MSG:` lines. Two bounded runs
  (~14s plan, ~6s default). Model served: `claude-opus-4-8[1m]`.
- Isolation: ran under throwaway cwds `scratchpad/spike-s7-0/work-{plan,default}`;
  `node_modules` symlinked into scratch dir for ESM resolution. **prod
  `vimes.service` never touched.**

Raw logs: `scratchpad/spike-s7-0/logs/{a-plan-deny,contrast-default-allow}.log`.

---

## (a) Does plan-mode write-blocking hold in a SPAWNED SDK session? — YES (with one caveat)

**Answer:** Yes. Spawning `query()` with `options.permissionMode:'plan'` makes the
spawned session refuse to perform the *user's work write*. Given "create note.txt
… containing hello", the plan-mode session **never wrote note.txt to the cwd** —
it drafted a plan and routed to `ExitPlanMode` instead. The identical prompt in
`permissionMode:'default'` (contrast run) went straight to a `Write` tool_use and
produced `work-default/note.txt` = `hello`. So the write is suppressed **by mode**,
not by a `canUseTool` deny.

**Evidence:**
- plan run: 0 `Write`/`Edit` gate calls for user work; the only `canUseTool`
  invocation was `ExitPlanMode`. `ls work-plan/` → empty.
- default run: `GATE:{"toolName":"Write","toolInput":{"file_path":".../work-default/note.txt","content":"hello"}}`, file written.

**CAVEAT (flag for design):** plan mode is **not a hard read-only jail.** The
plan-mode session performed a **`Write` to `~/.claude/plans/…​.md`
(the plan-draft file) that was NOT gated** — `canUseTool` never fired for it, and
the file really landed on disk (confirmed, then cleaned up). So a VIMES-spawned
plan session can write into the operator's **global** `~/.claude/plans/`
directory without passing the gate. This is CLI plan-mechanism behavior, outside
the project root (D21). It doesn't touch the project, but it is an ungated
filesystem side effect worth a risk-register line if we adopt native plan mode.

**Also confirmed** (matches the note already in `sessionHost.ts:1227`):
under `permissionMode:'plan'`, `canUseTool` fires **only** for `ExitPlanMode`,
not for read/other tools. `canUseTool` "fires only under default" is directionally
right; more precisely, in plan mode the gate is consulted for the plan-exit
boundary and not for the ungated plan-draft write.

---

## (b) Does ExitPlanMode fire reliably headless, and is the payload stable? — YES; payload is a single inline markdown string (+ a local path field)

**Answer:** Yes. `ExitPlanMode` fires in headless/SDK mode and reaches
`canUseTool`. Its tool input is:

```json
{ "plan": "<full markdown plan, inline>", "planFilePath": "/home/…/.claude/plans/<slug>.md" }
```

- `plan` — the entire plan as one UTF-8 markdown string (headings, bullets).
  This is the payload of record.
- `planFilePath` — an **absolute path to the on-disk plan draft in the
  operator's global `~/.claude/plans/`** (machine-specific, outside the project).

**SHAPE DRIFT NOTE (rule 0.6):** older/other CLI builds emitted `ExitPlanMode`
with **only** `{plan}`. This build (2.1.220 / transcript-stamped 2.1.207) adds
`planFilePath`. Adapters MUST treat `planFilePath` as optional and MUST NOT
depend on it (it's a local path leak, not portable). Consume `input.plan` only.
Recommend a risk-register entry: "ExitPlanMode input shape carries extra
`planFilePath` as of CLI 2.1.x; may add/remove fields — pin to `plan`."

**FIXTURED** → `scratchpad/spike-s7-0-exitplanmode.jsonl` (2 verbatim records):
1. the **on-disk transcript** assistant `tool_use` line (the shape the daemon
   reads via `transcriptPaths.ts`; carries `version`, `cwd`, `slug`, `sessionId`…);
2. the **SDK stream-message** assistant `tool_use` line (the shape
   `SdkAdapter.consumeSdk` sees live). Both show `input` keys `["plan","planFilePath"]`.

The plan content is *also* available in two other places if needed: the raw
`canUseTool` argument, and the terminal `result` record's `permission_denials[]`
array (full `tool_input` echoed back on deny).

Minor harness note: in THIS spike's tool config `ExitPlanMode` was a *deferred*
tool, so the model did a `ToolSearch select:ExitPlanMode` first. That is an
artifact of this session's tool set, not the daemon's; the SDK-spawned daemon
child gets `ExitPlanMode` directly. It doesn't change the emitted payload.

---

## (c) Can the adapter stop cleanly at plan emission? — YES, cleanly

**Answer:** Yes. Denying `ExitPlanMode` from `canUseTool`
(`{behavior:'deny', message:…}`) stops the session at the plan boundary
**without any hang, error, or dirty teardown.** Sequence observed:

1. model emits `ExitPlanMode` → `canUseTool` returns deny;
2. SDK feeds the model a `tool_result` with `is_error:true`
   (`"VIMES stops at plan boundary"`);
3. model emits one short wrap-up text turn ("plan boundary is blocking approval…");
4. the query yields a terminal `result` record: `subtype:"success"`,
   `is_error:false`, `terminal_reason:"completed"`, `num_turns:4`,
   `permission_denials:[{tool_name:"ExitPlanMode", …}]`; the async generator
   then completes normally (`DONE` printed, subprocess exited).

No orphaned `claude` children were left (verified `ps`; the long-lived `claude`
procs on the box predate the spike by days and were left untouched).

So VIMES can end at the plan boundary just by **denying ExitPlanMode** — the SDK
does not fight it; it treats the denial as a normal permission denial and closes
out with a success result. (`sdkHandle.close()` / closing the input queue is an
even harder stop if wanted, but is not required — deny alone is clean.)

*Confidence:* the clean-teardown mechanics are solid (deterministic SDK path).
The model gracefully giving up after one denial is single-run; a stubborn model
could retry ExitPlanMode or attempt a Write — but retries would simply hit the
same deny (and Writes hit the same plan-mode suppression), so the **stop remains
enforced** regardless of model persistence. Worst case is a couple of extra
denied turns before `result`, not a hang.

---

## (d) Does the plan payload map LOSSLESSLY into `submit_plan`? — YES, trivially

**Answer:** Yes. The plan is a single markdown string (`input.plan`). Mapping to
the reserved by-reference `submit_plan` shape is:

```
planContent  = exitPlanMode.input.plan          // UTF-8 markdown, verbatim
planArtifactHash = hash(planContent)            // store blob → hash → submit_plan
// identity (sessionId, cwd, slug, timestamp) available from the transcript record
```

No structural transform is needed — there are no nested/structured plan
sub-fields to flatten; it is prose+markdown in one field. **Losslessness holds
as long as the artifact stores the exact bytes** of `input.plan` (preserve the
trailing newline; it is UTF-8; markdown, not JSON). The only field to
deliberately **drop** is `planFilePath` (machine-local, non-portable — do not
propagate into the artifact or submit_plan).

So the adapter needs a thin normalization step, not a transform: take
`input.plan`, drop `planFilePath`, hash, attach identity. Confidence: high.

---

## RECOMMENDATION for S7·5

**Use native plan mode for BOTH read-only hardening AND plan capture — but keep
plain-prompt + `submit_plan` as the declared fallback (D44).** Rationale:

1. **Read-only hardening (a):** `permissionMode:'plan'` gives free suppression of
   user-work writes *by mode* in a spawned session — no reliance on `canUseTool`
   trust. Adopt it for the planning stage. **BUT** register the caveat: plan mode
   permits an **ungated write to `~/.claude/plans/`** (outside the project root).
   If that side effect is unacceptable, either accept it (it's the operator's own
   global dir, harmless, cleaned automatically enough) or point `HOME`/plans dir
   at a throwaway for plan sessions. Risk-register line, Wes's call.

2. **Plan capture (b/d):** `ExitPlanMode` fires reliably headless and its `plan`
   string maps losslessly into `submit_plan` via hash. Capture from
   `canUseTool`'s argument (earliest, most reliable) — don't wait to re-parse the
   transcript. Fixture is banked so S7·5 needn't re-run a live session.

3. **Clean stop (c):** deny `ExitPlanMode` in `canUseTool` to end the session at
   the plan boundary; the SDK closes out with `result:success`, no hang. This is
   the mechanism that makes native plan mode *usable* for the "plan crosses, a
   fresh implementer does the work" model (D46). It was the real trouble spot and
   it came back clean.

**Two risk-register items (rule 0.6):**
- **R-a:** plan mode's ungated `~/.claude/plans/` write — filesystem side effect
  outside the project root.
- **R-b:** `ExitPlanMode` input shape drift — `planFilePath` appeared alongside
  `plan` in CLI 2.1.x; adapters must consume `plan` only and treat everything
  else as optional. Fixture pins the observed shape.

**Net:** native plan mode is viable for VIMES; the fallback is not forced. Design
S7·5 around `permissionMode:'plan'` + capture-at-`canUseTool` + deny-to-stop,
with the two risk items priced at Gate-D.

---

## Files produced
- `scratchpad/spike-s7-0-planmode-FINDINGS.md` (this file)
- `scratchpad/spike-s7-0-exitplanmode.jsonl` (fixture: 2 verbatim ExitPlanMode records; CLI 2.1.220 / transcript-stamp 2.1.207, SDK 0.3.207)
- `scratchpad/spike-s7-0/` — probe.mjs + raw logs (throwaway)
