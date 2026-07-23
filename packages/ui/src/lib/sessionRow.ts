import { resolveSessionLabel } from './sessionLabel.js';
import type { AttentionReason, Custody, Liveness, SessionRecord } from './types.js';

export interface SessionRow {
  appSessionId: string;
  label: string;
  channel: 'sdk' | 'pty';
  cwdTail: string;
  liveness: Liveness;
  livenessLabel: string;
  livenessColorClass: string;
  attention: { visible: true; reason: AttentionReason; label: string } | { visible: false };
  // D10 custody + action availability (the list surfaces different actions per
  // custody). `mirrored` drives the badge; the can* flags gate the row's buttons.
  custody: Custody;
  mirrored: boolean;
  canAdopt: boolean;
  canKill: boolean;
  canRename: boolean;
}

// Distinct colors per liveness state; interrupted is amber (scope requirement:
// "distinct colors, interrupted amber").
const LIVENESS_STYLE: Readonly<Record<Liveness, { label: string; colorClass: string }>> = {
  spawning: { label: 'spawning', colorClass: 'bg-sky-500 text-white' },
  running: { label: 'running', colorClass: 'bg-emerald-500 text-white' },
  dormant: { label: 'dormant', colorClass: 'bg-slate-400 text-white' },
  interrupted: { label: 'interrupted', colorClass: 'bg-amber-500 text-white' },
  dead: { label: 'dead', colorClass: 'bg-rose-600 text-white' },
};

const ATTENTION_LABEL: Readonly<Record<AttentionReason, string>> = {
  gate: 'needs a decision',
  question: 'asked a question',
  completed: 'finished a run',
  stale: 'went quiet',
  quarantined: 'hit a quarantined line',
  // Reserved (rule 0.5): no setter emits these yet — 'rate-limited' lands
  // slice 5, 'brake' lands slice 7. Labels included now so the badge map
  // stays exhaustive over AttentionReason.
  'rate-limited': 'hit a rate limit',
  brake: 'held by a brake',
};

function cwdTail(cwd: string): string {
  const segments = cwd.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : cwd;
}

export function deriveSessionRow(session: SessionRecord): SessionRow {
  const style = LIVENESS_STYLE[session.liveness];
  // Default 'host' when custody is absent (projection predating the field).
  const custody: Custody = session.custody ?? 'host';
  const mirrored = custody === 'external';
  return {
    appSessionId: session.appSessionId,
    // Q3: the ONE ladder (lib/sessionLabel.ts), shared with the cost ledger so
    // the two views can never call the same session different things.
    // `createdAt` is this surface's "earliest observed" instant — the ledger
    // passes its earliest cost row instead; the rung is the same.
    label: resolveSessionLabel({
      sessionId: session.appSessionId,
      name: session.name,
      derivedTitle: session.derivedTitle,
      earliestActivityAt: session.createdAt,
    }),
    channel: session.channel,
    cwdTail: cwdTail(session.cwd),
    liveness: session.liveness,
    livenessLabel: style.label,
    livenessColorClass: style.colorClass,
    attention:
      session.needsAttention === null
        ? { visible: false }
        : {
            visible: true,
            reason: session.needsAttention.reason,
            label: ATTENTION_LABEL[session.needsAttention.reason],
          },
    custody,
    mirrored,
    // Adopt is offered only on mirrored rows. Kill needs a host-owned live
    // process (running or still spawning). Rename is allowed on any custody.
    canAdopt: mirrored,
    canKill: !mirrored && (session.liveness === 'running' || session.liveness === 'spawning'),
    canRename: true,
  };
}
