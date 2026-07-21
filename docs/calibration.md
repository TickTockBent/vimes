# Calibration — the measurement record

Pinned budgets and bands, probe and spike results, and the measurement methods
that produced them. **Bands are pinned with their assumptions** (workload
profile, device, network condition), never as bare numbers, and never
unreviewed (Gate-D).

## Status

**No bands pinned yet** — the harness is pending (slice 0). Until `--report`
mode runs and Wes prices the results, every ⟨tune⟩ number is a placeholder and
every budget assertion is PREVIEW, never FAIL-able.

## Scenario profiles (measurement instruments)

The six profiles from spec §7. Findings are relational — variants run
side-by-side through multiple profiles, never one alone. CI runs every scenario
twice; byte-identical event logs and final projections required.

| Profile | Script / policy | What it proves |
|---|---|---|
| happy-path-desktop | spawn, converse, tool calls, complete, seen, cleared | baseline projections (regression instrument, not an experience claim) |
| flaky-mobile | subscribe, drop mid-stream, gate fires offline, short-gap and very-long-gap returns; backpressure drop | I2 one-path replay; notification event emitted while offline |
| concurrent-clash | two clients, one session; resume mid-run; explicit fork; simultaneous clear-attention | I11, I3, I5 single-transition |
| cold-restart | host dies mid-run, 3 live sessions, one needing attention; restart | I5 attention survives; I3/I4 on resume; I6 snapshot+tail ≡ from-empty |
| hostile-input | truncated/interleaved JSONL, unknown event types, absurd counts; path-traversal uploads; unauth + forged-JWT probes (HTTP, WS upgrade, PTY) | I8, I14 |
| budget-wall | meters approach caps; threshold crossing; requireHeadroom refusal; deferUntilReset on injected clock | I10; notification events |

## Harness observations (`scenarios --report`, 2026-07-13 — PREVIEW, nothing pinned)

First slice-0 report run. **Assumptions:** in-process harness (MemoryEventStore,
no network, no real processes), synthetic profile workloads, seed epoch fixed —
these are shape/regression baselines, not experience measurements; the §8
latency targets need slice-1 live probes.

| profile | events | streams | replay-window | quarantines | raw-bytes | snapshot-bytes |
|---|---|---|---|---|---|---|
| happy-path-desktop | 12 | 1 | 12 | 0 | 0 | 792 |
| flaky-mobile | 309 | 1 | 309 | 0 | 0 | 847 |
| concurrent-clash | 9 | 2 | 8 | 0 | 0 | 842 |
| cold-restart | 18¹ | 4¹ | 8 | 0 | 0 | 1317¹ |
| hostile-input | 14 | 1 | 14 | 3 | 60 | 943 |
| budget-wall | 14 | 4 | 5 | 0 | 0 | 1298 |

(`replay-window` = largest single-stream event count; `raw-bytes` = FakePty
byte-channel total, exercised-never-parsed per rule 0.8; `snapshot-bytes` = sum
of the three mid-log projection snapshots. ¹ cold-restart re-observed same day
after D13 added the spawning-at-crash session to the profile — was 14/3/838.)

### 2026-07-14 — first real gate round-trip (smoke S5/S6, live daemon)

Real SDK session on Dongfu through the deployed daemon + Access + browser:
spawn → converse (thinking/tool_use/tool_result turn) → Write-gate fired →
answered ALLOW from the UI → file created. Event-log evidence (session
17293cfd): `gate_fired` seq 29 → `notification_trigger` seq 30 (**adjacent —
the I5 batch rule holding in production**) → `attention_cleared` seq 31 with
cause `gate_answered`. Also observed: one turn = several assistant messages
each with an identical usage snapshot (→ D17); default spawned model
`claude-opus-4-8-1m`; gate prompt payload carried just the tool name
("Write") — canUseTool `title` apparently absent; enrichment candidate.

### 2026-07-19 — Slice-2 step-0a hooks spike (CLI 2.1.215 — box auto-updated from 2.1.207 mid-slice)

**Q1 — injection is MERGE, both channels.** Surface: SDK `Options.settings`
(file path or object, "flag settings" tier) + `settingSources`; CLI
`--settings` + `--setting-sources`. A per-session settings file's hooks fire
ALONGSIDE the project's own `.claude/settings.json` hooks for the same event
(verified SessionStart + Stop, PTY and SDK). **D14's project-tier promise
holds under injection.**

**Q2 — D7 correlation complete and deterministic.** Hook payload `session_id`
=== transcript filename === SDK-reported id, every run; the relay URL's
embedded appSessionId token survives untouched; PTY hook subprocesses also
carry `CLAUDE_CODE_SESSION_ID` in env (second confirmation channel — note:
D10's lean said `CLAUDE_SESSION_ID`, observed truth is `CLAUDE_CODE_`
prefix). Hook contract: JSON payload on stdin, bash execution, `CLAUDE*` env
present. Spawn→first-POST latency ~470–550 ms both channels.

**Q3 — golden payload fixtures** captured for SessionStart / Stop /
SessionEnd / PreToolUse (sanitized, `fixtures/hooks/`, stamped 2.1.215).
`StopFailure` unobtainable at spike budget — fixture gap noted for slice 5.

**Q4 —** SessionEnd fires on TUI `/exit` with `reason: "prompt_input_exit"`
(distinguishable — D10's adoption trigger is real); a project's OWN settings
hooks fire for uninjected sessions (the foreign-session adoption path works).

**Version-drift rider:** the box auto-updated the CLI 2.1.207→2.1.215 during
the slice. Fresh-transcript field check: ADDITIVE only (new top-level
`requestId` on assistant records); tail/mapper unaffected; full fixture
re-stamp deferred to the next release gate. This is live evidence for the
ATA runtime-lockfile item (tracker) — the platform updates under us without
asking.

Burn: 5 tiny invocations, low thousands of tokens. Process baseline clean.

### 2026-07-20 — S9/S10 + hooks live-confirmation (second smoke session)

**Hooks channel LIVE in production** (first real confirmation): session
58070f4d received `hook_session_start` (payload `session_id` present +
`appSessionId` stamped by the 4601 ingress) and 11× `hook_pre_tool_use`.
**D7 correlation held live** — exactly ONE `claude_session_mapped` on the
stream despite both SDK-init and hook paths firing (principle 9 dedupe
boundary working). The two synthetically-tested fragile surfaces (settings
hooks-block shape, relay contract) are now real-world validated.

**S9 PASS** — airplane-mode gap mid-stream, session resumed on return via
lastSeq replay.

**S10 — I3 (no fork) PASS on disk; I11 refusal harness-owned.** Two phone
tabs on one session; resume fired in tab A → dormant→spawning→running
(seq 92→95), tab B reflected the resumed state (pillar 2 — viewport, not
owner; it never fired its own resume). `transition_rejected: 0` (no
concurrent attempt occurred), `claude_session_mapped: 1`, and ON DISK a
single transcript (`75e6…a.jsonl`, appended in place) — I3 single-chain
verified, the artifact the slice-1 exit gate wanted. I11's concurrent-resume
REFUSAL was not exercised: the UI withdraws the resume affordance the instant
a session leaves dormant, and human click-timing can't hit the sub-second
spawn window, so the registry refusal has a UI guard in front of it in normal
use. I11 stays proven by the concurrent-clash harness profile (its proper
home for a sub-second race). Note for the on-device checkpoint / slice-2
retro: consider whether a deliberate "force concurrent resume" affordance is
worth building purely for manual I11 demonstration — likely not (harness
owns it).

### 2026-07-20 — slice-3 dogfooding finds (during the push checkpoint session)

- **PASS (real-world spawn allowlist):** spawning a session with a cwd outside
  `VIMES_PROJECT_ROOTS` returns a red `cwd-outside-project-roots` refusal with
  a dismiss button — the path-discipline / spawn-allowlist boundary
  (slice-2 step 2) confirmed live, not just in the harness.
- **BUG (queued, not yet fixed — UI state, slice-2 surface):** after a spawn
  refusal, the spawn button stays in "Spawning…" forever. Cause (high
  confidence): the spawn affordance sets a local pending flag on click and
  clears it on `{op:'spawned'}`, but the `{op:'refused', refusedOp:'spawn'}`
  path never resets it. Fix bundles into the next UI deploy (post-measurement,
  with slice-3 + roots-widening). Any refused op that a button optimistically
  "pended" needs the same reset — audit the store's refused handler for other
  stuck-affordance cases while fixing.

### 2026-07-20 — push pipeline, on-device (Gate-D measurement, DAEMON-SIDE pinned-able)

First real gate-to-push measurement, live daemon + Access + Android PWA.
Gate `15e2faf1` (a Bash/awk gate): `gate_fired` and `notification_trigger`
at the SAME ms (15:53:09.372Z — I5 batch rule live), `push_sent` accepted by
the push service at 15:53:09.478Z. **Daemon-side latency gate→push-accepted
= 106 ms** — the ⟨tune 10s⟩ "gate-to-push-delivered" intent has ~100×
headroom on our side; total gate-to-buzz is dominated by push-service/OS
delivery, not the daemon. **Pipeline proven end-to-end** (Wes saw the bell).
**Dead-subscription prune confirmed live:** a stale sub returned 410 Gone and
was auto-pruned before the live send succeeded (subscriptions 2→1). Push
subscription persistence + suppression path exercised without incident.

**OBSERVED (Wes, 2026-07-20): LOCKED phone, gate-to-buzz "basically instant,
same second easily" (sub-1 s).** This is the spike's flagged worst case
(Android background-delivery throttling on a dozing device) and it delivered
effectively immediately. **Slice-2 kill criterion (push unreliable on
Android → halt) is NOT triggered — the pillar-5 promise lands.** Gate-D
pin-readiness: the ⟨tune 10s gate-to-push-delivered⟩ and ⟨tune 60s
gate-noticed⟩ intents both have enormous margin; **push latency is deliberately UNPINNED (D20):** the real invariant is
qualitative — delivery must not silently fail (confirmed) — not a defended
millisecond band. No FAIL-able assertion on gate-to-buzz. Assumptions of the
observation: single Android device, GitHub-IdP Access session valid, home
tunnel, screen-locked.

### 2026-07-20 — queued findings (slice-3 resume)

- **[RESOLVED 2026-07-20]** **Test-infra flakiness (rule 0.4 — to harden):**
  `packages/daemon/src/auth.test.ts` I14 matrix (real servers + JWKS crypto +
  WS upgrades) timed out at the default 5000 ms under CPU contention — observed
  3/3 timeout failures during a full-gate run while an agent + the live daemon
  competed; passed 6/6 in isolation. Fixed: `vi.setConfig({ testTimeout:
  30_000, hookTimeout: 30_000 })` at the top of auth.test.ts. Green across
  several full-gate runs since (491, then 501 tests).
- **Protocol gap (gate_response refusal correlation):** the `refused`
  envelope carries no `requestId`, so a refused `gate_response` can only be
  recovered UI-side by clearing the WHOLE `answeringRequestIds` set (agent's
  flagged choice). Safe for the minimal one-gate-at-a-time page; imprecise
  once many gates are concurrently pending (a refusal on one re-enables all).
  Precise fix needs `requestId` on the refused envelope (daemon protocol
  addition) — queued for the slice where concurrent gates become real
  (6/7). Accepted as-is for now.
- **[NEW 2026-07-20] CLI runtime drift — expected=2.1.215 observed=2.1.216
  (rule 0.7, Wes's awareness).** The box auto-updated the Claude Code CLI again
  (2.1.207→2.1.215 earlier, now 2.1.215→2.1.216) during the polish-pass deploy.
  The daemon boots and runs fine — the version pin
  (`VIMES_EXPECTED_CLI_VERSION`) emits a non-fatal drift warning, doing exactly
  its job: surfacing a new Anthropic surface for a human glance rather than
  silently trusting it. **Deliberately NOT bumped unreviewed** — under rule 0.7
  we classify CLI behavior by observation, and blessing 2.1.216 (does it change
  hook/JSONL/transcript shape?) is Wes's call. Hook golden fixtures are stamped
  2.1.215 and still pass. Action for Wes: eyeball 2.1.216's release notes /
  spot-check a session, then bump the pin in `/etc/vimes/env` to clear the
  warning (or pin the CLI version to stop auto-updates mid-work).

### 2026-07-20 — slice-3 live smoke (desktop, deployed build)

- **#1 editor: PASS** — edited gate-test.txt (dongfu) in CM6, saved (87→125 B,
  mtime confirmed); mtime-precondition write path works live.
- **#2 search: PASS** — searched 'gate', all instances found (real ripgrep).
- **#3 terminal: PASS (desktop + mobile), after two fixes.** (a) ref-timing
  deadlock fixed; (b) mobile-corruption fixed — pty now spawns at the client's
  fitted viewport size (was hardcoded 80 cols → Claude rendered wide → phone
  wrapped it into garbage). Field-verified 2026-07-20: Claude Code's TUI
  reflows clean and full-width on the phone, visibly MORE legible than the
  code-server comparison shot (no activity-bar/tab-strip chrome tax — the box
  border runs edge to edge). Validates the "real estate to content" candidate
  principle (design-directions). Original failure notes retained below.
  Original root cause: `TerminalView.vue`
  ref-timing deadlock — the xterm mount `<div ref>` is behind `v-else`
  (renders only when `started`), but `start()` null-checks the ref and
  silently returns BEFORE setting `started`, so the element never exists →
  click does nothing, no console error. Fix: set started + `nextTick` before
  mount; make failure paths show a visible error, not silence. Bundled: add
  the missing `GET /api/files/roots` endpoint (step-2 gap) so terminal/tree
  offer the configured `~/projects` roots, not just session cwds.
- **#4 NOT a VIMES bug.** Session cwd was correctly `.../infrastructure/vimes`
  (event log confirms); the AGENT chose the absolute path
  `/home/ticktockbent/desktop-test.md` (gate card surfaced it verbatim, then
  approved). Likely driven by the ambient `~/CLAUDE.md` framing `~` as the
  top-level "cockpit" — VIMES sessions load CLAUDE.md up the whole tree and
  agent writes are gated by permission cards, NOT confined to VIMES roots (by
  design — the agent is a full Claude session; §3 scoping is Claude's job).
  **UX finding [RESOLVED 2026-07-20, commit ef758d6]:** the Write/Edit gate card
  showed `Write: {"file_path":"...","content":"..."}` truncated at 160 chars —
  the path was hard to scan and easy to approve unread. Fixed: the gate now
  headlines the tool name + a structured target (`file_path`/`command`/`pattern`
  pulled from the SDK tool INPUT via pure `extractGateTarget`, rule 0.8 — never
  the prompt string) in a monospace `break-all` line above the prompt. Not a bug
  (the gate always worked); a safety-ergonomics improvement, now shipped.
  Cleanup: a stray `/home/ticktockbent/desktop-test.md` ("PASS") exists — Wes to
  remove at will.

### 2026-07-20 — slice-4 spikes (read-only, against real data; front-loaded per rule 0.6)

**Spike G — git porcelain surfaces (fragile-adapter verify-row).** System
`git version 2.43.0` present (like ripgrep — no npm dep needed). Confirmed
stable + machine-parseable on this repo:
- `git status --porcelain=v2 -z --branch` → `# branch.oid <sha>`, `# branch.head
  <name>`, then `1/2/u/?` entry lines. NUL-delimited with `-z`.
- `git diff --no-color [--staged] -- <path>` → standard unified hunks
  (`@@ -a,b +c,d @@`), parseable per-hunk.
- `git worktree list --porcelain` → `worktree <path>` / `HEAD <sha>` / `branch
  <ref>` records.
- `git for-each-ref --format='%(refname:short) %(objectname:short)
  %(upstream:short)' refs/heads/` → clean branch list.
Conclusion: shell out to system git behind a single `GitAdapter` parse module
(rule 0.6). Pin/observe the git version like the CLI pin (2.43.0). No lib.

**Spike C — cache-observability data (rule 0.7 verify-row).** 57 real
`usage_block` events already in the deployed `events.db`. A live sample's usage
object:
```
cache_creation: { ephemeral_1h_input_tokens: 2909, ephemeral_5m_input_tokens: 0 }
cache_creation_input_tokens: 2909
cache_read_input_tokens: 39044
input_tokens: 2, output_tokens: 2
service_tier: "standard"
```
Findings: (1) **observed TTL tier** is directly classifiable from
`cache_creation.ephemeral_1h/5m_input_tokens` — this sample is **1h-tier**
(1h>0, 5m==0), matching the spec's "1h TTL observed on subscription main
conversations." Classifier: `1h>0&&5m==0→'1h'`, `5m>0&&1h==0→'5m'`,
`both>0→'mixed'`, `both==0→'none'`. (2) **Cache hit rate** =
`cache_read / (cache_read + cache_creation_input + input)` — this sample ≈ 93%
warm (39044 read vs 2911 new). (3) **`service_tier`** ("standard") is the
billing-bucket observation signal (rule 0.7) — pairs with session interactivity
to answer "5h window vs $100 automation bucket" (the dongfu question).
Conclusion: NO new event capture needed — a pure projection over existing
`usage_block` events delivers the whole cache-observability surface. The classifier
is a pure fn unit-tested over these real samples.

### 2026-07-21 — slice-4 exit-gate test: FINDING (git panel could not reach any repo)

**Found by Wes in the first live exit-gate attempt, from Vimes itself.** The git
panel's picker offered only `effectiveRoots` — the configured
`VIMES_PROJECT_ROOTS` (`~/projects`, D21) plus live-session cwds. But
`~/projects` is a **container of repos, not a repo**: the real repos sit one or
more levels down (`~/projects/infrastructure/vimes`, `…/games/dongfu`). With no
live sessions the dropdown had exactly one entry, it wasn't a repo, and the
daemon (correctly) answered `not-a-repo` — so the entire diff surface was
unreachable and the kill criterion could not even be evaluated.

**Class of error worth remembering:** this is the SAME gap the terminal hit
(fixed there 2026-07-20 with a free-text cwd field + `decideStartCwd`, because
`~/projects` is not a shell-worthy cwd either). The lesson was not carried
across surfaces — when a surface takes a "root", ask whether the configured
roots are actually *usable targets* for it, or merely containers of them.

**Fix (same day):** (1) `GET /api/git/repos` — depth-bounded (≤3 below each
root) discovery walker: a directory containing a `.git` entry of ANY type (the
worktree/submodule `.git`-FILE case included) is a repo; no descent into a found
repo; `node_modules`/`.git`/dot-dirs skipped; only `isDirectory()` entries
descended so symlinks cannot cycle; unreadable dirs skipped, never thrown; every
returned path re-verified through `resolveWithinRoots`; added to the I14 auth
matrix. (2) The panel now picks from DISCOVERED REPOS (one tap on mobile) with a
free-text path field as the escape hatch (pillar 7), last-used repo remembered.
603 tests green. Gate test re-armed.

### 2026-07-21 — slice-4 exit-gate test, 2nd finding: repo-relative paths resolved against the wrong base

**Found by Wes, second live gate attempt.** With the repo picker fixed he loaded
`~/projects/content/vesh` and tapped its modified `manuscript/chapter-01.md` —
and the daemon tried to read `~/projects/manuscript/chapter-01.md` (ENOENT): the
repo's own `content/vesh/` prefix was dropped.

**Mechanism:** `git status --porcelain=v2` emits **repo-relative** paths; the UI
hands them straight back; `resolvePathParam` passed them to `resolveWithinRoots`,
whose `resolve()` anchors a relative path on the daemon cwd / allowlist root —
NOT the repo root. Hit `/api/git/diff`, `/api/git/stage` and `/api/git/unstage`
alike. **Orchestrator's design error:** the step-1 spec said "every request path
goes through `resolveWithinRoots`" but never said a repo-relative path must FIRST
be anchored to the resolved repo root. The rule to carry forward: when a surface
accepts paths from an external tool, pin down *what they are relative to* — the
wall tells you a path is safe, never what it means.

**Fix (same session):** `resolvePathParam` takes the verified repo toplevel;
absolute → as-is, relative → `join(verifiedRepoRoot, path)`; the result still
passes the unchanged `resolveWithinRoots` wall, so a repo-relative traversal
(`../../../etc/passwd`) still 403s before any git subprocess. Six regression
tests use a repo NESTED below the allowlisted root (`<root>/content/vesh`) so the
bug cannot return. 609 tests green.

### 2026-07-21 — observed: PTY shell UX when the daemon restarts under it (validated, no action)

Wes deliberately left a vimes terminal open across a `systemctl restart` to
observe the failure mode. **Result: clean degradation.** The shell stopped
responding, a red error bar reported an invalid/unknown shell, the existing
scrollback REMAINED READABLE, and backing out to the terminals list worked
normally. No hang, no lost buffer, no stuck view. Process death (as opposed to a
WS reconnect, which D23 already covers) therefore has an acceptable UX today —
no polish item filed. Relevant to the hot-reload design direction: the cost of a
daemon restart is a dead shell with intact scrollback, not a broken client.

### 2026-07-21 — FINDING: no `Cache-Control` on static files (stale assets survive deploys)

**Found while chasing "the new icon is still a blue square."** Replacing the
placeholder icon and deploying did NOT change what the phone showed — and
critically, **not even at the asset's direct URL**, which ruled out the PWA
install cache and pointed upstream.

**Mechanism:** the daemon's static handler (`app.ts`) sets **only
`content-type`** — no `Cache-Control`, no `ETag`, no `Last-Modified`. With no
cache directives, three independent caches each hold the old bytes:
1. **Cloudflare** edge-caches `.png` (and other static extensions) by extension
   under the Standard cache level, regardless of origin headers.
2. The **service worker** precaches by EXACT URL — a replaced file at a stable
   name keeps its old precache entry until the new SW activates.
3. **Android** bakes the manifest icon into a generated WebAPK it refreshes on
   its own schedule (~daily), so even uninstall/reinstall can reuse it.
A stable filename is therefore served stale by all three, indefinitely.

**Immediate fix (icons only, no daemon restart):** icon filenames now carry an
`ICON_VERSION` (`icon-512.v2.png`, `scripts/make-icons.mjs`), referenced from
the manifest + index.html. Changing the URL defeats all three caches at once,
and the changed manifest is also what prompts Android to regenerate the WebAPK.

**The larger exposure — QUEUED, needs a daemon change (restart):** Vite
content-hashes JS/CSS, so those are safe. But **`index.html`, `sw.js` and
`manifest.webmanifest` are unhashed AND uncached-headered** — Cloudflare may
serve a STALE APP SHELL after a deploy, which would present as "my deploy didn't
land" with no obvious cause. Fix: set `Cache-Control` in the static handler —
`no-cache` (revalidate) for `index.html` / `sw.js` / `manifest.webmanifest`,
long-lived `immutable` for content-hashed `/assets/*`. Schedule with the next
daemon-touching work; it is a correctness/operability fix, not a tuning knob.

### 2026-07-21 — SPIKE U1 (slice 5): the usage endpoint is ALIVE — kill criterion NOT triggered

Read-only probe, run at Wes's instruction. **Method (rule 0.7 — observed truth,
never documentation):** extracted endpoint strings from the installed CLI bundle
(`~/.local/share/claude/versions/2.1.216`), found a function literally named
**`fetchUtilization`** issuing `GET /api/oauth/usage`, base
`https://api.anthropic.com` (58 occurrences; `api-staging` also present). Then
called it directly with the OAuth bearer from `~/.claude/.credentials.json`
(mode 600, `claudeAiOauth.accessToken`).

**Result: HTTP 200 with a rich, structured body.** Golden fixture pinned at
`fixtures/usage/oauth-usage-2026-07-21.json` (CLI 2.1.216, plan `max` /
`default_claude_max_5x`). **The slice-5 kill criterion is NOT triggered** — the
authoritative source exists, so meters can be truthful.

**The response carries TWO surfaces; consume the second.**
1. Flat legacy fields: `five_hour`, `seven_day` (each `{utilization, resets_at,
   limit_dollars, used_dollars, remaining_dollars}`), plus many null buckets.
2. **`limits[]` — already NORMALIZED**, and the right adapter target:
   `{kind, group, percent, severity, resets_at, scope, is_active}`. Observed:

   | kind | group | percent | resets_at | scope | is_active |
   |---|---|---|---|---|---|
   | `session` | session | 29 | 2026-07-21T15:19:59Z | — | false |
   | `weekly_all` | weekly | 52 | 2026-07-23T16:59:59Z | — | false |
   | `weekly_scoped` | weekly | 64 | 2026-07-23T16:59:59Z | `model.display_name: "Fable"` | **true** |

   This maps 1:1 onto the spec's presumed meter set: 5-hour rolling window =
   `session`; weekly all-models cap = `weekly_all`; weekly model-family cap =
   `weekly_scoped` (+ `scope.model`). `is_active` marks the currently-BINDING
   limit — a gift for "can I afford to start this?".

**Design consequences for slice-5 step 1 (must be decided before building):**
- **PERCENT ONLY.** `limit_dollars`/`used_dollars`/`remaining_dollars` are all
  null and `limits[]` carries `percent`, never token or dollar absolutes. The
  reserved `MeterRecord {used, limit}` (§5) assumes absolutes. Either store
  `used = percent, limit = 100`, or widen the record with an explicit
  `percent`/`unit` field. **Lean: widen** — collapsing a percentage into
  `used/limit` invents precision the source never gave us, and pillar 4 says
  meters must not lie.
- `severity` (`normal` | …) is a server-side judgement we get for free — prefer
  it over inventing our own ⟨tune 80%⟩ threshold where present.
- No overage on this plan: `extra_usage.is_enabled: false`, `spend.enabled:
  false`, `can_purchase_credits: false`, `spend.used = $0.00`.

**Rule-0.6 goldmine — the schema visibly churns.** The body carries obviously
internal/unreleased codenamed buckets, all null: `seven_day_cowork`,
`seven_day_omelette`, `tangelo`, `iguana_necktie`, `omelette_promotional`,
`nimbus_quill`, `cinder_cove`, `amber_ladder`. This is direct evidence for the
fragile-adapter posture: **consume `limits[]`, tolerate and IGNORE unknown
top-level keys, never enumerate buckets.** The fixture retains the codenames
deliberately as that evidence.

**D24 (billing bucket) — strong lean, not yet a decision.**
`seven_day_oauth_apps` is **null** — that is the bucket that would plausibly
carry non-interactive / third-party-app usage — while `session` and `weekly_all`
are both populated and moving. The lean: VIMES-spawned SDK work consumes the
SAME 5-hour/weekly buckets as interactive use, i.e. Wes's dongfu runs did NOT
draw on a separate automation credit. **This is a null-based inference and must
not be promoted to a decision on its own** (a null can mean "no usage", "not on
this plan", or "not populated"). Confirm by correlation: sample the endpoint
before/after a known headless run and observe WHICH meter moves. That
correlation is the D24-settling experiment; it belongs in slice-5 step 2.

**Adapter constraint (operational).** The OAuth access token expires (observed
~6 h validity) and the CLI owns refreshing it. A daemon adapter reading the same
credentials file will eventually present a stale token and get 401 → it must
degrade to **stale**, never crash and never silently show old numbers as
current. This is the staleness path, exercised by a real failure mode.

**Second endpoint, for the record:** `/api/claude_code/policy_limits` also
returns 200 but is policy/compliance flags (`restrictions`,
`compliance_taints`, `defaults`) — **not** usage. Noted so nobody chases it.

### 2026-07-21 — SPIKE U2 (slice 5): OTel direct ingest works, and carries the interactivity signal

**Method:** confirmed the CLI honors the full `OTEL_*` env set + 
`CLAUDE_CODE_ENABLE_TELEMETRY` (bundle strings), then ran a minimal
`claude -p` (haiku, to spare the binding Fable weekly cap) under `env -i` with a
clean environment, exporting OTLP/HTTP JSON to a throwaway local listener.
**Direct ingest confirmed — no collector process.** Fixture (identity redacted):
`fixtures/usage/otlp-metrics-2026-07-21.json`.

**Two streams arrive:** `POST /v1/metrics` and `POST /v1/logs`.
Metrics observed (all `sum`):

| metric | unit | notes |
|---|---|---|
| `claude_code.token.usage` | tokens | 4 points, split by `type`: `input` / `output` / `cacheRead` / `cacheCreation` |
| `claude_code.cost.usage` | **USD** | a real cost figure ($0.050549 for the test call) — MORE than JSONL gives |
| `claude_code.session.count` | — | with `start_type` |
| `claude_code.active_time.total` | s | wall-clock attention |

**Attribute keys are the contract:** `model`, `query_source` (`main` — so
subagent attribution is available), and — the prize — **`terminal.type`:
`interactive` | `non-interactive`**. That is exactly the interactivity signal
`usage_block` lacks and that D24 needs. Resource attributes carry
`service.version` (= CLI version), a free drift signal.
`/v1/logs` additionally streams session events (`hook_execution_start`,
`permission_mode_changed`, `plugin_loaded`, `hook_registered`).

**PII caveat (matters if VIMES ever ships to anyone else):** every data point
carries `user.email`, `user.id`, `user.account_uuid`, `user.account_id`,
`organization.id`, `session.id`. On Wes's own box this is his own data; a
product-ized VIMES ingesting this is handling identity, not just numbers. The
fixture redacts them.

### 2026-07-21 — SPIKE U3 (slice 5): JSONL accounting is ATTRIBUTION, not headroom — the finding that reshapes the slice

Folded the `usage_block` events already in `events.db` with D17 dedupe.

**1. D17 is load-bearing, empirically.** 57 `usage_block` events → **30 counted,
27 duplicate `message.id`s skipped (47%)**. Naive summation would have inflated
every number by nearly 2×. The slice-4 cache projection's dedupe is validated
against real data, not just reasoning. (16 events carry NO `messageId` —
harness/PTY paths — and therefore cannot be deduped: a residual, bounded risk.)

**2. THE HEADLINE — local sources are account-BLIND.** The endpoint reports the
5-hour window at 29–35% consumed. Over that same 5 hours, VIMES's JSONL holds
**ZERO `usage_block` events** (its whole span is 2026-07-14 → 2026-07-20).
Reason: VIMES only sees sessions it HOSTS, while the limits are **account-wide**
— every Claude Code invocation anywhere (other terminals, other machines, the
web, and this very orchestrator session) draws on the same window.

**This inverts the spec's assumption.** §3.6 calls JSONL accounting
"bulletproof" — it is, but only for *attribution*: "what did VIMES-hosted work
consume." It can never answer *"how much headroom do I have?"* And OTel shares
the same blindness (it only covers sessions VIMES spawns with the env set).
**Only the `/api/oauth/usage` endpoint is account-wide.**

Consequences, binding on slice-5 design:
- **Source precedence is not a preference, it is a type distinction.** Headroom
  comes from the ENDPOINT ONLY. Local sources supply attribution, burn rate and
  cost. A local source must NEVER be allowed to impersonate a headroom number.
- **The kill criterion sharpens:** if the endpoint dies, JSONL/OTel cannot
  substitute. The honest degradation is headroom → **unknown** while attribution
  keeps working — which is exactly what the `fresh | stale | unknown` staleness
  model already prescribes. Meters that lie are worse than meters that don't
  exist (pillar 4).

### 2026-07-21 — D24 correlation experiment: no separate automation bucket

Ran a KNOWN non-interactive session (`claude -p`; OTel independently labelled it
`terminal.type: non-interactive`) between two endpoint probes.

| meter | before | after |
|---|---|---|
| `session` (5-hour) | 29% | **35%** |
| `weekly_all` | 52% | 52% |
| `weekly_scoped` (Fable) | 64% | 64% |
| `seven_day_oauth_apps` | null | **still null** |

**Honest confound:** the orchestrator's own session was consuming the same
window between probes, so the **+6 magnitude is NOT attributable to the test run
alone**. The *direction* is what carries evidence: a non-interactive run
produced **no new bucket** and left `seven_day_oauth_apps` null while the
standard session window moved.

**Reading (recommended for ratification, not unilaterally decided — rule 0):**
Claude Code usage, interactive or headless, consumes the **standard 5-hour and
weekly windows**; there is no separate automation credit on this plan
(`extra_usage.is_enabled: false`, `can_purchase_credits: false`). The bucket's
NAME (`oauth_apps`) suggests it covers **third-party OAuth applications** — which
first-party Claude Code, `-p` or not, is not. **This answers Wes's standing
dongfu question: those runs burned the 5-hour/weekly windows, not a $100
automation bucket.** Promote D24 to a decision on his sign-off.

### 2026-07-21 — FINDING (step 4a, caught at orchestrator verification): weekly meters would re-alert every ~5h20m forever

Caught by an orchestrator probe against the step-4a agent's reported-green
`evaluateMeterAlerts`, before any daemon wiring existed. **ci-gate was fully
green (728 tests) with this defect present** — it is not a regression, it is an
uncovered interaction.

**Reproduction** (probe kept as `_orchVerify.test.ts` until folded into the real
suite): a `weekly-cap` meter, `resetsAt` unchanged, `percent` only ever rising —
i.e. the window demonstrably has NOT rolled over. Fire the 80% alert, advance six
hours, evaluate again → **the alert fires a second time.**

**Root cause.** `currentWindowStartIso` infers the window's start from the
bounded sample history (`METER_HISTORY_LIMIT = 64`). When no reset occurred
inside the retained span, `samplesSinceLastReset` returns *everything it has*, so
the inferred "window start" is simply the oldest retained sample — **a sliding
value that tracks the buffer, not the window.** At the 5-minute default poll
interval 64 samples ≈ 5h20m, which happens to approximate the 5-hour window, so
`endpoint:session` looks correct **by coincidence**. For `weekly_all` /
`weekly_scoped` the real window is 7 days and the inference is wrong by two
orders of magnitude.

**Consequence.** Any alert older than the retained span falls before the apparent
window start, is read as re-armed, and re-fires; the replacement alert then ages
out of the buffer 5h20m later and the cycle repeats. **A weekly meter parked
above threshold would buzz the phone roughly every five hours, indefinitely** —
precisely the pillar-5 noise the multi-threshold rule was carefully designed to
avoid. The care went into the wrong branch.

**The transferable lesson: absence of evidence of a reset was read as evidence of
a reset.** Running off the end of a bounded buffer is, in that code path,
indistinguishable from a genuine rollover — and the code chose the alarming
interpretation. This is the same family as the D25 rule (specifying a value's
security property says nothing about its semantics): here, specifying that
history is *bounded* said nothing about what the boundary MEANS to a reader of
that history. **Bounded retention must degrade to `unknown`, never to
"something changed".** That is the slice invariant applied to a buffer edge, and
it is the general form worth carrying: every place VIMES truncates, the truncation
edge needs an explicit meaning, or a consumer will invent an alarming one.

**Fix direction (a new agent, not a patch — rule 0.1):** the percent-drop signal
may only re-arm on **positive evidence** of a drop, i.e. when
`samplesSinceLastReset` actually located a reset boundary *inside* the retained
history. When the returned segment begins at the very first retained sample there
is no observed reset and that signal must **abstain**, leaving `resetsAt`
(which for weekly meters is the reliable signal, and does change on rollover) to
decide alone.

### 2026-07-21 — FINDING: meter freshness is BINARY, and the fresh band is wider than the poll interval

**Observed by Wes on the deployed build:** the meters strip read `59%` for the
5-hour window while a live probe of the endpoint returned `60%`. His words:
*"it's actually stale data with no way to detect that."*

**The numbers.** `DEFAULT_USAGE_POLL_INTERVAL_MS = 300_000` (5 min, daemon
`config.ts`; no `VIMES_USAGE_POLL_MS` override in `/etc/vimes/env`, so the
default is live). `METER_STALE_AFTER_MS_PREVIEW = 10 * 60 * 1000` (10 min, UI
`meterDisplay.ts`).

**Two distinct defects, one root cause.**

1. **Age is invisible inside the fresh band.** `displayPercent` is correctly
   nulled when a reading goes stale — the invariant holds literally — but
   `fresh` is a *binary*. A reading three seconds old and a reading nine minutes
   old render identically, as a bare confident number. The user cannot tell
   which they are looking at, which is exactly what Wes hit.
2. **The stale threshold is 2× the poll interval, so one missed poll still reads
   fresh.** A silently failing poller — and per U1 the *normal* daily failure is
   a 401 at ~6h token roll, which by design emits nothing — leaves a
   confident-looking number on screen for up to 10 minutes before anything marks
   it.

**Root cause: two independent ⟨tune⟩ constants that are only meaningful
relative to each other**, held in two packages, with nothing forcing the
relationship. That is the one-source-of-record rule (principle 9) violated on a
*derived relationship* rather than on a fact — a shape worth recognising again.

**The invariant needs sharpening, not just the code.** "A stale observation never
renders as a current number" was satisfied while the screen still misled. The
stronger form, adopted here: **a reading's AGE is always visible; freshness is a
gradient the user can see, not a binary the code decides for them.** Under
pillar 4 a meter that hides how old it is overstates its own precision, which is
the same failure as overstating its units (D26).

**Fix, split across the two remaining slice-5 units:**
- `staleAfterMs` is **derived from the poll interval by the daemon** and served
  in the derived read model — one number, one owner, relationship enforced.
- The UI shows a **continuously updating age** against `observedAt` (never
  against the browser's own fetch time — that would read "3 seconds ago" while
  the underlying reading is hours old and 401-blocked, the precise failure this
  slice exists to prevent).
- A **forced-refresh** route so the user can close the gap on demand, debounced,
  because the endpoint is unofficial and exposes no rate-limit headers.

**Not a cost concern (probed 2026-07-21):** three back-to-back calls to
`GET /api/oauth/usage` returned 200 with byte-identical percentages
(`session=60 weekly_all=54 weekly_scoped=64`) and **no rate-limit headers of any
kind**. It is an OAuth account-metadata read, not an inference call — a forced
poll consumes no window. The debounce exists for endpoint-citizenship (rule
0.6), not for usage.

### 2026-07-21 — observed: the cost hierarchy already exists on disk, retroactively (feeds D27)

Prompted by Wes's ask for a per-project / per-session / per-subagent cost
readout. Read-only survey of `~/.claude/projects`, rule 0.7 — observed, not
documented.

**Layout.** Project → session → subagents, with the parent link encoded in the
path:

```
~/.claude/projects/<project-slug>/
    <sessionId>.jsonl                          ← the session's own thread
    <sessionId>/subagents/agent-<agentId>.jsonl ← its subagents
```

**Volume: 641 session transcripts; 584 subagent transcripts across 10
projects.** Subagent transcripts are durable — the `/tmp/claude-*/…/tasks/
<agentId>.output` path a running session sees is a **symlink** into the
`subagents/` directory above, not ephemeral scratch as first assumed.

**Per-message content (sampled):** `usage` with cache tiers split out
(`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`,
`cache_read_input_tokens`, `input_tokens`, `output_tokens`), `model` per message,
and `message.id` — so D17 dedupe applies unchanged and pricing can be
model- and tier-correct.

**Why it matters:** every dimension of the D27 ask (project, session, subagent,
history) is derivable from data **already on disk for work already done**. A cost
ledger would ship with retrospective history on day one rather than beginning to
accumulate from its ship date.

**What is NOT there:** dollars. JSONL carries tokens only; USD comes from OTel
(`claude_code.cost.usage`, U2) which covers only sessions VIMES spawns with the
env set, and only going forward. Hence D27's price-table-validated-against-OTel
approach. Also absent: any statement of window SIZE — consistent with D26,
nothing on disk says how many tokens a 5-hour window holds, which is why
percent-of-window can only ever be estimated by correlation (D27 spike C1).

**Caution for whoever builds this:** `isSidechain` is `false` on all 2726
records sampled in the main transcripts, and a naive `*/*.jsonl` glob **misses
every subagent file** (they sit one level deeper). Both are easy ways to conclude
"subagent cost is invisible" and be wrong.

### 2026-07-21 — prior-art mining: usage/cost monitoring across the three decomposed repos

Read-only re-read of the decomposition series against one question: *how did
Jinn / agent-teams-ai / Codor solve usage and cost monitoring, and is any of it
better than what VIMES is building?* Full carry-over rows in
[decomposition/README.md](decomposition/README.md).

**Headline: this is the thinnest territory in the series** — roughly 12 lines of
substantive findings across ~355 lines of analysis. All three treat cost as a
bolt-on.

**Nothing beats VIMES observationally.** None of the three found the
account-wide usage endpoint (U1); none used OTel (U2); none had a first-party
USD figure; none pre-flighted work against remaining headroom. **All three were
structurally account-blind and none of them knew it** — Jinn sums its own
transcripts, ATA reads its own streams, Codor tracks its own runs, and each
presents "what my platform spent" as a budget. That is U3's finding applied
backwards, and it is why slice 5's source-precedence-as-a-TYPE-DISTINCTION rule
is the thing all three violate.

**Three things worth taking** (tracker rows updated):
1. **Codor's brake semantics** — work is *held*, not failed; release is one tap
   from the phone; the spend meter is always-on and never-blocking so the brake
   is never the first you hear of it. *"Operators kill, software doesn't."*
   Strictly better than slice 5's threshold *notification*. Wes's call
   (2026-07-21): ship the notification as scoped, **reserve the brake vocabulary
   now** (rule 0.5) so slice 7 upgrades it without a migration.
2. **ATA's auto-resume staleness matrix** — never stack timers; sanity-cap
   parsed reset times; past-due resets fall back to a buffered delay; at fire
   time re-check the flag, that the session is alive, and that it has not
   advanced past the run that hit the limit. Needed verbatim by
   `deferUntilReset`. **U1 improves the trigger:** they schedule reactively off a
   rate-limit event (i.e. only after hitting the wall); `limits[].resets_at`
   lets VIMES schedule *before* it.
3. **Per-spawner budget scope** — appears independently in all three (Jinn
   monthly-per-employee, ATA meters, Codor `budgets` table). Triple
   corroboration, the bar that promoted hooks and reviewer-close. Cheap to
   reserve alongside the meter schema, expensive after meters ship.

**The one prior-art verdict that U1/U2 overturned.** jinn §2.2 judged StopFailure
"more sanctioned than the unofficial `/usage` endpoint probe (D8)" — written
before U1 ran. StopFailure is official but **session-scoped**; the endpoint is
unofficial but **account-wide and alive**. They answer different questions and
principle 9 already forbids treating them as substitutes. Likewise jinn's
dollar-estimation "skip" was reasoned as *"notional on subscription"* — true of a
hardcoded table, false of OTel's first-party USD figure (see D27).

**Still unclaimed:** `billing_error` in the StopFailure reason enum (jinn §2.1
lists it; only `rate_limit` is routed). A distinct attention reason from
rate-limiting, and nothing in slice 5 or the tracker mentions it.

## Budget table (`--report`)

Design-intent targets from spec §8, listed so nothing gets pinned from memory.
All ⟨tune⟩; proposal at pin time is ±25% around observed, floors as well as
ceilings ("too fast" = a path skipped fails like "too slow").

| Measure | Design intent | Observed (profile) | Proposed band | Pinned? |
|---|---|---|---|---|
| reconnect-to-caught-up (mobile, tunnel) | < 2 s | — | — | no — harness pending |
| gate-to-push-delivered | < 10 s | — | — | no |
| cold-start-to-usable-session-list | < 5 s (log-size-independent via snapshots) | — | — | no |
| WS bufferedAmount drop threshold | ⟨tune⟩ | — | — | no |
| PTY reconnect ring buffer | 2 MB | — | — | no |
| JSONL tail latency (append→event) | < 300 ms | — | — | no |
| watchdog stale threshold | 5 min | — | — | no |
| meter staleness tolerance | 60 s | — | — | no |
| search first-results (house repo size) | < 1 s | — | — | no |
| initial mobile JS payload (gzipped, excl. lazy CM6/xterm) | < 300 KB | — | — | no |
| measured-quantity tolerance | ±10% relative | — | — | no |

Deterministic CI check, **no calibration needed** (lands slice 3): build
manifest shows CM6 and xterm in separate lazy chunks; entry chunk imports
neither.

## Spike results

### 2026-07-13 — Node 24 native-module coverage (finding F, slice 0 setup) ✅

**Method:** installed Node 24.18.0 via nvm on the dev box (Ubuntu 24.04);
`npm install node-pty better-sqlite3` in a clean scratch project;
loaded both, spawned a real PTY (`bash -c 'echo pty-ok'`, output captured via
`onData`), opened an in-memory better-sqlite3 DB with `journal_mode = WAL`,
round-tripped a row. **Result:** node-pty@1.1.0 and better-sqlite3@12.11.1 both
build (`pty.node`, `better_sqlite3.node` present) and function under Node
24.18.0 / npm 11.16.0. **The Node 24 pin holds; no fallback to 22.**
**Wart recorded:** npm 11's `allow-scripts` policy blocks both packages'
native install scripts by default — repo setup and CI must approve them
(`npm approve-scripts better-sqlite3 node-pty`) or installs silently skip the
native build. Baked into slice 0 step 1.

### 2026-07-13 — Slice-1 step-0 spikes: D4 billing bucket, SDK surface, fixture shape

**Method:** Claude Code CLI 2.1.207, SDK 0.3.207, isolated scratch project.
`/usage` TUI captured programmatically via node-pty (ANSI-stripped), readings
around identical tiny workloads per channel, two rounds. Raw captures +
scripts + typings citations in the spike job dir (see checkpoint).

**D4 headline: on this Max account, SDK `query()` and PTY interactive burn the
SAME meters** — 5-hour window + weekly caps. No non-interactive monthly credit
movement on either channel (usage-credits feature present but OFF). Kill
criterion's billing branch not triggered.

| Reading | Trigger | 5h window | Week all | Week Fable |
|---|---|---|---|---|
| R0 | baseline (pre-spike; Wes's other work already running) | 89% | 66% | 73% |
| R1+R2 | SDK round (cascade, see below) + PTY round | 95% | 66% | 74% |
| R3 | SDK round, isolated (`settingSources: []`) | 96% | 67% | 74% |
| R4 | PTY round | 96% | 67% | 74% |
| R5 | PTY round (cascade recurred) | 97% ("USAGE CRITICAL" banner) | — | — |

**Finding → D14 (settingSources inheritance):** an SDK `query()` with default
`settingSources` inherits the user's ambient `~/.claude/settings.json` — R1's
"reply ok" became an 8-turn, 6,351-output / 812k-cache-read cascade via Wes's
usage-warning Stop hook (its systemd-run / file-write attempts were all
denied — safe, but the burn was real). `settingSources: []` produced the
clean 4-message exchange. PTY has no such knob (inherits everything, by
design). Burn accounting: total spike burn exceeded plan solely due to this
cascade — which is itself D4-relevant data.

**Finding → D15 (PTY transcript absence):** three PTY-hosted spike sessions
(incl. one clean, patient run, clearly billed) produced NO transcript .jsonl
anywhere the spike could find. Unexplained; not chased at critical usage.
Rule 0.8 makes the JSONL tail the ONLY structure source for PTY sessions —
verify-row before the tailer is trusted (step 2 blocker).

**SDK surface (typings + live tests, citations in spike notes):**
`listSessions()`; `resume` option — **live-verified append-to-same-file, no
fork, no new file** (I3 groundwork); `forkSession` (option + standalone fn);
streaming input via `AsyncIterable` prompt / `Query.streamInput()`; `interrupt()`
(streaming mode required); **`canUseTool` callback is a clean promise-based
gate surface** ({title, displayName, requestId} — directly awaitable against
a phone round-trip). CLI: `-n/--name` confirmed (feeds D7). Naming mismatch:
CLI `--permission-mode manual` vs SDK type `default` — fragile-adapter note.

**Fixture shape vs 2.1.207 (SDK-channel transcripts only, per D15):** additive
except one breaking difference — real user records carry `message.content` as
an ARRAY of blocks, fixture has a bare string. Also whole record types absent
from fixtures (`attachment` — majority of lines in one real transcript —
`queue-operation`, `file-history-snapshot`, …); live SDK stream types never
appear in persisted JSONL (it's a strict subset). Action: fixture refresh
task queued (fix user content shape, add representative new record types,
re-stamp 2.1.207).

Remaining slice-ordered queue: D7
`claude -n` correlation + push delivery timing + iOS PWA re-auth bounce
(slice 2); D8 usage endpoint capture (slice 5); D5 streaming-input injection
(slice 6). Results land here dated, with method; decisions they force move to
decisions.md.

## Invariants

I1–I14 are specified in spec §7 with the slice each lands in. Slice 0 brings
I1, I2, I4, I5, I6, I8, I12, I13 under test. Exact where counted (events, seqs,
transitions); relative-epsilon where measured (latencies, projections).
