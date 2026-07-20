# Design principles

The project's design constitution — standing principles, banked as they are
established. When a proposal touches one's territory, check it against the
principle before recommending. Seeded at kickoff from the spec's ground rules
(§0) and pillars (§1); added to as review passes and findings establish more.

## Ground rules (0.x — non-negotiable; violating one is wrong, not a judgment call)

- **0 (umbrella).** No behavior-shaping change ships without **evidence + Wes's
  sign-off.**
- **0.1 — Findings, not patches.** Any structural flaw discovered by tests,
  spikes, or scenario runs — a race, an unstable identity, a dependency
  behaving differently than designed-for — is a *finding*. It halts the slice
  and earns a dated decision record before work continues. Never quietly
  patched or tuned away.
- **0.2 — Gate-D.** ⟨tune⟩ numbers are placeholders. They may not become
  FAIL-able assertions until calibrate-then-pin (spec §8) has run and Wes has
  priced them against measurements. Never pin and pass in one unreviewed step.
- **0.3 — Deterministic headless core.** Pure logic with clocks, randomness,
  and I/O injected at the boundary. UIs, agents, and external callers consume
  state and propose transitions — never own either. The dispatcher owns the
  task state machine; orchestrator agents propose, they never transition.
- **0.4 — Green stays green.** Every slice ships its assertion set green with
  all prior assertions still green. A regression is a finding.
- **0.5 — Reserve schema early.** Slices may stub systems but must land data
  shapes, event schemas, and API contracts. Data shapes, not tooling —
  machinery with no live consumer waits for its first consumer (D11 is the
  worked example).
- **0.6 — External surfaces drift.** Every uncontrolled surface gets a
  risk-register entry (spec §6) and a fragile-adapter boundary; nothing outside
  the adapter depends on the surface's specifics. Anthropic surfaces get double
  suspicion (the March TTL regression and June billing split both happened
  mid-design). Verify-rows are spikes, front-loaded — never built against
  documentation alone.
- **0.7 — Observed truth over declared truth.** Wherever Anthropic behavior
  matters (TTL tiers, billing buckets, session ID semantics), classify by
  runtime observation of usage fields and transcript data, never by
  documentation. Tags record what a session *did*.
- **0.8 — Never parse the screen.** Structured data comes from JSONL
  transcripts and SDK streams only. Raw PTY bytes are relayed verbatim to
  terminal renderers and never regexed for meaning.

## Design pillars

1. **The session list is the home screen.** Sessions are the primary object;
   files, editors, and terminals are views opened from a session's context.
   Every feature is judged by whether it works from the session list on a phone.
2. **Reconnecting is not resuming.** A browser is a viewport on a server-owned
   process, never the process's owner. Closing every tab changes nothing about
   any running session; "resume" only means waking a dormant transcript, and it
   never forks.
3. **The agent is the refactor engine.** Editing intelligence beyond CM6
   basics + ripgrep is delegated to Claude, not an embedded language service.
   No LSP, no TS server in the browser, no Monaco.
4. **Budgets gate work, not surprise it.** Usage windows, credits, and cache
   economics are first-class domain objects readable by anything that schedules
   work. The dispatcher can decline or defer; the human sees headroom before
   committing.
5. **Attention is the scarce resource.** When a session needs a human, say so
   within seconds, to a device that can answer in one tap. Attention state is
   its own dimension, survives restarts, and is cleared only by deliberate
   action — never lost by a reboot or a glance.
6. **Deterministic harness, replaceable actors.** State machines and reducers
   are authoritative and testable without Claude, network, or UI. A green
   harness means the core is correct even if Anthropic changed everything
   overnight.
7. **Escape hatches beside abstractions.** Every structured pathway keeps a raw
   sibling: the PTY terminal next to the SDK stream, direct file paths next to
   the upload dialog. The day the abstraction fails, work continues.

## Established in use (added as they're banked)

8. **Tunnel to any depth; live at the top.** *(Wes, 2026-07-14, first live
   smoke night.)* The user must be able to drop to any layer — orchestration
   → task board → dispatcher → live session → raw PTY — when needed, but the
   product is judged by how rarely that's necessary. Consequence: every layer
   must be independently solid (the layer you tunnel into is load-bearing
   exactly when things are going wrong), and no layer may assume a
   supervising human at the layer above.

## Established in use (continued)

*(9–10 instituted as night-shift defaults 2026-07-19; ratified by Wes
2026-07-20.)*

9. **One source of record per fact.** *(codor decomp §5.1; default
   2026-07-19.)* Content facts come from the JSONL tail; lifecycle facts
   from hooks/SDK stream; no fact is ingested from two sources without an
   explicit dedupe boundary (the D7 mapping dedupe and the tailer's
   SDK-file skip are the worked examples). Being accidentally *both* is the
   only losing position.
10. **The MCP server is a thin client of the daemon's API — never a second
    writer to the store.** *(ata decomp §3.1; default 2026-07-19.)* Two
    writers is how file locks happen. Binding on slice 6–7 design.

## Standing consequences worth restating

- **Security is core, not product** (finding A): the PTY endpoint is RCE as
  designed; the auth choke point (spec §3.11, I14) is MVP-blocking and live
  from slice 1. Hostile-input probes it every CI run.
- **The event log is the replay buffer** (findings B/E): persist-before-
  broadcast (I13) + replay-from-log (I2) is one path for every gap length. No
  in-memory ring buffers for spine events (the per-terminal PTY byte buffer is
  the sole, deliberate exception).
- **Precision policy:** counted quantities assert exact; measured quantities
  assert within stated tolerance — relative-epsilon, never exact equality.
- **The MVP line is slice 3.** Everything after it must survive contact with
  real daily use before it earns its build.
