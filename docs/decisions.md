# Decision record

Settled design calls, with rationale. **Append-only**: a reversal is a new dated
entry, not an edit. Numbering (`D#`) is preserved forever and continues the
design spec's numbering — still-open questions (D1, D4–D8, D10–D11, D14 at
last update) live in [open-questions.md](open-questions.md) until decided.

Each entry:

```
## D# — <one-line title>

*<YYYY-MM-DD>.* <What was decided, and why. Cite the evidence (harness probe,
calibration run, spike result) and the open-question it closes. Note any
assertion or pin this decision moves.>
```

## D2 — Process topology: one daemon + static UI bundle

*2026-07-13 (resolved during design, red-pen round 1; migrated at kickoff).*
One daemon process serves the API, the WS endpoint, and the built UI as static
files. The split topology's only protection was sessions surviving web-layer
restarts — but during slices 1–6 the code that churns is the registry and
session-host logic itself, which forces restarts of the process-owning layer
under either topology, and the web layer is static middleware that will never
change independently. The real mitigation is `interrupted` + one-tap resume,
promoted to daily UX (spec §4 beat 7). Registry stays transport-agnostic
(in-memory for harness, WS for prod). Boundary: revisit only if daemon restarts
hurt despite the recovery polish — then extract PTY/SDK ownership into a
supervisor process (a refactor, not a rewrite, thanks to the transport-agnostic
registry).

## D9 — Ack semantics: liveness × attention split

*2026-07-13 (resolved during design, finding D; migrated at kickoff).* Session
state is two orthogonal dimensions, not one machine: *liveness* (process
reality: `spawning → running → dormant | interrupted | dead`) and *attention*
(`needsAttention` + `seenAt`). Viewing a session sets `seenAt` — acknowledging
the notification, stopping re-alerts. **Only a deliberate action clears
`needsAttention`** — responding to the gate, dismissing explicitly, the run
resuming. A glance never silently clears "needs you," and attention state
survives restarts (I5). The old `waiting`/`idle` labels survive only as derived
UI badges.

## D12 — Event log body storage: message bodies inline

*2026-07-13 (signed off by Wes at slice 0 kickoff; moved from
open-questions.md).* Message bodies are stored **inline** in the event log,
with projection snapshots keeping boot flat. Transcript-refs were rejected
because they would make replay depend on Anthropic's transcript files
surviving, which rule 0.6 refuses. Cost accepted: log growth (multi-GB/year at
heavy use), revisited with real growth data post-MVP (archival/compaction
sketched in the horizon). This commits the slice 0 `EventRecord` schema; I6
(replay equivalence) and I13 (persist-before-broadcast) are designed against
inline bodies.

## D13 — Recovery of `spawning`-at-crash sessions: add the `spawning→interrupted` edge

*2026-07-13 (rule-0.1 finding in slice 0 step 4; decided by Wes same day;
moved from open-questions.md).* The step-4 recovery design ("sessions the log
last left `running` or `spawning` with no live process become `interrupted`")
conflicted with the D9 edge set, which gave `spawning` only `→running` and
`→dead`. The implementing agent routed recovery through the machine and
reported the conflict rather than patching it; without a fix, a
`spawning`-at-crash session stays `spawning` forever. **Decision: add
`spawning→interrupted` to the liveness edge set.** A spawning session is live
in the spec's sense (§3.10: host restart → live sessions → `interrupted`), and
`interrupted`'s one-tap recovery degrades gracefully to re-spawn when no
transcript was written before the crash. The rejected alternative —
recovery touches only `running`, `spawning`-at-crash goes to `dead` — silently
discards the user's intent to have a session. Moves: `LIVENESS_EDGES` in
sessionMachine, the slice-0.md edge list, and the cold-restart profile grows a
spawning-at-crash session so the recovered edge is exercised, not just legal.
## D3 — Deployment: bare-host systemd on the host

*2026-07-13 (decided by Wes at slice 1 infra review; moved from
open-questions.md).* The daemon runs on the host under a systemd unit,
bound to `localhost:4600`, with cloudflared as the only route in — matching
the box's existing per-app tunnel pattern (vscode/genesis/handoff). Docker was
rejected because the host must spawn `claude`, read `~/.claude`, and touch
project dirs, all awkward through a container boundary. Public hostname:
**vimes.example.dev**, new `vimes` tunnel. Access uses **GitHub as IdP** for
this slice (the daemon's JWT validation is IdP-agnostic — JWKS + aud only);
the product-ization auth wrapper stays post-MVP. Reopens if a dedicated dev
container becomes the environment itself.

## D15 — PTY transcript absence: caused by inherited CLAUDE* env; channel scrubs

*2026-07-13 (opened as a slice-1 spike finding; resolved by the step-2 matrix
spike same day; moved from open-questions.md).* A node-pty-spawned `claude`
writes NO transcript JSONL when it inherits a parent Claude session's env;
with every `/^CLAUDE/` key deleted, the same driven session writes a normal
transcript (27 KB, proper records). Matrix: inherited env → encoded dir but
no .jsonl (4/4 earlier failures explained); scrubbed env → transcript
present. **Decision: the PTY channel spawns with a scrubbed env (delete all
`/^CLAUDE/` keys), and the JSONL tailer is trusted for PTY sessions on that
basis.** The scrub function is the isolation boundary; revisit if a future
Claude Code version changes nested-session detection (rule 0.6).

## D16 — Tailer backstop poll: chokidar confirmed dropping trailing appends

*2026-07-13 (rule-0.1 finding in slice-1 step 2; mitigation reviewed and
accepted same day).* chokidar (native inotify AND polling modes) reproducibly
drops the trailing append of a rapid write burst on this box — the exact
"chokidar missing appends" risk slice-1.md named as a would-be finding.
**Decision: `JsonlTailer` runs an internal file-size poll backstop
(⟨tune 100 ms PREVIEW⟩) alongside chokidar** (kept for low-latency
discovery); correctness never depends on chokidar alone. The poll interval is
a ⟨tune⟩ — pinned after real-session observation against the JSONL-tail-
latency budget (< 300 ms intent, spec §8).

## D18 — Multi-provider posture: interfaces shaped for many, machinery built for one

*2026-07-19 (Wes's call at the decomposition review).* Product-horizon VIMES
should let users attach other providers (OpenAI subscription, OpenRouter,
local models); MVP stays Claude-native to hold scope. The decomposition
series prices the abstraction cost precisely (Jinn's ~7,900-line engines
directory; ATA's per-provider quirks; Codor's registry — declined 4×), so
the resolution is **corner-avoidance without machinery**:
(a) `SessionRecord` reserves a `provider` field (default `'claude-code'`) —
rule 0.5 schema reservation; new payloads added from here get the same
neutrality review; (b) the session host formalizes as a
**capabilities-declared adapter interface** (codor-decompose §2.5) with
exactly two MVP implementations (Claude-SDK, Claude-PTY) — which also makes
the Agent-SDK dependence a Claude-adapter internal, not an architectural
commitment; (c) **boundary rule (inward 0.6):** provider-specifics live only
inside adapters; nothing outside an adapter names a provider's concepts.
Explicitly NOT built until a second provider is scheduled: adapter registry,
provider config surface, any second adapter. Items (a)–(c) apply through
the normal slice gates (a lands with the next schema-touching step; b and c
at slice-2 design).

## D4 — Channel default: SDK-hosted everywhere; PTY is the escape hatch

*2026-07-19 (approved by Wes; spiked 2026-07-13, moved from
open-questions.md).* On the Max account, SDK `query()` and PTY interactive
sessions burn the SAME meters — 5-hour window + weekly caps; the monthly
usage-credits bucket is present but OFF, so nothing can drain it (spike
readings R0–R5, calibration.md). With billing equal, the SDK channel wins on
merit: `canUseTool` is a clean awaitable gate surface (proven in live smoke),
resume is live-verified append-no-fork (I3), and settings isolation is
controllable (D14) — a knob the PTY channel structurally lacks (it inherits
everything; named property of that channel). **Default: SDK-hosted for all
VIMES-spawned sessions; PTY remains the escape hatch** (pillar 7) and the
TUI-features channel. Reopens deliberately, not by surprise, if usage-credits
is ever turned on to give task/orchestration runs an isolated budget — that
flip requires a re-spike (rule 0.7).

## D14 — SDK session settings isolation: settingSources ['project']

*2026-07-19 (approved by Wes; finding + spike 2026-07-13, moved from
open-questions.md).* Daemon-spawned SDK sessions set `settingSources:
['project']` — project `.claude/settings.json` and CLAUDE.md load (typings
confirm 'project' is REQUIRED for CLAUDE.md); the user tier never loads, so
personal automation (the usage-warning Stop-hook cascade that turned a
one-word spike prompt into a 6.3k-output-token exchange) cannot leak into
VIMES sessions. `[]` remains available for fully isolated runs (config).
The ⟨tune PREVIEW⟩ marker on the config default retires with this record.

## D7 — PTY↔JSONL correlation: hooks-first, deterministic

*2026-07-19 (approved by Wes at the slice-2 Gate-D pause; spiked same day;
moved from open-questions.md).* Correlation is delivered by the hooks
channel: a per-session settings file injected at spawn registers a
`SessionStart` hook whose relay URL carries `appSessionId`; the payload's
`session_id` carries Claude's id. Spike evidence (calibration.md
2026-07-19): payload id === transcript filename === SDK-reported id on every
run, both channels; the URL token survives untouched; ~470–550 ms
spawn→POST latency; injection MERGES with project settings (D14 promise
holds); PTY hook subprocesses carry `CLAUDE_CODE_SESSION_ID` as a second
confirmation channel. `claude -n` demotes to an unused fallback, retained
only as a footnote. Hook payload schemas are a rule-0.6 fragile surface:
golden fixtures at `fixtures/hooks/` (2.1.215), loose ingest, risk-register
row at the next doc pass.

## D10 — Terminal-started sessions: mirrored custody, adopt on resume or SessionEnd

*2026-07-19 (resolved at slice-2 design per the skeleton Wes greenlit;
mechanism from codor-decompose §2.2; spike Q4 evidence same day; moved from
open-questions.md).* Sessions VIMES didn't spawn are **mirrored**: listed
from on-demand discovery, read-only-live via the tailer, `custody:
'external'`, the daemon never writes to them, and **attention setters never
fire for mirrored sessions** (the slice-2 turn-attribution rule). Adoption —
custody transfer to the host — happens by explicit action, by
resume-through-VIMES, or automatically via the `SessionEnd` hook where a
project's own settings carry the VIMES relay (spike-verified: SessionEnd
fires on TUI `/exit` with distinguishable `reason:"prompt_input_exit"`;
uninjected sessions fire project-level hooks). Pre-adoption history replays
under the `resync` marker (spec §3.2). Correction from observed truth: the
self-registration env var is `CLAUDE_CODE_SESSION_ID` (not
`CLAUDE_SESSION_ID` as the decomp lean had it). Deliveries-queued-while-
external (the codor FIFO) is deferred until VIMES has deliveries to queue —
schema note only, machinery waits for its consumer (rule 0.5).

