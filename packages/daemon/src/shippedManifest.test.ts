import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtensionManifest, type ParsedWorkflow } from '@vimes/core';
import {
  SHIPPED_MANIFEST_PATH,
  SHIPPED_WORKFLOW_ID,
  ShippedManifestError,
  loadShippedWorkflow,
} from './shippedManifest.js';

// ─── S12·U2 (D72 Move 3) — the shipped asset and its boot resolution ─────────
//
// Two jobs in one file, because they are two halves of one fact ("the daemon
// reads a declaration it actually ships"):
//
//   • THE DIVERGENCE TRIPWIRE (slice-12 scope 1 / S12-A3's second clause). The
//     SHIPPED manifest starts as a byte-copy of the FROZEN fixture and the two
//     are EXPECTED to diverge in later moves — so this file pins the things that
//     may not diverge yet (the expanded edge set, the forbidden rows, and the
//     three inputs to the pinned ref) rather than byte equality, which would
//     redden on the first legal edit.
//   • S12-A5: a daemon booted against an unparsable/absent shipped manifest
//     refuses to start, WITH the parse errors in the output.

const FIXTURE_MANIFEST_PATH = fileURLToPath(
  new URL('../../../fixtures/extensions/vimes-tasks/vimes-extension.toml', import.meta.url),
);

function parseOrThrow(path: string): ReturnType<typeof parseExtensionManifest> {
  const result = parseExtensionManifest(readFileSync(path, 'utf8'));
  expect(result.ok).toBe(true);
  return result;
}

/** `{from,to}` as a comparable set — `by`/`max_traversals` are not pinned here. */
function edgeKeySet(workflow: ParsedWorkflow): Set<string> {
  return new Set(workflow.edges.map((edge) => `${edge.from}→${edge.to}`));
}

function forbiddenKeySet(workflow: ParsedWorkflow): Set<string> {
  return new Set(workflow.forbidden.map((row) => `${row.from}→${row.to}:${row.reason}`));
}

function softwareWorkflowOf(path: string): ParsedWorkflow {
  const parsed = parseOrThrow(path);
  if (!parsed.ok) throw new Error('unreachable — asserted ok above');
  const workflow = parsed.manifest.workflows.find(
    (declaredWorkflow) => declaredWorkflow.id === SHIPPED_WORKFLOW_ID,
  );
  expect(workflow).toBeDefined();
  return workflow as ParsedWorkflow;
}

describe('the shipped manifest asset — the divergence tripwire (slice-12 scope 1)', () => {
  // ⚠ WHAT A RED HERE MEANS. The SHIPPED copy under `packages/daemon/extensions/`
  // is the runtime asset and MAY be edited; the FIXTURE under `fixtures/` is
  // FROZEN FOREVER (it is the differential's reference and S12-A2's replay
  // input). A divergence in the legality data below is legal ONLY under a DATED
  // SLICE-12 AMENDMENT saying so — until such an amendment exists, a red here is
  // a FINDING (rule 0.1): the daemon would be adjudicating against a table no
  // frozen artifact vouches for.
  it('declares the SAME expanded edge table as the frozen fixture', () => {
    const shipped = edgeKeySet(softwareWorkflowOf(SHIPPED_MANIFEST_PATH));
    const fixture = edgeKeySet(softwareWorkflowOf(FIXTURE_MANIFEST_PATH));
    expect([...shipped].sort()).toEqual([...fixture].sort());
    // Count-pinned so an empty parse on either side cannot pass as agreement.
    expect(shipped.size).toBeGreaterThan(0);
  });

  it('declares the SAME forbidden rows, reasons included', () => {
    const shipped = forbiddenKeySet(softwareWorkflowOf(SHIPPED_MANIFEST_PATH));
    const fixture = forbiddenKeySet(softwareWorkflowOf(FIXTURE_MANIFEST_PATH));
    expect([...shipped].sort()).toEqual([...fixture].sort());
    expect(shipped.size).toBeGreaterThan(0);
  });

  // The three inputs to the ref every instance is now stamped with. They agree
  // with the fixture AND with their literal values, so a rename on either side is
  // caught in the same red.
  it('agrees with the fixture on the ref stamp inputs (id, initial node, version)', () => {
    const shippedManifest = parseOrThrow(SHIPPED_MANIFEST_PATH);
    const fixtureManifest = parseOrThrow(FIXTURE_MANIFEST_PATH);
    if (!shippedManifest.ok || !fixtureManifest.ok) throw new Error('unreachable');
    expect(shippedManifest.manifest.id).toBe(fixtureManifest.manifest.id);
    expect(shippedManifest.manifest.version).toBe(fixtureManifest.manifest.version);
    expect(softwareWorkflowOf(SHIPPED_MANIFEST_PATH).initial).toBe(
      softwareWorkflowOf(FIXTURE_MANIFEST_PATH).initial,
    );
    expect(shippedManifest.manifest.id).toBe('vimes-tasks');
    expect(shippedManifest.manifest.version).toBe('1.0.0');
    expect(softwareWorkflowOf(SHIPPED_MANIFEST_PATH).initial).toBe('backlog');
  });
});

describe('loadShippedWorkflow — boot-time resolution (S12-A5)', () => {
  it('resolves the REAL in-build asset with no argument, and pins the ref', () => {
    const resolved = loadShippedWorkflow();
    expect(resolved.workflow.id).toBe('software');
    expect(resolved.workflow.initial).toBe('backlog');
    expect(resolved.ref).toEqual({
      extension: 'vimes-tasks',
      workflow: 'software',
      rev: '1.0.0',
    });
  });

  it('resolves the same declaration the module-level path names', () => {
    // The default-argument path and the exported constant are the same asset —
    // asserted rather than assumed, because everything downstream (the writer's
    // adjudication, the stage-edges route) trusts that they are.
    expect(loadShippedWorkflow(SHIPPED_MANIFEST_PATH).workflow).toEqual(
      loadShippedWorkflow().workflow,
    );
  });

  it('THROWS on broken TOML, with the parse issues in the message', () => {
    const brokenPath = join(mkdtempSync(join(tmpdir(), 'vimes-manifest-')), 'broken.toml');
    writeFileSync(brokenPath, 'id = "vimes-tasks"\nthis is not toml at all [[[\n', 'utf8');
    let thrown: unknown;
    try {
      loadShippedWorkflow(brokenPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ShippedManifestError);
    const message = (thrown as Error).message;
    // The parse issues VERBATIM — A5 is "with the parse errors in the boot
    // output", so the structured code has to survive into the sentence.
    expect(message).toContain('toml-parse-error');
    expect(message).toContain(brokenPath);
  });

  it('THROWS naming the path when the manifest is absent', () => {
    const missingPath = join(
      mkdtempSync(join(tmpdir(), 'vimes-manifest-')),
      'nowhere',
      'vimes-extension.toml',
    );
    expect(() => loadShippedWorkflow(missingPath)).toThrow(ShippedManifestError);
    expect(() => loadShippedWorkflow(missingPath)).toThrow(missingPath);
  });

  it('THROWS naming what was missing when a VALID manifest declares no `software` workflow', () => {
    // A manifest that parses cleanly and simply has no such workflow — the
    // failure mode a rename produces, which is why the message lists what IS
    // declared.
    const path = join(mkdtempSync(join(tmpdir(), 'vimes-manifest-')), 'no-workflow.toml');
    writeFileSync(
      path,
      [
        'id = "vimes-tasks"',
        'name = "VIMES tasks"',
        'version = "1.0.0"',
        'api_version = 1',
        '',
        '[runtime]',
        'kind = "in-process"',
        '',
        '[[workflows]]',
        'id = "hardware"',
        'title = "Not the one"',
        'initial = "backlog"',
        'edges = [{ from = "backlog", to = "done", by = ["human"] }]',
        '',
        '[[workflows.nodes]]',
        'id = "backlog"',
        'kind = "hold"',
        '',
        '[[workflows.nodes]]',
        'id = "done"',
        'kind = "hold"',
        '',
        '[[node-kinds]]',
        'id = "hold"',
        '',
      ].join('\n'),
      'utf8',
    );
    let thrown: unknown;
    try {
      loadShippedWorkflow(path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ShippedManifestError);
    expect((thrown as Error).message).toContain('software');
    expect((thrown as Error).message).toContain('"hardware"');
  });
});
