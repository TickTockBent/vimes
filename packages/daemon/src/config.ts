import { homedir } from 'node:os';
import { join } from 'node:path';

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
}

const DEFAULT_PORT = 4600;
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

function parsePositiveInteger(rawValue: string, variableName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${variableName} must be a non-negative integer, got '${rawValue}'`);
  }
  return parsedValue;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const rawPort = env.VIMES_PORT;
  const rawSnapshotInterval = env.VIMES_SNAPSHOT_INTERVAL_MS;
  const rawBufferedLimit = env.VIMES_WS_BUFFERED_LIMIT;
  const rawDbPath = env.VIMES_DB_PATH;

  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePositiveInteger(rawPort, 'VIMES_PORT'),
    dbPath: expandHome(rawDbPath === undefined || rawDbPath === '' ? '~/.vimes/events.db' : rawDbPath),
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
  };
}
