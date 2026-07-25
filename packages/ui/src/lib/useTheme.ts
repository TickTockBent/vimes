// ── Theme store (unit 6b·2) — the side-effecting half of the picker ─────────
//
// A module-level SINGLETON: the chosen mode is one global fact (the whole app
// shares one theme), so state and the matchMedia listener live once at module
// scope rather than per-component. The PURE decision — mode × OS-pref → theme,
// which attribute to write, how to parse a persisted value — lives in
// lib/theme.ts and is unit-tested there. This file is the browser I/O glue
// (localStorage, `data-theme` on <html>, the OS-change listener) and is
// deliberately NOT unit-tested (house rule: glue is jsdom-shaped, the logic is
// tested where it is pure).

import { computed, readonly, ref, type ComputedRef, type DeepReadonly, type Ref } from 'vue';
import {
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  dataThemeAttrFor,
  parseThemeMode,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
} from './theme.js';

const hasBrowser = typeof window !== 'undefined';

function readStoredMode(): ThemeMode {
  if (!hasBrowser) {
    return DEFAULT_THEME_MODE;
  }
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // localStorage can throw (private mode, disabled) — default to auto.
    return DEFAULT_THEME_MODE;
  }
}

function persistMode(mode: ThemeMode): void {
  if (!hasBrowser) {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Persisting is best-effort; the in-memory ref still drives this session.
  }
}

function systemPrefersDarkNow(): boolean {
  return hasBrowser && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

// Write (or remove) the `data-theme` attribute on <html>. `auto` removes it so
// the CSS `:root:not([data-theme])` OS-dark branch resumes control — an auto
// choice must NOT pin an explicit attribute, or it would stop tracking the OS.
function applyModeToDom(mode: ThemeMode): void {
  if (!hasBrowser) {
    return;
  }
  const attr = dataThemeAttrFor(mode);
  if (attr === null) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', attr);
  }
}

// ── Singleton state, initialized once at first import ────────────────────────
const mode = ref<ThemeMode>(readStoredMode());
const systemPrefersDark = ref<boolean>(systemPrefersDarkNow());

// The concrete theme actually on screen — derived, always light|dark. Consumers
// that need to reason in JS (e.g. a future xterm/CodeMirror theme, OUT of this
// unit) read this rather than re-deriving.
const resolvedTheme = computed<ResolvedTheme>(() =>
  resolveTheme(mode.value, systemPrefersDark.value),
);

// Apply the stored choice to the DOM at module load, before first paint of any
// component, so there is no flash of the wrong theme.
applyModeToDom(mode.value);

// React to OS changes. Relevant only while in `auto` (where data-theme is
// absent and the CSS media query already re-themes the tokens on its own) — but
// we still track the ref so `resolvedTheme` stays accurate for JS consumers in
// every mode. Registered ONCE at module scope (singleton), never torn down per
// component.
if (hasBrowser && typeof window.matchMedia === 'function') {
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = (event: MediaQueryListEvent): void => {
    systemPrefersDark.value = event.matches;
  };
  if (typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', onSystemChange);
  } else if (typeof (darkQuery as MediaQueryList).addListener === 'function') {
    // Safari < 14 fallback: the deprecated addListener signature.
    (darkQuery as MediaQueryList).addListener(onSystemChange);
  }
}

function setMode(next: ThemeMode): void {
  mode.value = next;
  persistMode(next);
  applyModeToDom(next);
}

export interface ThemeController {
  // The user's chosen mode (auto | light | dark), read-only to consumers — they
  // change it through setMode so persistence + the DOM attribute never drift.
  readonly mode: DeepReadonly<Ref<ThemeMode>>;
  // The concrete theme currently rendered (light | dark).
  readonly resolvedTheme: ComputedRef<ResolvedTheme>;
  // Choose a mode: updates the ref, persists to localStorage, writes/removes the
  // `data-theme` attribute.
  setMode(next: ThemeMode): void;
}

export function useTheme(): ThemeController {
  return { mode: readonly(mode), resolvedTheme, setMode };
}
