// Proves vitest discovers this package (docs/slice-18.md §3.6: "U1 PROVES
// vitest discovery of the new packages' tests and records the mechanism in
// its checkpoint before U2 relies on it"). Not a test of behaviour — there is
// none yet, per this package's empty barrel — just a live tripwire: if this
// stops showing up in `npm test`'s file list, the workspace wiring broke.
import { describe, expect, it } from 'vitest';
import './index.js';

describe('ext-tasks discovery', () => {
  it('is discovered by the root vitest config', () => {
    expect(true).toBe(true);
  });
});
