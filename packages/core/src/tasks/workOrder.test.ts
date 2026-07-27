import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson.js';
import {
  artifactEnvelopeSchema,
  reportCompletionPayloadSchema,
  reportReviewPayloadSchema,
  scopedTokenBindingSchema,
  stageRunIdentitySchema,
  submitPlanPayloadSchema,
} from './workOrder.js';
// S7·7b: the same three shapes, imported from where they now LIVE, so the
// re-export shims can be pinned by identity (see the last describe in this file).
import {
  reportCompletionPayloadSchema as schemasReportCompletionPayloadSchema,
  reportReviewPayloadSchema as schemasReportReviewPayloadSchema,
  taskStageSchema as schemasTaskStageSchema,
} from '../schemas.js';
import { taskStageSchema as machineTaskStageSchema } from './taskStateMachine.js';

// ─── S7·1 — the reserved shapes have NO consumer yet ─────────────────────────
//
// These tests exercise the schemas ENTIRELY IN ISOLATION: no projection, no
// dispatcher, no event, no daemon file is involved anywhere below. That is the
// point of a rule-0.5 reservation — the shape must be provably correct on its
// own terms before anything is wired to it.
//
// Per schema: a valid value `safeParse`s success, a canonicalJson round-trip
// (parse → canonicalJson → parse → canonicalJson) is stable, and at least one
// malformed value `safeParse`s failure.

describe('stageRunIdentitySchema (D46 — the stage-run identity tuple)', () => {
  const validIdentity = {
    taskId: 'task-aaaa-0001',
    stage: 'implementing' as const,
    attempt: 1,
    workOrderRev: 0,
  };

  it('accepts a well-formed identity', () => {
    expect(stageRunIdentitySchema.safeParse(validIdentity).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = stageRunIdentitySchema.parse(validIdentity);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = stageRunIdentitySchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('rejects attempt: 0 — attempts are 1-based, never zero', () => {
    expect(
      stageRunIdentitySchema.safeParse({ ...validIdentity, attempt: 0 }).success,
    ).toBe(false);
  });

  it('rejects a stage outside the task-stage enum', () => {
    expect(
      stageRunIdentitySchema.safeParse({ ...validIdentity, stage: 'not-a-real-stage' }).success,
    ).toBe(false);
  });
});

describe('artifactEnvelopeSchema (the content-addressed blob envelope)', () => {
  const validEnvelope = {
    hash: 'sha256:abc123',
    kind: 'plan',
    taskRef: { taskId: 'task-aaaa-0001', stage: 'planning' },
    rev: 0,
    createdBy: { appSessionId: 'session-aaaa-0001' },
    createdAt: '2026-07-24T12:00:00.000Z',
  };

  it('accepts a well-formed envelope', () => {
    expect(artifactEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it('accepts an arbitrary `kind` string — reserved open, not an enum', () => {
    expect(
      artifactEnvelopeSchema.safeParse({ ...validEnvelope, kind: 'some-future-kind' }).success,
    ).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = artifactEnvelopeSchema.parse(validEnvelope);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = artifactEnvelopeSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('rejects a missing hash', () => {
    const { hash: _omittedHash, ...withoutHash } = validEnvelope;
    expect(artifactEnvelopeSchema.safeParse(withoutHash).success).toBe(false);
  });
});

describe('submitPlanPayloadSchema (D44 — plan crosses by reference)', () => {
  const validPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'planning' as const,
    attempt: 1,
    workOrderRev: 0,
    planArtifactHash: 'sha256:def456',
    plannerSessionRef: { appSessionId: 'session-aaaa-0001' },
  };

  it('accepts a well-formed submit_plan payload', () => {
    expect(submitPlanPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = submitPlanPayloadSchema.parse(validPayload);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = submitPlanPayloadSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('rejects attempt: 0', () => {
    expect(submitPlanPayloadSchema.safeParse({ ...validPayload, attempt: 0 }).success).toBe(false);
  });

  it('rejects a missing planArtifactHash', () => {
    const { planArtifactHash: _omitted, ...withoutHash } = validPayload;
    expect(submitPlanPayloadSchema.safeParse(withoutHash).success).toBe(false);
  });
});

describe('reportReviewPayloadSchema (per-criterion pass/fail, S7·6)', () => {
  const validPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'review' as const,
    attempt: 1,
    workOrderRev: 1,
    criteria: [
      { criterionId: 'crit-1', verdict: 'pass' as const },
      { criterionId: 'crit-2', verdict: 'fail' as const, note: 'missing edge case' },
    ],
  };

  it('accepts a well-formed review report with mixed verdicts', () => {
    expect(reportReviewPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = reportReviewPayloadSchema.parse(validPayload);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = reportReviewPayloadSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it("rejects a verdict outside the {'pass','fail'} enum", () => {
    const withBadVerdict = {
      ...validPayload,
      criteria: [{ criterionId: 'crit-1', verdict: 'maybe' }],
    };
    expect(reportReviewPayloadSchema.safeParse(withBadVerdict).success).toBe(false);
  });
});

describe('reportCompletionPayloadSchema (D46 — the worklog fix-seed)', () => {
  const validPayload = {
    taskId: 'task-aaaa-0001',
    stage: 'implementing' as const,
    attempt: 2,
    workOrderRev: 0,
    worklog: {
      decisionsMade: ['used a Map instead of an object for O(1) lookup'],
      pathsRejected: ['tried a recursive descent parser; abandoned, too slow to review'],
    },
  };

  it('accepts a well-formed completion report', () => {
    expect(reportCompletionPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = reportCompletionPayloadSchema.parse(validPayload);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = reportCompletionPayloadSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('rejects a worklog missing pathsRejected', () => {
    const withoutPathsRejected = {
      ...validPayload,
      worklog: { decisionsMade: ['something'] },
    };
    expect(reportCompletionPayloadSchema.safeParse(withoutPathsRejected).success).toBe(false);
  });
});

describe('scopedTokenBindingSchema (what a per-role credential is bound to)', () => {
  const validBinding = {
    taskId: 'task-aaaa-0001',
    stage: 'planning' as const,
    attempt: 1,
  };

  it('accepts a well-formed binding', () => {
    expect(scopedTokenBindingSchema.safeParse(validBinding).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = scopedTokenBindingSchema.parse(validBinding);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = scopedTokenBindingSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('does NOT carry workOrderRev — a token authorizes the run, not a revision', () => {
    expect(Object.keys(scopedTokenBindingSchema.shape)).not.toContain('workOrderRev');
  });

  it('rejects attempt: -1', () => {
    expect(scopedTokenBindingSchema.safeParse({ ...validBinding, attempt: -1 }).success).toBe(false);
  });
});

// ─── S7·7b — the hoist shims (D52 finding 1) ──────────────────────────────────
//
// `taskStageSchema` and the two report payload schemas now LIVE in `schemas.ts`
// (they type `taskRecordSchema.stage`/`.lastReview`/`.lastCompletion`, and a leaf
// cannot import from a module that imports it). Both old import paths survive as
// re-exports, and these tests are the pin on that: IDENTITY (`toBe`), not mere
// structural equivalence, because the whole point of one-source-of-record is that
// there is exactly ONE schema object, reachable by several names.
describe('S7·7b hoist — the old import paths still resolve to the SAME objects', () => {
  it('workOrder.ts re-exports the schemas.ts report payloads by identity', () => {
    expect(reportReviewPayloadSchema).toBe(schemasReportReviewPayloadSchema);
    expect(reportCompletionPayloadSchema).toBe(schemasReportCompletionPayloadSchema);
  });

  it('taskStateMachine.ts re-exports the schemas.ts stage enum by identity', () => {
    expect(machineTaskStageSchema).toBe(schemasTaskStageSchema);
  });

  it('the report payloads validate their stage against that very enum', () => {
    // The reason the hoist was needed at all: stage → report payload → task record
    // → stage was a cycle. Asserted as behaviour, not structure: a stage outside
    // the enum must still be rejected after the move.
    expect(reportReviewPayloadSchema.safeParse({
      taskId: 'task-aaaa-0001',
      stage: 'not-a-stage',
      attempt: 1,
      workOrderRev: 0,
      criteria: [],
    }).success).toBe(false);
  });
});
