# Slice 1 — testing runbook

> **Status end of 2026-07-14 (first smoke night):** Access live (GitHub IdP,
> the org team), daemon auth=configured, **S1–S8 PASS** (see results
> below). S9/S10 deferred to next session. Gate-D still owed: D4 (channel
> default — lean: SDK) and D14 (settingSources — lean: ['project'], running
> as PREVIEW default). 220 tests green at `9210c0c`+.

## Smoke results — 2026-07-14 evening (desktop + Android phone, live tunnel)

| # | Result | Evidence / notes |
|---|---|---|
| S1 | **PASS** | unauth → 302 to the org Access login, aud matches; zero product bytes |
| S2 | **PASS** | local no-JWT and garbage-JWT → 401 from the daemon's own I14 wall |
| S3 | **PASS** | GitHub login → session list |
| S4 | **PASS** | WS clean; no spurious auth_rejected |
| S5 | **PASS** | Dongfu sessions spawned/conversed; transcripts append live |
| S6 | **PASS ×2** | Write gates answered from desktop AND phone; log shows gate_fired→notification_trigger ADJACENT (I5 batch rule live) → attention_cleared(gate_answered); gate-test.txt + gate-test-2.md real |
| S7 | **PASS** | daemon restarted mid-generation: interrupted(recovery-no-process) → resume → same appSessionId, single mapping entry (no fork), cgroup shows exactly 1 owned child post-resume; "continue" completed the run (gate-test-3.md, 5.4 KB) |
| S8 | **PASS** (after fixes) | phone loop usable; 3 ergonomics defects found+fixed same night (keyboard overlay, non-growing composer, gate-card overflow) |
| S9 | deferred | next session |
| S10 | deferred | next session (capture transcript-dir listing as I3/I11 evidence) |

**Bonus observation (Wes):** the same session open on phone AND desktop
updates live in both — multi-client fan-out on one stream working in
production (the concurrent-clash profile's first half, observed live).

**Fixes shipped during smoke (all gated + committed):** prompt echo into the
event log; auto-resume-on-send; gate prompts carry tool+input (160-char cap);
thinking/tool/tool_result rendering; consecutive-usage collapse (D17); the
three mobile ergonomics fixes. New open question: D17 (usage_block
granularity/double-counting for slice-4/5 consumers).

Tomorrow's session: wire Access, deploy, smoke-test, first phone loop. The
**exit gate** (a full workday driven from the phone) is a separate later day —
tomorrow proves the plumbing so the gate day can be honest.

## 1. Wes: Cloudflare Access app (~10 min, dashboard)

1. one.dash.cloudflare.com → Zero Trust → Access → Applications → **Add an
   application → Self-hosted**.
2. Application domain: `vimes.example.dev` (the tunnel is already live and
   serving 502/fail-closed — safe meanwhile).
3. Identity provider: **GitHub** (add under Settings → Authentication →
   Login methods if not already present; needs a GitHub OAuth app — the
   dashboard walks through it).
4. Policy: Allow → Include → your identity (GitHub email). Session duration:
   your call (24h is comfortable for slice 1; the expiry re-auth wart is
   slice 2's on-device test).
5. **Hand me two values** from the app's Overview/settings:
   - **Team domain** — `<team>.cloudflareaccess.com`
   - **Application Audience (aud) tag** — long hex string
   They become `VIMES_ACCESS_TEAM_DOMAIN` and `VIMES_ACCESS_AUD` in the
   daemon env. Until they land, the daemon runs fail-closed (503 everything).

## 2. Me: deploy (after steps 1–3 verified)

- Env file (root-owned, mode 600): `/etc/vimes/env` — PORT, DB path
  (`~/.vimes/events.db`), team domain + aud, static dir (ui/dist).
- `vimes.service` systemd unit (After=network-online; ExecStart node
  packages/daemon/dist/main.js with nvm-node-24 absolute path; Restart=on-
  failure; User=ticktockbent). Enable + start.
- Verify boot line in journald; `~/homelab/services.md` gains the row.

## 3. Smoke checklist (desktop first, then phone)

| # | Check | Expect |
|---|---|---|
| S1 | `curl https://vimes.example.dev/api/health` (no Access cookie) | Access login interstitial or 401/403 from Access; NEVER daemon product bytes |
| S2 | curl direct `http://127.0.0.1:4600/api/health` without JWT header (on box) | 401 from daemon (its own I14 wall, independent of Access) |
| S3 | Browser (desktop) → hostname → GitHub login → app loads | session list renders |
| S4 | DevTools: WS connected; `auth_rejected` events NOT flowing for own traffic | clean stream |
| S5 | Spawn a session on Dongfu from the UI; converse | stream renders live; transcript grows in `~/.claude/projects/-home-ticktockbent-projects-games-dongfu/` |
| S6 | Trigger a permission gate; answer from the UI | canUseTool round-trip completes; attention badge set → cleared |
| S7 | `systemctl restart vimes` mid-run | session shows `interrupted`, attention intact (beat 7); one-tap resume works |
| S8 | Phone (Android Chrome): login → repeat S5–S7 | usable with thumbs |
| S9 | Phone airplane-mode 2 min mid-stream → return | caught up from lastSeq, zero lost events, no fork |
| S10 | Concurrent resume attempt (two tabs resume same dormant session) | second refused (I11), no fork in transcript dir (I3) |

## 4. Real-world I3/I11 evidence capture (during S10)

Before/after `ls -la` of the Dongfu transcript dir goes into calibration.md —
the slice's assertion row wants real-transcript evidence, not just harness.

## 5. Known-open items going into tomorrow

- D4/D14 await Wes's pricing (leans verified; step 2 builds with
  settingSources injectable, default parked as PREVIEW until priced).
- D15 (PTY transcript absence): step-2 env-matrix spike; PTY channel ships
  env-scrubbed regardless. If PTY structure stays unproven tomorrow, the
  phone loop runs SDK-channel sessions only — acceptable for the gate.
- Backpressure threshold, snapshot interval: ⟨tune PREVIEW⟩ defaults, pinned
  post-observation per Gate-D.
