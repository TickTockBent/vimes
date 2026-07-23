// Evidence for §E's interception decision (desktop phase 3+4). The .vue glue is
// untested here, so the ENTIRE "intercept vs fall through" rule lives in
// panelLinkClick and is pinned below — every edge that, if wrong, breaks a
// ctrl-click / middle-click / external link.

import { describe, expect, it } from 'vitest';
import { panelLinkClick } from './panelLinkClick.js';

// A plain left-click: button 0, no modifier. The other fields vary per case.
const PLAIN_LEFT = { hasModifier: false, button: 0 } as const;

describe('panelLinkClick — intercepts a plain left-click on an in-app hash route', () => {
  it('a file-path link becomes an editor Route to push', () => {
    // This is the marquee case: a `#/files?path=…` code-span click.
    expect(panelLinkClick({ ...PLAIN_LEFT, href: '#/files?path=/tmp/a.ts&line=42' })).toEqual({
      view: 'editor',
      path: '/tmp/a.ts',
      line: 42,
      returnToParam: null,
    });
  });

  it('a session hash link resolves to a stream Route', () => {
    expect(panelLinkClick({ ...PLAIN_LEFT, href: '#/session/abc' })).toEqual({
      view: 'stream',
      appSessionId: 'abc',
    });
  });
});

describe('panelLinkClick — falls through (returns null) when the browser should handle it', () => {
  it('a held modifier (ctrl/⌘/shift/alt) is an explicit new-tab gesture', () => {
    expect(
      panelLinkClick({ href: '#/files?path=/tmp/a.ts', hasModifier: true, button: 0 }),
    ).toBeNull();
  });

  it('a middle click (button 1) opens a background tab — never intercepted', () => {
    expect(
      panelLinkClick({ href: '#/files?path=/tmp/a.ts', hasModifier: false, button: 1 }),
    ).toBeNull();
  });

  it('a right click (button 2) is the context menu — never intercepted', () => {
    expect(
      panelLinkClick({ href: '#/files?path=/tmp/a.ts', hasModifier: false, button: 2 }),
    ).toBeNull();
  });

  it('an external http link is not an in-app route — falls through to target="_blank"', () => {
    expect(panelLinkClick({ ...PLAIN_LEFT, href: 'https://example.com' })).toBeNull();
  });

  it('a mailto link falls through', () => {
    expect(panelLinkClick({ ...PLAIN_LEFT, href: 'mailto:a@b.com' })).toBeNull();
  });

  it('a bare "#" or non-route fragment falls through (not an in-app "#/" route)', () => {
    expect(panelLinkClick({ ...PLAIN_LEFT, href: '#' })).toBeNull();
    expect(panelLinkClick({ ...PLAIN_LEFT, href: '#top' })).toBeNull();
  });
});
