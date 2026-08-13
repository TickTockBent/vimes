import { describe, expect, it } from 'vitest';
import { nodeRefusalMessage } from './nodeRefusalMessages.js';

// The closed 11-reason vocabulary, spelled exactly as
// packages/daemon/src/nodeWriter.ts's `nodeRefusalReasonSchema` declares it.
const ALL_REASONS = [
  'unknown-project',
  'unknown-parent',
  'parent-closed',
  'cross-project-parent',
  'empty-name',
  'unknown-node',
  'already-closed',
  'node-closed',
  'unknown-session',
  'already-attached',
  'attached-elsewhere',
] as const;

describe('nodeRefusalMessage', () => {
  // 11 named assertions, one per reason, so a mapping quietly dropped for a
  // single reason (falling through to the verbatim default) reddens exactly
  // its own test rather than one loop silently covering the gap.
  it.each(ALL_REASONS)('reason "%s" returns a non-empty message that is not the raw reason string', (reason) => {
    const message = nodeRefusalMessage(reason);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toBe(reason);
  });

  it('an unknown reason renders exactly the input string, unchanged', () => {
    expect(nodeRefusalMessage('zorp-flagrant')).toBe('zorp-flagrant');
  });

  it('no message contains a tenant/workflow word (doctrine U4)', () => {
    for (const reason of ALL_REASONS) {
      expect(nodeRefusalMessage(reason)).not.toMatch(/task|stage|review|chapter|backlog/i);
    }
  });
});
