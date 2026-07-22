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
