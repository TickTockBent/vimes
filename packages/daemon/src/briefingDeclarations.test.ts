import { describe, expect, it } from 'vitest';
import { DISPATCHABLE_TASK_STAGES, NON_DISPATCHABLE_TASK_STAGES, TASK_STAGES } from '@vimes/core';

import { loadShippedWorkflow } from './shippedManifest.js';
import {
  ENGINE_REPORT_TOOL_IDS,
  ENGINE_REPORT_TOOL_NAMES,
  ENGINE_REPORT_TOOL_SERVER,
  dispatchedFootingFor,
  isEngineKnownToolId,
  readNodeBriefingDeclaration,
} from './briefingDeclarations.js';

// ─── S19·U2 — the DECLARATION READER (slice-19 §3.3/§3.4/§3.6) ───────────────
//
// What this file pins: the reader answers off the BOOT-RESOLVED declaration, it
// is TOTAL over every node id anything can hand it, and §3.4's permission
// mapping is stated once and asserted directly.
//
// ⚠ It reads the SHIPPED manifest — the real one the daemon boots on — through
// the same `loadShippedWorkflow()` the daemon uses, so a manifest edit that
// changed a composer name or a tool id reddens HERE rather than at 3am.

const SHIPPED = loadShippedWorkflow().workflow;

// The domain, asserted FROM THE ENGINE'S OWN PARTITION rather than hand-listed
// (recon fact 1: the dispatchable three are exactly the briefing-carrying
// three). A stage joining or leaving `DISPATCHABLE_TASK_STAGES` changes what
// this file covers, automatically.
const DISPATCHABLE = [...DISPATCHABLE_TASK_STAGES];

describe('S19·U2 — the shipped declaration, read per dispatchable node', () => {
  it('covers exactly the three dispatchable stages (the domain claim itself)', () => {
    expect(DISPATCHABLE.sort()).toEqual(['implementing', 'planning', 'review']);
  });

  it.each(DISPATCHABLE)('%s declares a briefing', (stage) => {
    const lookup = readNodeBriefingDeclaration(SHIPPED, stage);
    expect(lookup.declared).toBe(true);
  });

  // The shipped declaration, field by field. These are the values the A2
  // differential then proves EQUIVALENT to the compiled path — pinned here so a
  // manifest drift is a named red rather than a silent shift in what A2 compares.
  it('planning: the plan-mode, plan-capturing, tool-less node (D48 + D55)', () => {
    const lookup = readNodeBriefingDeclaration(SHIPPED, 'planning');
    expect(lookup).toEqual({
      declared: true,
      declaration: {
        nodeId: 'planning',
        composerEntryPoint: 'briefings/planning',
        inputRows: ['instance.record'],
        toolIds: [],
        permissionFooting: 'plan',
        capture: ['plan'],
      },
    });
  });

  it('implementing: the fix-seed node — all four input rows, the completion tool', () => {
    const lookup = readNodeBriefingDeclaration(SHIPPED, 'implementing');
    expect(lookup).toEqual({
      declared: true,
      declaration: {
        nodeId: 'implementing',
        composerEntryPoint: 'briefings/implementing',
        inputRows: [
          'instance.record',
          'artifact:plan',
          'report:last-review',
          'report:last-completion',
        ],
        toolIds: ['vimes_report.report_completion'],
        permissionFooting: 'auto',
        capture: [],
      },
    });
  });

  it('review: the record alone, the review tool', () => {
    const lookup = readNodeBriefingDeclaration(SHIPPED, 'review');
    expect(lookup).toEqual({
      declared: true,
      declaration: {
        nodeId: 'review',
        composerEntryPoint: 'briefings/review',
        inputRows: ['instance.record'],
        toolIds: ['vimes_report.report_review'],
        permissionFooting: 'auto',
        capture: [],
      },
    });
  });

  // §3.2's disjointness has a precondition nobody states out loud: an undeclared
  // input kind must be genuinely undeclared. Planning and review declare NEITHER
  // report row, which is what makes A3's "never read" assertion meaningful.
  it.each(['planning', 'review'] as const)(
    '%s declares NEITHER report row (the precondition A3 rests on)',
    (stage) => {
      const lookup = readNodeBriefingDeclaration(SHIPPED, stage);
      expect(lookup.declared).toBe(true);
      if (!lookup.declared) return;
      expect(lookup.declaration.inputRows).not.toContain('report:last-review');
      expect(lookup.declaration.inputRows).not.toContain('report:last-completion');
      expect(lookup.declaration.inputRows).not.toContain('artifact:plan');
    },
  );

  it('every declared tool id on every dispatchable node is engine-known', () => {
    for (const stage of DISPATCHABLE) {
      const lookup = readNodeBriefingDeclaration(SHIPPED, stage);
      expect(lookup.declared).toBe(true);
      if (!lookup.declared) continue;
      for (const toolId of lookup.declaration.toolIds) {
        expect(isEngineKnownToolId(toolId)).toBe(true);
      }
    }
  });
});

describe('S19·U2 — the reader is TOTAL (a typed absence, never a throw)', () => {
  it('an unknown node id is a named absence', () => {
    expect(readNodeBriefingDeclaration(SHIPPED, 'a-node-nobody-declared')).toEqual({
      declared: false,
      absence: 'unknown-node',
    });
  });

  it('the empty string is a node id like any other — absent, not a crash', () => {
    expect(readNodeBriefingDeclaration(SHIPPED, '')).toEqual({
      declared: false,
      absence: 'unknown-node',
    });
  });

  // A7's neighbour, mechanised: the non-dispatchable stages are declared nodes
  // that carry NO briefing, and the two absences must stay distinguishable —
  // "the workflow never heard of this node" is a different operator problem from
  // "this node has no briefing table".
  it.each([...NON_DISPATCHABLE_TASK_STAGES])(
    '%s is a DECLARED node with no briefing table',
    (stage) => {
      expect(readNodeBriefingDeclaration(SHIPPED, stage)).toEqual({
        declared: false,
        absence: 'node-declares-no-briefing',
      });
    },
  );

  it('nothing in the task-stage vocabulary can make the reader throw', () => {
    for (const stage of TASK_STAGES) {
      expect(() => readNodeBriefingDeclaration(SHIPPED, stage)).not.toThrow();
    }
  });
});

describe('S19·U2 — §3.4: the permission mapping, stated once', () => {
  it('declared `plan` is the SDK plan footing', () => {
    expect(dispatchedFootingFor('plan')).toBe('plan');
  });

  // "declared `default` or ABSENT" is ONE case in code, because the parser
  // defaults an absent node-level `permission_mode` to `default` before it ever
  // reaches this function — which is exactly why the shipped `implementing` and
  // `review` nodes (neither of which spells the key at all) land on `auto` above.
  it('declared `default` — and therefore an ABSENT key — is the dispatched footing `auto`', () => {
    expect(dispatchedFootingFor('default')).toBe('auto');
  });

  it('`auto` is NOT tenant vocabulary: the manifest never spells it', () => {
    // The mapping exists precisely because these two alphabets differ. If the
    // manifest ever accepted `auto`, §3.4's rejected alternative would have
    // landed by accident and this test is where that shows up.
    for (const stage of DISPATCHABLE) {
      const lookup = readNodeBriefingDeclaration(SHIPPED, stage);
      expect(lookup.declared).toBe(true);
      if (!lookup.declared) continue;
      expect(['plan', 'auto']).toContain(lookup.declaration.permissionFooting);
    }
  });
});

describe('S19·U2 — §3.6: the engine-known tool id set (ONE source)', () => {
  it('the ids are DERIVED from the server name and the tool names, not re-listed', () => {
    expect(ENGINE_REPORT_TOOL_IDS).toEqual(
      ENGINE_REPORT_TOOL_NAMES.map((name) => `${ENGINE_REPORT_TOOL_SERVER}.${name}`),
    );
  });

  it('the set is exactly the two report tools the host can build', () => {
    expect([...ENGINE_REPORT_TOOL_IDS]).toEqual([
      'vimes_report.report_review',
      'vimes_report.report_completion',
    ]);
  });

  // FAIL-CLOSED (§3.6): a tenant selects among engine tools, it never mints one.
  it.each([
    'report_review',
    'vimes_report.report_reviews',
    'vimes_board.create_task',
    'vimes_report.rm_rf',
    '',
  ])('%s is NOT engine-known', (toolId) => {
    expect(isEngineKnownToolId(toolId)).toBe(false);
  });
});
