# VIMES

**An agent-first remote IDE for Claude Code.** A daemon owns every Claude Code
process on a dev box and streams structured state to any browser — so a phone is
a full peer of the desk, not a degraded view of it.

The premise: when an agent writes most of the code, the human's job shifts from
typing to *supervising* — noticing a run has gone quiet, reading a diff, steering
a worker mid-turn, deciding what runs next. VIMES is built for that job. It
watches sessions rather than files, and it is designed so you can tunnel to any
depth (task board → live session → raw PTY) while living at the top.

> **Status: mid-build, and not yet packaged for anyone else to run.**
> The core is solid and the CI gate is green, but there is no release, no install
> path, and setup assumes a host configured much like the author's. Read it as a
> working system with its reasoning on display, not a product you can adopt today.

## What's actually built

Sessions (spawn, resume, interrupt, liveness), a live event stream over
WebSocket, a mobile-first PWA with push notifications, a file browser and editor,
search, a git review panel with mobile hunk diffs, raw PTY terminals, usage
meters, and a cost ledger that prices real token usage per session, per project
and per agent. In progress: the task system — a deterministic dispatcher that
owns task transitions and spawns stage runs.

## How it is built

The discipline matters more than the feature list, and it is machine-enforced:

- **A deterministic, headless core.** `packages/core` is pure logic — clocks,
  randomness and I/O are injected at the boundary. A CI grep gate fails the build
  on `Date.now`/`Math.random`/`crypto.randomUUID` in core.
- **Determinism proven by byte-comparison**, not asserted. Six scenario profiles
  (`happy-path-desktop`, `flaky-mobile`, `concurrent-clash`, `cold-restart`,
  `hostile-input`, `budget-wall`) run twice per CI run; a single differing byte
  fails the gate.
- **An append-only event log** is the source of record; all read models are folds
  over it, and replay equivalence (boot-from-snapshot === replay-from-empty) is a
  tested invariant.
- **Structured data only.** State comes from JSONL transcripts and SDK streams;
  PTY bytes are relayed verbatim and never scraped for meaning.
- **Observed truth over declared truth.** Claude's runtime behaviour is
  classified by measurement, never by documentation.

The reasoning behind every non-obvious choice is recorded rather than lost —
see [`docs/`](docs/).

## Requirements

- **Node 24** (`>=24 <25`; see `.nvmrc`). Native builds for `better-sqlite3` and
  `node-pty`, so a working toolchain is required.
- **Claude Code** on the host PATH.
- **`git`** and **`ripgrep`** as real binaries on PATH. (A shell alias for `rg` is
  not enough — the daemon spawns it directly.)
- **Cloudflare Access** in front of the daemon. Auth fails closed: an unconfigured
  daemon rejects every request by design rather than serving unauthenticated.

## Running it

```bash
nvm use            # Node 24
npm ci
npm run ci         # the full gate: typecheck, tests, UI build, determinism, grep gate
```

`npm run ci` is the quality bar made executable, and it is the thing to run
before trusting a change. `npm test` alone is not equivalent: workspace imports
resolve to `dist/`, so tests can run against stale build output unless
`npm run typecheck` has rebuilt it.

The daemon binds `127.0.0.1` only (hardcoded, not configurable) and expects a
tunnel in front of it. Configuration is by environment — `VIMES_PORT` (4600),
`VIMES_HOOK_PORT` (4601), `VIMES_PROJECT_ROOTS`, `VIMES_ACCESS_TEAM_DOMAIN`,
`VIMES_ACCESS_AUD`, and others read in `packages/daemon/src/config.ts`.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure deterministic logic: events, projections, pricing, task state machine, scenario harness. No I/O. |
| `packages/daemon` | Every I/O boundary: session host, PTY, SQLite, HTTP/WS, auth, git, search, cost ingest. |
| `packages/ui` | Vue 3 + Pinia PWA, mobile-first. |
| `docs/` | The design record — see below. |
| `scripts/ci-gate.sh` | The gate. |

## The design record

This project keeps its reasoning, which is the main reason an outside reader can
follow it at all:

- [`docs/README.md`](docs/README.md) — index of the suite and its working rules.
- [`docs/decisions.md`](docs/decisions.md) — append-only decision log. A reversal
  is a new dated entry, never an edit.
- [`docs/architecture.md`](docs/architecture.md) — standing constraints. Read
  before writing a projection.
- [`docs/calibration.md`](docs/calibration.md) — measurements, with the
  assumptions each band was pinned under.
- [`docs/risk-register.md`](docs/risk-register.md) — external surfaces presumed
  to drift, and the isolation plan for each.

## Caveats

Single author, no external contributors, and mid-build. There is no GitHub
Actions workflow — `scripts/ci-gate.sh` is run by hand, so CI is disciplined
rather than enforced. Some dependency advisories remain in the transitive tree;
what is reachable and what is not is tracked in the risk register.

## License

MIT — see [LICENSE](LICENSE).
