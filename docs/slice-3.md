# Slice 3 — Workspace (operational plan) → THE MVP LINE

> **Status 2026-07-20:** construction steps 1–3 complete + the spawn-fix
> class-bug + auth-timeout hardening — all verified, committed, UNDEPLOYED
> (446 tests; entry 44.6KB gzip; CM6 + xterm both lazy). Step 4 (polish:
> interrupted-list beat-7, `--report` additions) not started — minor.
> **DEPLOYED 2026-07-20 (D21):** roots widened to ~/projects, precache
> trimmed (SW 1158->147 KiB), one restart shipped editor/files/search/
> terminal + fixes live; verified wired (file API 401 behind auth, no session
> flood, daemon clean on both listeners). Step 4 polish deferred. Exit gate
> (code-server retired, used for real) is human — reframes like D20 (used in
> anger, not a ceremonial week). Awaiting Wes's on-device smoke.

*Skeleton drafted 2026-07-19 (night shift). **Construction not started** —
awaiting (a) slice-2 step 4 (on-device checkpoint) and (b) Wes's process
call on whether the slice-2 exit-gate week blocks construction or runs
alongside it (orchestrator recommendation: alongside — nothing here perturbs
the notification loop under test).* Spec reference: §9 slice 3, §3.4.

**Exit gate: human** — code-server retired for one full week of daily work,
desktop and mobile.
**Kill criterion:** if CM6 mobile editing is not comfortably better than
code-server-on-mobile for real edits, halt and reassess the editor layer
before building more on it.

## Scope / explicitly out

**In:** CM6 editor + file tree; upload (dialog + drag-drop, multipart) and
download (file + zipped folder); ripgrep search with tap-to-open;
preview-diff replace; raw PTY shell endpoint with reconnect ring buffer
(binary WS frames — I9); mobile keyboard toolbar; interrupted-recovery
polish (spec §4 beat 7); build-manifest lazy-chunk CI check (§8).

**Out:** git panel (slice 4), LSP-anything, multi-pane layouts, multi-file
tabs beyond a simple recent-list, collaborative anything.

## Architecture (binding)

- **File API (daemon, REST):** scoped to `projectRoots` ∪ registered session
  cwds; every path resolved + prefix-checked against the allowlist BEFORE
  any fs call (traversal denied at the boundary — hostile-input grows
  upload/download probes, extending the slice-1 posture). `GET
  /api/files/tree?root&path`, `GET /api/files/content`, `PUT
  /api/files/content` (mtime precondition: client sends the mtime it read;
  mismatch → 409 + client warn dialog — last-write-wins only after explicit
  confirm; n=1 MVP posture), `GET /api/files/download` (single file;
  `?zip=1` for folders — **new dep sanctioned: `yazl`**), `POST
  /api/files/upload` (multipart; >⟨tune 5 MB PREVIEW⟩ rejected until
  streaming lands post-MVP).
- **Search:** ripgrep `--json` subprocess (binary presumed present — it
  ships with the box; preflight-style check with structured failure);
  results stream over WS: `{op:'search', searchId, root, query, flags?}` →
  `{op:'search_result', searchId, file, line, col, submatches[]}` stream →
  `{op:'search_done', searchId, stats}`; cancel via `{op:'search_cancel'}`.
  Replace = server-computed preview diff (`{op:'replace_preview'}` →
  per-file hunks) then `{op:'replace_apply'}` gated on the preview's hash
  (no blind apply).
- **Raw terminal (the RCE-by-design endpoint, §3.11 honesty):** separate
  from Claude sessions: `{op:'term_open', cwd}` mints a shell PTY
  (`$SHELL`, env-scrubbed of `CLAUDE*` like everything we spawn);
  **payload bytes ride binary WS frames** tagged with a 1-byte
  terminal-id prefix (zod validates control envelopes ONLY — rule 0.8:
  bytes are never parsed); per-terminal reconnect ring buffer
  ⟨tune 2 MB PREVIEW⟩ (I9: within the window, reconnect renders the
  identical byte sequence a never-disconnected client saw — harness
  asserts byte-conservation with scripted feeds); `term_input` /
  `term_resize` / `term_close` control ops; auth unchanged (the wall is
  already in front); hostile-input adds unauthed + forged probes against
  the terminal ops specifically.
- **Editor (UI):** CM6 in a **lazy chunk** (dynamic import on first file
  open); lezer grammars ⟨tune: TS/JS, Vue, Python, Rust, Markdown,
  JSON/YAML⟩; mobile keyboard toolbar (tab, esc, arrows, ctrl-combos,
  save); save → PUT with mtime precondition; open-from-search and
  open-from-tree. xterm.js likewise lazy. **Build-manifest CI check
  (deterministic, no calibration):** entry chunk imports neither CM6 nor
  xterm; both live in separate lazy chunks; gate fails otherwise.
- **Interrupted-recovery polish:** interrupted sessions float to the top of
  the session list with a one-tap resume affordance (beat 7 is daily UX).

## Assertions

I9 (byte conservation across terminal reconnect, harness-scripted); hostile
upload/download traversal probes (I14 posture extension); build-manifest
check; all prior assertions green (rule 0.4).

## Build order (sequential agents; verification + commit between each)

| # | Step | Model | Delivers |
|---|---|---|---|
| 1 | File API + search | opus | scoped fs API w/ traversal wall + mtime preconditions, upload/download+zip, rg streaming + preview-gated replace, hostile probes |
| 2 | Editor + tree UI | opus | CM6 lazy integration, tree, mobile toolbar, save flow, open-from-search; kill-criterion smoke on the phone EARLY (first usable build goes to Wes before polish) |
| 3 | Raw terminal | opus | PTY endpoint, binary frames, ring buffer, I9 harness assertion, xterm lazy chunk, term hostile probes |
| 4 | Polish + gates | sonnet | build-manifest ci-gate step (DONE), interrupted-list polish, --report additions (buffer sizes, search latency observations) |

**Step-4 polish backlog (aimed by 2026-07-20 live use — the reason polish was deferred):**
- **[LANDED 2026-07-20 — D23]** **Terminal lifecycle — persistent, reapable, re-enterable terminals (Wes,
  2026-07-20; refined design).** Built: detach-on-navigate-away, inactivity
  reaper (`terminalsToReap` pure fn + daemon timer; `VIMES_TERMINAL_IDLE_REAP_MS`
  ⟨tune 1h PREVIEW⟩, 0=disabled), `resilient` flag, terminals list
  (`GET /api/terminals`, in I14 matrix), `term_set_resilient`. 491 tests green. The daemon ALREADY supports persistence (pty
  outlives a WS connection + ring-buffer reconnect-replay, I9); the UI kills
  shells by sending `term_close` on unmount. **Key architectural distinction:
  terminals are live-or-dead, NOT sleepable** — a shell's state is a live
  process tree (not serializable), unlike a session whose state is a
  replayable transcript. So "resume a terminal" can only mean reconnect to a
  still-alive shell; a resumable Claude *conversation* belongs in a SESSION,
  not a terminal (the terminal is the raw-shell escape hatch). Design:
  - Persistent by default: navigate-away DETACHES (keep terminalId, shell runs
    on), not close → re-enterable like sessions (pillar 2 for terminals).
  - **Inactivity reaper** (⟨tune 1h PREVIEW⟩, configurable, unpinned): a
    terminal idle (no I/O) for the window is auto-killed. INACTIVITY-based,
    not age-based (age would kill an active shell). Bounds accumulation.
  - **"Resilient" flag** (per-terminal checkmark): exempts from the reaper —
    the escape valve for a quiet-but-working shell (long compile/watch) or a
    keeper. An idle shell is nearly free (few MB, 0 CPU); the risks are
    accumulation + runaway processes, which reaper + resilient + list cover.
  - **Terminals list** on the landing screen: alive / last-active / resilient,
    tap-to-enter, one-tap kill — the visibility that makes persistence safe.
  - Needs a daemon "list active terminals" endpoint (terminalId is in-memory
    only today → survive page reload) + re-subscribe-with-offset on return.
  - Combined with `term_exit`: navigate-away = persist; shell-exits = show exit
    state + New shell / Close; explicit close or reaper = kill.
  Auto-reaping is behavior-shaping → earns a decision record when built; the
  1h is ⟨tune⟩ (calibrate, don't pin).
- Terminal free-text cwd (#2, Wes): a path input beside the root dropdown; server-side `resolveWithinRoots` already enforces the boundary, so arbitrary in-roots paths open and out-of-roots refuse.
- SearchPanel roots consistency: still uses `deriveRoots(sessions)`; switch to `effectiveRoots` like terminal/tree.
- Interrupted-list beat-7: float interrupted sessions to the top with one-tap resume (§4 beat 7).
- Gate-card target prominence (from smoke #4): surface `file_path`/target of a Write/Edit gate prominently instead of buried in truncated JSON — a safety-ergonomics win (a path was approved unread).
- `--report` additions: terminal ring-buffer sizes, search first-result latency (observations, unpinned).
**Gated on:** the kill-criterion verdict (does the editor replace code-server, esp. mobile) — polish only earns its build if the editor layer survives that call.

## What would be a finding

Any file API path reachable outside the allowlist (halt — that is the
arbitrary-file-API threat row from §3.11); ring buffer unable to satisfy I9
byte-identity (buffer design flaw, not a tuning matter); CM6 chunk landing
in the entry bundle (build config, deterministic gate catches); rg --json
schema drift (fragile-adapter row if observed).
