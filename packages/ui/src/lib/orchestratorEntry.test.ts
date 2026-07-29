import { describe, expect, it } from 'vitest';
import { describeEnsureOutcome, sessionToOpenAfterEnsure } from './orchestratorEntry.js';

const SESSION_ID = 'sess-orch-abc123';

describe('sessionToOpenAfterEnsure — only a live-session outcome hands back an id', () => {
  it('already-live returns its appSessionId', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'already-live', appSessionId: SESSION_ID })).toBe(
      SESSION_ID,
    );
  });

  it('resumed returns its appSessionId', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'resumed', appSessionId: SESSION_ID })).toBe(SESSION_ID);
  });

  it('founded (first) returns its appSessionId', () => {
    expect(
      sessionToOpenAfterEnsure(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'sent' },
      }),
    ).toBe(SESSION_ID);
  });

  it('founded + refounded returns its appSessionId', () => {
    expect(
      sessionToOpenAfterEnsure(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        refounded: true,
        briefingDelivery: { status: 'sent' },
      }),
    ).toBe(SESSION_ID);
  });

  it('a founded session whose briefing was NOT delivered still opens — the notice is a separate concern', () => {
    expect(
      sessionToOpenAfterEnsure(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'not-delivered', reason: 'no-live-process' },
      }),
    ).toBe(SESSION_ID);
  });

  it('spawn-refused opens nothing', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'spawn-refused', reason: 'preflight-failed' })).toBeNull();
  });

  it('resume-refused opens nothing', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'resume-refused', reason: 'no-live-process' })).toBeNull();
  });

  it('a refused outcome that somehow carries an appSessionId STILL returns null — the outcome gate decides, not id presence', () => {
    expect(
      sessionToOpenAfterEnsure(200, { outcome: 'spawn-refused', reason: 'x', appSessionId: SESSION_ID }),
    ).toBeNull();
  });

  it('an unrecognised outcome opens nothing (rule 0.6 — never guessed as success)', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'teleported', appSessionId: SESSION_ID })).toBeNull();
  });

  it('a non-200 status opens nothing, even with an otherwise-valid body', () => {
    expect(sessionToOpenAfterEnsure(404, { outcome: 'already-live', appSessionId: SESSION_ID })).toBeNull();
  });

  it('the postJsonApi network sentinel (status 0) opens nothing', () => {
    expect(sessionToOpenAfterEnsure(0, null)).toBeNull();
  });

  it('an empty appSessionId opens nothing', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'already-live', appSessionId: '' })).toBeNull();
  });

  it('a missing appSessionId opens nothing', () => {
    expect(sessionToOpenAfterEnsure(200, { outcome: 'already-live' })).toBeNull();
  });

  it('a non-object body opens nothing', () => {
    expect(sessionToOpenAfterEnsure(200, 'not an object')).toBeNull();
    expect(sessionToOpenAfterEnsure(200, null)).toBeNull();
    expect(sessionToOpenAfterEnsure(200, undefined)).toBeNull();
  });
});

describe('describeEnsureOutcome — the notice for everything that is NOT a plain open', () => {
  it('already-live says nothing — opening the chat IS the feedback', () => {
    expect(describeEnsureOutcome(200, { outcome: 'already-live', appSessionId: SESSION_ID })).toBeNull();
  });

  it('a marker-less resumed (no briefingDelivery — a dormant resume) says nothing', () => {
    expect(describeEnsureOutcome(200, { outcome: 'resumed', appSessionId: SESSION_ID })).toBeNull();
  });

  it('a founded (first) session — PINNED string', () => {
    expect(
      describeEnsureOutcome(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'sent' },
      }),
    ).toEqual({ tone: 'info', text: 'Orchestrator founded for this project.' });
  });

  it('a refounded session — PINNED string', () => {
    expect(
      describeEnsureOutcome(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        refounded: true,
        briefingDelivery: { status: 'sent' },
      }),
    ).toEqual({
      tone: 'info',
      text:
        "A previous orchestrator's transcript ended; a new one was founded carrying its standing notes forward.",
    });
  });

  it('spawn-refused — PINNED string, reason inline', () => {
    expect(describeEnsureOutcome(200, { outcome: 'spawn-refused', reason: 'preflight-failed' })).toEqual({
      tone: 'warn',
      text: 'The orchestrator could not be started: preflight-failed.',
    });
  });

  it('resume-refused — PINNED string, reason inline', () => {
    expect(describeEnsureOutcome(200, { outcome: 'resume-refused', reason: 'no-live-process' })).toEqual({
      tone: 'warn',
      text: 'The orchestrator could not be resumed: no-live-process.',
    });
  });

  it('a spawn-refused with no reason string still produces a sentence — PINNED fallback', () => {
    expect(describeEnsureOutcome(200, { outcome: 'spawn-refused' })).toEqual({
      tone: 'warn',
      text: 'The orchestrator could not be started: unknown reason.',
    });
  });

  it('founded with an undelivered briefing — PINNED composed string, warn tone', () => {
    expect(
      describeEnsureOutcome(200, {
        outcome: 'founded',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'not-delivered', reason: 'no-live-process' },
      }),
    ).toEqual({
      tone: 'warn',
      text: 'Orchestrator founded for this project. It is live but its briefing was not delivered: no-live-process.',
    });
  });

  it('resumed (interrupted) with an undelivered reorientation — PINNED string, warn tone', () => {
    expect(
      describeEnsureOutcome(200, {
        outcome: 'resumed',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'not-delivered', reason: 'send-threw:boom' },
      }),
    ).toEqual({
      tone: 'warn',
      text: 'It is live but its briefing was not delivered: send-threw:boom.',
    });
  });

  it('resumed (interrupted) whose reorientation WAS delivered says nothing — a clean continuation is not news', () => {
    expect(
      describeEnsureOutcome(200, {
        outcome: 'resumed',
        appSessionId: SESSION_ID,
        briefingDelivery: { status: 'sent' },
      }),
    ).toBeNull();
  });

  it('an unrecognised outcome says nothing at 200 (rule 0.6 — never invents a fact)', () => {
    expect(describeEnsureOutcome(200, { outcome: 'teleported' })).toBeNull();
  });

  it('a 404 — PINNED generic warn', () => {
    expect(describeEnsureOutcome(404, { error: 'not found' })).toEqual({
      tone: 'warn',
      text: "Could not reach this project's orchestrator right now.",
    });
  });

  it('the postJsonApi network sentinel (status 0) — PINNED generic warn', () => {
    expect(describeEnsureOutcome(0, null)).toEqual({
      tone: 'warn',
      text: "Could not reach this project's orchestrator right now.",
    });
  });

  it('a non-object body at 200 degrades to no outcome match, not a throw', () => {
    expect(describeEnsureOutcome(200, 'garbage')).toBeNull();
    expect(describeEnsureOutcome(200, null)).toBeNull();
  });
});
