// Proves vitest discovers this package (docs/slice-18.md §3.6: "U1 PROVES
// vitest discovery of the new packages' tests and records the mechanism in
// its checkpoint before U2 relies on it"). That is this file's whole and
// permanent job.
//
// ⚠ It was written as a TRIPWIRE against an EMPTY barrel, and it is neither of
// those things now: S18·U2 moved `composeStageInstruction` and
// `createTaskToolPayloadSchema` in, each with its own suite, so behaviour here
// is covered by tests that would themselves vanish from the run if discovery
// broke. What survives the barrel filling up is the §3.6 job above: this file
// imports the barrel and asserts nothing about it, so it stays green through
// every future move and reddens for exactly one reason — the package stopped
// being wired into the root vitest run.
import { describe, expect, it } from 'vitest';
import './index.js';

describe('ext-tasks discovery', () => {
  it('is discovered by the root vitest config', () => {
    expect(true).toBe(true);
  });
});
