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

## D39 — Desktop is the PANEL STACK; N by breakpoint with a device-remembered override; sidebar replaces the session list; focus is last-interacted

*2026-07-23. Wes signed off the five gating questions from `design-directions.md`
→ PANELS. This entry records the answers so a work order can be written against
them; the design rationale stays in `design-directions.md` (append-only there
too — this does not edit it).*

The desktop shell is the **panel stack**: navigation state is a list of panels,
each holding one route; the viewport renders as many trailing panels as fit; back
pops. The phone is the **degenerate case** (`N = 1`), so today's behaviour is a
one-element stack and survives untouched.

1. **Adopt the panel stack — YES.** It is simpler than the two-slot alternative
   (one slot type, one back rule, no param namespacing, one shell), it is the
   reason desktop is worth building, and retrofitting the router later is the
   rewrite. Phase 1 (routing → a pure tested lib) already shipped as `d2bf45e`.
2. **N is chosen by a width breakpoint** at common phone / tablet / desktop
   boundaries, **with a user override remembered on the device** (localStorage).
   The computed N is the default; the override wins when set and persists per
   device. localStorage is device-local presentation state — it is NOT event-log
   state and never becomes a projection input (rule 0.3 boundary).
3. **The sidebar session list REPLACES `SessionListView` on desktop.** Two lists
   of the same thing is exactly the drift the model exists to prevent (principle
   9). On a phone the session list stays a panel; on desktop it becomes ambient
   chrome in the sidebar. Wes: "let's see what this looks like" — so the first
   desktop build shows it and we judge from the lived view.
4. **Focus = the last-interacted / last-clicked panel.** It takes keyboard input
   and global actions, shows a **visible focus border**, and when it hosts a text
   entry that entry shows a visibly **active cursor**. This is decided BEFORE the
   shell is built, not after (it shapes the host's event model).
5. **First unit is LEAN — proof of concept: the shell plus the stream→editor
   panel pair.** Not every view's panel treatment at once. That pair exercises
   push, pop, and focus end to end, which is what a POC has to prove. The full
   per-view audit (all eight views as one-of-N) follows once the pair validates
   the host's push/pop/focus API.

**Sequencing consequence.** The retrofit is phases 2→4 (phase 1 shipped):
phase 2 (`Route` → `Panel[]`, additive, single-panel URLs byte-identical) then
phase 3+4 merged (host + sidebar + the proof pair), since #5's lean scope is
exactly that merge. The desktop board is a later unit consuming step 9's
layout-agnostic `lib/` unchanged.

## D40 — The panel shell mirrors only the VISIBLE window to the hash; the full stack lives in memory, rooted at the session list

*2026-07-23. Discovered and decided during the panel-shell POC (D39 phase 3+4).
This refines — does not reverse — phase 2's "the hash encodes the stack": it
narrows WHAT the hash encodes once a stack can be deeper than the viewport shows.*

**The tension.** Phase 2 kept the stack length 1 and derived it straight from the
hash. The shell needs history *below* the visible window so "back" works — but on
a phone (N=1) opening a session yields the stack `[list, stream]` while only
`stream` is visible, and the hash MUST stay byte-identical to today
(`#/session/x`, not the multi-panel `#/stack/…`). Encoding the full stack breaks
the phone byte-identity that D39 and phase 2 make load-bearing.

**Decision.** Split the two:
- The **in-memory `ref` is the source of truth** — the full navigation history,
  as deep as navigation made it.
- The **hash mirrors only the trailing-N visible window.** At N=1 that is always
  one panel, so `buildPanelStackHash([single]) === buildHash(single)` (the phase-2
  invariant) and every phone URL/transition is byte-identical. The window is also
  what a user sees and would bookmark/share, so it is the honest URL.

**The invariant that makes "back" survive a reload: the session list is the root
of every stack.** A deep-link/reload seeds the ref from just the visible window
(`#/session/x` → `[stream]`); `seedStackFromHash` prepends the sessionList root
when the window does not already start there, so back always reaches home —
matching today's `navigateHome` from any view. Without it, back from a reloaded
non-home view was a no-op (the regression the orchestrator's gate caught; the
shipped shell fixes it).

**Accepted limits (POC).** Depth *below* the mirrored window is not URL-persistent
— a reload recovers the window plus the synthesized list root, not arbitrarily
deep history. Deep browser-history integration (`history.back()` vs writing the
popped hash) is deferred. `returnTo`/`decideEditorReturn` is now redundant under
the stack (popping an editor reveals the panel it was pushed from); the param
stays in `route.ts` (harmless) but the shell wires editor-back to a plain pop. The
git→editor→back diff-refresh edge (GitPanel staying mounted beneath a popped
editor) is a known follow-up, out of the POC path.

**Why this is not a reversal of phase 2.** Phase 2's guarantee — every URL that
worked before is byte-identical and single-panel URLs stay readable — is *upheld*
here, not weakened: the window is single-panel on a phone precisely so those URLs
stay pretty. D40 only answers the new question phase 2 never faced ("what does the
hash show when the stack is deeper than the viewport"), and answers it in the
direction phase 2's readability goal already pointed.

## D41 — A panel's "back" is TRUNCATE-FORWARD; the affordance reads "back" on phone, "close ×" on a desktop panel

*2026-07-23. Settles the open question captured in `design-directions.md` → "Panel
back/close semantics", which the shell POC surfaced (Wes clicked back on a middle
panel and the tail closed). Wes's call: option #1 + the #3 affordance.*

**Behaviour — truncate-forward.** Back on panel *i* closes panel *i* and
everything opened after it (its downstream children):
`closePanelAt(stack, i) = stack.slice(0, max(1, i))` — never empties (floors at the
session-list root, D40). This mirrors how OPENING already works (`openPanelFrom`
discards everything forward of the acting panel), so the stack stays a linear
drill-path and an editor opened FROM a file closes WITH the file rather than being
orphaned. On the tail, `closePanelAt` equals `popPanel`, so the **phone path is
unchanged** — on a phone only the tail is visible, and back there still walks up
one panel at a time.

*Rejected:* splice/close-one (keep the downstream panel, re-parent it) — it
disagrees with `openPanelFrom` and muddies the drill model; and global
"back = pop tail" — the bug proved users read the button as belonging to the panel
it is on.

**Affordance — layout-aware label, same action.** The action is `closePanelAt`
everywhere; only the label/icon differs by context: a **phone** panel's button
reads/behaves as "← back" (pop the one visible panel = go up), while a **desktop**
content panel's button reads "close ✕" (close this specific panel + its children).
Implemented by threading a `backKind: 'back' | 'close'` context to each view's
existing back button (App knows the layout: desktop content panel → 'close', else
'back') — NOT by moving the affordance out of the views, which would be a larger
refactor deferred for now.

**Scope note.** This is the panel-lifecycle affordance living in each view's back
button for now. A future clean-up could move panel chrome (close/back) into the
shell (`PanelHost`) so views stop owning it — noted, not scheduled.

## D41 (addendum) — TWO views have a conditional back, not one; only the branch that actually emits closes the panel

*2026-07-23, found while implementing D41's affordance half. The orchestrator's
work order asserted that only `GitPanel` had a conditional back and that
`TerminalView.onBack` "always closes the panel". That was wrong, and the
implementing agent caught it rather than applying the label blindly.*

`TerminalView.onBack` is the **same shape as GitPanel's**:
```js
async function onBack() {
  if (started.value) { teardownView(); await refreshTerminals(); return; }  // in-view: back to the terminal LIST, no emit
  emit('back');                                                            // only this closes the panel
}
```
From an open shell it detaches and returns to the terminal list — **in-view
navigation, no `emit('back')`** — and only from the list does it close the panel.

**The rule this generalises to, and the one to apply to any future view:** a
view's back button relabels to "close ✕" **only in the branch that actually
`emit('back')`s** to the shell. A branch that navigates WITHIN the view keeps its
own affordance regardless of `backKind` — labelling it "Close panel" would be an
accessibility lie, telling a screen-reader user the panel will close when it will
not. Both `GitPanel` (`activeFilePath`) and `TerminalView` (`started`) are
handled this way.

No behaviour changed here — this addendum records the corrected fact and the rule,
because the next view with an in-view back will hit exactly this.

## D42 — "Project" is a DECLARED boundary (a user-picked directory in an event-sourced registry), never an inferred one; scoping is a derivation over cwd

*2026-07-24. Settles the derivation-vs-entity question opened by the
project-centric redesign (see `design-directions.md` → "Project-centric VIMES").
A read-only spike established the crux; Wes's call resolves it. The relationship
to D37 is load-bearing and stated below. BUILD is deferred to after slice 6.*

**The question.** The redesign makes VIMES project-centric: a landing
project-picker scopes every surface (sessions, cost, terminals, git, files,
search). Is "project" derivable from data VIMES already emits, or a new entity? A
spike found cwd is carried nearly everywhere — `session_created.cwd`
(`events.ts` → `sessions.ts`), cost rows keep `projectCwd` verbatim
(`costCorpus.ts`, `costLedgerReadModel.ts:157`), terminals (`terminalHost.ts`),
files (`app.ts` `projectRoots ∪ liveSessionCwds`) — BUT `VIMES_PROJECT_ROOTS` is a
SINGLE root (`~/projects`, D21), so `cwd → root` collapses every project to one
node. Reaching a NAMED project needs a boundary, and **D37 is a signed decision
that VIMES does not infer one** (fixed-depth, `.git`, `package.json`, and dotfile
conventions each rejected on Wes's own objection).

**Decision — don't infer, DECLARE.**
- First launch shows a blank project picker with **+New Project**. The user
  selects a directory; **that directory IS the project boundary.** Optional name +
  description; absent a name, the directory basename is the name.
- The selection persists to an **event-sourced project registry**
  (`project_created` + lifecycle events, NOT static config) — projects are created
  at runtime, carry mutable user metadata, and have a lifecycle
  (created → optionally initialized → optionally archived); that is event-log state
  (rule 0.3, I12), not config. This UPDATES the orchestrator's earlier "config
  registry" lean, which predated the runtime-creation + metadata + init-hook shape.
- `VIMES_PROJECT_ROOTS` (D21) does NOT become the project set — it stays the
  **allow-list within which projects may be declared** (see the security
  sub-decision).
- Opening a project makes its boundary the root; every surface **scopes by cwd
  prefix-match against declared boundaries — a pure derivation, computed at read
  time.**

**Why this is NOT a reversal of D37.** D37 refused to *infer* a boundary
heuristically. Declaring one explicitly, per project, by user selection is exactly
the sanctioned alternative D37 pointed at — the machine still never guesses. D37
stays intact; D42 supplies the boundary D37 withheld, from the user instead of a
heuristic. Building an inference to auto-populate the picker WOULD silently reverse
D37 (rule 0.8 territory) and is out.

**The payoff — declared entity, DERIVED (retroactive) attribution.** Because
attribution is a prefix-match over cwd, and historical data already carries cwd,
declaring a project **retroactively scopes all its historical data for free — no
backfill, no migration.** The cost ledger already scans the WHOLE
`~/.claude/projects` corpus recursively (`costIngest.ts` → `~/.claude/projects`),
so this includes sessions that never touched VIMES; the `<outside-project-roots>`
bucket (`costTree.ts:241`) is the standing proof the ledger already holds
non-project cwds. This is the best-of-both the spike's NEEDS-ENTITY verdict
allowed: a small declared entity + zero-migration derivation. (History
browse/resume is elaborated in `design-directions.md`.)

**Consequential decisions this record makes:**
- **Overlap → longest-prefix-wins.** A user may declare both `~/projects` and
  `~/projects/vimes`; a cwd under vimes matches both. The most specific (deepest)
  boundary wins. Nesting is a feature, not an error.
- **Attribution is READ-TIME derivation, never stamped on events at creation** —
  cwd is already native on both session records and cost rows, so project reads
  from each row's own field and NEVER through the fragile
  `appSessionId ↔ claudeSessionId` title-map bridge that halted Q4's relocation.
  The spike confirmed the n:1 ambiguity does not resurface here.
- **Landing = the picker**, settling two parked items: the 2026-07-20 "sessions
  should not be the landing page" and Q2's "demote the session list" half. The
  picker becomes the panel-stack ROOT — a D40 evolution: the stack roots at the
  selected project (not the session list, D40's current root), and each project
  owns its stack; switching projects swaps the stack, and the hash gains a project
  segment.
- **A `project_initialized` event is RESERVED** (rule 0.5 reserve-schema) for the
  onboarding hook (`design-directions.md` → "Project onboarding") — the shape is
  reserved now; the workflow is built when it has a consumer, not before.

**⚠ The one sub-decision needing Wes's explicit sign-off BEFORE the slice
(security-shaped).** May declaring a project **extend** the file/git allow-list
beyond `VIMES_PROJECT_ROOTS`, or must projects be declared **within** it? Files and
git already allow-list paths against the roots (`gitApi.ts:138-151`, `app.ts`); a
picker that can select anywhere would silently widen that access surface (rule
0.6 / security posture). **Lean: constrained within the roots** — D21 stays the
safety fence, projects are declared inside it, and widening the fence stays a
separate deliberate act. This is the only piece not settled here, and it gates the
work order.

**Known gap carried forward (NOT solved by this).** A worktree-isolated session's
cwd is deliberately OUTSIDE every root (`worktreeRoot`, `config.ts`), so
prefix-match dumps it (and its cost rows) to `<outside-project-roots>`, not the
parent project. Correct attribution needs the `session.taskRef.taskId →
task.projectRoot` join, and cost rows carry no `taskRef`. Only bites when
`VIMES_WORKTREE_ISOLATION` flips (already a ⟨Wes⟩ item) — named here so the build
does not rediscover it.

**Sequencing.** Build AFTER slice 6 closes (its exit gate is one test away; do not
destabilize it). Slice-7 MVP = picker + registry + derived scoping. The history
read-model and the onboarding init-workflow are follow-ons, not the first cut.

## D45 — Transcript dirs are DISCOVERED (matched by session id / internal cwd field), never COMPUTED from a slug rule we mirror

*(2026-07-25. A rule-0.1 finding from the T6 CLI-2.1.220 verify spike, verified
independently by the orchestrator against real transcripts, then Wes's call.)*

**The finding.** `encodeCwdForProjects` (`transcriptPaths.ts:17`) folds `/` and `.`
to `-` but **preserves `_`** (`/[/.]/g`), on the strength of a code comment
claiming that was observed truth at CLI 2.1.207. **That comment is false.** Ground
truth (rule 0.7): the on-disk dir `…-games-space-industry` contains a transcript
whose own `cwd` field is `/home/ticktockbent/projects/games/space_industry` — the
CLI folded `_`→`-` when naming the dir (same on `ThermAI_FlightDeck →
ThermAI-FlightDeck`; uppercase is preserved, so the fold is `_` only). So for any
project whose path contains an underscore, `encodeCwdForProjects` computes a dir
that does not exist and **transcript tailing + discovery silently find nothing** —
no error, just missing data. Pre-existing (the fold is visible back to ≤2.1.207),
NOT a 2.1.220 regression.

**Why not just fix the regex (`/[/.]/g → /[/._]/g`).** Earlier the same day the
orchestrator's own `ls` showed a dir `…-unnamed_progress_ship_game` with the
underscore **preserved** (now gone). One folded dir and one preserved dir in
recent history ⇒ the CLI's slug rule appears **version-dependent** — precisely the
rule-0.6 "external surface drifts under you" hazard. Mirroring today's rule
re-bets on a surface we just watched change, and the `.`→`-` edge has *never* been
observable (no dotted project dir has ever existed). A computed slug is a
standing guess about someone else's private encoding.

**The decision (Wes, 2026-07-25): approach B — discover, don't compute.** Stop
reconstructing the dir name from cwd; find the real path instead, immune to
whatever the CLI's slug rule is (rule-0.8-aligned: depend on structured content,
not on a fragile derived name). It is **not a uniform swap** — two caller shapes:
- **Session id known** (`sessionHost.ts:425,1064`, via `transcriptFileFor`):
  glob `~/.claude/projects/*/<claudeSessionId>.jsonl` and take the match.
- **Only a cwd known** (`tailer.ts:111`, `discovery.ts:42`, via
  `transcriptDirFor`): resolve the dir by matching each candidate dir's *internal*
  `cwd` field against the target cwd — discovery already enumerates the dirs, so it
  reads truth rather than predicting a name. (Discovery fundamentally cannot know
  a session id in advance — that is what it is discovering.)

**Scope note for the build.** Keep a single fragile-adapter module; the computed
slug may survive as a *hint*/fast-path but never as the authority. Delete the false
comment. Land a test with an underscore cwd (the guard that would have caught
this). The `.`→`-` edge stops being load-bearing under B, which is part of the
point. Queued (QUEUE.md), not yet built — its own small unit, sequenced by Wes
against the task-model pass.

**Unrelated T6 outcome (not a finding).** Bumping `VIMES_EXPECTED_CLI_VERSION`
2.1.217→2.1.220 is safe (warn-only, gates no spawn, no boundary drift observed);
it needs a root `/etc/vimes/env` edit + restart, so batch it into the next real
deploy rather than a dedicated restart. The B fix does NOT depend on the pin.

## D43 — A task IS a work-order: structured fields for what the machine reads, attached artifacts (by reference) for what only an agent reads

*(2026-07-25. Migrated from open-questions D43; the T7 real-use evidence there is
the trigger. Settled with D44 and D46 as one design pass. This supersedes the
"add an optional `description` string" lean — the finding was bigger than a field.)*

The task stops being `{title, stage}` and becomes a **work-order**: the
spec-and-verify unit the whole workflow runs on, not a chat prompt to steer.

**The dividing rule (fields vs. artifact).** *If the dispatcher, the verifier, or
the board branches or renders on it, it is a FIELD. If only an agent reads it, it
is an attached ARTIFACT by reference.* Both, with that boundary:
- **Fields on the task record:** scope summary; explicitly-out; **acceptance
  criteria as a structured LIST** — each criterion individually addressable, never
  a text blob; kill criterion; plus what already exists (isolation, gates).
- **Artifacts, content-addressed, referenced by the record:** the plan and its
  kind — a self-owned blob (the codor/AgenC pattern), never inlined into the task
  row. (Envelope reserved under the slice-7 floor pieces, slice-7.md.)

**Two shapes that are quietly load-bearing later, reserved now (rule 0.5):**
1. **Acceptance-as-list is a rubric.** A structured criteria list is exactly what
   the verify stage grades against, so `review` can grow toward the "grader iterates
   against criteria" (Outcomes) shape **without a second schema pass**. This is why
   it must be a list, not prose — see D46's `report_review` floor piece.
2. **Work-orders are revisioned, not mutated (spine discipline).** Edits land as
   **amendment events**; a stage run records **which `workOrderRev` it was
   dispatched against**. That gives every stage run the identity
   **`(taskId, stage, attempt, workOrderRev)`**, which turns "the implementer built
   against the old scope" from an argument into a queryable fact — and is the same
   key D46 relies on to keep per-attempt cost/usage honest.

Widening discipline as ever: base fields absent-stays-absent, I6-safe; amendments
are appended events, never in-place edits.

## D44 — The plan crosses the plan→implement boundary as a `submit_plan` TOOL CALL, validated in-run; native plan mode lives below the adapter line

*(2026-07-25. Migrated from open-questions D44; decided with D43/D46.)*

The planning stage emits its plan by calling a Vimes-owned **`submit_plan` MCP
tool**, whose payload is **validated against the plan schema at submission time,
inside the planner's own run**. Not a structured final message.

**The deciding argument — retry locality.** A schema-invalid plan submitted via the
tool **bounces back as a tool result and the planner fixes it in-session**. A
structured *final message* only fails **after the run has ended** — dead session,
respawn, cold start — so every schema miss becomes a full stage retry. Supporting:
matches the typed-reports-over-prose consensus; is byte-identical across the SDK and
PTY channels (it rides the stream/JSONL either way); and gives a natural
**provenance hook** — the tool result records the artifact **hash** and the
**planner session ref** onto the task. The plan itself persists as a D43 artifact
(content-addressed blob + envelope); `submit_plan` is what writes it.

**Multi-provider seam (why a custom tool and not native plan mode as the contract).**
`submit_plan` is **THE CONTRACT** — schema-validated and provider-neutral, and
multi-provider is eventual. Claude Code's native **plan mode is a Claude-ism**: it
already emits a machine-liftable plan (the content rides in the **`ExitPlanMode`
tool call's input**, in the JSONL — no screen involved), but that belongs **below
the claude-adapter line** per the seam rule. The adapter *may optionally* use native
plan mode as the planning UX and **funnel its output into the same `submit_plan`
shape**. The contract stays ours; Claude's mechanism is an implementation detail.
(The plan-mode A/B spike reframes accordingly — it no longer asks "which wins" but
characterizes plan mode's behaviors and confirms `ExitPlanMode` is cleanly liftable;
scope in slice-7.md.)

## D46 — Stage-run fixes spawn FRESH; `mode:'resume'` dies for stage runs. Two correction doors, both fresh, differing only by `workOrderRev`

*(2026-07-25. The one sub-decision inside the task-model pass; Wes sided with the
orchestrator's synthesis. Resolves S10 — "resume bypasses stage independence" — by
never resuming a stage run at all.)*

There are exactly two legitimate ways to correct dispatched work, and **both spawn
a fresh session**:
- **Steer (the fix loop, `review → implementing`):** a **fresh** implementer seeded
  with `(same workOrderRev + the prior attempt's diff + the review feedback + the
  author's worklog)`, `attempt++`.
- **Amend (new scope):** a **fresh** dispatch against a **new `workOrderRev`**.

They differ **only** in whether `workOrderRev` changes. `resolveStageRunner` loses
its resume mode; the dispatcher loses a branch; the fix-seed composition moves into
`composeStageInstruction` where it belongs (net simplification).

**Why (two independent arguments — the second recorded deliberately so the decision
survives even if the doctrine is later disputed):**
1. **Doctrine / identity.** Resume-the-author is chat-and-steer wearing a task
   costume. A resumed author makes **one transcript straddle two attempts**, which
   muddies per-attempt **usage attribution**, **replay (I6)**, and the convergence
   loop's "are attempts improving?" comparison — all at once. The
   `(taskId, stage, attempt, workOrderRev)` key stays honest **only if a session
   never spans attempts**.
2. **Anchoring (survives even if you reject #1).** An author resumed with its own
   review feedback is **structurally invited to defend its original approach** — it
   is marinating in its own rationale. A **fresh** implementer reading
   work-order + diff + feedback **cold** judges the fix against the **contract**, not
   against its memory of why it did it that way. Review-stage independence and
   fix-stage freshness are the same principle.

**Rider 1 — the fix-seed MUST carry the worklog, not just the diff.** What you lose
with fresh dispatch is **not** memory of the code (the diff has that) — it is memory
of the **dead ends**. So `report_completion`'s payload carries **decisions-made and
paths-rejected**; without that worklog a fresh fixer re-explores the dead ends on
our tokens. (This makes the worklog a reserved floor piece, slice-7.md.)

**Rider 2 — scope precisely.** This governs **stage runs only**. Interactive free
sessions keep `resume` untouched — that is the human's own door and always was.

**Honest cost — measure, don't argue it away.** A warm resumed author re-reads its
context at **cache-read** rates inside the 1h TTL; a fresh implementer pays **cold
prefix + re-reads**. So re-dispatch-with-feedback is genuinely **more expensive per
fix cycle**. Clean attempt identity (rationale #1) is exactly what makes per-attempt
cost a **queryable number** — so the standing call is **"revisit if fix-cycle cost
proves material,"** with the data pipeline to actually know.

**The two-door UX (T7's deepest lesson).** The failure in T7 was never a missing
door — it was that the doors **weren't labeled**. The board must make **choosing the
door a visible act**: steer (same rev, new attempt) vs. amend (new rev, fresh
dispatch). This is the correction model made legible, and it is where the
chat-and-steer instinct gets a legitimate, bounded home.

## D47 — A UI-foundation slice (panel-frames + design system + full re-skin) is inserted as slice 6b, BEFORE the task model (slice 7); the task model is NOT renumbered

*(2026-07-25. Wes: "rip the band-aid off, pause backend, style up the front end."
The build-order call + why the numbering is done this way.)*

**The work.** Slice 7's task-model UI (authoring form, two-door choice, orchestrator
conversation) will reuse shared components — buttons, inputs, modals, the usage gauge.
Building those against the *current* look and restyling later is building the UI
twice (the standing rule). The panel-frame spike (2026-07-25) also showed the scroll
fix is a small, contained change (height not overflow — see slice-6b doc). So the
UI foundation lands **before** the task model:
- **panel-frames** — every openable panel becomes an independent scroll frame
  (verified small: `App.vue` root `min-h-screen`→`h-[100dvh] overflow-hidden`, the 9
  view roots `min-h-screen`→`h-full`, StreamView's `window.scrollTo` re-pointed to the
  frame scroller). S6 (pinned vitals) folds in as top-of-frame.
- **design system** — an *elevated* identity pinned as tokens (cockpit/instrument
  thesis, IBM Plex Mono + Plex Sans, cool neutrals + one instrument-cyan accent,
  distinct green/amber/red gauge tones), signed off via a styleguide artifact.
- **full re-skin** — all 9 views migrated to the tokens, incrementally, one unit each.
- **the active usage gauge** — persistent top-bar instrument showing the **binding
  constraint** with a **pulldown** for all constraints + **burn rate** (Wes's spec);
  account usage always-visible in the bar, this-session context stays in the stream
  strip (the two-tier split).
UI-only — no daemon/core changes, so it ships via the gate with no restart; its exit
gate is **human** (Wes clicks every view × 2 themes × 3 viewports). Operational plan:
`slice-6b-ui-foundation.md`.

**Why "slice 6b" and not "renumber the task model to 8"** (the mechanical decision,
recorded so it isn't re-litigated). Renumbering the task model would rewrite the
meaning of ~15 files' worth of correct "slice 7" references — including load-bearing
ones in `risk-register.md` (the MCP-advisory reasoning), `architecture.md`,
`calibration.md`, and the **append-only** `D43`/`D44`/`D46` — and would force edits to
committed decision bodies, which append-only forbids (a change is a new entry, never
an edit). The repo already has the interstitial-slice precedent (`slice-5b-cost-
ledger.md`), so the UI work is **slice 6b**: the task model keeps slice 7, every
existing reference stays true, and the `S7·N` unit labels stay valid. Integer
tidiness is not worth rewriting history.

## D48 — Native plan mode is ADOPTED for the plan→implement crossing (Gate-D, settling D44); the plan is captured by VIMES intercepting `ExitPlanMode`, not by a session-called tool

**Date:** 2026-07-25. **Status:** signed off by Wes (Gate-D pause before S7·5).
**Settles:** the [[D44]] open half ("native plan mode lives below the adapter
line" — which side wins). **Evidence:** spike S7·0, all four behaviors green,
live (SDK 0.3.207 / CLI 2.1.220) — `docs/evidence-spike-s7-0-planmode.md`,
fixture `fixtures/plan-mode/exitplanmode.jsonl`.

**The decision.** The planning stage is spawned with `permissionMode:'plan'`.
VIMES intercepts `ExitPlanMode` at the `canUseTool` boundary, captures
`input.plan`, hashes it into the artifact store (S7·4), records the plan against
the task, and **denies `ExitPlanMode` to stop the session cleanly** at the plan
boundary (the spike proved this yields `result:success`, no hang). Plain-prompt +
an explicit `submit_plan` tool remains the **declared but unforced** fallback
(D44) if native plan mode ever regresses.

**Why (spike):** (a) plan mode blocks the work-write *by mode* — free read-only
hardening for planning, not `canUseTool` trust; (b) `ExitPlanMode` fires reliably
headless, payload fixtured; (c) deny-to-stop is clean; (d) `input.plan` (one UTF-8
markdown string) maps losslessly into the plan artifact by hashing its bytes.

**Risks priced at Gate-D:**
- **R-a — ACCEPTED.** Plan mode performs an *ungated* write to the operator's
  global `~/.claude/plans/` (outside the D21 project root). Accepted as harmless
  (operator's own dir, self-cleaning); NOT redirected. Recorded in
  `risk-register.md` R-a.
- **R-b — mitigated by construction.** `ExitPlanMode` input grew a `planFilePath`
  field (drift). The adapter consumes **`input.plan` ONLY**; every other key is
  optional and never propagated (a machine-local path leak). Fixture pins the
  observed shape; re-fixture per CLI bump. `risk-register.md` R-b.

**CONSEQUENCE — S7·5 is re-scoped, and Gate 1 gains NO exposed tool surface.**
Because the plan crosses by VIMES *intercepting* a native tool (`ExitPlanMode`),
**no VIMES-authored MCP tool is exposed to the session for the plan path.** So the
floor-piece-2 machinery D44/`slice-7.md` attached to `submit_plan` — "the first
tool VIMES exposes to a session," per-role **scoped tokens** binding a credential
to `(taskId,stage,attempt)`, and the **hostile-input** profile for a
VIMES-owned tool surface — **relocates to S7·6** (`report_review` /
`report_completion`, which ARE genuinely session-called exposed tools). Net: **S7·5
becomes the native plan-capture path** (SDK-adapter `ExitPlanMode` interception +
artifact-store wiring, its first consumer + a plan-submitted event carrying the
reserved `submitPlanPayloadSchema` shape + a task-record plan reference + the
dispatcher spawning planning in plan mode and transitioning planning→plan-ready),
and Gate 1's minimal loop crosses the plan boundary with **zero VIMES-exposed
tools** — a simplification. The reserved `submitPlanPayloadSchema` (S7·1) is reused
as the **event** payload VIMES emits, not as a session tool input.

## D50 — NO VIMES-dispatched session may spawn sub-agents, in ANY stage or mode; planning additionally investigates inline and emits its plan via `ExitPlanMode` in one bounded turn

**Scope generalized 2026-07-26 (Wes):** the ban is UNIVERSAL, not planning-only.
Every dispatched task session (planning, implementing, review — modes `plan` AND
`default`) fails the SAME way if it fans out: the async `Agent` sub-agents outlive
the parent turn, the session goes dormant/ends, and their results have nowhere to
land. So VIMES denies the sub-agent-spawn tool for ALL dispatched sessions.
**Observed (event log):** the spawn tool is named **`Agent`** (no `Task` seen);
dispatched sessions run in `default` (implementing/review) and `plan` (planning);
the PreToolUse hook fires for the parent's `Agent` call in every mode, so a
mode-independent choke exists. The finding below happened in planning first only
because planning is the first stage the loop reaches.

**Choke point — SPIKE KILLED the first mechanism (2026-07-26); pivoted to
`disallowedTools`.** The spike (`scratchpad/spike-path1-findings.md`, SDK 0.3.207,
3 isolated `query()` runs, ~$1.59) found:
- **KILL: the `Agent` tool BYPASSES the `canUseTool` seam entirely** — a
  `canUseTool` deny is never asked and never fires, in `default` mode *or* `plan`
  mode. Decisive same-mode contrast: in `default` mode the parent's `Bash` DID hit
  `canUseTool` but `Agent` did NOT. So `canUseTool` (where [[D48]] intercepts
  `ExitPlanMode`) is the WRONG choke for sub-agents — the force-prompt run spawned
  2 sub-agents that ran real work with `permission_denials:[]`.
- **GREEN on the rest of Path 1:** with a plan-directed "sub-agents not authorized"
  instruction, the planner investigated INLINE (Bash×3, Read×7), never attempted
  `Agent`, reached `ExitPlanMode` with a real 6111-char plan, and stopped clean
  (`result:success`). So the instruction half works; only the hard mechanism moved.

**New choke point: `disallowedTools: ['Agent','Task']` at every dispatched-session
spawn (SDK `Options`).** The shipped SDK types say a `disallowedTools` entry is
"removed from the model's context and cannot be used, even if they would otherwise
be allowed" and "also blocks harness-internal direct calls that hold the tool
object without a name lookup" — i.e. it closes the exact hole that bypassed
`canUseTool`. A tool that is absent from context cannot be called: no runtime deny
to bypass, no model retry-storm, mode-independent. Both names listed for
CLI-version safety (`Agent` observed today; `Task` historically). **The PreToolUse
hard-deny hook** (S2 footing; `HookPermissionDecision` supports `'deny'`; fires in
all modes) is the belt-and-suspenders fallback. Plan-directed + "sub-agents not
authorized" language is still added to the **planning** briefing; the tool removal
is universal across stages/modes.

**Still to confirm before building (rule 0.7 — `canUseTool` just fooled us, do NOT
trust the doc comment alone):** a quick spike that `disallowedTools:['Agent','Task']`
actually removes the tool and a force-to-fan-out prompt CANNOT spawn a sub-agent.
Then build into the adapter's dispatched-session spawn path.

**SPIKE 2 result — `disallowedTools:['Agent','Task']` is NOT a universal choke
(RED, 2026-07-26).** It removed `Agent`/`Task` by name (0 `Agent` tool_use — the
model even noted the tool "is not actually available"), BUT the force-prompted model
**routed around the block via a DIFFERENT spawn surface, the `Workflow` tool**
(`ToolSearch`×6 hunting for a spawner, then `Workflow` running
`parallel([() => agent(...), () => agent(...)])`) and launched 2 real sub-agents
anyway — `task_started`×1, `task_progress`×26, and the stream hung 74s past
`result:success` while the background children ran. **The problem is not one tool;
it is a FAMILY of spawn/orchestration surfaces** (`Agent`, `Task`, `Workflow`, and
autonomous machinery like `ScheduleWakeup` leaked in too). A name-denylist is
whack-a-mole and drifts (rule 0.6). Sub-finding pointing at the fix: `Workflow` DID
pass through `canUseTool` (unlike `Agent`), and the PreToolUse hook sees `Agent`
(event-log evidence) — so a hook or an allowlist sees more than `canUseTool` alone.

**The real fork (decision pending Wes):**
- **(a) Closed ALLOWLIST** — give dispatched sessions only the minimal worker
  toolset (Read/Write/Edit/Bash/Grep/Glob/ExitPlanMode/ToolSearch/Web*), so EVERY
  orchestration surface — current or future — is excluded by construction, not by
  name. Robust (default-deny, rule-0.6-aligned), no whack-a-mole, and if it removes
  tools from context the model can't even hunt for a spawner. **Open question: does
  the SDK's `allowedTools` RESTRICT availability, or merely pre-approve permissions?
  — must be spiked** (do not trust the doc).
- **(b) Enumerated deny at the PreToolUse HOOK** — the hook fires for every tool in
  every mode (sees `Agent`, which bypasses `canUseTool`), and can return `deny`.
  Deny the spawn family there. Still a denylist (drifts), and a runtime deny the
  model sees and hunts around — but it catches surfaces an allowlist might miss and
  VIMES already runs the hook channel.

Lean: **(a) allowlist**, with **(b) the hook as belt-and-suspenders**.

**DECIDED 2026-07-26 (Wes): BOTH — closed allowlist PRIMARY + PreToolUse-hook
deny BACKSTOP, plus the "sub-agents not authorized" instruction language.** There
is no situation in which a VIMES-dispatched task agent should spawn sub-agents, so
the guarantee is layered: (1) a closed allowlist restricts dispatched sessions to
the minimal worker toolset (every spawn/orchestration surface excluded by
construction); (2) the PreToolUse hard-deny hook catches anything the allowlist
misses (it sees `Agent`, which bypasses `canUseTool`); (3) the initial-message
language tells the planner not to fan out (proven to earn compliance in spike 1).
**Next: spike the `allowedTools` semantics** — does it remove non-listed tools from
context (availability), and with the minimal set + a force-fan-out prompt can the
model reach a spawner by ANY route (incl. `ToolSearch`→load), while the allowed
worker tools + `ExitPlanMode` still function? Then build. (Spend is subscription
usage, capped by the plan — not gated on dollar estimates.)

**SPIKE 3 result — the primary choke is the `tools` option, NOT `allowedTools`
(2026-07-26).** Observed-truth caught a third wrong assumption: **`allowedTools` is
a PRE-APPROVAL (auto-allow) list, not an availability restriction** — with the
worker set in `allowedTools`, the unlisted `Agent` still spawned 2 sub-agents in
both modes. The SDK doc confirms: `allowedTools` = "auto-allowed without
prompting… **To restrict which tools are available, use the `tools` option
instead.**" **CORRECTIVE run (GREEN): `tools: [worker set]`** (Agent/Task/Workflow/
ScheduleWakeup/ToolSearch all excluded) → only `Bash`/`Read` callable, **0** spawns
by any route, **0** `task_*` lifecycle, and the model adapted cleanly ("I don't
actually have an Agent… my available tools are Bash, Edit, Glob, Grep, Read, Write,
WebFetch, WebSearch, NotebookEdit, ExitPlanMode"), investigated inline, `result:
success`. **The three SDK options, disambiguated:** `allowedTools` = pre-approve
(not a choke); `disallowedTools` = removes NAMED tools (brittle whack-a-mole —
`Workflow` escaped it); **`tools` = closed allowlist, base available set, everything
else removed from context = the PRIMARY choke.** PreToolUse hook remains the
backstop. **Final residual confirm before building:** `tools`-restricted + plan
mode + a PLAN-DIRECTED prompt → does `ExitPlanMode` still fire cleanly under the
restriction (it is in the worker set; spike 1 showed it fires with a plan-directed
prompt, corrective showed `tools` works — this confirms the exact combination).

**MECHANISM CONFIRMED — READY TO BUILD (2026-07-26, final spike GREEN).** Plan mode
+ `tools:[worker set]` + a plan-directed prompt → `ExitPlanMode` fired with a real
5933-char plan, **0 spawns by any route** (Agent/Task/Workflow/ToolSearch/
ScheduleWakeup all 0, 0 `task_*` lifecycle), only worker tools callable, clean
deny-to-stop (`result:success`, no hang). With the default-mode corrective, `tools`
is confirmed for BOTH planning and implementing. Spike series complete
(`scratchpad/spike-path1-findings.md`, 4 rounds). **The build:**
1. **Primary choke:** set `tools: [<worker set>]` on every dispatched-session spawn
   (SDK adapter) — Read/Write/Edit/Bash/Grep/Glob/ExitPlanMode/WebFetch/WebSearch/
   NotebookEdit/TodoWrite (exact set a build-time design detail; every spawn/
   orchestration surface excluded by construction).
2. **Instruction language (load-bearing):** the planning stage briefing must
   explicitly request an approvable plan via exit-plan-mode + state sub-agent use is
   not authorized (spike 3 proved a non-plan-directed prompt makes the model skip
   `ExitPlanMode`). This is the planning analogue of S7·7a's implementing briefing.
3. **Backstop:** PreToolUse hard-deny hook on the spawn family (defence in depth).

**Build caveats surfaced by the spikes:**
- **`AskUserQuestion` still injects in plan mode despite `tools`** — it is an
  interactive dialog (not a spawner), fails headless, and the model self-recovers,
  but it briefly stalls the turn. The dispatcher should auto-handle it (deny/answer)
  so a dispatched turn is never blocked on a human dialog. Minor robustness item.
- **Plan-draft `~/.claude/plans/` write persists** (ungated, outside project) —
  already `risk-register.md` R-a (accepted).

**BUILD-TIME REFINEMENT (2026-07-26, S7·5c — orchestrator, pending Wes review).**
The build ships items 1 + 2 as specified. Item 3, the backstop, is **refined**:
the originally-sketched *PreToolUse hard-deny hook* would have to return its deny
decision back to the SDK through the existing `curl` hook-relay's stdout — an
**unverified** SDK path (does 0.3.207 parse a PreToolUse deny returned that way?
which JSON shape?). Building against it now would violate rule 0.6 (no reliance on
an unspiked external surface), and the `tools` closed allowlist is already
spike-proven airtight (0 spawns by any route, both modes). So the shipped backstop
is **`disallowedTools: ['Agent','Task','Workflow','ScheduleWakeup']`** on every
dispatched spawn — an *in-SDK, verified* mechanism (round-2 spike observed it
removes named tools; the four names cover every spawn surface the spikes found).
It is redundant with `tools` today but gives rule-0.6 drift resistance if a future
SDK reinterprets `tools`. **The PreToolUse-relay hard-deny hook is DEFERRED to its
own spike** (would it even fire before the model, and does the relay carry a deny?)
and is not needed while the primary choke holds. Also shipped: the AskUserQuestion
auto-deny for dispatched sessions (the caveat above), scoped to dispatched sessions
so interactive sessions keep their normal gate. **Reversible:** if Wes wants the
relay hook, it is a clean follow-up spike + unit on top of this.

**DEFERRED QUESTION RESOLVED (2026-07-26, auto-mode spike — `scratchpad/spike-automode-FINDINGS.md`).**
The deferred backstop question — "does the SDK honor a deny returned through our
PreToolUse hook relay's stdout?" — is answered **YES**, verified by side effect
(the denied `Write`/`Bash` never ran; both landed in `permission_denials`), under
BOTH `permissionMode:'auto'` and `default`, on our real SDK path (0.3.207). So the
PreToolUse hard-deny hook IS a viable boundary floor after all — it just wasn't
NEEDED for D50 (the `tools` clamp already suffices). It becomes load-bearing in the
NEXT footing change: the `auto`-mode direction for dispatched sessions (QUEUE.md S2,
SPIKED #3) relies on exactly this hook as the boundary floor Anthropic's classifier
can't provide. The D50 `disallowedTools` belt stays as-is; the hook arrives with the
auto-footing build, not as a retrofit here.

**Date:** 2026-07-26. **Status:** decided by Wes at the Gate-1 human exit gate;
**Path 1 chosen, pending a confirming spike** before it is built on. Moved here from
`open-questions.md` D50 (the finding).

**The finding (first real run of the Gate-1 loop — task `347c4cc8`, project
`1e9999`, session `4a1ef2ee`, observed from the event log).** A planning session
spawned in `permissionMode:'plan'` launched **3 async `Explore` sub-agents** via the
Agent/Task tool, ended its turn with *"I'll wait for the exploration agents to
report back,"* and went **dormant** — a sub-agent's `Read` fired ~2s AFTER the
parent went dormant, proving the async children outlived the parent turn.
**`ExitPlanMode` was never called** (0 times), no plan was captured, and the task is
stuck in `planning`. Root cause is two-part: (1) the planning stage still gets the
GENERIC spawn instruction — it is never told to produce and submit a plan; and
(2) a VIMES-dispatched SDK session that completes its turn goes dormant with no live
turn for the async sub-agents' notifications to land in, and nothing resumes it, so
`ExitPlanMode` is never reached. No orphaned OS processes (the session ended); the
failure is convergence, not resource. This is independent of [[D48]]'s capture
machinery (which is correct) — it lives in the *assumption* that the planner reaches
`ExitPlanMode`.

**The two paths considered (both recorded per Wes):**
- **Path 1 (CHOSEN) — deny sub-agents in dispatched planning.** Intercept the
  Agent/Task tool at the SDK-adapter `canUseTool` seam (the same seam [[D48]] uses
  for `ExitPlanMode`) and deny it, AND add language to the planning-stage
  instruction that sub-agent use is not authorized. The planner investigates inline
  within one bounded turn, then emits its plan via `ExitPlanMode`.
- **Path 2 (REJECTED) — persist the session until sub-agents report.** Keep the
  session alive until its async sub-agents check in, then resume it to assemble the
  plan and emit `ExitPlanMode`.

**Why Path 1.** Path of least resistance and the right fit for the dispatch model.
Path 2 means patching a headless SDK query to stay live for background-agent
check-ins — which (a) may not even be possible headless (the notification-resume
mechanism is an interactive-REPL affordance; feasibility is unknown, rule 0.7),
(b) requires a sub-agent-lifecycle liveness model VIMES does not have (liveness
tracks sessions; sub-agents are invisible below that line — a new stateful surface
over an uncontrolled SDK behavior, rule 0.6), and (c) reintroduces the open-ended
liveness (a hung sub-agent holds the session open) that [[D48]]'s clean
deny-to-stop boundary was designed to avoid. Sub-agent fan-out is an interactive
affordance that does not fit fire-and-capture dispatch. If planning quality on large
codebases ever proves inadequate under the inline constraint, THAT is the trigger to
revisit Path 2 — and only after a spike proves headless resume-on-notification works
at all.

**Open sub-choice for the spike:** deny **all** Agent/Task fan-out in planning
(simplest, safest — the chosen default) vs. deny only **async/background** sub-agents
(a synchronous sub-agent completes within the parent turn and would not orphan). Lean
deny-all; the spike confirms the deny mechanics and whether the distinction is even
detectable at the `canUseTool` gate.

**Next:** a confirming spike (isolated SDK sessions, never prod `vimes.service`,
rule 0.7) — does denying the Agent/Task tool at `canUseTool` + a plan-directed
instruction make the planner investigate inline and reach `ExitPlanMode` cleanly?
Findings + fixture bank like S7·0 before this is built into the dispatcher/adapter.

## D52 — Un-defer the exposed-tool (in-process MCP) channel; `report_review` is its first customer — DECIDED 2026-07-26

**Decision (Wes).** VIMES exposes its first session-callable custom tool. D48 had
re-scoped away the `submit_plan` MCP surface in favour of native `ExitPlanMode`, and
MCP was parked as a `design-directions.md` horizon item — but S7·6 (independent
review) needs a dispatched session to hand back a STRUCTURED per-criterion verdict,
and there is no native tool that carries that shape (the map confirmed ZERO exposed-
tool infra existed). Three upcoming units need the same "dispatched session →
structured payload → VIMES" channel (`report_review`, `report_completion`'s worklog,
and the future abort-and-flag / orchestrator tools), so it is foundational, not a
one-off. Un-deferred with conviction; "deferred" was never "forbidden."

**Spike-confirmed mechanism (`scratchpad/spike-s7-6-FINDINGS.md`, SDK 0.3.207, rule
0.6/0.7 — orchestrator re-verified against raw transcripts).** In-process MCP via
`createSdkMcpServer` + `tool()` mounted on the query's `mcpServers`:
- **Orthogonal to the D50 `tools` clamp** — the clamp filters BUILT-IN tools only;
  the MCP tool rides in via `mcpServers` regardless, needs NO allowlist entry, and
  **opens no spawn hole** (0 spawns under a force-fanout prompt; `ToolSearch` stays
  absent). This is the load-bearing clean result.
- **Captured in the tool HANDLER** (in-process), NOT `canUseTool` — under
  `permissionMode:'auto'` (the dispatched footing) `canUseTool` is bypassed for the
  MCP tool but the handler still fires. So capture lives in the handler.
- Model calls it reliably; payload schema-valid; clean stop on a normal result.

**As built (S7·6a core + S7·6b daemon, 2026-07-26).** 6a: `review_reported` event
(payload = `reportReviewPayloadSchema` verbatim), pure `deriveReviewOutcome`
(all-pass+full-coverage → `done`; any fail / incomplete → `implementing`; bare task →
`done`), and the review-stage briefing branch (renders criteria WITH ids, directs the
`report_review` tool). 6b: exposes `report_review` via `createSdkMcpServer`/
`mcpServers` on dispatched sessions (SDK imports stay ONLY in the query factory — the
adapter passes a plain tool-spec through `SdkQueryOptions`, factory wraps it), captures
in the handler → `recordReview` (mirror of `recordPlan`: reverse-lookup a `review`
sessionRef → emit `review_reported` → propose `review→done`/`review→implementing` via
the `taskWriter` I7 choke). The review loop is now end-to-end.

**Two findings surfaced building it (rule 0.1), both at the core↔daemon schema seam:**
1. **6a — `schemas.ts` leaf cycle.** The `lastReview` fix-seed field could not import
   `reportReviewPayloadSchema` (schemas.ts is the leaf; workOrder.ts → schemas.ts).
   **Resolved: `lastReview` + its projection fold DEFERRED to S7·7b** (its only
   consumer, rule 0.5), which will also resolve the schema-location (likely hoist the
   payload schema into the leaf) at that point. The review loop works without it
   (transition derives straight from the event payload).
2. **6b — zod v3/v4 boundary.** Core validates with zod **v3**, the daemon + Agent SDK
   use zod **v4** (the split `taskApi.ts:92` already documents). Reusing core's schema
   object in the daemon throws at runtime (invisible to CI). **Resolved: the tool's
   input shape is RESTATED in daemon-v4 zod and BOUND to core by a two-way `satisfies`
   type-check** (`taskApi.ts` boundary discipline; the drift-guard was verified by
   breaking). Caveat: catches structural drift, not future value-level tightening.

**Recurring-seam note (candidate future cleanup, not blocking):** two findings this
session both stem from **core sharing zod-schema objects across the v3/daemon-v4
boundary**. Worth a deliberate pass someday — align zod versions, or formalise the
"restate-and-type-bind at the boundary" discipline as the standing rule.

**Deferred to S7·7b:** `report_completion` (the worklog fix-seed producer) + the
`lastReview`/`lastCompletion` folds + the fix-seed composition (the consumer). Only
the review path shipped here; `report_completion` waits for its consumer (rule 0.5).

## D53 — The movement taxonomy: promotions are DECISIONS, reports are OUTCOMES, dispatch is MECHANICS; review is a holding pen — DECIDED 2026-07-27

*(Wes, planning S7·7b, the morning after the first full live loop. Settles the
"how much automation" question for the whole task layer, ahead of the
orchestrator (S7·9).)*

**The frame (Wes).** VIMES is not a conveyor belt — it is a **task-dispatcher
layer that the orchestrator will use exactly the way the orchestrator's own
Agent tool is used today**: the mechanism (spawn, capture reports, record) is
automated; the judgment (what advances, what gets reviewed, what bounces) is
not. The target loop: orchestrator chats with Wes to create backlog tasks →
priorities promote into planning → planning dispatches immediately → plan
reported → plan-ready → orchestrator reviews the plan (consult Wes or promote)
→ implementing dispatches immediately → completion reported → review →
orchestrator decides: dispatch an independent reviewer OR bounce to
implementing with specific fixes → verdict → done → orchestrator tells Wes
what landed.

**The taxonomy.** Three kinds of stage movement, owned differently:
1. **Promotions — decisions.** `backlog→planning` (priority) and
   `plan-ready→implementing` (plan approval). Orchestrator's job (human today).
2. **Outcomes — reports.** The work reporting its own state:
   `planning→plan-ready` on plan capture (built, D48),
   **`implementing→review` on `report_completion` (this decision — S7·7b
   builds it)**, `review→done/implementing` on the `report_review` verdict
   (built, D52). Proposed by the dispatcher through the I7 choke, always.
3. **Dispatch — mechanics.** Entering an ACTIVE stage starts the work:
   *"Why would you move it to Implementing and NOT want it to begin
   implementation? The promotion should be the decision. No task moves to an
   active stage unless it's ready to begin."* So planning and implementing
   **dispatch-on-promotion** (queued as its own unit, after S7·7b). **Review
   is deliberately NOT an active stage — it is a holding pen**: entering it
   auto-dispatches nothing; the orchestrator (human today) chooses reviewer vs
   bounce. **No chaining**: a completion report never auto-dispatches a
   reviewer.

**Rider — D46 fix-seed refinement (diff on-disk, not inlined).** D46's fix-seed
lists "the prior attempt's diff". Decided: the fixer is directed to **read it
from disk (`git diff` in its own cwd)** rather than the dispatcher inlining
diff text into the briefing — zero prompt bytes, never truncated, never stale.
A refinement of D46's carrier, not a reversal of its content: the fixer still
HAS the diff; the briefing carries review feedback + worklog inline (small
structured data with no on-disk home) and points at the diff.

## D54 — The per-task in-flight dispatch lock: D53's sharper exposure carries its own guard — DECIDED 2026-07-28

*(Settled by S7·7c, the dispatch-on-promotion unit — exactly the trigger the
open question named. Moved from open-questions.md D54.)*

**The hazard, restated.** D46 made every stage run a fresh spawn, which left
`decideDispatch`'s `already-running` refusal as the ONLY double-dispatch guard
— and that refusal is derived from the task's own `sessionRefs` against live
processes, so it cannot fire until `task_session_attached` has LANDED. Since
step 8 there is an `await` between the decision and that event (worktree
creation is a subprocess); a second attempt arriving inside the window sailed
through to a second live session on one task. Tolerable while dispatch was
human-clicked; S7·7c makes dispatch machine-initiated (a promotion is a
dispatch), which is precisely the sharpening the open question predicted.

**Decided: the lean, as leaned — a per-task in-flight lock in `TaskDispatcher`,
built into the same unit that created the exposure.**

- `inFlightDispatches: Set<string>`, claimed in `dispatchTask`'s SYNCHRONOUS
  prefix (after the unknown-task lookup, before the decision), released in a
  `finally` so every path — refuse, defer, spawn, worktree-failed, spawn-threw
  — releases. Correctness rests on the single JS thread: no `await` stands
  between check and claim.
- The loser returns a NEW `in-flight` execution outcome: a sibling of
  `spawn-failed` / `worktree-failed`, NOT a `DispatchRefuseReason` (the
  decision function never saw the attempt — a `dispatch_refused` record would
  claim a judgment that never happened), and SILENT like `defer` (nothing
  happened; the concurrent attempt's own result is the record).
- NOT the alternative lean (`already-attached-live-session` inside
  `decideDispatch`): in-flight-ness is process state — live promises in one
  daemon — not projection state, so a pure replayable function can never see
  it. This is the one recorded exception to "WHETHER-ifs belong in
  `decideDispatch`", and the module header now says so.
- What it does NOT guard, recorded: another process. In-memory, cleared by
  restart (correctly — the promises died with the process). No scheduler, no
  cross-process lease. The post-attach guards (`already-running`, I11 on the
  human resume path) are unchanged and still do the other half of the job.

Verified by breaking: disabling the check, widening the promoter match to
`!== 'dispatcher'`, and deleting the `finally` each redden their own distinct
test set (agent's three sabotages + the orchestrator's independent route-level
inversion, which reddened exactly the seven guard-measuring cases in both
directions).

## D55 — Report tools are OFFERED per stage, not to every dispatched session: exposure is not free under plan mode — DECIDED 2026-07-28

*(Settled by S7·7d. A recorded reversal of the exposure half of D52's build —
the sessionHost comment that argued both-tools-everywhere was "deliberate
rather than lazy".)*

**The observed incident (rule 0.7 — this is why the reversal earned its
record).** 2026-07-28, task `25f9c558`, planning session `f35a77dd`: the
planner finished capturing its plan and then called `report_completion`. Under
D48 planning runs `permissionMode: 'plan'`, and in plan mode the SDK routes
MCP tool calls through `canUseTool` — so the call FIRED A HUMAN GATE. Wes was
attending and approved it; the dispatcher guard then correctly no-opped the
report (no `implementing` sessionRef). Unattended, that gate is a stall: a
fleet planner waiting forever on an approval nobody will give. The johnny run
could not have shown this — its auto-mode legs bypass `canUseTool` for MCP
tools entirely; the asymmetry only appears in plan mode.

**What was reversed, and what deliberately was NOT.**
- REVERSED: the OFFER. `spawnSession` now carries the dispatched `stage`
  (threaded dispatcher → host → SDK spawn context), and the adapter offers:
  planning → NOTHING (its deliverable travels via ExitPlanMode; an offered
  tool under plan mode is a gate); implementing → `report_completion` only;
  review → `report_review` only; stage absent/unrecognized → both (fail-open-
  to-guarded — a plumbing bug must not silently remove the loop's only way to
  finish; unreachable from `dispatchTask` today).
- NOT REVERSED: the GUARD. `recordReview` / `recordCompletion` still adjudicate
  against the task's real sessionRefs and still no-op a wrong-stage caller.
  The old comment's argument — the dispatcher, where the task record lives, is
  the authority — was half right, and that half stands as defense in depth.
  What it missed is that exposure has a COST independent of the guard.
- UNTOUCHED: tool names, input shapes, handler bodies, acknowledgement strings
  (verbatim), the MCP server mechanics, and all gate behavior — the fix is
  what is offered, never how a call is judged.

Old sessionHost tests pinning both-tools-everywhere were repointed to the new
map (the deleted case's schema/order assertions live on in the no-stage
fallback case). Verified by breaking on both sides: the agent forced planning
back to both tools (reddened exactly the planning-has-none case); the
orchestrator cross-wired review to the completion spec (independent sabotage,
snapshot-restored).

## D56 — The orchestrator is a STANDING PER-PROJECT ENTITY the daemon maintains, never "just another session" — DECIDED 2026-07-29

*(Wes + Fable design pass, mid-slice-7 phase two. Supersedes the S7·9 skeleton's
`role: 'orchestrator'` spawn-option approach before any of it was built — recorded
here as considered-and-rejected. This decision re-frames slice 7's phase two into
slice 8; see `slice-8.md`.)*

**Wes's framing (the spec, verbatim in spirit):** the orchestrator is a global
top-level chat interface that persists without parking, because it will do the job
the CLI orchestrator (Fable) does now: the human opens a project and talks to ONE
persistent interface; that interface authors work orders, dispatches targeted
agents, checks results, keeps the books. "It will be you, running in a slightly
different window."

**The identity model (the crux).** No transcript persists forever — context fills,
compaction is lossy, long transcripts accumulate sediment. What CAN persist is what
already persists for the CLI orchestrator: **durable state — the event-sourced
board, the project's doctrine docs, and a standing-notes anchor — with the
transcript as a rotating vessel around it.** The park/resume ritual the CLI
workflow performs by hand becomes a SYSTEM PROPERTY: every (re)founding of the
orchestrator's transcript opens with a composed re-anchoring briefing built from
durable state, so continuity is a property of the entity, not of any one process.

**What "maintained by the daemon" means:**
- **Singleton per project** (D42's declared boundary is the key). Not spawned from
  a session list — maintained: the daemon respawns/resumes it across restarts.
  This also defuses the recursion hazard (a deploy that kills the orchestrator's
  process is recoverable by construction — it re-anchors on respawn).
- **Excluded from the ordinary session surfaces.** It gets its own top-level chat
  surface bound to the global project pointer (design-directions' "home =
  project/orchestrator view"), while remaining a Claude process under the hood.
- **Verbs are GRANTS on the standing entity** — author (`create_task`) first;
  promote / dispatch / review / amend later, each individually revertible
  (unchanged from the phase-two plan). Board events delivered to it as turns (the
  orchestrator reacting to completions/verdicts) is the FAR grant: the seam is
  reserved, nothing is built.
- **Propose-never-transition from birth** (principle 10 / I7): its tools call the
  sole writer's proposal paths; nothing it does moves the board until a drive
  verb is deliberately granted.

**Sequencing consequence.** A standing per-project entity cannot be built before
"project" is first-class: **D42's build (registry + picker + global project
pointer) is a prerequisite, not a parallel track.** Slice-8 order: D42 build →
orchestrator foundation → author grant → Gate-2 authorship trial (the ~10-task
pivot criterion carries forward unchanged).

**What survives from the rejected S7·9 skeleton** (so the thinking isn't lost):
the in-process tool-exposure seam (D52's channel), in-run payload validation
(retry locality), server-side forced project binding (the tool can never author
across the project fence), the text-only criteria shape (ids minted server-side),
the `task_commented` reservation, and the briefing-composer pattern — all of it
moves into the standing-entity frame intact.

## D57 — The orchestrator transcript lifecycle: capture-then-compact via hook, with agency and escalating nudges — DECIDED 2026-07-29 (mechanics ⟨tune⟩, spike-gated)

*(Wes, same design pass as D56 — his lived numbers from months of driving the CLI
orchestrator, recorded as the design bands. Rule 0.7 applies to the mechanics:
hook behavior is classified by observation before anything is built on it.)*

**The policy.** The transcript problem D56 names is solved with a **compaction
hook at a reasonable token threshold (~⟨tune⟩ 250–300k)**: before compaction, the
orchestrator performs a precompaction capture (the `/precompaction` discipline —
flush context-only state to its standing notes / durable docs), THEN compacts.
Capture-then-compact makes compaction lossless-in-practice: what the summary
drops was already banked.

**Agency (deliberate).** The orchestrator may DELAY compaction when it is about
to land something — mid-test, mid-feature, mid-verification — rather than being
interrupted at a mechanical threshold. The hook nudges on an **escalating
series** (so it isn't constantly firing): gentle at the threshold, firmer as fill
grows. Wes's lived bands, recorded with their assumption (CLI workflow, one
orchestrator, heavy tool traffic): **keep fill generally below ~40%; up to ~60%
is acceptable when rolling hot.** These are design bands, not FAIL-able
assertions — Gate-D applies before any of them is pinned in a test.

**Spike rows this creates (front-loaded into slice 8, rule 0.6/0.7):**
1. **PreCompact-hook observed behavior** — does the runtime's compaction hook
   fire where documentation claims, and what can it actually see/do there?
2. **Deferability** — can a hook DELAY/decline compaction (the agency mechanism),
   or must the nudge live a level up (e.g., VIMES watching context fill from
   stream events and messaging the orchestrator)? Build on whichever is OBSERVED
   to work; the fallback (VIMES-side nudges) is acceptable and may be preferable
   (it keeps policy in VIMES rather than in runtime hook semantics).
3. **Resume-across-restart fidelity** — the D56 respawn path leans on session
   resume surviving daemon restarts; verify the re-anchor + resume combination
   on a real transcript before the foundation unit builds on it.

## D60 — Project declaration is CONSTRAINED WITHIN `VIMES_PROJECT_ROOTS` — DECIDED 2026-07-29

*(Wes, at the S8·1 gate. This is D42's one explicitly-deferred sub-decision —
"the only piece not settled here, and it gates the work order" — now settled as
the lean.)*

Declaring a project does NOT extend the file/git allow-list. D21's
`VIMES_PROJECT_ROOTS` stays the safety fence; the picker may only declare
directories inside it (validated against the STATIC config roots, not the live
session-cwd union — a session's transient cwd is not a declarable boundary).
Widening the fence remains a separate, deliberate act (`/etc/vimes/env` edit +
restart), never a side effect of clicking in a picker.

## D61 — URL shape: the PATH carries the project, the HASH carries the view; localStorage carries last-layout — DECIDED 2026-07-29

*(Wes + Fable, during S8·2 design. This REVISES one consequential detail of D42
— "the hash gains a project segment" — which is why it is a new entry rather
than an edit: the hash does NOT gain a project segment; the path does.)*

**The shape:**
- `<vimes-host>/` → the project picker (D42's landing).
- `<vimes-host>/infrastructure/johnny/` → the johnny project, restored
  to its last layout (per-project panel-stack memory in localStorage).
- `<vimes-host>/infrastructure/johnny/#/session/<id>` → a deep link
  inside that project's scope; a present hash overrides the remembered layout.
- One tab = one project, visible in the URL bar; history and bookmarks work.

**Identity:** the path segment is the project root RELATIVE TO
`VIMES_PROJECT_ROOTS` — well-defined because D60 constrains declaration within
the roots; nested projects nest naturally in the URL.

**Why path over the alternatives considered:** a `?folder=` query param
(code-server's shape) exists because code-server could not own its URL space —
it is verbose and leaks absolute filesystem paths into shareable URLs; a
hash-only segment crams project and view stack into one namespace. The path
shape subsumes the `?folder=` affordance Wes actually valued: hitting a
project URL directly IS bypassing the picker.

**Resolution rules:** pathname resolved against the DECLARED registry (D42 —
never inferred). Unknown path or bare `/` → picker. A path inside the roots
but NOT yet declared → picker with "declare this?" pre-filled (the URL as an
onboarding door). The view stack machinery (buildHash, panel stack) is
untouched — it just roots per project.

**Cost accepted:** the daemon grows a SPA fallback route (any non-/api,
non-asset GET serves index.html — Vite assets are absolute so nothing breaks
under a prefix), which makes S8·2 a daemon-touching unit (restart on deploy),
no longer UI-only.

## D64 — S8·4 capture-then-compact mechanism: the hook holds the door (exit-2-only), the daemon nudges early — SIGNED OFF 2026-08-04

*(Wes, 2026-08-04: "Sign off on the S8·4 Gate-D mechanism as written." This is
the Gate-D sign-off the slice-8 plan paused on; the mechanism is the
SP8·1-recommended shape recorded in slice-8.md S8·4, adopted verbatim.)*

**The mechanism (D57 made operational):**
- **The PreCompact hook is the DOOR.** While the orchestrator's state is
  unbanked, the hook vetoes compaction via **exit code 2 only** — never a JSON
  decision, which SP8·1 observed to be accepted-and-silently-ignored (the
  risk-register row re-verifies exit-2 semantics per CLI bump). Once banked, it
  exits 0. Because the hook runs to completion BEFORE summarization, a
  synchronous file-level bank needs no veto at all — the veto exists for
  banking that needs a MODEL turn.
- **The daemon NUDGES early, so the veto rarely fires.** At the ⟨tune⟩
  thresholds the daemon injects escalating nudges into the orchestrator's
  session off `latestContextTokens` (already folded in cacheObservability;
  per-turn granularity — fill is known between turns, never mid-turn). The
  orchestrator keeps its D57 delay agency: it may finish landing work before
  capturing; the door holds while it does.
- **Banked state re-enters** via the session's own standing notes and/or a
  `SessionStart:compact` hook (observed to fire) — PreCompact itself CANNOT
  inject context (SP8·1).

**What is signed vs what remains open (Gate-D discipline):**
- SIGNED: the mechanism shape above.
- **NOT pinned:** thresholds (⟨tune⟩ ~250–300k) and the <40% general / ~60%
  rolling bands remain DESIGN BANDS — recorded with assumptions, never
  FAIL-able assertions, until calibrated against real orchestrator sessions.
- **NOT adopted (v1):** the strongest form (`DISABLE_AUTO_COMPACT=1` +
  VIMES-driven deliberate `/compact`) stays optional/parked — the env var is a
  rule-0.6 fragile surface needing a boot canary if ever adopted.
- **Open spike-row before LONG deferral is relied on:** sustained veto in a
  single long-lived process (auto-compact re-offer was observed across
  processes; `tengu_auto_compact_circuit_breaker` strings exist in the binary,
  behavior unverified). The early-nudge design deliberately makes long
  deferral rare rather than depending on it.

## D58 — Orchestrator sessions run permissionMode 'auto' — DECIDED 2026-08-04

*(Opened 2026-07-29 at the S7·9→slice-8 reframe; settled at S8·6's Gate-D pause
as planned. Wes chose the lean.)*

The standing orchestrator's session (spawn AND resume paths) runs `'auto'`:
`create_task` proposals flow gate-free. Rationale: the board PROMOTION is
already the human approval — gating the proposal too is approving twice; and
D55's observed evidence says MCP tools bypass `canUseTool` anyway, so an
interactive mode would gate the built-in tools while the VIMES verbs flowed
free — the worst of both. Nothing runs until Wes promotes from the board.
**Revisit trigger:** authored-task volume makes un-gated creation noisy.

## D65 — VIMES-native tools mount under verb-family servers: `vimes_board` joins `vimes_report` — DECIDED 2026-08-04

*(The walk-2 tool-confabulation finding's naming half — Wes leaned "prefix all
Vimes tools or call out specific names"; decided at S8·6's design pass.)*

MCP tool names compose as `mcp__<server>__<tool>`, so the server IS the prefix.
The convention: **one server per verb family, named `vimes_<family>`** —
`vimes_report` (stage-run report tools, unchanged bytes) and now `vimes_board`
(orchestrator board verbs; `create_task` first, future drive verbs join it).
The model therefore sees `mcp__vimes_board__create_task` — structurally
VIMES-prefixed, and the family separation mirrors the exposure matrix: a
server the doctrine doesn't grant simply isn't mounted. The founding
briefing's "your tools today" section ADDITIONALLY enumerates the exact names
(belt and braces against confabulation — the walk-2 finding).

## D68 — AskUserQuestion answers reach the model by injecting `answers` into `updatedInput` on allow — DECIDED 2026-08-05

*(Opened and settled same day. The first orchestrator-authored work-order
(`2b8c00ec`, AskUserQuestion multi-option support) surfaced the question; an
orchestrator spike drove the real SDK and pinned the contract; Wes signed. The
build slice is scope B — full single-call fidelity.)*

**The bug this answers.** `AskUserQuestion` reaches VIMES through the SDK
`canUseTool` permission callback — the same channel as "may I run `rm`?" — and
VIMES collapsed it into the binary allow/deny gate. On allow,
`respondInteraction` returned `{behavior:'allow', updatedInput:<the original
question>}`: it granted the tool permission to run but injected **no selected
answer**, so the tool executed with nothing chosen and the model got an empty
result. That is the observed "approved but returned no data."

**The contract (observed, rule 0.7 — spike 2026-08-05, two runs, driving
`@anthropic-ai/claude-agent-sdk` directly, isolated from `vimes.service`):**
- Input via `canUseTool` for `AskUserQuestion`:
  `{ questions: [ { question, header, options:[{label,description}], multiSelect } ] }`,
  1–4 questions. `options.title` is **undefined** for this tool (so the daemon's
  current `prompt = options.title` fallback already misfires on it).
- **Answer delivery:** return
  `{ behavior:'allow', updatedInput:{ ...input, answers: { [questionText]: string } } }`.
  The SDK-vendored built-in tool then emits the tool_result
  (`"Your questions have been answered: \"<q>\"=\"<value>\"…"`) and the model
  receives it. `answers` is keyed by the **question text**; each value is a
  **string**.
- **multiSelect** value = the selected labels joined with `", "` — this join is
  **VIMES's choice**, not an opaque external contract (the tool echoes the string
  verbatim). **"Other"** free-text value = the typed string. Both flow through the
  same string-valued `answers` channel.

**What is signed vs what remains open (Gate-D).**
- SIGNED: the input shape and the answer-injection mechanism above, as the
  grounding the build slice rests on.
- **NOT yet proven under production spawn:** the spike ran with
  `permissionMode:'default'` + a bare `canUseTool`, **not** the daemon's real
  spawn options (closed allowlist, spawn-family denylist, MCP report servers,
  hook env, `settingSources`). The contract is very likely stable but this is an
  external surface (rule 0.6) — the work-order's **first acceptance step**
  re-confirms it under daemon-identical spawn, and its **kill criterion** halts
  the slice to a finding if it does not hold (re-spike; if the SDK offers no
  supported answer channel through `canUseTool`, escalate to a design call —
  e.g. intercept `AskUserQuestion` as a client-side tool). Tracked as a
  fragile-adapter row in `risk-register.md`.

## D69 — Gate-2 verdict: PASSED. The task machine authors real work without human rewrite; drive verbs unlocked; slice 8 CLOSED — DECIDED 2026-08-05

*(Wes's call, same day as trial task 3's completion.)*

**The criterion and the evidence.** Gate 2 (carried verbatim from slice 7's
phase-two criterion) asked: do orchestrator-authored work orders need
substantial human rewrite more often than not? Verdict on a three-task
sample: **0/3 rewrites, and the quality rose as the difficulty did.**
- Task 1 (`0dc79a84`, clean feature, johnny): 8/8 review PASS attempt 1.
- Task 2 (`ad148cd0`, refactor in a deliberately dirty tree, graded blind):
  6/6 PASS attempt 1; the plan pre-applied the kill criterion's partial
  fallback; every layer fenced foreign uncommitted work unprompted.
- Task 3 (`2b8c00ec`, VIMES building VIMES — the recursion milestone): the
  orchestrator spiked the external contract ITSELF before authoring (D68),
  9/9 PASS attempt 1, deployed and production-confirmed the same day by the
  very session whose failed question was the originating finding.

**The sample-size rationale (Wes, banked in the trial log 2026-08-05):** the
planned ~10 tasks assumed synthetic stressor categories (vague asks,
find-the-bug). Skipped deliberately — those grade the MODEL, which is the
same model already doing that work elsewhere; the trial's question was the
HARNESS (schema, doctrine, routing, verdicts), and three end-to-end loops of
escalating difficulty answered it. Findings 1–6 were process discoveries,
none halting, all logged with owners.

**Consequences.**
- **S8·7+ drive verbs (promote/move/dispatch/amend) are UNLOCKED** — built
  one individually-revertible grant at a time, each work order carrying the
  herdr skill-file discipline and the principle-13 check (no
  decision-asserting parameters).
- **Slice 8 is CLOSED.** Two organic live exits carry forward as standing
  watch items, deliberately NOT blocking (Wes: "I'm not holding up dev work
  for them"): the S8·4 compaction gate's first real 250k/275k/300k crossing,
  and the 502 unit's observed reconnect ride-through. Housekeeping rides
  alongside: CLI 2.1.222 fixture shape-check + `VIMES_EXPECTED_CLI_VERSION`
  bump; D#-allocation-checks-both-files into the founding briefing (rides
  the S8·7 briefing edit).
- Slice 9 (D51 node-kit design pass) is next, inputs staged: D62 ACP read,
  D66/D67, the herdr manifest shape, books as second tenant.

## D70 — VIMES is a pure session engine; all workflow is extension content — DECIDED 2026-08-05

*(Wes's reassessment at slice-8 close, signed same day. Supersedes D69's
placement of the drive verbs — not their unlock: the Gate-2 validation
stands; what changed is where validated capability lives.)*

**The shape.** The engine ships session-handling architecture only: process
custody, the event spine, persistence, projections, gates/attention, auth,
and **session trees** — worktree-backed child sessions with git-checkout
provenance, grouped under a parent, per the herdr model (primary source
local in `docs/decomposition/references/herdr/`; this one design also
answers trial findings 1 and 5). The engine makes **zero assumptions about
how people work** — candidate design principle #16, to be ratified in the
slice-9 pass.

**What moves out.** The task machine — board, stages, dispatch, review —
becomes a **genuine extension**: the engine ships workflow-free and the
task system drops in like any tenant. The ex-S8·7 drive verbs are extension
content, arriving with the workflow extension that needs them, never engine
grants. The 0.3/principle-13 line is absolute: extensions propose, the
engine's deterministic core decides; an extension crash can never corrupt
or stall engine state.

**The tenants.** First: the task machine (migrating). Second: **Book
Genesis** (`~/projects/content/book-genesis`) — a real repo whose skills,
agents, and gates map directly onto stage briefings, performers, and
acceptance shapes. Third consumer at design time: the drive verbs. The
extension-authoring method is written FROM these worked examples, never
before them.

**The clients.** Web and terminal open VIMES as co-equal first-party
consumers of the same daemon API (#15 — no second SDK), loading each
project's declared extensions. Any capability reachable only through one
client is a bug against #15.

**Explicitly out of engine scope:** transcript-level conversation forking
(banked as a possible future enhancement; the session-tree primitive must
not preclude it, nothing designs for it).

**Consequence for the plan.** Slice 9 is redefined as the
**extension-engine design pass**, absorbing the D51 node-kit pass: D66
(boundary tiers) and D67 (trust) decided inside it; the extension manifest
and per-project declaration schemas reserved (0.5); the task-machine
migration map and drive-verb drop-in spec produced; migration sequencing
(seam-first vs migrate-last) an explicit pass question. Docs-first; nothing
builds until the pass is signed.

## D62 — Keep the private seam on both faces; ACP is vocabulary now, an adapter on trigger, a face as a future extension — DECIDED 2026-08-06

*(Moved from open-questions.md on the slice-9 pass signature. Research basis:
the S9·0a ACP read, 2026-08-05, primary docs — scratchpad/s9-0a-acp-read.md;
recommendation carried into migration-map.md §3.3 and signed with the pass.)*

**The decision, three commitments:**

1. **Provider side — private seam now, `AcpAgentAdapter` on the provider-#2
   trigger.** The `SessionAdapter`/`AdapterCapabilities` seam (D18) stays
   ours: provider #1's value depends on sub-ACP access (D48 deny-and-harvest,
   D50 clamps, hook custody, JSONL observation) that ACP cannot express. When
   provider #2 actually fires, implement it as ONE generic ACP-client adapter
   behind the existing seam — 40+ registry agents become spawnable without
   ACP ever becoming *the* seam. Full rule-0.6 fragile-adapter treatment.
2. **Client side — vocabulary yes, protocol no.** Four steals adopted into
   the client contract (migration-map §3.3), each vocabulary never protocol:
   gate OPTION FAMILIES (`allow_always`-class kinds reserved, no rule
   storage), elicitation's restricted question schemas (D68's shape
   discipline), tool-call `kind`/`status`/`locations` (derived from the
   structured stream, 0.8), capability negotiation with omitted=unsupported.
   An ACP *face* — an external Tier-2 extension consuming the public API and
   speaking ACP outward to editors, engine-ignorant — is banked with an
   explicit trigger: ACP v2 + remote transports stabilize, or real external-
   editor demand arrives.
3. **The sub-question answered:** ACP's plan primitive is a progress/todo
   surface, not an artifact; its plan boundary is an exit-mode tool call that
   can only be approved or rejected. D48's deny-and-harvest has NO ACP
   expression — the plan boundary stays a VIMES-private seam under every
   posture, permanently.

**Why not full adoption:** the topology inverts (ACP clients spawn agents;
the VIMES daemon owns processes and outlives every client), remote transports
are an unstabilized RFD, and v1→v2 is reshaping exactly the surfaces that fit
best (permissions, message chunking). VIMES is ahead of the standard on the
axis that defines it — remote, multi-client, persistent, custodial.

## D66 — The extension boundary: two tiers, one vocabulary — DECIDED 2026-08-06

*(Moved from open-questions.md on the slice-9 pass signature. Full proposal:
extension-model.md §1, now the standing reference.)*

**Tier 1** — in-process TypeScript modules in the daemon build: first-party
only, spine-speed, may register write-path projections, zero failure
isolation (a Tier-1 crash is a daemon incident, accepted because Tier 1 is
in-build and reviewed under the gate discipline). **Tier 2** — external
processes (argv commands or one supervised worker) over the public HTTP/WS/
MCP surface: language freedom, real crash isolation, capability-gated (D67).

**Both tiers declare the SAME TOML manifest** (`vimes-extension.toml`); the
tier is one `[runtime].kind` field whose privileged value only builtin trust
may hold. The **Tier-2-completeness rule** guards #15: any manifest surface
must be servable over the public API — Tier 1 is a placement optimization,
never a privileged vocabulary, and a Tier-1-only capability is a finding.
Two Tier-1 bounds are structural: modules import the declared extension-host
interface (never core internals — enforced by the `packages/ext-tasks/`
package boundary, migration-map q29) and modules still PROPOSE (spine writes,
projection mutation, transition decisions stay engine-owned).

Placement: tasks → Tier 1; Book Genesis → Tier 2 (the deliberate proof Tier 2
is real); drive verbs → content of their owning extension; future ACP face →
Tier 2. Reopening trigger: the day a Tier-1 slot is offered to code we did
not review, D66 reopens rather than stretches.

## D67 — Extension trust: v1 is first-party-only; the grant machinery is built anyway — DECIDED 2026-08-06

*(Moved from open-questions.md on the slice-9 pass signature. Full proposal:
extension-model.md §5, now the standing reference.)*

**Trust by authorship in v1** — no install path exists at all (a property,
not a policy): the installed set is the daemon build plus local directories
the operator names. **But the grant machinery ships day one**, because Tier 2
is real day one (Book Genesis), #15 makes the API surface the trust surface,
and the declared `capabilities` array is the review artifact for our own
PRs: grants pinned to the manifest hash; **unknown capability → reject,
never grant**; widened grant → re-approval pinned to exact content (declining
keeps the current version); `extensions.lock` recording source + manifest
hash + granted set.

**The threat class, named:** this daemon holds Access-authenticated reach
into every project under `VIMES_PROJECT_ROOTS`, owns session custody and the
usage window, and is tunnel-published — agenc's class, not herdr's laptop.
**The honest ceiling, in the doc verbatim:** capabilities without OS
enforcement are informed consent, not containment — coherent exactly while
author == consenter. **That equivalence is D67's load-bearing conditional and
its reopening trigger:** before any extension VIMES did not author is
installed (realistically: before the authoring method is published), D67
reopens as a new dated entry.

The capability taxonomy grades by EFFECT (session.read HIGH — the
exfiltration grant; session.unattended HIGH, never implied; terminal.create
HIGH — RCE by design; no cross-extension capability exists at all).
`confinement = { mode, paths }` is reserved on the dispatch spec — **off by
default** per E3's third meaning of directory (Wes's conscious signature,
diverging from agenc's default-on; agenc's fail-closed broker named as the
eventual enforcement shape, with VIMES's five execution surfaces enumerated
now while it is free).

## D71 — The slice-9 extension-engine design pass is SIGNED; the E1–E3 settlements are records; the kill criterion held — DECIDED 2026-08-06

*(Wes reviewed the assembled pass — extension-model.md, node-kit.md,
migration-map.md, architecture.md, the tree-spine reservation `74dfe4b`, and
the signing packet — and signed 2026-08-06. The DRAFT banners drop with this
entry. The 29 open questions accumulated across the pass docs, each carrying
a DEFAULT TAKEN, are confirmed as recorded.)*

**The E-settlements, now records** (walked with Wes 2026-08-05,
architecture.md is the full text):

- **E1-a** — the cost ledger is ENGINE; budget policy is the scheduler
  extension's.
- **E1-b** — the artifact store is an ENGINE blob service, namespaced per
  extension by the engine from the caller's identity.
- **E1-c** — mounting declared tools into sessions is ENGINE; the verbs are
  extension content (D65's split, generalized).
- **E1-d** — the engine owns `dispatch(sessionSpec) → completion events`;
  extensions own everything deciding WHAT and WHEN (function-level cut:
  migration-map §1.5).
- **E1-e** — the persistent-chat primitive is ENGINE (ensure/attach, turn
  delivery, standing notes); the orchestrator persona, doctrine and grants
  are extension content (cut: migration-map §1.6; test: a project with no
  extensions still has a chat).
- **E2-a** — ONE node kind; provenance is a nullable property,
  WRITE-ONCE-AT-CREATION; null stays null forever; converting = a new child
  node; no `node_moved` in v1.
- **E2-b** — subtree aggregation is an ENGINE projection: an explicit,
  VERSIONED total order over attention severities (v1 shipped in
  `nodeRollup.ts`), and rollups count PROCESSES, not open nodes.
- **E2-c** — both humans and extensions propose checkouts through one API;
  the engine does git (principle 13 applied to the filesystem); create ≠
  open, fails loud; removal gated on resumable sessions (SP8·2).
- **E3-a** — groups are directory-OPTIONAL; the three meanings of directory
  stay separate (organization / spawn default / opt-in containment reserved).

**The kill-criterion verdict, signed:** both tenants — the task machine (30
mapped rows) and Book Genesis (31 rows) — are hosted by the node kit with
zero engine carve-outs. Standing assertable rule (node-kit §1.10): **the
engine's source may not contain a tenant's word.** The ten named bends are
accepted as recorded.

**The three walk-first calls, decided as defaulted:**
- The engine gains the **workflow-instance store** (q6/q13): engine-owned
  core fields + opaque manifest-declared payload — E4's NINTH item. Its
  sibling growth is the generic rubric acceptance evaluator
  (ex-`deriveReviewOutcome`).
- **`offered_when` is retired** (q14): exposure = node-declared `tools` +
  entity grants. No predicate grammar, ever.
- **Event-kind renames** (q21): generic instance siblings are new kinds; a
  permanent versioned alias table replays retired kinds; history is never
  rewritten; deprecated kinds warn like unknown ones (q8 decided with it:
  the event-kind allowlist is versioned public API).

**Also signed with the pass:** the client contract entire (migration-map
§3 — shared IA/per-client grammar, the nine API items, blocks-degrade-to-
text, meters as engine chrome no extension may re-source); scope 7 covered
by the tasks manifest's two-faced verb declarations (no separate doc);
principle #16 ratified (design-principles.md); `nodeConfig` as
required-null; the confirm-batch defaults 1–5, 9–12, 15–20, 22–29 as
recorded in their documents.

## D72 — Migration sequencing: SEAM-FIRST — DECIDED 2026-08-06

*(Signed with the pass; full argument migration-map.md §2.)*

The recorded behaviour (the trial's event log, seq 101–111, plus the
3132-test suite at slice-8 close) is the migration FIXTURE — refactors are
free, behaviour is the test — and seam-first is the only order in which that
fixture stays a test rather than becoming a post-mortem. The differential
test node-kit demands (declared edges vs `TASK_STAGE_EDGES`) mechanically
requires the parser to exist before the migration.

**The moves:** 0 — freeze the fixture into a repo file; 1 — manifest parser +
registry with ZERO consumers (exit: the differential test; kill: the
vimes-tasks manifest cannot be written without amending the kit more than
once); 2 — the instance store as `projections/tasks.ts` + `taskWriter` +
`taskApi` generalized (riskiest early, while the old code stands as
reference; alias table; `/api/tasks/*` aliases live exactly one deploy); 3 —
adjudication reads the pinned declaration, then `TASK_STAGE_EDGES` dies.
**The coexistence rule: the seam moves, the state does not** — never
dual-write the spine; every step deletes what it replaces in the same unit.
Untouched until their own units: routes/WS vocabulary, the whole UI (the
ci-gate partial-deploy hazard makes this a hard line), MCP names, the
orchestrator founding, Book Genesis.

## D74 — The tree's middle layer: a NODE, not a field; label now, scope structurally reserved — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue, discussed live. Trigger
had fired: blocks the tree read model.)*

**A subproject is a NODE in the tree with its own kind — addressable, with
children — that at v1 carries no config.** Not a string attribute on session
nodes. The lean ("ship the label, reserve the scope") stands, but Wes
strengthened the reservation: reserving *where resolution would happen* as
prose is weaker than reserving it structurally. As a node, scope-resolution
later is nearly free — the node-to-root walk already exists, and a scope
layer is "also consult this node's config on the way up." As a field, that
retrofit is a real migration. Per-subproject config, rules, and extension
loading remain unbuilt until a consumer exists (D11).

**Stated explicitly to prevent a read-model collision: a worktree child is
NOT a subproject.** Worktree is an *isolation mechanism*; subproject is
*organizational grouping* — different axes. A worktree node *belongs to* a
subproject. The tree read model must keep the axes distinct.

## D75 — An enabled extension's declared placement is honoured, including `main`; slot cardinality is engine-enforced — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue.)*

The extension declares placement, the client honours it — including the
primary slot — with an operator override. Structurally-secondary extension
chrome would be a Tier-1-only capability wearing a CSS class (#15's UI
corollary, Tier-2-completeness).

**The cardinality answer (Wes):** `main` is a single slot, so **two enabled
extensions both claiming it is a detectable duplicate the OPERATOR resolves**
(ordering or explicit choice) — never something the engine silently picks or
renders nondeterministically. This is the mateclaw cardinality-vs-policy
distinction: refusing/surfacing a second claimant is *cardinality* (engine's
job); choosing which extension's opinion wins is *policy* (the operator's).
The no-arbitration tenet survives intact.

**Coupled to D77 (Wes):** the board arriving as a `[[panes]]` contribution at
`main` is the first live test of this decision. If that turns out impossible
or ugly, D75's call is wrong — one gate answers both records, and the UI-era
slice must treat it so.

## D76 — A client renders unknown workflows from the declaration alone; proven by a deliberately ALIEN synthetic tenant and a client-bundle grep — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue.)*

Declared-generic fallback: node-kind name, declared overlays, declared verbs,
rendered with zero client-side workflow knowledge. Two hardenings from Wes:

1. **The synthetic test workflow must be deliberately alien.** The failure
   mode is a synthetic tenant that quietly resembles tasks and passes by
   accident. It shares NO vocabulary — unfamiliar node kinds, overlays, and
   verbs, and a different graph shape. Same discipline as the S9·4 strain
   instruction and verify-guards-by-breaking-them: a test that cannot fail
   measures nothing.
2. **The carve-out test at the face is a CHECK, not a demo:** grep the built
   client bundle for tenant words, exactly as `packages/core` is grepped
   (#16's mechanism, third surface — core source, engine chrome, now the
   shipped bundle).

## D77 — The board survives slice 13 untouched, then becomes a `[[panes]]` contribution of the tasks extension — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue.)*

`TaskBoardView` migrates its data shape in slice 13 (U3) without rewrite —
rewriting there would violate that slice's own explicitly-out, and its
eventual home is a different package (Move 4). Ownership moves in the UI era,
where **the board at `main` placement IS D75's first live test** (coupling
recorded in both entries, Wes's instruction): one gate answers both.

## D78 — The phone lands on ATTENTION; every attention item is decidable from its own card — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue.)*

Mobile home is the attention list — open gates, failures, awaited approvals —
with the tree one tap away. A tree home on a phone is a navigator you must
immediately drill out of ("mobile is monitoring"), which pillar 5 rejects.

**The assertion that makes it testable (Wes): the phone never REQUIRES the
tree in order to act.** Every attention item carries enough context to decide
from its own card. That property is what keeps the attention list from
degrading into a navigation menu, and it is assertable per item kind.
Ordering is by **risk/urgency tier** (the AgentSwarms carry-over), never
recency — recency ordering is what makes an attention surface dishonest.

## D79 — Session short ids are DERIVED, not issued: a prefix of the appSessionId with git-style collision extension — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue. Supersedes the lean's
"engine-issued" spelling with something stronger.)*

A short id is a **rendering of the real id, not a second fact about a
session**: the 4-char prefix of the appSessionId, extended git-style on
collision. Engine-owned (the derivation rule and collision handling live in
one place), stable, no parallel id registry, no recycling question — the
principle-9 argument in its strongest form. Rendered in the TUI (a command
grammar needs addressable handles), hidden in the web (a pointer grammar
does not). The only reason to ever revisit: wanting pronounceable ids
rather than hex.

## D80 — Economics split by KIND, not by client: aggregate/window everywhere, per-turn detail on desk surfaces — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue. Refines the lean, which
split by client and missed the third one.)*

**Aggregate and window economics** (5h/7d meters, running/queued/fail counts,
headroom) are chrome **everywhere, including mobile** — pillar 4's "can I
afford to start this" is most acute on the phone. **Per-turn detail** (token
in/out per turn) is chrome on desk surfaces (TUI + desktop web) and is NOT
forced onto the phone — a decision surface does not carry per-turn noise.
This gives TUI/web parity where it matters and resolves the mockup asymmetry
as a rule rather than an artifact.

## D81 — ONE write etiquette at the session-input choke point; lease and admission timing separable in code; queued writes visibly queued — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue. Binds the
sessionguard/InputLease build.)*

One etiquette serves briefings, companion-panel note injection, and human
writes: never into an open gate (the lease); otherwise admit at a cache-safe
boundary by default, with an explicit queue-until-turn-end mode (jcode's
ratified admission timing). Two riders from Wes, both binding on the build:

1. **The lease (safety) and admission timing (cache efficiency) stay
   SEPARABLE in code** even though they present as one operator-facing
   policy — they fail differently and want different tests.
2. **A queued write is VISIBLE while queued.** A note that lands four
   minutes later with no indication it was waiting is its own confusion —
   the queue state is surfaced, not silent.

## D82 — Ratified as principle #17: engine session states describe the PROCESS; overlays describe the WORK — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue. The decision — yes, the
engine gains a work-agnostic `queued` state — was the smaller half; Wes
promoted the rationale to the principles doc as the standing test for every
future proposed session state.)*

`queued` is engine vocabulary: a dispatch-queue fact any workflow produces.
`review` is one tenant's node name and reaches the tree only as
`[[overlays]]`. **The edge case run to prove the principle load-bearing
(Wes):** a session blocked on a permission gate decomposes cleanly — blocked
is a *process* fact (engine state), why it is blocked is the *attention*
model, what the gate means for the work is *overlay*. It held. Full text:
design-principles.md #17.

## D83 — Seen/unread is an engine read model; SEEN never conflates with HANDLED — DECIDED 2026-08-11

*(Moved from open-questions.md; the D70-face queue.)*

Engine model, nearly free: `seen` events already exist on the spine; the
missing piece is a read model exposing them. **The guard (Wes): seen is the
weaker of the two acknowledgment facts — viewing acks the NOTIFICATION;
only deliberate action clears the STATE (D9's split, verbatim).** A
"✓ 1 Viewed" counter must never read as "1 handled," or the tree quietly
undoes D9 at the presentation layer. If both facts are surfaced they carry
visibly different affordances.

## D85 — (closes D84) The API-version floor: bundle-declared, bundle-CHECKED at connect; the hello frame is the carrier — DECIDED 2026-08-12

*(Moved from open-questions.md D84; built as S14 U1, commit at the slice-14
record. Lean (b) taken, with one deliberate inversion from the lean's
spelling, recorded here.)*

The daemon declares what it serves: `{op:'hello', apiVersion, capabilities}`
as the FIRST frame on every WS connection, mirrored on `GET /api/health`
beside the distinct event-schema fact. The bundle declares the floor it was
built against (`UI_REQUIRED_API_VERSION`, deliberately restated — core is
not a UI dependency). A daemon below the floor — or one that proves the
connection live (a `subscribed` ack) without ever saying hello, i.e. a
daemon that predates version reporting — renders a sticky, NON-dismissible
banner naming both versions and the remedy. The capability set ships EMPTY:
an omitted capability is UNSUPPORTED, never assume-yes (migration-map
§3.3(d), q26 settled with this record).

**The inversion, deliberate:** D84's lean said "daemon-checked on serve";
the build is bundle-checked at connect. The daemon cannot cheaply
introspect the bundle it serves; the bundle trivially reads the hello. The
coverage is identical for the defect class, because the dangerous direction
is always a NEW bundle over an OLD daemon (ci-gate's side effect ships UI,
never the daemon) — and a new bundle always carries the check. The reverse
direction (old bundle, new daemon) is the additive-safe direction and was
never the defect; a stale bundle that predates the hello op drops the
unknown frame silently (verified against the deployed parser before the
frame was added).

**Bump rule (part of the record):** `DAEMON_API_VERSION` rises in the same
reviewed unit that changes a served shape incompatibly; the UI floor rises
in the same unit that makes the UI consume a shape that did not exist at
the old floor. Never mechanical, never a drive-by. Candidate (a) — gate
stops shipping dist — remains open as an independent hardening, unclaimed
by this record.

## D86 — Projections carry a VERSION; a snapshot whose version mismatches is not a snapshot — DECIDED 2026-08-12

*(The S14-F3 finding's resolution, signed at the slice-14 halt. Lineage:
S14-F2 (durable creation order needs a record-shape change) → U2b's halt
(no invalidation mechanism exists — the snapshots table is
projectionId/lastAppliedSeq/state/savedAt, `Projection<T>` carries no
version, `bootFromSnapshot` has no check that can fail) → this record.)*

**The mechanism (option a):** `Projection<T>` gains an integer `version`,
default 1. The snapshot store persists it beside the state; on load, a
stored version different from the projection's declared version is treated
EXACTLY as no-snapshot-found — init(), full log replay, overwrite. No
partial migration, no field-tolerant parsing: a snapshot is either the
projection's own shape or it is nothing. Replay is the recovery path
because the log is truth (I12) and every fold is total and deterministic.

**The bump rule:** the version rises in the same reviewed unit that
changes the projection's RECORD SHAPE (fields added/removed/re-meaning),
never for fold-behavior fixes that produce the same shape. First consumer:
`projects` bumps to 2 with the `createdAt` fold (S14-F2's fix); `nodes`
stays 1 (its shape is new-born this slice — no legacy snapshots exist).

**Why not the alternatives:** renaming the projection id (the S11
precedent) works but spends public API surface (`/api/projections/:id`)
to avoid a version field; a tolerant comparator self-heals never (old
records' birth events sit behind `lastAppliedSeq` and are not re-folded).
Recorded dead so neither is reinvented.

## D87 — `@vimes/core` in the UI: type-only payload-contract imports are sanctioned; everything else stays banned

*(2026-08-13, ⟨Wes⟩ signed "go with option A" on S15-F1. Supersedes the
slice-1 blanket ban in its one dissolved case; re-ratifies the rest of it.)*

**The archaeology.** The ban dates to the first UI commit (slice 1 step 3,
`a5fb560`, 2026-07-13); its checkpoint file is gone, but the intent
triangulates to two things: (1) **bundle discipline** — slice 1 carried a
300KB entry ceiling and `@vimes/core` carries real runtime (zod, folds);
"no core at all" was a bright line needing no tooling; (2) **wire-contract
honesty** — in July, core's types were internal record shapes that merely
coincided with what the API serialized, so importing them coupled the
client to internals rather than the wire (the stance #15 later made
principle). A third fact was consequence, not intent: `ui/package.json`
never declared core, so the ban meant the dependency never had to be wired
honestly.

**What changed.** Slice 14 moved the ground under intent (2): the
`TreeResponse` family was DESIGNED in core as the documented payload of
`GET /api/tree` — core now deliberately authors wire contracts. Importing
those types IS consuming the wire contract. Intent (1) never changed and
still binds.

**The decision (option a, three riders):**
1. **Type-only, grep-assertable.** Every `from '@vimes/core'` under
   `packages/ui/src` must be an `import type` statement (the statement
   form, never inline `{ type X }` specifiers — greppability is the point).
   Enforced by a test in the UI suite, sabotage-verified like any guard.
2. **Payload-contract types only** — the tree payload family and
   `AttentionSeverity`. Core internals (folds, schemas, projections,
   runtime values) stay banned. The existing `lib/types.ts` narrow mirrors
   STAY — no blanket migration (the S14-F1 lesson: the mirror idiom is not
   wrong, it was the wrong price for one large recursive shape; each
   existing mirror keeps its context until a unit touching it has a reason).
3. **The dependency is declared** — `@vimes/core` lands in
   `ui/package.json` `devDependencies` (type-only usage ships nothing), so
   resolution stops being a workspace-hoisting accident.

**Stale-dist note:** UI typechecking resolves core types via built
`dist/index.d.ts`, the same stale-dist hazard the daemon already carries;
the existing discipline covers it (`npm run typecheck` rebuilds via project
references before anything trusts types; ci-gate orders it so). No tsconfig
reference added — vue-tsc resolves the declared package.

**Alternative recorded dead:** (b) keep the blanket ban and hand-mirror the
tree family — coherent, but it re-ratifies intent (2)'s original reason at
the moment slice 14 dissolved that reason for payload types specifically,
and buys a mirror that tracks a recursive contract by hand forever.

## D87 addendum — test files may value-import `@vimes/core` (S15-F2)

*(2026-08-13, ⟨Wes⟩ "Approved" on S15-F2 option (a), same day as D87.)*
Rider 1 binds SHIPPED source: non-test `.ts` under `packages/ui/src` must
use the `import type` statement form. **`.test.ts` files are exempt from
the type-only rule** — they run in node and never enter the browser
bundle, so intent 1 (bundle discipline) is untouched, and value-importing
core constants to cross-check UI literals against wire names
(`EVENT_TYPES.nodeCreated` etc.) is genuine drift protection the strict
reading would have destroyed. The `.vue` total ban stands for test and
non-test alike. The policy guard (`coreImportPolicy.test.ts`) encodes the
distinction. Found by that very guard reddening on its first run against
real code — the guard catching a case the decision hadn't priced is the
system working; the answer here was to price it, not to weaken the guard.
