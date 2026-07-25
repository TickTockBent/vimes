# Plan-mode fixtures — spike S7·0 (D44)

`exitplanmode.jsonl` — two verbatim `ExitPlanMode` tool-use records captured from a
LIVE spawned SDK session during spike S7·0 (2026-07-25). Provenance and full
analysis: `docs/evidence-spike-s7-0-planmode.md`.

- **Line 1** — the on-disk *transcript* form (what the daemon reads via
  `transcriptPaths.ts`): carries `version`, `cwd`, `slug`, `sessionId`, …
- **Line 2** — the SDK *stream-message* form (what `SdkAdapter.consumeSdk` sees
  live).

Captured on: SDK `@anthropic-ai/claude-agent-sdk` **0.3.207**, CLI `claude`
**2.1.220** (transcript `version` stamp **2.1.207** — the SDK-vendored binary skew
already tracked in `risk-register.md`), model `claude-opus-4-8`.

⚠ **Consume `input.plan` ONLY.** `input.planFilePath` is a machine-local path into
the operator's global `~/.claude/plans/` and is NON-PORTABLE — see risk-register
row **R-b** (ExitPlanMode input-shape drift). This fixture pins the observed shape
so S7·5 need not re-run a live session; re-capture on every CLI bump.
