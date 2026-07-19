import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  // Optional pinned CLI version (VIMES_EXPECTED_CLI_VERSION). At boot the daemon
  // probes `claude --version`; a mismatch OR an unpinned expectation emits
  // runtime_drift_observed + a console warn. NEVER gates a spawn (E4).
  expectedCliVersion: string | undefined;
}

const DEFAULT_PORT = 4600;
const DEFAULT_HOOK_PORT = 4601;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
// ⟨tune 4 MB PREVIEW⟩ — finding E backpressure ceiling; nothing pinned (rule 0.2).
const DEFAULT_WS_BUFFERED_LIMIT_BYTES = 4_194_304;
// Tunnel-only ingress (D3): never bind a routable interface.
const HARDCODED_BIND_HOST = '127.0.0.1';

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

  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePositiveInteger(rawPort, 'VIMES_PORT'),
    hookPort: rawHookPort === undefined ? DEFAULT_HOOK_PORT : parsePositiveInteger(rawHookPort, 'VIMES_HOOK_PORT'),
    dbPath,
    dataDir: rawDataDir === undefined || rawDataDir === '' ? dirname(dbPath) : expandHome(rawDataDir),
    expectedCliVersion:
      env.VIMES_EXPECTED_CLI_VERSION === undefined || env.VIMES_EXPECTED_CLI_VERSION === ''
        ? undefined
        : env.VIMES_EXPECTED_CLI_VERSION,
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
  };
}
