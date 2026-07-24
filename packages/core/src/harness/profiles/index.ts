import type { ScenarioProfile } from '../scenario.js';
import { happyPathDesktop } from './happyPathDesktop.js';
import { flakyMobile } from './flakyMobile.js';
import { concurrentClash } from './concurrentClash.js';
import { coldRestart } from './coldRestart.js';
import { hostileInput } from './hostileInput.js';
import { budgetWall } from './budgetWall.js';
import { watchdogStaleProfile } from './watchdogStale.js';

export {
  happyPathDesktop,
  flakyMobile,
  concurrentClash,
  coldRestart,
  hostileInput,
  budgetWall,
  watchdogStaleProfile,
};

// The six spec §7 profiles PLUS the seventh — slice 6's watchdog scenario (step
// 10, the last machine gate): a stage run goes silent, the watchdog reports it
// stale and escalates to the `quarantine` VERDICT without ever killing anything.
// Fixed order (double-run + --report iterate this).
export const ALL_PROFILES: ReadonlyArray<ScenarioProfile> = [
  happyPathDesktop,
  flakyMobile,
  concurrentClash,
  coldRestart,
  hostileInput,
  budgetWall,
  watchdogStaleProfile,
];
