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
  projectCreated,
  projectCreatedPayloadSchema,
  projectUpdated,
  projectUpdatedPayloadSchema,
  projectArchived,
  projectArchivedPayloadSchema,
  projectInitialized,
  projectInitializedPayloadSchema,
  compactionObserved,
  compactionObservedPayloadSchema,
  compactionNudgeSent,
  compactionNudgeSentPayloadSchema,
  compactionHeld,
  compactionHeldPayloadSchema,
  usageBlock,
  messagePayloadSchema,
  NODES_STREAM,
  nodeCreated,
  nodeCreatedPayloadSchema,
  nodeClosed,
  nodeClosedPayloadSchema,
  nodeProvenanceSchema,
  sessionAttachedToNode,
  sessionAttachedToNodePayloadSchema,
} from './events.js';
import { cacheObservabilityProjection } from './projections/cacheObservability.js';
import { replayFromEmpty } from './projections/projection.js';
import { sessionRecordSchema, type EventRecord } from './schemas.js';
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

  // D68: an AskUserQuestion gate carries a structured `questions` array — one
  // single-select and one multiSelect question, each with options. The widened
  // schema accepts it AND still accepts a permission gate that omits it entirely.
  it('constructor + schema accept a payload WITH a questions array (AskUserQuestion)', () => {
    const questions = [
      {
        question: 'Which language?',
        header: 'Language',
        options: [
          { label: 'TypeScript', description: 'Typed superset of JavaScript.' },
          { label: 'JavaScript' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which test tools?',
        options: [{ label: 'Vitest' }, { label: 'Playwright' }],
        multiSelect: true,
      },
    ];
    const input = gateFired({ appSessionId: 'app-1', prompt: 'Which language?', requestId: 'req-1', questions });
    expect((input.payload as { questions: unknown }).questions).toEqual(questions);
    expect(gateFiredPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('schema still accepts a gate WITHOUT questions (permission gate, no regression)', () => {
    const input = gateFired({ appSessionId: 'app-1', prompt: 'run rm?', requestId: 'req-2', toolName: 'Bash' });
    const parsed = gateFiredPayloadSchema.safeParse(input.payload);
    expect(parsed.success).toBe(true);
    expect((input.payload as { questions?: unknown }).questions).toBeUndefined();
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

  it('the registered hook names each map to a constructor emitting the right type', () => {
    // SIX since S8·4 added PreCompact — the compaction door (D64). The ORDER is
    // pinned too: `REGISTERED_HOOK_EVENT_NAMES` is `Object.keys` of the
    // constructor map, and it is what the settings file iterates.
    expect(REGISTERED_HOOK_EVENT_NAMES).toEqual([
      'SessionStart',
      'Stop',
      'StopFailure',
      'PreToolUse',
      'SessionEnd',
      'PreCompact',
    ]);
    const expectedTypes: Record<string, string> = {
      SessionStart: 'hook_session_start',
      Stop: 'hook_stop',
      StopFailure: 'hook_stop_failure',
      PreToolUse: 'hook_pre_tool_use',
      SessionEnd: 'hook_session_end',
      PreCompact: 'hook_pre_compact',
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
  // constructor is real and the instance fold writes it onto
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

// ── S8·1 D42 — the project-registry vocabulary, on its own 'projects' stream ──

describe('project_created (S8·1 — the declared boundary D42 settled)', () => {
  const declarationPayload = {
    projectId: 'project-aaaa-0001',
    root: '/home/user/projects/vimes',
    name: 'VIMES',
    description: 'agent-first remote IDE for Claude Code',
  };

  it('constructs on the projects stream and validates', () => {
    expect(projectCreated(declarationPayload)).toEqual({
      stream: 'projects',
      type: 'project_created',
      payload: declarationPayload,
    });
    expect(projectCreatedPayloadSchema.safeParse(declarationPayload).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.projectCreated]).toBe(projectCreatedPayloadSchema);
  });

  it('is registered under the project_created type string', () => {
    expect(EVENT_TYPES.projectCreated).toBe('project_created');
  });

  it('accepts a birth record with NO name and NO description (absent stays absent)', () => {
    // D42: an unnamed project displays its directory BASENAME, and that fallback
    // is a READ-TIME derivation — never stored. So the minimal birth record is
    // projectId + root, and it must validate on its own.
    const unnamedPayload = { projectId: 'project-aaaa-0002', root: '/home/user/projects/dao-tree' };
    expect(projectCreatedPayloadSchema.safeParse(unnamedPayload).success).toBe(true);
  });

  it('requires both projectId and root — a boundary with no directory is not one', () => {
    const { root: _omittedRoot, ...rootlessPayload } = declarationPayload;
    expect(projectCreatedPayloadSchema.safeParse(rootlessPayload).success).toBe(false);
    const { projectId: _omittedId, ...idlessPayload } = declarationPayload;
    expect(projectCreatedPayloadSchema.safeParse(idlessPayload).success).toBe(false);
  });
});

describe('project_updated (S8·1 — the metadata PATCH, work_order_amended discipline)', () => {
  it('constructs on the projects stream and validates', () => {
    const patchPayload = { projectId: 'project-aaaa-0001', name: 'VIMES (the session host)' };
    expect(projectUpdated(patchPayload)).toEqual({
      stream: 'projects',
      type: 'project_updated',
      payload: patchPayload,
    });
    expect(projectUpdatedPayloadSchema.safeParse(patchPayload).success).toBe(true);
    expect(EVENT_TYPES.projectUpdated).toBe('project_updated');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.projectUpdated]).toBe(projectUpdatedPayloadSchema);
  });

  it('tolerates a patch that touches only the description — both fields are optional', () => {
    // The patch half of the amendment precedent: an update that rewrites only the
    // description omits the name, and the fold leaves the name untouched.
    expect(
      projectUpdatedPayloadSchema.safeParse({
        projectId: 'project-aaaa-0001',
        description: 'a description, and nothing else',
      }).success,
    ).toBe(true);
  });

  it('REFUSES a `root` patch — a different directory is a different project (D42)', () => {
    // The absence of `root` from this payload is the DESIGN, not an oversight, so
    // it is asserted rather than only documented: zod strips unknown keys, so the
    // proof is that a "moved" root does not survive the parse.
    const parsed = projectUpdatedPayloadSchema.safeParse({
      projectId: 'project-aaaa-0001',
      root: '/somewhere/else/entirely',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'root' in parsed.data).toBe(false);
  });
});

describe('project_archived (S8·1 — archive, NOT delete)', () => {
  it('constructs on the projects stream and carries only the projectId', () => {
    const archivalPayload = { projectId: 'project-aaaa-0001' };
    expect(projectArchived(archivalPayload)).toEqual({
      stream: 'projects',
      type: 'project_archived',
      payload: archivalPayload,
    });
    expect(projectArchivedPayloadSchema.safeParse(archivalPayload).success).toBe(true);
    expect(EVENT_TYPES.projectArchived).toBe('project_archived');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.projectArchived]).toBe(projectArchivedPayloadSchema);
  });

  it('requires a projectId', () => {
    expect(projectArchivedPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('project_initialized (S8·1 — RESERVED, rule 0.5, NOTHING EMITS IT)', () => {
  // Precedent: `dispatch_refused` (reserved slice 0 → emitted slice 6),
  // `work_order_amended` (S7·1 → S7·2b) and the `meter_alert` `disposition: 'hold'`
  // reservation. D42 reserves this one for the project ONBOARDING HOOK
  // (`design-directions.md` → "Project onboarding"); the workflow is built when it
  // has a consumer, not before. **PARSE-ONLY: nothing in the tree calls the
  // constructor and `projections/projects.ts` deliberately does not fold it.**
  const initializationPayload = { projectId: 'project-aaaa-0001' };

  it('constructs on the projects stream and validates', () => {
    expect(projectInitialized(initializationPayload)).toEqual({
      stream: 'projects',
      type: 'project_initialized',
      payload: initializationPayload,
    });
    expect(projectInitializedPayloadSchema.safeParse(initializationPayload).success).toBe(true);
  });

  it('is registered in the payload table like its siblings, despite having no emitter', () => {
    // A reserved shape absent from the table is a shape no future consumer can
    // validate against, which defeats the point of reserving it.
    expect(EVENT_TYPES.projectInitialized).toBe('project_initialized');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.projectInitialized]).toBe(
      projectInitializedPayloadSchema,
    );
  });
});

describe('compaction_observed (S8·4a — the witness of an observed `/compact`)', () => {
  // The real numbers OBSERVED at SP8·1 (rule 0.7):
  // scratchpad/sp8-1-evidence/logs/q6-after-compact.jsonl.
  const observedPayload = {
    appSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    trigger: 'manual',
    preTokens: 37645,
    postTokens: 1534,
    durationMs: 16849,
  };

  it('constructs on the SESSION\'s own stream (sibling posture to usage_block)', () => {
    expect(compactionObserved(observedPayload)).toEqual({
      stream: observedPayload.appSessionId,
      type: 'compaction_observed',
      payload: observedPayload,
    });
    expect(compactionObservedPayloadSchema.safeParse(observedPayload).success).toBe(true);
    expect(EVENT_TYPES.compactionObserved).toBe('compaction_observed');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.compactionObserved]).toBe(
      compactionObservedPayloadSchema,
    );
  });

  it('accepts the minimal shape — appSessionId + trigger only (numbers are decoration)', () => {
    expect(
      compactionObservedPayloadSchema.safeParse({
        appSessionId: observedPayload.appSessionId,
        trigger: 'manual',
      }).success,
    ).toBe(true);
  });

  it('requires appSessionId and trigger — a witness with no session or no label is not a fact', () => {
    const { appSessionId: _omittedSession, ...sessionlessPayload } = observedPayload;
    expect(compactionObservedPayloadSchema.safeParse(sessionlessPayload).success).toBe(false);
    const { trigger: _omittedTrigger, ...triggerlessPayload } = observedPayload;
    expect(compactionObservedPayloadSchema.safeParse(triggerlessPayload).success).toBe(false);
  });

  it('trigger is a LOOSE z.string(), not an enum — an unforeseen future trigger still validates', () => {
    // Mirrors correctionDeliveredPayloadSchema.commandMode's reasoning exactly:
    // this records what the CLI reported, not a closed vocabulary VIMES declares.
    expect(
      compactionObservedPayloadSchema.safeParse({
        ...observedPayload,
        trigger: 'a-future-cli-trigger-nobody-has-seen-yet',
      }).success,
    ).toBe(true);
  });

  it('rejects negative or non-integer token/duration counts — evidence, never a fabricated shape', () => {
    expect(
      compactionObservedPayloadSchema.safeParse({ ...observedPayload, preTokens: -1 }).success,
    ).toBe(false);
    expect(
      compactionObservedPayloadSchema.safeParse({ ...observedPayload, postTokens: 1.5 }).success,
    ).toBe(false);
    expect(
      compactionObservedPayloadSchema.safeParse({ ...observedPayload, durationMs: 'seven' }).success,
    ).toBe(false);
  });
});

describe('compaction_nudge_sent (S8·4 — a DELIVERED escalation nudge)', () => {
  const nudgePayload = { appSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', level: 1, contextTokens: 268_000 };

  it("constructs on the SESSION's own stream, beside the compaction it is about", () => {
    expect(compactionNudgeSent(nudgePayload)).toEqual({
      stream: nudgePayload.appSessionId,
      type: 'compaction_nudge_sent',
      payload: nudgePayload,
    });
    expect(EVENT_TYPES.compactionNudgeSent).toBe('compaction_nudge_sent');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.compactionNudgeSent]).toBe(
      compactionNudgeSentPayloadSchema,
    );
  });

  it('requires all three fields — this event IS the escalation memory, so none is decoration', () => {
    // ⚠ Contrast `compaction_observed`, whose numbers ARE decoration (the
    // boundary is the fact). Here the level is what suppression keys on and the
    // fill is the calibration evidence, so a partial record is not a usable one.
    for (const omitted of ['appSessionId', 'level', 'contextTokens'] as const) {
      const { [omitted]: _dropped, ...partial } = nudgePayload;
      expect(compactionNudgeSentPayloadSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('the level is a positive integer; the fill is a nonnegative integer', () => {
    expect(compactionNudgeSentPayloadSchema.safeParse({ ...nudgePayload, level: 0 }).success).toBe(false);
    expect(compactionNudgeSentPayloadSchema.safeParse({ ...nudgePayload, level: 1.5 }).success).toBe(false);
    expect(compactionNudgeSentPayloadSchema.safeParse({ ...nudgePayload, contextTokens: -1 }).success).toBe(false);
    // An observed zero fill is a real (if odd) reading, not a validation error.
    expect(compactionNudgeSentPayloadSchema.safeParse({ ...nudgePayload, contextTokens: 0 }).success).toBe(true);
    // A rung the ladder has not grown yet still validates — the config owns the
    // rungs, not the schema.
    expect(compactionNudgeSentPayloadSchema.safeParse({ ...nudgePayload, level: 7 }).success).toBe(true);
  });
});

describe('compaction_held (S8·4 — the door refused; ALLOWS are deliberately never evented)', () => {
  const heldPayload = { appSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', contextTokens: 310_000 };

  it("constructs on the SESSION's own stream", () => {
    expect(compactionHeld(heldPayload)).toEqual({
      stream: heldPayload.appSessionId,
      type: 'compaction_held',
      payload: heldPayload,
    });
    expect(EVENT_TYPES.compactionHeld).toBe('compaction_held');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.compactionHeld]).toBe(compactionHeldPayloadSchema);
  });

  it('accepts the minimal shape — appSessionId alone (the fill degrades to ABSENT, never 0)', () => {
    expect(compactionHeldPayloadSchema.safeParse({ appSessionId: heldPayload.appSessionId }).success).toBe(true);
    expect(compactionHeld({ appSessionId: heldPayload.appSessionId }).payload).toEqual({
      appSessionId: heldPayload.appSessionId,
    });
  });

  it('rejects a negative or fractional fill', () => {
    expect(compactionHeldPayloadSchema.safeParse({ ...heldPayload, contextTokens: -1 }).success).toBe(false);
    expect(compactionHeldPayloadSchema.safeParse({ ...heldPayload, contextTokens: 1.5 }).success).toBe(false);
  });

  it('there is NO allow event in the vocabulary — allow is the default and is already witnessed', () => {
    // The design statement, made checkable: `compaction_observed` (S8·4a) records
    // the compaction that follows an allow, so an allow event would be a second
    // record of a fact the log already carries, on the hot path of every
    // compaction. If a `compaction_allowed` ever appears, that reasoning has been
    // reversed and it needs a decision record, not a quiet addition.
    expect(Object.values(EVENT_TYPES)).not.toContain('compaction_allowed');
  });
});

describe('S8·4 events and I6 replay — the new vocabulary perturbs NO existing read model', () => {
  // Hand-built records in the store's own shape, so the fold under test is the
  // real one rather than a paraphrase. ⚠ `ts` is passed EXPLICITLY rather than
  // derived from `seq`: `cacheObservability` folds `event.ts` into
  // `latestBlockAt`, so a ts that moved with a record's position would make the
  // two logs differ for a reason that has nothing to do with the new events.
  function record(
    seq: number,
    ts: string,
    input: { stream: string; type: string; payload?: unknown },
  ): EventRecord {
    return { seq, stream: input.stream, type: input.type, payload: input.payload, ts } as EventRecord;
  }

  const appSessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const firstUsageAt = '2026-08-04T10:00:01.000Z';
  const secondUsageAt = '2026-08-04T10:00:09.000Z';
  const firstUsage = usageBlock({
    appSessionId,
    messageId: 'msg-1',
    usage: { input_tokens: 10, cache_read_input_tokens: 250_000 },
  });
  const secondUsage = usageBlock({
    appSessionId,
    messageId: 'msg-2',
    usage: { input_tokens: 20, cache_read_input_tokens: 280_000 },
  });

  it('cacheObservability folds a log WITH the new events byte-identically to one WITHOUT', () => {
    // The I6 discipline for a vocabulary addition: a log that now carries the new
    // events replays to the SAME bytes as one that never saw them — because no
    // projection folds either event. If either ever grows a fold, this test is
    // the one that must be deliberately rewritten rather than quietly relaxed.
    const withoutNewEvents = cacheObservabilityProjection.serialize(
      replayFromEmpty(cacheObservabilityProjection, [
        record(1, firstUsageAt, firstUsage),
        record(2, secondUsageAt, secondUsage),
      ]),
    );
    const withNewEvents = cacheObservabilityProjection.serialize(
      replayFromEmpty(cacheObservabilityProjection, [
        record(1, firstUsageAt, firstUsage),
        record(2, '2026-08-04T10:00:02.000Z', compactionNudgeSent({ appSessionId, level: 1, contextTokens: 250_010 })),
        record(3, '2026-08-04T10:00:03.000Z', compactionHeld({ appSessionId, contextTokens: 250_010 })),
        record(4, secondUsageAt, secondUsage),
      ]),
    );
    expect(withNewEvents).toBe(withoutNewEvents);
  });
});

describe('messagePayloadSchema — the S8·4a isCompactSummary widening (OPTIONAL-only, I6)', () => {
  // The base message payload every case starts from — the pre-S8·4a shape that
  // must keep validating unchanged.
  const baseMessagePayload = {
    appSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    role: 'user',
    content: 'an ordinary turn',
  };

  it('still accepts a payload that omits isCompactSummary (the pre-S8·4a shape is unchanged)', () => {
    // The load-bearing I6 half at the event layer: every `message` event ever
    // written omits this key and must validate exactly as it did before the
    // widening landed, so old logs replay untouched.
    expect(messagePayloadSchema.safeParse(baseMessagePayload).success).toBe(true);
  });

  it('accepts isCompactSummary: true — the transcript compaction-summary record', () => {
    expect(
      messagePayloadSchema.safeParse({ ...baseMessagePayload, isCompactSummary: true }).success,
    ).toBe(true);
  });

  it('rejects isCompactSummary: false — never observed, and the field is a `z.literal(true)`', () => {
    // Absent-stays-absent means the ordinary case OMITS the key; it never
    // carries a literal `false`. A writer that ever sent `false` would be
    // signalling a shape nobody has actually seen at SP8·1.
    expect(
      messagePayloadSchema.safeParse({ ...baseMessagePayload, isCompactSummary: false }).success,
    ).toBe(false);
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

// ── S9·1 — the session-tree vocabulary, on its own 'nodes' stream (E2) ────────
//
// RESERVED (rule 0.5): nothing emits these yet, so what is under test here is
// exactly what a reservation is worth — the SHAPES. Two of them are load-bearing
// design decisions rather than field lists: `provenance` nullable (E2-a's one
// node kind, worktree-ness as a property) and `nodeConfig` reserved as
// null-only (E3-a's (iii) deferred until a real tenant needs it).

describe('node_created (S9·1 — the forest birth record E2-a settled)', () => {
  const rootNodePayload = {
    nodeId: 'node-aaaa-0001',
    parentNodeId: null,
    projectId: 'project-aaaa-0001',
    name: 'vimes',
    provenance: null,
    directory: '/home/user/projects/vimes',
    nodeConfig: null,
  };

  const checkoutProvenance = {
    branch: 'feature/session-tree',
    baseRef: 'main',
    resolvedCommit: '975d22f0c0ffee0000000000000000000000beef',
    path: '/home/user/projects/vimes-worktrees/session-tree',
  };

  it('constructs on the nodes stream and validates', () => {
    expect(nodeCreated(rootNodePayload)).toEqual({
      stream: 'nodes',
      type: 'node_created',
      payload: rootNodePayload,
    });
    expect(NODES_STREAM).toBe('nodes');
    expect(nodeCreatedPayloadSchema.safeParse(rootNodePayload).success).toBe(true);
    expect(EVENT_TYPES.nodeCreated).toBe('node_created');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.nodeCreated]).toBe(nodeCreatedPayloadSchema);
  });

  it('round-trips a PROVENANCE-BEARING create — worktree-ness is a property, not a kind', () => {
    // E2-a: ONE node table. A worktree node is this same shape with `provenance`
    // filled in, which is why there is no parallel `worktree_created` family.
    const worktreeNodePayload = {
      ...rootNodePayload,
      nodeId: 'node-aaaa-0002',
      parentNodeId: 'node-aaaa-0001',
      name: 'session-tree checkout',
      provenance: checkoutProvenance,
      directory: checkoutProvenance.path,
    };
    const parsed = nodeCreatedPayloadSchema.safeParse(worktreeNodePayload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.success && parsed.data.provenance).toEqual(checkoutProvenance);
  });

  it('round-trips a PROVENANCE-NULL create — a group carries no checkout claim', () => {
    const groupNodePayload = {
      ...rootNodePayload,
      nodeId: 'node-aaaa-0003',
      parentNodeId: 'node-aaaa-0001',
      name: 'frontend/checkout',
      provenance: null,
      directory: null, // E3-a: a label-only group scopes nothing
    };
    const parsed = nodeCreatedPayloadSchema.safeParse(groupNodePayload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.success && parsed.data.directory).toBeNull();
  });

  it('REFUSES a partial provenance — a checkout claim names all four facts or none', () => {
    // A provenance missing its resolved commit reads as a checkout while naming
    // nothing checkable: `baseRef` alone goes stale the moment the ref moves.
    const { resolvedCommit: _omittedCommit, ...partialProvenance } = checkoutProvenance;
    expect(
      nodeCreatedPayloadSchema.safeParse({ ...rootNodePayload, provenance: partialProvenance })
        .success,
    ).toBe(false);
    expect(nodeProvenanceSchema.safeParse(checkoutProvenance).success).toBe(true);
    expect(nodeProvenanceSchema.safeParse({ ...checkoutProvenance, branch: '' }).success).toBe(false);
  });

  it('nodeConfig is RESERVED and accepts ONLY null (E3-a, rule 0.5)', () => {
    // The key is reserved so the shape is pinned before (iii) exists; accepting
    // a value would be shipping half of per-node config with no consumer and no
    // semantics. A non-null nodeConfig must not parse.
    expect(nodeCreatedPayloadSchema.safeParse({ ...rootNodePayload, nodeConfig: {} }).success).toBe(
      false,
    );
    expect(
      nodeCreatedPayloadSchema.safeParse({ ...rootNodePayload, nodeConfig: { rules: [] } }).success,
    ).toBe(false);
    expect(nodeCreatedPayloadSchema.safeParse({ ...rootNodePayload, nodeConfig: null }).success).toBe(
      true,
    );
  });

  it('requires nodeId, projectId and name — an unnamed node in no project is not one', () => {
    const { nodeId: _omittedId, ...idlessPayload } = rootNodePayload;
    expect(nodeCreatedPayloadSchema.safeParse(idlessPayload).success).toBe(false);
    const { projectId: _omittedProject, ...projectlessPayload } = rootNodePayload;
    expect(nodeCreatedPayloadSchema.safeParse(projectlessPayload).success).toBe(false);
    expect(nodeCreatedPayloadSchema.safeParse({ ...rootNodePayload, name: '' }).success).toBe(false);
  });
});

describe('node_closed (S9·1 — closure is TREE-state, axis 1 of three)', () => {
  it('constructs on the nodes stream and carries only the nodeId', () => {
    const closurePayload = { nodeId: 'node-aaaa-0001' };
    expect(nodeClosed(closurePayload)).toEqual({
      stream: 'nodes',
      type: 'node_closed',
      payload: closurePayload,
    });
    expect(nodeClosedPayloadSchema.safeParse(closurePayload).success).toBe(true);
    expect(EVENT_TYPES.nodeClosed).toBe('node_closed');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.nodeClosed]).toBe(nodeClosedPayloadSchema);
  });

  it('carries NO kill or removal field — the three axes stay independent (E2)', () => {
    // Axis 2 is kill (process-state), axis 3 is removal (disk-state); both are
    // their own named, explicit acts. zod strips unknown keys, so the proof is
    // that a payload smuggling either does not survive the parse.
    const parsed = nodeClosedPayloadSchema.safeParse({
      nodeId: 'node-aaaa-0001',
      killSessions: true,
      removeWorktree: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'killSessions' in parsed.data).toBe(false);
    expect(parsed.success && 'removeWorktree' in parsed.data).toBe(false);
  });

  it('requires a nodeId', () => {
    expect(nodeClosedPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('session_attached_to_node (S9·1 — one parent per session)', () => {
  it('constructs on the NODES stream, not the session stream', () => {
    // Deliberate: the fact recorded is about the NODE's membership list, and
    // projections/nodes.ts folds only its own stream (D34, stream-local).
    const attachmentPayload = { nodeId: 'node-aaaa-0001', appSessionId: 'app-session-0001' };
    expect(sessionAttachedToNode(attachmentPayload)).toEqual({
      stream: 'nodes',
      type: 'session_attached_to_node',
      payload: attachmentPayload,
    });
    expect(sessionAttachedToNodePayloadSchema.safeParse(attachmentPayload).success).toBe(true);
    expect(EVENT_TYPES.sessionAttachedToNode).toBe('session_attached_to_node');
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.sessionAttachedToNode]).toBe(
      sessionAttachedToNodePayloadSchema,
    );
  });

  it('requires both ends of the link', () => {
    expect(sessionAttachedToNodePayloadSchema.safeParse({ nodeId: 'node-aaaa-0001' }).success).toBe(
      false,
    );
    expect(
      sessionAttachedToNodePayloadSchema.safeParse({ appSessionId: 'app-session-0001' }).success,
    ).toBe(false);
  });
});

describe('the tree vocabulary has NO node_moved (E2 — banned in v1)', () => {
  it('registers exactly three node event types', () => {
    // The absence is the design: moves are banned until someone wants one, and
    // then it is a D-record. A `node_moved` appearing in EVENT_TYPES without one
    // is the drift this assertion exists to catch.
    const nodeEventTypes = Object.values(EVENT_TYPES).filter(
      (eventType) => eventType.startsWith('node_') || eventType === 'session_attached_to_node',
    );
    expect(nodeEventTypes.sort()).toEqual([
      'node_closed',
      'node_created',
      'session_attached_to_node',
    ]);
  });
});
