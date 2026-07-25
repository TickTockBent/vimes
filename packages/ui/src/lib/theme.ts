// ── Theme decision logic (unit 6b·2) — PURE, TESTED ─────────────────────────
//
// The house rule (rule 0.3): the decision that maps a user's chosen MODE plus
// the OS preference to a concrete resolved theme lives here as a total function
// with no side effects. The composable (useTheme.ts) owns the effects —
// localStorage, the `data-theme` attribute, the matchMedia listener — and
// leans on these helpers for every actual choice.

// What the user PICKS. `auto` defers to the operating system.
export type ThemeMode = 'auto' | 'light' | 'dark';

// What actually gets rendered — always concrete, never `auto`.
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'] as const;

// The localStorage key the picker persists to (vimes-styleguide-TOKENS.md).
export const THEME_STORAGE_KEY = 'vimes-theme';

// The default mode before any choice has ever been made.
export const DEFAULT_THEME_MODE: ThemeMode = 'auto';

// Map (mode, OS-prefers-dark) → the concrete theme to render. `auto` follows the
// OS; an explicit light/dark ignores it entirely.
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'light') {
    return 'light';
  }
  if (mode === 'dark') {
    return 'dark';
  }
  // auto
  return systemPrefersDark ? 'dark' : 'light';
}

// Narrow an unknown persisted value (or anything) to a valid ThemeMode, falling
// back to the default. Total over hostile input — a corrupt localStorage entry
// must never wedge the picker.
export function parseThemeMode(raw: unknown): ThemeMode {
  return raw === 'auto' || raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME_MODE;
}

// The `data-theme` attribute value the DOM should carry for a mode. `auto` maps
// to null, meaning "remove the attribute" so the CSS `:root:not([data-theme])`
// OS-dark branch takes over — auto must NOT pin an explicit attribute, or it
// would stop tracking the OS.
export function dataThemeAttrFor(mode: ThemeMode): ResolvedTheme | null {
  return mode === 'auto' ? null : mode;
}
