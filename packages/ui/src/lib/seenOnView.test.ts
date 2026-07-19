import { describe, expect, it } from 'vitest';
import { shouldSendSeenOnMount, shouldSendSeenOnVisibility } from './seenOnView.js';

describe('seen-on-view (D9)', () => {
  it('sends seen when the page becomes visible', () => {
    expect(shouldSendSeenOnVisibility('visible')).toBe(true);
  });

  it('does NOT send seen while the page is hidden (a glance behind a locked phone never acks)', () => {
    expect(shouldSendSeenOnVisibility('hidden')).toBe(false);
  });

  it('mounting the view always sends seen (viewing IS the ack)', () => {
    expect(shouldSendSeenOnMount()).toBe(true);
  });
});
