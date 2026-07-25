// The ONE module that statically imports xterm.js. It is loaded EXCLUSIVELY via
// dynamic import() (see TerminalView.vue) so the bundler emits it — and its CSS —
// as a separate lazy chunk. The build-manifest CI gate
// (scripts/check-build-manifest.mjs) fails the build if the entry chunk ever
// reaches this file statically. Do NOT import it from anywhere eagerly.
//
// xterm renders raw PTY bytes verbatim; it never interprets them for VIMES
// (rule 0.8). Input keystrokes come back out as text via onInput.

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ── Terminal theme (unit 6b·4f) — ALWAYS DARK (Wes's call, 2026-07-25) ───────
//
// The xterm content lives outside CSS, so it can't inherit the token re-skin;
// we build its ITheme in JS. Rather than duplicate hexes, we READ the current
// dark token values off the mount element — TerminalView.vue pins that subtree
// with `data-theme="dark"`, so `getComputedStyle(parent).getPropertyValue('--…')`
// resolves the DARK values no matter what the app theme is. Single source (the
// CSS tokens), just always the dark branch. Because that branch never changes,
// the theme is built ONCE at mount — no reactive watcher.

// Fallbacks mirror the signed-off dark tokens (style.css [data-theme="dark"]),
// used only if getComputedStyle can't resolve a property (e.g. a non-browser
// harness). In the real app the DOM values win.
const DARK_TOKEN_FALLBACK: Record<string, string> = {
  '--ground': '#0a0e14',
  '--ink': '#e6edf3',
  '--ink-dim': '#8b98a8',
  '--accent': '#22d3ee',
  '--ok': '#22c55e',
  '--warn': '#f59e0b',
  '--crit': '#f87171',
};

// Append an 8-bit alpha to a #rrggbb hex; pass through anything else untouched.
function withAlpha(hex: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : hex;
}

// Blend a #rrggbb hex toward white by `factor` (0..1) — used to derive the ANSI
// "bright" variants a shade lighter than their base, straight from the tokens.
function lighten(hex: string, factor: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) {
    return hex;
  }
  const value = parseInt(match[1]!, 16);
  const toward = (channel: number): string =>
    Math.round(channel + (255 - channel) * factor)
      .toString(16)
      .padStart(2, '0');
  return `#${toward((value >> 16) & 0xff)}${toward((value >> 8) & 0xff)}${toward(value & 0xff)}`;
}

// Build the (always-dark) xterm theme from the token values on `scopeElement`,
// which must sit inside a `data-theme="dark"` subtree.
function buildDarkTheme(scopeElement: HTMLElement): ITheme {
  const styles = getComputedStyle(scopeElement);
  const token = (name: string): string =>
    styles.getPropertyValue(name).trim() || DARK_TOKEN_FALLBACK[name]!;

  const ground = token('--ground');
  const ink = token('--ink');
  const inkDim = token('--ink-dim');
  const accent = token('--accent');
  const ok = token('--ok');
  const warn = token('--warn');
  const crit = token('--crit');

  const brightFactor = 0.25;
  return {
    background: ground,
    foreground: ink,
    // Cursor block in accent; the char under it (cursorAccent) too, per the
    // work-order. Note: identical values mean the glyph under a solid block
    // cursor is not separately tinted — a candidate to revisit if legibility
    // under the cursor matters.
    cursor: accent,
    cursorAccent: accent,
    selectionBackground: withAlpha(accent, '55'), // ~33% translucent accent

    // ── ANSI 8 (work-order mapping) ──
    black: ground, // darkest neutral
    red: crit,
    green: ok,
    yellow: warn,
    blue: accent, // no separate blue token — accent covers blue & cyan
    magenta: inkDim, // no purple token → neutral fallback (see summary)
    cyan: accent,
    white: inkDim, // light-ish gray; brightWhite carries pure foreground
    // ── ANSI bright (a shade lighter) ──
    brightBlack: lighten(ground, 0.3), // a visible dark gray above `black`
    brightRed: lighten(crit, brightFactor),
    brightGreen: lighten(ok, brightFactor),
    brightYellow: lighten(warn, brightFactor),
    brightBlue: lighten(accent, brightFactor),
    brightMagenta: lighten(inkDim, brightFactor),
    brightCyan: lighten(accent, brightFactor),
    brightWhite: ink,
  };
}

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
    // Always-dark theme, read once from the dark-scoped mount element. It never
    // changes (the terminal is pinned dark), so there is no reactive watcher.
    theme: buildDarkTheme(parent),
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
