export const DAEMON = 'vimes-daemon';

export { SqliteEventStore } from './sqliteEventStore.js';
export { SqliteSnapshotStore } from './sqliteSnapshotStore.js';
export { loadConfigFromEnv, type DaemonConfig } from './config.js';
export { productionClock, productionIdSource } from './prodIds.js';
export { createDaemon, type Daemon, type DaemonDeps } from './app.js';
export { WsHub, type WsHubDeps } from './wsHub.js';
export {
  SessionHost,
  scrubClaudeEnv,
  type SessionHostDeps,
  type SessionTailer,
  type SdkQueryFactory,
  type SdkQueryHandle,
  type SdkStreamMessage,
  type SdkUserMessage,
  type SdkCanUseTool,
  type SdkPermissionResult,
  type PtyLike,
  type PtySpawnFactory,
  type PtySpawnOptions,
  type SpawnResult,
  type ResumeResult,
  type SendResult,
  type AnswerResult,
} from './sessionHost.js';
export { JsonlTailer, type JsonlTailerDeps } from './tailer.js';
export {
  encodeCwdForProjects,
  transcriptDirFor,
  transcriptFileFor,
  defaultProjectsRoot,
} from './transcriptPaths.js';
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
