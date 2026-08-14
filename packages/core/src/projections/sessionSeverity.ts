import type { AttentionReason, Liveness } from '../events.js';
import type { SessionRecord } from '../schemas.js';
import type { AttentionSeverity } from './nodeRollup.js';

// ─── S14·U2 — the ONE severity join (slice-14.md §3b, PURE) ──────────────────
//
// Three vocabularies exist in the engine and none of them is severity:
//   • LIVENESS (`spawning|running|dormant|interrupted|dead`) — a fact about the
//     PROCESS, folded from `liveness_changed`.
//   • ATTENTION (`gate|question|completed|stale|quarantined` + two reserved) — a
//     fact about what the run ASKED FOR, folded from the attention setters.
//   • SEVERITY (`nodeRollup.ts`'s versioned `ATTENTION_SEVERITY_RANKS`) — the
//     ORDER a rollup takes the max over.
//
// `rollupNode` has taken a per-session severity callback since S9·1 and nobody
// implemented it. This is that implementation, and it is the ONLY one: E2-b says
// the projection is the one place "worst" gets defined, and a second spelling of
// this table is a second answer the day one of them misses a row (principle 9).
// Every consumer — the tree read model, a future debounce watermark, an
// extension asking "is anything under here red" — calls THIS.
//
// Rule 0.3: pure. No clock, no randomness, no I/O. It is a table lookup over two
// arguments and it returns one of five declared values.

// ⚠ **TOTAL, AND TOTALITY IS ENFORCED TWICE (S14-A4).**
//
//   1. AT COMPILE TIME, by the `never` bindings in both `default` arms below. A
//      future member of `Liveness` or `AttentionReason` — `queued`, say, or
//      `rate-limited` gaining an emitter and a re-priced rank — is a TYPE ERROR
//      here, not a runtime surprise. That is the whole reason this is a switch
//      over a literal union rather than a `Record` with a `??` fallback: a
//      record's missing key reads as `undefined` and defaults away silently,
//      which is exactly the "new state sorts last / reads amber" failure E2-b
//      pin 1 was written about.
//   2. AT RUNTIME, by THROWING on a value outside the union. Callers outside the
//      type system exist (a value read back off the wire, a JS consumer, a
//      snapshot written by an older build), and for them the honest answer is a
//      hard error. **Never a silent `idle`**: `idle` is the quietest rank there
//      is, so guessing it for an unrecognized state is precisely the going-dark
//      failure the attention system exists to prevent. Loud beats quiet.
//
// Note the asymmetry with `rollupNode`, which is deliberately FORGIVING about an
// unknown severity (it contributes nothing rather than sorting arbitrarily).
// That is the right posture THERE — it is aggregating other people's readings —
// and the wrong posture HERE, because this function is the place the reading is
// MADE. An aggregator may decline to speak about a value it does not recognize;
// the authority that mints the value may not.
export function sessionSeverityOf(
  liveness: Liveness,
  needsAttention: SessionRecord['needsAttention'],
): AttentionSeverity {
  // ⚠ **ATTENTION OVERRIDES LIVENESS (§3b), AND THE ORDER OF THESE TWO BLOCKS IS
  // THE WHOLE RULE.** A session that fired a gate is `running` — the process is
  // alive and blocked on a human — so reading liveness first would render the
  // one state that most needs a person as ordinary work in flight.
  if (needsAttention !== null && needsAttention !== undefined) {
    return severityOfAttentionReason(needsAttention.reason);
  }
  // `undefined` is read as "no attention", beside `null`, because a record from
  // an older snapshot may genuinely lack the key and refusing to read that
  // session at all is a worse failure than reading it as unattended. What is NOT
  // forgiven is a PRESENT attention object carrying a reason outside the
  // vocabulary — that is a claim we cannot rank, and it throws.
  return severityOfLiveness(liveness);
}

// The attention half of §3b. Every row is written out; nothing falls through.
function severityOfAttentionReason(reason: AttentionReason): AttentionSeverity {
  switch (reason) {
    // The eponymous rank: a gate fired is the state the severity vocabulary was
    // named for.
    case 'gate':
      return 'gate_fired';
    case 'question':
      return 'waiting_input';
    // ⚠ COMPLETION IS A TERMINAL FACT, NOT AN ASK (D88, superseding §3b's
    // original "somebody has to acknowledge the result" pricing). Attention
    // marks work asking for input; a session that finished has nothing left
    // to ask — pricing it at `waiting_input` made a 17-day-quiet, already-
    // delivered session read identically to one genuinely blocked on a human
    // (S15-F6). The ask-shaped residue of a finished run, when there is one,
    // belongs to the deliverable/next-step, not to the session's own row.
    // `run_completed` still SETS `needsAttention{reason:'completed'}`
    // (deliberately unchanged, D88) — the completion push notification and
    // the `run_completed` row in the stream remain the completion evidence;
    // only the PRICE moves here, in this pure join, with zero migration.
    case 'completed':
      return 'idle';
    case 'stale':
      return 'error';
    case 'quarantined':
      return 'error';
    // ── reserved reasons, ranked AT RESERVATION (E2-b pin 1) ─────────────────
    //
    // Neither of these has an emitter today (events.ts says so at the schema).
    // They are ranked anyway, here, because pin 1's rule is that a reason
    // declares its rank when it is RESERVED or the rollup misorders silently on
    // the day it lands. `error` is the loud choice, and loud is the safe
    // direction for a reason whose real weight nobody has measured yet: the unit
    // that gives one of these an emitter re-prices it under the ordinary gate,
    // and the version bump is what tells a consumer the order moved.
    case 'rate-limited':
      return 'error';
    case 'brake':
      return 'error';
    default: {
      // Compile-time exhaustiveness + the runtime hard error. See the header.
      const unrecognizedReason: never = reason;
      throw new Error(
        `sessionSeverityOf: unrecognized attention reason ${JSON.stringify(unrecognizedReason)}`,
      );
    }
  }
}

// The liveness half of §3b — read ONLY when no attention is raised.
function severityOfLiveness(liveness: Liveness): AttentionSeverity {
  switch (liveness) {
    case 'spawning':
      return 'working';
    case 'running':
      return 'working';
    case 'dormant':
      return 'idle';
    // ⚠ AN INTERRUPTED SESSION AWAITS A HUMAN RESUME DECISION (§3b), so it ranks
    // with the other things waiting on a person rather than with the quiet ones.
    // It is also the state discovery parks a mirrored external session in, which
    // is the honest reading: nothing will move it until somebody decides to.
    case 'interrupted':
      return 'waiting_input';
    // ⚠ `dead` IS ARCHAEOLOGY, NOT AN ALARM, and this row looks wrong until you
    // read it beside E2-b pin 2. A dead session cannot be doing anything, so it
    // has nothing to ask for; ranking it `error` would leave every estate
    // permanently red for work that finished last month. What keeps a dead-
    // session estate honest is `rollupNode`'s PROCESS COUNT, which counts
    // attachments rather than severities — not this rank.
    case 'dead':
      return 'idle';
    default: {
      const unrecognizedLiveness: never = liveness;
      throw new Error(
        `sessionSeverityOf: unrecognized liveness ${JSON.stringify(unrecognizedLiveness)}`,
      );
    }
  }
}
