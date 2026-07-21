# Slice 4 (0.2) — Git & cache observability

> **Status 2026-07-20 (night shift):** skeleton drafted by the orchestrator +
> both spikes run (read-only, against real data) — see calibration.md
> "2026-07-20 — slice-4 spikes." Wes authorized "begin slice 4 per the usual
> workflow" while testing the polish pass; needs NOTHING from him (all local,
> no new external surface). Sensible defaults taken (below), deferred to his
> morning review. Construction proceeds sequentially; ⟨tune⟩ numbers stay
> PREVIEW/unpinned (Gate-D) — calibrated with sign-off, never pinned mid-build.

Spec reference: §9 slice 4 (line 352), §3.4 (git), §3.7 (cache observability).
This is the **0.2** milestone. Reviewing agent diffs is "the primary human
job" (spec §3.4) — this slice builds that job's tool + the cache/billing
visibility that tells you which bucket a run burned.

## Exit gate: human
Wes reviews a **real agent diff** through the git panel (desktop + mobile) and
it's genuinely usable for the accept/send-back review loop; the cache/billing
badges answer "which bucket did this burn, and was it cache-warm" at a glance.
Reframes like D20/D22 — "usable in real review," not a ceremonial week.

## Kill criterion
If the mobile hunk-diff view is not legible enough to actually review agent
diffs on a phone (the primary human job), halt and reconsider the diff-rendering
approach before the dispatcher (slice 6) is built to depend on it.

## Scope / explicitly out

**In:**
- **Git panel (daemon service + UI):** `status` (porcelain v2), per-file AND
  per-hunk diff (unified, mobile-legible), stage/unstage (hunk-level where
  feasible, file-level floor), commit (message composer), branch + worktree
  **listing**. Read + index/commit writes only.
- **Cache observability (core projection + UI):** a pure projection over the
  existing `usage_block` events → per-session **observed TTL tier** (rule 0.7:
  classified from `cache_creation.ephemeral_1h/5m_input_tokens`), **cache hit
  rate**, token totals, and a **billing-bucket badge** (from `service_tier` +
  session interactivity — answers the dongfu "5h window vs $100 automation
  bucket" question). **Cache-vandal warnings** before known cache-busting
  actions (model switch; MCP-connection churn on a live session).
- Hostile-input probes: git ops against out-of-roots paths refused (extends
  I14 / traversal posture).

**Out (explicit):**
- **The meter SYSTEM** — usage windows, weekly caps, monthly credit, burn rate,
  headroom, `deferUntilReset`/`requireHeadroom` gates. That is **slice 5**
  (§3.6). The `meters.ts` projection stays the slice-5 stub. Slice 4 does cache
  *observability* + billing *tagging*, not the meter service.
- Git **push / pull / fetch / merge / rebase / stash / cherry-pick** — the raw
  terminal (slice 3) is the escape hatch (pillar 7). VIMES stages, commits, and
  shows you diffs; network + history-rewrite git stays at a real shell.
- Worktree **creation / management** — slice 6 / D6 (the dispatcher owns
  isolation). Slice 4 only *lists* branches + worktrees.
- The **keep-warm pinger** (spec §3.7 — out; the notification loop carries cache
  economics at the observed 1h TTL).
- Multi-repo per root — one repo per project root (the enclosing `.git`).
- LSP / semantic diff — plain unified diff (pillar 3).

## Architecture (binding)

- **Git adapter (daemon, fragile-adapter boundary — rule 0.6):** shell out to
  the **system `git`** (present: 2.43.0, like ripgrep — no new npm dep;
  simple-git/isomorphic-git rejected to avoid lib lock-in and keep the parse
  surface ours). A single `GitAdapter` module owns every `git` invocation +
  parse; nothing outside it depends on git's output shape. Commands (spike-G
  confirmed stable): `git status --porcelain=v2 -z --branch`, `git diff
  --no-color [--staged] -- <path>` (unified hunks), `git worktree list
  --porcelain`, `git for-each-ref --format=... refs/heads/`, `git add`/`git
  restore --staged`, `git commit`. **Every path routed through
  `resolveWithinRoots`** (the security spine) — a repo must sit within an
  allowlisted root; git never runs outside it. The repo root for a given cwd is
  found via `git rev-parse --show-toplevel`, itself prefix-checked.
- **Git API (REST + WS):** `GET /api/git/status?root`, `GET /api/git/diff?root&path&staged`,
  `GET /api/git/branches?root`, `GET /api/git/worktrees?root` (reads);
  `POST /api/git/stage` / `/unstage` (path or hunk), `POST /api/git/commit`
  (message) — writes. All behind the Access wall (I14), all root-scoped.
  Human-initiated through the UI (behind Access auth) → **no permission-gate
  card** (gate cards are for *agent* tool calls, not the operator's own taps).
- **Cache-observability projection (core, pure — rule 0.3):** reduces
  `usage_block` events per `appSessionId` into `{ sampleCount,
  countedMessageIds, cacheReadTokens, cacheCreateTokens, inputTokens,
  outputTokens, cacheHitRate, ttlTier: '1h'|'5m'|'mixed'|'none', serviceTier }`.
  TTL classifier (spike-C, real data): `ephemeral_1h>0 && 5m==0 → '1h'`;
  `5m>0 && 1h==0 → '5m'`; both>0 → `'mixed'`; both==0 → `'none'`. Hit rate =
  `cache_read / (cache_read + cache_creation_input + input)`. **D17 dedupe is
  BINDING:** identical usage snapshots repeat within a turn — the projection
  dedupes by `message.id` (count each `messageId` once; blocks without a
  `messageId`, i.e. harness/PTY, count individually). Naive summation
  double-counts. Snapshot + tail replay byte-identical (like every projection).
  **No new event capture** — the data is already in the spine (rule 0.5 was
  satisfied upstream by the mapper's `usage_block`). **This projection is THE
  single source for cache observability** (principle 9) — one source per fact.
- **Billing bucket — flagged, NOT fabricated (D24, rule 0.7):** the bucket
  (5h-window vs $100-automation) is NOT derivable from a usage block alone;
  `service_tier` is captured RAW but no bucket label is invented. The bucket
  classifier waits for an interactivity-correlation spike (D24, likely slice 5).
- **Reserved session tag fields** (`observedTtlTier`/`observedBillingBucket` on
  the sessions projection) stay **unfed stubs** this slice — the
  cache-observability projection is the source of truth; the UI joins it to the
  session list by `appSessionId`. Do NOT emit `ttl_tier_observed` /
  `billing_bucket_observed` (that would create a second source — principle 9).
  Whether to later retire the reserved session fields is a cleanup for Wes.
- **Diff UI (mobile-legible — the primary-human-job surface):** per-hunk unified
  diff, monospace, horizontal-scroll contained (never body-scroll), add/del
  gutters, tap-to-stage a hunk, a commit composer. Real-estate-to-content
  (principle 11): no file rail tax — the diff owns the width. Desktop may show
  file-list + diff side by side (bespoke-desktop direction), mobile is one
  column.
- **Badges + warnings UI:** TTL-tier + billing-bucket badge on the session
  header/row; per-session cache hit rate; a cache-vandal confirm before a
  model switch or MCP-churning action on a live session.

## Assertions
- Git status/diff/branch/worktree **parse is deterministic** over a scripted
  git-repo fixture (harness builds a known git state → asserts the parsed
  model). Fragile-adapter boundary is the only thing that touches git bytes.
- Cache-observability projection is a **pure reducer**; snapshot+replay
  byte-identical; the TTL-tier + hit-rate classifier is a pure fn unit-tested
  over **real captured usage blocks** (rule 0.7 verify-row, spike-C samples).
- Git ops **scoped to allowlisted roots**: out-of-roots repo path refused
  (hostile-input, extends I14).
- All prior assertions green (rule 0.4); scenario double-run byte-identical.

## Build order (sequential agents; verify + commit between each)

| # | Step | Model | Delivers |
|---|------|-------|----------|
| 1 | Git adapter + API | opus | `GitAdapter` (subprocess + parse, fragile boundary, root-scoped), REST/WS status/diff/branches/worktrees/stage/unstage/commit, git-repo test fixture + hostile-input probes |
| 2 | Cache-observability projection + tags | opus | pure per-session projection over `usage_block` (TTL tier / hit rate / tokens / billing bucket), reserved session tags (rule 0.7), snapshot+replay assertions over real-shaped samples |
| 3 | Git diff UI (mobile hunk view) + stage/commit | opus | per-hunk unified diff (mobile-legible, principle 11), tap-to-stage, commit composer, branch/worktree list; **kill-criterion smoke to Wes early** |
| 4 | Cache/billing badges + vandal warnings + polish | sonnet | TTL/billing badges + hit-rate on session header/row, cache-vandal confirm, `--report` additions (diff parse latency, projection counts) |

## What would be a finding
- Any git op reachable outside the allowlist (halt — arbitrary-command threat).
- `git --porcelain=v2` / diff schema drift across git versions unstable enough
  to break the parse (fragile-adapter row; pin the observed git version like the
  CLI pin).
- The TTL-tier or billing-bucket classifier ambiguous on real data (a rule-0.7
  finding — record the observed shape, don't guess a mapping).
- Cache-observability projection failing snapshot/replay byte-identity
  (projection design flaw, not tuning).

## Defaults taken this night shift (Wes to confirm/veto in the morning)
1. Raw system-git subprocess + parse layer (no new npm dep). 
2. Git scope = read + stage/commit; push/pull/merge/rebase OUT; branch/worktree
   list-only.
3. Git ops root-scoped via `resolveWithinRoots`; no permission-gate card for
   operator-initiated git (behind Access already).
4. Commit identity = the box's configured git user; no special VIMES trailer
   unless requested.
5. Cache observability = pure projection over existing `usage_block`; billing
   bucket keyed off `service_tier` + interactivity; vandal thresholds unpinned.
6. Meter system deferred to slice 5.
