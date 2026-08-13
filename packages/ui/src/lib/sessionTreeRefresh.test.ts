import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@vimes/core';
import { SESSIONS_AFFECTING_TYPES, TREE_AFFECTING_TYPES } from './sessionTreeRefresh.js';

// ─── A3 — TREE_AFFECTING_TYPES completeness (slice-15.md §4) ─────────────────

describe('TREE_AFFECTING_TYPES', () => {
  it('A3: is a superset of SESSIONS_AFFECTING_TYPES', () => {
    for (const sessionsType of SESSIONS_AFFECTING_TYPES) {
      expect(TREE_AFFECTING_TYPES.has(sessionsType)).toBe(true);
    }
  });

  // Six separate assertions, one per added string, so sabotaging any single
  // line (e.g. dropping 'node_created') reddens exactly its own named test
  // rather than a single assertion covering all six going dark together.
  it('A3: includes node_created (a node was born)', () => {
    expect(TREE_AFFECTING_TYPES.has('node_created')).toBe(true);
  });

  it('A3: includes node_closed (a node closed)', () => {
    expect(TREE_AFFECTING_TYPES.has('node_closed')).toBe(true);
  });

  it('A3: includes session_attached_to_node (a session moved onto a node)', () => {
    expect(TREE_AFFECTING_TYPES.has('session_attached_to_node')).toBe(true);
  });

  it('A3: includes project_created (a new root can appear)', () => {
    expect(TREE_AFFECTING_TYPES.has('project_created')).toBe(true);
  });

  it('A3: includes project_updated (a root can be renamed/redirected)', () => {
    expect(TREE_AFFECTING_TYPES.has('project_updated')).toBe(true);
  });

  it('A3: includes project_archived (a root can stop claiming new work)', () => {
    expect(TREE_AFFECTING_TYPES.has('project_archived')).toBe(true);
  });

  // Spot-check the six literals against core's own wire names. EVENT_TYPES IS
  // exported as a VALUE from @vimes/core's index (`export * from './events.js'`
  // re-exports the const declared there) — confirmed by reading
  // packages/core/src/index.ts before writing this test, per the WO's
  // conditional instruction.
  it('the six added literals match EVENT_TYPES\'s wire names exactly', () => {
    expect('node_created').toBe(EVENT_TYPES.nodeCreated);
    expect('node_closed').toBe(EVENT_TYPES.nodeClosed);
    expect('session_attached_to_node').toBe(EVENT_TYPES.sessionAttachedToNode);
    expect('project_created').toBe(EVENT_TYPES.projectCreated);
    expect('project_updated').toBe(EVENT_TYPES.projectUpdated);
    expect('project_archived').toBe(EVENT_TYPES.projectArchived);
  });
});
