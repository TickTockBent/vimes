# Golden fixtures

Synthetic, real-shaped, pinned per Claude Code version (rule 0.7; see docs/slice-0.md).

**Shape provenance:** field layout (field names, nesting, types) was derived from
one real transcript on this box during development against **Claude Code version
`2.1.206`**. Only the *shape* was borrowed — `sessionId`, `uuid`, `timestamp`,
`type`, `message.{role,content}`, assistant `message.usage.{...}`, `cwd`,
`version`, `gitBranch`. **All values are synthetic** (`/home/user/project`,
counter UUIDs, "synthetic ..." message text). No real session content, paths, or
prose is committed. Refresh these fixtures whenever the Claude Code version bumps.

## transcripts/

- **`baseline.jsonl`** — 15 lines, a synthetic user/assistant exchange under a
  single `sessionId`. Line 6 (assistant) carries a `usage` block. Through the
  tail: 1 rotation output (the initial mapping) + 15 record outputs; through the
  mapper: 15 `message` events + 1 `usage_block`.
- **`rotation.jsonl`** — same shape and parallel content, but `sessionId`
  switches partway (line 8; compaction simulation). Through the tail: exactly 2
  rotation outputs (initial + change). Used by the I1 end-to-end test — a session
  driven through baseline vs rotation differs only in `claudeSessionIds`.
- **`hostile.jsonl`** — valid lines interleaved with adversarial input (I8):
  a truncated JSON line, a line of non-JSON garbage, a valid-JSON-but-alien-shape
  record, an absurd token count (`9e15`) in a usage block, and one line over
  1 MB (generated programmatically — the committed file is ~1.1 MB, which is the
  point). Ends with valid lines to prove the tail resumes. Exactly 3 quarantines:
  two `malformed-json`, one `oversize`.

The fixtures are hand-written (no generator); on a Claude Code version bump,
re-derive the shape from a fresh real transcript and update these by hand,
keeping all values synthetic.
