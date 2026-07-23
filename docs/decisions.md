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

## D28 — Slice 5's human exit gate validates IN FLIGHT, not in a freeze

*2026-07-21. Wes's call, after the machine half was rebuilt and the meters
shipped. Reframing of a gate, in the manner D20/D22 established — slice-5.md
already anticipated this ("Reframable like D20/D22 if a shorter honest sample
settles it").*

**The gate as written** asked for meters matching Anthropic's `/usage` within
⟨tune 5% PREVIEW⟩ "over a week of real use", which read as *pause development
for a week*.

**Decision: do not pause. Keep building, and let ordinary use produce the
evidence.** Wes: *"My usage will generate feedback as we go and building will
further push the window where we need to see a gate crossing event."*

**Why this is a sharpening rather than a weakening.** The gate needs three
things: accuracy against the authoritative source, at least one **window
rollover**, and ideally a **real threshold crossing**. None of them is produced
by waiting — rollover happens on the clock regardless, and *the other two are
produced by WORK*. A frozen week yields a flat, uninformative sample: meters
parked at a constant percentage, no crossing, and accuracy confirmed only in the
one state that never mattered. **Development is not an interruption of this
gate's evidence; it is the source of it.**

**What still holds, unchanged.** The gate's *content* is untouched — accuracy
within the band, across at least one rollover, is still what passes it. What
changed is the posture: evidence accumulates continuously (the usage observation
log records every poll, and `meter_alert` events are durable in the log), and
the gate is called when the evidence is sufficient rather than when a calendar
says so. **The orchestrator reports when the sample supports a verdict, and does
not declare a pass from a comfortable partial one.**

**Already banked toward it (2026-07-21):** one real 5-hour rollover captured end
to end, including the previously-unknown `resets_at`-disappears-at-zero shape;
the first half of the human gate landed unprompted (VIMES displaced the official
portal); the machine half rebuilt into an instrument proven to fail under seven
sabotages. **Still missing: a real threshold crossing** — the deliberate burn
reached 16% of a fresh window before the load stopped, and the 80% line has not
yet been crossed in anger.

## D8 — The usage endpoint is the SOLE headroom authority; local sources never substitute

*2026-07-21. Opened 2026-07-13 as an open question with a lean; the verify half
ran as slice-5 spikes U1/U3 and CORRECTED that lean; settled by the adapter
actually shipping (`cc3c009`) and running in production. Moved from
open-questions.md.*

**Decision: wrap `GET https://api.anthropic.com/api/oauth/usage` — the CLI's own
`fetchUtilization` — as a clearly-marked fragile adapter (rule 0.6), and treat it
as the ONLY source that may produce a headroom number. When it breaks, headroom
degrades to `unknown`. Local sources are never promoted to fill the gap.**

**The original lean was wrong and the spikes said so.** It read: *"do it; meters
degrade to JSONL+OTel sources when it breaks."* U3 disproved the degradation
clause — **JSONL and OTel are account-blind.** They see only the sessions VIMES
hosts, while the limits are account-wide (every Claude Code invocation anywhere,
including the orchestrator's own session). Observed directly: the endpoint
reported the 5-hour window at 29–35% consumed while VIMES's JSONL held **zero**
`usage_block` events for that same window.

**So source precedence is a TYPE DISTINCTION, not a preference.** Local sources
supply attribution, burn and cost for VIMES-hosted work — which is real and
valuable, and became slice 5b — but they are structurally incapable of answering
"how much headroom does this ACCOUNT have", and must never be allowed to
impersonate an answer. One authoritative source per `meterId` (principle 9);
corroboration, never a silent merge.

**Consequences, all now shipped.** The adapter consumes `limits[]` only and
ignores the churning codenamed buckets; a 401 at ~6h token roll is the NORMAL
daily failure and emits nothing rather than a placeholder; freshness is derived,
never stored; and `unknown` never collapses into `pass` or `0`.

**Reopens (happily) if Anthropic ships an official endpoint.** Until then the
fragile-adapter boundary and the usage observation log — which fingerprints every
response shape and stores the first sighting of any new one — are how we find out
that it moved.

## D24 — CORRECTION (2026-07-21, same day): the conclusion stands, one cited mechanism does not

D24 concluded that Claude Code usage — interactive or headless — consumes the
standard account-wide windows, with no separate automation credit. **That
conclusion is unchanged and still supported.**

But it cited, as supporting evidence, that *"U2: OTel independently labels a
session `terminal.type: interactive | non-interactive` — the interactivity
signal `usage_block` lacks."* **Spike C2 disproved that reading of the
attribute.** `terminal.type` is not an interactivity classification at all — it
is **the value of `$TERM`**, defaulting to the literal string
`non-interactive` when unset. Run the same headless command with `TERM=dumb` and
OTel reports `terminal.type: "dumb"`.

**Consequences:**
- **Anything keying on `terminal.type === 'non-interactive'` will misclassify**
  — it is a terminal-capability string, not a mode flag. Nothing in VIMES does
  today; this records why nothing should start.
- D24's evidence base narrows to U1's `limits[]` shape and the correlation
  experiment (a run moved the standard `session` window while
  `seven_day_oauth_apps` stayed null and no new bucket appeared). Both stand on
  their own, so **the decision does not reopen.**
- **The honest caveat already recorded in D24 gets sharper:** its magnitude
  evidence was confounded by the orchestrator's own session, and now one of its
  three legs is gone too. It remains the right call on the evidence, and it is a
  thinner-legged call than it looked on the day.

**Rule 0.7 cuts both ways.** D24 was built by preferring observation to
documentation; this correction comes from preferring a *better* observation to
an earlier one. An attribute's NAME is documentation too — `terminal.type` read
like a mode because it was named like one, and nobody tested what actually
populated it until a spike ran `TERM=dumb`.

## D29 — Push urgency/TTL signed off; and the operator's 95% wind-down brake

*2026-07-21. Wes, on the evening of the first real threshold crossing.*

**Two decisions, and the second one turns out to specify a feature.**

### 1. Push delivery fixes — APPROVED, deferred to after the window reset
The threshold alert fired correctly but did not reach the phone until the app
was opened, because `createWebPushSender` sends with **no `urgency` and no
`TTL`** (see calibration.md). Signed off:
- **`urgency: 'high'` on time-sensitive sends only** — attention gates and
  threshold alerts. Not on routine traffic: high urgency wakes the radio, so the
  distinction between "the human is needed now" and "this is merely true" becomes
  an HTTP header. Pillar 5, made concrete.
- **A bounded `TTL`** so an undeliverable threshold alert **expires rather than
  arriving late**. A "you crossed 80%" push landing after the window resets is a
  stale number wearing a notification — forbidden everywhere else in slice 5, and
  it must be forbidden here too. Natural value: seconds until `resetsAt`.
- **A non-session-scoped delivery-outcome event.** Meter alerts emit no
  `push_sent`/`push_failed` because those payloads carry an `appSessionId` and a
  meter belongs to no session. The consequence, felt immediately: when delivery
  actually failed, **the log could not say whether the push was even attempted.**

**Scheduling: after the 5-hour window resets (20:39:59Z).** These are daemon
changes and need a restart; doing it mid-window during a deliberate burn would
interrupt in-flight work for no benefit.

### 2. The 95% wind-down brake — a NEW operating rule
> *"I'm going to rule that if we hit 95% of the window, gently shut down anything
> in-flight."*

Binding from now: **at ⟨tune 95% PREVIEW⟩ of the binding window, in-flight agents
are wound down gently** — finish the current unit, write the checkpoint, stop; do
not start the next unit. Not killed: **held.**

**This is the spend brake, specified by the operator in his own words.** The
prior-art mining recommended exactly this shape from Codor — *work is held, not
failed; release is the human's; the meter is always visible so the brake is never
the first you hear of it* — and it was reserved (rule 0.5) as
`disposition: 'hold'` with no producer. **Wes arrived at the same design
independently, from use, before seeing the implementation.** That is the
strongest signal available that the reserved vocabulary is the right shape, and
slice 7's brake should be built to THIS description rather than to the
orchestrator's design guess.

**Note the two ceilings are different things.** 95% is the operator's brake — a
choice, tunable, about protecting remaining headroom for work he cares about.
100% is Anthropic's wall — not a choice, and in-flight work fails on their terms
regardless of what any rule here says. The brake exists to keep us from meeting
the wall.

## D5 — Course correction is STREAMING-INPUT INJECTION; `interrupt()` is the hard stop, not the fallback

*2026-07-22 (settled by spike S1, Wes: "d5 approved"). Moved from
open-questions.md; the 2026-07-13 lean is CONFIRMED by observation.*

**Decision: steer = inject, abort = interrupt.** A correction is delivered by
pushing a `SdkUserMessage` into the live session's streaming-input queue.
`interrupt()` is retained as a *complementary* lever for hard stops (runaway
command, abort) — **not** as the correction fallback it was originally cast as.

**Evidence (spike S1, full record in calibration.md 2026-07-22; SDK 0.3.207,
SDK-vendored CLI 2.1.207).** Injection was observed to reach the model **inside
the turn** — 3.06 s and 1.29 s from enqueue to delivery with zero `result`s
emitted, so provably before any turn boundary — on **two models**, using the
production message shape, leaving **one continuous run** (single `result`, one
`sessionId`, one transcript). The orchestrator independently verified I3 no-fork
structurally across four runs: 1 sessionId, 1 root, 0 multi-child parents, 0
chain breaks. Interrupt+resume also works cleanly (3 ms stop, no orphans, same
file, correction applied), so **both** levers exist.

**Kill criterion NOT triggered.** It fires only if corrections require killing
runs on both paths; neither path requires it. Slice 6 proceeds.

**The constraint this decision carries (binding on slice 6 step 6).** Delivery is
bounded by the **next model call**, not by generation: injection does **not**
preempt an in-flight tool. Parked in a 40 s tool, a correction landed at
**30.4 s**, exactly when the tool returned — and the worst case is unbounded (a
long build or test suite). Therefore:
- the UI renders a correction as **queued → delivered**, never as instantly
  applied; and
- the **watchdog must not read "correction queued, not yet delivered" as stale**,
  or it will quarantine a healthy corrected run.
`interrupt()` is the only lever that preempts a running tool — which is precisely
why it is kept rather than discarded.

**Consequence for the build.** The mechanism ALREADY SHIPS: `sendMessage()` into
a running session already lands in the SDK queue (`sessionHost.ts`). Slice 6
step 6 is therefore mostly **semantics, evidencing and UI** — a `correction`
verb, its event, and the board affordance — not new plumbing.

**Two riders recorded, not folded into this decision** (risk-register rows,
2026-07-22): the SDK vendors its own CLI binary at a different version from PATH
(the E4 drift-guard fix is a separate approved unit); and an injected correction
is written as a `queued_command` **attachment**, not a `user` record, carrying
the *enqueue* timestamp at the *delivery* file position — so **the tailer must
learn that shape or mid-run corrections are invisible in the session stream**,
and transcript records must never be ordered by `timestamp`.

**Deliberately not determined** (so it is not mistaken for settled): the
undocumented `SDKUserMessage.priority` field; delivery when mid-generation with
no tool pending; behaviour with a **subagent in flight** (relevant — stage
runners spawn subagents); coalescing of rapid injections; and whether anything
differs when spawned through the daemon rather than directly. The long-tool
latency bound rests on a **single** run.

## D30 — Watchdog staleness band PINNED at 15 min (Gate-D); and "stale" is three conditions, not one

*2026-07-22 (Wes: "pin the staleness band at 15 min for now", after spike S3a's
measurements). Rule 0.2 satisfied: calibrated → signed off → pinned, deliberately.*

**PINNED: a stage run with no JSONL append for 15 minutes is STALE.** This
replaces the spec's ⟨tune 5 min⟩ placeholder, which the measurement disproved.

**Why 15 and not 5.** Measured over the real corpus (697 transcripts, 80.6k
records; full record in calibration.md 2026-07-22), the **machine-work** gap
distribution is p50 1.5 s, p99 1.33 min, p99.9 3.52 min, **max 14.87 min**. False
quarantines by band: >5 min → **30**, >10 min → 8, **>15 min → 0**. A 15-minute
band clears every one of 70,232 observed healthy gaps. The 5-minute placeholder
fails **systematically, not occasionally**: the tail is long thinking blocks plus a
reproducible cluster of `TaskOutput`/`Agent` gaps at exactly **10.00 min** (an
upstream subagent-poll cap) — and slice 6's stage runners spawn subagents, so a
5-minute band would quarantine healthy subagent work as a matter of course.

**The assumptions this band carries** (bands are pinned with their assumptions,
never as bare numbers): measured on **interactive/orchestrated work on this host**,
CLI 2.1.x, not on dispatcher stage runs — which do not exist yet and may run longer
autonomous stretches. Wes's "for now" is recorded as intent: **this band is
provisional and is expected to be re-priced once real stage runs produce their own
distribution.** Re-measuring is cheap (the S3a scripts are read-only and rerunnable).

**⚠ The pin is only half the design — the other half is not a number.** Human-gated
waits (`AskUserQuestion` / `ExitPlanMode`) were observed up to **599.99 min** (10 h)
on perfectly healthy runs, because the human's reply returns as a `tool_result` and
is indistinguishable from in-flight work. **No threshold separates those from a
stall**, so the watchdog must not try. **"Stale" therefore means THREE conditions,
all required:**
1. the run is **not blocked on a human gate** (consult the existing `canUseTool` /
   `needsAttention` state — slices 0–2 already own it),
2. it is **not at a resume boundary** (a resumed session's first gap is wall-clock,
   not a stall),
3. and it has **not appended for ≥ 15 min**.

A watchdog implementing only (3) is wrong at any band, and would quarantine a run
that is waiting on Wes — the exact rule-0.1 failure slice-6.md names ("a system
that kills good work is worse than no watchdog").

**Still UNPINNED, deliberately (Gate-D):** the retry count before quarantine
(⟨tune 3⟩) and the retry backoff curve ⟨tune⟩. Those price against *retry* behaviour,
which no measurement covers yet; they stay placeholders until a stage run produces
evidence. Binding on build step 5.

## D31 — The 3× Opus cost divergence is NOTED, not chased; the table stands, and D28 is the monitor

*2026-07-22 (Wes, on the S2 finding): "my feeling is that if we chase this too much
we'll just go into a tailspin because Anthropic could change their pricing silently
at any time. Pin what we have observed, and we'll monitor as we go for changes."
Asked which of the two observed rates to pin, he declined to re-pin: "keep a note
about this intact, and we can revisit it later if we notice further discrepancies."*

**Decision: change nothing.** `claude-opus-4-8` stays pinned at **$15/$75 per
MTok** (the C2-validated figure). The SDK `total_cost_usd` observation implying
$5.05/$25.24 is **recorded as an open divergence, not treated as a correction.**
No re-pin, no Gate-D supersession, no code change.

**Why this is the right call and not avoidance.** Pricing is a **rule-0.6 external
surface** — presumed to change under us without notice. Chasing a 3× discrepancy
between two first-party signals could consume the slice with no guarantee of a
stable answer, because the answer itself can move. The project's response to a
drifting external surface is an isolation boundary plus observation, not a
one-time forensic resolution. The price table already IS that boundary: it is a
single pinned module carrying an effective date, so a later correction is a
one-line, dated re-pin rather than a refactor.

**What this decision costs, stated plainly (pillar 4 — no pretending).** Absolute
Opus dollars in the ledger carry a **known, unresolved 3× uncertainty**, and Opus
dominates the corpus. Unaffected: percentages, rankings, project/session/agent
attribution, reconciliation, the tree, and every un-known classification — this is
a scalar on one model's rate, not a structural error.

**D28 is un-halted, and D28 IS the monitor.** The accuracy sign-off compares the
ledger against Anthropic's own `/usage` over days of real use — which is precisely
the tiebreaker this divergence needs. "Monitor as we go for changes" therefore
requires no new machinery to begin: **if the ledger and `/usage` disagree by ~3×,
that is the further discrepancy this decision defers to.** D28's verdict should
explicitly note which way that comparison came out.

**⚠ The monitoring gap this exposed (queued, not built).** VIMES currently ingests
**NEITHER** first-party cost signal: nothing captures `total_cost_usd` from the SDK
result stream (zero references in `packages/`), and `claude_code.cost.usage` was
spiked in U2 but never built — only a fixture exists. **The ledger prices tokens
with our own table and has nothing to check itself against**, which is exactly why
a 3× divergence survived a Gate-D pin and was found only when a spike tripped over
it. Cheapest fix, if wanted later: the daemon already consumes the SDK stream, so
capturing `total_cost_usd` per run and continuously comparing it to our priced
figure gives a **rate-agnostic ratio monitor** — it watches for the ratio *moving*,
so it works regardless of which rate is correct, and it would have caught this on
day one. Queued as a rider, not scheduled; slice 6 keeps its scope.

## D32 — Worker isolation default is WORKTREE; the lean's cache premise was refuted

*2026-07-22 (Wes: "agreed, flip the default to worktree isolation", on spike S2's
evidence). Moved from open-questions.md; the 2026-07-13 lean is REVERSED.*

**Decision: default `isolation: 'worktree'`**, with the per-task override the spec
already reserved (`shared-dir` remains selectable per task).

**Why the lean reversed.** The 2026-07-13 lean was `shared-dir`, resting entirely
on one claim: *"prompt cache is scoped to machine + directory, so a worktree worker
cannot reuse a sibling's cached prefix."* **Spike S2 observed that this is false on
this host** (full record in calibration.md 2026-07-22): a worker in a never-used
directory read 16,081 tokens written in a DIFFERENT directory, and a fresh worktree
took a **100% cache hit including a 22,297-token block written elsewhere** — while
the second worker in the *same* directory still paid 3,260 tokens of cache writes.
Caching behaves prefix/content-addressed, not directory-keyed.

With the cache benefit gone, the trade collapsed to a single axis: **worktree buys
file isolation; shared-dir buys nothing that can still be demonstrated.** Isolation
therefore wins by default rather than by measurement.

**What this decision is explicitly NOT based on.** S2 also produced an 88% dollar
delta favouring worktree — **that number is order-confounded and was not used.**
Write tokens fell monotonically across the whole run sequence and arm B ran last,
so run order is fully confounded with arm. The *cache-scoping observation* is the
finding; the price tag is not.

**The untested axis, stated so it is not mistaken for settled.** S2 ran serial,
single-worker, read-only, so it says nothing about (a) how bad shared-dir's write
races actually get — including `.git/index.lock` contention, which is a hard
failure rather than a slow path — or (b) what worktree isolation COSTS in setup
time, disk, and git overhead. This decision buys a known benefit against an
unmeasured cost. Build step 8 should measure worktree setup cost as it lands and
keep the per-task override cheap, so a cost surprise is a config change rather than
a redesign.

**Limits of the evidence:** one host, one account, one model, one task shape, five
serial runs. Caching is a rule-0.6 external surface that already shifted under us
the same day (every write landed in the 1h tier, none in 5m). If cache scoping ever
becomes directory-keyed, this decision's premise returns and D6 should be reopened
as a new dated entry.

**Scope note:** no code carries an isolation default today — `schemas.ts` reserves
the enum (`'shared-dir' | 'worktree'`) but nothing sets it. This decision is
therefore docs-only until build step 8, which is where the default first becomes
real.

## D33 — The degenerate staleness band PINNED at `-1`; `NOTHING_IS_FRESH_STALE_BAND_MS` renamed to `NO_OBSERVATION_IS_FRESH_STALE_BAND_MS`

*2026-07-22 (Wes, on the open-questions D33 finding): approved changing the value
to `-1` and renaming the constant. Rule 0.1 satisfied: the finding earned this
record rather than a silent patch; moved from open-questions.md, where the finding
and its exposure analysis were first recorded.*

**Found by an implementing agent's test, confirmed independently.** During slice-6
step 4b verification, the first version of a test asserted the *intent* of
`NOTHING_IS_FRESH_STALE_BAND_MS` and failed. Confirmed independently against
`meterDerivations.ts:75`: `meterFreshness` classifies with `observationAgeMs >
staleAfterMs` — a strict `>` — so at a band of `0` an observation aged **exactly
0 ms** read `fresh`, and its gate was evaluated for real. The constant's name
claimed nothing could be fresh; it overstated that guarantee by one millisecond.

**Exposure, sized rather than hand-waved.** With the usage poller disabled,
`runUsagePoll` is `meter_sample`'s only emitter, so reaching the gap required a
*forced* `POST /api/usage/refresh` landing in the same millisecond as a gated
dispatch. `observedAt` is stamped from the daemon's own injected clock
(`usageEndpoint.ts:178`), never from the endpoint's, so clock skew could not widen
the window — a future-dated observation was never reachable here. In production
the poller is ON and this constant is unused; the gap was real but narrow and
failed OPEN.

**Decision: `-1`, and the constant is renamed.** `packages/daemon/src/app.ts` now
exports `NO_OBSERVATION_IS_FRESH_STALE_BAND_MS = -1`. Because `meterFreshness`
uses a strict `>`, `-1` is not an arbitrary negative number picked to "look
closed" — it is the **largest** band for which every non-negative observation age
reads `stale`, which is exactly the guarantee the name makes. The comment at its
definition says so explicitly, and flags that `-1` reading oddly as a duration is
deliberate: it is a sentinel, not a timeout, and a future reader who "fixes" it
back to `0` re-opens D33.

**Why a name that overstates its own guarantee matters at one millisecond of
blast radius.** This is the pillar-4 failure in miniature: a constant that claims
"nothing can be vouched for" while actually vouching for one exact case is the
same shape of error as trusting a number the system cannot see, just smaller.
Rule 0.2's discipline — don't fabricate a plausible band, don't tune away a
finding silently — was already satisfied by the original band; this decision
closes the one remaining crack without touching the rest of that reasoning, which
is unchanged and still load-bearing: `-1` beats both fabricating a plausible
number and disabling task dispatch entirely whenever the poller is off.

**Test consequence, taken on purpose.** `taskApi.test.ts` carried a test explicitly
labelled as pinning this gap (an observation stamped at exactly `now` reading
`fresh` and spawning). That test has been inverted: the same observation now reads
`stale`, and the assertion moved from "spawned" to zero `spawnSession` calls. The
other tests in that describe block — a 1 ms-old observation refuses, a
never-observed meter refuses, an ungated task still spawns — are unchanged; the
ungated case remains the proof that the blast radius stays opt-in.

**Forward pointer.** Step 5's watchdog is the next consumer of freshness
reasoning in this codebase, and should inherit a constant that means what it says
rather than a second constant needing its own asterisk.

## D34 — Projections are STREAM-LOCAL; the watchdog heartbeat moves to the SESSION record

*2026-07-22 (Wes, on the open-questions D34 finding): approved option (d) —
`lastAppendAt` on the session record — and the constraint written down. Rule 0.1
satisfied: the finding halted slice-6 step 5b, earned this record, and was not
patched around. Moved from open-questions.md, where the full reproduction and the
four options were first recorded.*

**The finding.** Step 5b's heartbeat fold was the first genuine cross-stream fold
in the codebase, and it does not work. `bootFromSnapshot` and
`readAllStreamsGrouped` fold **each stream to completion before the next**, and
`streams()` is alphabetical. Every `appSessionId` is a UUIDv4, so every session
stream sorts before the literal `'tasks'` — the tasks projection folded session
appends *before* the `task_session_attached` that gives them meaning, and dropped
them. Whether it appeared to work depended on the stream's NAME: the same fold
succeeds with a `zzzz…` id and fails with a real UUID.

**Root cause.** `seq` is per-stream (`UNIQUE(stream, seq)`, `MAX(seq) WHERE
stream = ?`). **The event log has no global ordering column** — only `ts`, which
is not guaranteed unique or monotonic across streams. "Replay the log in order"
is not something the system can currently do.

**It also broke I6**, and the existing guard could not see it: with a snapshot
taken after the attach, boot set `lastHeartbeatAt` while replay-from-empty left it
`null`. `assertBootEqualsReplayAtCuts` cuts an *already-grouped* array, so its cut
points never reproduce the snapshot-contains-the-attach shape a live daemon
produces constantly. A green I6 is evidence about single-stream folds only.

**How it was found and handled.** The implementing agent halted at section B
rather than working around it, and proposed four repairs without choosing one.
The orchestrator reproduced all three probes independently before accepting the
claim. Section A (the `watchdog_stale` widening) was green and independent and
shipped separately (`7e53f15`); section B was reverted and saved as a patch.

**Decision: option (d) — the heartbeat is a fact about a SESSION.**
`lastAppendAt` (and the stale-episode count) live on the **session record**, folded
by the sessions projection, which already owns session-stream events. That fold is
single-stream, so no ordering problem exists and I6 is unaffected. The watchdog
runner already reads sessions state for `liveness` and `needsAttention`, so it
costs nothing at the call site.

This is not merely the cheapest repair — it is the better model. **"When did this
session last append?" is a fact about a session, not about a task** (principle 9:
one source of record per fact, held where its stream already is).
`TaskRecord.lastHeartbeatAt` and `TaskRecord.staleRetries` are slice-0
reservations that predate the session/task split being worked out; under this
decision they stay unwritten and are **explicitly retired** rather than left
looking live.

**Rejected, with reasons.** (a) Give the log a global order — the general fix and
the only one that makes cross-stream folds ordinary, but it costs an event-store
migration plus new snapshot `lastAppliedSeq` semantics under *every* projection.
If cross-stream folding is ever genuinely required, this is the honest answer and
**it is its own slice, not a step inside one.** (b) Emit heartbeat events on the
tasks stream — doubles event volume for the highest-frequency signal in the system
(S3 counted 80.6k transcript records) and writes a second record of a fact the
session stream already holds. (c) Buffer unresolved heartbeats inside `TasksState`
— order-independent and I6-safe, but state grows with every session ever observed
and the mechanism is subtle in a projection that is currently easy to read.

**The constraint is now written down** in `architecture.md`: *no projection may
fold an event from a stream other than its own.* That entry exists so the next
person does not lose the same day, and it is why `architecture.md` was created.

## D35 — A correction is a steer of an IN-FLIGHT turn; `run_completed` is the clear

*2026-07-23 (Wes, during the slice-6 live test plan): approved. Rule 0.1
satisfied — T1/T2 surfaced two independent defects, the slice halted, and this
record was written before any code changed. Supersedes the delivery assumption
inside D5/D30; the D5 injection mechanism and the D30 protection conditions
themselves are unchanged.*

**How it was found.** Wes ran T1, sent a first prompt to a freshly spawned
session, and the composer immediately showed *"Correction queued"* — for a
correction he had not made. The indicator never cleared. He then ran a second
session (`138d3ef4`) deliberately dropping three mid-turn corrections, and
dropped three more into the orchestrator's own session so the behaviour could be
observed from both sides at once.

### Finding A — `correction_queued` fires on every send

`wsHub.ts:416` emits `correction_queued` for **every** `send` op the host
accepts. There is no notion of whether a turn is actually running, so an opening
prompt to an idle session is recorded as a course-correction. Observed in both
test sessions (`5c8c382c` seq 7, `138d3ef4` seq 7).

**A liveness gate would NOT have fixed this, and the trace proves it.** Session
`138d3ef4` was `liveness: running` from `liveness_changed{cause:'spawn'}` at
11:36:57 — *before any prompt existed*. An SDK session sits in streaming-input
mode awaiting its first turn and is `running` throughout. **`running` means the
process is alive, not that a model turn is in flight**, and the two are not the
same fact.

### Finding B — the SDK channel cannot observe delivery at all

`correction_delivered` has exactly one source: the transcript mapper recognising
a `queued_command` attachment. On the SDK channel it can never fire:

- `sessionHost.ts:430` — every SDK session calls `markSdkJsonl(jsonlPath)` on
  `system/init`
- `tailer.ts:186` — that adds the path to `skipPaths` and drops its file state
- `tailer.ts:216` — the tailer skips that file permanently

Which is **correct for messages** — SDK sessions get those from the stream at
`sessionHost.ts:440`, and tailing as well would double-count. But the
`queued_command` attachment exists **only in the JSONL and never in the SDK
stream**. So step 6a's recogniser is structurally unreachable on the default
channel (D4), and the lifetime count of `correction_delivered` in the production
log is **0** — not bad luck, architecture.

The recogniser itself is **correct and vindicated**: `138d3ef4`'s transcript
record 20 is a genuine `queued_command`, `commandMode:'prompt'`,
`entrypoint:'sdk-ts'` — exactly the shape `mapper.ts` matches. This also answers
the open unknown in the risk register's `queued_command` row: **VIMES's own SDK
injection produces `prompt` with no `origin` and no `source_uuid`**, confirming
the decision to carry `origin.kind` as evidence rather than require it.

### The measurement that decided the fix — corrections arrive in TWO shapes

Six live corrections across three sessions (two channels, `sdk-ts` and
`claude-vscode`):

| delivery timing | transcript shape | observable? |
|---|---|---|
| **mid-turn** (the turn made another tool call while queued) | `queued_command` attachment, `commandMode:'prompt'` | yes — on PTY; **not on SDK** (finding B) |
| **after the turn ended** | an ordinary user message, **no attachment at all** | **no — on any channel** |

`138d3ef4`'s third correction is the second shape: enqueued 11:37:49, `Stop` at
11:38:06.669, delivered 11:38:06.681 as plain record 33. The orchestrator's own
third note behaved identically on the interactive client. **That shape emits no
signal any tailer could ever see**, so no amount of transcript work covers it.

Delivery is also **mid-turn at the next tool call**, not at the next turn
boundary — which kills the "clear on the second `run_completed`" refinement the
orchestrator initially proposed. By the first `run_completed`, both shapes have
already been consumed.

### Decision

1. **A `turnInFlight` bit on the session record**, folded single-stream (D34):
   set when VIMES delivers a message, cleared on `run_completed`.
2. **`correction_queued` is emitted only when a turn was in flight *before* the
   send.** Kills the phantom; keeps genuine mid-run steers.
3. **`pendingCorrectionAt` clears on `run_completed`** as well as on
   `correction_delivered`. This is the **load-bearing** rule, not a backstop: it
   is the only path that covers both delivery shapes.
4. `correction_delivered` remains the earlier, more precise clear wherever it is
   observable — today, the PTY channel.

**Why this matters beyond the indicator.** `pendingCorrectionAt` feeds
`watchdogDecision`'s `correction-in-flight` protection. A phantom protection
normally lifts on the next transcript append, but a session that wedges
*immediately* after a phantom stays protected forever — the staleness guard
silently switched off on a run nobody is steering, which is exactly the failure
mode the D5 comment at `wsHub.ts:398` was written to prevent for refused sends.
Pillar 4 applies directly: a meter that lies is worse than no meter.

**Rejected, with reasons.** (a) *Gate emission on `liveness === 'running'`* —
disproved by the trace above; it would have emitted the phantom anyway. (b)
*Clear on the second `run_completed`* — rests on a wrong model of when the CLI
picks up queued text; measurement showed mid-turn delivery. (c) *Let the tailer
read SDK transcripts for attachment records only* — would restore delivery
observation on the default channel, but the SDK skip exists to prevent duplicate
message events and reaching into it risks a regression in the highest-frequency
path in the system, for a gain of "clears a few seconds sooner." **Deferred to
open-questions with its own trigger**, not folded into this fix. (d) *Treat the
CLI's `queue-operation` records as the signal* — they are richer (enqueue /
popAll / remove / dequeue, and they capture a human editing a queued note before
delivery) but they are a client-transcript artifact behind the same tailer skip,
and building on them would deepen the coupling this decision is narrowing.

## D37 — The cost ledger groups by DIRECTORY ROLLUP, not by an inferred project boundary

*2026-07-23 (Wes, reviewing the live cost ledger): approved. Raised as "those
'projects' are really just categories of projects" and settled in the same
exchange — a project boundary is not a thing VIMES can detect, so it stops trying.*

**The finding.** `costTree.ts:392` returns `rootWithBoundary + firstSegment` —
the **immediate child** of the longest matched `VIMES_PROJECT_ROOTS` entry. With
`VIMES_PROJECT_ROOTS=/home/ticktockbent/projects` and a
`projects/<category>/<project>` layout, every rollup keys on
`/home/ticktockbent/projects/infrastructure` — the **category**. Every repo under
it is summed into one line, and drilling in reaches session UUIDs with no
directory in between.

**Why not just go one level deeper.** It would fix this layout and break a flat
one. The depth of a project below its root is not a constant, and picking any
number is a guess dressed as a rule.

**Why not detect a boundary marker.** Considered and rejected on Wes's objection,
which is decisive: *"we cannot rely on every project being a git repo. I may want
to work locally without a repo for a while, or I may want to use another source
control system."* `.git` fails for un-versioned work and for jj/hg; `package.json`
fails for polyglot repos and reverses inside monorepos; any dotfile convention
fails for anyone not using it. **A cwd is a fact; a project boundary is an
inference**, and rule 0.8's posture — do not infer meaning from a signal we do
not control — applies to directory layout exactly as it does to the screen.

**Decision: group by the directory tree itself, with rollups at every node.**
Anything launched in `…/vimes/packages/daemon` counts under `…/vimes`, which
counts under `…/projects/infrastructure`, up to `…/projects` as the full rollup of
all spend. Each node reports `own` and `subtree`, and the operator chooses
granularity by expanding rather than by trusting a boundary someone guessed.

Three reasons this is better than a fixed grouping and not merely more flexible:
1. **Nothing is inferred.** Every node is a real directory a session really ran
   in — the honest-full-cwd fallback `costTree.ts:360` already reaches for when no
   root matches, applied uniformly instead of only in the fallback case.
2. **It is the codebase's existing shape.** The agent tree already computes
   `own` + `subtree` at every node; this is that pattern one level up, not a new
   concept to learn.
3. **It retires the question permanently.** Flat layouts, nested layouts,
   monorepos, scratch dirs and future tools all work without another decision.

A flat group-by-exact-cwd was the cheaper repair and is **rejected**: it is honest
but fragments one repo into several unrelated line items whenever sessions are
launched at different depths, hiding the number the operator asked for. The tree
costs more and removes the failure instead of relocating it.

**Unchanged:** `VIMES_PROJECT_ROOTS` keeps its job as the *filter*, and the single
outside-roots bucket survives (binding data rule 9 — "slugs are not projects").
`insideProjectRoots` is untouched.

**No money moves.** This re-buckets presentation only: same rows, same prices,
same totals. C2 reconciliation is unaffected — a fact worth stating because a
regrouping of every historical figure sounds larger than it is.

**Session leaves get a readable identity too.** Cost rows already carry
`projectCwd`, so showing a directory instead of a UUID needs no join. The
human-given session `name` lives on the sessions projection and does. The ladder
is `name` → cwd basename → short id, so it degrades to something readable rather
than to a hash.

## D38 — Money renders at 2 dp, and a real sub-cent amount renders `<$0.01`, never `$0.00`

*2026-07-23 (Wes, same review): approved. "6 decimal places is not meaningful in
cost reporting."*

**The decision has two halves and the second is the load-bearing one.**

**Two decimal places, at the DISPLAY layer only.** `formatUsd`
(`priceTable.ts:198`) keeps its 6 dp: micro-dollars are "the Money boundary"
(`priceTable.ts:191-193`) and **the figure C2 reconciles against OTel's USD**.
Rounding at the source would trade a validation the ledger exists to pass for a
formatting preference. The transform belongs in `packages/ui/src/lib/costDisplay.ts`.

This does **not** breach that module's integrity rule ("a money figure is NEVER
re-computed here"). That rule forbids *deriving* money — summing, converting,
apportioning — because a second computation can disagree with the source. Reducing
precision for display is presentation, and presentation is the view's job. The
orchestrator's first instinct was to fix it at the source; Wes's redirect to the
display layer was correct and is recorded because the reasoning is not obvious
from either file alone.

**Round, never truncate.** String-slicing `"$0.999999"` yields `"$0.99"` — a
systematic *understatement* of money across every figure in the ledger. Round
half-up, matching `nanoDollarsToMicroDollars`'s existing rule.

**A non-zero amount below one cent renders `<$0.01`.** This is the same pillar-4
line the ledger already holds when it refuses to render an unpriced row as `$0`:
real spend collapsing to `$0.00` is the identical lie in different clothing, and a
per-agent breakdown is full of genuinely sub-cent rows. A true zero still renders
`$0.00`, so the two remain distinguishable.

## D35 (addendum) — adoption also resets `turnInFlight`

*2026-07-23 (Wes: "fix the adoption residue"). Appended rather than edited into
D35 above, which is already committed (`471f21b`) — decisions.md is append-only.
Found by the orchestrator during verification of D35, not by the test suite.*

**The residue.** A mirrored session accumulates a turn that nothing can ever end.
The tailer emits `message` events for an externally-discovered session
(`custody:'external'`, parked at `liveness:'interrupted'` by
`cause:'discovered-external'`), so D35's fold sets `turnInFlight: true` — but
VIMES is not driving that process, so no `run_completed` arrives and its liveness
never moves. Confirmed against the live log: stream `d85bc8f8` carries 5 such
messages.

**Why it was harmless right up until it wasn't.** While the session stays
mirrored, `sessionHost.ts:739` refuses every send with `external-custody` before
anything is emitted, and a refused send emits nothing. But `session_adopted`
flips custody to `'host'` and deliberately leaves liveness untouched (D10 —
separate axes). So the first send after adopting a mirrored session would read a
stale `true` and record a phantom course-correction — the exact defect D35 exists
to kill, surviving in a narrower case.

**Decision: `session_adopted` clears `turnInFlight` to `false`, unconditionally.**
Not "leave it alone": adoption means VIMES has just taken custody of a process it
was **never driving**, so what that process is doing is genuinely UNKNOWN — and
unknown resolves to `false`, the same fail-safe direction the rest of D35 takes.
An absent correction record costs the watchdog a protection it did not need; a
phantom one switches the staleness guard off on a run nobody is steering. The
next `message` sets it truthfully anyway, so the clear is a reset, not a mute.
**Liveness stays untouched** — this does not widen the D10 separation.

**`pendingCorrectionAt` does NOT have the same shape, and the reason is worth
recording** (raised by the implementing agent; verified rather than assumed). It
is set only by `correction_queued`, which the hub emits only *after* an accepted
send — and mirrored sends are refused before that point. So a mirrored session
can never acquire a pending correction to go stale. `correction_delivered`
arriving for a human typing into an external PTY is already an explicit no-op
that refuses to create the field. **Two independent guards, so no pinned test was
added**; this paragraph exists so the next reader does not re-derive it.
