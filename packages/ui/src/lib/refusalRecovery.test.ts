import { describe, expect, it, vi } from 'vitest';
import {
  isGateResponseRefusal,
  resolveRefusedPending,
  resolveSpawnedPending,
  shouldSearchRefusalError,
  type PendingSpawn,
} from './refusalRecovery.js';

describe('resolveSpawnedPending / resolveRefusedPending (spawn)', () => {
  it('a refused spawn resolves the pending spawn: fires onRefused, clears pending, does not fire onSpawned', () => {
    const onSpawned = vi.fn();
    const onRefused = vi.fn();
    const pending: PendingSpawn = { onSpawned, onRefused };

    const result = resolveRefusedPending(pending, 'spawn', 'cwd-outside-project-roots');
    expect(result.next).toBeNull();
    result.fire?.();

    expect(onRefused).toHaveBeenCalledWith('cwd-outside-project-roots');
    expect(onSpawned).not.toHaveBeenCalled();
  });

  it('a refusal of a different op leaves the pending spawn untouched (no callback fires)', () => {
    const onSpawned = vi.fn();
    const onRefused = vi.fn();
    const pending: PendingSpawn = { onSpawned, onRefused };

    const result = resolveRefusedPending(pending, 'send', 'unknown-session');
    expect(result.next).toBe(pending);
    expect(result.fire).toBeNull();

    expect(onSpawned).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('a refusal with no pending spawn is a no-op', () => {
    const result = resolveRefusedPending(null, 'spawn', 'cwd-outside-project-roots');
    expect(result.next).toBeNull();
    expect(result.fire).toBeNull();
  });

  it('a subsequent successful spawn fires ONLY its own callback (proves the FIFO leak is fixed)', () => {
    // Simulates: spawn #1 is refused (resolved, cleared) then spawn #2 is
    // started and succeeds. #1's callbacks must never fire again.
    const firstOnSpawned = vi.fn();
    const firstOnRefused = vi.fn();
    let pending: PendingSpawn | null = { onSpawned: firstOnSpawned, onRefused: firstOnRefused };

    const refusal = resolveRefusedPending(pending, 'spawn', 'cwd-outside-project-roots');
    pending = refusal.next;
    refusal.fire?.();
    expect(pending).toBeNull();

    const secondOnSpawned = vi.fn();
    const secondOnRefused = vi.fn();
    pending = { onSpawned: secondOnSpawned, onRefused: secondOnRefused };

    const success = resolveSpawnedPending(pending, 'app-session-2');
    pending = success.next;
    success.fire?.();

    expect(secondOnSpawned).toHaveBeenCalledWith('app-session-2');
    expect(secondOnRefused).not.toHaveBeenCalled();
    // The first spawn's callbacks were already consumed by its own refusal —
    // the second spawn's resolution must not touch them again.
    expect(firstOnSpawned).not.toHaveBeenCalled();
    expect(firstOnRefused).toHaveBeenCalledTimes(1);
  });

  it('success path still works: a spawned envelope resolves the pending spawn once', () => {
    const onSpawned = vi.fn();
    const onRefused = vi.fn();
    const pending: PendingSpawn = { onSpawned, onRefused };

    const result = resolveSpawnedPending(pending, 'app-session-1');
    expect(result.next).toBeNull();
    result.fire?.();

    expect(onSpawned).toHaveBeenCalledWith('app-session-1');
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('a spawned envelope with no pending spawn is a no-op', () => {
    const result = resolveSpawnedPending(null, 'app-session-1');
    expect(result.next).toBeNull();
    expect(result.fire).toBeNull();
  });
});

describe('isGateResponseRefusal (gate_response)', () => {
  it('is true only for refusedOp "gate_response"', () => {
    expect(isGateResponseRefusal('gate_response')).toBe(true);
    expect(isGateResponseRefusal('spawn')).toBe(false);
    expect(isGateResponseRefusal('send')).toBe(false);
  });
});

describe('shouldSearchRefusalError (search)', () => {
  it('is true only when a search refusal arrives while a search is running', () => {
    expect(shouldSearchRefusalError('running', 'search')).toBe(true);
    expect(shouldSearchRefusalError('idle', 'search')).toBe(false);
    expect(shouldSearchRefusalError('done', 'search')).toBe(false);
    expect(shouldSearchRefusalError('error', 'search')).toBe(false);
    expect(shouldSearchRefusalError('running', 'spawn')).toBe(false);
  });
});
