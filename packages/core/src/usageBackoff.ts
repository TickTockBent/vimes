// ─── B1 — usage-poller auth-failure backoff, the DECISION (PURE, packages/core) ───
//
// The usage-endpoint poller (packages/daemon) is a fixed cadence: when the OAuth
// token expires it 401s on every poll and the endpoint escalates 401 → 429 while
// spamming the journal (open-questions D49, risk-register "Usage OAuth token
// lifecycle"). This module is the fix's LOGIC half: given the prior backoff
// state and whether the just-completed poll succeeded, decide how long the
// daemon should wait before the next one. It never polls, times or touches I/O
// — the daemon boundary (app.ts) owns the actual `setTimeout` and calls this on
// every poll outcome, exactly the separation `watchdogDecision.ts` keeps between
// verdict and runner (rule 0.3).
//
// **This is NOT the token-refresh fix (that's A / D49, deliberately not built
// here).** Backoff only makes the failure honest and non-escalating — it widens
// the interval so a dead token stops being hammered — it never refreshes
// credentials, writes a token or mints anything.
//
// Rule 0.3: pure and total. No clock is read here — `succeeded` is a fact the
// caller already observed, not something this module derives. Same inputs,
// same output, forever; nothing thrown, nothing mutated.
//
// Rule 0.2 — `maxIntervalMs` and `multiplier` are ⟨tune⟩ PREVIEW numbers
// (packages/daemon/src/config.ts pins their env vars and defaults, NOT this
// module). Tests here assert the LOGIC — grows-on-failure, caps, resets,
// disabled-degrade, totality — never an exact millisecond figure.

// The reducer's own state: how many polls have failed BACK TO BACK, right up to
// and including the most recent one. A success resets this to zero — the state
// carries no memory of failures before the last success, deliberately: backoff
// is about a run of consecutive trouble, not a lifetime failure count.
export interface UsageBackoffState {
  readonly consecutiveFailures: number;
}

// The state a fresh daemon boot (or a reducer caller with nothing prior) starts
// from — zero failures, i.e. "assume healthy until proven otherwise". Exported
// so app.ts never hand-rolls `{ consecutiveFailures: 0 }` and the two can never
// drift apart.
export const initialUsageBackoffState: UsageBackoffState = { consecutiveFailures: 0 };

export interface UsageBackoffConfig {
  // The configured usage-poll cadence (`config.usagePollIntervalMs`) — the floor
  // every delay this reducer returns sits at or above, and the value a success
  // always resets to.
  readonly baseIntervalMs: number;
  // The ceiling the backed-off interval may never exceed. ⟨tune⟩ (rule 0.2).
  readonly maxIntervalMs: number;
  // The growth factor applied per consecutive failure. ⟨tune⟩ (rule 0.2).
  readonly multiplier: number;
}

/**
 * Given the prior backoff state and whether the just-completed poll succeeded,
 * return the delay until the next poll and the new state.
 *
 * - **Success** resets to base cadence and clears the failure count — the SAME
 *   direction as `runUsagePoll`'s own contract (a failed poll emits nothing and
 *   is never fatal; a success is the all-clear).
 * - **Failure** grows the delay geometrically from the base:
 *   `baseIntervalMs * multiplier^consecutiveFailures`, capped at `maxIntervalMs`.
 *   The FIRST failure already widens the interval (multiplier^1, not ^0) —
 *   that is what stops the 401→429 escalation starting on poll two rather than
 *   waiting for a third or fourth failure to earn any relief.
 * - **Backoff-disabled degrade**: an operator can turn backoff off entirely by
 *   setting `multiplier <= 1` (nothing to grow) or `maxIntervalMs <= baseIntervalMs`
 *   (nowhere to grow into). Either condition collapses every result to
 *   `baseIntervalMs` — today's fixed-cadence behaviour, unchanged.
 * - **Totality**: for any finite, non-negative config this NEVER returns NaN,
 *   Infinity or a negative delay, no matter how large `consecutiveFailures`
 *   grows — `Math.pow` is never evaluated past the point it could overflow,
 *   because the failure count is clamped to the smallest exponent that already
 *   reaches the cap before `Math.pow` is called at all.
 */
export function nextUsageBackoff(
  state: UsageBackoffState,
  succeeded: boolean,
  config: UsageBackoffConfig,
): { readonly delayMs: number; readonly state: UsageBackoffState } {
  const { baseIntervalMs, maxIntervalMs, multiplier } = config;

  if (succeeded) {
    return { delayMs: baseIntervalMs, state: initialUsageBackoffState };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const nextState: UsageBackoffState = { consecutiveFailures };

  // Backoff-disabled degrade: either condition means there is nothing to grow
  // or nowhere to grow into, so every failure still waits exactly one base
  // interval — fixed cadence, exactly today's behaviour before this unit.
  if (multiplier <= 1 || maxIntervalMs <= baseIntervalMs) {
    return { delayMs: baseIntervalMs, state: nextState };
  }

  // Guard the `Math.pow` overflow BEFORE it can happen, rather than computing a
  // huge (possibly Infinity) intermediate and clamping after: find the smallest
  // exponent at which `baseIntervalMs * multiplier^exponent` would already have
  // reached or passed the cap, and never raise the actual exponent past it. A
  // failure run of a million polls is exactly as safe as a run of two.
  const failuresUntilCap = smallestExponentReachingCap(baseIntervalMs, multiplier, maxIntervalMs);
  const clampedExponent = Math.min(consecutiveFailures, failuresUntilCap);
  const grownDelayMs = baseIntervalMs * Math.pow(multiplier, clampedExponent);

  // Belt-and-braces on top of the exponent clamp above: floating-point rounding
  // at the clamp boundary could in principle land a hair over the cap, and this
  // is the module's totality guarantee, not a best effort.
  const delayMs = Math.min(grownDelayMs, maxIntervalMs);

  return { delayMs, state: nextState };
}

// The smallest non-negative exponent N such that `base * multiplier^N >= cap`.
// Callers never raise the exponent past this, which keeps `Math.pow` forever
// inside a range that cannot overflow to Infinity — `base` and `cap` are both
// finite, `multiplier > 1` here (the degrade branch above handles `<= 1`), and
// `Math.log` of a finite ratio is finite, so this always returns a finite,
// bounded exponent.
function smallestExponentReachingCap(
  baseIntervalMs: number,
  multiplier: number,
  maxIntervalMs: number,
): number {
  if (maxIntervalMs <= baseIntervalMs) {
    return 0;
  }
  const exactExponent = Math.log(maxIntervalMs / baseIntervalMs) / Math.log(multiplier);
  // Round UP so the returned exponent's delay is at or past the cap (never a
  // hair short of it), then guard against a non-finite result (e.g. a
  // degenerate baseIntervalMs of 0) by falling back to "no growth".
  return Number.isFinite(exactExponent) ? Math.max(0, Math.ceil(exactExponent)) : 0;
}
