import {
  EMPTY_COMPACTION_NUDGE_MEMORY,
  EVENT_TYPES,
  V0_COMPACTION_STEWARD_CONFIG,
  compactionHeld,
  compactionNudgeSent,
  compactionNudgeSentPayloadSchema,
  composeCompactionNudge,
  composeCompactionResumeContext,
  decideCompactionGate,
  evaluateCompactionNudge,
  rememberCompactionNudge,
  sumContextTokens,
  type CacheObservabilityState,
  type CompactionGateDecision,
  type CompactionNudgeMemory,
  type CompactionStewardConfig,
  type EventInput,
  type EventRouter,
  type EventStore,
  type SessionRecord,
  type SessionsState,
} from '@vimes/core';

// ─── The compaction steward at the daemon boundary (S8·4, D57/D64) ───────────
//
// The pure half lives in `@vimes/core`'s `orchestrator/compactionSteward.ts`:
// edge-triggered escalation, the door's truth table, and the words for both. This
// module supplies that policy with facts from the world — the fill (a core
// projection folded here), the escalation memory (folded from the event log), the
// standing-notes mtime (real fs) — and turns its answers into events plus one
// injected turn each.
//
// Its architecture is `meterAlerts.ts`'s, deliberately and line for line: a
// ledger that is DERIVABLE-NOT-STATEFUL, an evaluation that reads that ledger
// BEFORE emitting, and a daemon module that owns none of the deciding. The one
// structural difference is scope — a meter belongs to no session, while every
// fact here is about ONE session's transcript, so the ledger is keyed per
// session and folds that session's own stream.

// ─── the escalation memory, rebuilt from the log ─────────────────────────────
//
// DERIVABLE, NOT STATEFUL. One session's memory is exactly
// `fold(rememberCompactionNudge)` over the `compaction_nudge_sent` and
// `compaction_observed` events on that session's stream. A daemon restart
// therefore re-derives the same escalation state it had, and cannot re-send a
// level the orchestrator already received — nor forget that a compaction reset
// the epoch.
//
// ─── THE BOUNDED-READ RULE (inherited verbatim from meterAlerts.ts) ──────────
// The step-4a finding: *absence of evidence of a reset was read as evidence of a
// reset*, because running off the end of a bounded buffer looked identical to a
// rollover. The identical trap exists here: if this fold ever ran off the end of
// a bounded read — a query LIMIT, a snapshot horizon, a "last N events" window —
// the missing `compaction_nudge_sent` records would look like nudges that never
// fired, and every one of them would re-fire at the orchestrator.
//
// So this fold is structurally incapable of running off an end:
//   * it starts at seq 1 (the true beginning of the stream), never at a snapshot
//     mark and never at head;
//   * `EventStore.read(stream, fromSeq)` has NO limit — it returns every record
//     from `fromSeq` to head;
//   * it advances the per-session mark only past records it actually folded, so a
//     later call resumes exactly where the previous one stopped.
// If a bounded read is ever introduced here, the correct degradation is to keep
// the PREVIOUS memory and STAY SUPPRESSED — never to treat the unread span as
// "nothing was sent".
export class CompactionNudgeLedger {
  private readonly store: EventStore;
  private readonly memoryBySession = new Map<string, CompactionNudgeMemory>();
  // Per session: the next sequence on that session's stream this ledger has not
  // folded yet. Streams are 1-based (the store assigns head+1), so 1 IS the
  // beginning.
  private readonly nextSeqToFoldBySession = new Map<string, number>();

  constructor(store: EventStore) {
    this.store = store;
  }

  /**
   * One session's escalation memory as of the current head of its stream. Folds
   * anything appended since the last call, then returns the memory.
   */
  current(appSessionId: string): CompactionNudgeMemory {
    let memory = this.memoryBySession.get(appSessionId) ?? EMPTY_COMPACTION_NUDGE_MEMORY;
    let nextSeqToFold = this.nextSeqToFoldBySession.get(appSessionId) ?? 1;
    for (const record of this.store.read(appSessionId, nextSeqToFold)) {
      if (record.seq >= nextSeqToFold) {
        nextSeqToFold = record.seq + 1;
      }
      if (record.type === EVENT_TYPES.compactionObserved) {
        // The epoch reset. Note it is folded WITHOUT validating the payload: the
        // fact being read is "a compaction happened on this stream", which the
        // event's TYPE already asserts. S8·4a emits the event even when the CLI's
        // metadata is missing or malformed (boundary-is-the-fact), so demanding a
        // parseable payload here would drop exactly the degraded compactions that
        // still rotated the transcript.
        memory = rememberCompactionNudge(memory, { kind: 'compaction-observed' });
        continue;
      }
      if (record.type !== EVENT_TYPES.compactionNudgeSent) {
        continue;
      }
      const parsedPayload = compactionNudgeSentPayloadSchema.safeParse(record.payload);
      if (!parsedPayload.success) {
        // An unreadable nudge event is skipped, not guessed at — the same posture
        // MeterAlertLedger takes. It cannot re-arm anything by being skipped; it
        // simply is not in the memory, which is the LOUD direction here (a missed
        // nudge record means a level re-fires), which is why the payload is also
        // validated at emit time.
        continue;
      }
      const atMs = Date.parse(record.ts);
      memory = rememberCompactionNudge(memory, {
        kind: 'nudge-sent',
        level: parsedPayload.data.level,
        // The EVENT's own ts (I6 — deterministic under replay), never a clock
        // read. An unparseable ts contributes no start-of-asking mark rather than
        // a NaN one: `decideCompactionGate` fails open on a non-finite mark, so
        // the degradation is an open door, not a stuck one.
        atMs: Number.isFinite(atMs) ? atMs : Number.NaN,
      });
    }
    this.memoryBySession.set(appSessionId, memory);
    this.nextSeqToFoldBySession.set(appSessionId, nextSeqToFold);
    return memory;
  }
}

// ─── the steward ─────────────────────────────────────────────────────────────

export type NudgeDeliveryResult = { ok: true } | { refused: true; reason: string };

export interface CompactionStewardDeps {
  store: EventStore;
  // Per-stream subscription source (the PushPipeline precedent). Optional: a
  // composition that only wants the DOOR (the two answer paths) can leave it out
  // and drive `evaluateForSession` itself — which is exactly what the tests do.
  router?: EventRouter;
  // Emit sink for the two S8·4 events. In production this is `router.emit`.
  emit: (events: EventInput[]) => void;
  readSessions: () => SessionsState;
  readCacheObservability: () => CacheObservabilityState;
  // The existing host send op — never a second delivery path (the same line
  // `orchestratorApi`'s composition draws for its own briefing turns).
  sendMessage: (appSessionId: string, text: string) => NudgeDeliveryResult;
  // `<vimesHome>/orchestrator-notes/<projectId>.md` — the daemon's own helper,
  // injected so this module never re-derives a path that already has one owner.
  standingNotesPathFor: (projectId: string) => string;
  // The fs boundary (rule 0.3): last-modified time of a notes file in epoch
  // millis, or null. Injected so tests never touch a real disk.
  statNotesMtimeMs: (notesPath: string) => number | null;
  // ⟨tune⟩ v0 unless a caller says otherwise. NOT pinned (Gate-D, D64).
  config?: CompactionStewardConfig;
}

/**
 * The daemon half of D64's mechanism: nudge early so the door rarely has to hold.
 *
 * Every method is safe to call for ANY session id — a session that is not an
 * orchestrator, or is not in the log at all, evaluates to "nothing to do" and
 * answers `allow`.
 */
export class CompactionSteward {
  private readonly deps: CompactionStewardDeps;
  private readonly ledger: CompactionNudgeLedger;
  private readonly config: CompactionStewardConfig;
  // One unsubscribe per WATCHED orchestrator stream (watch() is a no-op for a
  // stream already watched, and for a session that is not an orchestrator).
  private readonly unsubscribeByStream = new Map<string, () => void>();

  constructor(deps: CompactionStewardDeps) {
    this.deps = deps;
    this.ledger = new CompactionNudgeLedger(deps.store);
    this.config = deps.config ?? V0_COMPACTION_STEWARD_CONFIG;
  }

  // ── the evaluation trigger (PushPipeline's lifecycle shape) ────────────────
  //
  // Subscribe to every ORCHESTRATOR session stream already in the log; new ones
  // arrive via watch() off the host's onSessionCreated callback. Subscribing at
  // current head means a boot never re-evaluates history — and it does not need
  // to, because the ledger re-derives the escalation memory from seq 1 anyway.
  start(): void {
    for (const appSessionId of Object.keys(this.deps.readSessions().sessions)) {
      this.watch(appSessionId);
    }
  }

  /**
   * Register a per-stream subscription for one session, from that stream's
   * current head. Idempotent, and a NO-OP for a session that is not the standing
   * orchestrator.
   *
   * ⚠ **THE ORCHESTRATOR CHECK IS DONE HERE, ONCE PER SESSION — not per event.**
   * `readSessions()` folds the log, so asking it on every `usage_block` of every
   * session in the lab would put a projection replay on the hot path of ordinary
   * turns. It is sound to cache the answer this way because
   * `orchestratorForProjectId` is written ONLY by `session_created` (see
   * projections/sessions.ts) — a session's orchestrator-ness is fixed at birth and
   * can never change afterwards.
   */
  watch(appSessionId: string): void {
    if (this.deps.router === undefined || this.unsubscribeByStream.has(appSessionId)) {
      return;
    }
    const session = this.deps.readSessions().sessions[appSessionId];
    if (session === undefined || !isOrchestratorSession(session)) {
      return;
    }
    const head = this.deps.store.head(appSessionId);
    const unsubscribe = this.deps.router.subscribe(appSessionId, head, (record) => {
      // `usage_block` is the ONLY event that moves `latestContextTokens`, so it is
      // the only one worth an evaluation. Fill is therefore known BETWEEN turns
      // and never during one (OBSERVED, SP8·1 Q7) — a nudge cannot pre-empt a
      // single turn that balloons the context on its own, and this design accepts
      // that rather than pretending otherwise.
      if (record.type === EVENT_TYPES.usageBlock) {
        this.evaluateForSession(appSessionId);
      }
    });
    this.unsubscribeByStream.set(appSessionId, unsubscribe);
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribeByStream.values()) {
      unsubscribe();
    }
    this.unsubscribeByStream.clear();
  }

  watchedStreamCount(): number {
    return this.unsubscribeByStream.size;
  }

  /**
   * Evaluate one orchestrator session's fill and deliver a nudge if a rung fired.
   *
   * ⚠ **THE EVENT FOLLOWS THE DELIVERY, NEVER PRECEDES IT.** `compaction_nudge_sent`
   * IS the escalation memory — the ledger folds it, and a recorded level never
   * fires again this epoch. So it is emitted only after `sendMessage` ACCEPTED
   * the turn. Emitting first would burn the level on a session that never
   * received the words: the orchestrator would sail past the threshold having
   * been told nothing, and (worse) the door would then be armed against it, since
   * `firstNudgeAtMs` would be set. Refusing to event a refused send means the
   * next evaluation simply re-fires the same level, which is the correct
   * behavior and costs one more evaluation.
   */
  evaluateForSession(appSessionId: string): void {
    const session = this.deps.readSessions().sessions[appSessionId];
    if (session === undefined || !isOrchestratorSession(session)) {
      return;
    }
    const contextTokens = this.contextTokensFor(appSessionId);
    const fired = evaluateCompactionNudge({
      contextTokens,
      config: this.config,
      // Read BEFORE anything is emitted, so this evaluation sees exactly the
      // history that existed at the crossing (the meterAlerts ordering).
      memory: this.ledger.current(appSessionId),
    });
    if (fired === null || contextTokens === null) {
      return;
    }
    const delivery = this.deps.sendMessage(appSessionId, composeCompactionNudge(fired.level, contextTokens));
    if (!('ok' in delivery)) {
      return;
    }
    this.deps.emit([
      compactionNudgeSent({
        appSessionId,
        level: fired.level,
        // Truncated because the schema wants an integer; summed token counts are
        // integers already, so this only guards the seam.
        contextTokens: Math.trunc(contextTokens),
      }),
    ]);
  }

  /**
   * Answer one PreCompact hook — the whole content of the `hold`/`allow` body the
   * relay turns into an exit code.
   *
   * Emits `compaction_held` on a hold, and NOTHING on an allow: an allow is the
   * universal default, and the compaction that follows it is already witnessed by
   * S8·4a's `compaction_observed` (see the event's own schema note).
   */
  decideGate(appSessionId: string): CompactionGateDecision {
    const session = this.deps.readSessions().sessions[appSessionId];
    const projectId = session?.orchestratorForProjectId;
    const isOrchestrator = session !== undefined && isOrchestratorSession(session);
    const contextTokens = this.contextTokensFor(appSessionId);
    const decision = decideCompactionGate({
      isOrchestrator,
      contextTokens,
      // Only stat'd for a session that could possibly hold — an ordinary session's
      // compaction must not cost a filesystem call on the hook's critical path.
      notesMtimeMs:
        isOrchestrator && projectId !== undefined ? this.notesMtimeFor(projectId) : null,
      firstNudgeAtMs: isOrchestrator ? this.ledger.current(appSessionId).firstNudgeAtMs : null,
      holdThresholdTokens: this.config.holdThresholdTokens,
    });
    if (decision === 'hold') {
      this.deps.emit([
        compactionHeld(
          // Absent rather than 0 when unknown (pillar 4) — though a hold always
          // has a fill in practice, since an unknown fill answers `allow`.
          contextTokens === null
            ? { appSessionId }
            : { appSessionId, contextTokens: Math.trunc(contextTokens) },
        ),
      ]);
    }
    return decision;
  }

  /**
   * The `additionalContext` paragraph for a `SessionStart` hook whose source is
   * `"compact"` — null for every other session and every other source.
   *
   * This is the ONLY way banked state gets re-pointed-at after a compaction:
   * PreCompact itself cannot inject context (its `hookSpecificOutput` variant is
   * rejected by the CLI's own schema, OBSERVED SP8·1 Q3b(i)), so the pointer has
   * to ride the hook that fires on the FAR side of the boundary.
   */
  resumeContextForCompactedSession(appSessionId: string): string | null {
    const session = this.deps.readSessions().sessions[appSessionId];
    if (session === undefined || !isOrchestratorSession(session)) {
      return null;
    }
    const projectId = session.orchestratorForProjectId;
    if (projectId === undefined) {
      return null;
    }
    return composeCompactionResumeContext(this.deps.standingNotesPathFor(projectId));
  }

  // The observed fill for one session, off the cache-observability projection —
  // the same number the UI's vitals strip shows. Null when unobserved.
  private contextTokensFor(appSessionId: string): number | null {
    return sumContextTokens(
      this.deps.readCacheObservability().perSession[appSessionId]?.latestContextTokens,
    );
  }

  // The notes mtime, or null. EVERY failure degrades to null (the seam's
  // contract) — which the gate reads as "no evidence of banking", the same as a
  // file that was never written. See `decideCompactionGate`'s note on why that is
  // the one degraded-looking input that does not fail open.
  private notesMtimeFor(projectId: string): number | null {
    return this.deps.statNotesMtimeMs(this.deps.standingNotesPathFor(projectId));
  }
}

// The orchestrator marker, read the way every other reader reads it (S8·5's
// `isOrchestratorSession` draws the same line in the UI): only a well-typed
// NON-EMPTY string marks a session as an orchestrator. Here the fail direction is
// the opposite of the UI's, and correctly so — the UI fails open to VISIBLE,
// while an unrecognizable marker here means "an ordinary session", i.e. never
// nudged and never gated.
function isOrchestratorSession(session: SessionRecord): boolean {
  const projectId = session.orchestratorForProjectId;
  return typeof projectId === 'string' && projectId.length > 0;
}
