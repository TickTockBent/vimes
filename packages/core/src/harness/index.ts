export {
  createWorld,
  restart,
  ProjectionHost,
  STATIC_STREAMS,
  DEFAULT_WORLD_SEED,
  type World,
  type WorldSeed,
} from './world.js';
export {
  RunRegistry,
  orphanScan,
  recoveryRoutine,
  type ProcessHandle,
  type FakeProcessTable,
  type ResumeResult,
  type ResumeRefused,
  type ResumeSpawned,
} from './registry.js';
export { emitGuardedLiveness } from './liveness.js';
export { FakeSdk, type SdkFeedStep } from './fakeSdk.js';
export { FakePty, type PtyFeedStep } from './fakePty.js';
export { FakeClient } from './clients.js';
export {
  runScenario,
  type ScenarioProfile,
  type ScenarioArtifact,
  type ScenarioCounters,
} from './scenario.js';
export {
  ALL_PROFILES,
  happyPathDesktop,
  flakyMobile,
  concurrentClash,
  coldRestart,
  hostileInput,
  budgetWall,
} from './profiles/index.js';
export { checkHeadroomGate, checkDeferGate } from './profiles/budgetWall.js';
