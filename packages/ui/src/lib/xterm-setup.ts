// The ONE module that statically imports xterm.js. It is loaded EXCLUSIVELY via
// dynamic import() (see TerminalView.vue) so the bundler emits it — and its CSS —
// as a separate lazy chunk. The build-manifest CI gate
// (scripts/check-build-manifest.mjs) fails the build if the entry chunk ever
// reaches this file statically. Do NOT import it from anywhere eagerly.
//
// xterm renders raw PTY bytes verbatim; it never interprets them for VIMES
// (rule 0.8). Input keystrokes come back out as text via onInput.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalHandle {
  // Render raw output bytes into the terminal (xterm accepts a byte array).
  write(bytes: Uint8Array): void;
  // Render a plain informational line (e.g. the "output dropped" notice).
  writeNotice(text: string): void;
  // User keystrokes leave the terminal as text (to be framed + sent as bytes).
  onInput(callback: (text: string) => void): void;
  // Fired when xterm's own dimensions change (after a fit()).
  onResize(callback: (dimensions: TerminalDimensions) => void): void;
  // Refit to the parent element; returns the resulting dimensions.
  fit(): TerminalDimensions;
  focus(): void;
  dispose(): void;
}

export function mountTerminal(parent: HTMLElement): TerminalHandle {
  const terminal = new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    scrollback: 5000,
    theme: { background: '#020617', foreground: '#e2e8f0' },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(parent);

  function fit(): TerminalDimensions {
    try {
      fitAddon.fit();
    } catch {
      // A zero-sized parent (not yet laid out) can throw — ignore; the next fit
      // after layout succeeds.
    }
    return { cols: terminal.cols, rows: terminal.rows };
  }

  return {
    write: (bytes) => terminal.write(bytes),
    writeNotice: (text) => terminal.writeln(`\r\n\x1b[33m${text}\x1b[0m`),
    onInput: (callback) => {
      terminal.onData(callback);
    },
    onResize: (callback) => {
      terminal.onResize(({ cols, rows }) => callback({ cols, rows }));
    },
    fit,
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
}
