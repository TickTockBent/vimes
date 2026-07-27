import { describe, expect, it } from 'vitest';
import type { ReportReviewPayload } from './workOrder.js';
import { deriveReviewOutcome } from './reviewOutcome.js';

// ─── S7·6a — the review verdict → proposed-stage function ──────────────────────
//
// Pure and TOTAL (rule 0.3): the same inputs always yield the same stage, and no
// input throws. The rules under test:
//   any fail -> implementing; incomplete coverage -> implementing;
//   all task criteria covered + passed -> done; empty task criteria -> done.

type Criteria = ReportReviewPayload['criteria'];

function pass(criterionId: string, note?: string): Criteria[number] {
  return { criterionId, verdict: 'pass', ...(note === undefined ? {} : { note }) };
}
function fail(criterionId: string, note?: string): Criteria[number] {
  return { criterionId, verdict: 'fail', ...(note === undefined ? {} : { note }) };
}

describe('deriveReviewOutcome', () => {
  it('all task criteria passed and covered -> done', () => {
    const reported = [pass('a'), pass('b')];
    expect(deriveReviewOutcome(reported, ['a', 'b'])).toBe('done');
  });

  it('any reported fail -> implementing (even if everything else passes)', () => {
    const reported = [pass('a'), fail('b', 'not implemented')];
    expect(deriveReviewOutcome(reported, ['a', 'b'])).toBe('implementing');
  });

  it('a single fail with full coverage otherwise -> implementing', () => {
    // The verify-by-breaking target: flipping the fail check to always-`done` reds
    // exactly this assertion.
    expect(deriveReviewOutcome([fail('a')], ['a'])).toBe('implementing');
  });

  it('incomplete coverage (a task criterion never passed) -> implementing', () => {
    // 'b' is on the task but the reviewer never reported a pass for it.
    expect(deriveReviewOutcome([pass('a')], ['a', 'b'])).toBe('implementing');
  });

  it('a task criterion reported only as fail is uncovered -> implementing', () => {
    // Belt-and-braces: even ignoring the any-fail short-circuit, 'b' is not passed.
    expect(deriveReviewOutcome([pass('a'), fail('b')], ['a', 'b'])).toBe('implementing');
  });

  it('empty task criteria (a bare task) -> done (vacuously covered)', () => {
    expect(deriveReviewOutcome([], [])).toBe('done');
    // Even with some reported passes but no task bar, it is vacuously done.
    expect(deriveReviewOutcome([pass('stray')], [])).toBe('done');
  });

  it('an extra reported id not on the task is ignored for coverage (does not block done)', () => {
    const reported = [pass('a'), pass('b'), pass('extra-not-on-task')];
    expect(deriveReviewOutcome(reported, ['a', 'b'])).toBe('done');
  });

  it('a duplicate pass for a covered id still counts as covered -> done', () => {
    expect(deriveReviewOutcome([pass('a'), pass('a')], ['a'])).toBe('done');
  });

  it('is PURE/TOTAL: never throws on empty, mismatched, or odd inputs', () => {
    expect(() => deriveReviewOutcome([], [])).not.toThrow();
    expect(() => deriveReviewOutcome([], ['a', 'b', 'c'])).not.toThrow();
    expect(() => deriveReviewOutcome([pass('x'), fail('y')], ['z'])).not.toThrow();
    // No reports but a coverage bar -> uncovered -> implementing.
    expect(deriveReviewOutcome([], ['a'])).toBe('implementing');
  });

  it('is deterministic: same inputs -> same output', () => {
    const reported = [pass('a'), pass('b')];
    const ids = ['a', 'b'];
    expect(deriveReviewOutcome(reported, ids)).toBe(deriveReviewOutcome(reported, ids));
  });
});
