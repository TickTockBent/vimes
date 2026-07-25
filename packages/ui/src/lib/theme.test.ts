import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  dataThemeAttrFor,
  parseThemeMode,
  resolveTheme,
  type ThemeMode,
} from './theme.js';

describe('resolveTheme', () => {
  it('light mode is always light, regardless of the OS preference', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('dark mode is always dark, regardless of the OS preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('auto follows the OS preference', () => {
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('auto', true)).toBe('dark');
  });

  it('covers every mode × both system prefs (total, only ever light|dark)', () => {
    for (const mode of THEME_MODES) {
      for (const systemPrefersDark of [false, true]) {
        expect(['light', 'dark']).toContain(resolveTheme(mode, systemPrefersDark));
      }
    }
  });
});

describe('parseThemeMode', () => {
  it('accepts the three valid modes verbatim', () => {
    expect(parseThemeMode('auto')).toBe('auto');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('dark')).toBe('dark');
  });

  it('falls back to the default for anything else (hostile / corrupt input)', () => {
    expect(parseThemeMode(null)).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode(undefined)).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode('')).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode('DARK')).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode('system')).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode(42)).toBe(DEFAULT_THEME_MODE);
    expect(parseThemeMode({})).toBe(DEFAULT_THEME_MODE);
  });

  it('defaults to auto', () => {
    expect(DEFAULT_THEME_MODE).toBe('auto');
  });
});

describe('dataThemeAttrFor', () => {
  it('auto yields null so the attribute is removed (OS tracking resumes)', () => {
    expect(dataThemeAttrFor('auto')).toBeNull();
  });

  it('explicit modes yield the matching attribute value', () => {
    expect(dataThemeAttrFor('light')).toBe('light');
    expect(dataThemeAttrFor('dark')).toBe('dark');
  });

  it('non-auto attr values round-trip back through parseThemeMode', () => {
    for (const mode of ['light', 'dark'] as ThemeMode[]) {
      const attr = dataThemeAttrFor(mode);
      expect(attr).not.toBeNull();
      expect(parseThemeMode(attr)).toBe(mode);
    }
  });
});
