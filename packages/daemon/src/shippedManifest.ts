import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseExtensionManifest,
  type ManifestIssue,
  type ParsedWorkflow,
  type WorkflowRef,
} from '@vimes/core';

// ─── S12·U2 (D72 Move 3) — the SHIPPED declaration, resolved at boot ──────────
//
// The daemon ships `vimes-tasks/vimes-extension.toml` as a RUNTIME ASSET and
// parses it once, at construction, into the workflow the adjudicator reads. This
// module is the whole of the I/O: the parser is pure (S10-A5), `proposeMove` is
// pure, and the writer is INJECTED the parsed result — so the only thing that
// ever touches the filesystem for a declaration is the fifty lines below.
//
// ⚠ **FAILURE HERE IS A BOOT FAILURE, NOT A DEGRADE** (slice-12 scope item 2).
// A daemon that cannot read its own in-build declaration is MISBUILT, not
// running-in-a-reduced-mode: adjudication has no table, creation has no starting
// node, and every instance it went on to write would be recorded against nothing.
// So this is the one sanctioned throw in the daemon's write-adjacent code — it
// happens during `createDaemon`, BEFORE any listener binds, and `main.ts`'s
// existing top-level catch prints it and `process.exit(1)`s (S12-A5). Nothing in
// here is reachable from a request.
//
// ⚠ **F3 — DIRECT PARSE, THE REGISTRY STAYS UNWIRED.** `extensionRegistry.ts`
// exists and does project-declared discovery + provenance; wiring it here would
// fake an activation story Move 3 does not have. Its first live consumer is the
// activation move, and the in-build source kind it already carries is the landing
// pad for that day.

/**
 * The workflow id this daemon adjudicates against. ONE workflow, named here
 * rather than discovered: Move 3 pins a single boot-resolved declaration (F2),
 * and "whichever workflow happens to be first" is not a pin.
 */
export const SHIPPED_WORKFLOW_ID = 'software';

/**
 * The in-build manifest's path, resolved RELATIVE TO THIS MODULE and never to
 * the process's working directory — systemd's `WorkingDirectory` is not a
 * contract, and a cwd-relative asset is a daemon that boots differently
 * depending on which shell started it.
 *
 * ⚠ THE SAME LITERAL IS CORRECT FROM BOTH `src/` AND `dist/`, and that is not a
 * coincidence: `packages/daemon/src/` and `packages/daemon/dist/` are both DIRECT
 * CHILDREN of the package root, so `../extensions/…` lands on
 * `packages/daemon/extensions/vimes-tasks/vimes-extension.toml` whether this
 * module is being run from TypeScript source under vitest or from the compiled
 * output under `vimes.service`. There is no copy step, and there is nothing to
 * keep in sync — the asset is read out of the package it ships in.
 */
export const SHIPPED_MANIFEST_PATH: string = fileURLToPath(
  new URL('../extensions/vimes-tasks/vimes-extension.toml', import.meta.url),
);

/**
 * A boot-resolved declaration and the identity every instance created under it
 * is stamped with.
 */
export interface ShippedWorkflow {
  /** The parsed workflow — the adjudicator's only authority (`proposeMove`). */
  readonly workflow: ParsedWorkflow;
  /**
   * The pinned ref (node-kit §1.7's identity): the extension that declares the
   * workflow, the workflow's id inside it, and the manifest's own `version` as
   * `rev`. Recorded on every birth record from Move 3 onward.
   */
  readonly ref: WorkflowRef;
}

/** Thrown when the shipped declaration cannot be read, parsed, or resolved. */
export class ShippedManifestError extends Error {}

/** The parse issues, serialized so the boot output names what was wrong and where. */
function describeIssues(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => `  • [${issue.code}] ${issue.path}: ${issue.message}`).join('\n');
}

/**
 * Read, parse and resolve the shipped declaration. THROWS on every failure —
 * see the header for why this one is sanctioned.
 *
 * The three failures, each naming what a human needs to fix it:
 *
 *   • the file cannot be READ (absent, unreadable) → the resolved PATH is in the
 *     message, because "manifest missing" without a path sends the operator
 *     hunting through a build layout.
 *   • the parser REFUSES it → every `ManifestIssue` is printed VERBATIM (code,
 *     path, message). S12-A5 is specifically "with the parse errors in the boot
 *     output": a refusal summarised as "invalid manifest" is a refusal nobody can
 *     act on.
 *   • the manifest parses but declares no `software` workflow → the workflow ids
 *     it DOES declare are listed, because the failure is almost always a rename.
 *
 * @param manifestPath TEST INJECTION ONLY. Production passes nothing and gets
 * the in-build asset; the parameter exists so the three refusals above are
 * assertable without moving files around a live package.
 */
export function loadShippedWorkflow(manifestPath: string = SHIPPED_MANIFEST_PATH): ShippedWorkflow {
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new ShippedManifestError(
      `the shipped extension manifest could not be read at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parseResult = parseExtensionManifest(manifestText);
  if (!parseResult.ok) {
    throw new ShippedManifestError(
      `the shipped extension manifest at ${manifestPath} did not parse:\n${describeIssues(
        parseResult.errors,
      )}`,
    );
  }

  const manifest = parseResult.manifest;
  const workflow = manifest.workflows.find(
    (declaredWorkflow) => declaredWorkflow.id === SHIPPED_WORKFLOW_ID,
  );
  if (workflow === undefined) {
    const declaredIds = manifest.workflows.map((declaredWorkflow) => declaredWorkflow.id);
    throw new ShippedManifestError(
      `the shipped extension manifest at ${manifestPath} declares no "${SHIPPED_WORKFLOW_ID}" workflow; it declares ${
        declaredIds.length === 0 ? 'none at all' : declaredIds.map((id) => `"${id}"`).join(', ')
      }`,
    );
  }

  return {
    workflow,
    // The ref's three fields, every one READ off the manifest rather than
    // restated: a hardcoded id or rev here would be the daemon claiming an
    // identity the declaration did not give it (rule 0.7, in miniature).
    ref: { extension: manifest.id, workflow: workflow.id, rev: manifest.version },
  };
}
