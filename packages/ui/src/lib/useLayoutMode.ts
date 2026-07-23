// The window/localStorage glue for the panel layout (desktop phase 3+4, §B).
// This is the ONE place `window.innerWidth`, the `resize` event, and the stored
// per-device override are read — a rule 0.3 boundary: this is presentation
// state (how many panels the viewport shows), never a projection input. ALL the
// arithmetic lives in lib/layoutMode.ts where it is unit-tested without a
// browser; this file only wires reactive `window` I/O into it, so there is no
// untested branch here worth a test (it is glue, and glue is jsdom-shaped).

import { computed, onUnmounted, ref, type ComputedRef } from 'vue';
import { MAX_PANELS, resolvePanelCount } from './layoutMode.js';

// A single localStorage key holds the per-device override (D39 #2). A missing or
// non-integer value → null, which resolvePanelCount treats as "no override, use
// the width". The KEY is here (not in layoutMode.ts) because it is I/O, not
// arithmetic.
const PANEL_OVERRIDE_STORAGE_KEY = 'vimes.panelOverride';

// SSR/jsdom safety (I8-flavoured): Vitest and any no-window context must not
// crash a component that happens to construct this. When there is no window we
// default the width to a desktop-ish value so tests of OTHER things render a
// sane layout, and treat localStorage as empty.
const hasBrowser = typeof window !== 'undefined';
const DEFAULT_NO_WINDOW_WIDTH = 1280;

function readStoredOverride(): number | null {
  if (!hasBrowser) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PANEL_OVERRIDE_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    // A NaN / non-integer stored value degrades to null — resolvePanelCount then
    // ignores it and the width decides (layoutMode.ts owns that validation, so
    // we hand it the raw-ish number and let it be the judge; null short-circuits
    // the obviously-absent case).
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    // localStorage can throw (private mode, disabled) — degrade to no override.
    return null;
  }
}

export interface LayoutMode {
  // How many trailing panels the viewport should render, reactive to width and
  // the stored override.
  readonly panelCount: ComputedRef<number>;
  // The largest N the default breakpoint table offers — for an override control.
  readonly maxPanels: number;
  // Set (and persist) the per-device override. Pass null to CLEAR it (fall back
  // to the width computation). Invalid values are stored as given but ignored by
  // resolvePanelCount, matching layoutMode.ts's "ignore, don't clamp" posture.
  setOverride(next: number | null): void;
  // Clear the override — sugar for setOverride(null).
  clearOverride(): void;
}

export function useLayoutMode(): LayoutMode {
  const width = ref(hasBrowser ? window.innerWidth : DEFAULT_NO_WINDOW_WIDTH);
  const override = ref<number | null>(readStoredOverride());

  function onResize(): void {
    width.value = window.innerWidth;
  }

  if (hasBrowser) {
    window.addEventListener('resize', onResize);
    onUnmounted(() => {
      window.removeEventListener('resize', onResize);
    });
  }

  const panelCount = computed(() => resolvePanelCount(width.value, override.value));

  function setOverride(next: number | null): void {
    override.value = next;
    if (!hasBrowser) {
      return;
    }
    try {
      if (next === null) {
        window.localStorage.removeItem(PANEL_OVERRIDE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(PANEL_OVERRIDE_STORAGE_KEY, String(next));
      }
    } catch {
      // Persisting is best-effort; the in-memory ref still drives this session.
    }
  }

  function clearOverride(): void {
    setOverride(null);
  }

  return { panelCount, maxPanels: MAX_PANELS, setOverride, clearOverride };
}
