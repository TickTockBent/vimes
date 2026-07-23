import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import { EventRouter } from '../router.js';
import type { EventInput, EventRecord, SessionRecord } from '../schemas.js';
import { assertAttentionBatchRule } from '../sessionMachine.js';
import {
  EVENT_TYPES,
  attentionCleared,
  billingBucketObserved,
  claudeSessionMapped,
  correctionDelivered,
  correctionQueued,
  gateFired,
  livenessChanged,
  lineQuarantined,
  message,
  notificationTrigger,
  notificationTriggerPayloadSchema,
  questionAsked,
  resyncMarker,
  runCompleted,
  seen,
  sessionAdopted,
  sessionCreated,
  sessionRenamed,
  taskQuarantined,
  transitionRejected,
  ttlTierObserved,
  usageBlock,
  watchdogStale,
  withNotificationTrigger,
} from '../events.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
} from './projection.js';
import { sessionsProjection } from './sessions.js';
import { TRANSCRIPT_APPEND_EVENT_TYPES } from '../tasks/watchdogDecision.js';

const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

function createInput(): EventInput {
  return sessionCreated({
    appSessionId: APP_SESSION_ID,
    channel: 'sdk',
    cwd: '/home/user/project',
    name: 'synthetic session',
    forkedFrom: null,
    taskRef: null,
  });
}

function stateFromLog(batches: EventInput[][]): ReturnType<typeof sessionsProjection.init> {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));
}

describe('sessions projection — session_created', () => {
  it('births a SessionRecord with the documented defaults', () => {
    const state = stateFromLog([[createInput()]]);
    const record = state.sessions[APP_SESSION_ID];
    expect(record).toMatchObject({
      appSessionId: APP_SESSION_ID,
      channel: 'sdk',
      cwd: '/home/user/project',
      claudeSessionIds: [],
      liveness: 'spawning',
      needsAttention: null,
      seenAt: null,
      observedTtlTier: 'unknown',
      observedBillingBucket: 'unknown',
      name: 'synthetic session',
      forkedFrom: null,
      taskRef: null,
    });
    expect(record!.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is total: events for an unknown session are no-ops', () => {
    const state = stateFromLog([[gateFired({ appSessionId: 'ghost', prompt: 'x' })]]);
    expect(state.sessions.ghost).toBeUndefined();
  });

  // E1/D18: provider defaults 'claude-code' when session_created omits it (old
  // logs tolerate); an explicit provider passes through untouched.
  it('defaults provider to claude-code when the session_created payload omits it', () => {
    const state = stateFromLog([[createInput()]]);
    expect(state.sessions[APP_SESSION_ID]!.provider).toBe('claude-code');
  });

  it('carries an explicit provider through unchanged (fresh session_created)', () => {
    const state = stateFromLog([
      [
        sessionCreated({
          appSessionId: APP_SESSION_ID,
          channel: 'sdk',
          cwd: '/p',
          name: null,
          forkedFrom: null,
          taskRef: null,
          provider: 'openai-subscription',
        }),
      ],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.provider).toBe('openai-subscription');
  });
});

// D10 custody: default, adoption flip, rename, resync no-op, old-log tolerance.
describe('sessions projection — custody (D10)', () => {
  it('defaults custody to host when session_created omits it (old logs tolerate)', () => {
    const state = stateFromLog([[createInput()]]);
    expect(state.sessions[APP_SESSION_ID]!.custody).toBe('host');
  });

  it('carries an explicit external custody through (discovery mint)', () => {
    const state = stateFromLog([
      [
        sessionCreated({
          appSessionId: APP_SESSION_ID,
          channel: 'pty',
          cwd: '/p',
          name: null,
          forkedFrom: null,
          taskRef: null,
          custody: 'external',
        }),
      ],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.custody).toBe('external');
  });

  it('session_adopted flips custody external → host (liveness untouched)', () => {
    const state = stateFromLog([
      [
        sessionCreated({
          appSessionId: APP_SESSION_ID,
          channel: 'pty',
          cwd: '/p',
          name: null,
          forkedFrom: null,
          taskRef: null,
          custody: 'external',
        }),
      ],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'interrupted', cause: 'discovered-external' })],
      [sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })],
    ]);
    const record = state.sessions[APP_SESSION_ID]!;
    expect(record.custody).toBe('host');
    expect(record.liveness).toBe('interrupted'); // adoption never touches liveness
  });

  it('session_renamed updates the name (any custody)', () => {
    const state = stateFromLog([
      [createInput()],
      [sessionRenamed({ appSessionId: APP_SESSION_ID, name: 'renamed session' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.name).toBe('renamed session');
  });

  it('resync_marker is a projection no-op (touches no field)', () => {
    const withoutMarker = stateFromLog([[createInput()]]).sessions[APP_SESSION_ID]!;
    const withMarker = stateFromLog([
      [createInput()],
      [resyncMarker({ appSessionId: APP_SESSION_ID, reason: 'pre-adoption-history' })],
    ]).sessions[APP_SESSION_ID]!;
    expect(withMarker).toEqual(withoutMarker);
  });

  it('adopted/renamed for an unknown session are no-ops', () => {
    const state = stateFromLog([
      [sessionAdopted({ appSessionId: 'ghost', via: 'resume' })],
      [sessionRenamed({ appSessionId: 'ghost', name: 'x' })],
    ]);
    expect(state.sessions.ghost).toBeUndefined();
  });
});

describe('sessions projection — I5 attention conservation', () => {
  // (a) Attention is set ONLY by the five setters. Every other event type leaves
  // needsAttention null.
  const nonSetterInputs: Array<[string, EventInput]> = [
    ['liveness_changed', livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'c' })],
    ['transition_rejected', transitionRejected({ appSessionId: APP_SESSION_ID, from: 'dormant', to: 'running', cause: 'c' })],
    ['notification_trigger', notificationTrigger({ appSessionId: APP_SESSION_ID, reason: 'gate' })],
    ['seen', seen({ appSessionId: APP_SESSION_ID })],
    ['attention_cleared', attentionCleared({ appSessionId: APP_SESSION_ID, cause: 'dismissed' })],
    ['claude_session_mapped', claudeSessionMapped({ appSessionId: APP_SESSION_ID, claudeSessionId: 'c1', jsonlPath: '/p' })],
    ['ttl_tier_observed', ttlTierObserved({ appSessionId: APP_SESSION_ID, tier: '1h' })],
    ['billing_bucket_observed', billingBucketObserved({ appSessionId: APP_SESSION_ID, bucket: 'interactive' })],
    ['message', message({ appSessionId: APP_SESSION_ID, role: 'user', content: 'hi' })],
    ['usage_block', usageBlock({ appSessionId: APP_SESSION_ID, usage: { input_tokens: 1 } })],
    ['line_quarantined', lineQuarantined({ appSessionId: APP_SESSION_ID, raw: 'x', reason: 'malformed-json' })],
  ];

  for (const [label, input] of nonSetterInputs) {
    it(`does not set needsAttention on ${label}`, () => {
      const state = stateFromLog([[createInput()], [input]]);
      expect(state.sessions[APP_SESSION_ID]!.needsAttention).toBeNull();
    });
  }

  const setterInputs: Array<[string, EventInput, string]> = [
    ['gate_fired', gateFired({ appSessionId: APP_SESSION_ID, prompt: 'p' }), 'gate'],
    ['question_asked', questionAsked({ appSessionId: APP_SESSION_ID, prompt: 'p' }), 'question'],
    ['run_completed', runCompleted({ appSessionId: APP_SESSION_ID }), 'completed'],
    ['watchdog_stale', watchdogStale({ appSessionId: APP_SESSION_ID }), 'stale'],
    ['task_quarantined', taskQuarantined({ appSessionId: APP_SESSION_ID, taskId: 't1' }), 'quarantined'],
  ];

  for (const [label, input, reason] of setterInputs) {
    it(`${label} sets needsAttention.reason = ${reason}`, () => {
      const state = stateFromLog([[createInput()], withNotificationTrigger(input)]);
      expect(state.sessions[APP_SESSION_ID]!.needsAttention).toMatchObject({ reason });
    });
  }

  // ⚠ ASSERTION 5 (slice 6 step 5b) — THE WIDENED `watchdog_stale` STILL REACHES
  // THE ATTENTION PATH, UNCHANGED. The runner writes four extra evidence fields
  // (taskId / observedSilenceMs / retryNumber / wouldQuarantine), and this
  // projection parses `watchdog_stale` with **`seenPayloadSchema`** — `{
  // appSessionId }` — not a schema of its own. Zod's default object behaviour
  // STRIPS unknown keys rather than rejecting them, so the widened payload folds
  // to exactly the same record. That is verified here rather than assumed,
  // because if it rejected instead, every widened staleness report would fold to
  // NOTHING: no attention, no notification, and a watchdog that writes to a log
  // nobody is told about.
  it('the WIDENED watchdog_stale payload still sets needsAttention.reason = stale', () => {
    const widenedInput = watchdogStale({
      appSessionId: APP_SESSION_ID,
      taskId: 'task-aaaa-0001',
      observedSilenceMs: 1_800_000,
      retryNumber: 2,
      wouldQuarantine: true,
    });
    const widenedState = stateFromLog([[createInput()], withNotificationTrigger(widenedInput)]);
    const narrowState = stateFromLog([
      [createInput()],
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID })),
    ]);
    expect(widenedState.sessions[APP_SESSION_ID]!.needsAttention).toMatchObject({ reason: 'stale' });
    // Byte-identical to the pre-widening fold: the extra fields changed the LOG,
    // and changed nothing at all about the session record.
    expect(sessionsProjection.serialize(widenedState)).toBe(
      sessionsProjection.serialize(narrowState),
    );
    // And the evidence itself survived into the log for the rule-0.1
    // investigation it exists to serve — stripping happens at the FOLD, never at
    // the append.
    expect(widenedInput.payload).toMatchObject({ wouldQuarantine: true, retryNumber: 2 });
  });

  // (c) Reserved reasons (rule 0.5 — schema addition only, no setter emits
  // them yet: 'rate-limited' lands slice 5, 'brake' lands slice 7). A
  // hand-built notification_trigger carrying 'rate-limited' must validate
  // and flow through the projection exactly like any other non-setter event
  // (I5 conservation holds: notification_trigger never itself sets
  // needsAttention, regardless of which reason it carries).
  it('a hand-built notification_trigger with reason "rate-limited" validates and flows through the projection', () => {
    const input = notificationTrigger({ appSessionId: APP_SESSION_ID, reason: 'rate-limited' });
    expect(notificationTriggerPayloadSchema.safeParse(input.payload).success).toBe(true);
    const store = makeStore();
    store.append([createInput()]);
    store.append([input]);
    // Conservation holds: this non-setter event never sets needsAttention...
    const state = replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));
    expect(state.sessions[APP_SESSION_ID]!.needsAttention).toBeNull();
    // ...and the event itself round-trips through the log/projection intact.
    const triggerEvents = readAllStreamsGrouped(store).filter(
      (e) => e.stream === APP_SESSION_ID && e.type === 'notification_trigger',
    );
    expect(triggerEvents).toHaveLength(1);
    expect(triggerEvents[0]!.payload).toMatchObject({ reason: 'rate-limited' });
  });

  // (b) seen sets seenAt and does NOT clear needsAttention.
  it('seen sets seenAt but never clears needsAttention', () => {
    const state = stateFromLog([
      [createInput()],
      withNotificationTrigger(gateFired({ appSessionId: APP_SESSION_ID, prompt: 'p' })),
      [seen({ appSessionId: APP_SESSION_ID })],
    ]);
    const record = state.sessions[APP_SESSION_ID]!;
    expect(record.seenAt).not.toBeNull();
    expect(record.needsAttention).toMatchObject({ reason: 'gate' });
  });

  // (c) Only attention_cleared clears.
  it('only attention_cleared clears needsAttention', () => {
    const state = stateFromLog([
      [createInput()],
      withNotificationTrigger(gateFired({ appSessionId: APP_SESSION_ID, prompt: 'p' })),
      [seen({ appSessionId: APP_SESSION_ID })],
      [attentionCleared({ appSessionId: APP_SESSION_ID, cause: 'gate_answered' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.needsAttention).toBeNull();
  });

  // (e) The batch-rule scan passes on a helper-built log and fails on a
  // hand-built one missing the trigger.
  it('batch-rule scan passes on helper-built log, fails when trigger is missing', () => {
    const helperStore = makeStore();
    helperStore.append([createInput()]);
    helperStore.append(withNotificationTrigger(gateFired({ appSessionId: APP_SESSION_ID, prompt: 'p' })));
    expect(assertAttentionBatchRule(readAllStreamsGrouped(helperStore)).violations).toEqual([]);

    const handStore = makeStore();
    handStore.append([createInput()]);
    handStore.append([gateFired({ appSessionId: APP_SESSION_ID, prompt: 'p' })]); // no trigger
    expect(assertAttentionBatchRule(readAllStreamsGrouped(handStore)).violations).toHaveLength(1);
  });
});

// ─── D34 — the watchdog heartbeat is a fact about a SESSION (step 5b) ────────
//
// Take 1 of this step folded these facts into the TASKS projection from
// SESSION-stream events; that fold is impossible (architecture.md, "Projections
// are STREAM-LOCAL") and D34 moved the facts to the record whose stream already
// owns the events. Every event exercised below is constructed with
// `stream: payload.appSessionId`, so every fold under test is same-stream.
describe('sessions projection — lastAppendAt / staleEpisodes (D34)', () => {
  // Fold a log and hand back the records too, so an assertion can name the ts of
  // the event it expects to have been folded rather than hard-coding a clock step.
  function foldLog(batches: EventInput[][]): {
    state: ReturnType<typeof sessionsProjection.init>;
    records: EventRecord[];
  } {
    const store = makeStore();
    for (const batch of batches) {
      store.append(batch);
    }
    const records = readAllStreamsGrouped(store);
    return { state: replayFromEmpty(sessionsProjection, records), records };
  }

  // ASSERTION 1 — ENUMERATED, NOT SAMPLED. One builder per member of the
  // exported append set, keyed by the event type itself, so the keys can be
  // compared against the set: a tenth append type added to
  // `TRANSCRIPT_APPEND_EVENT_TYPES` reddens the coverage case below rather than
  // slipping through untested.
  const transcriptAppendInputsByEventType: Record<string, EventInput> = {
    [EVENT_TYPES.message]: message({ appSessionId: APP_SESSION_ID, role: 'assistant', content: 'hi' }),
    [EVENT_TYPES.usageBlock]: usageBlock({ appSessionId: APP_SESSION_ID, usage: { input_tokens: 1 } }),
    [EVENT_TYPES.gateFired]: gateFired({ appSessionId: APP_SESSION_ID, prompt: 'approve?' }),
    [EVENT_TYPES.questionAsked]: questionAsked({ appSessionId: APP_SESSION_ID, prompt: 'which?' }),
    [EVENT_TYPES.runCompleted]: runCompleted({ appSessionId: APP_SESSION_ID }),
    [EVENT_TYPES.claudeSessionMapped]: claudeSessionMapped({
      appSessionId: APP_SESSION_ID,
      claudeSessionId: 'c1',
      jsonlPath: '/p1',
    }),
    [EVENT_TYPES.ttlTierObserved]: ttlTierObserved({ appSessionId: APP_SESSION_ID, tier: '1h' }),
    [EVENT_TYPES.billingBucketObserved]: billingBucketObserved({
      appSessionId: APP_SESSION_ID,
      bucket: 'interactive',
    }),
    [EVENT_TYPES.lineQuarantined]: lineQuarantined({
      appSessionId: APP_SESSION_ID,
      raw: 'x',
      reason: 'malformed-json',
    }),
  };

  it('exercises EVERY member of the exported TRANSCRIPT_APPEND_EVENT_TYPES set', () => {
    expect(Object.keys(transcriptAppendInputsByEventType).sort()).toEqual(
      [...TRANSCRIPT_APPEND_EVENT_TYPES].sort(),
    );
  });

  it('every transcript-append builder is constructed on the SESSION stream', () => {
    // The D34 constraint, asserted rather than assumed: a fold in the sessions
    // projection is only legal for events that live on the session's own stream.
    for (const [eventType, input] of Object.entries(transcriptAppendInputsByEventType)) {
      expect(input.stream, `${eventType} must be on the session stream`).toBe(APP_SESSION_ID);
    }
  });

  for (const [eventType, input] of Object.entries(transcriptAppendInputsByEventType)) {
    it(`advances lastAppendAt on ${eventType}`, () => {
      const { state, records } = foldLog([[createInput()], [input]]);
      expect(state.sessions[APP_SESSION_ID]!.lastAppendAt).toBe(records.at(-1)!.ts);
    });
  }

  it('leaves lastAppendAt ABSENT until something is observed (old-shape bytes)', () => {
    // Optional-only widening: a session that has never appended serializes
    // exactly as it did before this field existed.
    const { state } = foldLog([[createInput()]]);
    expect(state.sessions[APP_SESSION_ID]!.lastAppendAt).toBeUndefined();
    expect(sessionsProjection.serialize(state)).not.toContain('lastAppendAt');
  });

  // ASSERTION 2 — daemon-authored bookkeeping NEVER advances the heartbeat.
  // ⚠ The self-defeating bug this holds the line on: if `watchdog_stale`
  // counted, the watchdog's own report would refresh the heartbeat it is
  // judging, and no run could ever escalate past its first episode.
  const daemonAuthoredInputs: Array<[string, EventInput]> = [
    ['watchdog_stale', watchdogStale({ appSessionId: APP_SESSION_ID })],
    ['liveness_changed', livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'spawned' })],
    ['notification_trigger', notificationTrigger({ appSessionId: APP_SESSION_ID, reason: 'stale' })],
    ['seen', seen({ appSessionId: APP_SESSION_ID })],
    ['attention_cleared', attentionCleared({ appSessionId: APP_SESSION_ID, cause: 'dismissed' })],
    ['session_renamed', sessionRenamed({ appSessionId: APP_SESSION_ID, name: 'renamed' })],
    ['session_adopted', sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })],
    ['transition_rejected', transitionRejected({ appSessionId: APP_SESSION_ID, from: 'dormant', to: 'running', cause: 'c' })],
    ['task_quarantined', taskQuarantined({ appSessionId: APP_SESSION_ID, taskId: 't1' })],
    ['resync_marker', resyncMarker({ appSessionId: APP_SESSION_ID, reason: 'pre-adoption-history' })],
  ];

  for (const [label, input] of daemonAuthoredInputs) {
    it(`does NOT advance lastAppendAt on ${label}`, () => {
      const appendInput = message({ appSessionId: APP_SESSION_ID, role: 'assistant', content: 'hi' });
      const { state, records } = foldLog([[createInput()], [appendInput], [input]]);
      // The heartbeat still points at the MESSAGE (record index 1), not at the
      // bookkeeping event that came after it.
      expect(state.sessions[APP_SESSION_ID]!.lastAppendAt).toBe(records[1]!.ts);
      expect(state.sessions[APP_SESSION_ID]!.lastAppendAt).not.toBe(records.at(-1)!.ts);
    });
  }

  it('the three named daemon-authored types are structurally outside the append set', () => {
    // The membership test above is behavioural; this is the structural half, so
    // the exclusion cannot be re-introduced by editing one shared set.
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(EVENT_TYPES.watchdogStale)).toBe(false);
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(EVENT_TYPES.livenessChanged)).toBe(false);
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(EVENT_TYPES.notificationTrigger)).toBe(false);
  });

  // ASSERTION 3 — the episode counter.
  it('staleEpisodes increments once per watchdog_stale, and is ABSENT before the first', () => {
    const { state: beforeAny } = foldLog([[createInput()]]);
    expect(beforeAny.sessions[APP_SESSION_ID]!.staleEpisodes).toBeUndefined();

    const { state } = foldLog([
      [createInput()],
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID, retryNumber: 1 })),
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID, retryNumber: 2 })),
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID, retryNumber: 3 })),
    ]);
    expect(state.sessions[APP_SESSION_ID]!.staleEpisodes).toBe(3);
  });

  it('a watchdog_stale for an unknown session fabricates nothing', () => {
    const { state } = foldLog([[createInput()], [watchdogStale({ appSessionId: 'ghost' })]]);
    expect(state.sessions.ghost).toBeUndefined();
    expect(state.sessions[APP_SESSION_ID]!.staleEpisodes).toBeUndefined();
  });

  it('a transcript append for an unknown session fabricates nothing', () => {
    const { state } = foldLog([
      [createInput()],
      [message({ appSessionId: 'ghost', role: 'assistant', content: 'hi' })],
    ]);
    expect(state.sessions.ghost).toBeUndefined();
  });

  // ASSERTION 4 — old snapshots (written before either field existed) still load
  // and fold forward. Both fields are optional-only widenings precisely so this
  // works: nothing validates a snapshot's records against the schema on load.
  it('an OLD snapshot lacking both fields boots and folds forward', () => {
    const store = makeStore();
    store.append([createInput()]);
    const oldShapeRecord = {
      appSessionId: APP_SESSION_ID,
      channel: 'sdk',
      cwd: '/home/user/project',
      claudeSessionIds: [],
      liveness: 'running',
      needsAttention: null,
      seenAt: null,
      forkedFrom: null,
      taskRef: null,
      observedTtlTier: 'unknown',
      observedBillingBucket: 'unknown',
      name: 'synthetic session',
      createdAt: '2026-01-01T00:00:00.000Z',
      provider: 'claude-code',
      custody: 'host',
      // NOTE: no lastAppendAt, no staleEpisodes — this is the pre-D34 shape.
    } as SessionRecord;
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save({
      projectionId: sessionsProjection.id,
      lastAppliedSeq: { [APP_SESSION_ID]: 1 },
      state: { sessions: { [APP_SESSION_ID]: oldShapeRecord } },
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    // The tail: one real append, then one staleness report.
    store.append([message({ appSessionId: APP_SESSION_ID, role: 'assistant', content: 'hi' })]);
    store.append(withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID })));

    const booted = bootFromSnapshot(sessionsProjection, snapshotStore, store);
    const records = readAllStreamsGrouped(store);
    expect(booted.sessions[APP_SESSION_ID]!.lastAppendAt).toBe(records[1]!.ts);
    expect(booted.sessions[APP_SESSION_ID]!.staleEpisodes).toBe(1);
  });

  it('an OLD snapshot with nothing to fold serializes IDENTICALLY (no field invented)', () => {
    const store = makeStore();
    store.append([createInput()]);
    const oldShapeState = replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save({
      projectionId: sessionsProjection.id,
      lastAppliedSeq: { [APP_SESSION_ID]: 1 },
      state: oldShapeState,
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(sessionsProjection.serialize(bootFromSnapshot(sessionsProjection, snapshotStore, store))).toBe(
      sessionsProjection.serialize(oldShapeState),
    );
  });

  // ASSERTION 6 — purity, and a fold that never throws on hostile input (I8).
  it('never mutates the state it is handed', () => {
    const { state: bornState } = foldLog([[createInput()]]);
    const bornRecord = bornState.sessions[APP_SESSION_ID]!;
    const appendRecord: EventRecord = {
      eventId: '00000000-0000-4000-8000-00000000dead',
      seq: 2,
      stream: APP_SESSION_ID,
      ts: '2026-01-01T00:10:00.000Z',
      type: EVENT_TYPES.message,
      payload: { appSessionId: APP_SESSION_ID, role: 'assistant', content: 'hi' },
    };
    const nextState = sessionsProjection.apply(bornState, appendRecord);
    expect(nextState).not.toBe(bornState);
    expect(nextState.sessions[APP_SESSION_ID]).not.toBe(bornRecord);
    // The ORIGINAL record is untouched — snapshots share references with live state.
    expect(bornRecord.lastAppendAt).toBeUndefined();
    expect(nextState.sessions[APP_SESSION_ID]!.lastAppendAt).toBe('2026-01-01T00:10:00.000Z');
  });

  const malformedPayloads: Array<[string, unknown]> = [
    ['null payload', null],
    ['empty object', {}],
    ['appSessionId of the wrong type', { appSessionId: 42 }],
    ['a bare string', 'not-an-object'],
    ['an array', [1, 2, 3]],
  ];

  for (const [label, payload] of malformedPayloads) {
    it(`leaves state unchanged and never throws on a ${label}`, () => {
      const { state: bornState } = foldLog([[createInput()]]);
      for (const eventType of [EVENT_TYPES.message, EVENT_TYPES.watchdogStale]) {
        const hostileRecord: EventRecord = {
          eventId: '00000000-0000-4000-8000-00000000beef',
          seq: 2,
          stream: APP_SESSION_ID,
          ts: '2026-01-01T00:10:00.000Z',
          type: eventType,
          payload,
        };
        let foldedState: ReturnType<typeof sessionsProjection.init> | null = null;
        expect(() => {
          foldedState = sessionsProjection.apply(bornState, hostileRecord);
        }).not.toThrow();
        expect(sessionsProjection.serialize(foldedState!)).toBe(
          sessionsProjection.serialize(bornState),
        );
      }
    });
  }
});

describe('sessions projection — pendingCorrectionAt (D5/D30, slice 6 step 6a)', () => {
  // ASSERTION 6. Everything here folds through the REAL projection over a real
  // event log; nothing is hand-stubbed.
  function foldLog(batches: EventInput[][]): {
    state: ReturnType<typeof sessionsProjection.init>;
    records: EventRecord[];
  } {
    const store = makeStore();
    for (const batch of batches) {
      store.append(batch);
    }
    const records = readAllStreamsGrouped(store);
    return { state: replayFromEmpty(sessionsProjection, records), records };
  }

  const queuedInput = correctionQueued({
    appSessionId: APP_SESSION_ID,
    text: 'synthetic steer: prefer the smaller change',
  });
  const deliveredInput = correctionDelivered({
    appSessionId: APP_SESSION_ID,
    commandMode: 'prompt',
    originKind: 'human',
    enqueuedAt: '2026-07-13T12:00:09.000Z',
  });

  it('BOTH correction events are constructed on the SESSION stream (D34, stated as a test)', () => {
    // This projection is the one D34 was about, so the same-stream property is
    // ASSERTED rather than asserted-in-a-comment: a fold here is only legal for
    // events that live on the session's own stream.
    expect(queuedInput.stream).toBe(APP_SESSION_ID);
    expect(deliveredInput.stream).toBe(APP_SESSION_ID);
  });

  it('correction_queued sets pendingCorrectionAt to the EVENT ts', () => {
    const { state, records } = foldLog([[createInput()], [queuedInput]]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBe(records.at(-1)!.ts);
  });

  it('correction_delivered CLEARS it to null', () => {
    const { state } = foldLog([[createInput()], [queuedInput], [deliveredInput]]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBeNull();
  });

  it('a second queued correction overwrites the pending timestamp with the newer one', () => {
    const { state, records } = foldLog([
      [createInput()],
      [queuedInput],
      [correctionQueued({ appSessionId: APP_SESSION_ID, text: 'synthetic second steer' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBe(records.at(-1)!.ts);
  });

  it('a delivery with NOTHING pending is a no-op — the field is not even created', () => {
    // ⚠ NOT A CORNER CASE. A human typing straight into a PTY produces a
    // `commandMode:'prompt'` queued_command that VIMES never queued; so does a
    // correction that was in flight across a daemon restart. Neither is an
    // error, and neither may stamp a field onto a record that never had one —
    // the record must serialize exactly as an untouched session does.
    const { state: bornState } = foldLog([[createInput()]]);
    const { state } = foldLog([[createInput()], [deliveredInput]]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBeUndefined();
    expect(sessionsProjection.serialize(state)).toBe(sessionsProjection.serialize(bornState));
    expect(sessionsProjection.serialize(state)).not.toContain('pendingCorrectionAt');
  });

  it('a SECOND delivery after the field is already null is also a no-op', () => {
    const once = foldLog([[createInput()], [queuedInput], [deliveredInput]]);
    const twice = foldLog([[createInput()], [queuedInput], [deliveredInput], [deliveredInput]]);
    expect(sessionsProjection.serialize(twice.state)).toBe(
      sessionsProjection.serialize(once.state),
    );
  });

  it('an UNKNOWN session is ignored by both folds — nothing is fabricated', () => {
    const { state } = foldLog([
      [correctionQueued({ appSessionId: 'never-created-session', text: 'synthetic' })],
      [correctionDelivered({ appSessionId: 'never-created-session', commandMode: 'prompt' })],
    ]);
    expect(state.sessions['never-created-session']).toBeUndefined();
    expect(sessionsProjection.serialize(state)).toBe(
      sessionsProjection.serialize(sessionsProjection.init()),
    );
  });

  it('an OLD snapshot with no pendingCorrectionAt still loads and serializes unchanged', () => {
    // Optional-only widening: a session that has never seen a correction
    // serializes exactly as it did before this field existed.
    const { state } = foldLog([[createInput()], [message({ appSessionId: APP_SESSION_ID, role: 'user', content: 'hi' })]]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBeUndefined();
    expect(sessionsProjection.serialize(state)).not.toContain('pendingCorrectionAt');
  });

  it('neither fold advances lastAppendAt — delivery releases the guard without resetting the clock', () => {
    // ⚠ LOAD-BEARING, and the reason assertion 9's second half is not vacuous.
    // `correction_delivered` is NOT in TRANSCRIPT_APPEND_EVENT_TYPES, so
    // observing a delivery clears the protection WITHOUT making the run look
    // freshly alive. If it advanced the heartbeat, a run that wedged the instant
    // after being steered would silently reset its own silence clock.
    const { state, records } = foldLog([
      [createInput()],
      [message({ appSessionId: APP_SESSION_ID, role: 'assistant', content: 'working' })],
      [queuedInput],
      [deliveredInput],
    ]);
    const heartbeatRecord = records.find((record) => record.type === EVENT_TYPES.message)!;
    expect(state.sessions[APP_SESSION_ID]!.lastAppendAt).toBe(heartbeatRecord.ts);
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(EVENT_TYPES.correctionQueued)).toBe(false);
    expect(TRANSCRIPT_APPEND_EVENT_TYPES.has(EVENT_TYPES.correctionDelivered)).toBe(false);
  });

  it('purity: the input state and its records are never mutated', () => {
    const { state: bornState } = foldLog([[createInput()]]);
    const bornRecord = bornState.sessions[APP_SESSION_ID]!;
    const queuedRecord: EventRecord = {
      eventId: '00000000-0000-4000-8000-00000000cafe',
      seq: 2,
      stream: APP_SESSION_ID,
      ts: '2026-01-01T00:10:00.000Z',
      type: EVENT_TYPES.correctionQueued,
      payload: { appSessionId: APP_SESSION_ID, text: 'synthetic steer' },
    };
    const nextState = sessionsProjection.apply(bornState, queuedRecord);
    expect(nextState).not.toBe(bornState);
    expect(nextState.sessions[APP_SESSION_ID]).not.toBe(bornRecord);
    expect(bornRecord.pendingCorrectionAt).toBeUndefined();
    expect(nextState.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBe('2026-01-01T00:10:00.000Z');
  });

  const malformedCorrectionPayloads: Array<[string, unknown]> = [
    ['null payload', null],
    ['empty object', {}],
    ['appSessionId of the wrong type', { appSessionId: 42, text: 'x' }],
    ['a bare string', 'not-an-object'],
    ['an array', [1, 2, 3]],
    ['correction_queued with no text', { appSessionId: APP_SESSION_ID }],
    ['correction_delivered with no commandMode', { appSessionId: APP_SESSION_ID }],
  ];

  for (const [label, payload] of malformedCorrectionPayloads) {
    it(`a ${label} leaves state unchanged and never throws (I8)`, () => {
      const { state: pendingState } = foldLog([[createInput()], [queuedInput]]);
      for (const eventType of [EVENT_TYPES.correctionQueued, EVENT_TYPES.correctionDelivered]) {
        const hostileRecord: EventRecord = {
          eventId: '00000000-0000-4000-8000-00000000dead',
          seq: 3,
          stream: APP_SESSION_ID,
          ts: '2026-01-01T00:20:00.000Z',
          type: eventType,
          payload,
        };
        let foldedState: ReturnType<typeof sessionsProjection.init> | null = null;
        expect(() => {
          foldedState = sessionsProjection.apply(pendingState, hostileRecord);
        }).not.toThrow();
        expect(sessionsProjection.serialize(foldedState!)).toBe(
          sessionsProjection.serialize(pendingState),
        );
      }
    });
  }
});

// ─── D35 — turnInFlight, and the run_completed clear (slice 6, correction fix) ─
//
// The defect this block pins was measured, not imagined: an operator sent a
// FIRST prompt to a freshly spawned session and the composer said "Correction
// queued" for a correction he had not made, and it never cleared. Both halves
// live here — the bit that says a turn is genuinely running, and the clear that
// covers the correction shape NO tailer can observe (delivered after the turn
// ended: an ordinary user message, no attachment, on any channel).
describe('sessions projection — turnInFlight (D35)', () => {
  function foldLog(batches: EventInput[][]): {
    state: ReturnType<typeof sessionsProjection.init>;
    records: EventRecord[];
  } {
    const store = makeStore();
    for (const batch of batches) {
      store.append(batch);
    }
    const records = readAllStreamsGrouped(store);
    return { state: replayFromEmpty(sessionsProjection, records), records };
  }

  const userTurnInput = message({
    appSessionId: APP_SESSION_ID,
    role: 'user',
    content: 'synthetic opening prompt',
  });
  const queuedInput = correctionQueued({
    appSessionId: APP_SESSION_ID,
    text: 'synthetic steer: prefer the smaller change',
  });

  // ASSERTION 2.
  it('a message event SETS turnInFlight', () => {
    const { state } = foldLog([[createInput()], [userTurnInput]]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });

  it('an assistant message sets it too — both roles mean the run is mid-turn', () => {
    const { state } = foldLog([
      [createInput()],
      [message({ appSessionId: APP_SESSION_ID, role: 'assistant', content: 'working' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });

  // ASSERTION 1 — the field is ABSENT until a message sets it, so a record from
  // before D35 (and a session that has never been prompted) serializes exactly as
  // it did before this field existed.
  it('is ABSENT on a session that has never been prompted (old-shape bytes)', () => {
    const { state } = foldLog([[createInput()]]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBeUndefined();
    expect(sessionsProjection.serialize(state)).not.toContain('turnInFlight');
  });

  it('an OLD snapshot lacking turnInFlight boots, folds forward, and never throws (I8)', () => {
    const store = makeStore();
    store.append([createInput()]);
    const preD35Record = {
      appSessionId: APP_SESSION_ID,
      channel: 'sdk',
      cwd: '/home/user/project',
      claudeSessionIds: [],
      liveness: 'running',
      needsAttention: null,
      seenAt: null,
      forkedFrom: null,
      taskRef: null,
      observedTtlTier: 'unknown',
      observedBillingBucket: 'unknown',
      name: 'synthetic session',
      createdAt: '2026-01-01T00:00:00.000Z',
      provider: 'claude-code',
      custody: 'host',
      lastAppendAt: '2026-01-01T00:00:00.000Z',
      // NOTE: no turnInFlight, no pendingCorrectionAt — this is the pre-D35 shape.
    } as SessionRecord;
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save({
      projectionId: sessionsProjection.id,
      lastAppliedSeq: { [APP_SESSION_ID]: 1 },
      state: { sessions: { [APP_SESSION_ID]: preD35Record } },
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    // The boot itself must not reject the old record...
    let booted: ReturnType<typeof sessionsProjection.init> | null = null;
    expect(() => {
      booted = bootFromSnapshot(sessionsProjection, snapshotStore, store);
    }).not.toThrow();
    expect(booted!.sessions[APP_SESSION_ID]!.turnInFlight).toBeUndefined();

    // ...and the tail must fold onto it normally.
    store.append([userTurnInput]);
    const bootedWithTail = bootFromSnapshot(sessionsProjection, snapshotStore, store);
    expect(bootedWithTail.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });

  // ASSERTION 3 — the turn boundary, and THE load-bearing clear.
  it('run_completed clears turnInFlight AND pendingCorrectionAt', () => {
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      [queuedInput],
      withNotificationTrigger(runCompleted({ appSessionId: APP_SESSION_ID })),
    ]);
    const record = state.sessions[APP_SESSION_ID]!;
    expect(record.turnInFlight).toBe(false);
    expect(record.pendingCorrectionAt).toBeNull();
    // ...and the attention behaviour it already had is untouched.
    expect(record.needsAttention).toMatchObject({ reason: 'completed' });
  });

  it('run_completed clears a correction that was NEVER observed delivered — the whole point', () => {
    // ⚠ THE SHAPE NO TAILER CAN SEE. A correction delivered after the turn ended
    // arrives as an ordinary user message with no attachment, so there is no
    // `correction_delivered` on ANY channel — and on the SDK channel there never
    // is one at all (the transcript is skipped). Without this clear the indicator
    // sticks forever, which is exactly what the operator hit.
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      [queuedInput],
      withNotificationTrigger(runCompleted({ appSessionId: APP_SESSION_ID })),
    ]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBeNull();
    // No delivery was ever observed — the clear came from the turn boundary alone.
    const { records } = foldLog([
      [createInput()],
      [userTurnInput],
      [queuedInput],
      withNotificationTrigger(runCompleted({ appSessionId: APP_SESSION_ID })),
    ]);
    expect(records.some((record) => record.type === EVENT_TYPES.correctionDelivered)).toBe(false);
  });

  // ASSERTION 4 — liveness CLEARS, and never sets.
  const nonLiveTransitions: Array<[string, 'dormant' | 'interrupted' | 'dead']> = [
    ['dormant', 'dormant'],
    ['interrupted', 'interrupted'],
    ['dead', 'dead'],
  ];

  for (const [label, target] of nonLiveTransitions) {
    it(`liveness_changed to ${label} clears turnInFlight`, () => {
      const { state } = foldLog([
        [createInput()],
        [userTurnInput],
        [livenessChanged({ appSessionId: APP_SESSION_ID, to: target, cause: 'synthetic' })],
      ]);
      expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(false);
      expect(state.sessions[APP_SESSION_ID]!.liveness).toBe(target);
    });
  }

  it('liveness_changed {to: running, cause: spawn} does NOT set turnInFlight — THE PHANTOM', () => {
    // ⚠ THE MEASURED DEFECT, PINNED. Session `138d3ef4` was `liveness:'running'`
    // from `liveness_changed{cause:'spawn'}` BEFORE any prompt existed — an SDK
    // session sits in streaming-input mode awaiting its first turn and is
    // `running` throughout. `running` means the PROCESS is alive, not that a turn
    // is in flight, and a gate built on liveness would have emitted the phantom
    // anyway (D35 rejected alternative (a), disproved by this trace).
    const { state } = foldLog([
      [createInput()],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'spawn' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBeUndefined();
    expect(state.sessions[APP_SESSION_ID]!.liveness).toBe('running');
    expect(sessionsProjection.serialize(state)).not.toContain('turnInFlight');
  });

  it('a resume (dormant → spawning) does NOT clear a turn that is still in flight', () => {
    // `spawning` is a live state: a resume in flight has not ended anything.
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'spawning', cause: 'resume' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });

  it('liveness_changed never RE-sets a cleared flag, in either direction', () => {
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'dormant', cause: 'idle' })],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'spawning', cause: 'resume' })],
      [livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'resumed' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(false);
  });

  // ASSERTION 5 — THE REGRESSION GUARD FOR THE SHARED `case` GROUP.
  //
  // `run_completed` shares its case with four other attention setters. Only
  // `run_completed` gained the two clears; the other four must behave EXACTLY as
  // they did before, byte for byte. A fold that gave `watchdog_stale` a
  // correction-clearing side effect would release the watchdog's own protection
  // the instant it reported — and `gate_fired` clearing a steer would drop a
  // correction that is still genuinely queued.
  const otherSettersInTheSharedCase: Array<[string, EventInput, string]> = [
    ['gate_fired', gateFired({ appSessionId: APP_SESSION_ID, prompt: 'approve?' }), 'gate'],
    ['question_asked', questionAsked({ appSessionId: APP_SESSION_ID, prompt: 'which?' }), 'question'],
    ['watchdog_stale', watchdogStale({ appSessionId: APP_SESSION_ID }), 'stale'],
    ['task_quarantined', taskQuarantined({ appSessionId: APP_SESSION_ID, taskId: 't1' }), 'quarantined'],
  ];

  for (const [label, input, reason] of otherSettersInTheSharedCase) {
    it(`${label} still sets attention (${reason}) and clears NEITHER turnInFlight NOR pendingCorrectionAt`, () => {
      const { state, records } = foldLog([
        [createInput()],
        [userTurnInput],
        [queuedInput],
        withNotificationTrigger(input),
      ]);
      const record = state.sessions[APP_SESSION_ID]!;
      expect(record.needsAttention).toMatchObject({ reason });
      // The turn is still running and the steer is still queued.
      expect(record.turnInFlight).toBe(true);
      const queuedRecord = records.find(
        (candidate) => candidate.type === EVENT_TYPES.correctionQueued,
      )!;
      expect(record.pendingCorrectionAt).toBe(queuedRecord.ts);
    });
  }

  it('watchdog_stale still counts its episode, unchanged', () => {
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID })),
      withNotificationTrigger(watchdogStale({ appSessionId: APP_SESSION_ID })),
    ]);
    expect(state.sessions[APP_SESSION_ID]!.staleEpisodes).toBe(2);
  });

  // ASSERTION 6 — the earlier, more precise clear is untouched.
  it('correction_delivered still clears pendingCorrectionAt and does NOT touch turnInFlight', () => {
    const { state } = foldLog([
      [createInput()],
      [userTurnInput],
      [queuedInput],
      [correctionDelivered({ appSessionId: APP_SESSION_ID, commandMode: 'prompt' })],
    ]);
    const record = state.sessions[APP_SESSION_ID]!;
    expect(record.pendingCorrectionAt).toBeNull();
    // Delivery is not the end of the turn — the run is still mid-turn, and D35
    // keeps `correction_delivered` as the earlier clear, not a turn boundary.
    expect(record.turnInFlight).toBe(true);
  });

  it('a delivery with nothing pending is STILL a no-op, and still invents no field', () => {
    const { state: bornState } = foldLog([[createInput()]]);
    const { state } = foldLog([
      [createInput()],
      [correctionDelivered({ appSessionId: APP_SESSION_ID, commandMode: 'prompt' })],
    ]);
    expect(state.sessions[APP_SESSION_ID]!.pendingCorrectionAt).toBeUndefined();
    expect(sessionsProjection.serialize(state)).toBe(sessionsProjection.serialize(bornState));
  });

  // Totality (I8): a malformed `message` payload leaves the record alone rather
  // than stamping a turn onto it.
  const malformedMessagePayloads: Array<[string, unknown]> = [
    ['null payload', null],
    ['empty object', {}],
    ['appSessionId of the wrong type', { appSessionId: 42, role: 'user', content: 'x' }],
    ['a missing role', { appSessionId: APP_SESSION_ID, content: 'x' }],
    ['a bare string', 'not-an-object'],
    ['an array', [1, 2, 3]],
  ];

  for (const [label, payload] of malformedMessagePayloads) {
    it(`a message with ${label} never sets turnInFlight and never throws (I8)`, () => {
      const { state: bornState } = foldLog([[createInput()]]);
      const hostileRecord: EventRecord = {
        eventId: '00000000-0000-4000-8000-0000000f1a17',
        seq: 2,
        stream: APP_SESSION_ID,
        ts: '2026-01-01T00:10:00.000Z',
        type: EVENT_TYPES.message,
        payload,
      };
      let foldedState: ReturnType<typeof sessionsProjection.init> | null = null;
      expect(() => {
        foldedState = sessionsProjection.apply(bornState, hostileRecord);
      }).not.toThrow();
      expect(foldedState!.sessions[APP_SESSION_ID]!.turnInFlight).toBeUndefined();
    });
  }

  it('a message for an unknown session fabricates nothing', () => {
    const { state } = foldLog([
      [createInput()],
      [message({ appSessionId: 'ghost', role: 'user', content: 'hi' })],
    ]);
    expect(state.sessions.ghost).toBeUndefined();
  });

  it('purity: the input state and its records are never mutated', () => {
    const { state: bornState } = foldLog([[createInput()]]);
    const bornRecord = bornState.sessions[APP_SESSION_ID]!;
    const messageRecord: EventRecord = {
      eventId: '00000000-0000-4000-8000-0000000f1a18',
      seq: 2,
      stream: APP_SESSION_ID,
      ts: '2026-01-01T00:10:00.000Z',
      type: EVENT_TYPES.message,
      payload: { appSessionId: APP_SESSION_ID, role: 'user', content: 'hi' },
    };
    const nextState = sessionsProjection.apply(bornState, messageRecord);
    expect(nextState.sessions[APP_SESSION_ID]).not.toBe(bornRecord);
    expect(bornRecord.turnInFlight).toBeUndefined();
    expect(nextState.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });

  // ── adoption clears the turn a MIRRORED session could never end (D35) ──────
  //
  // ⚠ THE GAP THIS CLOSES, MEASURED ON THE LIVE LOG (stream `d85bc8f8`, five
  // such messages). The tailer emits `message` events for an
  // externally-discovered session, so the fold sets `turnInFlight: true` — and
  // nothing can ever clear it: VIMES is not driving that process, so no
  // `run_completed` arrives, and discovery parks its liveness at `interrupted`
  // and leaves it there. Harmless while mirrored (the host refuses every send
  // with `external-custody` before anything is emitted, and a refused send emits
  // nothing) — but `session_adopted` flips custody to 'host' and deliberately
  // leaves liveness alone, so the FIRST send after adoption would read a stale
  // `true` and record a phantom course-correction.
  describe('adoption (D10 + D35)', () => {
    const discoveredInput = sessionCreated({
      appSessionId: APP_SESSION_ID,
      channel: 'pty',
      cwd: '/home/user/project',
      name: null,
      forkedFrom: null,
      taskRef: null,
      custody: 'external',
    });
    const parkedAtInterrupted = livenessChanged({
      appSessionId: APP_SESSION_ID,
      to: 'interrupted',
      cause: 'discovered-external',
    });
    // What the TAILER emits while mirroring someone else's session.
    const mirroredTranscriptMessage = message({
      appSessionId: APP_SESSION_ID,
      role: 'assistant',
      content: 'work VIMES is only watching',
    });

    // ASSERTION 1.
    it('a mirrored session whose tailer messages set turnInFlight has it CLEARED by session_adopted', () => {
      const { state: beforeAdoption } = foldLog([
        [discoveredInput],
        [parkedAtInterrupted],
        [mirroredTranscriptMessage],
      ]);
      // The premise, stated rather than assumed: the mirror really does set it,
      // and nothing in the mirrored log can clear it.
      expect(beforeAdoption.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);

      const { state } = foldLog([
        [discoveredInput],
        [parkedAtInterrupted],
        [mirroredTranscriptMessage],
        [sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })],
      ]);
      expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(false);
    });

    // ASSERTION 2 — the pre-existing behaviour, PINNED, so this clear cannot
    // quietly widen into the liveness axis it must not touch.
    it('session_adopted still flips custody to host and still leaves liveness UNTOUCHED', () => {
      const { state } = foldLog([
        [discoveredInput],
        [parkedAtInterrupted],
        [mirroredTranscriptMessage],
        [sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })],
      ]);
      const record = state.sessions[APP_SESSION_ID]!;
      expect(record.custody).toBe('host');
      // Custody and liveness are SEPARATE AXES (D10). Adoption says who owns the
      // process, never what it is doing.
      expect(record.liveness).toBe('interrupted');
    });

    it('adoption clears to false even on a session that had no turn — unknown resolves to false', () => {
      const { state } = foldLog([
        [discoveredInput],
        [parkedAtInterrupted],
        [sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'resume' })],
      ]);
      expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(false);
    });

    it('a message AFTER adoption sets it truthfully again — the clear is a reset, not a mute', () => {
      const { state } = foldLog([
        [discoveredInput],
        [parkedAtInterrupted],
        [mirroredTranscriptMessage],
        [sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })],
        [message({ appSessionId: APP_SESSION_ID, role: 'user', content: 'now VIMES is driving' })],
      ]);
      expect(state.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
    });

    it('adoption for an unknown session still fabricates nothing', () => {
      const { state } = foldLog([[sessionAdopted({ appSessionId: 'ghost', via: 'explicit' })]]);
      expect(state.sessions.ghost).toBeUndefined();
    });

    // ASSERTION 3 — I6 across the new clear, at every cut point.
    it('I6: boot(snapshot+tail) equals replay-from-empty at EVERY cut across the adoption', () => {
      const store = makeStore();
      store.append([discoveredInput]);
      store.append([parkedAtInterrupted]);
      store.append([mirroredTranscriptMessage]); // ← the mirror sets it
      store.append([sessionAdopted({ appSessionId: APP_SESSION_ID, via: 'explicit' })]); // ← the clear
      store.append([message({ appSessionId: APP_SESSION_ID, role: 'user', content: 'a real turn' })]);

      const records = readAllStreamsGrouped(store);
      const fullReplaySerialized = sessionsProjection.serialize(
        replayFromEmpty(sessionsProjection, records),
      );
      // Non-vacuity: the fixture must actually move the field.
      expect(fullReplaySerialized).toContain('turnInFlight');

      for (let cutPoint = 0; cutPoint <= records.length; cutPoint += 1) {
        const snapshotStore = new MemorySnapshotStore();
        snapshotStore.save({
          projectionId: sessionsProjection.id,
          lastAppliedSeq: cutPoint === 0 ? {} : { [APP_SESSION_ID]: records[cutPoint - 1]!.seq },
          state: replayFromEmpty(sessionsProjection, records.slice(0, cutPoint)),
          savedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(
          sessionsProjection.serialize(bootFromSnapshot(sessionsProjection, snapshotStore, store)),
          `cut ${cutPoint}`,
        ).toBe(fullReplaySerialized);
      }

      // The cut that carries the STALE `true` across the snapshot boundary really
      // does hold it, so the loop above cannot go quietly vacuous.
      const mirroredState = replayFromEmpty(sessionsProjection, records.slice(0, 3));
      expect(mirroredState.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
    });
  });

  // ASSERTION 7 — I6 across the NEW field, with the snapshot cut placed where it
  // matters: INSIDE the turn, so the boot has to carry `turnInFlight: true`
  // across the snapshot boundary and then clear it from the tail. A cut only at
  // the ends would never exercise that.
  it('I6: boot(snapshot+tail) equals replay-from-empty at EVERY cut, including mid-turn', () => {
    const store = makeStore();
    store.append([createInput()]);
    store.append([livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'spawn' })]);
    store.append([userTurnInput]); // ← the set
    store.append([queuedInput]);
    store.append(withNotificationTrigger(runCompleted({ appSessionId: APP_SESSION_ID }))); // ← the clears
    store.append([message({ appSessionId: APP_SESSION_ID, role: 'user', content: 'a second turn' })]);
    store.append([livenessChanged({ appSessionId: APP_SESSION_ID, to: 'dormant', cause: 'idle' })]);

    const records = readAllStreamsGrouped(store);
    const fullReplaySerialized = sessionsProjection.serialize(
      replayFromEmpty(sessionsProjection, records),
    );
    // Non-vacuity: the fixture must actually move the field, or the equivalence
    // below would pass while testing nothing.
    expect(fullReplaySerialized).toContain('turnInFlight');

    // EVERY cut, not three — the mid-turn ones (snapshot holds the `message`
    // that set the flag, tail holds the `run_completed` that clears it) are the
    // ones the shared I6 helper's coarse cut points can miss.
    for (let cutPoint = 0; cutPoint <= records.length; cutPoint += 1) {
      const snapshotStore = new MemorySnapshotStore();
      snapshotStore.save({
        projectionId: sessionsProjection.id,
        lastAppliedSeq: cutPoint === 0 ? {} : { [APP_SESSION_ID]: records[cutPoint - 1]!.seq },
        state: replayFromEmpty(sessionsProjection, records.slice(0, cutPoint)),
        savedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(
        sessionsProjection.serialize(bootFromSnapshot(sessionsProjection, snapshotStore, store)),
        `cut ${cutPoint}`,
      ).toBe(fullReplaySerialized);
    }

    // And the cut that carries the flag ACROSS the snapshot boundary really does
    // hold it — stated so the loop above cannot go quietly vacuous.
    const snapshotInsideTheTurn = replayFromEmpty(sessionsProjection, records.slice(0, 3));
    expect(snapshotInsideTheTurn.sessions[APP_SESSION_ID]!.turnInFlight).toBe(true);
  });
});

describe('sessions projection — I5/I6 restart byte-identity', () => {
  it('live router-subscribed applier equals replay-from-empty, byte-identical', () => {
    const store = makeStore();
    const router = new EventRouter(store);

    let liveState = sessionsProjection.init();
    router.subscribe(APP_SESSION_ID, 0, (event) => {
      liveState = sessionsProjection.apply(liveState, event);
    });

    router.emit([createInput()]);
    router.emit([livenessChanged({ appSessionId: APP_SESSION_ID, to: 'running', cause: 'spawned' })]);
    router.emit(withNotificationTrigger(gateFired({ appSessionId: APP_SESSION_ID, prompt: 'approve?' })));
    router.emit([seen({ appSessionId: APP_SESSION_ID })]);
    router.emit([claudeSessionMapped({ appSessionId: APP_SESSION_ID, claudeSessionId: 'c1', jsonlPath: '/p1' })]);
    router.emit([ttlTierObserved({ appSessionId: APP_SESSION_ID, tier: '1h' })]);
    router.emit([billingBucketObserved({ appSessionId: APP_SESSION_ID, bucket: 'interactive' })]);
    router.emit([attentionCleared({ appSessionId: APP_SESSION_ID, cause: 'gate_answered' })]);
    router.emit([livenessChanged({ appSessionId: APP_SESSION_ID, to: 'dormant', cause: 'idle' })]);

    const liveSerialized = sessionsProjection.serialize(liveState);
    const replayedSerialized = sessionsProjection.serialize(
      replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store)),
    );

    expect(replayedSerialized).toBe(liveSerialized);
  });
});
