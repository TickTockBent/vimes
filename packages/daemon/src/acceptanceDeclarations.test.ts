import { describe, expect, it } from 'vitest';
import { TASK_STAGES } from '@vimes/core';

import { loadShippedWorkflow } from './shippedManifest.js';
import { acceptanceFor, nodeDeclaringReportVerb } from './acceptanceDeclarations.js';
import { ENGINE_REPORT_TOOL_IDS } from './briefingDeclarations.js';

// ─── S20·U1 — the ACCEPTANCE READ on the declaration seam (slice-20 §3.3) ────
//
// What this file pins: the reader answers off the BOOT-RESOLVED declaration in
// both directions, and it is TOTAL over every id anything can hand it — an
// unknown node, a node that declares no acceptance, a verb nothing declares.
//
// ⚠ It reads the SHIPPED manifest — the real one the daemon boots on — through
// the same `loadShippedWorkflow()` the daemon uses, so a manifest edit that
// moved a report binding reddens HERE rather than at 3am.
//
// ⚠ NOTHING IN PRODUCTION CALLS THESE YET (U2 wires them beside the compiled
// routings). These cells are the pure proof that the pieces are right before
// anything depends on them.

const SHIPPED = loadShippedWorkflow().workflow;

const REVIEW_VERB = 'vimes_report.report_review';
const COMPLETION_VERB = 'vimes_report.report_completion';

describe('S20·U1 — `acceptanceFor`: node → what it accepts', () => {
  it('reads the three declared tables off the shipped workflow', () => {
    expect(acceptanceFor(SHIPPED, 'planning')).toEqual({
      declared: true,
      nodeId: 'planning',
      acceptance: { kind: 'artifact', requires: ['capture:plan'], onPass: 'plan-ready' },
    });
    expect(acceptanceFor(SHIPPED, 'implementing')).toEqual({
      declared: true,
      nodeId: 'implementing',
      acceptance: { kind: 'report', report: COMPLETION_VERB, onPass: 'review' },
    });
    expect(acceptanceFor(SHIPPED, 'review')).toEqual({
      declared: true,
      nodeId: 'review',
      acceptance: {
        kind: 'rubric',
        report: REVIEW_VERB,
        criteriaFrom: 'instance.acceptanceCriteria',
        coverage: 'all-criteria-pass',
        unlistedIds: 'ignore',
        onPass: 'done',
        onFail: 'implementing',
      },
    });
  });

  it('a declared node with NO acceptance table is a typed absence, not a throw (§1.8.4 (f))', () => {
    // Eight of the eleven shipped nodes rest — that is the ordinary case, and
    // the ABSENCE half of the claim above.
    for (const nodeId of ['backlog', 'plan-ready', 'done', 'manual-review', 'cancelled']) {
      expect(acceptanceFor(SHIPPED, nodeId)).toEqual({
        declared: false,
        absence: 'node-declares-no-acceptance',
      });
    }
  });

  it('an unknown node id is a DIFFERENT typed absence, not a throw', () => {
    expect(acceptanceFor(SHIPPED, 'no-such-node')).toEqual({
      declared: false,
      absence: 'unknown-node',
    });
    expect(acceptanceFor(SHIPPED, '')).toEqual({ declared: false, absence: 'unknown-node' });
  });

  it('is TOTAL over every task stage the engine knows', () => {
    for (const stage of TASK_STAGES) {
      expect(() => acceptanceFor(SHIPPED, stage)).not.toThrow();
      expect(typeof acceptanceFor(SHIPPED, stage).declared).toBe('boolean');
    }
  });

  it('exactly three of the shipped nodes declare acceptance (the coverage claim, §0.1)', () => {
    const declaring = SHIPPED.nodes
      .map((node) => node.id)
      .filter((nodeId) => acceptanceFor(SHIPPED, nodeId).declared);
    expect(declaring).toEqual(['planning', 'implementing', 'review']);
  });
});

describe('S20·U1 — `nodeDeclaringReportVerb`: verb → the node it satisfies', () => {
  it('resolves each shipped catalogue verb to the node that declared it', () => {
    expect(nodeDeclaringReportVerb(SHIPPED, REVIEW_VERB)).toEqual({
      bound: true,
      nodeId: 'review',
    });
    expect(nodeDeclaringReportVerb(SHIPPED, COMPLETION_VERB)).toEqual({
      bound: true,
      nodeId: 'implementing',
    });
  });

  it('every engine catalogue verb resolves — and to a DISTINCT node', () => {
    const resolved = ENGINE_REPORT_TOOL_IDS.map((verbId) =>
      nodeDeclaringReportVerb(SHIPPED, verbId),
    );
    expect(resolved.every((lookup) => lookup.bound)).toBe(true);
    const nodeIds = resolved.flatMap((lookup) => (lookup.bound ? [lookup.nodeId] : []));
    expect(new Set(nodeIds).size).toBe(ENGINE_REPORT_TOOL_IDS.length);
  });

  it('a verb NO node declares is a typed absence — the spurious-call guard, preserved (A5)', () => {
    // Not a throw and not a lucky first node: the guard the compiled path keeps
    // today stays a guard, it just moves onto the declaration.
    expect(nodeDeclaringReportVerb(SHIPPED, 'vimes_report.report_invented')).toEqual({
      bound: false,
      absence: 'no-node-declares-verb',
    });
    expect(nodeDeclaringReportVerb(SHIPPED, '')).toEqual({
      bound: false,
      absence: 'no-node-declares-verb',
    });
    // ABSENCE, stated: a NODE ID is not a verb id. Handing the reverse lookup a
    // node id must not accidentally resolve that node.
    for (const node of SHIPPED.nodes) {
      expect(nodeDeclaringReportVerb(SHIPPED, node.id).bound).toBe(false);
    }
  });

  it('round-trips: the node a verb resolves to declares that same verb', () => {
    for (const verbId of ENGINE_REPORT_TOOL_IDS) {
      const binding = nodeDeclaringReportVerb(SHIPPED, verbId);
      expect(binding.bound).toBe(true);
      if (!binding.bound) continue;
      const declaration = acceptanceFor(SHIPPED, binding.nodeId);
      expect(declaration.declared).toBe(true);
      if (!declaration.declared) continue;
      expect(declaration.acceptance.report).toBe(verbId);
    }
  });
});
