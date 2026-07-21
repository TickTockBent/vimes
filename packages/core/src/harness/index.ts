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
// `checkHeadroomGate` is GONE (calibration.md 2026-07-21): budget-wall's local
// stub was replaced by core's real `evaluateHeadroomGate` (meterDerivations.ts),
// which is the single source of record for the headroom verdict. `checkDeferGate`
// remains — slice 6 owns the real dispatcher, and nothing in core evaluates a
// deferral yet.
export { checkDeferGate } from './profiles/budgetWall.js';
