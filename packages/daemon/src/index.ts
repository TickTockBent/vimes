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
  truncateGatePrompt,
  CLAUDE_SDK_CAPABILITIES,
  CLAUDE_PTY_CAPABILITIES,
  type SessionHostDeps,
  type SessionTailer,
  type SessionAdapter,
  type AdapterCapabilities,
  type InteractionAck,
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
export {
  createHookIngress,
  type HookIngress,
  type HookIngressDeps,
  type HookHost,
  type HookAuthResult,
  type HookIngestResult,
} from './hookIngress.js';
export {
  createCredentialPreflightProbe,
  createCliVersionProbe,
  type PreflightProbe,
  type PreflightResult,
  type CliVersionProbe,
} from './runtimeChecks.js';
export {
  buildSessionSettings,
  hookRelayCommand,
  mintSpawnSecret,
  secretMatchesDigest,
  sessionSettingsPath,
  sessionSettingsDir,
  writeSessionSettings,
  removeSessionSettings,
  type SpawnSecret,
} from './sessionSettings.js';
export { JsonlTailer, type JsonlTailerDeps } from './tailer.js';
export {
  loadOrCreateVapidKeys,
  createWebPushSender,
  buildPushPayload,
  reasonBody,
  isValidPushSubscription,
  vapidKeyPath,
  type PushSender,
  type PushSubscriptionRecord,
  type PushPayload,
  type VapidKeys,
} from './pushService.js';
export { PushSubscriptions } from './pushSubscriptions.js';
export { PushPipeline, shouldSuppressPush, type PushPipelineDeps } from './pushPipeline.js';
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
