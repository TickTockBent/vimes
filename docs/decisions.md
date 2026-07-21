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


## D19 — Slice-3 construction runs through the slice-2 gate week, deploys unrestricted

*2026-07-20 (Wes's call at the morning review).* The slice-2 exit-gate week
is a lived criterion on the notification loop; slice-3 workspace
construction proceeds during it, with deploys as steps land — Wes owns the
awareness cost ("if I see a UI bug I'm smart enough to check in here").
Gate-evidence interpretation note: a missed gate attributable to a
deploy/restart window is investigated before it counts against the exit
criterion. Orchestrator self-restraint: no deploys during an active
on-device measurement. Night-shift defaults 1–4 ratified same morning
(design principles 9–10, attention-reason reservation, operational
housekeeping).

## D20 — Slice-2 exit gate satisfied on "platform validated live"; week-ceremony retired; push latency unpinned

*2026-07-20 (Wes's Gate-D call after the on-device checkpoint passed).* The
slice-2 exit gate as written ("a week where no gate goes unnoticed past
⟨tune 60s⟩ from the phone") tested the wrong usage mode: solo phone-driving of
single sessions is a *means*, not the product (the destination is the
orchestration layer — see design-directions.md). The session/notification
layer is the platform and must be solid (principle 8), but its validation is
the live checkpoint (auth, hooks, custody, push all confirmed 2026-07-20;
locked-phone gate-to-buzz sub-second) plus continuous real use as slices 3+
are built on it — not a ceremonial week of artificial typing. **Decisions:**
(a) slice-2 exit gate is SATISFIED; the literal week is retired. (b) Push
delivery latency is deliberately **UNPINNED** — the real invariant is
qualitative ("delivery must not silently fail," confirmed), not a defended
millisecond band; instrumenting ⟨tune 60s⟩/⟨tune 10s⟩ as FAIL-able
assertions would be over-carefulness (choosing not to pin is as deliberate as
pinning, per Gate-D). Kill criterion not triggered; pillar 5 lands. Slice 3
(workspace / code-server replacement) remains the MVP line and the next
build; dev proceeds continuously (D19), not gated behind a lived week.

## D21 — Slice-3 deploy: roots widened to ~/projects; precache excludes heavy chunks

*2026-07-20 (Wes's three deploy calls, at the slice-3 construction-complete
handoff).* (1) **`VIMES_PROJECT_ROOTS` widened to `/home/ticktockbent/projects`**
(the whole tree) — VIMES is Wes's IDE now; risk is bounded to his single
Access-gated identity, and it brings `infrastructure/vimes` itself into scope
(first step toward the north star: driving the VIMES repo through VIMES).
This governs both spawn cwds and the file-API/terminal reach. (2) **Deploy
now** — slice 3 (editor/files/search/terminal + the spawn-fix class + auth
hardening) ships in one deliberate restart; the code-server-replacement value
and its kill criterion can't be evaluated until it's on Wes's devices. (3)
**PWA precache excludes the CM6/xterm lazy chunks** — load-on-demand (online
behind the tunnel); offline editing was never an MVP promise; keeps the SW
install light on mobile-first. This is the first deliberate slice-3 deploy;
subsequent deploys proceed per D19 (continuous, Wes owns awareness).

## D22 — Slice-3 exit satisfied: CM6 editor replaces code-server; MVP (0–3) complete

*2026-07-20 (Wes's kill-criterion verdict, live on his phone).* The slice-3
kill criterion — "if CM6 mobile editing is not comfortably better than
code-server-on-mobile, halt and reassess the editor layer" — is decisively
NOT triggered: Wes reports the mobile editor "FAR easier to use," "miles
better," principally because it isn't a cramped editor buried among IDE
sidebars (the real-estate-to-content principle, now #11). All slice-3
surfaces validated live: editor, files, search, terminal (desktop + mobile,
the latter after the pty-sizing fix). Like D20, the exit gate's "one full
week of daily use" ceremony reframes to "validated in real use + continuous
daily use going forward" — the MVP is proven, not on probation. **MVP =
slices 0–3 COMPLETE and deployed; 0.1-shippable.** Step-4 polish is now
EARNED (the editor layer survived its kill criterion). Forward: the step-4
polish backlog (slice-3.md) + the slice 4→7 path toward the orchestration
north star; sequencing is Wes's call.

## D23 — Terminals are persistent by default; an inactivity reaper bounds accumulation (window unpinned)

*2026-07-20 (Wes signed off on the design during the polish-pass approval;
built on the night shift). Behavior-shaping → decision record (rule 0).* Raw
PTY terminals change from close-on-navigate-away to **persistent by default**:
leaving the terminal view DETACHES (tears down the xterm binding, keeps the
shell's process tree alive), matching pillar 2 for terminals — reconnecting is
not resuming. **Key architectural distinction:** terminals are **live-or-dead,
never sleepable** — a shell's state is a live process tree (not serializable),
unlike a session whose state is a replayable transcript. So "re-enter a
terminal" means re-subscribe to a still-alive shell (the ring replays what it
holds; `term_lost` if the gap exceeded the window), never "resume." A resumable
Claude *conversation* belongs in a SESSION, not a terminal — the terminal stays
the raw-shell escape hatch (pillar 7).

Persistence is made safe by three things landing together, not persistence
alone: (1) a **terminals list** on the landing screen (`GET /api/terminals`,
byte-free per rule 0.8 — id/cwd/last-active/resilient/subscriber-count) giving
visibility of every alive shell with tap-to-enter and one-tap kill, since
`terminalId` is in-memory only and a page reload would otherwise orphan shells;
(2) an **inactivity reaper** — a non-resilient shell idle (no input OR output)
past a window is auto-killed; INACTIVITY-based, never age-based, so an active
shell is never reaped; (3) a per-terminal **`resilient` flag** ("keep") that
exempts a quiet-but-working shell (long compile/watch) or a deliberate keeper.

**Gate-D honored — the window is NOT pinned.** `terminalIdleReapMs` defaults to
`3_600_000` (⟨tune 1h PREVIEW⟩, `VIMES_TERMINAL_IDLE_REAP_MS`, `0` disables
reaping entirely). The *design* (persistence + reaper + resilient + list) has
Wes's sign-off; the *number* stays a placeholder pending calibrate→sign-off→pin
(rule 0.2) — it earns its calibration when real idle-shell accumulation is
observed. The reap decision is a pure deterministic core fn (`terminalsToReap`,
Date.parse over injected ISO strings — no ambient clock); the periodic timer
lives at the daemon boundary (rule 0.3), unref'd, cleared on stop, and never
created when the window is 0. The check cadence (`TERMINAL_REAP_CHECK_INTERVAL_MS
= 60_000`) is a plain constant, not a ⟨tune⟩ band — it only bounds detection
latency to ≤1 min past the window; the window is the behavior-shaping knob.
Evidence: 491 tests green on the orchestrator's own ci-gate run (+25 new),
scenarios byte-identical, lazy-chunk gate PASS, `/api/terminals` added to the
I14 auth matrix. UNDEPLOYED at record time (ships with the polish-pass restart).

## D25 — Slice-4 exit satisfied: the git diff review window is a real tool; slice 4 complete

*2026-07-21 (Wes's kill-criterion verdict, live on his phone through VIMES).*
The slice-4 kill criterion — "if the mobile hunk-diff view is not legible enough
to actually review agent diffs on a phone, halt and reassess the diff-rendering
approach before the dispatcher is built on it" — is **NOT triggered.** Wes:
"I'm calling this human gate a pass, this is a genuinely useful diff review
window." The primary-human-job surface (spec §3.4 — reviewing agent diffs) is
validated in real use, on the device that matters, against a real repo
(`~/projects/content/vesh`).

**It took three attempts, and the two failures were both mine — in the plumbing
TO the diff, never the diff itself:**
1. The repo picker offered only allowlisted ROOTS, but `~/projects` is a
   *container* of repos — no repo was selectable at all. (Same gap the terminal
   hit and solved with free-text cwd; the lesson wasn't carried across.) Fixed
   with depth-bounded repo discovery + a free-text escape hatch.
2. Repo-relative paths from `git status --porcelain=v2` were resolved against
   the allowlist root instead of the repo root, so tapping a file read the wrong
   path (ENOENT). Fixed by anchoring relative paths on the verified repo root.

**The rule both failures share, worth carrying forward:** specifying a path's
SECURITY property (`resolveWithinRoots`) says nothing about its SEMANTICS. When
a surface accepts paths from an external tool, pin down *what they are relative
to* and *whether the configured roots are usable targets or merely containers of
them*. The wall tells you a path is safe, never what it means.

Like D20/D22, the exit gate's ceremony reframes to "validated in real use +
continuous daily use going forward" — proven, not on probation. **Slice 4
(0.2 — git & cache observability) is COMPLETE**: 609 tests, git adapter + API,
cache-observability projection (D17-deduped), the mobile diff review surface,
and cache badges, all deployed. Cache-vandal warning stays reserved (rule 0.5,
no consumer); billing-bucket classification stays deferred (D24).

**Immediately queued from the passing verdict (Wes's one change):** an **Edit
button in the diff view** that opens the CM6 editor on that file, and on
back-out returns to the diff *with the diff refreshed* — closing the
review→fix→re-review loop inside one surface. This is the review loop of
design-directions' dispatcher vision, in miniature and human-driven.

## D24 — Billing bucket: Claude Code consumes the standard windows; there is no separate automation credit

*2026-07-21 (opened as a slice-4 design finding when the bucket proved underivable
from `usage_block` alone; settled by the slice-5 spikes U1–U3 plus a correlation
experiment; **ratified by Wes**). Moved from open-questions.md.*

**Decision: Claude Code usage — interactive OR headless — draws on the same
account-wide 5-hour and weekly windows. There is no separate "automation" or
non-interactive credit in play on this plan.** The `seven_day_oauth_apps` bucket
is presumed to cover **third-party OAuth applications**; first-party Claude Code
(including `claude -p`) is not one, and VIMES-spawned SDK sessions are not one.

**Evidence (rule 0.7 — observed, never documented):**
- U1: `GET /api/oauth/usage` returns `limits[]` with `session`, `weekly_all`,
  `weekly_scoped`; `seven_day_oauth_apps` is null, `extra_usage.is_enabled` is
  false and `can_purchase_credits` is false (plan `max` /
  `default_claude_max_5x`).
- U2: OTel independently labels a session `terminal.type:
  interactive | non-interactive` — the interactivity signal `usage_block` lacks.
- Correlation: a run confirmed non-interactive by U2's own label moved the
  standard `session` window while `seven_day_oauth_apps` stayed null and no new
  bucket appeared.
- **Honest limit of the evidence:** the orchestrator's own session consumed the
  same window between probes, so the *magnitude* of movement is confounded; the
  *direction* (no separate bucket materialised) is what this rests on. Revisit
  if a plan change or a genuine third-party OAuth app enters the picture.

**Consequences.** Slice 4's refusal to fabricate a bucket label from
`service_tier` was correct and stands — the classification never lived in the
usage block at all. Slice 5 models the three real windows and does NOT model a
phantom automation credit. **This answers the standing question about the dongfu
automation runs: they burned the 5-hour and weekly windows, not a $100 bucket.**

## D26 — `MeterRecord` carries percent + unit; absolute usage is never invented

*2026-07-21 (Gate-D: spike U1 observed the shape, Wes signed off before
construction — calibrate → sign off → pin, rule 0.2).*

The authoritative source reports **percentages only**: `limits[]` entries carry
`percent`, and `limit_dollars` / `used_dollars` / `remaining_dollars` are null.
The slice-0 reserved `MeterRecord {used, limit}` (spec §5) assumes absolutes.

**Decision: widen `MeterRecord` with an explicit `percent` and `unit`, and make
`used`/`limit` optional — present only when a source actually supplies them.**
Rejected: collapsing a percentage into `used = 29, limit = 100`, which would
manufacture an absolute the source never gave and let downstream consumers
believe we know token counts we do not. Under pillar 4 a meter that overstates
its own precision is a meter that lies, and the whole slice exists to prevent
that.

Carried alongside, because the endpoint supplies them free and they beat
anything we would invent: `severity` (the server's own judgement, preferred over
a local ⟨tune 80%⟩ threshold where present), `isActive` (which limit is
currently BINDING), and `scope` (e.g. the model a weekly cap is scoped to).
`source` + `observedAt` stay mandatory on every sample so freshness is always
derivable — freshness itself is DERIVED by a pure function, never stored, so a
stale record can never masquerade as fresh.
