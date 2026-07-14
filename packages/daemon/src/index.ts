export const DAEMON = 'vimes-daemon';

export { SqliteEventStore } from './sqliteEventStore.js';
export { SqliteSnapshotStore } from './sqliteSnapshotStore.js';
export { loadConfigFromEnv, type DaemonConfig } from './config.js';
export { productionClock, productionIdSource } from './prodIds.js';
export { createDaemon, type Daemon, type DaemonDeps } from './app.js';
export { WsHub, type WsHubDeps } from './wsHub.js';
export {
  ACCESS_JWT_HEADER,
  AUTH_REJECTED_EVENT_TYPE,
  createCloudflareAccessVerifier,
  createLocalAccessVerifier,
  createUnconfiguredVerifier,
  createAccessAuthMiddleware,
  type AccessVerifier,
  type VerifyResult,
} from './auth.js';
