// The "should this click on an in-app link become a panel push?" decision
// (desktop phase 3+4, §E — the marquee interaction). Pure, no Vue/DOM: the .vue
// glue pulls `href`, the modifier flags, and the mouse button off the real
// event; THIS function makes the decision and hands back the Route to push, or
// `null` to let the browser do exactly what it does today.
//
// WHY A PURE HELPER FOR SOMETHING THIS SMALL. Under panels, a file-path code
// span in a stream must PUSH an editor panel beside the stream rather than open
// a new tab (D39 / MarkdownInlineNode's own comment). That means intercepting a
// left-click — and an interception that gets its "when NOT to intercept" wrong
// is a regression users feel: a ctrl/⌘-click that should open a new tab instead
// silently hijacks the current view, a middle-click that should open a
// background tab does nothing. Those edges are the whole risk, so they live in a
// tested function, not in a `.vue` we cannot test here.
//
// THE RULE. Intercept ONLY a plain left-click on an in-app hash link:
//   • left button (button === 0) — a middle/right click falls through, so the
//     browser's own new-tab / context-menu behaviour on the surviving `href`
//     still works;
//   • no modifier held (ctrl/meta/shift/alt) — ctrl/⌘/shift/alt-click is the
//     user explicitly asking the browser for a new tab/window, which the href
//     still delivers;
//   • the href is an in-app hash route (starts with '#/') — external links
//     (http/mailto) and non-route fragments are none of our business and keep
//     their `target="_blank"`.
// Everything else returns null → the browser handles it via the untouched href.

import { parseRoute, type Route } from './route.js';

export interface PanelLinkClick {
  // The clicked anchor's `href` attribute, verbatim.
  readonly href: string;
  // true iff ANY of ctrl/meta/shift/alt was held (the .vue ORs the four flags).
  readonly hasModifier: boolean;
  // MouseEvent.button: 0 = left/primary, 1 = middle, 2 = right.
  readonly button: number;
}

// Returns the Route to push as a new panel, or null to let the browser handle
// the click through the surviving href. Total: parseRoute never throws, so any
// in-app href resolves to some Route (the sessionList fallback at worst).
export function panelLinkClick(click: PanelLinkClick): Route | null {
  // A non-primary button (middle/right) is the browser's job — new tab, context
  // menu. Never intercept it.
  if (click.button !== 0) {
    return null;
  }
  // A held modifier is an explicit "open elsewhere" gesture; the href delivers it.
  if (click.hasModifier) {
    return null;
  }
  // Only in-app hash routes are ours. External links keep target="_blank".
  if (!click.href.startsWith('#/')) {
    return null;
  }
  return parseRoute(click.href);
}
