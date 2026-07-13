import type { ScenarioProfile } from '../scenario.js';
import { happyPathDesktop } from './happyPathDesktop.js';
import { flakyMobile } from './flakyMobile.js';
import { concurrentClash } from './concurrentClash.js';
import { coldRestart } from './coldRestart.js';
import { hostileInput } from './hostileInput.js';
import { budgetWall } from './budgetWall.js';

export {
  happyPathDesktop,
  flakyMobile,
  concurrentClash,
  coldRestart,
  hostileInput,
  budgetWall,
};

// The six spec §7 profiles, in a fixed order (double-run + --report iterate this).
export const ALL_PROFILES: ReadonlyArray<ScenarioProfile> = [
  happyPathDesktop,
  flakyMobile,
  concurrentClash,
  coldRestart,
  hostileInput,
  budgetWall,
];
