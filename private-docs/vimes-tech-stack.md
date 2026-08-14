# VIMES — Tech Stack Recommendation
**Companion to the design spec — draft 2 — 2026-07-13**

> A Node 24 + TypeScript daemon (the Agent SDK and node-pty leave no honest alternative), SQLite as the event log and the replay buffer both, and a Vite-built Vue 3 PWA whose two heaviest components — CodeMirror 6 and xterm.js — are framework-agnostic anyway. Priors were disregarded per instruction; most of the house stack re-earned its seat on merit. The load-bearing choices are the runtime, the event log, the WS replay protocol, and the auth choke point; the UI framework is explicitly swappable.

**Changes from draft 1 (red-pen round 1):** Node 22 → 24 LTS with node-pty prebuild verification moved into slice 0 setup (finding F); auth row added — Cloudflare Access JWT validation as core middleware (finding A); replay served from the event log, in-memory ring buffer deleted, backpressure policy added (findings B, E); OTLP ingest pinned to http/json via spawn env with a deliberately loose schema (amendment 2 riders); binary WS frames for PTY bytes; chokidar scoped to active project dirs; node:sqlite added to named alternatives; §9 amendments marked applied in spec draft 2.

## 1. What's proven vs. what's new

Instruction was to disregard priors, so nothing here is carried forward on familiarity. The house *process* stack — TypeScript strict, core logic as a pure headless package, Vitest harness, golden fixtures before every tag, CI double-run determinism gate — re-earns its place trivially: the spec's §7 harness contract is essentially a description of it. Treated as settled below.

The six problems this project has that no prior project did:

1. **Process ownership** — a daemon that owns PTYs and SDK runs, where the runtime choice is forced by two native/SDK dependencies (§3).
2. **Realtime fan-out with replay** — the seq/replay protocol from spec §3.2, now served straight from the log (§4).
3. **Heavy imperative widgets on mobile** — an editor and a terminal that dominate bundle and UX, and that no framework owns (§5).
4. **An append-only event log as the source of truth** — persistence chosen for replay, with snapshots for boot (§6).
5. **PWA push as a core-path feature** — notifications the design *depends* on, on iOS and Android (§7).
6. **An authenticated remote shell on a public hostname** — the PTY endpoint is RCE by design; auth is stack, not product (§8).

## 2. Core decisions

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 24 LTS (`engines` pin, `.nvmrc`, CI on the identical version) | node-pty and the official Agent SDK are Node; 24 has been LTS since Oct 2025 — prebuild coverage for node-pty verified in slice 0 setup, the only honest reason to fall back to 22 |
| Language | TypeScript strict, ESM | shared types across core/daemon/ui; house discipline |
| Daemon HTTP/WS | Hono + `ws` | tiny, TS-first; `ws` stays out of the way of our own replay protocol |
| **Auth** | **Cloudflare Access on the tunnel + daemon-side `cf-access-jwt-assertion` validation (JWKS, `aud`) on every HTTP request and WS upgrade** | one middleware at a single choke point, not a login system; spec §3.11, I14 |
| Agent channel | `@anthropic-ai/claude-agent-sdk` | official; structured streams; resume/fork/session-listing surface |
| PTY channel | node-pty | the only serious option; pins Node |
| Persistence | SQLite via better-sqlite3, WAL mode | single-user event log; synchronous API suits deterministic core; doubles as the replay buffer (I13) |
| **OTLP ingest** | **daemon endpoint accepting OTLP/HTTP JSON; `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` pinned in spawn env; loose zod (unknown fields tolerated)** | no collector process, no protobuf/gRPC; rule 0.6 applies to the OTLP schema too |
| File watching | chokidar, **scoped to active project dirs**; historical transcripts listed on demand | full-tree watch would enroll thousands of JSONLs and risk inotify limits |
| Search | ripgrep subprocess (`--json`) | already the agent's own search engine |
| Client build | Vite + vite-plugin-pwa | fast iteration; workbox service worker for push + install |
| Client framework | Vue 3 + Pinia | see §5 — narrow merit win as the reactive shell around imperative widgets; explicitly swappable |
| Editor | CodeMirror 6 | locked by spec pillar 3 |
| Terminal | xterm.js over **binary WS frames** | bytes in, bytes out; zod validates control envelopes, never payload bytes |
| Styling | Tailwind | mobile-first utility styling; swappable |
| Validation | zod at every boundary | WS envelopes, JSONL lines, API inputs — hostile-input scenario demands parse-don't-trust |
| Push | `web-push` (VAPID); Declarative Web Push evaluated in the slice 2 spike | standard; iOS path verified on-device |
| Testing | Vitest + fixture transcripts + scenario runner | spec §7 verbatim |
| Deploy | systemd unit on the dev host (per D3) | restart-on-crash, journald, boot persistence |

Repo shape (npm workspaces; no Turborepo at this scale):

```
vimes/
├── packages/
│   ├── core/        # headless: registry, liveness×attention model, reducers, schemas, scenario runner
│   │                # zero deps on node-pty, SDK, ws, sqlite — I/O injected (rule 0.3)
│   ├── daemon/      # Hono + ws, auth middleware, PTY/SDK adapters, JSONL tailer, sqlite EventStore,
│   │                # push, OTLP ingest, static serving of ui/dist
│   └── ui/          # Vite + Vue 3 PWA
├── fixtures/        # golden JSONL transcripts, scripted adapter feeds, golden DBs (versioned per Claude Code release)
└── scripts/         # report mode, fixture refresh, release gate
```

**Load-bearing (expensive to change):** Node runtime; the event schema, SQLite log, and persist-before-broadcast ordering (I13); the WS subscribe/replay protocol; the auth choke point; CM6; xterm.js; the core/daemon boundary itself.
**Swappable (one-module or one-package events):** Hono, Vue/Pinia, Tailwind, chokidar, the three usage adapters (by design), push transport (ntfy/Telegram fallback behind the same trigger events).

## 3. Process ownership

The daemon owns every Claude process on the box: n≈2–10 concurrent sessions, each a node-pty child or an SDK `query()` run, plus shell PTYs. Two dependencies decide the runtime. node-pty is the only production-grade PTY binding and it's Node-native. The Agent SDK's first-class implementation is TypeScript. A Rust or Go daemon would shell out to the CLI for everything, reimplement session streaming, and gain performance this workload will never need — the daemon is an I/O multiplexer, not a compute engine.

Topology (D2, resolved): **one daemon process** serving the API, the WS endpoint, and the built UI as static files. The draft-1 argument ("UI deploys are static swaps") was half of it; the closing half is that during slices 1–6 the code that churns is the registry and session-host logic itself, which forces restarts of the process-owning layer under *either* topology — the split only ever protected sessions from web-layer restarts, and the web layer is now static middleware that will never change independently. The real mitigation is `interrupted` + one-tap resume, promoted to daily UX (spec §4 beat 7), because dogfooding from slice 3 while actively developing the daemon makes restart-recovery an every-day path. Boundary: revisit only if daemon restarts hurt despite that polish, in which case extract PTY/SDK ownership into a supervisor process — the transport-agnostic registry makes that a refactor, not a rewrite.

Native-module discipline (finding F): node-pty and better-sqlite3 rebuild per Node ABI. `engines` pin in package.json, `.nvmrc`, CI on the identical version, and Node bumps gated like Claude Code bumps — fixture suite green before deploy. Node 24 prebuild coverage for node-pty is verified in slice 0 setup rather than assumed; if coverage is missing, pin 22 and record it.

## 4. Realtime fan-out with replay

Numbers that make it real: a busy session emits ⟨tune ~1–10⟩ events/sec; a phone on the tunnel drops and resubscribes constantly. The protocol (subscribe with lastSeq → replay → live) is specified and invariant-checked (I2, I13).

Decision: bare `ws` with our protocol, zod-validated envelopes (control frames only — PTY payload bytes ride binary frames unvalidated by design). Explicitly **not** Socket.IO: its auto-reconnect, acks, and buffering duplicate exactly the machinery I2 requires us to own. **Replay is served from the SQLite `(stream, seq)` index** — persist-before-broadcast means the log head is always ≥ any client's lastSeq, so there is no in-memory ring buffer, no overrun path, and no memory ceiling from buffered payloads (finding B). Backpressure is one line (finding E): a client whose socket `bufferedAmount` crosses ⟨tune⟩ is dropped and recovers through the same subscribe path as any disconnect. The client keeps one WS multiplexing all subscriptions with per-stream seq — connection count stays at 1 regardless of open panes, which matters through cloudflared. Boundary: none foreseeable; abandoning the replay protocol would be a spec change, not a stack change.

## 5. Heavy imperative widgets on mobile

The two components that dominate the client are framework-agnostic imperative libraries — CM6 and xterm.js mount into a DOM node and manage themselves. The framework is therefore the *shell*: session list, chat/transcript rendering, kanban, meters, diffs. What the shell needs: fine-grained reactivity for high-frequency stream updates without re-render storms, small bundle for mobile, and clean lifecycle control around the imperative mounts.

Evaluated on merit: **Svelte 5** wins bundle size; **SolidJS** wins raw update performance; **React** wins ecosystem (and all prior art is React); **Vue 3** wins nothing outright but is within a few percent of the leaders on every axis this app stresses — its ref-based reactivity maps one-to-one onto event-stream projections, and Pinia stores are literally reducers-with-subscriptions, which is what §3.3 consumers are. Since no framework owns the hard parts, the deciding weights are lifecycle ergonomics around imperative widgets (all four fine), bundle (Svelte > Vue ≈ Solid > React), and the cost of being wrong (low — the shell is the swappable layer). Vue 3 takes it as the strongest all-rounder; that it coincides with fluency is noted and was not the criterion. Reopen conditions: React, if we decide to wholesale adopt a prior-art component layer; Svelte, if the mobile bundle budget can't be met. The bundle budget itself is a ⟨tune 300 KB gzipped⟩ entry ceiling paired with a deterministic build-manifest CI check — CM6 and xterm in separate lazy chunks, entry imports neither — replacing draft 1's size floor, which was an indirect proxy needing calibration for something assertable directly.

No Nuxt/Next/SSR: a single-user authenticated app behind a tunnel has no SEO, no first-paint-anonymous, and a WS-driven state model; SSR is pure cost here.

## 6. The event log as the source of truth

SQLite in WAL mode, better-sqlite3. The synchronous API is a feature: the deterministic core calls an injected `EventStore` interface, and the production implementation being synchronous keeps persist-before-broadcast ordering trivial and the harness's in-memory implementation behaviorally identical. Events table append-only, enforced by the interface type (I12) — no update or delete operations exist to call. Write volume (⟨tune ≤ tens/sec⟩ across all streams) is three orders of magnitude below SQLite's comfort zone.

Boot and growth (finding C, D12): projections persist with `lastAppliedSeq` and boot replays only the tail, keeping cold start flat regardless of log size; I6's from-empty replay is a harness assertion over fixtures, not a boot path. Message bodies are inline (D12) — transcript-refs would chain replay to Anthropic's files surviving, which rule 0.6 refuses — and growth is revisited with real data post-MVP.

Schema versioning: a `meta(schema_version)` row from slice 0; migrations are pure functions over golden fixture DBs, executed as raw SQL **below** the EventStore interface — the sole sanctioned I12 exception (D11) — and the migration harness is built when the first real migration exists to run through it. The `replay --to <projection>` debug command lands in slice 0. Backups: `VACUUM INTO` on a timer + before every migration. Reopen Postgres only at product-ization.

## 7. PWA push as a core path

Pillar 5 makes push load-bearing, and platform reality is the risk, not the library. Android: installed-PWA push is solid. iOS: supported since 16.4 but **only for installed (Add-to-Home-Screen) PWAs**, with OS-level delivery-timing quirks — so the slice 2 spike tests **locked-phone delivery timing specifically** and evaluates **Declarative Web Push (iOS 18.4+) against SW-based push**, since it's the more reliable path on 2026-era iOS. Permission requires a user gesture after install: onboarding includes a deliberate enable-notifications tap, never an automatic prompt. Stack: vite-plugin-pwa/workbox service worker, `web-push` VAPID on the daemon, deep-link payloads. Push and service workers require a secure context; the tunnel provides it, and a hypothetical bare-LAN mode would have no push. The fallback (ntfy or Telegram adapter) is a one-module swap behind the same notification-trigger events, so the failure mode is a detour, not a redesign.

## 8. The authenticated remote shell (finding A)

The daemon exposes, on a public tunnel hostname, a PTY endpoint (a shell — RCE as designed) and an arbitrary-file API. Auth is therefore a stack decision with the same weight as the runtime. The shape: Cloudflare Access on the hostname handles identity; the daemon **independently** validates the `cf-access-jwt-assertion` header on every HTTP request and every WS upgrade — signature against the team JWKS (cached with refresh), `aud` against the Access app tag — in one middleware in front of everything including static assets. Unauthenticated: 401, zero bytes of product, `auth_rejected` evented (I14). The daemon never trusts the tunnel alone: a misconfigured Access policy or a direct-to-origin path must still hit a locked door, which is also why the daemon binds to localhost with cloudflared as the only route in.

Known wart, owned client-side: Access session expiry breaks WS upgrades with a redirect the WS client can't follow; the client detects the failed upgrade, bounces through a full-page re-auth, and resubscribes with lastSeq. The installed-iOS-PWA version of that bounce is genuinely awkward and is on-device tested in slice 2 alongside push. Boundary: this is deliberately not a login system; product-ization (multi-user) reopens auth as a product feature, at which point Access remains the outer wall and a real user model goes behind it.

## 9. Honest alternatives, named and dismissed

- **Bun** — attractive speed, native TS; dismissed because node-pty compatibility is the one place the daemon cannot be adventurous. Reopens when Bun's PTY story has been boring for a year.
- **node:sqlite** (finding F) — built-in since Node 22, would eliminate one of the two native modules that gate Node bumps. Dismissed for now: better-sqlite3 wins on maturity, API surface, and known WAL behavior under the exact synchronous patterns the EventStore needs. Reopens when node:sqlite's API surface covers the store's needs and a Node bump makes the prebuild pain real — the EventStore interface makes the swap a one-module event.
- **Rust/Go daemon** — dismissed per §3 (no official SDK, reimplements streaming, performance unneeded). Reopens if an official Rust SDK ships *and* the daemon measurably struggles, which at n=1 user it will not.
- **Socket.IO** — dismissed per §4. Reopens only if the custom replay protocol is removed from the spec.
- **Monaco / code-server embedding** — dismissed by pillar 3 and the project's founding grievance. Reopens never; that's the product being replaced.
- **Electron/Tauri native wrapper** — dismissed for MVP; the PWA is the mobile story. Reopens post-MVP if push or file-handling limits bite (the slice 2 spike is the evidence-gatherer).
- **Postgres / Turborepo / message brokers** — scale tooling without a scale problem. Reopen at product-ization.

## 10. Spec amendments (status: applied)

Draft 1's seven amendments were red-penned and folded into spec draft 2 with the review's edits: (1) D2 resolved single-daemon with the churn argument completed and interrupted-recovery promoted to UX beat 7; (2) OTLP direct ingest with http/json pinned via spawn env and loose schema; (3) I12 with migrations-below-the-interface clause; (4) bundle ceiling kept, size floor replaced by the deterministic build-manifest check; (5) engines pin + CI version match + risk-register native-module row; (6) split — schema_version row and `replay --to` in slice 0, migration harness deferred to first migration (D11); (7) iOS push spike extended to locked-phone timing, Declarative Web Push evaluation, and the permission-gesture onboarding. Findings A–F are reflected in spec §3.11, §3.2/§3.3, D12, the liveness×attention model, and this document's §2/§3/§8/§9.

---

*End of stack recommendation, draft 2.*
