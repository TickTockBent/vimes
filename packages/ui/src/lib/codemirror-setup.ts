// The ONE module that statically imports CodeMirror 6. It is loaded EXCLUSIVELY
// via dynamic import() (see EditorView.vue) so the bundler emits it — and its
// heavy lezer grammars — as a separate lazy chunk. The build-manifest CI gate
// (scripts/check-build-manifest.mjs) fails the build if the entry chunk ever
// reaches this file statically. Do NOT import it from anywhere eagerly.

import { EditorState, Annotation, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineUp,
  cursorLineDown,
  cursorGroupLeft,
  cursorGroupRight,
  cursorDocStart,
  cursorDocEnd,
  indentMore,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { vue } from '@codemirror/lang-vue';
import { basicSetup } from 'codemirror';
import type { LanguageKey } from './languageByExtension.js';
import type { ResolvedTheme } from './theme.js';

// ── Editor theme (unit 6b·4f) — FOLLOWS THE PICKER ──────────────────────────
//
// CodeMirror renders outside CSS, so (like xterm) it needs its own theme object;
// unlike the always-dark terminal, the editor tracks the app theme. We derive
// both the container theme and the syntax highlight from the CURRENT token
// values on <html> via getComputedStyle — the picker swaps those tokens, so a
// re-read after a theme switch yields the new palette (single source, no hexes
// duplicated here). The whole thing sits in a Compartment so a switch is one
// `reconfigure` dispatch, not a fresh EditorState.

const DEFAULT_TOKENS: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    '--ground': '#f7f8fa',
    '--panel': '#ffffff',
    '--panel-sunken': '#eef1f5',
    '--ink': '#0d1117',
    '--ink-dim': '#5b6673',
    '--line': '#e3e7ec',
    '--accent': '#0891b2',
    '--ok': '#16a34a',
    '--warn': '#d97706',
  },
  dark: {
    '--ground': '#0a0e14',
    '--panel': '#10151d',
    '--panel-sunken': '#0d131b',
    '--ink': '#e6edf3',
    '--ink-dim': '#8b98a8',
    '--line': '#1c2530',
    '--accent': '#22d3ee',
    '--ok': '#22c55e',
    '--warn': '#f59e0b',
  },
};

// Append an 8-bit alpha to a #rrggbb hex; pass anything else through untouched.
function withAlpha(hex: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : hex;
}

// Read the live token values off <html>. `mode` only selects the fallback set
// (used when getComputedStyle can't resolve, e.g. a non-browser harness); the
// real DOM values win and already reflect the current theme.
function readTokens(mode: ResolvedTheme): (name: string) => string {
  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  return (name: string): string =>
    (styles?.getPropertyValue(name).trim() || '') || DEFAULT_TOKENS[mode][name]!;
}

// The theme + highlight extension for a resolved app theme, built from tokens.
function themeExtension(mode: ResolvedTheme): Extension {
  const token = readTokens(mode);
  const ground = token('--ground');
  const panel = token('--panel');
  const panelSunken = token('--panel-sunken');
  const ink = token('--ink');
  const inkDim = token('--ink-dim');
  const accent = token('--accent');
  const ok = token('--ok');
  const warn = token('--warn');

  const editorTheme = EditorView.theme(
    {
      '&': { color: ink, backgroundColor: ground },
      '.cm-content': { caretColor: accent },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: accent },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: withAlpha(accent, '33'), // ~20% accent tint
      },
      '.cm-gutters': { backgroundColor: panel, color: inkDim, border: 'none' },
      '.cm-activeLine': { backgroundColor: withAlpha(accent, '14') },
      '.cm-activeLineGutter': { backgroundColor: panelSunken, color: ink },
      '.cm-selectionMatch': { backgroundColor: withAlpha(accent, '22') },
    },
    { dark: mode === 'dark' },
  );

  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: accent },
    { tag: [tags.string, tags.special(tags.string)], color: ok },
    { tag: [tags.number, tags.bool, tags.null], color: warn },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: inkDim, fontStyle: 'italic' },
    { tag: [tags.variableName, tags.propertyName], color: ink },
    { tag: [tags.function(tags.variableName), tags.definition(tags.function(tags.variableName))], color: accent },
    { tag: [tags.typeName, tags.className, tags.namespace], color: ok },
    { tag: [tags.operator, tags.punctuation, tags.bracket], color: inkDim },
    { tag: [tags.meta, tags.processingInstruction], color: inkDim },
    { tag: tags.invalid, color: token('--ink') },
  ]);

  return [editorTheme, syntaxHighlighting(highlight)];
}

// The named actions the mobile keyboard toolbar dispatches into the editor. The
// toolbar owns the sticky-Ctrl UI; it asks for the word/doc variants directly.
export type EditorAction =
  | 'tab'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordLeft'
  | 'wordRight'
  | 'docStart'
  | 'docEnd'
  | 'escape';

export interface EditorHandle {
  getContent(): string;
  // Replace the whole document (used by reload-on-conflict); does not fire onChange.
  setContent(text: string): void;
  // Move the cursor to (and scroll to) a 1-based line — open-from-search.
  goToLine(lineNumber: number): void;
  // Re-theme the editor to follow the app picker (light | dark). Reconfigures a
  // Compartment in place — no document/state churn.
  setTheme(mode: ResolvedTheme): void;
  run(action: EditorAction): void;
  focus(): void;
  destroy(): void;
}

export interface MountOptions {
  parent: HTMLElement;
  doc: string;
  language: LanguageKey;
  // The resolved app theme at mount time; the editor follows the picker from here.
  theme: ResolvedTheme;
  // Fires on every user edit with the new document text.
  onChange: (content: string) => void;
  // Ctrl/Cmd-S inside the editor triggers a save (in addition to the toolbar).
  onSave: () => void;
}

function languageExtension(language: LanguageKey): Extension[] {
  switch (language) {
    case 'typescript':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'javascript':
      return [javascript()];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'python':
      return [python()];
    case 'rust':
      return [rust()];
    case 'markdown':
      return [markdown()];
    case 'json':
      return [json()];
    case 'yaml':
      return [yaml()];
    case 'vue':
      return [vue()];
    case 'none':
      return [];
  }
}

// Marks a transaction as a programmatic content replacement (reload-on-conflict)
// so the change listener can skip it — a reload must not register as a user edit.
const programmaticReplace = Annotation.define<boolean>();

export function mountEditor(options: MountOptions): EditorHandle {
  const changeListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !update.transactions.some((tr) => tr.annotation(programmaticReplace))) {
      options.onChange(update.state.doc.toString());
    }
  });

  // Ctrl/Cmd-S saves without inserting a character or letting the browser's
  // save dialog steal it.
  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        options.onSave();
        return true;
      },
    },
  ]);

  // The theme lives in a Compartment so the picker can reconfigure it in place.
  const themeCompartment = new Compartment();

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        basicSetup,
        ...languageExtension(options.language),
        saveKeymap,
        changeListener,
        EditorView.lineWrapping,
        themeCompartment.of(themeExtension(options.theme)),
      ],
    }),
  });

  function run(action: EditorAction): void {
    switch (action) {
      case 'tab':
        indentMore(view);
        break;
      case 'left':
        cursorCharLeft(view);
        break;
      case 'right':
        cursorCharRight(view);
        break;
      case 'up':
        cursorLineUp(view);
        break;
      case 'down':
        cursorLineDown(view);
        break;
      case 'wordLeft':
        cursorGroupLeft(view);
        break;
      case 'wordRight':
        cursorGroupRight(view);
        break;
      case 'docStart':
        cursorDocStart(view);
        break;
      case 'docEnd':
        cursorDocEnd(view);
        break;
      case 'escape':
        view.contentDOM.blur(); // dismiss the mobile keyboard
        return;
    }
    view.focus();
  }

  return {
    getContent: () => view.state.doc.toString(),
    setContent: (text: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: programmaticReplace.of(true),
      });
    },
    goToLine: (lineNumber: number) => {
      const clamped = Math.min(Math.max(lineNumber, 1), view.state.doc.lines);
      const line = view.state.doc.line(clamped);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
    },
    setTheme: (mode: ResolvedTheme) => {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(mode)) });
    },
    run,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
