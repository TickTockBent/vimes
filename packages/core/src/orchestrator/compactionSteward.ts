// ─── D57/D64 — the transcript lifecycle's POLICY (pure, packages/core) ───────
//
// Capture-then-compact, made operational. Two mechanisms, one policy module:
//
//   • **The daemon nudges early.** As the orchestrator's context fills, escalating
//     turns are injected asking it to bank its state into its standing notes at
//     the next good boundary. The orchestrator keeps D57's DELAY AGENCY — it may
//     finish landing something first.
//   • **The hook holds the door.** Past a firmer threshold, and only while the
//     notes are still untouched, the PreCompact hook vetoes the compaction so the
//     capture can happen before the summary replaces the transcript.
//
// Everything here is pure and deterministic (rule 0.3): no clock, no fs, no
// randomness. The daemon reads the fill (cacheObservability's
// `latestContextTokens`), stats the notes file, folds the nudge memory out of the
// event log, and passes all of it in as DATA. The composers are golden-tested,
// like `founding.ts` next door.
//
// ⚠ The PROSE constants below are UNWRAPPED on purpose — each paragraph is one
// long source line (no mid-sentence `\n`), because template literals preserve
// hard wraps verbatim into the delivered turn. Same rule as founding.ts and
// stageInstruction.ts; do not re-wrap them for tidiness.

// ── the ⟨tune⟩ configuration ─────────────────────────────────────────────────

export interface CompactionNudgeThreshold {
  // The escalation step. 1-based and ASCENDING with `contextTokens`: the ladder's
  // rungs are climbed in level order, and the level is what the memory records.
  readonly level: number;
  // The fill (summed input-side `latestContextTokens`) at or past which this rung
  // fires.
  readonly contextTokens: number;
}

export interface CompactionStewardConfig {
  // The escalation ladder, ascending by level.
  readonly nudgeThresholds: readonly CompactionNudgeThreshold[];
  // The fill at or past which the compaction DOOR may hold — and only while the
  // state is still unbanked (see `decideCompactionGate`).
  readonly holdThresholdTokens: number;
}

/**
 * ⟨tune⟩ **v0 — DESIGN BANDS, NOT PINNED NUMBERS.**
 *
 * D57 recorded Wes's lived bands from months of driving the CLI orchestrator
 * (keep fill generally below ~40%, up to ~60% when rolling hot; a compaction
 * threshold around 250–300k tokens) *with their assumption*: the CLI workflow,
 * one orchestrator, heavy tool traffic. D64 signed the MECHANISM and explicitly
 * did NOT pin these numbers — Gate-D (rule 0.2) says calibrate against real
 * orchestrator sessions, sign off, and only then pin.
 *
 * So: no test in this repo may assert these VALUES as a pass/fail criterion. The
 * policy tests below drive the pure functions with their OWN thresholds, exactly
 * as `evaluateMeterAlerts` takes its crossing levels from the caller. This
 * constant exists so the daemon has a defensible default to run with today, and
 * so the calibration pass has one place to change when the numbers are earned.
 *
 * The calibration evidence is already being written: every
 * `compaction_nudge_sent` carries the fill that fired it, and S8·4a's
 * `compaction_observed` carries the CLI's own `preTokens` at every real
 * compaction — observed truth (rule 0.7), not a declared model→window table.
 */
export const V0_COMPACTION_STEWARD_CONFIG: CompactionStewardConfig = {
  nudgeThresholds: [
    { level: 1, contextTokens: 250_000 },
    { level: 2, contextTokens: 275_000 },
  ],
  holdThresholdTokens: 300_000,
};

// ── the fill reading ─────────────────────────────────────────────────────────

/**
 * The observed context occupancy this whole policy is driven by: the input-side
 * tokens of the MOST RECENTLY OBSERVED usage block (input + cacheRead +
 * cacheCreation), off `CacheObservabilityRecord.latestContextTokens`. Output is
 * excluded upstream — generated text is not resident context.
 *
 * Null when nothing has been observed: no usage block yet, or a record from a
 * daemon that predates the field. **NEVER a fabricated 0** (pillar 4) — but a
 * genuinely observed zero-token block returns 0, because "observed empty" and
 * "unobserved" are different facts and must not collapse.
 *
 * ⚠ `packages/ui/src/lib/contextFill.ts` computes this same sum for the vitals
 * strip. It is the SAME derivation and belongs here (principle 9, one rule); the
 * UI copy is deliberately left alone by S8·4, whose scope is core + daemon only.
 * Collapse it onto this the next time that file is touched.
 */
export function sumContextTokens(
  latestContextTokens:
    | { readonly inputTokens: number; readonly cacheReadTokens: number; readonly cacheCreationTokens: number }
    | null
    | undefined,
): number | null {
  if (latestContextTokens === null || latestContextTokens === undefined) {
    return null;
  }
  return (
    latestContextTokens.inputTokens +
    latestContextTokens.cacheReadTokens +
    latestContextTokens.cacheCreationTokens
  );
}

// ── the escalation memory (folded from the log, never held as state) ─────────

/**
 * What ONE orchestrator session has already been told, within the CURRENT
 * transcript epoch.
 *
 * "Epoch" is the load-bearing word. A compaction REPLACES the transcript with a
 * summary, so the session on the other side of the boundary has a nearly empty
 * context and a fresh climb ahead of it — the escalation must start over. That
 * reset is modelled as part of THIS FOLD (a `compaction_observed` clears the
 * memory) rather than as elapsed wall time, so it stays derivable from the log
 * and deterministic under replay (rule 0.3, I6).
 */
export interface CompactionNudgeMemory {
  // The highest escalation level already DELIVERED this epoch. 0 = nothing sent.
  // Highest rather than a set: the ladder only climbs, and a level at or below
  // this one is a level the orchestrator has already been told about.
  readonly highestLevelSent: number;
  // When the FIRST nudge of this epoch was delivered (epoch millis, taken from
  // the event's own `ts` — never a clock read). This is the gate's "has the
  // orchestrator touched its notes SINCE we started asking" reference point.
  // Null when nothing has been sent this epoch.
  readonly firstNudgeAtMs: number | null;
}

export const EMPTY_COMPACTION_NUDGE_MEMORY: CompactionNudgeMemory = {
  highestLevelSent: 0,
  firstNudgeAtMs: null,
};

/**
 * One folded log record, in the two shapes this memory cares about. The daemon's
 * ledger reads the session's stream and maps each relevant record to one of
 * these; a test folds the same shapes by hand and gets the same answer, which is
 * the point (the `rememberMeterAlert` posture: core owns the folding RULE, the
 * daemon owns the reading).
 */
export type CompactionMemoryEntry =
  | {
      readonly kind: 'nudge-sent';
      readonly level: number;
      // The event's own `ts` as epoch millis.
      readonly atMs: number;
    }
  // A compaction was OBSERVED for this session (S8·4a's witness) — the transcript
  // rotated, so the escalation re-arms from the bottom.
  | { readonly kind: 'compaction-observed' };

/**
 * Fold one entry into an escalation memory, returning a new memory.
 *
 * Mirrors `rememberMeterAlert`: the daemon rebuilds its memory from the event log
 * rather than keeping it, and this function exists so the log's implied folding
 * rule and every test's folding rule are THE SAME rule rather than two that can
 * drift.
 */
export function rememberCompactionNudge(
  memory: CompactionNudgeMemory,
  entry: CompactionMemoryEntry,
): CompactionNudgeMemory {
  if (entry.kind === 'compaction-observed') {
    // EPOCH RESET. Unconditional and total: the transcript this escalation was
    // about no longer exists, so both the level and the "since when have we been
    // asking" reference go with it.
    return EMPTY_COMPACTION_NUDGE_MEMORY;
  }
  // A level is only ever CLIMBED. An out-of-order or duplicate record (a replay
  // artefact, a level re-emitted) can never walk the memory back down and re-arm
  // a nudge the orchestrator has already received.
  const highestLevelSent = Math.max(memory.highestLevelSent, entry.level);
  // FIRST wins — this is the epoch's start-of-asking mark, not its latest.
  const firstNudgeAtMs = memory.firstNudgeAtMs ?? entry.atMs;
  return { highestLevelSent, firstNudgeAtMs };
}

// ── the nudge decision (edge-triggered) ──────────────────────────────────────

export interface CompactionNudgeInput {
  // The summed input-side `latestContextTokens` for this session, or null when no
  // usage block has been observed yet. UNKNOWN NEVER BECOMES 0: a fill we cannot
  // read is not a fill of zero, and it fires nothing.
  readonly contextTokens: number | null;
  readonly config: CompactionStewardConfig;
  readonly memory: CompactionNudgeMemory;
}

/**
 * Which escalation rung — if any — should fire right now.
 *
 * EDGE-TRIGGERED, exactly like `evaluateMeterAlerts`: the suppression lives
 * entirely in the caller-supplied memory, so re-evaluating at an unchanged fill
 * returns null and a level never repeats.
 *
 * ⚠ **THE LOWEST un-sent crossed level, not the highest** — the deliberate
 * OPPOSITE of `evaluateMeterAlerts`'s multi-threshold choice, and for a reason
 * that is specific to this mechanism. A meter alert is a NOTIFICATION racing a
 * deadline, so collapsing 70→92 into one buzz at 90 is mercy. A compaction nudge
 * is a CONVERSATIONAL ESCALATION: L2 says "the door will hold", and saying that
 * to an orchestrator that was never asked gently first is a threat out of
 * nowhere. Fill arrives per-turn (SP8·1 Q7), so the next turn carries L2 anyway —
 * the ladder is climbed, never skipped, at a cost of one turn.
 */
export function evaluateCompactionNudge(input: CompactionNudgeInput): { level: number } | null {
  const { contextTokens, config, memory } = input;
  if (contextTokens === null || !Number.isFinite(contextTokens)) {
    return null;
  }
  let lowestUnsentCrossedLevel: number | null = null;
  for (const threshold of config.nudgeThresholds) {
    if (!Number.isFinite(threshold.contextTokens)) {
      continue;
    }
    if (contextTokens < threshold.contextTokens) {
      continue;
    }
    if (threshold.level <= memory.highestLevelSent) {
      continue;
    }
    if (lowestUnsentCrossedLevel === null || threshold.level < lowestUnsentCrossedLevel) {
      lowestUnsentCrossedLevel = threshold.level;
    }
  }
  return lowestUnsentCrossedLevel === null ? null : { level: lowestUnsentCrossedLevel };
}

// ── the door (the PreCompact answer) ─────────────────────────────────────────

export type CompactionGateDecision = 'allow' | 'hold';

export interface CompactionGateInput {
  // Only the standing orchestrator's transcript is worth holding a door for. Every
  // ordinary session compacts freely.
  readonly isOrchestrator: boolean;
  // Summed input-side `latestContextTokens`, or null when unknown.
  readonly contextTokens: number | null;
  // Last-modified time of this project's standing-notes file (epoch millis), or
  // null when the file does not exist or could not be stat'd.
  readonly notesMtimeMs: number | null;
  // When this epoch's first nudge was delivered (epoch millis), or null when none
  // has been.
  readonly firstNudgeAtMs: number | null;
  readonly holdThresholdTokens: number;
}

/**
 * Answer one PreCompact hook: may this compaction proceed?
 *
 * `hold` requires ALL FOUR of: this is the orchestrator, the fill is at or past
 * the hold threshold, we have already asked it to capture, and the notes have NOT
 * been touched since we started asking. Anything else allows.
 *
 * ⚠⚠ **THE DOOR FAILS OPEN, BY DESIGN — every degraded DECISION input answers
 * `allow`.** No fill reading, no nudge history, an unusable threshold, a session
 * we cannot identify: all of them allow. This is not defensive slop, it is the
 * decision:
 *
 *   • A veto is an OPTIMIZATION for a healthy system. It buys a lossless
 *     compaction by making the capture happen first. What it costs when it
 *     misfires is a wedged orchestrator whose context can never be compacted —
 *     the CLI re-offers the compaction every turn (OBSERVED, SP8·1 Q3d) and every
 *     one of them is refused, forever, by a daemon that has lost the ability to
 *     tell that it should stop refusing.
 *   • A lossy summary is RECOVERABLE. The standing notes and the board survive it
 *     (D56 — the transcript is a rotating vessel around durable state), and
 *     S8·4a's `compaction_observed` witnesses the boundary either way, so a
 *     compaction we allowed and should not have is visible in the log afterwards.
 *   • D64's whole point is that the nudges make the veto RARE. A door that holds
 *     only when it is certain is exactly the door that design asks for.
 *
 * So: uncertainty opens the door. Refusing on a fact we do not have would be
 * asserting one we do not have.
 *
 * ⚠ **THE ONE EXCEPTION, and it is not an exception to the rule above:** an
 * ABSENT `notesMtimeMs` HOLDS. It looks degraded and is not — "there is no notes
 * file" is positive evidence of exactly the state this door exists for, a
 * transcript that has never banked anything. Allowing on it would make the
 * mechanism inert for a first-epoch orchestrator, i.e. for precisely the case
 * D57 was written about. Uncertainty lives in the DECISION inputs (fill, nudge
 * history); the notes stat answers a question about the world.
 */
export function decideCompactionGate(input: CompactionGateInput): CompactionGateDecision {
  if (!input.isOrchestrator) {
    // Ordinary sessions are never gated (S8·4 explicitly-out). Their compactions
    // are their own business and VIMES only witnesses them.
    return 'allow';
  }
  const { contextTokens, holdThresholdTokens } = input;
  if (contextTokens === null || !Number.isFinite(contextTokens)) {
    // Fill unknown — see the fail-open rationale above. Never treat unknown as
    // "must be huge" (nor as 0; it is simply not a number we have).
    return 'allow';
  }
  if (!Number.isFinite(holdThresholdTokens) || contextTokens < holdThresholdTokens) {
    return 'allow';
  }
  const { firstNudgeAtMs } = input;
  if (firstNudgeAtMs === null || !Number.isFinite(firstNudgeAtMs)) {
    // Never asked, so never refuse. Holding a door on an orchestrator that was
    // given no chance to capture is a veto with no way out of it — the nudge is
    // what makes the hold terminate.
    return 'allow';
  }
  const { notesMtimeMs } = input;
  if (notesMtimeMs !== null && Number.isFinite(notesMtimeMs) && notesMtimeMs >= firstNudgeAtMs) {
    // BANKED. The notes were written at or after we started asking, so whatever
    // the summary drops has already been captured — which is precisely the state
    // capture-then-compact exists to reach. Open the door.
    return 'allow';
  }
  return 'hold';
}

// ── the words ────────────────────────────────────────────────────────────────

// Thousands-separated, ASCII, LOCALE-FREE. `toLocaleString` would make the
// composed turn depend on the daemon process's environment, which is exactly the
// nondeterminism rule 0.3 forbids and a golden test would catch only on the
// machine that happens to differ.
function formatTokenCount(tokenCount: number): string {
  const wholeTokens = Math.trunc(tokenCount);
  return `${wholeTokens}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// L1 — the GENTLE rung. States the fact, names the action, and hands back the
// timing. D57's delay agency is the whole content of the last sentence: an
// orchestrator interrupted mid-landing is the failure this design is avoiding,
// not a compliance problem.
function composeGentleNudge(contextTokensText: string): string {
  return `Context check: this transcript is now carrying about ${contextTokensText} tokens, which crosses the capture band. At your next good boundary — not mid-edit, not mid-verification — run a precompaction capture: flush anything that currently lives only in this conversation into your standing notes file, so a compaction would cost you nothing.

Finishing what you are landing first is fine and expected. This is a heads-up, not an interrupt.`;
}

// L2 — the FIRM rung. Same ask, less room, and it names the door: the contract
// D64 fixes for this level is that the orchestrator is TOLD the veto exists
// before it ever experiences one. A hold that arrives unannounced reads as a
// malfunction; a hold that was promised reads as the system working.
function composeFirmNudge(contextTokensText: string): string {
  return `Context is getting tight: about ${contextTokensText} tokens. Capture soon — flush the conversation-only state into your standing notes file now rather than at the next natural break.

Until those notes are updated, VIMES will HOLD the compaction door for you: a compaction attempted before you have banked will be refused, and offered again on the following turn. That hold exists to protect your state, and it lifts the moment you write the notes.`;
}

/**
 * The turn injected into the orchestrator's session for one escalation rung.
 *
 * Voice: operator-to-orchestrator, honest about agency (D57). The LEVEL MEANINGS
 * are the fixed contract — L1 gentle-with-delay-permission, L2 firm-and-names-the
 * -door — while the exact wording is pinned by the golden tests and free to be
 * improved there.
 *
 * ⚠ An unrecognized (higher) level composes the FIRM text, never the gentle one.
 * The ladder can grow a rung in config without this composer changing, and the
 * safe direction for an unforeseen rung is the one that understates nothing: a
 * fill past L2's threshold that spoke gently would be actively misleading.
 */
export function composeCompactionNudge(level: number, contextTokens: number): string {
  const contextTokensText = formatTokenCount(contextTokens);
  return level <= 1 ? composeGentleNudge(contextTokensText) : composeFirmNudge(contextTokensText);
}

/**
 * The paragraph handed back to a session that has just been compacted, via the
 * `SessionStart` hook's `additionalContext` (source `"compact"`, OBSERVED to fire
 * at SP8·1).
 *
 * ⚠ THIS IS THE ONLY CHANNEL. PreCompact itself CANNOT inject context — the CLI's
 * hook-output schema rejects `hookSpecificOutput.hookEventName: "PreCompact"`
 * outright (OBSERVED, SP8·1 Q3b(i)) — so the banked state has to be re-read on
 * the far side of the boundary. This paragraph is the pointer that makes that
 * happen; the notes file itself is the payload.
 *
 * One paragraph, deliberately: it is prepended to a session that has just had its
 * transcript replaced by a summary, and it competes for attention with that
 * summary. Say the one thing the summary cannot.
 */
export function composeCompactionResumeContext(notesPath: string): string {
  return `Your transcript was just compacted — what you can see above is a summary, not the conversation. Before continuing, re-read your standing notes at ${notesPath}: they are the durable record of decisions, in-flight work and project knowledge that the summary may have thinned out. Trust the notes over the summary wherever the two disagree.`;
}
