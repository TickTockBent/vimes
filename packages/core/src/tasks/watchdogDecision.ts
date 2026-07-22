// ─── slice 6 step 5a — the watchdog DECISION (PURE, packages/core) ───────────
//
// Given one stage run's observation, a caller-supplied policy and an injected
// clock, decide whether that run is **healthy**, **stale**, **quarantine**-able,
// or **unknown**. Nothing here polls, times, events or touches I/O: step 5b is
// the daemon runner that calls this on a schedule and writes `watchdog_stale` /
// `task_quarantined`. That separation is what makes the watchdog assertable
// headlessly — no Claude, no network, no clock.
//
// ⚠ **THIS IS THE MOST DANGEROUS FUNCTION IN SLICE 6.** The slice's named
// rule-0.1 finding is *"the watchdog quarantines a **healthy** run"*
// (slice-6.md, "What would be a finding"), and a system that kills good work is
// worse than no watchdog at all. Everything below is arranged so that the ways
// to be wrong are STRUCTURAL and enumerable rather than a matter of a number:
// every protection for a healthy run is an early return sitting ABOVE every
// escalation branch, and each one is derived from exported data that the tests
// enumerate.
//
// **D30 is the design, and it is three conditions, not one.** Spike S3a measured
// the real corpus (697 transcripts, 80.6k records): the machine-work gap tail
// tops out at 14.87 min — but healthy HUMAN-GATED waits reach **599.99 min
// (10 h)**, and no time threshold can separate those from a stall. So "stale"
// means the run is (1) NOT blocked on a human gate, (2) NOT at a resume
// boundary, and (3) has not appended for ≥ the band. A watchdog implementing
// only (3) is wrong at any band.
//
// **Rule 0.2 / Gate-D — what is PINNED and what is NOT.** D30 pinned the
// staleness band at 15 min. It pinned NOTHING about retries: S3 measured
// staleness, not retry behaviour, so ⟨tune 3⟩ retries-before-quarantine and the
// backoff curve have no evidence behind them at all. Therefore **every ⟨tune⟩ in
// this module is a REQUIRED input with NO DEFAULT** — this file contains no
// band, no retry count and no backoff constant, and the tests assert
// RELATIONSHIPS ("the Nth retry escalates", "backoff is positional and clamps"),
// never that any particular number is right. Pinning those is Wes's Gate-D call,
// and it has not been made.
//
// Rule 0.3: pure. `nowIso` is a PARAMETER — this module never reads a clock,
// never randomizes, never mutates its input. Same inputs, same verdict, forever.
//
// Rule: **NEVER THROW.** Like `proposeTransition` (step 1) and `decideDispatch`
// (step 3), `assessStageRun` is TOTAL: every input, including values outside the
// schema enums and unparseable timestamps, maps to a verdict. A watchdog that
// throws is a watchdog that has silently stopped watching.

import { EVENT_TYPES } from '../events.js';
import { sessionRecordSchema, type SessionRecord } from '../schemas.js';

// ── which liveness values the watchdog governs ───────────────────────────────
// Exported as DATA (the same discipline as `TASK_STAGE_EDGES` and
// `DISPATCHABLE_TASK_STAGES`), with its COMPLEMENT derived rather than
// transcribed, so the partition cannot drift when a liveness value is added.
//
// **Only a run that could be appending can be silent.** Each membership is a
// decision:
//   • `running` — the ordinary case. A worker mid-turn either appends or wedges.
//   • `spawning` — a run that never gets off the ground is exactly a wedge, and
//     it is the shape D13 already had to recover from at crash. Governed.
//   • `dormant` is PARKED (the session ended its run and is resumable), `dead`
//     is finished and `interrupted` was stopped deliberately. None of the three
//     is "stalled" — they are states the existing liveness path already tells
//     the truth about, and escalating one would quarantine a task because its
//     session did what it was told.
export const WATCHDOG_GOVERNED_LIVENESS: ReadonlySet<SessionRecord['liveness']> = new Set<
  SessionRecord['liveness']
>(['spawning', 'running']);

// Every liveness value the session record can hold, in the schema's own order —
// DERIVED from `sessionRecordSchema`, never re-typed, so the watchdog and the
// record cannot drift apart.
export const ALL_SESSION_LIVENESS: readonly SessionRecord['liveness'][] =
  sessionRecordSchema.shape.liveness.options;

// The complement, derived — never hand-listed. Exported so callers and tests
// share one partition rather than two that can disagree (principle 9). A
// liveness value added to the schema lands HERE by construction, i.e. ungoverned
// — the fail-safe direction for a guard that can kill work.
export const NON_GOVERNED_SESSION_LIVENESS: readonly SessionRecord['liveness'][] =
  ALL_SESSION_LIVENESS.filter((liveness) => !WATCHDOG_GOVERNED_LIVENESS.has(liveness));

// Widened to `string` deliberately: the check is only meaningful if a value
// outside the enum can physically reach it (observations are assembled by the
// daemon from projections that tolerate old snapshots; TypeScript's guarantee
// stops at the boundary). An unrecognized liveness is NOT governed — the
// direction that protects work.
export function isWatchdogGovernedLiveness(candidateLiveness: string): boolean {
  return WATCHDOG_GOVERNED_LIVENESS.has(candidateLiveness as SessionRecord['liveness']);
}

// ── which attention reasons mean "blocked on a human" ────────────────────────
// **D30 condition (1), and the single most important classification in this
// file.** S3a observed healthy human-gated waits reaching 10 hours, because the
// human's reply returns as a `tool_result` and is indistinguishable from
// in-flight work. The watchdog does not invent a second notion of "blocked": it
// CONSULTS the `needsAttention` state slices 0–2 already own.
//
// Derived as data, with the complement derived from the schema, so every reason
// is classified deliberately:
//   • `gate` — a `canUseTool` permission prompt is waiting on a person. BLOCKING.
//   • `question` — `AskUserQuestion` / `ExitPlanMode` is waiting on a person.
//     BLOCKING. These two are the 599.99-min population S3a measured.
//   • `completed` — the run finished; it is not waiting on anyone. Not blocking
//     (and a completed run's liveness is not governed anyway).
//   • `stale`, `quarantined` — **watchdog-AUTHORED**. Treating either as
//     protective would be the same disarms-itself bug as a self-refreshing
//     heartbeat (see `TRANSCRIPT_APPEND_EVENT_TYPES`): the first `watchdog_stale`
//     sets `needsAttention: 'stale'`, which would then protect the run forever
//     and no retry could ever escalate. NOT blocking, deliberately.
//   • `rate-limited`, `brake` — RESERVED (rule 0.5); no setter emits either yet
//     (schemas.ts says so). They are not human gates, so they are not blocking
//     today. **When their setters land, their classification is a deliberate
//     decision to make here** — the enumerated partition test is what forces it.
export const WATCHDOG_BLOCKING_ATTENTION_REASONS: ReadonlySet<string> = new Set<string>([
  'gate',
  'question',
]);

// Every attention reason the session record can hold — DERIVED by unwrapping the
// nullable `needsAttention` object in `sessionRecordSchema`. Same anti-drift
// discipline as `ALL_SESSION_LIVENESS`.
export const ALL_ATTENTION_REASONS: readonly string[] =
  sessionRecordSchema.shape.needsAttention.unwrap().shape.reason.options;

// The complement, derived. A reason added to the schema lands here — i.e. NOT
// protective — which is the direction that keeps the guard armed; the deliberate
// act is adding one to the blocking set above.
export const NON_BLOCKING_ATTENTION_REASONS: readonly string[] = ALL_ATTENTION_REASONS.filter(
  (reason) => !WATCHDOG_BLOCKING_ATTENTION_REASONS.has(reason),
);

// `null` attention (the common case: nothing is waiting on anyone) is not
// blocking. Widened to `string` for the same boundary reason as the liveness
// predicate.
export function isBlockingAttentionReason(candidateReason: string | null | undefined): boolean {
  return typeof candidateReason === 'string' && WATCHDOG_BLOCKING_ATTENTION_REASONS.has(candidateReason);
}

// ── what counts as a HEARTBEAT ───────────────────────────────────────────────
// ⚠ **THE SELF-DEFEATING BUG THIS PREVENTS, STATED SO IT CANNOT BE
// REINTRODUCED.** The heartbeat is advanced ONLY by events the TAILER derived
// from the transcript — i.e. by an actual JSONL append the run made. It is
// NEVER advanced by daemon-authored bookkeeping.
//
// If bookkeeping counted, **the watchdog writing `watchdog_stale` would refresh
// the very heartbeat it is judging**: every poll would observe a fresh
// heartbeat, silence would reset to zero on each escalation, and the guard could
// never reach quarantine — a guard that disarms itself on use. The same is true
// of `liveness_changed`, `notification_trigger` and the `task_*` family: they
// are things VIMES wrote ABOUT the run, not things the run did.
//
// Rule 0.7 says the same thing from the other end: staleness is **observed**
// (JSONL append cadence), never **declared**. Rule 0.8 backs it: the observation
// comes from structured transcript records, never from screen bytes.
//
// Referenced through `EVENT_TYPES` rather than as string literals so the
// vocabulary has one source of record (principle 9), and exported as data so a
// future event type must be classified DELIBERATELY — an unclassified new type
// lands in the derived complement below, i.e. NOT a heartbeat, which is the
// direction that keeps the watchdog honest rather than the direction that
// silences it.
export const TRANSCRIPT_APPEND_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  // The run said something — the primary append.
  EVENT_TYPES.message,
  // A usage block was written alongside an assistant record: the model produced
  // tokens, which is machine work happening.
  EVENT_TYPES.usageBlock,
  // A permission prompt appeared in the transcript. The run is alive enough to
  // ask; the gate EXEMPTION (above) is what protects the wait that follows.
  EVENT_TYPES.gateFired,
  // Likewise `AskUserQuestion` / `ExitPlanMode` reaching the transcript.
  EVENT_TYPES.questionAsked,
  // The run reached a `result` record. The run appended; whether the session
  // then goes dormant is the liveness path's business, not the heartbeat's.
  EVENT_TYPES.runCompleted,
  // A new Claude session id was observed in the transcript — derived from the
  // JSONL, and the very append that a resume produces.
  EVENT_TYPES.claudeSessionMapped,
  // Both are derived by the tailer from transcript records (cache TTL tier,
  // billing bucket): observing one means a record was appended.
  EVENT_TYPES.ttlTierObserved,
  EVENT_TYPES.billingBucketObserved,
  // A transcript line the tailer could not parse. THE RUN STILL APPENDED — the
  // bytes exist and we failed to read them. Excluding it would let a run whose
  // output we cannot parse look silent, and we would quarantine a healthy run
  // for OUR parser's shortcoming. Counted, deliberately.
  EVENT_TYPES.lineQuarantined,
]);

// Every event type in the vocabulary, and the derived complement of the
// heartbeat set. Exported so the tests enumerate the partition instead of
// sampling it, and so 5b (and any later consumer) reads the same two sets.
export const ALL_EVENT_TYPES: readonly string[] = Object.values(EVENT_TYPES);

export const NON_HEARTBEAT_EVENT_TYPES: readonly string[] = ALL_EVENT_TYPES.filter(
  (eventType) => !TRANSCRIPT_APPEND_EVENT_TYPES.has(eventType),
);

// Widened to `string` for the same boundary reason as the other predicates: the
// event log is append-only and forever, so a historical type outside today's
// vocabulary can physically reach this. Unknown ⇒ not a heartbeat.
export function isTranscriptAppendEventType(candidateEventType: string): boolean {
  return TRANSCRIPT_APPEND_EVENT_TYPES.has(candidateEventType);
}

// ── the inputs ───────────────────────────────────────────────────────────────

export interface StageRunObservation {
  readonly appSessionId: string;
  readonly taskId: string;
  // From the sessions projection. The watchdog CONSULTS the liveness the rest of
  // the system already uses; it never derives a second notion of "alive"
  // (slice-6.md, "Architecture (binding)").
  readonly liveness: SessionRecord['liveness'];
  readonly needsAttention: SessionRecord['needsAttention'];
  // The last TRANSCRIPT-OBSERVED append for this session — advanced only by
  // `TRANSCRIPT_APPEND_EVENT_TYPES` above. Null = nothing has ever been observed.
  readonly lastHeartbeatAt: string | null;
  // When this session most recently crossed a RESUME BOUNDARY — a new Claude
  // session id was mapped, or it went dormant → running. Null = never resumed.
  // D30 condition (2): a resumed session's first gap is wall-clock, not a stall.
  readonly lastResumeBoundaryAt: string | null;
  // RESERVED FOR STEP 6 (rule 0.5). D5: correction delivery is bounded by the
  // NEXT MODEL CALL, so a correction can sit QUEUED for the length of an
  // in-flight tool call (30.4 s observed against a 40 s tool; unbounded worst
  // case — a long build or test suite). D30/D5 say it explicitly: a
  // queued-but-undelivered correction is NOT staleness, or the watchdog
  // quarantines a healthy CORRECTED run. Nothing populates this until step 6,
  // but the decision HONOURS it now, so step 6 wires a value in and changes no
  // logic here.
  readonly correctionQueuedAt?: string | null;
  // How many stale escalations this run has already accumulated. Supplied by the
  // caller (5b folds it); the decision never counts anything itself.
  readonly staleRetriesSoFar: number;
}

export interface WatchdogPolicy {
  // D30, PINNED at 15 min — SUPPLIED, never defaulted here. Rule 0.2 forbids a
  // band living in core as a silent default; the caller names it, exactly as
  // `decideDispatch` takes `staleAfterMs`.
  readonly staleAfterMs: number;
  // ⟨tune⟩ **UNPINNED** (D30: "no measurement covers retry behaviour yet").
  // REQUIRED, no default. How many stale escalations a run may accumulate before
  // it is quarantined.
  readonly maxStaleRetries: number;
  // ⟨tune⟩ **UNPINNED**. REQUIRED, no default. Positional: the Nth retry reads
  // element N-1, clamping to the LAST element once retries run past the array.
  readonly retryBackoffMs: readonly number[];
}

// ── the verdict ──────────────────────────────────────────────────────────────

export type WatchdogHealthyReason =
  // The liveness is not one the watchdog governs (finished, parked, stopped).
  | 'not-a-live-run'
  // Blocked on a human gate or question — D30 condition (1). THE protection.
  | 'awaiting-human'
  // Resumed and not yet appended — D30 condition (2). Expected startup silence.
  | 'resume-boundary'
  // A queued correction has not been delivered yet (D5; step 6 feeds it).
  | 'correction-in-flight'
  // Silence is inside the band — D30 condition (3) not yet met.
  | 'appending';

export type WatchdogVerdict =
  | { readonly verdict: 'healthy'; readonly reason: WatchdogHealthyReason }
  | {
      readonly verdict: 'stale';
      readonly observedSilenceMs: number;
      // 1-based: the FIRST escalation is retry 1.
      readonly retryNumber: number;
      // Read positionally from `policy.retryBackoffMs`, clamped to its last element.
      readonly retryAfterMs: number;
    }
  | {
      readonly verdict: 'quarantine';
      readonly observedSilenceMs: number;
      // The retry count that was already exhausted when this verdict was reached.
      readonly retriesExhausted: number;
    }
  | {
      readonly verdict: 'unknown';
      readonly reason: 'no-heartbeat-observed' | 'unparseable-timestamp';
    };

// Parse an ISO timestamp to epoch milliseconds, or null when it is absent or
// unparseable. `Date.parse` is a pure string→number function (no clock read), so
// it is permitted under rule 0.3.
//
// A private copy of the three-line helper `dispatchDecision.ts` and
// `meterDerivations.ts` each keep privately, for the reason recorded there: they
// are the same total function over the same input domain, with no behaviour to
// diverge, and this step is not the place to reshape a frozen slice-5 surface.
// If a fourth copy ever wants to exist, promote it instead of adding one.
function parseIsoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMilliseconds = Date.parse(isoTimestamp);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : null;
}

// Is this timestamp PRESENT (a non-empty string the caller meant as a value) but
// unreadable? Distinguishing "absent" from "present but unparseable" is what
// lets an absent optional field mean "nothing to honour" while a corrupt one
// means "we cannot tell" — and we never escalate on something we cannot tell.
function isPresentButUnparseable(isoTimestamp: string | null | undefined): boolean {
  return (
    typeof isoTimestamp === 'string' &&
    isoTimestamp.length > 0 &&
    parseIsoToEpochMs(isoTimestamp) === null
  );
}

/**
 * Assess ONE stage run. TOTAL and PURE: every input maps to a verdict, nothing
 * throws, nothing is mutated, and the same inputs always produce the same verdict.
 *
 * CHECK ORDER (load-bearing — the FIRST matching check wins). **Every early
 * return is a PROTECTION for a healthy run, and every one of them sits ABOVE the
 * escalation branches. That ordering IS the guard against this slice's named
 * finding**, and it is proved by stacking conflicting conditions in the tests
 * rather than asserted case by case:
 *
 *   1. **liveness not governed** → `healthy: 'not-a-live-run'`. Only a run that
 *      could be appending can be silent; a dead/interrupted/dormant session is
 *      finished or parked, and the existing liveness path already says so.
 *   2. **blocked on a human** (`needsAttention.reason` ∈ gate/question) →
 *      `healthy: 'awaiting-human'`. **D30 condition (1)** — the 10-hour
 *      observation. No threshold separates a human wait from a stall, so the
 *      watchdog must not try.
 *   3. **resume boundary at or after the last heartbeat** →
 *      `healthy: 'resume-boundary'`. **D30 condition (2)** — the run resumed and
 *      has not appended since; that silence is startup, measured in wall-clock.
 *   4. **correction queued at or after the last heartbeat** →
 *      `healthy: 'correction-in-flight'`. **D5** — delivery waits on the next
 *      model call, which an in-flight tool can delay without bound.
 *   5. **heartbeat unobservable** (never observed, or ANY supplied timestamp
 *      present-but-unparseable) → `unknown`.
 *   6. **silence < `staleAfterMs`** → `healthy: 'appending'`. D30 condition (3)
 *      is not met.
 *   7. **silence ≥ `staleAfterMs`** → the escalation: `stale` while retries
 *      remain, `quarantine` once they are exhausted.
 *
 * ⚠ **THE PILLAR-4 JUDGEMENT: `unknown` IS ITS OWN VERDICT AND NEVER
 * ESCALATES.** The same reasoning step 3 applied to `headroom-unknown`: if we
 * cannot see how long a run has been silent, we do not get to call it stalled.
 * Quarantining on an unobservable is the lying-meter failure WITH TEETH — it
 * kills work rather than merely misreporting. So "we cannot tell" is carried as
 * its own verdict, with its own reasons, and a caller surfaces it instead of
 * acting on it. Note the asymmetry, which is deliberate: an unparseable
 * timestamp anywhere in the observation yields `unknown`, while checks 1–4 —
 * all of which only ever return `healthy` — get to run first. Uncertainty may
 * cost a run its escalation; it may never cost a run its life.
 */
export function assessStageRun(
  observation: StageRunObservation,
  policy: WatchdogPolicy,
  nowIso: string,
): WatchdogVerdict {
  const {
    liveness,
    needsAttention,
    lastHeartbeatAt,
    lastResumeBoundaryAt,
    correctionQueuedAt,
    staleRetriesSoFar,
  } = observation;

  // 1. Is this even a run the watchdog governs? Fail-safe: anything not in the
  //    exported governed set — including a liveness outside the schema enum —
  //    is left alone here.
  if (!isWatchdogGovernedLiveness(liveness)) {
    return { verdict: 'healthy', reason: 'not-a-live-run' };
  }

  // 2. D30 condition (1). The 10-hour wait. Checked before anything time-based
  //    precisely because time cannot distinguish it.
  if (isBlockingAttentionReason(needsAttention?.reason)) {
    return { verdict: 'healthy', reason: 'awaiting-human' };
  }

  const lastHeartbeatMs = parseIsoToEpochMs(lastHeartbeatAt);

  // 3. D30 condition (2). "At or after" the last heartbeat means the run has
  //    resumed and not yet appended. A resume boundary with NO heartbeat at all
  //    protects too: a run that resumed and has never been observed appending is
  //    the same fact in its purest form, and protecting it is the direction that
  //    cannot kill work. An UNPARSEABLE boundary does not protect here — it
  //    falls through, and unless a check below protects the run first, check 5
  //    turns it into `unknown`, which also never escalates.
  const lastResumeBoundaryMs = parseIsoToEpochMs(lastResumeBoundaryAt);
  if (
    lastResumeBoundaryMs !== null &&
    (lastHeartbeatMs === null || lastResumeBoundaryMs >= lastHeartbeatMs)
  ) {
    return { verdict: 'healthy', reason: 'resume-boundary' };
  }

  // 4. D5. Same shape, same reasoning: a correction enqueued at or after the
  //    last append has not been delivered yet, and waiting for the next model
  //    call is not a stall. Step 6 populates the field; until then it is
  //    `undefined` everywhere, which parses to null and changes nothing.
  const correctionQueuedMs = parseIsoToEpochMs(correctionQueuedAt);
  if (
    correctionQueuedMs !== null &&
    (lastHeartbeatMs === null || correctionQueuedMs >= lastHeartbeatMs)
  ) {
    return { verdict: 'healthy', reason: 'correction-in-flight' };
  }

  // 5. Can we see the silence at all? Two distinct unknowns, kept distinct so a
  //    caller can say WHICH kind of blindness it hit:
  //      • nothing has ever been observed appending, versus
  //      • something was supplied and we could not read it.
  //    Every present-but-unparseable timestamp in the observation counts —
  //    including the resume boundary and the queued correction, because a
  //    corrupt one means we cannot establish the protection that timestamp
  //    exists to provide, and escalating past an unestablished protection is
  //    exactly how a healthy run gets quarantined.
  const nowMs = parseIsoToEpochMs(nowIso);
  if (
    isPresentButUnparseable(lastHeartbeatAt) ||
    isPresentButUnparseable(lastResumeBoundaryAt) ||
    isPresentButUnparseable(correctionQueuedAt) ||
    nowMs === null
  ) {
    return { verdict: 'unknown', reason: 'unparseable-timestamp' };
  }
  if (lastHeartbeatMs === null) {
    return { verdict: 'unknown', reason: 'no-heartbeat-observed' };
  }

  // 6. D30 condition (3). Note the direction, pinned by test rather than
  //    assumed (D33 exists because a boundary was assumed): silence EXACTLY at
  //    the band is stale, one millisecond below it is healthy. A negative
  //    silence (a heartbeat ahead of `now` — clock skew across hosts) is below
  //    any non-negative band and therefore healthy, which is the direction that
  //    protects work.
  const observedSilenceMs = nowMs - lastHeartbeatMs;
  if (observedSilenceMs < policy.staleAfterMs) {
    return { verdict: 'healthy', reason: 'appending' };
  }

  // 7. The escalation. Both branches are reached ONLY past all six protections.
  //    Every number here comes from the caller's policy — this module contains
  //    no retry count and no backoff constant (rule 0.2; the ⟨tune⟩s are
  //    unpinned and may not become FAIL-able assertions until Wes signs them).
  if (staleRetriesSoFar < policy.maxStaleRetries) {
    return {
      verdict: 'stale',
      observedSilenceMs,
      retryNumber: staleRetriesSoFar + 1,
      retryAfterMs: readBackoffForRetry(policy.retryBackoffMs, staleRetriesSoFar),
    };
  }

  return { verdict: 'quarantine', observedSilenceMs, retriesExhausted: staleRetriesSoFar };
}

// Positional read with a CLAMP to the last element: retry 1 reads element 0,
// retry 2 element 1, and every retry past the array's length re-reads the last
// element. Clamping (rather than wrapping or extrapolating) means a short curve
// degrades into "hold the final delay", which is the behaviour a reader expects
// from a backoff curve that has run out.
//
// DEGENERATE CASE, stated rather than hidden: an EMPTY curve names no delay, and
// the verdict shape requires a number, so it yields 0 — "no delay stated", not a
// tuned default (there is no number in this module for a caller to inherit).
// A caller that supplies an empty curve has declined to specify backoff; the
// retry ceiling still bounds the escalation. Same spirit as D33 — the degenerate
// value is pinned deliberately and documented, not left to fall out.
function readBackoffForRetry(
  retryBackoffMs: readonly number[],
  retriesSoFar: number,
): number {
  if (retryBackoffMs.length === 0) {
    return 0;
  }
  const clampedIndex = Math.min(Math.max(retriesSoFar, 0), retryBackoffMs.length - 1);
  return retryBackoffMs[clampedIndex] ?? 0;
}
