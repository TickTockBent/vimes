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
| 4 | Polish + gates | sonnet | build-manifest ci-gate step, interrupted-list polish, --report additions (buffer sizes, search latency observations) |

## What would be a finding

Any file API path reachable outside the allowlist (halt — that is the
arbitrary-file-API threat row from §3.11); ring buffer unable to satisfy I9
byte-identity (buffer design flaw, not a tuning matter); CM6 chunk landing
in the entry bundle (build config, deterministic gate catches); rg --json
schema drift (fragile-adapter row if observed).
