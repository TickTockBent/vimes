import { describe, expect, it } from 'vitest';
import { extensionOf, languageForPath, type LanguageKey } from './languageByExtension.js';

describe('extensionOf', () => {
  it('extracts the lower-cased extension of a basename', () => {
    expect(extensionOf('/home/wes/app.TS')).toBe('ts');
    expect(extensionOf('README.md')).toBe('md');
  });

  it('uses only the last dot for multi-dotted names', () => {
    expect(extensionOf('/a/b/component.test.tsx')).toBe('tsx');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('treats a leading-dot dotfile as having no extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('/etc/.bashrc')).toBe('');
  });

  it('returns empty for a name with no dot', () => {
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('/usr/bin/node')).toBe('');
  });
});

describe('languageForPath', () => {
  const cases: Array<[string, LanguageKey]> = [
    ['index.ts', 'typescript'],
    ['index.mts', 'typescript'],
    ['App.tsx', 'tsx'],
    ['main.js', 'javascript'],
    ['bundle.mjs', 'javascript'],
    ['widget.jsx', 'jsx'],
    ['train.py', 'python'],
    ['lib.rs', 'rust'],
    ['NOTES.md', 'markdown'],
    ['pkg.json', 'json'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['App.vue', 'vue'],
  ];
  for (const [path, expected] of cases) {
    it(`maps ${path} → ${expected}`, () => {
      expect(languageForPath(path)).toBe(expected);
    });
  }

  it('falls back to none for unknown extensions and dotfiles', () => {
    expect(languageForPath('data.bin')).toBe('none');
    expect(languageForPath('Dockerfile')).toBe('none');
    expect(languageForPath('.gitignore')).toBe('none');
  });
});
