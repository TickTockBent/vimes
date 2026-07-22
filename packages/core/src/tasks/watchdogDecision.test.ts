import { describe, expect, it } from 'vitest';
import {
  ALL_ATTENTION_REASONS,
  ALL_EVENT_TYPES,
  ALL_SESSION_LIVENESS,
  NON_BLOCKING_ATTENTION_REASONS,
  NON_GOVERNED_SESSION_LIVENESS,
  NON_HEARTBEAT_EVENT_TYPES,
  TRANSCRIPT_APPEND_EVENT_TYPES,
  WATCHDOG_BLOCKING_ATTENTION_REASONS,
  WATCHDOG_GOVERNED_LIVENESS,
  assessStageRun,
  isBlockingAttentionReason,
  isTranscriptAppendEventType,
  isWatchdogGovernedLiveness,
  type StageRunObservation,
  type WatchdogPolicy,
  type WatchdogVerdict,
} from './watchdogDecision.js';
import { EVENT_TYPES } from '../events.js';
import type { SessionRecord } from '../schemas.js';

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Every clock in this file is a LITERAL or is derived from one by arithmetic.
// `nowIso` is a parameter of the function under test (rule 0.3), so no test here
// may read a clock either — one that did would be asserting against a moving
// target and would also trip the ci-gate's nondeterminism grep over
// packages/core/src.

const NOW_ISO = '2026-07-22T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const ONE_MINUTE_MS = 60 * 1000;

// D30's PINNED band, named here as a TEST INPUT — there is no default in the
// module to import, and rule 0.2 keeps it that way. Every band-relative
// assertion below is written against this variable, never against "15".
const STALE_AFTER_MS = 15 * ONE_MINUTE_MS;

// ⚠ **THESE TWO NUMBERS ARE ARBITRARY AND ARE NOT A PIN.** D30 pinned the
// staleness band and pinned NOTHING about retries — S3 measured staleness, not
// retry behaviour, so ⟨tune 3⟩ retries-before-quarantine and the backoff curve
// have no evidence behind them and may not become FAIL-able assertions
// (rule 0.2 / Gate-D; that call is Wes's and it is unmade). They exist here only
// so a policy object can be constructed. **No test in this file asserts that any
// particular retry count or delay is the RIGHT one** — the escalation tests
// parametrize over several values and assert RELATIONSHIPS.
const ARBITRARY_MAX_STALE_RETRIES = 2;
const ARBITRARY_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];

function policy(overrides: Partial<WatchdogPolicy> = {}): WatchdogPolicy {
  return {
    staleAfterMs: STALE_AFTER_MS,
    maxStaleRetries: ARBITRARY_MAX_STALE_RETRIES,
    retryBackoffMs: ARBITRARY_RETRY_BACKOFF_MS,
    ...overrides,
  };
}

// Pure timestamp arithmetic around the literal `NOW_ISO`: no clock is read.
function isoBeforeNow(millisecondsOfSilence: number): string {
  return new Date(NOW_MS - millisecondsOfSilence).toISOString();
}

function observation(overrides: Partial<StageRunObservation> = {}): StageRunObservation {
  return {
    appSessionId: 'app-session-1',
    taskId: 'task-1',
    liveness: 'running',
    needsAttention: null,
    lastHeartbeatAt: NOW_ISO,
    lastResumeBoundaryAt: null,
    staleRetriesSoFar: 0,
    ...overrides,
  };
}

// A run that has been silent for `millisecondsOfSilence`, with nothing else
// protecting it — the shape every escalation test starts from.
function silentFor(
  millisecondsOfSilence: number,
  overrides: Partial<StageRunObservation> = {},
): StageRunObservation {
  return observation({ lastHeartbeatAt: isoBeforeNow(millisecondsOfSilence), ...overrides });
}

function attention(reason: string): SessionRecord['needsAttention'] {
  return { reason, since: NOW_ISO } as SessionRecord['needsAttention'];
}

// Freeze an object graph so a mutation anywhere inside the input THROWS rather
// than passing silently (vitest runs in strict mode, where writing to a frozen
// property is a TypeError).
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nestedValue);
  }
  return Object.freeze(value);
}

// Silences used wherever "several silences including one absurdly long" is
// called for. The 10-hour entry is S3a's measured healthy human-gated wait
// (599.99 min); the 24-hour entry is past anything ever observed.
const ABSURD_SILENCES_MS: readonly number[] = [
  0,
  STALE_AFTER_MS - 1,
  STALE_AFTER_MS,
  STALE_AFTER_MS * 4,
  10 * 60 * ONE_MINUTE_MS,
  24 * 60 * ONE_MINUTE_MS,
];

// ─── 1. the governed-liveness partition ──────────────────────────────────────
//
// Both sides are ENUMERATED from the exported data — the governed set and its
// complement against the schema's own liveness enum. There is deliberately no
// hand-copied liveness list in this file: a set plus a transcribed test list is
// two sources of one truth, and they drift.

describe('the governed-liveness partition', () => {
  it('partitions the schema liveness enum exactly — every value is on exactly one side', () => {
    const governed = [...WATCHDOG_GOVERNED_LIVENESS];
    const union = [...governed, ...NON_GOVERNED_SESSION_LIVENESS].sort();
    expect(union).toEqual([...ALL_SESSION_LIVENESS].sort());
    expect(new Set(union).size).toBe(ALL_SESSION_LIVENESS.length);
    for (const liveness of governed) {
      expect(ALL_SESSION_LIVENESS).toContain(liveness);
      expect(NON_GOVERNED_SESSION_LIVENESS).not.toContain(liveness);
    }
  });

  it('names the two governed liveness values and nothing else', () => {
    // The one place the design intent is spelled out as a value. A liveness
    // added to the schema lands in the complement (ungoverned) by construction,
    // and THIS assertion is where a deliberate change to the governed side is
    // made — never an incidental one.
    expect([...WATCHDOG_GOVERNED_LIVENESS].sort()).toEqual(['running', 'spawning']);
  });

  it('EVERY governed liveness can reach BOTH escalations', () => {
    // Assertion 1's first half: a governed value is not merely "in the set", it
    // is a value the watchdog can actually escalate on. A governed value that
    // could never escalate would be a silently dead branch.
    expect(WATCHDOG_GOVERNED_LIVENESS.size).toBeGreaterThan(0);
    for (const liveness of WATCHDOG_GOVERNED_LIVENESS) {
      const stale = assessStageRun(
        silentFor(STALE_AFTER_MS, { liveness, staleRetriesSoFar: 0 }),
        policy(),
        NOW_ISO,
      );
      expect(stale.verdict, `governed liveness ${liveness} could not reach stale`).toBe('stale');

      const quarantined = assessStageRun(
        silentFor(STALE_AFTER_MS, {
          liveness,
          staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES,
        }),
        policy(),
        NOW_ISO,
      );
      expect(
        quarantined.verdict,
        `governed liveness ${liveness} could not reach quarantine`,
      ).toBe('quarantine');
    }
  });

  it('EVERY non-governed liveness returns not-a-live-run, even at absurd silence with retries exhausted', () => {
    expect(NON_GOVERNED_SESSION_LIVENESS.length).toBeGreaterThan(0);
    for (const liveness of NON_GOVERNED_SESSION_LIVENESS) {
      for (const silenceMs of ABSURD_SILENCES_MS) {
        expect(
          assessStageRun(
            silentFor(silenceMs, { liveness, staleRetriesSoFar: 999 }),
            policy(),
            NOW_ISO,
          ),
          `${liveness} at ${silenceMs}ms silence`,
        ).toEqual({ verdict: 'healthy', reason: 'not-a-live-run' });
      }
    }
  });

  it('a liveness outside the schema enum is fail-safe, not a crash', () => {
    // Observations are assembled by the daemon from projections that tolerate
    // old snapshots; TypeScript's guarantee stops at that boundary.
    expect(isWatchdogGovernedLiveness('wat')).toBe(false);
    const malformed = {
      ...silentFor(STALE_AFTER_MS),
      liveness: 'wat',
    } as unknown as StageRunObservation;
    expect(assessStageRun(malformed, policy(), NOW_ISO)).toEqual({
      verdict: 'healthy',
      reason: 'not-a-live-run',
    });
  });
});

// ─── 2. THE FINDING GUARD ────────────────────────────────────────────────────
//
// ⚠ **THE LOAD-BEARING TEST OF THIS FILE.** Slice 6's named rule-0.1 finding is
// "the watchdog quarantines a HEALTHY run". S3a measured healthy human-gated
// waits reaching 599.99 min (10 h) — the human's reply comes back as a
// `tool_result`, so it is indistinguishable in the JSONL from in-flight work,
// and no time threshold can separate them. **If this test is ever weakened, the
// slice's named finding is live.**

describe('THE FINDING GUARD — a gate-blocked or question-blocked run is HEALTHY at any silence', () => {
  const blockingReasons = [...WATCHDOG_BLOCKING_ATTENTION_REASONS];

  it('names the two blocking reasons — D30 condition (1)', () => {
    expect(blockingReasons.sort()).toEqual(['gate', 'question']);
  });

  it.each(blockingReasons)('reason %s stays healthy at every silence, including 10 hours', (reason) => {
    for (const silenceMs of ABSURD_SILENCES_MS) {
      for (const liveness of WATCHDOG_GOVERNED_LIVENESS) {
        expect(
          assessStageRun(
            silentFor(silenceMs, { liveness, needsAttention: attention(reason) }),
            policy(),
            NOW_ISO,
          ),
          `${reason} at ${silenceMs}ms silence, liveness ${liveness}`,
        ).toEqual({ verdict: 'healthy', reason: 'awaiting-human' });
      }
    }
  });

  it.each(blockingReasons)(
    'reason %s stays healthy even with retries already exhausted (the protection outranks the escalation)',
    (reason) => {
      // The identical observation WITHOUT the attention reason quarantines —
      // so the test cannot pass because the escalation was unreachable anyway.
      const silentTenHours = silentFor(10 * 60 * ONE_MINUTE_MS, {
        staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES + 5,
      });
      expect(assessStageRun(silentTenHours, policy(), NOW_ISO).verdict).toBe('quarantine');
      expect(
        assessStageRun(
          { ...silentTenHours, needsAttention: attention(reason) },
          policy(),
          NOW_ISO,
        ),
      ).toEqual({ verdict: 'healthy', reason: 'awaiting-human' });
    },
  );

  it('a NON-blocking attention reason does NOT protect — the partition is enumerated, not sampled', () => {
    // The other half of the classification, and the one that keeps the guard
    // ARMED. `stale` and `quarantined` are watchdog-AUTHORED: if either were
    // treated as blocking, the first `watchdog_stale` would set
    // `needsAttention: 'stale'`, which would protect the run forever and no
    // retry could ever escalate — the same disarms-itself bug as a
    // self-refreshing heartbeat.
    expect(NON_BLOCKING_ATTENTION_REASONS.length).toBeGreaterThan(0);
    for (const reason of NON_BLOCKING_ATTENTION_REASONS) {
      expect(isBlockingAttentionReason(reason), `${reason} must not protect`).toBe(false);
      expect(
        assessStageRun(
          silentFor(STALE_AFTER_MS, {
            needsAttention: attention(reason),
            staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES,
          }),
          policy(),
          NOW_ISO,
        ).verdict,
        `${reason} wrongly protected a silent run`,
      ).toBe('quarantine');
    }
  });

  it('explicitly: the watchdog-authored reasons are on the NON-blocking side', () => {
    // Named rather than left to the derived complement, because THESE are the
    // two whose misclassification silently disables the watchdog.
    expect(NON_BLOCKING_ATTENTION_REASONS).toContain('stale');
    expect(NON_BLOCKING_ATTENTION_REASONS).toContain('quarantined');
  });

  it('null attention does not protect, and an attention reason outside the enum does not either', () => {
    expect(isBlockingAttentionReason(null)).toBe(false);
    expect(isBlockingAttentionReason(undefined)).toBe(false);
    expect(isBlockingAttentionReason('wat')).toBe(false);
    expect(
      assessStageRun(
        silentFor(STALE_AFTER_MS, { needsAttention: attention('wat') }),
        policy(),
        NOW_ISO,
      ).verdict,
    ).toBe('stale');
  });

  it('the attention-reason partition covers the schema enum exactly', () => {
    const union = [...WATCHDOG_BLOCKING_ATTENTION_REASONS, ...NON_BLOCKING_ATTENTION_REASONS].sort();
    expect(union).toEqual([...ALL_ATTENTION_REASONS].sort());
    expect(new Set(union).size).toBe(ALL_ATTENTION_REASONS.length);
  });
});

// ─── 3. the resume boundary — D30 condition (2) ──────────────────────────────

describe('resume boundary', () => {
  it('a boundary NEWER than the last heartbeat is healthy at every silence', () => {
    for (const silenceMs of ABSURD_SILENCES_MS) {
      const heartbeatSilence = silenceMs + ONE_MINUTE_MS;
      expect(
        assessStageRun(
          silentFor(heartbeatSilence, {
            lastResumeBoundaryAt: isoBeforeNow(silenceMs),
            staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES + 5,
          }),
          policy(),
          NOW_ISO,
        ),
        `resume boundary ${silenceMs}ms ago, heartbeat ${heartbeatSilence}ms ago`,
      ).toEqual({ verdict: 'healthy', reason: 'resume-boundary' });
    }
  });

  it('a boundary EXACTLY at the last heartbeat protects (at-or-after, pinned by test)', () => {
    const silence = STALE_AFTER_MS * 4;
    expect(
      assessStageRun(
        silentFor(silence, { lastResumeBoundaryAt: isoBeforeNow(silence) }),
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'resume-boundary' });
  });

  it('an OLDER boundary does NOT protect — it falls through to the escalation', () => {
    // The run resumed and then appended: the append is the newer fact, so the
    // silence since it is real silence.
    const verdict = assessStageRun(
      silentFor(STALE_AFTER_MS, {
        lastResumeBoundaryAt: isoBeforeNow(STALE_AFTER_MS + ONE_MINUTE_MS),
      }),
      policy(),
      NOW_ISO,
    );
    expect(verdict.verdict).toBe('stale');
  });

  it('a boundary with NO heartbeat at all protects (resumed, never yet observed appending)', () => {
    expect(
      assessStageRun(
        observation({ lastHeartbeatAt: null, lastResumeBoundaryAt: isoBeforeNow(STALE_AFTER_MS * 4) }),
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'resume-boundary' });
  });

  it('a null boundary changes nothing (the default everywhere)', () => {
    const withNull = assessStageRun(
      silentFor(STALE_AFTER_MS, { lastResumeBoundaryAt: null }),
      policy(),
      NOW_ISO,
    );
    expect(withNull.verdict).toBe('stale');
  });
});

// ─── 4. the queued correction — D5 / D30 ─────────────────────────────────────
//
// Nothing populates `correctionQueuedAt` until step 6. The decision honours it
// NOW so that step 6 wires a value in and changes no logic here (rule 0.5).

describe('correction in flight', () => {
  it('a correction queued AFTER the last heartbeat is healthy at every silence', () => {
    for (const silenceMs of ABSURD_SILENCES_MS) {
      const heartbeatSilence = silenceMs + ONE_MINUTE_MS;
      expect(
        assessStageRun(
          silentFor(heartbeatSilence, {
            correctionQueuedAt: isoBeforeNow(silenceMs),
            staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES + 5,
          }),
          policy(),
          NOW_ISO,
        ),
        `correction queued ${silenceMs}ms ago`,
      ).toEqual({ verdict: 'healthy', reason: 'correction-in-flight' });
    }
  });

  it('the unbounded worst case D5 names — a long build — is still healthy', () => {
    // D5: delivery is bounded by the NEXT MODEL CALL, not by generation. 30.4 s
    // was observed against a 40 s tool and the worst case is unbounded, so a
    // correction parked behind an hours-long test suite must not read as stale.
    expect(
      assessStageRun(
        silentFor(4 * 60 * ONE_MINUTE_MS, {
          correctionQueuedAt: isoBeforeNow(4 * 60 * ONE_MINUTE_MS - 1),
        }),
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'correction-in-flight' });
  });

  it('a correction queued exactly AT the heartbeat protects; an OLDER one does not', () => {
    const silence = STALE_AFTER_MS * 2;
    expect(
      assessStageRun(
        silentFor(silence, { correctionQueuedAt: isoBeforeNow(silence) }),
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'correction-in-flight' });
    // Older: the run appended AFTER the correction was queued, so it was
    // delivered — the silence since that append is real silence.
    expect(
      assessStageRun(
        silentFor(silence, { correctionQueuedAt: isoBeforeNow(silence + ONE_MINUTE_MS) }),
        policy(),
        NOW_ISO,
      ).verdict,
    ).toBe('stale');
  });

  it('leaving the field undefined (as everything does until step 6) changes NOTHING', () => {
    // Assertion 4's real content: the reserved field must be inert. Every other
    // case in this file is re-run with the field absent, present-as-undefined
    // and present-as-null, and all three must agree.
    const cases: Array<Partial<StageRunObservation>> = [
      { liveness: 'dead' },
      { needsAttention: attention('gate') },
      { lastResumeBoundaryAt: isoBeforeNow(0) },
      { lastHeartbeatAt: null },
      { lastHeartbeatAt: 'not-a-timestamp' },
      {},
      { staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES },
    ];
    for (const caseOverrides of cases) {
      const base = silentFor(STALE_AFTER_MS * 2, caseOverrides);
      const withoutField = assessStageRun(base, policy(), NOW_ISO);
      const withUndefined = assessStageRun(
        { ...base, correctionQueuedAt: undefined },
        policy(),
        NOW_ISO,
      );
      const withNull = assessStageRun({ ...base, correctionQueuedAt: null }, policy(), NOW_ISO);
      expect(withUndefined).toEqual(withoutField);
      expect(withNull).toEqual(withoutField);
    }
  });
});

// ─── 5. unknown — and it NEVER escalates ─────────────────────────────────────

describe('unknown is its own verdict and never escalates', () => {
  it('a null heartbeat is no-heartbeat-observed, never stale or quarantine', () => {
    for (const staleRetriesSoFar of [0, ARBITRARY_MAX_STALE_RETRIES, 999]) {
      expect(
        assessStageRun(
          observation({ lastHeartbeatAt: null, staleRetriesSoFar }),
          policy(),
          NOW_ISO,
        ),
      ).toEqual({ verdict: 'unknown', reason: 'no-heartbeat-observed' });
    }
  });

  it.each([
    { label: 'the heartbeat', overrides: { lastHeartbeatAt: 'not-a-timestamp' } },
    { label: 'the resume boundary', overrides: { lastResumeBoundaryAt: 'whenever' } },
    { label: 'the queued correction', overrides: { correctionQueuedAt: 'soon' } },
  ])('an unparseable timestamp in $label yields unparseable-timestamp', ({ overrides }) => {
    expect(
      assessStageRun(
        silentFor(STALE_AFTER_MS * 4, {
          staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES + 5,
          ...overrides,
        }),
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'unknown', reason: 'unparseable-timestamp' });
  });

  it('an unparseable nowIso yields unparseable-timestamp — we cannot place the run in time', () => {
    expect(
      assessStageRun(
        silentFor(STALE_AFTER_MS * 4, { staleRetriesSoFar: 999 }),
        policy(),
        'not-a-timestamp',
      ),
    ).toEqual({ verdict: 'unknown', reason: 'unparseable-timestamp' });
  });

  it('an empty-string heartbeat reads as never observed, not as a parse failure', () => {
    expect(
      assessStageRun(observation({ lastHeartbeatAt: '' }), policy(), NOW_ISO),
    ).toEqual({ verdict: 'unknown', reason: 'no-heartbeat-observed' });
  });
});

// ─── 6. the band boundary — pinned by test, not assumed ──────────────────────
//
// D33 exists because a boundary was assumed rather than asserted. The direction
// is fixed HERE so no later reader has to infer it from the comparison operator.

describe('the staleness band boundary', () => {
  it('one millisecond BELOW the band is healthy: appending', () => {
    expect(assessStageRun(silentFor(STALE_AFTER_MS - 1), policy(), NOW_ISO)).toEqual({
      verdict: 'healthy',
      reason: 'appending',
    });
  });

  it('EXACTLY at the band is stale — the band is inclusive (≥)', () => {
    expect(assessStageRun(silentFor(STALE_AFTER_MS), policy(), NOW_ISO)).toMatchObject({
      verdict: 'stale',
      observedSilenceMs: STALE_AFTER_MS,
    });
  });

  it('one millisecond ABOVE the band is stale', () => {
    expect(assessStageRun(silentFor(STALE_AFTER_MS + 1), policy(), NOW_ISO)).toMatchObject({
      verdict: 'stale',
      observedSilenceMs: STALE_AFTER_MS + 1,
    });
  });

  it('zero silence is healthy, and a NEGATIVE silence (clock skew) is healthy too', () => {
    expect(assessStageRun(silentFor(0), policy(), NOW_ISO)).toEqual({
      verdict: 'healthy',
      reason: 'appending',
    });
    // A heartbeat stamped ahead of `now`: hosts disagree about the clock. The
    // protective direction is the only acceptable one for a guard that kills.
    expect(assessStageRun(silentFor(-ONE_MINUTE_MS), policy(), NOW_ISO)).toEqual({
      verdict: 'healthy',
      reason: 'appending',
    });
  });

  it('the band is the CALLER’s — a different band moves the boundary with it', () => {
    // Proof that no band is baked in: the same observation flips on the policy
    // alone. S3a's measured machine-work maximum (14.87 min) is healthy under
    // D30's 15-minute band and stale under the spec's disproved 5-minute one —
    // the exact false quarantine D30 was pinned to prevent.
    const measuredMachineWorkMaximumMs = Math.round(14.87 * ONE_MINUTE_MS);
    const longestObservedHealthyGap = silentFor(measuredMachineWorkMaximumMs);
    expect(
      assessStageRun(longestObservedHealthyGap, policy({ staleAfterMs: STALE_AFTER_MS }), NOW_ISO)
        .verdict,
    ).toBe('healthy');
    expect(
      assessStageRun(longestObservedHealthyGap, policy({ staleAfterMs: 5 * ONE_MINUTE_MS }), NOW_ISO)
        .verdict,
    ).toBe('stale');
  });
});

// ─── 7. escalation is PARAMETRIZED, never pinned ─────────────────────────────

describe('escalation — retries then quarantine', () => {
  // ⚠ **NO TEST BELOW ASSERTS THAT ANY PARTICULAR N IS THE RIGHT N.** ⟨tune 3⟩
  // retries-before-quarantine is UNPINNED: D30 pinned the staleness band and
  // explicitly left the retry count and the backoff curve to a later Gate-D
  // sign-off, because no measurement covers retry behaviour yet. These tests
  // assert the RELATIONSHIP — "with a ceiling of N, retries 0..N-1 escalate as
  // stale and the Nth quarantines" — for several N, which is exactly what keeps
  // this step a PREVIEW rather than a pin.
  const retryCeilings = [1, 2, 3, 5, 7];

  it.each(retryCeilings)('with maxStaleRetries = %i, retries 0..N-1 are stale and N+ quarantines', (maxStaleRetries) => {
    const escalationPolicy = policy({ maxStaleRetries });
    for (let staleRetriesSoFar = 0; staleRetriesSoFar < maxStaleRetries; staleRetriesSoFar += 1) {
      const verdict = assessStageRun(
        silentFor(STALE_AFTER_MS, { staleRetriesSoFar }),
        escalationPolicy,
        NOW_ISO,
      );
      expect(verdict).toMatchObject({
        verdict: 'stale',
        // 1-based: the FIRST escalation is retry 1.
        retryNumber: staleRetriesSoFar + 1,
      });
    }
    for (const exhausted of [maxStaleRetries, maxStaleRetries + 1, maxStaleRetries + 50]) {
      expect(
        assessStageRun(
          silentFor(STALE_AFTER_MS, { staleRetriesSoFar: exhausted }),
          escalationPolicy,
          NOW_ISO,
        ),
      ).toEqual({
        verdict: 'quarantine',
        observedSilenceMs: STALE_AFTER_MS,
        retriesExhausted: exhausted,
      });
    }
  });

  it('a ceiling of zero quarantines on the FIRST staleness (no retries at all)', () => {
    // A relationship, not a recommendation: N = 0 means "do not retry".
    expect(
      assessStageRun(silentFor(STALE_AFTER_MS), policy({ maxStaleRetries: 0 }), NOW_ISO),
    ).toEqual({ verdict: 'quarantine', observedSilenceMs: STALE_AFTER_MS, retriesExhausted: 0 });
  });

  it('the escalation carries the observed silence, so a caller can report WHAT it saw', () => {
    const silence = STALE_AFTER_MS * 3 + 17;
    expect(assessStageRun(silentFor(silence), policy(), NOW_ISO)).toMatchObject({
      observedSilenceMs: silence,
    });
    expect(
      assessStageRun(
        silentFor(silence, { staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES }),
        policy(),
        NOW_ISO,
      ),
    ).toMatchObject({ observedSilenceMs: silence });
  });
});

// ─── 8. the backoff curve — positional, clamping ─────────────────────────────

describe('retryAfterMs follows the caller-supplied curve', () => {
  // These tests are about the CURVE, not the ceiling, so they lift the retry
  // ceiling out of the way. The number is deliberately meaningless — see the
  // ⟨tune⟩ note at the top of the file: no test here pins a retry count.
  const CEILING_OUT_OF_THE_WAY = 100_000;

  it('reads the curve POSITIONALLY: retry 1 → element 0, retry 2 → element 1, …', () => {
    const curve = [11, 22, 33, 44];
    const backoffPolicy = policy({
      maxStaleRetries: CEILING_OUT_OF_THE_WAY,
      retryBackoffMs: curve,
    });
    for (let retriesSoFar = 0; retriesSoFar < curve.length; retriesSoFar += 1) {
      expect(
        assessStageRun(
          silentFor(STALE_AFTER_MS, { staleRetriesSoFar: retriesSoFar }),
          backoffPolicy,
          NOW_ISO,
        ),
      ).toMatchObject({ verdict: 'stale', retryNumber: retriesSoFar + 1, retryAfterMs: curve[retriesSoFar] });
    }
  });

  it('CLAMPS to the last element once retries run past the curve', () => {
    const curve = [11, 22, 33];
    const backoffPolicy = policy({ maxStaleRetries: CEILING_OUT_OF_THE_WAY, retryBackoffMs: curve });
    for (const retriesSoFar of [curve.length, curve.length + 1, curve.length + 500]) {
      expect(
        assessStageRun(
          silentFor(STALE_AFTER_MS, { staleRetriesSoFar: retriesSoFar }),
          backoffPolicy,
          NOW_ISO,
        ),
      ).toMatchObject({ retryAfterMs: curve[curve.length - 1] });
    }
  });

  it('a single-element curve is legal — every retry reads it', () => {
    const backoffPolicy = policy({ maxStaleRetries: CEILING_OUT_OF_THE_WAY, retryBackoffMs: [7] });
    for (const retriesSoFar of [0, 1, 2, 40]) {
      expect(
        assessStageRun(
          silentFor(STALE_AFTER_MS, { staleRetriesSoFar: retriesSoFar }),
          backoffPolicy,
          NOW_ISO,
        ),
      ).toMatchObject({ retryAfterMs: 7 });
    }
  });

  it('an EMPTY curve is degenerate, not a crash: it names no delay, so 0', () => {
    // Documented on `readBackoffForRetry`: 0 is "no delay stated", not a tuned
    // default — a caller that supplies an empty curve has declined to specify
    // backoff, and the retry CEILING still bounds the escalation.
    expect(
      assessStageRun(
        silentFor(STALE_AFTER_MS),
        policy({ maxStaleRetries: CEILING_OUT_OF_THE_WAY, retryBackoffMs: [] }),
        NOW_ISO,
      ),
    ).toMatchObject({ verdict: 'stale', retryNumber: 1, retryAfterMs: 0 });
  });

  it('a NON-DECREASING curve stays non-decreasing across its retries (a relationship, not a pin)', () => {
    const curve = [1_000, 5_000, 30_000];
    const backoffPolicy = policy({ maxStaleRetries: CEILING_OUT_OF_THE_WAY, retryBackoffMs: curve });
    const delays: number[] = [];
    for (let retriesSoFar = 0; retriesSoFar < curve.length + 3; retriesSoFar += 1) {
      const verdict = assessStageRun(
        silentFor(STALE_AFTER_MS, { staleRetriesSoFar: retriesSoFar }),
        backoffPolicy,
        NOW_ISO,
      );
      if (verdict.verdict === 'stale') {
        delays.push(verdict.retryAfterMs);
      }
    }
    expect(delays.length).toBe(curve.length + 3);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] as number);
    }
  });
});

// ─── 9. check order, with conditions STACKED ─────────────────────────────────
//
// Every case below satisfies SEVERAL conditions at once; only the stacking makes
// the order assertable (a case with one condition would pass under any ordering).

describe('check order — every PROTECTION beats every ESCALATION', () => {
  // The observation each case starts from: silent for ten hours, retries long
  // since exhausted. On its own it QUARANTINES — asserted first, so no case
  // below can pass because the escalation was unreachable.
  const wouldQuarantine = silentFor(10 * 60 * ONE_MINUTE_MS, {
    staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES + 10,
  });

  it('the base observation really does quarantine (non-vacuity for every case below)', () => {
    expect(assessStageRun(wouldQuarantine, policy(), NOW_ISO).verdict).toBe('quarantine');
  });

  it('non-governed liveness + gate-blocked + silent for hours + retries exhausted → not-a-live-run', () => {
    expect(
      assessStageRun(
        { ...wouldQuarantine, liveness: 'dead', needsAttention: attention('gate') },
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'not-a-live-run' });
  });

  it('gate-blocked + resumed + correction queued + silent for hours + retries exhausted → awaiting-human', () => {
    expect(
      assessStageRun(
        {
          ...wouldQuarantine,
          needsAttention: attention('question'),
          lastResumeBoundaryAt: NOW_ISO,
          correctionQueuedAt: NOW_ISO,
        },
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'awaiting-human' });
  });

  it('resumed + correction queued + silent for hours + retries exhausted → resume-boundary', () => {
    expect(
      assessStageRun(
        { ...wouldQuarantine, lastResumeBoundaryAt: NOW_ISO, correctionQueuedAt: NOW_ISO },
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'resume-boundary' });
  });

  it('correction queued + UNPARSEABLE resume boundary + silent for hours → correction-in-flight, NOT quarantine', () => {
    // The correction check (4) sits above the unknown check (5), so a protection
    // we CAN establish wins over a timestamp we cannot read. Either outcome is
    // non-escalating; the ordering is pinned here so the reason is predictable.
    expect(
      assessStageRun(
        { ...wouldQuarantine, lastResumeBoundaryAt: 'garbage', correctionQueuedAt: NOW_ISO },
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'healthy', reason: 'correction-in-flight' });
  });

  it('UNPARSEABLE resume boundary alone + silent for hours → unknown, NOT quarantine', () => {
    expect(
      assessStageRun({ ...wouldQuarantine, lastResumeBoundaryAt: 'garbage' }, policy(), NOW_ISO),
    ).toEqual({ verdict: 'unknown', reason: 'unparseable-timestamp' });
  });

  it('unparseable heartbeat + silent-looking + retries exhausted → unknown, NOT quarantine', () => {
    expect(
      assessStageRun(
        { ...wouldQuarantine, lastHeartbeatAt: 'garbage' },
        policy(),
        NOW_ISO,
      ),
    ).toEqual({ verdict: 'unknown', reason: 'unparseable-timestamp' });
  });
});

// ─── THE STRUCTURAL SAFETY MATRIX ────────────────────────────────────────────
//
// The load-bearing assertion of the file, and the reason this suite ENUMERATES
// rather than samples. Every combination of (liveness × attention × heartbeat
// shape × resume boundary × queued correction × retries × clock) is assessed,
// and the safety properties are read off the whole cross product rather than off
// the cases we thought to name:
//
//   • an escalation (`stale` or `quarantine`) implies EVERY protection was
//     absent — governed liveness, no blocking attention, no protecting resume
//     boundary, no queued correction, no unreadable timestamp, and a silence at
//     or past the band; and
//   • read forwards: a gate-blocked run, a run at a resume boundary, and a run
//     with an unobservable heartbeat NEVER escalate, under any other combination.
//
// This is what ESTABLISHES the finding guard instead of asserting it: the
// property holds over all rows, so a future edit that reorders the checks or
// loosens a protection reddens here even if it leaves the named cases green.

describe('the structural safety matrix — no protected run can ever be escalated', () => {
  const MATRIX_MAX_STALE_RETRIES = 2;
  const matrixPolicy = policy({ maxStaleRetries: MATRIX_MAX_STALE_RETRIES });

  const heartbeatShapes: Array<{ label: string; value: string | null }> = [
    { label: 'never observed (null)', value: null },
    { label: 'never observed (empty)', value: '' },
    { label: 'unparseable', value: 'not-a-timestamp' },
    { label: 'just now', value: isoBeforeNow(0) },
    { label: 'one ms inside the band', value: isoBeforeNow(STALE_AFTER_MS - 1) },
    { label: 'exactly at the band', value: isoBeforeNow(STALE_AFTER_MS) },
    { label: 'ten hours ago', value: isoBeforeNow(10 * 60 * ONE_MINUTE_MS) },
  ];

  const resumeShapes: Array<{ label: string; value: string | null }> = [
    { label: 'none', value: null },
    { label: 'older than any heartbeat', value: isoBeforeNow(48 * 60 * ONE_MINUTE_MS) },
    { label: 'newer than any heartbeat', value: isoBeforeNow(0) },
    { label: 'unparseable', value: 'whenever' },
  ];

  const correctionShapes: Array<{ label: string; value: string | null | undefined }> = [
    { label: 'absent', value: undefined },
    { label: 'null', value: null },
    { label: 'older than any heartbeat', value: isoBeforeNow(48 * 60 * ONE_MINUTE_MS) },
    { label: 'newer than any heartbeat', value: isoBeforeNow(0) },
    { label: 'unparseable', value: 'soon' },
  ];

  const attentionShapes: Array<{ label: string; value: SessionRecord['needsAttention'] }> = [
    { label: 'none', value: null },
    ...ALL_ATTENTION_REASONS.map((reason) => ({ label: reason, value: attention(reason) })),
  ];

  const retryCounts = [0, MATRIX_MAX_STALE_RETRIES, MATRIX_MAX_STALE_RETRIES + 9];
  const clockChoices = [NOW_ISO, 'not-a-timestamp'];

  interface MatrixRow {
    readonly label: string;
    readonly observation: StageRunObservation;
    readonly nowIso: string;
    readonly verdict: WatchdogVerdict;
  }

  function everyRow(): MatrixRow[] {
    const rows: MatrixRow[] = [];
    for (const liveness of ALL_SESSION_LIVENESS) {
      for (const attentionShape of attentionShapes) {
        for (const heartbeatShape of heartbeatShapes) {
          for (const resumeShape of resumeShapes) {
            for (const correctionShape of correctionShapes) {
              for (const staleRetriesSoFar of retryCounts) {
                for (const nowIso of clockChoices) {
                  const rowObservation: StageRunObservation = {
                    appSessionId: 'app-session-1',
                    taskId: 'task-1',
                    liveness,
                    needsAttention: attentionShape.value,
                    lastHeartbeatAt: heartbeatShape.value,
                    lastResumeBoundaryAt: resumeShape.value,
                    correctionQueuedAt: correctionShape.value,
                    staleRetriesSoFar,
                  };
                  rows.push({
                    label: `liveness=${liveness} attention=${attentionShape.label} heartbeat=${heartbeatShape.label} resume=${resumeShape.label} correction=${correctionShape.label} retries=${staleRetriesSoFar} now=${nowIso}`,
                    observation: rowObservation,
                    nowIso,
                    verdict: assessStageRun(rowObservation, matrixPolicy, nowIso),
                  });
                }
              }
            }
          }
        }
      }
    }
    return rows;
  }

  const allRows = everyRow();

  it('the matrix is a real cross product and is NON-VACUOUS — it reaches every verdict and every healthy reason', () => {
    expect(allRows.length).toBe(
      ALL_SESSION_LIVENESS.length *
        attentionShapes.length *
        heartbeatShapes.length *
        resumeShapes.length *
        correctionShapes.length *
        retryCounts.length *
        clockChoices.length,
    );
    const verdicts = new Set(allRows.map((row) => row.verdict.verdict));
    expect([...verdicts].sort()).toEqual(['healthy', 'quarantine', 'stale', 'unknown']);
    const healthyReasons = new Set(
      allRows.flatMap((row) => (row.verdict.verdict === 'healthy' ? [row.verdict.reason] : [])),
    );
    expect([...healthyReasons].sort()).toEqual([
      'appending',
      'awaiting-human',
      'correction-in-flight',
      'not-a-live-run',
      'resume-boundary',
    ]);
    const unknownReasons = new Set(
      allRows.flatMap((row) => (row.verdict.verdict === 'unknown' ? [row.verdict.reason] : [])),
    );
    expect([...unknownReasons].sort()).toEqual(['no-heartbeat-observed', 'unparseable-timestamp']);
  });

  it('READ BACKWARDS: every escalation in the matrix had EVERY protection absent', () => {
    let escalatedRows = 0;
    for (const row of allRows) {
      if (row.verdict.verdict !== 'stale' && row.verdict.verdict !== 'quarantine') {
        continue;
      }
      escalatedRows += 1;
      const observed = row.observation;
      const heartbeatMs = Date.parse(String(observed.lastHeartbeatAt));
      expect(isWatchdogGovernedLiveness(observed.liveness), row.label).toBe(true);
      expect(isBlockingAttentionReason(observed.needsAttention?.reason), row.label).toBe(false);
      // The heartbeat was genuinely observable…
      expect(Number.isFinite(heartbeatMs), row.label).toBe(true);
      // …the clock was readable…
      expect(Number.isFinite(Date.parse(row.nowIso)), row.label).toBe(true);
      // …no resume boundary or queued correction was at-or-after it, and neither
      // was present-but-unreadable…
      for (const protectingTimestamp of [observed.lastResumeBoundaryAt, observed.correctionQueuedAt]) {
        if (typeof protectingTimestamp === 'string' && protectingTimestamp.length > 0) {
          const protectingMs = Date.parse(protectingTimestamp);
          expect(Number.isFinite(protectingMs), row.label).toBe(true);
          expect(protectingMs, row.label).toBeLessThan(heartbeatMs);
        }
      }
      // …and the silence really was at or past the band.
      expect(Date.parse(row.nowIso) - heartbeatMs, row.label).toBeGreaterThanOrEqual(
        STALE_AFTER_MS,
      );
    }
    expect(escalatedRows).toBeGreaterThan(0);
  });

  it('READ FORWARDS: a gate/question-blocked GOVERNED run is ALWAYS healthy: awaiting-human', () => {
    let blockedRows = 0;
    for (const row of allRows) {
      if (!isWatchdogGovernedLiveness(row.observation.liveness)) {
        continue;
      }
      if (!isBlockingAttentionReason(row.observation.needsAttention?.reason)) {
        continue;
      }
      blockedRows += 1;
      expect(row.verdict, row.label).toEqual({ verdict: 'healthy', reason: 'awaiting-human' });
    }
    expect(blockedRows).toBeGreaterThan(0);
  });

  it('READ FORWARDS: a run with an UNOBSERVABLE heartbeat never escalates', () => {
    let unobservableRows = 0;
    for (const row of allRows) {
      const heartbeat = row.observation.lastHeartbeatAt;
      const heartbeatIsObservable =
        typeof heartbeat === 'string' && heartbeat.length > 0 && Number.isFinite(Date.parse(heartbeat));
      if (heartbeatIsObservable) {
        continue;
      }
      unobservableRows += 1;
      expect(row.verdict.verdict, row.label).not.toBe('stale');
      expect(row.verdict.verdict, row.label).not.toBe('quarantine');
    }
    expect(unobservableRows).toBeGreaterThan(0);
  });

  it('READ FORWARDS: a governed run at a resume boundary newer than its heartbeat never escalates', () => {
    let resumedRows = 0;
    for (const row of allRows) {
      const { lastResumeBoundaryAt, lastHeartbeatAt } = row.observation;
      const resumeMs = Date.parse(String(lastResumeBoundaryAt));
      if (!Number.isFinite(resumeMs)) {
        continue;
      }
      const heartbeatMs = Date.parse(String(lastHeartbeatAt));
      if (Number.isFinite(heartbeatMs) && resumeMs < heartbeatMs) {
        continue;
      }
      resumedRows += 1;
      expect(row.verdict.verdict, row.label).not.toBe('stale');
      expect(row.verdict.verdict, row.label).not.toBe('quarantine');
    }
    expect(resumedRows).toBeGreaterThan(0);
  });

  it('READ FORWARDS: a governed run with a correction queued at-or-after its heartbeat never escalates', () => {
    let correctedRows = 0;
    for (const row of allRows) {
      const { correctionQueuedAt, lastHeartbeatAt } = row.observation;
      const correctionMs = Date.parse(String(correctionQueuedAt));
      if (!Number.isFinite(correctionMs)) {
        continue;
      }
      const heartbeatMs = Date.parse(String(lastHeartbeatAt));
      if (Number.isFinite(heartbeatMs) && correctionMs < heartbeatMs) {
        continue;
      }
      correctedRows += 1;
      expect(row.verdict.verdict, row.label).not.toBe('stale');
      expect(row.verdict.verdict, row.label).not.toBe('quarantine');
    }
    expect(correctedRows).toBeGreaterThan(0);
  });

  it('the matrix never throws — the function is TOTAL', () => {
    // Established by construction: every row above already called it. Restated
    // as its own assertion because "a watchdog that throws is a watchdog that
    // has silently stopped watching" is a property, not an accident.
    expect(allRows.length).toBeGreaterThan(0);
  });
});

// ─── 10. purity / determinism / no clock ─────────────────────────────────────

describe('purity and determinism', () => {
  const richObservation = silentFor(STALE_AFTER_MS * 2, {
    needsAttention: attention('completed'),
    lastResumeBoundaryAt: isoBeforeNow(STALE_AFTER_MS * 3),
    correctionQueuedAt: isoBeforeNow(STALE_AFTER_MS * 3),
    staleRetriesSoFar: 1,
  });

  it('does not mutate a deep-frozen observation or policy', () => {
    const frozenObservation = deepFreeze({ ...richObservation });
    const frozenPolicy = deepFreeze(policy());
    const observationBefore = JSON.stringify(frozenObservation);
    const policyBefore = JSON.stringify(frozenPolicy);
    expect(() => assessStageRun(frozenObservation, frozenPolicy, NOW_ISO)).not.toThrow();
    expect(JSON.stringify(frozenObservation)).toBe(observationBefore);
    expect(JSON.stringify(frozenPolicy)).toBe(policyBefore);
  });

  it('is deterministic — the same inputs always produce the same verdict', () => {
    const verdicts = [
      assessStageRun(richObservation, policy(), NOW_ISO),
      assessStageRun(richObservation, policy(), NOW_ISO),
      // A structurally-equal but distinct object graph decides identically:
      // nothing is keyed on object identity or insertion order.
      assessStageRun({ ...richObservation }, { ...policy() }, NOW_ISO),
    ];
    for (const verdict of verdicts) {
      expect(verdict).toEqual(verdicts[0]);
    }
  });

  it('reads NO clock — only the injected nowIso moves a time-dependent outcome', () => {
    // Clock-INDEPENDENT case: a non-governed run decides the same at any instant,
    // including one a year later. If the module read a real clock this could not
    // hold across arbitrary `nowIso` values.
    const parked = observation({ liveness: 'dormant' });
    const instants = [NOW_ISO, '2027-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'];
    for (const instant of instants) {
      expect(assessStageRun(parked, policy(), instant)).toEqual({
        verdict: 'healthy',
        reason: 'not-a-live-run',
      });
    }

    // Clock-DEPENDENT case: one fixed observation, three instants, and the
    // verdict moves with the PARAMETER and nothing else.
    const heartbeatAt = isoBeforeNow(0);
    const fixedRun = observation({ lastHeartbeatAt: heartbeatAt });
    expect(assessStageRun(fixedRun, policy(), NOW_ISO)).toEqual({
      verdict: 'healthy',
      reason: 'appending',
    });
    expect(
      assessStageRun(fixedRun, policy(), new Date(NOW_MS + STALE_AFTER_MS).toISOString()).verdict,
    ).toBe('stale');
    expect(
      assessStageRun(
        { ...fixedRun, staleRetriesSoFar: ARBITRARY_MAX_STALE_RETRIES },
        policy(),
        new Date(NOW_MS + STALE_AFTER_MS).toISOString(),
      ).verdict,
    ).toBe('quarantine');
  });

  it('every ⟨tune⟩ is REQUIRED — the same observation flips on the policy alone', () => {
    // Rule 0.2 made visible: nothing in the module supplies a band, a retry
    // ceiling or a backoff delay, so all three must come from the caller.
    const silent = silentFor(STALE_AFTER_MS, { staleRetriesSoFar: 1 });
    expect(
      assessStageRun(silent, policy({ staleAfterMs: STALE_AFTER_MS * 10 }), NOW_ISO).verdict,
    ).toBe('healthy');
    expect(assessStageRun(silent, policy({ maxStaleRetries: 1 }), NOW_ISO).verdict).toBe(
      'quarantine',
    );
    expect(assessStageRun(silent, policy({ maxStaleRetries: 9 }), NOW_ISO).verdict).toBe('stale');
    expect(
      assessStageRun(silent, policy({ maxStaleRetries: 9, retryBackoffMs: [42, 43] }), NOW_ISO),
    ).toMatchObject({ retryAfterMs: 43 });
  });
});

// ─── 11. the heartbeat definition ────────────────────────────────────────────

describe('TRANSCRIPT_APPEND_EVENT_TYPES — what may advance the heartbeat', () => {
  it('names exactly the tailer-derived transcript events', () => {
    // The one place the design intent is spelled out as a value. A new event
    // type lands in the derived complement (NOT a heartbeat) by construction,
    // and THIS assertion is where a deliberate addition is made.
    expect([...TRANSCRIPT_APPEND_EVENT_TYPES].sort()).toEqual(
      [
        'billing_bucket_observed',
        'claude_session_mapped',
        'gate_fired',
        'line_quarantined',
        'message',
        'question_asked',
        'run_completed',
        'ttl_tier_observed',
        'usage_block',
      ].sort(),
    );
  });

  it('⚠ contains NO daemon-authored bookkeeping type — the self-refreshing-heartbeat bug', () => {
    // If bookkeeping counted, **the watchdog writing `watchdog_stale` would
    // refresh the very heartbeat it is judging**: every poll would see a fresh
    // heartbeat, silence would reset on each escalation, and quarantine would be
    // unreachable — a guard that disarms itself on use. Rule 0.7 from the other
    // end: staleness is OBSERVED (JSONL append cadence), never DECLARED.
    const daemonAuthoredTypes = [
      EVENT_TYPES.watchdogStale,
      EVENT_TYPES.livenessChanged,
      EVENT_TYPES.notificationTrigger,
      EVENT_TYPES.seen,
      EVENT_TYPES.attentionCleared,
      EVENT_TYPES.sessionRenamed,
      EVENT_TYPES.taskCreated,
      EVENT_TYPES.taskTransitioned,
      EVENT_TYPES.taskTransitionRejected,
      EVENT_TYPES.taskSessionAttached,
      EVENT_TYPES.taskQuarantined,
      EVENT_TYPES.dispatchRefused,
    ];
    for (const eventType of daemonAuthoredTypes) {
      expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(eventType), `${eventType} must not be a heartbeat`).toBe(
        false,
      );
      expect(isTranscriptAppendEventType(eventType), `${eventType} must not be a heartbeat`).toBe(
        false,
      );
      expect(NON_HEARTBEAT_EVENT_TYPES).toContain(eventType);
    }
    // Named explicitly, because this is THE one: the watchdog's own event.
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has('watchdog_stale')).toBe(false);
    // And every `task_*` type in the vocabulary, found by shape rather than by
    // the hand-written list above, so a task event added later is covered too.
    for (const eventType of ALL_EVENT_TYPES.filter((type) => type.startsWith('task_'))) {
      expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(eventType), `${eventType} must not be a heartbeat`).toBe(
        false,
      );
    }
  });

  it('partitions the event vocabulary exactly, and every member is a REAL event type', () => {
    const union = [...TRANSCRIPT_APPEND_EVENT_TYPES, ...NON_HEARTBEAT_EVENT_TYPES].sort();
    expect(union).toEqual([...ALL_EVENT_TYPES].sort());
    expect(new Set(union).size).toBe(ALL_EVENT_TYPES.length);
    for (const eventType of TRANSCRIPT_APPEND_EVENT_TYPES) {
      expect(ALL_EVENT_TYPES, `${eventType} is not in EVENT_TYPES`).toContain(eventType);
    }
  });

  it('an event type outside the vocabulary is not a heartbeat (the log is forever)', () => {
    expect(isTranscriptAppendEventType('some_future_event')).toBe(false);
    expect(isTranscriptAppendEventType('')).toBe(false);
  });
});
