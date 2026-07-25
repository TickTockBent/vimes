import { describe, expect, it } from 'vitest';
import { sessionToSubscribeAfterDispatch } from './dispatchFollow.js';

const SESSION_ID = 'sess-abc123';

describe('sessionToSubscribeAfterDispatch — only a genuine spawn hands back an id', () => {
  it('a spawned outcome with a real appSessionId returns that id', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'spawned', appSessionId: SESSION_ID, cwd: '/x' } }),
    ).toBe(SESSION_ID);
  });

  it('a resumed outcome is NOT new — excluded even though it also carries an appSessionId', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'resumed', appSessionId: SESSION_ID } }),
    ).toBeNull();
  });

  it('deferred spawns nothing', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'deferred', reason: 'awaiting-meter-reset' } }),
    ).toBeNull();
  });

  it('refused spawns nothing', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'refused', reason: 'already-running' } }),
    ).toBeNull();
  });

  it('a refused outcome that somehow carries an appSessionId STILL returns null — the outcome gate, not id presence, is what decides', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, {
        result: { outcome: 'refused', reason: 'already-running', appSessionId: SESSION_ID },
      }),
    ).toBeNull();
  });

  it('spawn-failed / resume-failed / worktree-failed all spawn nothing', () => {
    for (const outcome of ['spawn-failed', 'resume-failed', 'worktree-failed']) {
      expect(
        sessionToSubscribeAfterDispatch(200, { result: { outcome, appSessionId: SESSION_ID } }),
        outcome,
      ).toBeNull();
    }
  });

  it('an unrecognised outcome spawns nothing (rule 0.6 — never guessed as success)', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'teleported', appSessionId: SESSION_ID } }),
    ).toBeNull();
  });

  it('404 (unknown task) — nothing was attempted', () => {
    expect(sessionToSubscribeAfterDispatch(404, { error: 'not found' })).toBeNull();
  });

  it('500 (or any non-200 status) is never trusted, even if the body looks spawned', () => {
    expect(
      sessionToSubscribeAfterDispatch(500, { result: { outcome: 'spawned', appSessionId: SESSION_ID } }),
    ).toBeNull();
  });

  it('status 0 — the request never reached the daemon', () => {
    expect(sessionToSubscribeAfterDispatch(0, null)).toBeNull();
  });

  it('a spawned outcome missing appSessionId returns null', () => {
    expect(sessionToSubscribeAfterDispatch(200, { result: { outcome: 'spawned', cwd: '/x' } })).toBeNull();
  });

  it('a spawned outcome with an empty-string appSessionId returns null', () => {
    expect(sessionToSubscribeAfterDispatch(200, { result: { outcome: 'spawned', appSessionId: '' } })).toBeNull();
  });

  it('a spawned outcome with a non-string appSessionId returns null', () => {
    expect(sessionToSubscribeAfterDispatch(200, { result: { outcome: 'spawned', appSessionId: 12345 } })).toBeNull();
  });

  it('malformed / hostile bodies never throw and always resolve to null', () => {
    const hostileBodies: unknown[] = [
      null,
      undefined,
      '',
      'spawned',
      42,
      true,
      [],
      {},
      { result: null },
      { result: 'spawned' },
      { result: [] },
      { result: { outcome: null } },
      { result: { outcome: 'spawned', appSessionId: null } },
    ];
    for (const body of hostileBodies) {
      expect(() => sessionToSubscribeAfterDispatch(200, body)).not.toThrow();
      expect(sessionToSubscribeAfterDispatch(200, body), JSON.stringify(body)).toBeNull();
    }
  });
});
