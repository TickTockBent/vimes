import type { ParsedWorkflow } from '@vimes/core';

// ─── S19·U2 (slice-19 §3.3/§3.4/§3.6) — READING the boot declaration ─────────
//
// One question, one answer: **what does the BOOT-RESOLVED declaration say about
// this node's briefing?** — the composer entry point, the declared input rows,
// the declared tool ids, the permission footing a dispatched spawn gets, and the
// declared captures.
//
// ── the law this module obeys (slice-19 §3.3, and Move 3's signed F2) ─────────
//
//   "Dispatch follows Move 3's one-boot-declaration law. The dispatcher reads
//    the boot-resolved declaration (same source adjudication uses); no
//    per-instance re-resolution, and a rev difference is not a mismatch."
//
// That is why this module takes a `ParsedWorkflow` and nothing else. It does no
// I/O, holds no cache, and resolves nothing per instance: `app.ts` calls
// `loadShippedWorkflow()` EXACTLY ONCE at boot and hands the same object to the
// `InstanceWriter` (which adjudicates against it) and to the instance API (which
// serves its edge table). The dispatch preflight becomes the third reading of
// that ONE declaration, wired the same way, from the same variable.
//
// ⚠ **TOTAL — NOTHING HERE THROWS.** An unknown node id, a node with no briefing
// table, a node the workflow has never heard of: each is a typed ABSENCE, never
// an exception. The caller (`briefingPreflight.ts`) turns an absence into a
// named, loud refusal that spawns nothing; a throw at this depth would surface
// as an unhandled rejection inside an HTTP handler instead.
//
// Rule 0.3: pure. The declaration is INJECTED, exactly as `InstanceWriter` takes
// it, because a module that read the manifest itself would be a second boot
// resolution and F2 says there is one.

// ── the types, derived from the barrel rather than re-declared ───────────────
//
// `ParsedWorkflowNode`, `ParsedBriefing` and `NodeProperties` are declared in
// core's `extensions/manifest.ts` and are deliberately NOT on core's barrel
// (`packages/core/src/index.ts` exports a NAMED list, and these three are not on
// it). Widening that barrel is out of this unit's touch list, and hand-copying
// the interfaces here would create a structural twin that can rot silently — so
// they are reached by INDEXED ACCESS off the one type the barrel does export.
// A field rename upstream reddens here rather than drifting.

/** One node of the boot-resolved workflow. */
type DeclaredWorkflowNode = ParsedWorkflow['nodes'][number];
/** A node's `[workflows.nodes.briefing]` table, as the parser produced it. */
type DeclaredBriefing = NonNullable<DeclaredWorkflowNode['briefing']>;
/** The manifest's permission vocabulary: `default | plan` (manifest.ts:180). */
type DeclaredPermissionMode = DeclaredWorkflowNode['properties']['permissionMode'];

// ── §3.4: the permission footing a DISPATCHED spawn gets ────────────────────

/**
 * The ENGINE's footing for a dispatched session — the vocabulary the session
 * host's `spawnSession` takes (`permissionMode: 'plan' | 'auto'`).
 *
 * ⚠ **`auto` IS NOT TENANT VOCABULARY, AND THAT IS THE WHOLE OF §3.4.** The
 * manifest says `default | plan`; the SDK says `plan | auto`. The two are
 * different alphabets on purpose: `auto` names an Anthropic-SDK footing, and
 * admitting it into a tenant document would put a vendor's word inside the
 * declaration — exactly the drift rule 0.6 fences. So the mapping lives HERE, at
 * the engine boundary, and is stated once.
 */
export type DispatchedPermissionFooting = 'plan' | 'auto';

/**
 * §3.4's mapping, and the ONLY place it is written:
 *
 *   • declared `plan`    → `'plan'` (+ capture per §3.7);
 *   • declared `default` → `'auto'`, the engine's footing for a DISPATCHED
 *     session (D50: server-side classifier, no per-tool gate).
 *
 * ABSENT is not a third case: the parser DEFAULTS a node's `permission_mode` to
 * `'default'` when the key is missing (manifest.ts's node-property base), so an
 * absent key arrives here already spelled `default` and lands on `'auto'` —
 * which is what "declared `default` or ABSENT → the engine's dispatched footing"
 * means in code.
 *
 * ⚠ EXHAUSTIVE SWITCH, NO `default:` ARM. A third member of the manifest's
 * permission vocabulary must break this build rather than fall silently into one
 * of today's two footings — an unclassified mode would spawn a real worker under
 * a footing nobody chose.
 */
export function dispatchedFootingFor(mode: DeclaredPermissionMode): DispatchedPermissionFooting {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'default':
      return 'auto';
  }
}

// ── §3.6: the ENGINE-KNOWN report tool ids — RE-EXPORTED FROM CORE ──────────
//
// ⚠ **THE CONSTANTS MOVED; THE "ONE PLACE" CONTRACT DID NOT.** S19·U1 authored
// `ENGINE_REPORT_TOOL_SERVER` / `_NAMES` / `_IDS` / `isEngineKnownToolId` right
// here, under a documented contract that this is the ONE place the id set is
// written in the declaration path. Slice-20 §3.5 needs the SAME set inside
// core's manifest parser (the `acceptance.report` catalogue rules) and core
// cannot import from the daemon — so the constants RE-HOMED to
// `packages/core/src/extensions/reportVerbs.ts`, beside the body schemas they
// map to, and this module re-exports them unchanged.
//
// The contract is re-pointed, not weakened: `reportVerbs.ts` is now the one
// place, every daemon consumer here keeps importing from
// `briefingDeclarations.ts` exactly as before, and the machine check that ties
// the set to the session host — `briefingPreflight.test.ts`'s A2 differential —
// passes UNCHANGED across the relocation. That differential is what makes this a
// move rather than a copy: a second spelling anywhere would redden it.
export {
  ENGINE_REPORT_TOOL_SERVER,
  ENGINE_REPORT_TOOL_NAMES,
  ENGINE_REPORT_TOOL_IDS,
  ENGINE_REPORT_VERB_BODIES,
  isEngineKnownToolId,
  type EngineReportBodyKind,
} from '@vimes/core';

// ── the answer this module gives ─────────────────────────────────────────────

/**
 * What the boot declaration says about ONE node's briefing — the five facts
 * dispatch needs, and nothing else.
 */
export interface NodeBriefingDeclaration {
  /** The node this was read from, echoed so a caller never has to re-derive it. */
  readonly nodeId: string;
  /** `[…].briefing.composer` — an entry-point STRING, resolved by the tenant. */
  readonly composerEntryPoint: string;
  /** `[…].briefing.inputs` — the declared rows, in declaration order. */
  readonly inputRows: readonly string[];
  /** `[…].briefing.tools` — declared tool IDS, never specs (§3.6). */
  readonly toolIds: readonly string[];
  /** The NODE's `permission_mode`, mapped to the engine's footing (§3.4). */
  readonly permissionFooting: DispatchedPermissionFooting;
  /** `[…].briefing.capture` — the declared interceptions (§3.7). */
  readonly capture: readonly string[];
}

/**
 * Why a node has no briefing declaration to read. TWO reasons, kept apart
 * because they are different operator errors: a node id nothing declares (a
 * plumbing bug, or a stage vocabulary that drifted from the workflow's node
 * ids), and a declared node that simply carries no `[…].briefing` table (a
 * non-dispatchable node, by construction — recon fact 1 — or a dispatchable one
 * whose declaration is incomplete).
 */
export type BriefingDeclarationAbsence = 'unknown-node' | 'node-declares-no-briefing';

/** The total answer: a declaration, or a named absence. NEVER a throw. */
export type BriefingDeclarationLookup =
  | { readonly declared: true; readonly declaration: NodeBriefingDeclaration }
  | { readonly declared: false; readonly absence: BriefingDeclarationAbsence };

/**
 * Read one node's briefing declaration off the BOOT-RESOLVED workflow.
 *
 * PURE and TOTAL. The workflow is the same object `InstanceWriter` adjudicates
 * against (§3.3); this function does not re-resolve, re-parse, or cache it.
 */
export function readNodeBriefingDeclaration(
  workflow: ParsedWorkflow,
  nodeId: string,
): BriefingDeclarationLookup {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return { declared: false, absence: 'unknown-node' };
  }
  const briefing: DeclaredBriefing | undefined = node.briefing;
  if (briefing === undefined) {
    return { declared: false, absence: 'node-declares-no-briefing' };
  }
  return {
    declared: true,
    declaration: {
      nodeId: node.id,
      composerEntryPoint: briefing.composer,
      inputRows: briefing.inputs,
      toolIds: briefing.tools,
      // ⚠ THE NODE IS THE ONLY HOME (§3.4). `ParsedBriefing` carries no
      // `permissionMode` at all as of S19·U1 — the briefing-level key is a named
      // parser refusal now — so there is nothing to fall back to and no
      // resolution rule to get wrong.
      permissionFooting: dispatchedFootingFor(node.properties.permissionMode),
      capture: briefing.capture,
    },
  };
}
