import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  EventRouter,
  MemoryEventStore,
  SteppingClock,
  compactionHeld,
  compactionNudgeSent,
  compactionObserved,
  usageBlock,
  type CacheObservabilityState,
  type CompactionStewardConfig,
  type EventRecord,
  type SessionRecord,
  type SessionsState,
} from '@vimes/core';
import { CompactionNudgeLedger, CompactionSteward, type NudgeDeliveryResult } from './compactionSteward.js';

// ─── The daemon half of S8·4 (D57/D64) ───────────────────────────────────────
//
// Every seam is injected: an in-memory store, hand-built projection states, a
// recording `sendMessage`, and a `statNotesMtimeMs` that never touches a disk.
// No daemon is started and no clock is raced.
//
// ⚠ Thresholds here are the TEST's own (Gate-D, rule 0.2). D64 signed the
// mechanism and left ⟨tune⟩ 250k/275k/300k as unpinned design bands, so no
// assertion below may turn one into a pass/fail criterion.
const TEST_CONFIG: CompactionStewardConfig = {
  nudgeThresholds: [
    { level: 1, contextTokens: 100 },
    { level: 2, contextTokens: 200 },
  ],
  holdThresholdTokens: 300,
};

const ORCHESTRATOR_SESSION_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ORDINARY_SESSION_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const PROJECT_ID = 'proj-1';
const NOTES_PATH = `/vimes/orchestrator-notes/${PROJECT_ID}.md`;

function sessionRecord(appSessionId: string, orchestratorForProjectId?: string): SessionRecord {
  return {
    appSessionId,
    channel: 'sdk',
    cwd: '/p',
    liveness: 'running',
    needsAttention: null,
    claudeSessionIds: [],
    forkedFrom: null,
    taskRef: null,
    observedTtlTier: 'unknown',
    observedBillingBucket: 'unknown',
    name: null,
    createdAt: '2026-08-04T09:00:00.000Z',
    provider: 'claude-code',
    custody: 'host',
    seenAt: null,
    ...(orchestratorForProjectId === undefined ? {} : { orchestratorForProjectId }),
  } as SessionRecord;
}

function sessionsWith(...records: SessionRecord[]): SessionsState {
  return {
    sessions: Object.fromEntries(records.map((record) => [record.appSessionId, record])),
  } as SessionsState;
}

function cacheObservabilityWith(
  perSessionTokens: Record<string, number | null>,
): CacheObservabilityState {
  const perSession: CacheObservabilityState['perSession'] = {};
  for (const [appSessionId, total] of Object.entries(perSessionTokens)) {
    perSession[appSessionId] = {
      appSessionId,
      sampleCount: 1,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
      ttlTier: 'none',
      serviceTier: null,
      latestBlockAt: '2026-08-04T09:30:00.000Z',
      // The whole reading is put on `inputTokens` so the test's number IS the
      // summed fill — `sumContextTokens` adds the three input-side counts.
      latestContextTokens:
        total === null ? null : { inputTokens: total, cacheReadTokens: 0, cacheCreationTokens: 0 },
      countedMessageIds: [],
    };
  }
  return { perSession };
}

interface Rig {
  steward: CompactionSteward;
  store: MemoryEventStore;
  router: EventRouter;
  sent: Array<{ appSessionId: string; text: string }>;
  statCalls: string[];
  eventsOn: (appSessionId: string) => EventRecord[];
  setNotesMtime: (mtimeMs: number | null) => void;
  setFill: (appSessionId: string, tokens: number | null) => void;
  setDelivery: (result: NudgeDeliveryResult) => void;
}

function makeRig(
  options: { sessions?: SessionsState; fills?: Record<string, number | null> } = {},
): Rig {
  const clock = new SteppingClock('2026-08-04T10:00:00.000Z', 1000);
  const store = new MemoryEventStore({ clock, ids: new CountingIdSource() });
  const router = new EventRouter(store);

  const sessions =
    options.sessions ??
    sessionsWith(
      sessionRecord(ORCHESTRATOR_SESSION_ID, PROJECT_ID),
      sessionRecord(ORDINARY_SESSION_ID),
    );
  let fills = options.fills ?? { [ORCHESTRATOR_SESSION_ID]: 0 };
  let notesMtimeMs: number | null = null;
  let deliveryResult: NudgeDeliveryResult = { ok: true };
  const sent: Array<{ appSessionId: string; text: string }> = [];
  const statCalls: string[] = [];

  const steward = new CompactionSteward({
    store,
    router,
    emit: (events) => router.emit(events),
    readSessions: () => sessions,
    readCacheObservability: () => cacheObservabilityWith(fills),
    sendMessage: (appSessionId, text) => {
      sent.push({ appSessionId, text });
      return deliveryResult;
    },
    standingNotesPathFor: (projectId) => `/vimes/orchestrator-notes/${projectId}.md`,
    statNotesMtimeMs: (notesPath) => {
      statCalls.push(notesPath);
      return notesMtimeMs;
    },
    config: TEST_CONFIG,
  });

  return {
    steward,
    store,
    router,
    sent,
    statCalls,
    eventsOn: (appSessionId) => store.read(appSessionId, 1),
    setNotesMtime: (mtimeMs) => {
      notesMtimeMs = mtimeMs;
    },
    setFill: (appSessionId, tokens) => {
      fills = { ...fills, [appSessionId]: tokens };
    },
    setDelivery: (result) => {
      deliveryResult = result;
    },
  };
}

function typesOn(records: EventRecord[]): string[] {
  return records.map((record) => record.type);
}

describe('CompactionNudgeLedger — derivable, not stateful', () => {
  it('folds the session\'s own stream into level + first-nudge time', () => {
    const rig = makeRig();
    const ledger = new CompactionNudgeLedger(rig.store);
    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 1, contextTokens: 120 })]);
    const first = ledger.current(ORCHESTRATOR_SESSION_ID);
    expect(first.highestLevelSent).toBe(1);
    expect(first.firstNudgeAtMs).toBe(Date.parse(rig.eventsOn(ORCHESTRATOR_SESSION_ID)[0]!.ts));

    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 2, contextTokens: 220 })]);
    const second = ledger.current(ORCHESTRATOR_SESSION_ID);
    expect(second.highestLevelSent).toBe(2);
    // FIRST wins — the start-of-asking mark does not move.
    expect(second.firstNudgeAtMs).toBe(first.firstNudgeAtMs);
  });

  it('a compaction_observed resets the epoch, and later nudges re-mark it', () => {
    const rig = makeRig();
    const ledger = new CompactionNudgeLedger(rig.store);
    rig.router.emit([
      compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 2, contextTokens: 220 }),
      compactionObserved({ appSessionId: ORCHESTRATOR_SESSION_ID, trigger: 'manual', preTokens: 220 }),
    ]);
    expect(ledger.current(ORCHESTRATOR_SESSION_ID)).toEqual({ highestLevelSent: 0, firstNudgeAtMs: null });

    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 1, contextTokens: 110 })]);
    expect(ledger.current(ORCHESTRATOR_SESSION_ID).highestLevelSent).toBe(1);
  });

  it('resets on a compaction_observed whose METADATA is missing (boundary-is-the-fact)', () => {
    // S8·4a emits the event even when the CLI's metadata is absent or unreadable.
    // Demanding a rich payload here would drop exactly the degraded compactions
    // that still rotated the transcript, leaving the escalation permanently spent.
    const rig = makeRig();
    const ledger = new CompactionNudgeLedger(rig.store);
    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 1, contextTokens: 110 })]);
    rig.router.emit([compactionObserved({ appSessionId: ORCHESTRATOR_SESSION_ID, trigger: 'auto' })]);
    expect(ledger.current(ORCHESTRATOR_SESSION_ID).highestLevelSent).toBe(0);
  });

  it('skips an UNREADABLE nudge payload rather than guessing at it', () => {
    const rig = makeRig();
    const ledger = new CompactionNudgeLedger(rig.store);
    rig.router.emit([
      { stream: ORCHESTRATOR_SESSION_ID, type: EVENT_TYPES.compactionNudgeSent, payload: { nonsense: true } },
    ]);
    expect(ledger.current(ORCHESTRATOR_SESSION_ID)).toEqual({ highestLevelSent: 0, firstNudgeAtMs: null });
  });

  it('is per-session — one orchestrator\'s escalation never suppresses another\'s', () => {
    const rig = makeRig();
    const ledger = new CompactionNudgeLedger(rig.store);
    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 2, contextTokens: 220 })]);
    expect(ledger.current(ORCHESTRATOR_SESSION_ID).highestLevelSent).toBe(2);
    expect(ledger.current(ORDINARY_SESSION_ID).highestLevelSent).toBe(0);
  });

  it('RESUMES the fold rather than restarting it, and re-derives the same answer cold', () => {
    // The bounded-read rule's observable half: a warm ledger that has already
    // folded a prefix must reach the same memory as a cold one folding from seq 1.
    const rig = makeRig();
    const warm = new CompactionNudgeLedger(rig.store);
    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 1, contextTokens: 110 })]);
    warm.current(ORCHESTRATOR_SESSION_ID);
    rig.router.emit([compactionNudgeSent({ appSessionId: ORCHESTRATOR_SESSION_ID, level: 2, contextTokens: 220 })]);
    const warmMemory = warm.current(ORCHESTRATOR_SESSION_ID);
    const coldMemory = new CompactionNudgeLedger(rig.store).current(ORCHESTRATOR_SESSION_ID);
    expect(warmMemory).toEqual(coldMemory);
  });
});

describe('CompactionSteward.evaluateForSession — nudges, and the delivery-before-event rule', () => {
  it('delivers L1 and events it once fill crosses the first rung', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]!.appSessionId).toBe(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent[0]!.text).toContain('about 150 tokens');
    expect(typesOn(rig.eventsOn(ORCHESTRATOR_SESSION_ID))).toEqual([EVENT_TYPES.compactionNudgeSent]);
    expect(rig.eventsOn(ORCHESTRATOR_SESSION_ID)[0]!.payload).toEqual({
      appSessionId: ORCHESTRATOR_SESSION_ID,
      level: 1,
      contextTokens: 150,
    });
  });

  it('does not re-fire the same level on a second evaluation at the same fill', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(1);
  });

  it('climbs to L2 as fill grows, then goes quiet', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    rig.setFill(ORCHESTRATOR_SESSION_ID, 250);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    rig.setFill(ORCHESTRATOR_SESSION_ID, 999);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);

    expect(rig.sent).toHaveLength(2);
    expect(rig.sent[1]!.text).toContain('HOLD the compaction door');
    expect(typesOn(rig.eventsOn(ORCHESTRATOR_SESSION_ID))).toEqual([
      EVENT_TYPES.compactionNudgeSent,
      EVENT_TYPES.compactionNudgeSent,
    ]);
  });

  it('re-arms after a compaction — the fresh transcript climbs from L1 again', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 250);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(2);

    rig.router.emit([compactionObserved({ appSessionId: ORCHESTRATOR_SESSION_ID, trigger: 'auto', preTokens: 250 })]);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(3);
    expect(rig.sent[2]!.text).toContain('heads-up, not an interrupt');
  });

  // ⚠ THE ORDERING RULE, AND WHY IT IS A TEST. The event IS the escalation
  // memory: eventing a nudge that was never delivered burns the level (the
  // orchestrator sails past the threshold having been told nothing) AND arms the
  // door against it (firstNudgeAtMs would be set).
  it('does NOT event a nudge the session refused to receive; the level re-fires later', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.setDelivery({ refused: true, reason: 'session-dead' });
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(1);
    expect(rig.eventsOn(ORCHESTRATOR_SESSION_ID)).toHaveLength(0);

    rig.setDelivery({ ok: true });
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(2);
    expect(typesOn(rig.eventsOn(ORCHESTRATOR_SESSION_ID))).toEqual([EVENT_TYPES.compactionNudgeSent]);
  });

  it('never nudges an ORDINARY session, however full it is', () => {
    const rig = makeRig();
    rig.setFill(ORDINARY_SESSION_ID, 10_000);
    rig.steward.evaluateForSession(ORDINARY_SESSION_ID);
    expect(rig.sent).toHaveLength(0);
    expect(rig.eventsOn(ORDINARY_SESSION_ID)).toHaveLength(0);
  });

  it('never nudges a session that is not in the log at all', () => {
    const rig = makeRig();
    rig.steward.evaluateForSession('cccccccc-0000-4000-8000-00000000000c');
    expect(rig.sent).toHaveLength(0);
  });

  it('nudges nothing when the fill has never been observed', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, null);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.sent).toHaveLength(0);
  });
});

describe('CompactionSteward.decideGate — the PreCompact answer', () => {
  it('HOLDS an unbanked orchestrator past the threshold, and events the hold', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 400);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID); // arm: L1 delivered
    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('hold');

    const heldEvents = rig.eventsOn(ORCHESTRATOR_SESSION_ID).filter((r) => r.type === EVENT_TYPES.compactionHeld);
    expect(heldEvents).toHaveLength(1);
    expect(heldEvents[0]!.payload).toEqual({ appSessionId: ORCHESTRATOR_SESSION_ID, contextTokens: 400 });
    expect(rig.statCalls).toEqual([NOTES_PATH]);
  });

  it('ALLOWS once the notes are written after the first nudge — and events NOTHING', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 400);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    const nudgeAtMs = Date.parse(rig.eventsOn(ORCHESTRATOR_SESSION_ID)[0]!.ts);
    rig.setNotesMtime(nudgeAtMs + 1);

    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('allow');
    // An allow is the universal default and the compaction that follows it is
    // already witnessed by `compaction_observed` — so nothing new is written.
    expect(typesOn(rig.eventsOn(ORCHESTRATOR_SESSION_ID))).toEqual([EVENT_TYPES.compactionNudgeSent]);
  });

  it('ALLOWS an orchestrator that was never nudged, past the threshold or not', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 10_000);
    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('allow');
    expect(rig.eventsOn(ORCHESTRATOR_SESSION_ID)).toHaveLength(0);
  });

  it('ALLOWS an ORDINARY session always — and never even stats a notes file for it', () => {
    const rig = makeRig();
    rig.setFill(ORDINARY_SESSION_ID, 10_000);
    expect(rig.steward.decideGate(ORDINARY_SESSION_ID)).toBe('allow');
    // The fs call is skipped entirely: an ordinary session's compaction must not
    // pay for a stat on the hook's critical path.
    expect(rig.statCalls).toEqual([]);
  });

  it('ALLOWS a session that is not in the log at all (fail open on an unknown id)', () => {
    const rig = makeRig();
    expect(rig.steward.decideGate('cccccccc-0000-4000-8000-00000000000c')).toBe('allow');
  });

  it('ALLOWS when the fill is unobserved, even with a nudge on record', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    rig.setFill(ORCHESTRATOR_SESSION_ID, null);
    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('allow');
  });

  it('re-answers hold on EVERY offer while unbanked — one event per re-offer', () => {
    // The CLI re-offers a blocked compaction on every turn (OBSERVED, SP8·1 Q3d).
    // That cadence is the accepted event volume, and it is what makes the hold
    // terminate the moment the notes land.
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 400);
    rig.steward.evaluateForSession(ORCHESTRATOR_SESSION_ID);
    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('hold');
    expect(rig.steward.decideGate(ORCHESTRATOR_SESSION_ID)).toBe('hold');
    expect(
      rig.eventsOn(ORCHESTRATOR_SESSION_ID).filter((r) => r.type === EVENT_TYPES.compactionHeld),
    ).toHaveLength(2);
  });
});

describe('CompactionSteward.resumeContextForCompactedSession', () => {
  it('points a compacted ORCHESTRATOR at its own standing notes', () => {
    const rig = makeRig();
    const paragraph = rig.steward.resumeContextForCompactedSession(ORCHESTRATOR_SESSION_ID);
    expect(paragraph).not.toBeNull();
    expect(paragraph!).toContain(NOTES_PATH);
    expect(paragraph!).toContain('just compacted');
  });

  it('has NOTHING to say to an ordinary session or an unknown one', () => {
    const rig = makeRig();
    expect(rig.steward.resumeContextForCompactedSession(ORDINARY_SESSION_ID)).toBeNull();
    expect(rig.steward.resumeContextForCompactedSession('cccccccc-0000-4000-8000-00000000000c')).toBeNull();
  });
});

describe('CompactionSteward lifecycle — watch only the orchestrator, evaluate on usage_block', () => {
  it('start() subscribes ORCHESTRATOR streams only', () => {
    const rig = makeRig();
    rig.steward.start();
    expect(rig.steward.watchedStreamCount()).toBe(1);
  });

  it('watch() is idempotent and a no-op for an ordinary or unknown session', () => {
    const rig = makeRig();
    rig.steward.watch(ORCHESTRATOR_SESSION_ID);
    rig.steward.watch(ORCHESTRATOR_SESSION_ID);
    rig.steward.watch(ORDINARY_SESSION_ID);
    rig.steward.watch('cccccccc-0000-4000-8000-00000000000c');
    expect(rig.steward.watchedStreamCount()).toBe(1);
  });

  it('a usage_block append on the watched stream fires an evaluation', () => {
    const rig = makeRig();
    rig.steward.start();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.router.emit([
      usageBlock({ appSessionId: ORCHESTRATOR_SESSION_ID, messageId: 'msg-1', usage: { input_tokens: 150 } }),
    ]);
    expect(rig.sent).toHaveLength(1);
  });

  it('an append that is NOT a usage_block fires nothing', () => {
    const rig = makeRig();
    rig.steward.start();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.router.emit([compactionHeld({ appSessionId: ORCHESTRATOR_SESSION_ID })]);
    expect(rig.sent).toHaveLength(0);
  });

  it('stop() unsubscribes — a later usage_block fires nothing', () => {
    const rig = makeRig();
    rig.steward.start();
    rig.steward.stop();
    expect(rig.steward.watchedStreamCount()).toBe(0);
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.router.emit([
      usageBlock({ appSessionId: ORCHESTRATOR_SESSION_ID, messageId: 'msg-1', usage: { input_tokens: 150 } }),
    ]);
    expect(rig.sent).toHaveLength(0);
  });

  it('start() subscribes at HEAD — a boot never re-nudges history', () => {
    const rig = makeRig();
    rig.setFill(ORCHESTRATOR_SESSION_ID, 150);
    rig.router.emit([
      usageBlock({ appSessionId: ORCHESTRATOR_SESSION_ID, messageId: 'old', usage: { input_tokens: 150 } }),
    ]);
    rig.steward.start();
    expect(rig.sent).toHaveLength(0);
  });
});
