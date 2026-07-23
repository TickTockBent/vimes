import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_USAGE_BASE_URL } from './usageEndpoint.js';

// Env-driven daemon configuration. The bind host is deliberately NOT an env knob
// (D3): the daemon binds 127.0.0.1 only, with cloudflared as the sole route in.
export interface DaemonConfig {
  port: number;
  dbPath: string;
  snapshotIntervalMs: number;
  accessTeamDomain: string | undefined;
  accessAud: string | undefined;
  staticDir: string | undefined;
  wsBufferedLimitBytes: number;
  bindHost: string;
  // settingSources passed to SDK query() for daemon-spawned sessions. Default
  // ['project'] is PINNED by D14 (decided 2026-07-19): loads .claude/settings.json
  // + CLAUDE.md, NOT the user tier / personal hooks that cascaded burn in the
  // slice-1 spike. The prior ⟨tune PREVIEW⟩ marker retired with that decision.
  sdkSettingSources: string[];
  // Absolute project roots a spawn cwd must sit within. Colon-separated env,
  // default empty = refuse ALL spawns (path-traversal discipline).
  projectRoots: string[];
  // Hook ingress port (127.0.0.1 only). A SEPARATE listener from the product
  // port: the cloudflared tunnel routes ONLY to `port`, so this ingress is
  // structurally unreachable from outside — the designed I14 exemption for the
  // per-spawn-secret hook channel (slice-2 step 1, deliverable A).
  hookPort: number;
  // Daemon data dir (per-session settings files, and later VAPID keys / caches).
  // Derived from dbPath's directory unless VIMES_DATA_DIR overrides.
  dataDir: string;
  // Optional pinned CLI version for the PTY channel (VIMES_EXPECTED_CLI_VERSION).
  // At boot the daemon probes the PATH `claude --version`; a mismatch OR an
  // unpinned expectation emits runtime_drift_observed + a console warn. NEVER
  // gates a spawn (E4).
  expectedCliVersion: string | undefined;
  // Optional pinned CLI version for the SDK channel (VIMES_EXPECTED_SDK_CLI_VERSION)
  // — the Claude Code binary the Agent SDK vendors and runs for every SDK session.
  // It is a SEPARATE pin on purpose: the vendored binary legitimately differs from
  // the PATH one (observed 2026-07-22: 2.1.207 vs 2.1.217), so reusing
  // expectedCliVersion here would emit permanent false drift. Unset → the SDK
  // channel is REPORTED at boot and never asserted (rule 0.2: an unpinned channel
  // has nothing to drift from; the value is pinned by hand after review).
  expectedSdkCliVersion: string | undefined;
  // VAPID `subject` (a mailto: or https: URL) sent with every web-push request
  // (VIMES_PUSH_SUBJECT). The default is a placeholder — a real operator sets a
  // reachable mailto so push services can contact them. Never a secret.
  pushSubject: string;
  // Max bytes the File API will preview/edit (GET /content, PUT /content) and
  // accept per uploaded file. Over this → refuse (413) rather than stream a huge
  // blob into the editor or half-write an upload (streaming upload is post-MVP).
  // VIMES_MAX_EDIT_BYTES overrides. ⟨tune 5 MB PREVIEW⟩ — placeholder (rule 0.2).
  maxEditBytes: number;
  // Inactivity window after which a non-resilient terminal shell is auto-reaped
  // (terminal-lifecycle backlog item). INACTIVITY-based, not age-based: the
  // window is measured from the shell's last input/output, so an active shell is
  // never killed. A value of 0 DISABLES reaping (the daemon skips the timer).
  // VIMES_TERMINAL_IDLE_REAP_MS overrides. ⟨tune 1h PREVIEW⟩ — behavior-shaping,
  // NOT pinned (rule 0.2): the 1h default is a placeholder to be calibrated.
  terminalIdleReapMs: number;
  // How often the usage-endpoint adapter is polled (slice 5 step 2). The
  // endpoint is the SOLE headroom authority (spike U3), so this is the cadence
  // at which headroom can possibly be fresh. A value of 0 DISABLES the poller
  // entirely (the daemon never creates the timer). VIMES_USAGE_POLL_MS
  // overrides. ⟨tune 5m PREVIEW⟩ — behavior-shaping, NOT pinned (rule 0.2).
  usagePollIntervalMs: number;
  // Base URL the usage adapter calls (`<base>/api/oauth/usage`). Overridable so
  // a test can point at a local stub; production leaves it at Anthropic's API.
  // VIMES_USAGE_BASE_URL overrides.
  usageBaseUrl: string;
  // Percentage lines that fire a meter alert (slice 5 step 4b). AN EMPTY LIST
  // DISABLES ALERTING ENTIRELY — no evaluation, no events, no push. Comma
  // separated via VIMES_USAGE_ALERT_PERCENTS; set it to an empty string to turn
  // alerts off. ⟨tune 80% PREVIEW⟩ — behavior-shaping, NOT pinned (rule 0.2).
  usageAlertPercents: number[];
  // Minimum spacing between FORCED polls (POST /api/usage/refresh). A call
  // inside this window is throttled: it re-derives and returns, it does not
  // poll. ⟨tune 30s PREVIEW⟩ — behavior-shaping, NOT pinned (rule 0.2).
  // VIMES_USAGE_REFRESH_MIN_INTERVAL_MS overrides; 0 disables debouncing.
  usageForcedRefreshMinIntervalMs: number;
  // How often the cost-ledger ingester re-scans Claude Code's transcripts into
  // the durable ledger db (slice 5b). This is an OPERATIONAL CADENCE, not a
  // calibrated meter band: the first scan captures the full backlog and the
  // incremental (path,size,mtime) machinery makes every later scan cheap, so the
  // interval is a freshness-vs-noise default open to tuning (like the push TTL),
  // NOT a behavior-shaping ⟨tune⟩ number. A value of 0 DISABLES ingestion
  // entirely: no store is opened, no db file is created, no timer runs.
  // VIMES_COST_INGEST_MS overrides.
  costIngestIntervalMs: number;
  // ─── the stage-run watchdog (slice 6 step 5b) ──────────────────────────────
  //
  // How often the watchdog wakes and examines every live stage run. This is a
  // SAMPLING CADENCE, NOT A THRESHOLD: it bounds detection LATENCY (a stall is
  // noticed at most one interval after it crosses the band) and never
  // correctness, because staleness is measured from event TIMESTAMPS rather
  // than from how many times we happened to look. Halving it does not make a
  // healthy run stale; it only makes the report arrive sooner. Rule 0.2 does
  // not apply to it for exactly that reason — no verdict depends on its value.
  // A value of 0 DISABLES the watchdog entirely (the daemon never creates the
  // timer), matching the usage poller and the terminal reaper.
  // VIMES_WATCHDOG_CHECK_MS overrides.
  watchdogCheckIntervalMs: number;
  // The staleness band: no transcript append for this long is condition (3) of
  // D30's three. **PINNED at 15 min by D30 (Gate-D, signed off 2026-07-22)**
  // against spike S3a's measurement of the real corpus — 70,232 healthy
  // machine-work gaps all clear it, the longest observed being 14.87 min. It is
  // therefore a real default rather than a ⟨tune⟩ placeholder. D30 records the
  // assumptions it carries (interactive work on this host, CLI 2.1.x, not
  // dispatcher stage runs) and that it is expected to be re-priced once real
  // stage runs produce their own distribution.
  // VIMES_WATCHDOG_STALE_AFTER_MS overrides.
  watchdogStaleAfterMs: number;
  // ⟨tune 3 PREVIEW⟩ — **UNPINNED, deliberately (D30: "no measurement covers
  // retry behaviour").** How many stale episodes a run may accumulate before
  // `assessStageRun` returns `quarantine`.
  //
  // ⚠ **NOTHING DESTRUCTIVE IS DRIVEN BY THIS NUMBER TODAY.** The watchdog
  // runner never quarantines and never retries (taskWatchdog.ts); the only
  // effect this value has is the `wouldQuarantine` flag recorded on a
  // `watchdog_stale`, which is the calibration column that will let the number
  // be priced against real work before anything acts on it. Named for what it
  // counts — EPISODES, not retries — because nothing retries.
  // VIMES_WATCHDOG_MAX_STALE_EPISODES overrides.
  watchdogMaxStaleEpisodes: number;
  // ⟨tune PREVIEW⟩ — **UNPINNED** backoff curve, read positionally by
  // `assessStageRun` and clamped to its last element. Same status as above: no
  // retry exists, so the only consumer of the delay it names is a verdict field
  // the runner discards. Kept because `WatchdogPolicy` requires it and because
  // step 6+ will need somewhere for the curve to live once it is earned.
  //
  // ⚠ **AN EMPTY CURVE IS REFUSED AT THIS BOUNDARY.** `assessStageRun` returns
  // `retryAfterMs: 0` for an empty curve — the documented degenerate case, "no
  // delay stated" — and in a RUNNER that reads as "retry immediately", i.e. a
  // hot loop. Nothing retries today so it cannot bite, which is precisely why
  // it is refused now, while refusing it is free.
  // VIMES_WATCHDOG_BACKOFF_MS overrides (comma-separated).
  watchdogRetryBackoffMs: number[];
  // ─── worker isolation (slice 6 step 8) ─────────────────────────────────────
  //
  // ⚠ **THE SHIPPING FLAG, AND IT DEFAULTS TO `off`.**
  //
  // `off` — every task, including one whose record says `isolation: 'worktree'`,
  // runs in `task.projectRoot`. Byte-identical to the behaviour before step 8; no
  // git command is issued on any dispatch path. D32 is NOT honoured, and the
  // dispatcher says so out loud rather than pretending otherwise.
  // `on`  — an `isolation: 'worktree'` task runs in its own git worktree.
  //
  // This is NOT a ⟨tune⟩ number and rule 0.2 is not what governs it — it is rule 0
  // itself. Isolation changes WHERE REAL WORK EXECUTES ON A REAL MACHINE: new
  // directories on a real disk, new branches in a real repo, agents editing files
  // nobody is watching. The whole path is built, wired and tested; the flip is a
  // human's, made deliberately, exactly as the watchdog's destructive half waited.
  // An unrecognised value is REFUSED at this boundary rather than read as `off` —
  // see parseWorktreeIsolation.
  // VIMES_WORKTREE_ISOLATION overrides.
  worktreeIsolation: WorktreeIsolationMode;
  // The parent directory every task worktree is created under.
  //
  // ⚠ **DEFAULTS TO A SIBLING OF THE DATA DIR, AND DELIBERATELY NOT INSIDE ANY
  // PROJECT ROOT.** The file/git/search/task APIs all scope themselves to
  // `projectRoots ∪ live-session cwds`, and the file browser lists what is under
  // them. A worktree root inside a project root would make every task's private
  // worker directory show up as if it were a project — a browsable, editable
  // sibling of the real repo — and would put N copies of a checkout inside the
  // very tree the allowlist exists to fence. Beside the data dir it is the
  // daemon's own bookkeeping, which is what it is.
  //
  // (Live-session cwds still enter the allowlist while a stage run is alive, which
  // is correct and is how the review panel can diff a worker's actual work.)
  // VIMES_WORKTREE_ROOT overrides.
  worktreeRoot: string;
}

// The two worlds, named. A string union rather than a boolean because the env var
// is the operator-facing surface and `VIMES_WORKTREE_ISOLATION=on` reads as what it
// does, where `=true` would not say what it is true ABOUT.
export type WorktreeIsolationMode = 'off' | 'on';

const DEFAULT_PORT = 4600;
const DEFAULT_HOOK_PORT = 4601;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
// ⟨tune 4 MB PREVIEW⟩ — finding E backpressure ceiling; nothing pinned (rule 0.2).
const DEFAULT_WS_BUFFERED_LIMIT_BYTES = 4_194_304;
// Tunnel-only ingress (D3): never bind a routable interface.
const HARDCODED_BIND_HOST = '127.0.0.1';
// Placeholder VAPID subject — a real deployment sets VIMES_PUSH_SUBJECT to a
// reachable mailto. `.invalid` is reserved (RFC 2606) so it can never resolve.
const DEFAULT_PUSH_SUBJECT = 'mailto:vimes@example.invalid';
// ⟨tune 5 MB PREVIEW⟩ — File API preview/edit + per-upload ceiling; not pinned (rule 0.2).
const DEFAULT_MAX_EDIT_BYTES = 5 * 1024 * 1024;
// ⟨tune 1h PREVIEW⟩ — terminal inactivity reaper window; behavior-shaping, not
// pinned (rule 0.2). 0 disables reaping.
const DEFAULT_TERMINAL_IDLE_REAP_MS = 3_600_000;
// ⟨tune 5m PREVIEW⟩ — usage-endpoint poll cadence; behavior-shaping, NOT pinned
// (rule 0.2). 0 disables the poller.
const DEFAULT_USAGE_POLL_INTERVAL_MS = 300_000;
// ⟨tune 80% PREVIEW⟩ — the threshold slice-5 names; behavior-shaping, NOT pinned
// (rule 0.2). An EMPTY list disables alerting.
const DEFAULT_USAGE_ALERT_PERCENTS: readonly number[] = [80];
// ⟨tune 30s PREVIEW⟩ — forced-refresh debounce; behavior-shaping, NOT pinned
// (rule 0.2). A forced poll costs no usage (probed: an OAuth metadata GET, not
// an inference call), but the endpoint is UNOFFICIAL and returns no rate-limit
// headers at all — so the debounce is about endpoint-citizenship (rule 0.6) and
// about a UI retry loop never becoming a hammer. 0 disables it.
const DEFAULT_USAGE_REFRESH_MIN_INTERVAL_MS = 30_000;
// Cost-ledger re-scan cadence, 30 min. An OPERATIONAL default open to tuning —
// like DEFAULT_PUSH_TTL_SECONDS, NOT a pinned ⟨tune⟩ band (rule 0.2 does not
// apply): the first scan captures the full backlog and later scans are cheap, so
// this is freshness-vs-noise, not a correctness knob. 0 disables ingestion.
const DEFAULT_COST_INGEST_INTERVAL_MS = 1_800_000;
// Watchdog SAMPLING CADENCE, 60 s — the same fixed-cadence idiom as
// TERMINAL_REAP_CHECK_INTERVAL_MS, and NOT a calibrated band (rule 0.2 does not
// apply): it bounds how long after a run crosses the band we notice, never
// whether the run is stale. 0 disables the watchdog.
const DEFAULT_WATCHDOG_CHECK_INTERVAL_MS = 60_000;
// D30's PINNED staleness band, 15 min. Signed off 2026-07-22 against spike S3a
// — a real, calibrated default, not a placeholder. See the field's own note for
// the assumptions it carries.
const DEFAULT_WATCHDOG_STALE_AFTER_MS = 900_000;
// ⟨tune 3 PREVIEW⟩ — UNPINNED (D30). Drives NO destructive action today; it only
// colours the `wouldQuarantine` calibration flag. See the field's note.
const DEFAULT_WATCHDOG_MAX_STALE_EPISODES = 3;
// ⟨tune PREVIEW⟩ — UNPINNED backoff curve (1 min, 5 min, 15 min). Nothing
// retries, so nothing waits these delays; the curve exists because
// `WatchdogPolicy` requires one. NEVER empty — see parseRetryBackoffMs.
const DEFAULT_WATCHDOG_RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

// ⚠ **`off`. THE SAFE VALUE IS THE ONE YOU GET BY SAYING NOTHING.** See the field's
// own note: this is a rule-0 flip, not a ⟨tune⟩ knob.
const DEFAULT_WORKTREE_ISOLATION: WorktreeIsolationMode = 'off';
// Appended to the data dir's own name to form its SIBLING: `~/.vimes` →
// `~/.vimes-worktrees`, `/var/lib/vimes` → `/var/lib/vimes-worktrees`.
const WORKTREE_ROOT_SIBLING_SUFFIX = '-worktrees';

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// ['project'] default per D14. A comma-separated env overrides; blank entries dropped.
const DEFAULT_SDK_SETTING_SOURCES: readonly string[] = ['project'];

function parseSettingSources(rawValue: string | undefined): string[] {
  if (rawValue === undefined) {
    return [...DEFAULT_SDK_SETTING_SOURCES];
  }
  return rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Colon-separated absolute roots; blank entries dropped, ~ expanded, each resolved.
function parseProjectRoots(rawValue: string | undefined): string[] {
  if (rawValue === undefined || rawValue === '') {
    return [];
  }
  return rawValue
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(expandHome(entry)));
}

// Comma-separated percentages. An UNSET env keeps the default; an env set to the
// empty string (or to nothing but separators) yields [] — which DISABLES
// alerting, deliberately and explicitly. Non-numeric entries are dropped rather
// than guessed at; the result is sorted and de-duplicated so the evaluation
// order never depends on how the operator typed it.
function parseAlertPercents(rawValue: string | undefined): number[] {
  if (rawValue === undefined) {
    return [...DEFAULT_USAGE_ALERT_PERCENTS];
  }
  const parsedPercents = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
  return [...new Set(parsedPercents)].sort((left, right) => left - right);
}

// The watchdog's backoff curve: comma-separated non-negative milliseconds, in
// the order they are read positionally.
//
// ⚠ **AN EMPTY CURVE IS REFUSED, LOUDLY.** Every other list-shaped knob here
// treats empty as "disable the feature" (alert percents), but this one cannot:
// `assessStageRun` documents `retryAfterMs: 0` as an empty curve's degenerate
// answer ("no delay stated"), and a runner that ever acts on it would read 0 as
// "retry immediately" — a hot loop against a wedged run. Nothing retries today,
// so this refusal costs nothing and closes the gap while it is free. A
// non-numeric or negative entry is refused for the same reason rather than
// silently dropped: a curve quietly shortened by a typo is a curve nobody
// reviewed.
function parseRetryBackoffMs(rawValue: string | undefined, variableName: string): number[] {
  if (rawValue === undefined) {
    return [...DEFAULT_WATCHDOG_RETRY_BACKOFF_MS];
  }
  const entries = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const parsedDelays = entries.map((entry) => parsePositiveInteger(entry, variableName));
  if (parsedDelays.length === 0) {
    throw new Error(
      `${variableName} must name at least one backoff delay — an empty curve would mean "no delay stated", which a runner reads as "retry immediately"`,
    );
  }
  return parsedDelays;
}

// The isolation flag. Case- and whitespace-insensitive ('ON' and ' on ' both mean
// on), because an operator who meant to turn it on and typed it in caps should not
// silently get the off world.
//
// ⚠ **AN UNRECOGNISED VALUE IS REFUSED, LOUDLY, RATHER THAN READ AS `off`.** Off is
// the safe direction, so defaulting to it looks harmless — but the failure it hides
// is the DANGEROUS one in the other sense: an operator who set
// `VIMES_WORKTREE_ISOLATION=true` and believed their workers were isolated would be
// running every task in the shared project root while thinking otherwise, and
// nothing would ever tell them. A daemon that will not boot is a much better
// outcome than a silent lie about isolation.
function parseWorktreeIsolation(
  rawValue: string | undefined,
  variableName: string,
): WorktreeIsolationMode {
  if (rawValue === undefined || rawValue.trim() === '') {
    return DEFAULT_WORKTREE_ISOLATION;
  }
  const normalizedValue = rawValue.trim().toLowerCase();
  if (normalizedValue === 'off' || normalizedValue === 'on') {
    return normalizedValue;
  }
  throw new Error(
    `${variableName} must be 'off' or 'on', got '${rawValue}' — refusing to guess, because guessing 'off' would let an operator believe workers are isolated when they are not`,
  );
}

function parsePositiveInteger(rawValue: string, variableName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${variableName} must be a non-negative integer, got '${rawValue}'`);
  }
  return parsedValue;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const rawPort = env.VIMES_PORT;
  const rawHookPort = env.VIMES_HOOK_PORT;
  const rawSnapshotInterval = env.VIMES_SNAPSHOT_INTERVAL_MS;
  const rawBufferedLimit = env.VIMES_WS_BUFFERED_LIMIT;
  const rawDbPath = env.VIMES_DB_PATH;
  const dbPath = expandHome(rawDbPath === undefined || rawDbPath === '' ? '~/.vimes/events.db' : rawDbPath);
  const rawDataDir = env.VIMES_DATA_DIR;
  const dataDir = rawDataDir === undefined || rawDataDir === '' ? dirname(dbPath) : expandHome(rawDataDir);
  const rawWorktreeRoot = env.VIMES_WORKTREE_ROOT;

  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePositiveInteger(rawPort, 'VIMES_PORT'),
    hookPort: rawHookPort === undefined ? DEFAULT_HOOK_PORT : parsePositiveInteger(rawHookPort, 'VIMES_HOOK_PORT'),
    dbPath,
    dataDir,
    expectedCliVersion:
      env.VIMES_EXPECTED_CLI_VERSION === undefined || env.VIMES_EXPECTED_CLI_VERSION === ''
        ? undefined
        : env.VIMES_EXPECTED_CLI_VERSION,
    expectedSdkCliVersion:
      env.VIMES_EXPECTED_SDK_CLI_VERSION === undefined || env.VIMES_EXPECTED_SDK_CLI_VERSION === ''
        ? undefined
        : env.VIMES_EXPECTED_SDK_CLI_VERSION,
    snapshotIntervalMs:
      rawSnapshotInterval === undefined
        ? DEFAULT_SNAPSHOT_INTERVAL_MS
        : parsePositiveInteger(rawSnapshotInterval, 'VIMES_SNAPSHOT_INTERVAL_MS'),
    accessTeamDomain: env.VIMES_ACCESS_TEAM_DOMAIN,
    accessAud: env.VIMES_ACCESS_AUD,
    staticDir: env.VIMES_STATIC_DIR,
    wsBufferedLimitBytes:
      rawBufferedLimit === undefined
        ? DEFAULT_WS_BUFFERED_LIMIT_BYTES
        : parsePositiveInteger(rawBufferedLimit, 'VIMES_WS_BUFFERED_LIMIT'),
    bindHost: HARDCODED_BIND_HOST,
    sdkSettingSources: parseSettingSources(env.VIMES_SDK_SETTING_SOURCES),
    projectRoots: parseProjectRoots(env.VIMES_PROJECT_ROOTS),
    pushSubject:
      env.VIMES_PUSH_SUBJECT === undefined || env.VIMES_PUSH_SUBJECT === ''
        ? DEFAULT_PUSH_SUBJECT
        : env.VIMES_PUSH_SUBJECT,
    maxEditBytes:
      env.VIMES_MAX_EDIT_BYTES === undefined || env.VIMES_MAX_EDIT_BYTES === ''
        ? DEFAULT_MAX_EDIT_BYTES
        : parsePositiveInteger(env.VIMES_MAX_EDIT_BYTES, 'VIMES_MAX_EDIT_BYTES'),
    terminalIdleReapMs:
      env.VIMES_TERMINAL_IDLE_REAP_MS === undefined || env.VIMES_TERMINAL_IDLE_REAP_MS === ''
        ? DEFAULT_TERMINAL_IDLE_REAP_MS
        : parsePositiveInteger(env.VIMES_TERMINAL_IDLE_REAP_MS, 'VIMES_TERMINAL_IDLE_REAP_MS'),
    usagePollIntervalMs:
      env.VIMES_USAGE_POLL_MS === undefined || env.VIMES_USAGE_POLL_MS === ''
        ? DEFAULT_USAGE_POLL_INTERVAL_MS
        : parsePositiveInteger(env.VIMES_USAGE_POLL_MS, 'VIMES_USAGE_POLL_MS'),
    usageBaseUrl:
      env.VIMES_USAGE_BASE_URL === undefined || env.VIMES_USAGE_BASE_URL === ''
        ? DEFAULT_USAGE_BASE_URL
        : env.VIMES_USAGE_BASE_URL,
    usageAlertPercents: parseAlertPercents(env.VIMES_USAGE_ALERT_PERCENTS),
    usageForcedRefreshMinIntervalMs:
      env.VIMES_USAGE_REFRESH_MIN_INTERVAL_MS === undefined ||
      env.VIMES_USAGE_REFRESH_MIN_INTERVAL_MS === ''
        ? DEFAULT_USAGE_REFRESH_MIN_INTERVAL_MS
        : parsePositiveInteger(
            env.VIMES_USAGE_REFRESH_MIN_INTERVAL_MS,
            'VIMES_USAGE_REFRESH_MIN_INTERVAL_MS',
          ),
    costIngestIntervalMs:
      env.VIMES_COST_INGEST_MS === undefined || env.VIMES_COST_INGEST_MS === ''
        ? DEFAULT_COST_INGEST_INTERVAL_MS
        : parsePositiveInteger(env.VIMES_COST_INGEST_MS, 'VIMES_COST_INGEST_MS'),
    watchdogCheckIntervalMs:
      env.VIMES_WATCHDOG_CHECK_MS === undefined || env.VIMES_WATCHDOG_CHECK_MS === ''
        ? DEFAULT_WATCHDOG_CHECK_INTERVAL_MS
        : parsePositiveInteger(env.VIMES_WATCHDOG_CHECK_MS, 'VIMES_WATCHDOG_CHECK_MS'),
    watchdogStaleAfterMs:
      env.VIMES_WATCHDOG_STALE_AFTER_MS === undefined || env.VIMES_WATCHDOG_STALE_AFTER_MS === ''
        ? DEFAULT_WATCHDOG_STALE_AFTER_MS
        : parsePositiveInteger(env.VIMES_WATCHDOG_STALE_AFTER_MS, 'VIMES_WATCHDOG_STALE_AFTER_MS'),
    watchdogMaxStaleEpisodes:
      env.VIMES_WATCHDOG_MAX_STALE_EPISODES === undefined ||
      env.VIMES_WATCHDOG_MAX_STALE_EPISODES === ''
        ? DEFAULT_WATCHDOG_MAX_STALE_EPISODES
        : parsePositiveInteger(
            env.VIMES_WATCHDOG_MAX_STALE_EPISODES,
            'VIMES_WATCHDOG_MAX_STALE_EPISODES',
          ),
    // An env set to the EMPTY STRING is refused rather than treated as "no
    // curve" — see parseRetryBackoffMs.
    watchdogRetryBackoffMs: parseRetryBackoffMs(
      env.VIMES_WATCHDOG_BACKOFF_MS,
      'VIMES_WATCHDOG_BACKOFF_MS',
    ),
    // An unrecognised value throws rather than defaulting — see the parser.
    worktreeIsolation: parseWorktreeIsolation(
      env.VIMES_WORKTREE_ISOLATION,
      'VIMES_WORKTREE_ISOLATION',
    ),
    // A SIBLING of the data dir, resolved absolute. Never inside a project root —
    // see the field's own note for why that matters to the file browser.
    worktreeRoot:
      rawWorktreeRoot === undefined || rawWorktreeRoot === ''
        ? resolve(`${dataDir}${WORKTREE_ROOT_SIBLING_SUFFIX}`)
        : resolve(expandHome(rawWorktreeRoot)),
  };
}
