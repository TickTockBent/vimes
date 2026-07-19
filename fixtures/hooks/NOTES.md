# Golden payload fixtures — slice-2 step-0a hooks spike

CLI: `claude --version` → **2.1.215** (Claude Code). (Task brief named 2.1.207;
the CLI has auto-updated on this box since — noted as a rule-0.6 drift point,
not re-pinned here.) SDK: `@anthropic-ai/claude-agent-sdk` 0.3.207 (installed
copy at scratchpad/spike-d4/node_modules, symlinked into this dir).

## Capture method

A per-session settings file (`../session-settings.json`) registers
`SessionStart`/`Stop`/`SessionEnd`/`PreToolUse` hooks whose `command` is a
relay script (`../relay.sh`) that: (1) writes the hook's stdin verbatim to a
capture file, (2) dumps its own `CLAUDE*`-prefixed env to a sidecar file, (3)
POSTs the stdin body to a local listener (`../listener.js`) at
`http://127.0.0.1:<port>/hooks/test-app-session-123?source=session&event=<Name>`.
A companion project-tier settings file (`../project-a/.claude/settings.json`)
registers the same hooks tagged `source=project`, for the merge-vs-shadow test.

Each fixture below is the **stdin payload** captured for that hook event,
JSON-parsed, then path-sanitized (`/tmp/.../project-a` → `/home/user/project`,
`~/.claude/projects/<encoded-cwd>/` → `/home/user/.claude/projects/<encoded-cwd>/`).
Session ids and tool_use ids are left as-is (random UUIDs/opaque tokens from
disposable spike sessions — not sensitive).

## Hook execution contract (observed, not documented anywhere the spike found)

- The payload arrives **on stdin** of the hook's command process — confirmed
  by `cat > file` in relay.sh capturing valid JSON every time.
- The hook subprocess also inherits a **CLAUDE\*-prefixed env**, distinct from
  what's on stdin. Observed keys: `CLAUDE_CODE_SESSION_ID` (matches
  `session_id` in the stdin payload AND the transcript filename — see
  session-start.json), `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_PID` (the
  running claude process's own PID), `CLAUDECODE=1`, `CLAUDE_PROJECT_DIR`,
  `CLAUDE_CODE_ENTRYPOINT` (`sdk-cli` for both `-p` print-mode and SDK-driven
  runs), `CLAUDE_ENV_FILE` (a per-hook-invocation script path under
  `~/.claude/session-env/<sessionId>/`).
  **Finding for D10:** the env var is `CLAUDE_CODE_SESSION_ID`, not
  `CLAUDE_SESSION_ID` as D10's text names it — same mechanism, different
  observed key. Worth a decisions.md correction when D10 lands for real.
- Hook command runs through a shell (bash) by default; a bare `bash script.sh
  <url> <tag>` invocation with single-quoted args worked with no escaping
  surprises.

## Fixtures

- `session-start.json` — SessionStart, source=`startup`, interactive TUI run.
  Nuance: `model` field present here (interactive) but absent in the `-p`
  print-mode and SDK-driven SessionStart captures (see raw logs) — looks
  optional/context-dependent, not guaranteed.
- `stop.json` — Stop, from the SDK-channel run (`sdk-hooks-test.mjs`).
  `last_assistant_message` echoes the model's literal reply. `effort.level`
  present since the box's default model supports it.
- `session-end.json` — SessionEnd, `reason: "prompt_input_exit"`, captured
  from an interactive TUI session terminated with `/exit`. A separate,
  unsaved capture from a `-p` one-shot run showed `reason: "other"` instead —
  **the `reason` field distinguishes exit paths**, useful for the D10
  adoption-vs-teardown distinction.
- `pre-tool-use.json` — PreToolUse for a Bash tool call
  (`echo hooks-spike-marker`), `permission_mode: "bypassPermissions"` (set via
  `--permission-mode` for the automated run, not a default).

## Not captured

- `StopFailure` — did not fire on any tiny run in this spike (no rate-limit /
  failure condition hit). Its schema is typed in sdk.d.ts
  (`StopFailureHookInput`, not independently verified here) — genuinely
  unobtainable at spike-budget scale; flag as still-a-fixture-gap for
  slice-5's usage adapter.
- `PostToolUse` — not requested by the task's priority list; PreToolUse alone
  was captured. Same relay mechanism would apply.
