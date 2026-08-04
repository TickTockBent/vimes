import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMPACTION_NUDGE_MEMORY,
  V0_COMPACTION_STEWARD_CONFIG,
  composeCompactionNudge,
  composeCompactionResumeContext,
  decideCompactionGate,
  evaluateCompactionNudge,
  rememberCompactionNudge,
  sumContextTokens,
  type CompactionMemoryEntry,
  type CompactionNudgeMemory,
  type CompactionStewardConfig,
} from './compactionSteward.js';

// ⚠ THE THRESHOLDS BELOW ARE THE TEST'S OWN, NOT THE ⟨tune⟩ CONFIG'S (Gate-D,
// rule 0.2). D64 signed the MECHANISM and explicitly left the numbers as design
// bands, so no assertion here may turn 250_000 / 275_000 / 300_000 into a
// pass/fail criterion. Round numbers, chosen for readability, exercising the
// same shape the real config has — exactly how `evaluateMeterAlerts`'s tests
// supply their own crossing levels.
const TEST_CONFIG: CompactionStewardConfig = {
  nudgeThresholds: [
    { level: 1, contextTokens: 100 },
    { level: 2, contextTokens: 200 },
  ],
  holdThresholdTokens: 300,
};

function foldEntries(entries: readonly CompactionMemoryEntry[]): CompactionNudgeMemory {
  return entries.reduce(rememberCompactionNudge, EMPTY_COMPACTION_NUDGE_MEMORY);
}

describe('V0_COMPACTION_STEWARD_CONFIG (⟨tune⟩ — SHAPE only, never the values)', () => {
  it('is an ascending ladder whose rungs all sit below the hold threshold', () => {
    // The STRUCTURAL invariants the policy depends on, asserted without pinning
    // any number: levels ascend, fills ascend with them, and the door's threshold
    // is past the last rung (a door that could hold before the orchestrator was
    // ever nudged would be a hold with no way out — see decideCompactionGate).
    const rungs = V0_COMPACTION_STEWARD_CONFIG.nudgeThresholds;
    expect(rungs.length).toBeGreaterThan(0);
    for (let index = 1; index < rungs.length; index += 1) {
      expect(rungs[index]!.level).toBeGreaterThan(rungs[index - 1]!.level);
      expect(rungs[index]!.contextTokens).toBeGreaterThan(rungs[index - 1]!.contextTokens);
    }
    const highestRungFill = rungs[rungs.length - 1]!.contextTokens;
    expect(V0_COMPACTION_STEWARD_CONFIG.holdThresholdTokens).toBeGreaterThanOrEqual(highestRungFill);
  });
});

describe('sumContextTokens — the observed fill this whole policy runs on', () => {
  it('sums the three input-side counts, exactly as the UI vitals strip does', () => {
    expect(
      sumContextTokens({ inputTokens: 12, cacheReadTokens: 200_000, cacheCreationTokens: 5_000 }),
    ).toBe(205_012);
  });

  it('UNOBSERVED is null — never a fabricated 0 (pillar 4)', () => {
    expect(sumContextTokens(null)).toBeNull();
    expect(sumContextTokens(undefined)).toBeNull();
  });

  it('an OBSERVED zero is 0, not null — the two facts must not collapse', () => {
    expect(sumContextTokens({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });
});

describe('rememberCompactionNudge — the escalation memory, folded from the log', () => {
  it('starts empty: nothing sent, no start-of-asking mark', () => {
    expect(EMPTY_COMPACTION_NUDGE_MEMORY).toEqual({ highestLevelSent: 0, firstNudgeAtMs: null });
  });

  it('records the level and the FIRST nudge time; a later nudge does not move the mark', () => {
    const memory = foldEntries([
      { kind: 'nudge-sent', level: 1, atMs: 1_000 },
      { kind: 'nudge-sent', level: 2, atMs: 5_000 },
    ]);
    expect(memory).toEqual({ highestLevelSent: 2, firstNudgeAtMs: 1_000 });
  });

  it('only ever climbs — an out-of-order or duplicate record cannot re-arm a sent level', () => {
    const memory = foldEntries([
      { kind: 'nudge-sent', level: 2, atMs: 5_000 },
      { kind: 'nudge-sent', level: 1, atMs: 1_000 },
    ]);
    expect(memory.highestLevelSent).toBe(2);
  });

  it('a compaction_observed RESETS the epoch — a fresh transcript starts a fresh climb', () => {
    const memory = foldEntries([
      { kind: 'nudge-sent', level: 1, atMs: 1_000 },
      { kind: 'nudge-sent', level: 2, atMs: 5_000 },
      { kind: 'compaction-observed' },
    ]);
    expect(memory).toEqual(EMPTY_COMPACTION_NUDGE_MEMORY);
  });

  it('re-arms after the reset: L1 fires again on the far side of a compaction', () => {
    const beforeReset = foldEntries([{ kind: 'nudge-sent', level: 1, atMs: 1_000 }]);
    expect(
      evaluateCompactionNudge({ contextTokens: 150, config: TEST_CONFIG, memory: beforeReset }),
    ).toBeNull();
    const afterReset = rememberCompactionNudge(beforeReset, { kind: 'compaction-observed' });
    expect(
      evaluateCompactionNudge({ contextTokens: 150, config: TEST_CONFIG, memory: afterReset }),
    ).toEqual({ level: 1 });
  });

  it('never mutates the memory it is handed', () => {
    const original: CompactionNudgeMemory = { highestLevelSent: 1, firstNudgeAtMs: 1_000 };
    rememberCompactionNudge(original, { kind: 'nudge-sent', level: 2, atMs: 9_000 });
    rememberCompactionNudge(original, { kind: 'compaction-observed' });
    expect(original).toEqual({ highestLevelSent: 1, firstNudgeAtMs: 1_000 });
  });
});

describe('evaluateCompactionNudge — edge-triggered escalation', () => {
  it('fires nothing below the first rung', () => {
    expect(
      evaluateCompactionNudge({
        contextTokens: 99,
        config: TEST_CONFIG,
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toBeNull();
  });

  it('fires L1 exactly AT the rung (the threshold is inclusive)', () => {
    expect(
      evaluateCompactionNudge({
        contextTokens: 100,
        config: TEST_CONFIG,
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toEqual({ level: 1 });
  });

  it('re-evaluating at the SAME fill after L1 fires nothing — the edge, not the level', () => {
    const memory = foldEntries([{ kind: 'nudge-sent', level: 1, atMs: 1_000 }]);
    expect(evaluateCompactionNudge({ contextTokens: 100, config: TEST_CONFIG, memory })).toBeNull();
    expect(evaluateCompactionNudge({ contextTokens: 150, config: TEST_CONFIG, memory })).toBeNull();
  });

  it('fires L2 once fill crosses the second rung and L1 is already sent', () => {
    const memory = foldEntries([{ kind: 'nudge-sent', level: 1, atMs: 1_000 }]);
    expect(evaluateCompactionNudge({ contextTokens: 200, config: TEST_CONFIG, memory })).toEqual({
      level: 2,
    });
  });

  it('never repeats a level, and never walks back down to a lower one', () => {
    const memory = foldEntries([
      { kind: 'nudge-sent', level: 1, atMs: 1_000 },
      { kind: 'nudge-sent', level: 2, atMs: 2_000 },
    ]);
    expect(evaluateCompactionNudge({ contextTokens: 999, config: TEST_CONFIG, memory })).toBeNull();
    // Fill falling back below L2 does not re-arm L1 either: the memory is the
    // only suppression, and it only climbs.
    expect(evaluateCompactionNudge({ contextTokens: 100, config: TEST_CONFIG, memory })).toBeNull();
  });

  it('a jump PAST both rungs still fires L1 first — the ladder is climbed, never skipped', () => {
    // ⚠ The deliberate OPPOSITE of evaluateMeterAlerts's highest-crossed choice.
    // L2 names the door; announcing the door to an orchestrator that was never
    // asked gently is a threat out of nowhere. Fill arrives per turn, so L2
    // follows on the next evaluation.
    const firstFire = evaluateCompactionNudge({
      contextTokens: 5_000,
      config: TEST_CONFIG,
      memory: EMPTY_COMPACTION_NUDGE_MEMORY,
    });
    expect(firstFire).toEqual({ level: 1 });
    const afterFirst = rememberCompactionNudge(EMPTY_COMPACTION_NUDGE_MEMORY, {
      kind: 'nudge-sent',
      level: 1,
      atMs: 1_000,
    });
    expect(
      evaluateCompactionNudge({ contextTokens: 5_000, config: TEST_CONFIG, memory: afterFirst }),
    ).toEqual({ level: 2 });
  });

  it('an UNKNOWN fill fires nothing — unknown never collapses into a number', () => {
    expect(
      evaluateCompactionNudge({
        contextTokens: null,
        config: TEST_CONFIG,
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toBeNull();
    expect(
      evaluateCompactionNudge({
        contextTokens: Number.NaN,
        config: TEST_CONFIG,
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toBeNull();
  });

  it('an empty ladder fires nothing (alerting off, the meter-alerts disable posture)', () => {
    expect(
      evaluateCompactionNudge({
        contextTokens: 10_000,
        config: { nudgeThresholds: [], holdThresholdTokens: 300 },
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toBeNull();
  });

  it('skips a rung whose configured fill is not a finite number', () => {
    expect(
      evaluateCompactionNudge({
        contextTokens: 10_000,
        config: {
          nudgeThresholds: [{ level: 1, contextTokens: Number.NaN }],
          holdThresholdTokens: 300,
        },
        memory: EMPTY_COMPACTION_NUDGE_MEMORY,
      }),
    ).toBeNull();
  });
});

describe('decideCompactionGate — the door, and every way it FAILS OPEN', () => {
  // The one and only combination that holds: the orchestrator, past the hold
  // threshold, already nudged, notes untouched since the asking began.
  const holdingInput = {
    isOrchestrator: true,
    contextTokens: 400,
    notesMtimeMs: 500,
    firstNudgeAtMs: 1_000,
    holdThresholdTokens: TEST_CONFIG.holdThresholdTokens,
  };

  it('HOLDS for an unbanked orchestrator past the threshold (the only hold row)', () => {
    expect(decideCompactionGate(holdingInput)).toBe('hold');
  });

  it('holds when the notes file does not exist at all (never written = never banked)', () => {
    // ⚠ THE ONE DEGRADED-LOOKING INPUT THAT DOES *NOT* FAIL OPEN, and deliberately
    // so. An absent mtime is not "we could not tell" — it is positive evidence of
    // the exact state the door exists for: a transcript that has never banked
    // anything. If this allowed, the mechanism would be inert for a first-epoch
    // orchestrator, i.e. inert for the case D57 was written about. The fail-open
    // rule governs the DECISION inputs (fill, nudge history), which is where
    // uncertainty actually lives.
    expect(decideCompactionGate({ ...holdingInput, notesMtimeMs: null })).toBe('hold');
  });

  it('allows once the notes are touched AT or after the first nudge — banked', () => {
    expect(decideCompactionGate({ ...holdingInput, notesMtimeMs: 1_000 })).toBe('allow');
    expect(decideCompactionGate({ ...holdingInput, notesMtimeMs: 1_001 })).toBe('allow');
  });

  it('allows for a NON-orchestrator session in every case (S8·4 explicitly-out)', () => {
    expect(decideCompactionGate({ ...holdingInput, isOrchestrator: false })).toBe('allow');
    expect(
      decideCompactionGate({ ...holdingInput, isOrchestrator: false, notesMtimeMs: null }),
    ).toBe('allow');
    expect(
      decideCompactionGate({
        ...holdingInput,
        isOrchestrator: false,
        contextTokens: 10_000_000,
      }),
    ).toBe('allow');
  });

  it('allows below the hold threshold, and AT the boundary holds (inclusive)', () => {
    expect(decideCompactionGate({ ...holdingInput, contextTokens: 299 })).toBe('allow');
    expect(decideCompactionGate({ ...holdingInput, contextTokens: 300 })).toBe('hold');
  });

  it('DEGRADED: fill unknown → allow (a fill we cannot read is not a fill that is huge)', () => {
    expect(decideCompactionGate({ ...holdingInput, contextTokens: null })).toBe('allow');
    expect(decideCompactionGate({ ...holdingInput, contextTokens: Number.NaN })).toBe('allow');
  });

  it('DEGRADED: never nudged → allow (a hold with no ask has no way out of itself)', () => {
    expect(decideCompactionGate({ ...holdingInput, firstNudgeAtMs: null })).toBe('allow');
    expect(decideCompactionGate({ ...holdingInput, firstNudgeAtMs: Number.NaN })).toBe('allow');
  });

  it('DEGRADED: an unusable hold threshold → allow', () => {
    expect(decideCompactionGate({ ...holdingInput, holdThresholdTokens: Number.NaN })).toBe(
      'allow',
    );
  });

  it('a nonsense notes mtime reads exactly like an absent one — no evidence of banking', () => {
    // One rule, not two: an mtime that cannot be compared is not evidence that the
    // notes were written, so it lands where `null` lands. (The daemon seam only
    // ever produces `number | null`; this pins the defensive branch.)
    expect(decideCompactionGate({ ...holdingInput, notesMtimeMs: Number.NaN })).toBe('hold');
  });

  it('is a pure function of its input — same input, same answer, no hidden state', () => {
    expect(decideCompactionGate(holdingInput)).toBe(decideCompactionGate({ ...holdingInput }));
  });
});

describe('composeCompactionNudge — GOLDEN (the delivered turns, pinned)', () => {
  it('L1 is gentle: names the fill, names the action, and grants the delay', () => {
    expect(composeCompactionNudge(1, 268_000)).toBe(
      `Context check: this transcript is now carrying about 268,000 tokens, which crosses the capture band. At your next good boundary — not mid-edit, not mid-verification — run a precompaction capture: flush anything that currently lives only in this conversation into your standing notes file, so a compaction would cost you nothing.

Finishing what you are landing first is fine and expected. This is a heads-up, not an interrupt.`,
    );
  });

  it('L2 is firm and NAMES THE DOOR (the fixed contract for this level, D64)', () => {
    expect(composeCompactionNudge(2, 281_500)).toBe(
      `Context is getting tight: about 281,500 tokens. Capture soon — flush the conversation-only state into your standing notes file now rather than at the next natural break.

Until those notes are updated, VIMES will HOLD the compaction door for you: a compaction attempted before you have banked will be refused, and offered again on the following turn. That hold exists to protect your state, and it lifts the moment you write the notes.`,
    );
  });

  it('the LEVEL CONTRACT: only L2 mentions the hold; L1 grants the delay', () => {
    const gentle = composeCompactionNudge(1, 250_000);
    const firm = composeCompactionNudge(2, 275_000);
    expect(gentle).toContain('heads-up, not an interrupt');
    expect(gentle).not.toContain('HOLD');
    expect(firm).toContain('HOLD the compaction door');
  });

  it('an unforeseen HIGHER rung composes the FIRM text, never the gentle one', () => {
    // The safe direction for a rung the composer has not been taught: a fill past
    // L2 that spoke gently would actively understate the situation.
    expect(composeCompactionNudge(3, 320_000)).toBe(composeCompactionNudge(2, 320_000));
    expect(composeCompactionNudge(99, 320_000)).toContain('HOLD the compaction door');
  });

  it('level 0 or below composes the gentle text (nothing below the bottom rung)', () => {
    expect(composeCompactionNudge(0, 100_000)).toBe(composeCompactionNudge(1, 100_000));
  });

  it('formats the token count LOCALE-FREE — same bytes on every machine', () => {
    expect(composeCompactionNudge(1, 999)).toContain('about 999 tokens');
    expect(composeCompactionNudge(1, 1_000)).toContain('about 1,000 tokens');
    expect(composeCompactionNudge(1, 1_234_567)).toContain('about 1,234,567 tokens');
    // A non-integer fill (never expected off summed token counts, but the seam is
    // a number) truncates rather than rendering a decimal into the turn.
    expect(composeCompactionNudge(1, 1_500.7)).toContain('about 1,500 tokens');
  });
});

describe('composeCompactionResumeContext — GOLDEN (the SessionStart:compact paragraph)', () => {
  it('points at the absolute notes path and ranks the notes above the summary', () => {
    expect(composeCompactionResumeContext('/home/wes/.vimes/orchestrator-notes/proj-1.md')).toBe(
      `Your transcript was just compacted — what you can see above is a summary, not the conversation. Before continuing, re-read your standing notes at /home/wes/.vimes/orchestrator-notes/proj-1.md: they are the durable record of decisions, in-flight work and project knowledge that the summary may have thinned out. Trust the notes over the summary wherever the two disagree.`,
    );
  });

  it('is ONE paragraph — it competes with a summary for attention and must not sprawl', () => {
    expect(composeCompactionResumeContext('/tmp/notes.md')).not.toContain('\n');
  });
});
