import { describe, expect, it } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  HOOK_EVENT_CONSTRUCTORS,
  REGISTERED_HOOK_EVENT_NAMES,
  gateFired,
  gateFiredPayloadSchema,
  hookEventPayloadSchema,
  hookSessionStart,
  meterAlert,
  meterAlertPayloadSchema,
  notificationTrigger,
  notificationTriggerPayloadSchema,
  pushFailedPayloadSchema,
  pushSentPayloadSchema,
  resyncMarker,
  resyncMarkerPayloadSchema,
  runtimeDriftObserved,
  runtimeDriftObservedPayloadSchema,
  sessionAdopted,
  sessionAdoptedPayloadSchema,
  sessionRenamed,
  sessionRenamedPayloadSchema,
  planSubmitted,
  reviewReported,
  completionReported,
  taskCreatedPayloadSchema,
  workOrderAmended,
  workOrderAmendedPayloadSchema,
} from './events.js';
import { sessionRecordSchema } from './schemas.js';
import {
  submitPlanPayloadSchema,
  reportReviewPayloadSchema,
  reportCompletionPayloadSchema,
} from './tasks/workOrder.js';

// gate_fired's schema widened (rule 0.7) to match wire reality: the daemon's
// real SDK gate carries requestId (sessionHost.ts's handleGate), harness
// profiles do not. Both shapes must validate under the same schema.
describe('gateFired / gateFiredPayloadSchema (widened for requestId, rule 0.7)', () => {
  it('constructor + schema both accept a payload WITH requestId', () => {
    const input = gateFired({ appSessionId: 'app-1', prompt: 'approve?', requestId: 'req-1' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'gate_fired',
      payload: { appSessionId: 'app-1', prompt: 'approve?', requestId: 'req-1' },
    });
    expect(gateFiredPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('constructor + schema both accept a payload WITHOUT requestId (harness profiles)', () => {
    const input = gateFired({ appSessionId: 'app-1', prompt: 'approve?' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'gate_fired',
      payload: { appSessionId: 'app-1', prompt: 'approve?' },
    });
    expect(gateFiredPayloadSchema.safeParse(input.payload).success).toBe(true);
  });
});

// Slice-2 hook vocabulary (B). Loose passthrough: unknown fields tolerated; the
// constructor emits on the session's stream with the ingress-stamped appSessionId.
describe('hook ingress vocabulary (B)', () => {
  it('hookSessionStart constructs on the session stream and tolerates unknown fields', () => {
    const payload = {
      appSessionId: 'app-1',
      hook_event_name: 'SessionStart',
      session_id: 'claude-xyz',
      transcript_path: '/t/claude-xyz.jsonl',
      cwd: '/p',
      source: 'startup',
      model: 'claude-opus-4-8[1m]',
    };
    const input = hookSessionStart(payload);
    expect(input.stream).toBe('app-1');
    expect(input.type).toBe('hook_session_start');
    const parsed = hookEventPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    // passthrough keeps the alien fields verbatim
    expect(parsed.success && (parsed.data as Record<string, unknown>).model).toBe('claude-opus-4-8[1m]');
  });

  it('the five registered hook names each map to a constructor emitting the right type', () => {
    expect(REGISTERED_HOOK_EVENT_NAMES).toEqual(['SessionStart', 'Stop', 'StopFailure', 'PreToolUse', 'SessionEnd']);
    const expectedTypes: Record<string, string> = {
      SessionStart: 'hook_session_start',
      Stop: 'hook_stop',
      StopFailure: 'hook_stop_failure',
      PreToolUse: 'hook_pre_tool_use',
      SessionEnd: 'hook_session_end',
    };
    for (const name of REGISTERED_HOOK_EVENT_NAMES) {
      const input = HOOK_EVENT_CONSTRUCTORS[name]!({ appSessionId: 'app-1', hook_event_name: name });
      expect(input.type).toBe(expectedTypes[name]);
      expect(input.stream).toBe('app-1');
    }
    expect(HOOK_EVENT_CONSTRUCTORS.NotAHook).toBeUndefined();
  });
});

// Slice-2 custody vocabulary (D10). Each constructor emits on the session stream.
describe('custody vocabulary (D10)', () => {
  it('sessionAdopted constructs on the session stream with via', () => {
    const explicit = sessionAdopted({ appSessionId: 'app-1', via: 'explicit' });
    expect(explicit).toEqual({
      stream: 'app-1',
      type: 'session_adopted',
      payload: { appSessionId: 'app-1', via: 'explicit' },
    });
    expect(sessionAdoptedPayloadSchema.safeParse(explicit.payload).success).toBe(true);
    const viaResume = sessionAdopted({ appSessionId: 'app-1', via: 'resume' });
    expect(sessionAdoptedPayloadSchema.safeParse(viaResume.payload).success).toBe(true);
    // An out-of-vocabulary `via` is rejected by the schema.
    expect(sessionAdoptedPayloadSchema.safeParse({ appSessionId: 'app-1', via: 'sneaky' }).success).toBe(false);
  });

  it('sessionRenamed constructs on the session stream with the name', () => {
    const input = sessionRenamed({ appSessionId: 'app-1', name: 'dongfu build' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'session_renamed',
      payload: { appSessionId: 'app-1', name: 'dongfu build' },
    });
    expect(sessionRenamedPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('resyncMarker constructs on the session stream with the sanctioned reason', () => {
    const input = resyncMarker({ appSessionId: 'app-1', reason: 'pre-adoption-history' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'resync_marker',
      payload: { appSessionId: 'app-1', reason: 'pre-adoption-history' },
    });
    expect(resyncMarkerPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(resyncMarkerPayloadSchema.safeParse({ appSessionId: 'app-1', reason: 'other' }).success).toBe(false);
  });
});

// Attention reason enum reservation (rule 0.5, docs/decomposition/README.md
// tracker row "Attention reason enum additions"): 'rate-limited' (slice 5,
// StopFailure/rate_limit_event) and 'brake' (slice 7, cascade guard) widen
// the value space now. NO setter emits them yet — verify every reason-typed
// schema accepts both, without changing which event types set attention.
describe('attention reason enum reservation — rate-limited / brake (rule 0.5)', () => {
  const reservedReasons = ['rate-limited', 'brake'] as const;

  it.each(reservedReasons)('notificationTriggerPayloadSchema accepts reason %s', (reason) => {
    const input = notificationTrigger({ appSessionId: 'app-1', reason });
    expect(input.payload).toEqual({ appSessionId: 'app-1', reason });
    expect(notificationTriggerPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it.each(reservedReasons)('pushSentPayloadSchema accepts reason %s', (reason) => {
    expect(pushSentPayloadSchema.safeParse({ appSessionId: 'app-1', reason }).success).toBe(true);
  });

  it.each(reservedReasons)('pushFailedPayloadSchema accepts reason %s', (reason) => {
    expect(
      pushFailedPayloadSchema.safeParse({ appSessionId: 'app-1', reason, statusCode: 410 }).success,
    ).toBe(true);
  });

  it.each(reservedReasons)('sessionRecordSchema.needsAttention accepts reason %s', (reason) => {
    const candidate = {
      appSessionId: 'app-1',
      channel: 'sdk',
      cwd: '/p',
      claudeSessionIds: [],
      liveness: 'running',
      needsAttention: { reason, since: '2026-07-19T00:00:00.000Z' },
      seenAt: null,
      forkedFrom: null,
      taskRef: null,
      observedTtlTier: 'unknown',
      observedBillingBucket: 'unknown',
      name: null,
      createdAt: '2026-07-19T00:00:00.000Z',
      provider: 'claude-code',
      custody: 'host',
    };
    expect(sessionRecordSchema.safeParse(candidate).success).toBe(true);
  });

  it('an out-of-vocabulary reason is still rejected', () => {
    expect(notificationTriggerPayloadSchema.safeParse({ appSessionId: 'app-1', reason: 'sneaky' }).success).toBe(
      false,
    );
  });
});

describe('runtime_drift_observed (E4)', () => {
  it('is system-scoped and accepts a null expected (unpinned)', () => {
    const input = runtimeDriftObserved({ expected: null, observed: '2.1.215' });
    expect(input.stream).toBe('system');
    expect(input.type).toBe('runtime_drift_observed');
    expect(runtimeDriftObservedPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('a HISTORICAL payload without channel/binaryPath still validates (append-only)', () => {
    // Drift events written before the pty/sdk channel split carry neither field.
    // The log is append-only, so they must keep parsing forever.
    const historicalPayload = { expected: '2.1.215', observed: '2.1.217' };
    expect(runtimeDriftObservedPayloadSchema.safeParse(historicalPayload).success).toBe(true);
  });

  it('carries the channel label and the observed binary path when present', () => {
    const sdkPayload = {
      expected: '2.1.207',
      observed: '2.1.208',
      channel: 'sdk',
      binaryPath: '/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    };
    expect(runtimeDriftObservedPayloadSchema.safeParse(sdkPayload).success).toBe(true);
    expect(runtimeDriftObservedPayloadSchema.safeParse({ ...sdkPayload, binaryPath: null }).success).toBe(true);
    // The channel vocabulary is closed: an unknown channel is rejected.
    expect(runtimeDriftObservedPayloadSchema.safeParse({ ...sdkPayload, channel: 'telepathy' }).success).toBe(false);
  });
});

describe('meter_alert (slice-5 step 4a — account-wide, not session-shaped)', () => {
  const crossingPayload = {
    meterId: 'session',
    thresholdPercent: 80,
    observedPercent: 83,
    kind: 'rolling-window' as const,
    scope: null,
    resetsAt: '2026-07-21T15:19:59.000Z',
    observedAt: '2026-07-21T12:00:00.000Z',
    disposition: 'notify' as const,
  };

  it('constructs on the usage stream and validates', () => {
    expect(meterAlert(crossingPayload)).toEqual({
      stream: 'usage',
      type: 'meter_alert',
      payload: crossingPayload,
    });
    expect(meterAlertPayloadSchema.safeParse(crossingPayload).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.meterAlert]).toBe(meterAlertPayloadSchema);
  });

  it('carries NO appSessionId — a threshold crossing belongs to no session', () => {
    // Deliberately not notification_trigger: that payload is keyed to a session
    // and its D9 suppression answers a different question. Forcing this event
    // into that shape would mean fabricating a session id.
    expect(Object.keys(meterAlertPayloadSchema.shape)).not.toContain('appSessionId');
    expect(notificationTriggerPayloadSchema.safeParse(crossingPayload).success).toBe(false);
  });

  // Rule 0.5 reservation (Wes, 2026-07-21): slice 7's brake holds work rather
  // than merely notifying. The vocabulary lands NOW so slice 7 needs no
  // migration — but slice 5 has no code path that sets it.
  it("accepts the RESERVED disposition 'hold' even though slice 5 never emits it", () => {
    expect(
      meterAlertPayloadSchema.safeParse({ ...crossingPayload, disposition: 'hold' }).success,
    ).toBe(true);
    expect(
      meterAlertPayloadSchema.safeParse({ ...crossingPayload, disposition: 'brake' }).success,
    ).toBe(false);
    // The emitter's own type is narrower than the schema: `evaluateMeterAlerts`
    // is proved to emit only 'notify' in meterDerivations.test.ts.
  });

  it('tolerates an omitted scope/resetsAt (a source may supply neither)', () => {
    const minimalPayload = {
      meterId: 'weekly_all',
      thresholdPercent: 90,
      observedPercent: 91,
      kind: 'weekly-cap' as const,
      observedAt: '2026-07-21T12:00:00.000Z',
      disposition: 'notify' as const,
    };
    expect(meterAlertPayloadSchema.safeParse(minimalPayload).success).toBe(true);
  });
});

describe('work_order_amended (S7·1 reserved the shape; S7·2b landed the emitter)', () => {
  // Precedent: `dispatch_refused` was reserved with its type+schema+constructor
  // ahead of any emitter (slice 0 -> emitted slice 6); the meter_alert
  // `disposition: 'hold'` reservation is the same posture. This event followed
  // it — the vocabulary landed in S7·1 with nothing emitting it, and S7·2b spent
  // the reservation: `TaskWriter.amendWorkOrder` is the writer, and it is the
  // one that adds the REQUIRED `amendedBy` below.
  const amendmentPayload = {
    taskId: 'task-aaaa-0001',
    workOrderRev: 1,
    amendedBy: 'human' as const,
    scope: 'add the S7·1 reserved schemas',
    explicitlyOut: ['wiring any consumer'],
    acceptanceCriteria: [{ id: 'crit-1', text: 'typecheck is green' }],
    killCriterion: 'a reserved shape forces a projection default',
  };

  it('constructs on the tasks stream and validates', () => {
    expect(workOrderAmended(amendmentPayload)).toEqual({
      stream: 'tasks',
      type: 'work_order_amended',
      payload: amendmentPayload,
    });
    expect(workOrderAmendedPayloadSchema.safeParse(amendmentPayload).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.workOrderAmended]).toBe(
      workOrderAmendedPayloadSchema,
    );
  });

  it('is registered under the work_order_amended type string', () => {
    expect(EVENT_TYPES.workOrderAmended).toBe('work_order_amended');
  });

  it('tolerates a patch that touches only scope — every PATCH field is optional', () => {
    // `taskId` / `workOrderRev` / `amendedBy` are the envelope, always present;
    // the four work-order fields are the patch, and omitting three of them is the
    // ordinary case (the fold leaves an omitted field untouched).
    const minimalPayload = {
      taskId: 'task-aaaa-0001',
      workOrderRev: 2,
      amendedBy: 'orchestrator' as const,
      scope: 'narrowed scope',
    };
    expect(workOrderAmendedPayloadSchema.safeParse(minimalPayload).success).toBe(true);
  });

  it('rejects a negative workOrderRev', () => {
    expect(
      workOrderAmendedPayloadSchema.safeParse({ ...amendmentPayload, workOrderRev: -1 }).success,
    ).toBe(false);
  });

  it('REFUSES `amendedBy: dispatcher` — the machinery never amends (D53)', () => {
    // The two-value enum, asserted rather than only documented. An amendment is a
    // DECISION; letting the dispatcher author one would put a judgment nobody made
    // in the log, and the whole point of the narrower enum is that the third
    // transition-proposer value is unrepresentable here.
    expect(
      workOrderAmendedPayloadSchema.safeParse({ ...amendmentPayload, amendedBy: 'dispatcher' })
        .success,
    ).toBe(false);
    // ...and it is REQUIRED: an amendment with no author is not recordable.
    const { amendedBy: _omitted, ...authorlessPayload } = amendmentPayload;
    expect(workOrderAmendedPayloadSchema.safeParse(authorlessPayload).success).toBe(false);
  });
});

describe('plan_submitted (S7·5a — RESERVED, payload REUSED from tasks/workOrder.ts)', () => {
  // Precedent: `dispatch_refused` (slice 0 -> emitted slice 6) and
  // `work_order_amended` above are both schema-first reservations with no
  // emitter yet; this follows the same posture (S7·5b is the emitter). The
  // identity assertion below is the point of this describe: `submit_plan`'s
  // tool payload and this event's payload are not merely equal in SHAPE, they
  // are the SAME zod object (D48) — declaring a second, near-identical schema
  // would be the "one source of record per fact" violation principle 9 names.
  const planPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'planning' as const,
    attempt: 1,
    workOrderRev: 0,
    planArtifactHash: 'sha256:deadbeef',
    plannerSessionRef: { appSessionId: 'session-planner-0001' },
  };

  it('constructs on the tasks stream and validates against submitPlanPayloadSchema', () => {
    expect(planSubmitted(planPayload)).toEqual({
      stream: 'tasks',
      type: 'plan_submitted',
      payload: planPayload,
    });
    expect(submitPlanPayloadSchema.safeParse(planPayload).success).toBe(true);
  });

  it('is registered under the plan_submitted type string, IDENTICAL to submitPlanPayloadSchema', () => {
    expect(EVENT_TYPES.planSubmitted).toBe('plan_submitted');
    // Identity (===), not mere schema equivalence — the reuse D48 calls for.
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.planSubmitted]).toBe(submitPlanPayloadSchema);
  });
});

describe('review_reported (S7·6a — RESERVED, payload REUSED from tasks/workOrder.ts)', () => {
  // Mirrors the plan_submitted describe above: schema-first reservation, no emitter
  // yet (S7·6b), and the identity assertion is the point — `report_review`'s tool
  // payload and this event's payload are the SAME zod object (D43), not two shapes.
  const reviewPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'review' as const,
    attempt: 1,
    workOrderRev: 0,
    criteria: [
      { criterionId: 'crit-id-1', verdict: 'pass' as const, note: 'looks good' },
      { criterionId: 'crit-id-2', verdict: 'fail' as const },
    ],
  };

  it('constructs on the tasks stream and validates against reportReviewPayloadSchema', () => {
    expect(reviewReported(reviewPayload)).toEqual({
      stream: 'tasks',
      type: 'review_reported',
      payload: reviewPayload,
    });
    expect(reportReviewPayloadSchema.safeParse(reviewPayload).success).toBe(true);
  });

  it('is registered under the review_reported type string, IDENTICAL to reportReviewPayloadSchema', () => {
    expect(EVENT_TYPES.reviewReported).toBe('review_reported');
    // Identity (===), not mere schema equivalence — the reuse D43 calls for.
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.reviewReported]).toBe(reportReviewPayloadSchema);
  });
});

describe('completion_reported (S7·7b — payload REUSED, folds, emitter in 7b-daemon)', () => {
  // The mirror of review_reported above, for the FIX side. As of S7·7b-core the
  // constructor is real and `projections/tasks.ts` folds it onto
  // `TaskRecord.lastCompletion`; the EMITTER (the `report_completion` tool) is
  // 7b-daemon's, so nothing in the tree calls this constructor yet.
  const completionPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'implementing' as const,
    attempt: 2,
    workOrderRev: 0,
    worklog: {
      decisionsMade: ['used the existing helper'],
      pathsRejected: ['a bespoke parser — too slow'],
    },
  };

  it('constructs on the tasks stream and validates against reportCompletionPayloadSchema', () => {
    expect(completionReported(completionPayload)).toEqual({
      stream: 'tasks',
      type: 'completion_reported',
      payload: completionPayload,
    });
    expect(reportCompletionPayloadSchema.safeParse(completionPayload).success).toBe(true);
  });

  it('is registered under the completion_reported type string, IDENTICAL to reportCompletionPayloadSchema', () => {
    expect(EVENT_TYPES.completionReported).toBe('completion_reported');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.completionReported]).toBe(reportCompletionPayloadSchema);
  });
});

describe('taskCreatedPayloadSchema — the S7·2a work-order widening (OPTIONAL-only, I6)', () => {
  // The base birth payload every case starts from — the pre-slice-7 shape that
  // must keep validating unchanged.
  const baseBirthPayload = {
    taskId: 'task-aaaa-0001',
    projectRoot: '/home/user/projects/vimes',
    createdBy: 'human' as const,
    isolation: 'worktree' as const,
    stage: 'backlog' as const,
  };

  it('accepts a payload carrying all four authored work-order fields', () => {
    // ⚠ `acceptanceCriteria` is the FULL record shape `{id,text}[]` on the EVENT
    // (the writer has already minted the ids and written them in), NOT the
    // `{text}` input shape the API accepts — the two are deliberately different.
    const fullPayload = {
      ...baseBirthPayload,
      scope: 'fold the work-order fields onto the birth record',
      explicitlyOut: ['the amend path (S7·2b)', 'the authoring UI (S7·3)'],
      acceptanceCriteria: [
        { id: 'crit-id-1', text: 'typecheck is green' },
        { id: 'crit-id-2', text: 'both suites pass' },
      ],
      killCriterion: 'a reserved shape forces a projection default',
    };
    const parsed = taskCreatedPayloadSchema.safeParse(fullPayload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('still accepts a payload that omits all four (the pre-slice-7 shape is unchanged)', () => {
    // The load-bearing I6 half at the event layer: an unauthored birth record
    // omits every work-order field and must validate exactly as it did before the
    // widening landed, so old logs replay untouched.
    expect(taskCreatedPayloadSchema.safeParse(baseBirthPayload).success).toBe(true);
  });

  it('rejects an acceptance criterion missing its minted id (the event shape is {id,text})', () => {
    // The event/record criterion shape REQUIRES an id: it is minted server-side
    // and written in, so a payload carrying a bare `{text}` here is malformed at
    // the event layer — the input `{text}` shape lives only at the API boundary.
    const missingId = {
      ...baseBirthPayload,
      acceptanceCriteria: [{ text: 'no id was minted for this one' }],
    };
    expect(taskCreatedPayloadSchema.safeParse(missingId).success).toBe(false);
  });
});
