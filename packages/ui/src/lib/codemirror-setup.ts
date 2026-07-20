// The ONE module that statically imports CodeMirror 6. It is loaded EXCLUSIVELY
// via dynamic import() (see EditorView.vue) so the bundler emits it — and its
// heavy lezer grammars — as a separate lazy chunk. The build-manifest CI gate
// (scripts/check-build-manifest.mjs) fails the build if the entry chunk ever
// reaches this file statically. Do NOT import it from anywhere eagerly.

import { EditorState, Annotation, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
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
  run(action: EditorAction): void;
  focus(): void;
  destroy(): void;
}

export interface MountOptions {
  parent: HTMLElement;
  doc: string;
  language: LanguageKey;
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
    run,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
