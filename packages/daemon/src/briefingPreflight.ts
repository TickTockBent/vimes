import { assembleBriefingInputs } from '@vimes/core';
import type {
  ArtifactStore,
  BriefingInputReads,
  BriefingInputRefusalReason,
  BriefingInputSet,
  ParsedWorkflow,
  TaskRecord,
} from '@vimes/core';
import type { BriefingComposer } from '@vimes/ext-tasks';

import {
  isEngineKnownToolId,
  readNodeBriefingDeclaration,
  type DispatchedPermissionFooting,
} from './briefingDeclarations.js';

// ─── S19·U2 (slice-19 §3.5/§3.6/§3.7) — THE DISPATCH PREFLIGHT ───────────────
//
// One question, one answer: **can this node's declared briefing actually be
// turned into a briefing — and if so, what does dispatch spawn with?**
//
// ── why a PREFLIGHT exists at all (§3.5, recon fact 5) ───────────────────────
//
// Briefing delivery is POST-SPAWN today: `spawnStageRun` starts a session and
// `deliverStageInstruction` composes and sends afterwards, so a composition
// failure lands as `not-delivered` on a task that ALREADY has a live worker
// sitting in a real directory with no instructions. That is tolerable while the
// words are compiled in and cannot fail; it stops being tolerable the moment the
// words come from a TENANT DECLARATION, where an unresolvable entry point, an
// unknown tool id or a composer that throws are all reachable states.
//
// So resolution moves BEFORE the side effects:
//
//   resolve the composer → validate the tool ids → validate the capture combo
//     → assemble the declared inputs → INVOKE the composer, keeping the string
//
// and a failure at ANY of those five steps **creates no worktree, spawns
// nothing, and emits no event** — it is RETURNED to the caller, exactly as
// `worktree-failed` behaves today.
//
// ⚠ **THE RESULT UNION DOES NOT GROW, AND THAT IS A DELIBERATE CONSTRAINT**
// (§3.5, §2). The dispatch routes serialize `DispatchAttemptResult` VERBATIM, so
// a new outcome member would be a wire change slice 19 explicitly forbids. A
// preflight refusal therefore reuses the EXISTING `spawn-failed` outcome and
// carries its precision in the reason string, spelled by
// `briefingUnresolvableReason` below: `briefing-unresolvable:<sub-reason>`. The
// `spawn-failed` reason field has always been "the host's reason string,
// verbatim" — an opaque string to every consumer — so widening what can appear
// in it is not a contract change.
//
// ⚠ **NOT WIRED IN THIS UNIT.** `TaskDispatcher` takes this as an OPTIONAL
// injected dep and never calls it; the compiled path composes post-spawn exactly
// as it did yesterday, byte for byte. S19·U3 is the flip, and by construction it
// is a CALL-SITE change: the machinery, the refusal vocabulary and the
// differential all land here first.
//
// Rule 0.3: the ONE piece of I/O (the artifact store) is injected, and the
// declaration is injected too — §3.3's one-boot-declaration law means this
// module must never resolve a manifest of its own.

// ── the refusal vocabulary (§3.5) ────────────────────────────────────────────

/**
 * Why the preflight refused. CLOSED, and authored nowhere but this file.
 *
 * Seven members, from three sources, and the split is worth reading:
 *
 *   • `composer-unresolvable` / `unknown-tool-id` / `invalid-capture-combo` —
 *     the three DECLARATION checks this module performs itself;
 *   • `unknown-artifact-id` / `unknown-report-kind` / `unknown-input-kind` —
 *     core's `briefingInputRefusalReasonSchema`, carried through UNRENAMED so
 *     the two vocabularies stay one vocabulary (the map below is exhaustive by
 *     construction, not by convention);
 *   • `compose-threw` — the tenant's own composer refusing the job.
 *
 * ⚠ **A NODE WITH NO BRIEFING LANDS ON `composer-unresolvable`, DELIBERATELY.**
 * §3.5 signs off exactly these sub-reasons and this module does not invent an
 * eighth: a node that declares no `[…].briefing` table has NO ENTRY POINT TO
 * RESOLVE, which is the strongest possible reading of "unresolvable composer"
 * rather than a different failure wearing its name. The distinction an operator
 * needs — "the node has no briefing" vs "the table has no such entry" — is
 * available from the declaration itself, one lookup away, and does not need to
 * ride the wire.
 */
export const BRIEFING_PREFLIGHT_SUB_REASONS = [
  'composer-unresolvable',
  'unknown-tool-id',
  'invalid-capture-combo',
  'unknown-artifact-id',
  'unknown-report-kind',
  'unknown-input-kind',
  'compose-threw',
] as const;

/** One member of the closed preflight refusal vocabulary. */
export type BriefingPreflightSubReason = (typeof BRIEFING_PREFLIGHT_SUB_REASONS)[number];

/**
 * The `spawn-failed` reason a preflight refusal is surfaced as (§3.5's
 * wire-stable spelling). ONE function, so the prefix is written once and the
 * route, the dispatcher and every test read the same string.
 */
export const BRIEFING_UNRESOLVABLE_REASON_PREFIX = 'briefing-unresolvable';

/** `briefing-unresolvable:<sub-reason>` — the whole of the wire vocabulary. */
export function briefingUnresolvableReason(subReason: BriefingPreflightSubReason): string {
  return `${BRIEFING_UNRESOLVABLE_REASON_PREFIX}:${subReason}`;
}

/**
 * Map ONE of core's assembly refusals onto this module's vocabulary.
 *
 * ⚠ **EXHAUSTIVE SWITCH, NO `default:` ARM** — the house way of proving a map
 * TOTAL. A new member of `briefingInputRefusalReasonSchema` breaks this build
 * rather than falling into a catch-all that would report the wrong cause (or,
 * worse, a plausible one). The names are carried through unchanged on purpose: a
 * rename here would be a second vocabulary for one fact.
 */
function subReasonForAssemblyRefusal(
  reason: BriefingInputRefusalReason,
): BriefingPreflightSubReason {
  switch (reason) {
    case 'unknown-artifact-id':
      return 'unknown-artifact-id';
    case 'unknown-report-kind':
      return 'unknown-report-kind';
    case 'unknown-input-kind':
      return 'unknown-input-kind';
  }
}

// ── §3.7: which capture the engine can actually arm ──────────────────────────

/**
 * The declared capture that arms plan harvesting. The manifest's interception
 * catalogue is CLOSED and v1 holds exactly this one entry (node-kit §1.8.3), so
 * a parser-legal `capture` list is either empty or `["plan"]` — but the arming
 * test is written against the NAME rather than against emptiness, because
 * "non-empty" would silently arm plan capture for a future second interception.
 */
export const PLAN_CAPTURE_NAME = 'plan';

// ── the preflight's answer ───────────────────────────────────────────────────

/** What a SUCCESSFUL preflight hands the dispatch that follows it. */
export interface BriefingPreflightSuccess {
  readonly ok: true;
  /**
   * The composed briefing, RETAINED for post-spawn delivery (§3.5). Composition
   * has already happened by the time a session exists, which is what shrinks
   * post-spawn `not-delivered` to SEND-time failures only.
   */
  readonly composed: string;
  /** The declared tool IDS, every one of them engine-known (§3.6). */
  readonly toolIds: readonly string[];
  /** §3.4's mapping applied to the NODE's declared permission mode. */
  readonly permissionFooting: DispatchedPermissionFooting;
  /** The declared captures, verbatim. */
  readonly capture: readonly string[];
  /**
   * Whether plan capture is ARMED — derived from the DECLARATION alone (§3.7),
   * never from the permission mode.
   *
   * ⚠ **THIS IS THE FIELD THE SHIPPED MANIFEST CANNOT PROVE ANYTHING ABOUT.**
   * Today's arming keys off `permissionMode === 'plan'` (sessionHost.ts:754) and
   * the shipped planning node declares BOTH `permission_mode = "plan"` and
   * `capture = ["plan"]` — so the two agree on every node that exists, and a
   * differential run against the shipped manifest alone would pass while proving
   * nothing. §3.7's perturbation cells are where they part, and they are
   * exercised against TEST-LOCAL declarations for exactly that reason.
   */
  readonly planCaptureArmed: boolean;
}

/** A preflight refusal: the sub-reason, and — for one reason only — a detail. */
export interface BriefingPreflightRefusal {
  readonly ok: false;
  readonly reason: BriefingPreflightSubReason;
  /**
   * LOGGING ONLY, NEVER WIRE. §3.5 pins the wire vocabulary at
   * `briefing-unresolvable:<sub-reason>` and nothing wider — the routes serialize
   * `DispatchAttemptResult` verbatim, so a thrown value's text has no business
   * riding that string. But the detail is not nothing: an operator staring at
   * `briefing-unresolvable:compose-threw` in the daemon's own log deserves to
   * know WHAT the tenant composer threw, which is why this field exists at all
   * (S19·U3, the flip's call-site rider). Present ONLY when
   * `reason === 'compose-threw'`; every other refusal reason carries no detail
   * because the check that produced it already IS the whole explanation.
   */
  readonly detail?: string;
}

/** TOTAL: every (task, declaration, table) triple maps to one of these two. */
export type BriefingPreflightResult = BriefingPreflightSuccess | BriefingPreflightRefusal;

// ── the daemon-side reads adapter ────────────────────────────────────────────

/**
 * Build the INJECTED reads `assembleBriefingInputs` needs, carrying **today's
 * degrade semantics exactly** — this function is a transcription of
 * `deliverStageInstruction`'s behaviour, not a reinterpretation of it, because
 * A2 asks for BYTE-IDENTICAL briefings and a differently-shaped degrade would
 * show up as a byte difference on the very tasks the degrade exists for.
 *
 * The four reads, and where each of today's rules comes from:
 *
 *   • `readInstanceRecord` — the record the dispatcher was handed. Core
 *     PROJECTS it (§3.2); this adapter does not, because projecting here would
 *     put the classification in two places.
 *   • `readPlanText` — the ONE piece of I/O. ABSENT HASH → NO FETCH AT ALL (the
 *     store is not consulted, so a task that never planned costs nothing); a
 *     `null` blob → `undefined`; a THROW → `undefined`. All three are
 *     `deliverStageInstruction`'s rules verbatim: "a failed blob read is not a
 *     failed dispatch — degrade to no plan."
 *   • `readLastReview` / `readLastCompletion` — NO I/O AT ALL, straight off the
 *     record, because both are FOLDED FIELDS (S7·7b-core folds `report_filed`
 *     into them) and a fix-seed that needed a fetch would need a degrade path of
 *     its own.
 *
 * ⚠ **EVERY READ IS TOTAL — it returns `undefined`, it never throws.** That is
 * `BriefingInputReads`'s stated contract and the reason core's assembly can
 * promise totality: the pure module's guarantee is only as good as its reads.
 */
export function taskBriefingInputReads(
  task: TaskRecord,
  artifactStore: Pick<ArtifactStore, 'getBlob'>,
): BriefingInputReads {
  return {
    readInstanceRecord: () => task,
    readPlanText: () => {
      if (task.planArtifactHash === undefined) {
        return undefined;
      }
      try {
        const planBlob = artifactStore.getBlob(task.planArtifactHash);
        return planBlob === null ? undefined : planBlob;
      } catch {
        return undefined;
      }
    },
    readLastReview: () => task.lastReview,
    readLastCompletion: () => task.lastCompletion,
  };
}

// ── the preflight itself ─────────────────────────────────────────────────────

/** Everything the preflight is INJECTED. It reads nothing else, ever. */
export interface BriefingPreflightDeps {
  /**
   * The BOOT-RESOLVED declaration (§3.3) — the SAME `ParsedWorkflow` object
   * `InstanceWriter` adjudicates against, handed in by `app.ts`. Never
   * re-resolved, never re-parsed, and a rev difference is not a mismatch.
   */
  readonly workflow: ParsedWorkflow;
  /**
   * The tenant's composer table (§3.1) — `briefingComposers` from
   * `@vimes/ext-tasks`. Injected rather than imported here so a test can hand
   * over a SPY table and observe exactly what a composer was given (A3).
   */
  readonly composers: Readonly<Record<string, BriefingComposer>>;
  /** The content-addressed blob store the `artifact:plan` row fetches from. */
  readonly artifactStore: Pick<ArtifactStore, 'getBlob'>;
}

/**
 * Resolve, validate, assemble and COMPOSE one task's briefing — before any
 * worktree exists and before anything spawns.
 *
 * TOTAL and side-effect-free apart from the one injected store read: it emits
 * nothing, spawns nothing, creates nothing, and never throws (a composer that
 * throws is CAUGHT and becomes a refusal, which is the entire point of doing
 * this before the side effects rather than after them).
 *
 * The node is the task's own stage. That is not a shortcut: `decideDispatch`
 * returns `{ action: 'spawn', stage: task.stage }` (dispatchDecision.ts:326), so
 * the decision's stage and the record's stage are the same fact, and reading it
 * off the record keeps this function callable without a decision in hand.
 */
export function preflightBriefing(
  task: TaskRecord,
  deps: BriefingPreflightDeps,
): BriefingPreflightResult {
  // ── step 0: the declaration (§3.3) ─────────────────────────────────────────
  const lookup = readNodeBriefingDeclaration(deps.workflow, task.stage);
  if (!lookup.declared) {
    // Both absences: no entry point exists, so there is nothing to resolve. See
    // `BRIEFING_PREFLIGHT_SUB_REASONS` for why this does not get a name of its
    // own.
    return { ok: false, reason: 'composer-unresolvable' };
  }
  const declaration = lookup.declaration;

  // ── step 1: resolve the composer entry point (§3.1/§3.5) ──────────────────
  //
  // NO FALLBACK ROW, EVER. A generic briefing served in place of an unresolvable
  // one would dispatch a real worker with the wrong words — the failure mode a
  // loud refusal exists to prevent.
  const composer = deps.composers[declaration.composerEntryPoint];
  if (composer === undefined) {
    return { ok: false, reason: 'composer-unresolvable' };
  }

  // ── step 2: validate every declared tool id (§3.6) ────────────────────────
  //
  // FAIL-CLOSED, and BEFORE the spawn precisely because specs cannot exist yet:
  // a report-tool spec closes over the freshly allocated `appSessionId`, so the
  // only thing that can cross the seam this early is the ID. A tenant selects
  // among engine tools; it never mints one.
  for (const toolId of declaration.toolIds) {
    if (!isEngineKnownToolId(toolId)) {
      return { ok: false, reason: 'unknown-tool-id' };
    }
  }

  // ── step 3: validate the §3.7 combo ───────────────────────────────────────
  //
  // Capture declared WITHOUT plan mode is a tenant error, refused rather than
  // ignored: the harvest mechanism only exists at the ExitPlanMode boundary, so
  // a node asking for capture under `auto` is asking for an interception that
  // cannot fire. The converse — plan mode WITHOUT capture — is LEGAL and is a
  // real cell (§3.7): the planner runs write-blocked and nothing is harvested.
  if (declaration.capture.length > 0 && declaration.permissionFooting !== 'plan') {
    return { ok: false, reason: 'invalid-capture-combo' };
  }

  // ── step 4: assemble ONLY the declared inputs (§3.2) ──────────────────────
  const assembly = assembleBriefingInputs(
    declaration.inputRows,
    taskBriefingInputReads(task, deps.artifactStore),
  );
  if (!assembly.assembled) {
    return { ok: false, reason: subReasonForAssemblyRefusal(assembly.reason) };
  }

  // ── step 5: INVOKE the composer, and keep the string (§3.5) ───────────────
  //
  // The join of the two structural twins happens on this line and nowhere else:
  // core declares `BriefingInputSet`, `@vimes/ext-tasks` declares
  // `BriefingInputs`, and the daemon is the one package that may legally import
  // both (`packages/ext-host/surface.json` does not grow for this — A7 signed).
  const inputs: BriefingInputSet = assembly.inputs;
  let composed: string;
  try {
    composed = composer(inputs);
  } catch (composeThrown) {
    // ⚠ THE THROWN VALUE NEVER RIDES THE WIRE. §3.5 pins the wire vocabulary at
    // `briefing-unresolvable:<sub-reason>`, and a tenant's exception message is
    // neither a sub-reason nor something the routes' consumers can switch on. The
    // REFUSAL says WHICH step failed; `detail` is the one place the exception's
    // own text survives at all, and it survives ONLY as far as the daemon's own
    // log at the call site (taskDispatcher.ts) — never past it.
    return { ok: false, reason: 'compose-threw', detail: describeThrown(composeThrown) };
  }

  return {
    ok: true,
    composed,
    toolIds: declaration.toolIds,
    permissionFooting: declaration.permissionFooting,
    capture: declaration.capture,
    planCaptureArmed: declaration.capture.includes(PLAN_CAPTURE_NAME),
  };
}

// A one-line description of a thrown value — never a stack, never a payload
// dump. The SAME shape `taskDispatcher.ts`'s own `describeThrown` produces
// (deliberately not imported from there: this module does not depend on the
// dispatcher, and the two describe the identical thing independently rather
// than share an import for one three-line function).
function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
