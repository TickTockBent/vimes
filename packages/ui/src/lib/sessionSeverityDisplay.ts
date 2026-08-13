import type { AttentionSeverity, TreeSession } from '@vimes/core';

// ─── S15·U1 — the severity → display mapping (ui-doctrine.md §3 made code,
// slice-15.md §3b, "one mapping, used twice") ─────────────────────────────────
//
// The daemon computes `AttentionSeverity` (packages/core/src/projections/
// sessionSeverity.ts); this module owns the ONE display translation of it —
// tone + glyph — so a leaf row and a collapsed-branch rollup never disagree
// about what a given severity looks like. There must be exactly one of these
// in the client, mirroring the "one place worst is defined" rule the engine
// already keeps for the severity VALUE itself (nodeRollup.ts).

// Tones name TOKEN FAMILIES (ui-doctrine §3), not hexes — the view maps them
// to utility classes (`--warn`/`--crit`/`--accent`/`--ink-dim` and friends).
// This module must not contain a color value: doing so would be a second
// source of record for the palette doctrine already pins in style.css.
export type SeverityTone = 'crit' | 'warn' | 'accent' | 'dim';

export interface SeverityDisplay {
  readonly tone: SeverityTone;
  readonly glyph: string;
}

// The pinned table (slice-15.md §3b). `gate_fired` and `waiting_input` share
// the `warn` tone but differ by glyph — deliberate (ui-doctrine U7: state
// carries a second channel; the glyph is what tells them apart, and how loud
// each reads is the view's prominence call, not this module's).
//
// ⚠ TOTAL, ENFORCED TWICE, mirroring packages/core/src/projections/
// sessionSeverity.ts (read it first; this module is its display-layer
// mirror): a compile-time `never` binding in the `default` arm catches a
// union member added to `AttentionSeverity` without a row added here, and a
// runtime throw catches a value that reaches this function from outside the
// type system (a value read back off the wire, an older snapshot). Never a
// silent fallback glyph — an unrecognized severity is a bug to surface, not
// paper over.
export function severityDisplayOf(severity: AttentionSeverity): SeverityDisplay {
  switch (severity) {
    case 'gate_fired':
      return { tone: 'warn', glyph: '!' };
    case 'error':
      return { tone: 'crit', glyph: '×' }; // × — MULTIPLICATION SIGN, not the letter x
    case 'waiting_input':
      return { tone: 'warn', glyph: '?' };
    case 'working':
      return { tone: 'accent', glyph: '*' };
    case 'idle':
      return { tone: 'dim', glyph: '·' }; // · — MIDDLE DOT, not a full stop
    default: {
      const unrecognizedSeverity: never = severity;
      throw new Error(`severityDisplayOf: unrecognized severity ${JSON.stringify(unrecognizedSeverity)}`);
    }
  }
}

// A rollup's `worst` is null when the subtree holds no processes (nodeRollup.ts:
// `{ worst: null, processCount: 0 }` for an empty subtree). Null is NEVER
// coerced to a severity (the S14 rule) — it gets its own quiet rendering,
// decided HERE so no view invents one. The rendering happens to equal idle's
// ('dim'/'·'), by choice, but is reached through this explicit branch rather
// than by feeding 'idle' through `severityDisplayOf` — an empty subtree and an
// idle process are different facts that only look the same on screen.
export function rollupWorstDisplay(worst: AttentionSeverity | null): SeverityDisplay {
  if (worst === null) {
    return { tone: 'dim', glyph: '·' };
  }
  return severityDisplayOf(worst);
}

// The row treatment joins severity with the SEEN channel. `seenAt` and
// `needsAttention` are two facts (D83): `seen` is carried as its own boolean
// and MUST NOT influence tone or glyph — a session a human looked at with a
// live gate under it stays exactly as loud as one nobody has looked at yet
// (ui-doctrine U5: seen never reads as handled). The A4 test proves this by
// construction — it asserts tone/glyph equality with `severityDisplayOf`
// directly, so nothing in this function has a code path that could bend one
// channel with the other.
export interface SessionRowTreatment {
  readonly tone: SeverityTone;
  readonly glyph: string;
  readonly seen: boolean;
}

export function sessionRowTreatment(session: TreeSession): SessionRowTreatment {
  const display = severityDisplayOf(session.severity);
  return {
    tone: display.tone,
    glyph: display.glyph,
    seen: session.seenAt !== null,
  };
}
