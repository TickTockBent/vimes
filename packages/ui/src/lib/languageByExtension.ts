// Language selection for the CM6 editor, driven purely by a file's extension
// (pillar 3: no LSP, no content sniffing — extension is the whole heuristic).
// This is a pure mapper so it can be unit-tested without loading CM6; the
// codemirror-setup module maps these keys to the actual lezer language packs
// inside the lazy chunk.

// The language keys the lazy CM6 setup knows how to instantiate. 'none' means
// mount CM6 with no language extension (plain text, still line-numbered).
export type LanguageKey =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'rust'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'vue'
  | 'none';

// Extension (lower-case, no dot) → language key. Kept explicit rather than
// clever so the sanctioned grammar set (TS/JS, Python, Rust, Markdown,
// JSON/YAML, Vue) is auditable at a glance.
const EXTENSION_TO_LANGUAGE: Readonly<Record<string, LanguageKey>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  vue: 'vue',
};

// Extract the lower-cased extension of a path's basename, or '' when there is
// no extension (a dotfile like `.gitignore` has no extension by this rule —
// the leading dot is the whole name, not a separator).
export function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) {
    // dotIndex 0 → dotfile (no extension); -1 → no dot at all.
    return '';
  }
  return basename.slice(dotIndex + 1).toLowerCase();
}

// Choose the CM6 language key for a path. Unknown/missing extensions → 'none'
// (plain text with line numbers), which is the graceful default the editor
// always renders something for.
export function languageForPath(path: string): LanguageKey {
  return EXTENSION_TO_LANGUAGE[extensionOf(path)] ?? 'none';
}
