# Slice 1 — Find the value: one real session on a phone (operational plan)

*Skeleton designed 2026-07-13. Infra items provided by Wes same day:
hostname **vimes.example.dev**; tunnel created by me, Access secured by Wes
(**GitHub IdP** — fine, JWT validation is IdP-agnostic); D4 spike approved;
n=1 project **Dongfu** (`~/projects/games/dongfu`); phone **Android**; D3
decided (systemd on the host — see decisions.md). Spec reference: §9
slice 1; §3.11 auth; findings A/E.*

**Exit gate: human** — a full workday driven from the phone page against a
real project: gates answered, disconnects survived, one dormant resume, zero
forks, every unauthenticated probe rejected.

**Kill criterion:** if resume forks, reconnect loses events, or the phone loop
feels worse than SSH at n=1 — stop; the core promise isn't landing and no IDE
on top fixes it. Secondary: if D4 shows SDK sessions burn non-interactive
credit *and* PTY-hosted interactive proves unviable → halt for a topology
decision record.

## Scope / explicitly out

**In:** minimal daemon (Hono + `ws`, static serving) with the Access-JWT
middleware live from the first request (I14); Cloudflare Access on the tunnel
hostname; minimal mobile page (session stream, send message, answer a gate,
resume button); one hand-configured project, n=1; spikes first (below);
real-world I3/I11 verification (resume dormant, attempt concurrent resume,
confirm no fork in `~/.claude/projects/`).

**Out:** editor, search, files, tasks, push, polish, PWA manifest (slice 2),
raw terminal endpoint (slice 3 — auth probes cover HTTP + WS upgrade in this
slice; the PTY-endpoint probe joins when the endpoint exists), any multi-user
anything.

## Infra prerequisites (Wes provides; nothing below blocks steps 0–3)

1. **Hostname** on the existing cloudflared setup — suggested
   `vimes.example.dev` (pattern-matches vscode/genesis/handoff tunnels on
   this box).
2. **Tunnel**: a new named tunnel (suggest `vimes`) + DNS route. Either Wes
   creates it in the dashboard, or authorizes me to run
   `cloudflared tunnel create vimes` + config + systemd unit locally
   (pattern: `/etc/cloudflared/vimes.yml` → `http://localhost:4600`).
3. **Cloudflare Access application** covering the hostname, from his Zero
   Trust team. The daemon needs exactly two values: the **team domain**
   (`https://<team>.cloudflareaccess.com` — the JWKS URL derives from it) and
   the application **aud tag**. Policy: allow his identity (email OTP or SSO);
   session duration his choice (the expiry re-auth wart is slice-2 tested).
4. **D4 spike go-ahead**: two short real sessions (one SDK-hosted, one
   PTY-hosted, identical small workloads) + /usage observation before/after.
   Real usage burn, deliberately small. Also: confirm the plan tier (Max 5x
   assumed) so meter expectations are honest.
5. **The n=1 test project** — which real repo the workday gate runs against.
6. **Phone platform** for the gate (iOS vs Android — slice 2 cares more, but
   the page gets tested on the actual device from day one).
7. **D3 confirmation**: daemon on this box (the host) under systemd,
   bound to `localhost:4600`, cloudflared as the only route in. Deploying
   moves D3 to decisions.md.

## Versions observed at skeleton time (2026-07-13)

Claude Code CLI **2.1.207** (fixtures shaped on 2.1.206 — spike (c) re-checks
shape and re-stamps or refreshes); `@anthropic-ai/claude-agent-sdk` published
**0.3.207**; port 4600 free on this box.

## Spikes first (step 0 — deliverable is data in calibration.md, not code)

- **(a) D4 billing bucket** ⚠ blocks channel-choice defaults. Method: record
  /usage (all meters) → run a fixed small workload via SDK `query()` → record
  → same workload via PTY `claude` → record. Compare which meters moved.
  Repeat once for signal. Output: dated calibration.md entry + D4 moves to
  decisions.md (Wes prices the default).
- **(b) SDK surface check**: with 0.3.207 installed — session listing surface,
  `resume:` semantics (does resume append to the same transcript file?),
  streaming-input mode availability, interrupt. Also `-n <name>` flag
  presence on the CLI (feeds the D7 slice-2 spike). No-burn where possible;
  tiny burns acceptable within the (a) budget.
- **(c) fixture shape check vs 2.1.207**: compare a fresh real transcript's
  field layout against the committed synthetic fixtures; re-stamp provenance
  (or refresh fixtures) accordingly — release discipline, spec §9.

## Architecture (binding for the build steps)

- **Daemon composition** (packages/daemon): `main.ts` wires — production
  `Clock` (real time) + `IdSource` (crypto UUID, `// determinism-exempt`
  daemon-side only), `SqliteEventStore` at a configured path, `EventRouter`,
  projections booted via `bootFromSnapshot` (sqlite SnapshotStore lands NOW —
  its consumer, the boot path, has arrived per rule 0.5), Hono app, `ws`
  server on the same HTTP server, session host, JSONL tailer.
- **Auth (I14)**: one middleware in front of EVERYTHING including static and
  the WS upgrade. `createAccessJwtVerifier({ teamDomain, aud })` using
  **`jose`** (new daemon dependency — sanctioned here) with JWKS cached +
  refreshed; the verifier is injected so CI tests run a locally-minted JWKS
  (I14 probes: absent JWT, garbage JWT, wrong-aud, wrong-key, expired — each
  against HTTP routes AND the WS upgrade; every rejection → 401 zero product
  bytes + `auth_rejected` event; never log token contents).
- **WS protocol v0** (zod-validated control envelopes): client→server
  `{op:'subscribe', stream, lastSeq}` / `{op:'unsubscribe', stream}` /
  `{op:'send', appSessionId, text}` / `{op:'gate_response', appSessionId,
  requestId, response}` / `{op:'resume', appSessionId}`; server→client
  `{op:'subscribed', stream, head}` / `{op:'event', event}` /
  `{op:'refused', refusedOp, reason}` / `{op:'error', reason}` (amended at
  step-1 review: the original two-`op` refused shape was impossible JSON).
  One WS multiplexes all streams. **v0.1 (step 2)** adds `{op:'spawn',
  channel, cwd, name?}` → `{op:'spawned', appSessionId}` — the UI must be
  able to create a session. Step-1 note: projection state is derived on
  demand via snapshot+tail (no live wildcard fold — the core router is
  per-stream by design); revisit only if a consumer needs sub-second
  projection pushes. Reads via REST (`GET /api/projections/sessions`); writes and live
  events via WS. Backpressure (finding E): `bufferedAmount` >
  ⟨tune 4 MB PREVIEW⟩ at send time → close the socket; the client reconnects
  and resubscribes with lastSeq — same replay path as any disconnect.
- **Session host**: owns real processes, same ownership semantics the harness
  registry proved (I4/I11 shapes): SDK channel (`query()` streaming-input;
  SDK stream → vocabulary events; permission requests → `gate_fired` via
  `withNotificationTrigger`; completion → `run_completed` + liveness→dormant)
  and PTY channel (node-pty `claude` from the recorded cwd; structure comes
  ONLY from the JSONL tailer — rule 0.8). Resume = SDK `resume:` /
  `claude --resume <id>` from recorded cwd (I3); concurrent resume refused at
  the registry before any spawn (I11).
- **JSONL tailer**: chokidar scoped to the active project's transcript dir
  only; fs bytes → `TranscriptTail` → `mapTranscriptOutputs` → router.
  Quarantine events flow like any others (I8 stays live in prod).
- **UI (packages/ui, spins up)**: Vite + Vue 3 + Pinia, ONE mobile page:
  session list (liveness × attention badges), tap → stream view (rendered
  transcript incl. thinking/tool lines), send box, gate-answer buttons,
  resume button. No router beyond a hash param, no polish. Tailwind in.

## Build order (sequential agents; my verification + commit between each)

| # | Step | Model | Delivers | Assertions |
|---|---|---|---|---|
| 0 | Spikes a/b/c | sonnet | data → calibration.md; D4 decision material | — (rule 0.2: nothing pinned) |
| ⟸ | **Gate-D pause: Wes prices D4 → channel defaults; infra items land** | | | |
| 1 | Daemon assembly | opus | main wiring, sqlite SnapshotStore, auth middleware + jose verifier, WS protocol, REST reads, static serving | I14 (CI: forged/absent/expired/wrong-aud/wrong-key × HTTP+WS) |
| 2 | Session host | opus | SDK + PTY channels, resume/fork/refuse, JSONL tailer | I3, I11 (scripted against real `~/.claude/projects` state) |
| 3 | Mobile page | sonnet | the one page, against localhost daemon | manual: phone-on-LAN walkthrough |
| 4 | Deploy + Access | me + Wes | systemd unit, tunnel, Access app, live probes | I14 against the live hostname; D3 → decisions.md |

Steps 1–3 build and test against localhost with the injected fake verifier —
**nothing before step 4 needs the infra items.** The exit-gate workday follows
step 4.

## What would be a finding

Resume that forks (kill criterion, not just finding); SDK stream lacking a
usable permission-request surface (gate answering impossible on SDK channel —
forces PTY-first topology, D4-adjacent decision record); JSONL tail latency
so high the phone loop feels dead (measure against the ⟨tune 300 ms⟩ intent);
Access JWT validation impossible per-request at the WS upgrade (would gut
I14); chokidar missing appends on this filesystem.
