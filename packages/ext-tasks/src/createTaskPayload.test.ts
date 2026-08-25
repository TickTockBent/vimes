import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@vimes/ext-host';
import { createTaskToolPayloadSchema } from './createTaskPayload.js';

// ─── S8·6 — createTaskToolPayloadSchema (the author grant's door) ─────────────
//
// The FIRST shape in this file with a live consumer at birth (the daemon's
// `buildCreateTaskSpec`), so these tests carry more weight than a reservation's:
// what they pin is what an orchestrator may and may not say.
describe("createTaskToolPayloadSchema (D56's author grant — the model's door)", () => {
  const validPayload = {
    title: 'Wire the provenance chip',
    scope: 'Board cards mark orchestrator-authored tasks so the rewrite rate is legible.',
    explicitlyOut: ['Drive verbs', 'Any change to the dispatched exposure matrix'],
    acceptanceCriteria: [{ text: 'A card with createdBy orchestrator renders the chip' }],
    killCriterion: 'The chip cannot be derived without a second board authority.',
  };

  it('accepts a well-formed authored work-order', () => {
    expect(createTaskToolPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('round-trips through canonicalJson identically', () => {
    const parsedOnce = createTaskToolPayloadSchema.parse(validPayload);
    const jsonOnce = canonicalJson(parsedOnce);
    const parsedTwice = createTaskToolPayloadSchema.parse(JSON.parse(jsonOnce));
    const jsonTwice = canonicalJson(parsedTwice);
    expect(jsonTwice).toBe(jsonOnce);
  });

  it('accepts a payload with NO explicitlyOut — the one optional field', () => {
    const { explicitlyOut: _omitted, ...withoutExplicitlyOut } = validPayload;
    const parsed = createTaskToolPayloadSchema.safeParse(withoutExplicitlyOut);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'explicitlyOut' in parsed.data).toBe(false);
  });

  // ── the forced fields: named by the daemon, never by the model ──────────────
  //
  // One case each, spelled out rather than looped, so a failure names the exact
  // field a future widening let through.
  it.each(['projectRoot', 'stage', 'isolation', 'gates', 'createdBy'])(
    'REJECTS a payload naming %s — the daemon decides it (principle 13)',
    (forcedField) => {
      const hostilePayload = { ...validPayload, [forcedField]: 'implementing' };
      const parsed = createTaskToolPayloadSchema.safeParse(hostilePayload);
      expect(parsed.success).toBe(false);
      // The failure NAMES the field, which is what the tool's acknowledgement
      // hands back to the model — strict-reject over silent-strip is only useful
      // if the rejection says what was wrong.
      expect(JSON.stringify(parsed.error?.issues)).toContain(forcedField);
    },
  );

  it('REJECTS an alien key nobody has ever heard of', () => {
    expect(
      createTaskToolPayloadSchema.safeParse({ ...validPayload, priority: 'urgent' }).success,
    ).toBe(false);
  });

  it('REJECTS a criterion that hand-types an id — ids are minted server-side', () => {
    expect(
      createTaskToolPayloadSchema.safeParse({
        ...validPayload,
        acceptanceCriteria: [{ id: 'crit-1', text: 'checkable' }],
      }).success,
    ).toBe(false);
  });

  // ── the required, non-empty fields: the doctrine, enforced ──────────────────
  it.each(['title', 'scope', 'killCriterion'])('REJECTS an absent %s', (requiredField) => {
    const withoutField: Record<string, unknown> = { ...validPayload };
    delete withoutField[requiredField];
    expect(createTaskToolPayloadSchema.safeParse(withoutField).success).toBe(false);
  });

  it.each(['title', 'scope', 'killCriterion'])('REJECTS an EMPTY %s', (requiredField) => {
    expect(
      createTaskToolPayloadSchema.safeParse({ ...validPayload, [requiredField]: '' }).success,
    ).toBe(false);
  });

  it('REJECTS an empty acceptanceCriteria list — a work-order with no rubric', () => {
    expect(
      createTaskToolPayloadSchema.safeParse({ ...validPayload, acceptanceCriteria: [] }).success,
    ).toBe(false);
  });

  it('REJECTS a criterion whose text is empty', () => {
    expect(
      createTaskToolPayloadSchema.safeParse({
        ...validPayload,
        acceptanceCriteria: [{ text: '' }],
      }).success,
    ).toBe(false);
  });

  it('REJECTS an absent acceptanceCriteria list', () => {
    const { acceptanceCriteria: _omitted, ...withoutCriteria } = validPayload;
    expect(createTaskToolPayloadSchema.safeParse(withoutCriteria).success).toBe(false);
  });
});
