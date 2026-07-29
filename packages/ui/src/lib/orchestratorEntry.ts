// S8·5 — the standing orchestrator's ENTRY surface (UI-only, D56).
//
// A narrow, LOOSE mirror of packages/daemon/src/orchestratorApi.ts's
// `EnsureOrchestratorResponse` wire contract — never imported (packages/ui is
// not allowed to depend on the daemon, the posture lib/types.ts states for
// `SessionRecord`), so this hand-duplicates the shape it actually reads:
// `outcome` as a bare string, every id/reason unknown-guarded. A hostile or
// stale server shape degrades to "nothing to open, nothing to say" — never a
// throw.
//
// The two functions below are dispatchFollow.ts's siblings, asked of a
// different envelope:
//   • `sessionToOpenAfterEnsure` is the `sessionToSubscribeAfterDispatch`
//     question ("does this response hand back a session id worth acting on")
//   • `describeEnsureOutcome` has no dispatch-side equivalent, because a
//     dispatch's only interesting fact IS the session it spawned. An
//     orchestrator ensure can succeed with something worth SAYING even when
//     there is nothing new to open (a rotation, a refusal, an undelivered
//     briefing) — so the two questions are asked, and answered, separately.

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// Outcomes that name a LIVE session — the daemon's `already-live` / `resumed`
// / `founded` arms. `spawn-refused` / `resume-refused` name nothing to open.
const OPENABLE_OUTCOMES = new Set(['already-live', 'resumed', 'founded']);

/**
 * The dispatchFollow.ts sibling: a 200 whose `outcome` names a live session
 * and carries a usable `appSessionId` → that id, to open the stream panel on.
 * Anything else — a non-200, a malformed body, an unrecognised outcome, a
 * missing/empty id — returns null. TOTAL, never throws.
 */
export function sessionToOpenAfterEnsure(status: number, body: unknown): string | null {
  if (status !== 200) {
    return null;
  }
  const envelope = asRecord(body);
  const outcome = asString(envelope.outcome);
  if (outcome === null || !OPENABLE_OUTCOMES.has(outcome)) {
    return null;
  }
  const appSessionId = asString(envelope.appSessionId);
  return appSessionId !== null && appSessionId.length > 0 ? appSessionId : null;
}

export interface EnsureOutcomeNotice {
  readonly tone: 'info' | 'warn';
  readonly text: string;
}

// PINNED — App.vue renders these verbatim; a wording change here is a wording
// change on screen.
const FOUNDED_FIRST_TEXT = 'Orchestrator founded for this project.';
const FOUNDED_REFOUNDED_TEXT =
  "A previous orchestrator's transcript ended; a new one was founded carrying its standing notes forward.";
const GENERIC_UNREACHABLE_TEXT = "Could not reach this project's orchestrator right now.";

// The `briefingDelivery.status === 'not-delivered'` clause, composed onto
// whatever outcome sentence (if any) precedes it — `founded` has one, a bare
// `resumed` reorientation does not.
function notDeliveredSuffix(briefingDelivery: Record<string, unknown>): string {
  const reason = asString(briefingDelivery.reason) ?? 'unknown reason';
  return `It is live but its briefing was not delivered: ${reason}.`;
}

/**
 * The human sentence for everything an ensure answer says that is NOT a
 * plain open — founding (first or refounded), a refused spawn/resume, an
 * undelivered briefing. A plain `already-live` or a marker-less `resumed`
 * (an ordinary dormant resume, no reorientation turn) return null: opening
 * the chat IS the feedback, and inventing a sentence for "nothing unusual
 * happened" would just be noise.
 *
 * Non-200 (including the `postJsonApi` network sentinel, status 0) and any
 * 200 whose `outcome` this file does not recognise both degrade to null or
 * the generic warn below — never a guess at what happened. TOTAL, never
 * throws.
 */
export function describeEnsureOutcome(status: number, body: unknown): EnsureOutcomeNotice | null {
  if (status !== 200) {
    return { tone: 'warn', text: GENERIC_UNREACHABLE_TEXT };
  }

  const envelope = asRecord(body);
  const outcome = asString(envelope.outcome);
  const briefingDeliveryValue = envelope.briefingDelivery;
  const briefingDelivery =
    typeof briefingDeliveryValue === 'object' && briefingDeliveryValue !== null
      ? (briefingDeliveryValue as Record<string, unknown>)
      : null;
  const notDelivered = briefingDelivery !== null && briefingDelivery.status === 'not-delivered';

  switch (outcome) {
    case 'founded': {
      const baseText = envelope.refounded === true ? FOUNDED_REFOUNDED_TEXT : FOUNDED_FIRST_TEXT;
      return notDelivered
        ? { tone: 'warn', text: `${baseText} ${notDeliveredSuffix(briefingDelivery!)}` }
        : { tone: 'info', text: baseText };
    }
    case 'resumed':
      // Only an INTERRUPTED resume carries a `briefingDelivery` at all (see
      // orchestratorApi.ts's reorientation-is-for-interrupted-only comment) —
      // a dormant resume is marker-less and says nothing, same as
      // already-live.
      return notDelivered ? { tone: 'warn', text: notDeliveredSuffix(briefingDelivery!) } : null;
    case 'spawn-refused':
      return {
        tone: 'warn',
        text: `The orchestrator could not be started: ${asString(envelope.reason) ?? 'unknown reason'}.`,
      };
    case 'resume-refused':
      return {
        tone: 'warn',
        text: `The orchestrator could not be resumed: ${asString(envelope.reason) ?? 'unknown reason'}.`,
      };
    case 'already-live':
    default:
      return null;
  }
}
