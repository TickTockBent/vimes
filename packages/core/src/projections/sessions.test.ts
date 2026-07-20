import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import { EventRouter } from '../router.js';
import type { EventInput } from '../schemas.js';
import { assertAttentionBatchRule } from '../sessionMachine.js';
import {
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
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { sessionsProjection } from './sessions.js';

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
