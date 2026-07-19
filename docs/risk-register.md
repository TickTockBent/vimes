# Risk register — external surfaces (delta model)

Spun up 2026-07-19 (first genuine growth beyond the founding table). The
**founding register is spec §6** (frozen with the spec); this file carries
rows added or materially changed since. Same columns, same rule-0.6
treatment: every uncontrolled surface gets an isolation plan; verify-rows
are spikes.

| Surface | Documented | Observed | Verify | Isolation plan |
|---|---|---|---|---|
| **Hook payload schemas** (SessionStart/Stop/StopFailure/PreToolUse/SessionEnd) | thin | shapes captured 2026-07-19 (CLI 2.1.215) — see `fixtures/hooks/`; payload on stdin; `CLAUDE*` env present | `StopFailure` shape UNCAPTURED (fires only on real API failure) — **slice 5 spike**; re-fixture on every CLI bump | loose zod ingest (unknown fields pass); golden payload fixtures pinned per CLI version; all `hook_event_name` handling centralized in one map |
| **Per-session settings injection** (`--settings` / `Options.settings`) | documented flags | MERGE with project settings confirmed both channels (2.1.215, spike 0a) | re-verify merge semantics on CLI bumps (a silent flip to shadow would break D14's promise **and** project hooks) | injection isolated in `sessionSettings.ts`; the merge assumption is asserted nowhere at runtime — the release-gate fixture pass is the tripwire |
| **CLI auto-update** (the box updates Claude Code without asking) | n/a | 2.1.207→2.1.215 mid-slice (2026-07-19), zero notice; transcript drift additive that time | every bump: transcript + hook fixture shape check before trusting | `VIMES_EXPECTED_CLI_VERSION` pin + `runtime_drift_observed` warn-only boot/spawn check (D-approved); release discipline keys fixtures to the pinned version |
| **`CLAUDE_CODE_SESSION_ID` env in hook subprocesses** | undocumented | present and correct on PTY channel (spike 0a) | recheck per CLI bump | used only as a secondary confirmation channel — correlation never depends on it alone (D7's primary is the relay URL + payload) |
