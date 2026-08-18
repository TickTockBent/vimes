# Golden fixtures

Synthetic, real-shaped, pinned per Claude Code version (rule 0.7; see docs/slice-0.md).

**Shape provenance:** field layout (field names, nesting, types) was derived from
two real transcripts captured on this box during the slice-1 step-0 spikes
(docs/calibration.md, "Slice-1 step-0 spikes") against **Claude Code version
`2.1.207`** (SDK `0.3.207`) — one `query()` transcript and one
`settingSources: []`-isolated `query()` transcript, both SDK-channel. Only the
*shape* was borrowed: `sessionId`, `uuid`, `timestamp`, `type`,
`message.{role,content,stop_sequence,stop_details}`, assistant
`message.usage.{...}` (including the 2.1.207 additions `server_tool_use`,
`inference_geo`, `speed`, `iterations`), top-level `promptId`, `permissionMode`,
`promptSource`, `userType`, `entrypoint`, `cwd`, `version`, `gitBranch`, and the
new record types `attachment` (with `attachment.type` subtypes), `queue-operation`,
`file-history-snapshot`. **All values are synthetic**
(`/home/user/project`, counter UUIDs, "synthetic ..." message text). No real
session content, paths, or prose is committed. Refresh these fixtures whenever
the Claude Code version bumps.

**PTY-channel transcript shape: UNVERIFIED (open question D15).** The spike's
PTY-hosted sessions produced no discoverable transcript `.jsonl` at all — see
docs/calibration.md D15. These fixtures cover only the **SDK-channel** JSONL
shape (the `query()` transcripts); whether PTY-hosted sessions persist the same
record shapes, a subset, or write to a different location remains open. Rule
0.8 makes the JSONL tail the only structure source for PTY sessions, so this
gap blocks trusting the tailer against real PTY output until D15 resolves.

## transcripts/

- **`baseline.jsonl`** — 19 lines, a synthetic user/assistant exchange under a
  single `sessionId`, upgraded to 2.1.207 shape: user `message.content` is an
  array of `{type:"text", ...}` blocks; user records carry `promptId` /
  `permissionMode` / `promptSource` / `userType` / `entrypoint`; assistant
  records carry `message.stop_sequence` / `message.stop_details` (null) /
  `userType` / `entrypoint`. Line 9 (assistant, formerly "line 6") carries a
  `usage` block with the 2.1.207 additions (`server_tool_use`, `inference_geo`,
  `speed`, `iterations`). Four representative new record-type lines are
  interleaved where they'd naturally appear: one `queue-operation` (before the
  opening user turn), one `attachment` of subtype `skill_listing` and one
  `file-history-snapshot` (after the opening user turn), and one `attachment`
  of subtype `hook_additional_context` (after the usage-bearing assistant
  turn). Through the tail: 1 rotation output (the initial mapping) + 19 record
  outputs, 0 quarantines; through the mapper: still 15 `message` events + 1
  `usage_block` — the four new record types carry no `message` field, so the
  mapper emits nothing for them (asserted explicitly in
  `packages/daemon/src/transcript.fixtures.test.ts`).
- **`rotation.jsonl`** — same shape and parallel content as `baseline.jsonl`
  (same 19 lines, same interleaved new record types), but `sessionId` switches
  partway at the same relative position as before (the assistant turn
  immediately after the fourth user turn; compaction simulation). Through the
  tail: exactly 2 rotation outputs (initial + change). Used by the I1
  end-to-end test — a session driven through baseline vs rotation differs only
  in `claudeSessionIds`.
- **`hostile.jsonl`** — valid lines interleaved with adversarial input (I8):
  a truncated JSON line, a line of non-JSON garbage, a valid-JSON-but-alien-shape
  record, an absurd token count (`9e15`) in a usage block, and one line over
  1 MB (generated programmatically — the committed file is ~1.1 MB, which is the
  point). The 5 valid lines are upgraded to 2.1.207 shape (array `content`,
  the new top-level and `usage` fields) exactly as in `baseline.jsonl`; the
  adversarial constructs themselves are untouched. Ends with valid lines to
  prove the tail resumes. Exactly 3 quarantines: two `malformed-json`, one
  `oversize`.

- **`corrections.jsonl`** — 14 lines, the `queued_command` attachment shape
  (slice 6 step 6a, D5). **Shape provenance is a MEASUREMENT, not an
  inference:** the record layout and the value populations were measured
  2026-07-22 over **30 real transcripts / 134 `queued_command` attachments** in
  the live store, and that measurement CORRECTED the earlier S1/D5 prose (see
  docs/risk-register.md, "`queued_command` attachment shape"). **Only the shape
  was borrowed — every prompt string, uuid, path and timestamp here is invented,
  and no test in this repo reads `~/.claude`.** The file pins, in order: a
  `prompt` correction with `origin.kind:'human'` and an enqueue `timestamp`; a
  `queue-operation`/remove; a **`task-notification`** (the ~46% population that
  must produce NOTHING); a `prompt` with **no origin and no timestamp** (the 25
  unmarked records VIMES's own SDK injections most resemble); an **unknown
  `commandMode`**; four malformed attachments (`attachment:null`, a
  `queued_command` with no `commandMode`, one with non-string fields and a
  non-object `origin`, and an `attachment` record with no attachment at all);
  and a final `prompt` correction. Through the tail: 1 rotation + 14 records, 0
  quarantines; through the mapper: 3 `message` + 1 `usage_block` +
  **3 `correction_delivered`**.
  ⚠ **The enqueue timestamps are deliberately OUT OF ORDER relative to file
  position** — the three recognized corrections carry enqueue times
  `12:00:09`, *(absent)*, `12:00:03` at file positions 4, 7, 13. That is the I6
  trap made concrete: the attachment carries the ENQUEUE time but sits at the
  DELIVERY file position (30.4 s apart in observed run A5), so any code that
  sorted transcript records by `timestamp` would reorder these and redden
  `transcript.fixtures.test.ts`.

The fixtures are hand-written (no generator); on a Claude Code version bump,
re-derive the shape from a fresh real transcript and update these by hand,
keeping all values synthetic.
