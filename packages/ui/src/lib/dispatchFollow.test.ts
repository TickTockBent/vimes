import { describe, expect, it } from 'vitest';
import { sessionToSubscribeAfterDispatch, sessionToSubscribeAfterTransition } from './dispatchFollow.js';

const SESSION_ID = 'sess-abc123';

describe('sessionToSubscribeAfterDispatch — only a genuine spawn hands back an id', () => {
  it('a spawned outcome with a real appSessionId returns that id', () => {
    expect(
      sessionToSubscribeAfterDispatch(200, { result: { outcome: 'spawned', appSessionId: SESSION_ID, cwd: '/x' } }),
    ).toBe(SESSION_ID);
  });

  it('the RETIRED `resumed` outcome is never treated as new — D46 removed it, S7·7e pins the degrade', () => {
    // `resumed` used to be excluded here on purpose (it reattached to a
    // session that already existed, so it was never "new" even though it also
    // carried an appSessionId). D46 removed the daemon's resume path and
    // S7·7e removed the outcome from the union entirely; the string can no
    // longer arrive, and this now exercises the SAME general `!== 'spawned'`
    // rejection any unrecognised outcome gets — no special case left to test.
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

// ── S7·7e — the D53 promotion rider's sibling guard ──────────────────────────
//
// SAME strict posture as `sessionToSubscribeAfterDispatch` (they share the one
// inner check, `spawnedSessionIdFromResult`), reading `body.dispatch` — the
// TOP-LEVEL rider on an accepted promotion's envelope — instead of `body.result`.
describe('sessionToSubscribeAfterTransition — the D53 rider, same guard, different envelope key', () => {
  it('a spawned rider with a real appSessionId returns that id', () => {
    expect(
      sessionToSubscribeAfterTransition(200, {
        accepted: true,
        instance: {},
        dispatch: { outcome: 'spawned', appSessionId: SESSION_ID, cwd: '/x' },
      }),
    ).toBe(SESSION_ID);
  });

  it('refused / deferred / in-flight riders spawn nothing', () => {
    for (const outcome of ['refused', 'deferred', 'in-flight']) {
      expect(
        sessionToSubscribeAfterTransition(200, { accepted: true, instance: {}, dispatch: { outcome } }),
        outcome,
      ).toBeNull();
    }
  });

  it('an ABSENT `dispatch` key — every non-promotion accepted transition — returns null', () => {
    // The common case: an ordinary move, or an outcome edge. No dispatch was
    // attempted at all, and the key is omitted rather than `undefined` (see
    // instanceApi.ts's `ProposeMoveResponse`) — the guard must read that
    // absence as cleanly as it reads any other malformed shape.
    expect(sessionToSubscribeAfterTransition(200, { accepted: true, instance: {} })).toBeNull();
  });

  it('a `result` key (the DISPATCH route\'s shape, not this one\'s) is ignored — wrong key, no cross-talk', () => {
    expect(
      sessionToSubscribeAfterTransition(200, {
        result: { outcome: 'spawned', appSessionId: SESSION_ID, cwd: '/x' },
      }),
    ).toBeNull();
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
      { dispatch: null },
      { dispatch: 'spawned' },
      { dispatch: [] },
      { dispatch: { outcome: null } },
      { dispatch: { outcome: 'spawned', appSessionId: null } },
    ];
    for (const body of hostileBodies) {
      expect(() => sessionToSubscribeAfterTransition(200, body)).not.toThrow();
      expect(sessionToSubscribeAfterTransition(200, body), JSON.stringify(body)).toBeNull();
    }
  });

  it('non-200 status is never trusted, even if the body looks spawned', () => {
    expect(
      sessionToSubscribeAfterTransition(409, {
        dispatch: { outcome: 'spawned', appSessionId: SESSION_ID, cwd: '/x' },
      }),
    ).toBeNull();
  });

  it('status 0 — the request never reached the daemon', () => {
    expect(sessionToSubscribeAfterTransition(0, null)).toBeNull();
  });
});
