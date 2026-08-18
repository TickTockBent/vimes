import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './schemas.js';
import type { StageRunnerPlan } from './tasks/stageRunner.js';
import { composeStageInstruction } from './tasks/stageInstruction.js';
import {
  deriveSessionTitle,
  extractMessageText,
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
  DISPATCH_BRIEFING_STEM,
  HARNESS_WRAPPER_TITLE_PREFIXES,
  SESSION_TITLE_MAX_LENGTH,
} from './sessionIdentity.js';

// ─── Q3 assertions 3, 4, 5, 8, 10, 11 — the derivation and the ladder ─────────

describe('extractMessageText: content is LOOSE, and an unknown shape contributes nothing', () => {
  it('a plain string is itself', () => {
    expect(extractMessageText('Review the current codebase')).toBe('Review the current codebase');
  });

  it('an array of text blocks concatenates', () => {
    expect(
      extractMessageText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first second');
  });

  // Assertion 4. This is the LIVE shape, not a hypothetical: `tool_result`
  // arrives as a `role:'user'` message, and 9 of the 13 sessions in the live
  // event log have them. Stringifying one would title a session with a wall of
  // JSON or `[object Object]`.
  it.each([
    ['tool_result', [{ type: 'tool_result', content: 'total 120\ndrwxr-xr-x 9 …', tool_use_id: 'toolu_01' }]],
    ['image', [{ type: 'image', source: { data: 'AAAA' } }]],
    ['a block with no type', [{ text: 'orphan' }]],
    ['a null block', [null]],
    ['a primitive block', [42, 'loose']],
    ['a text block whose text is not a string', [{ type: 'text', text: { nested: true } }]],
  ])('%s contributes nothing and never throws', (_label, content) => {
    expect(extractMessageText(content)).toBe('');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a bare object', { role: 'user' }],
  ])('%s yields the empty string rather than throwing (I8)', (_label, content) => {
    expect(extractMessageText(content)).toBe('');
  });

  it('a mixed array keeps only the text blocks', () => {
    expect(
      extractMessageText([
        { type: 'tool_result', content: 'noise' },
        { type: 'text', text: 'the actual ask' },
      ]),
    ).toBe('the actual ask');
  });
});

describe('deriveSessionTitle: the skip rules are recognized SHAPES, one case each', () => {
  it('a real first prompt becomes the title', () => {
    expect(deriveSessionTitle('Look at the development plan and write next-steps.md')).toBe(
      'Look at the development plan and write next-steps.md',
    );
  });

  // Assertion 3 — empty.
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['content with no text blocks', [{ type: 'tool_result', content: 'x' }]],
  ])('%s yields null (absent, not an empty title)', (_label, content) => {
    expect(deriveSessionTitle(content)).toBeNull();
  });

  // Assertion 3 — the bare slash command. `/compact` is 1 of the 13 live
  // sessions' first user messages.
  it.each(['/compact', '/clear', '/context-usage', '  /compact  '])(
    'the bare slash command %s yields null',
    (command) => {
      expect(deriveSessionTitle(command)).toBeNull();
    },
  );

  it('a slash command with real words after it is a REAL title, not a skip', () => {
    expect(deriveSessionTitle('/compact the docs and tell me what changed')).toBe(
      '/compact the docs and tell me what changed',
    );
  });

  // Assertion 3 — every harness-wrapper prefix, one case each. Driven off the
  // exported constant so adding a prefix without a case is impossible.
  it.each(HARNESS_WRAPPER_TITLE_PREFIXES)('the harness wrapper %s yields null', (wrapperPrefix) => {
    expect(deriveSessionTitle(`${wrapperPrefix} whatever follows it`)).toBeNull();
  });

  it('every wrapper prefix in the list is actually exercised above', () => {
    expect(HARNESS_WRAPPER_TITLE_PREFIXES.length).toBe(5);
  });

  // Assertion 5 — whitespace collapse + truncation at the bound.
  it('collapses whitespace to a single line', () => {
    expect(deriveSessionTitle('  Fix   the\n\nledger\ttitles  ')).toBe('Fix the ledger titles');
  });

  it('strips control bytes rather than smuggling them into a label', () => {
    const withEscape = `Compacted \u001b[2mnow\u001b[22m`;
    const title = deriveSessionTitle(withEscape)!;
    // The ESC becomes a space (then collapses) — the SGR payload is left as
    // ordinary text rather than being interpreted; nothing here parses ANSI.
    expect(title).toBe('Compacted [2mnow [22m');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(title)).toBe(false);
  });

  it(`truncates at ${SESSION_TITLE_MAX_LENGTH} — the same bound renameSession enforces on a human name`, () => {
    const longPrompt = 'w'.repeat(400);
    const title = deriveSessionTitle(longPrompt)!;
    expect(title).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(title).toBe('w'.repeat(SESSION_TITLE_MAX_LENGTH));
  });

  it('truncation happens AFTER collapse, so padding never eats the bound', () => {
    const paddedPrompt = `${' '.repeat(200)}${'x'.repeat(130)}`;
    expect(deriveSessionTitle(paddedPrompt)).toBe('x'.repeat(SESSION_TITLE_MAX_LENGTH));
  });
});

describe('the fallback rung: deterministic, locale-free, and DISTINGUISHING', () => {
  it('formats an ISO instant as it was written — UTC, from the string', () => {
    expect(formatSessionTimestamp('2026-07-19T23:25:51.371Z')).toBe('Jul 19 23:25');
    expect(formatSessionTimestamp('2026-01-06T04:05:00.000Z')).toBe('Jan 06 04:05');
    expect(formatSessionTimestamp('2026-12-31T00:00:00.000Z')).toBe('Dec 31 00:00');
  });

  it.each([
    ['not a timestamp at all', 'yesterday'],
    ['a month out of range', '2026-13-01T00:00:00.000Z'],
    ['a month of zero', '2026-00-01T00:00:00.000Z'],
    ['a date with no time', '2026-07-19'],
    ['null', null],
    ['undefined', undefined],
  ])('%s yields null rather than NaN or "Invalid Date"', (_label, isoTimestamp) => {
    expect(formatSessionTimestamp(isoTimestamp)).toBeNull();
  });

  it('the fallback carries BOTH halves', () => {
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6-7890', '2026-07-19T23:25:51.371Z')).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  // Assertion 10, at the unit level: two sessions created one MILLISECOND apart
  // (the real `101609cc` / `6e8b0f55` pair from the live log).
  it('distinguishes two sessions created a millisecond apart', () => {
    const first = formatSessionFallbackLabel('101609cc-06b4-4db4', '2026-07-21T21:36:46.099Z');
    const second = formatSessionFallbackLabel('6e8b0f55-dc21-4aa3', '2026-07-21T21:36:46.100Z');
    expect(first).not.toBe(second);
    expect(first).toBe('Jul 21 21:36 · 101609cc');
    expect(second).toBe('Jul 21 21:36 · 6e8b0f55');
  });

  it('degrades to the short id with no timestamp — never a fabricated time', () => {
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6', null)).toBe('a1b2c3d4');
  });

  it('never renders blank, even with no id at all', () => {
    expect(formatSessionFallbackLabel('', null)).toBe('<unknown-session>');
    expect(formatSessionFallbackLabel('   ', '2026-07-19T23:25:00.000Z')).toBe(
      'Jul 19 23:25 · <unknown-session>',
    );
  });

  it('contains no control bytes', () => {
    const label = formatSessionFallbackLabel('a1b2c3d4', '2026-07-19T23:25:00.000Z');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(label)).toBe(false);
  });

  // Assertion 11.
  it('is identical under every ambient TZ and locale', () => {
    const originalTimeZone = process.env.TZ;
    const originalLanguage = process.env.LANG;
    try {
      const labels = [
        ['UTC', 'en_US.UTF-8'],
        ['Pacific/Kiritimati', 'de_DE.UTF-8'],
        ['America/Los_Angeles', 'ja_JP.UTF-8'],
        ['Asia/Kolkata', 'C'],
      ].map(([timeZone, language]) => {
        process.env.TZ = timeZone!;
        process.env.LANG = language!;
        return formatSessionFallbackLabel('a1b2c3d4-e5f6', '2026-07-19T23:25:51.371Z');
      });
      expect(new Set(labels).size).toBe(1);
      expect(labels[0]).toBe('Jul 19 23:25 · a1b2c3d4');
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
      if (originalLanguage === undefined) {
        delete process.env.LANG;
      } else {
        process.env.LANG = originalLanguage;
      }
    }
  });
});

describe('resolveSessionLabel: the ladder, and the rung that is NOT in it', () => {
  // Assertion 8.
  it('name beats derivedTitle beats the fallback', () => {
    const inputs = {
      sessionId: 'a1b2c3d4-e5f6',
      earliestActivityAt: '2026-07-19T23:25:00.000Z',
    };
    expect(resolveSessionLabel({ ...inputs, name: 'the ledger rewrite', derivedTitle: 'auto' })).toBe(
      'the ledger rewrite',
    );
    expect(resolveSessionLabel({ ...inputs, name: null, derivedTitle: 'auto' })).toBe('auto');
    expect(resolveSessionLabel({ ...inputs, name: null, derivedTitle: null })).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  it('a blank at any rung falls through rather than rendering empty', () => {
    expect(
      resolveSessionLabel({
        sessionId: 'a1b2c3d4-e5f6',
        name: '   ',
        derivedTitle: '\t\n',
        earliestActivityAt: '2026-07-19T23:25:00.000Z',
      }),
    ).toBe('Jul 19 23:25 · a1b2c3d4');
  });

  it('trims a padded name rather than rendering the padding', () => {
    expect(resolveSessionLabel({ sessionId: 'x', name: '  named  ' })).toBe('named');
  });

  // ⚠ THE REGRESSION PIN at the ladder itself (assertion 9). `resolveSessionLabel`
  // takes NO cwd — the type has no place to put one. Reintroducing the rung would
  // require widening this signature, which is exactly the friction intended.
  it('takes no cwd at all: the ladder cannot read one even if someone passes it', () => {
    const label = resolveSessionLabel({
      sessionId: 'a1b2c3d4-e5f6',
      name: null,
      derivedTitle: null,
      earliestActivityAt: '2026-07-19T23:25:00.000Z',
      // A caller trying to sneak the deleted rung back in through the object.
      ...({ cwd: '/home/ticktockbent/projects/content/death' } as Record<string, unknown>),
    });
    expect(label).not.toBe('death');
    expect(label).toBe('Jul 19 23:25 · a1b2c3d4');
  });
});

// ─── S16-F1: the dispatch-briefing skip (ruled ⟨Wes⟩ 2026-08-17) ─────────────
//
// Two halves, and the SECOND one is the lesson. The first proves the mechanism;
// the second proves it fires on the REAL population, by composing the briefings
// through `composeStageInstruction` itself rather than through a convenient
// hand-written string. S16-F1 existed precisely because a fixture that placed
// `Task:` inside 120 characters proved a mechanism that could never fire on any
// real briefing.

const DISPATCH_TASK_LABEL = 'getMany(ids) — batch the session lookups';
const DISPATCH_PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

function dispatchedTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-s16-u6-000000000001',
    projectRoot: DISPATCH_PROJECT_ROOT,
    title: DISPATCH_TASK_LABEL,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

const SPAWN: StageRunnerPlan = { mode: 'spawn' };

// EVERY variant `composeStageInstruction` can reach, composed through the real
// exported function. `markerBeyondCap` records the measurement that IS S16-F1:
// where `Task:` lands in the whitespace-collapsed briefing, relative to the
// 120-character cap the old code applied first.
//   • implementing 178, review 182, planning 160 — all beyond the cap, so the
//     marker was truncated away and the downstream stripper could never fire.
//   • generic 96 — INSIDE the cap, so that variant was only half-broken: the
//     marker survived but the label was truncated to whatever fitted in the
//     remaining ~24 characters. Both are fixed by recognizing the shape first.
const DISPATCH_BRIEFING_VARIANTS: readonly {
  readonly variant: string;
  readonly compose: (task: TaskRecord) => string;
  readonly markerBeyondCap: boolean;
}[] = [
  {
    variant: 'generic make-progress (a bare implementing task degrades to it)',
    compose: (task) => composeStageInstruction(task, SPAWN),
    markerBeyondCap: false,
  },
  {
    variant: 'implementing, rich (a work-order section earns the fuller briefing)',
    compose: (task) =>
      composeStageInstruction({ ...task, scope: 'Batch the per-id lookups behind one call.' }, SPAWN),
    markerBeyondCap: true,
  },
  {
    variant: 'planning',
    compose: (task) => composeStageInstruction({ ...task, stage: 'planning' }, SPAWN),
    markerBeyondCap: true,
  },
  {
    variant: 'review',
    compose: (task) =>
      composeStageInstruction(
        {
          ...task,
          stage: 'review',
          acceptanceCriteria: [{ id: 'ac1', text: 'One query, not N.' }],
        },
        SPAWN,
      ),
    markerBeyondCap: true,
  },
];

describe('deriveSessionTitle: the dispatch briefing is titled by its TASK LINE (S16-F1)', () => {
  // ⚠ **THE COUPLING, MACHINE-CHECKED.** `DISPATCH_BRIEFING_STEM` is restated in
  // sessionIdentity.ts rather than imported from the task subsystem, which is
  // exactly the drift the UI stripper could only WARN about in a comment. This
  // test closes it: change the composer's opening sentence and this reddens
  // rather than going quietly inert.
  it.each(DISPATCH_BRIEFING_VARIANTS.map((v) => [v.variant, v] as const))(
    'the %s briefing opens with the stem the derivation matches on',
    (_variant, briefingVariant) => {
      expect(briefingVariant.compose(dispatchedTask()).startsWith(DISPATCH_BRIEFING_STEM)).toBe(true);
    },
  );

  it.each(DISPATCH_BRIEFING_VARIANTS.map((v) => [v.variant, v] as const))(
    'the %s briefing derives EXACTLY the task label',
    (_variant, briefingVariant) => {
      expect(deriveSessionTitle(briefingVariant.compose(dispatchedTask()))).toBe(DISPATCH_TASK_LABEL);
    },
  );

  // ⚠ THE REGRESSION PIN FOR THE FINDING ITSELF. If a future edit moves the skip
  // back AFTER the cap, these positions are what makes it a no-op again.
  it.each(DISPATCH_BRIEFING_VARIANTS.map((v) => [v.variant, v] as const))(
    'the %s briefing puts Task: where the OLD cap-first order could not reach it',
    (_variant, briefingVariant) => {
      const collapsedBriefing = briefingVariant
        .compose(dispatchedTask())
        .replace(/\s+/g, ' ')
        .trim();
      expect(collapsedBriefing.indexOf('Task:') > SESSION_TITLE_MAX_LENGTH).toBe(
        briefingVariant.markerBeyondCap,
      );
    },
  );

  // The table must actually cover four DIFFERENT briefings — a refactor that
  // collapsed two variants onto the same text would otherwise still pass above.
  it('covers four distinct composed briefings, not the same one four times', () => {
    const composedBriefings = DISPATCH_BRIEFING_VARIANTS.map((v) => v.compose(dispatchedTask()));
    expect(new Set(composedBriefings).size).toBe(4);
  });

  // ── the LINE bound (why core does not copy the UI's everything-after slice) ──
  it('takes the Task LINE only — Stage: and Directory: never reach the title', () => {
    const title = deriveSessionTitle(composeStageInstruction(dispatchedTask(), SPAWN))!;
    expect(title).toBe(DISPATCH_TASK_LABEL);
    expect(title).not.toContain('Stage:');
    expect(title).not.toContain('Directory:');
    expect(title).not.toContain(DISPATCH_PROJECT_ROOT);
  });

  // ── the FIRST-marker rule ────────────────────────────────────────────────────
  it('a label that itself begins "Task:" survives whole — the FIRST marker is the briefing\'s own', () => {
    const selfReferentialLabel = 'Task: surf the wave';
    const briefing = composeStageInstruction(dispatchedTask({ title: selfReferentialLabel }), SPAWN);
    expect(briefing).toContain(`  Task:      ${selfReferentialLabel}`);
    expect(deriveSessionTitle(briefing)).toBe(selfReferentialLabel);
  });

  // ── the cap still applies, to the LABEL rather than to the boilerplate ───────
  it(`a label longer than the bound truncates at ${SESSION_TITLE_MAX_LENGTH}`, () => {
    const longLabel = 'q'.repeat(300);
    const title = deriveSessionTitle(
      composeStageInstruction(dispatchedTask({ title: longLabel }), SPAWN),
    )!;
    expect(title).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(title).toBe('q'.repeat(SESSION_TITLE_MAX_LENGTH));
  });

  // ── boilerplate with nothing usable is a WRAPPER, not a title ────────────────
  it.each([
    ['no marker at all', `${DISPATCH_BRIEFING_STEM} to do something this file has never seen.`],
    ['the stem and nothing else', DISPATCH_BRIEFING_STEM],
    ['a marker with an empty remainder', `${DISPATCH_BRIEFING_STEM} to do a thing.\n\n  Task:      \n  Stage:     implementing`],
  ])('a dispatch briefing with %s yields null, exactly like a harness wrapper', (_label, briefing) => {
    expect(deriveSessionTitle(briefing)).toBeNull();
  });

  // The branch is anchored at byte 0, deliberately — see the constant's comment.
  it('the stem must OPEN the message: a prompt that merely mentions it is an ordinary title', () => {
    const mentionsTheStem = `Note: ${DISPATCH_BRIEFING_STEM} — but this message is not one. Task: still not one.`;
    expect(deriveSessionTitle(mentionsTheStem)).toBe(mentionsTheStem);
  });

  // The briefing arrives as a string in the live log, but `content` is LOOSE by
  // schema — a single text block must take the same branch.
  it('recognizes the briefing inside a text block, not only as a bare string', () => {
    const briefing = composeStageInstruction(dispatchedTask(), SPAWN);
    expect(deriveSessionTitle([{ type: 'text', text: briefing }])).toBe(DISPATCH_TASK_LABEL);
  });
});

describe('deriveSessionTitle: NON-dispatch input is byte-identical to the pre-S16·U6 behavior', () => {
  // ⚠ **PASSTHROUGH PINS.** The dispatch branch is a new fork in front of the
  // pipeline; every input that does not open with the stem must reach exactly
  // the answer it reached before. Each expectation below is the OLD
  // implementation's output, written as a literal rather than recomputed.
  it.each([
    ['an ordinary prompt', 'Look at the development plan and write next-steps.md', 'Look at the development plan and write next-steps.md'],
    ['a padded multi-line prompt', '  Fix   the\n\nledger\ttitles  ', 'Fix the ledger titles'],
    ['a slash command with real words', '/compact the docs and tell me what changed', '/compact the docs and tell me what changed'],
    ['a bare slash command', '/compact', null],
    ['a harness wrapper', '<command-name>/compact</command-name>', null],
    ['a continuation summary', 'This session is being continued from a previous conversation.', null],
    ['an empty string', '', null],
    ['whitespace only', '   \n\t  ', null],
    ['a tool_result block', [{ type: 'tool_result', content: 'total 120', tool_use_id: 'toolu_01' }], null],
    ['a text block array', [{ type: 'text', text: 'Review the current codebase' }], 'Review the current codebase'],
    ['a shape nobody recognizes', { role: 'user' }, null],
    // A `Task:` marker WITHOUT the stem is somebody's ordinary prompt, and it
    // keeps every byte — the marker alone never triggers the skip.
    ['a prompt that happens to say Task:', 'Task: write the migration report', 'Task: write the migration report'],
  ])('%s is unchanged', (_label, content, expectedTitle) => {
    expect(deriveSessionTitle(content)).toBe(expectedTitle);
  });

  it('the long-prompt truncation is unchanged', () => {
    expect(deriveSessionTitle('w'.repeat(400))).toBe('w'.repeat(SESSION_TITLE_MAX_LENGTH));
  });

  it('every harness wrapper prefix still yields null through the new fork', () => {
    for (const wrapperPrefix of HARNESS_WRAPPER_TITLE_PREFIXES) {
      expect(deriveSessionTitle(`${wrapperPrefix} whatever follows it`)).toBeNull();
    }
  });
});
