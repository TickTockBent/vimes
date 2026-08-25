import type {
  ReportCompletionPayload,
  ReportReviewPayload,
  StageRunnerPlan,
  TaskRecord,
} from '@vimes/ext-host';
import { composeStageInstruction, type StageInstructionContext } from './stageInstruction.js';

// ─── S19·U1 (slice-19 §3.1) — the Tier-1 COMPOSER TABLE ──────────────────────
//
// The manifest's `[workflows.nodes.briefing].composer` is an ENTRY-POINT
// STRING, and node-kit §1.8.1's law is that only its NAME is declarative — "the
// prose is code." This module is where that name is resolved: a table from
// entry-point string to composer, exported by the tenant that owns the words.
//
// ⚠ **ZERO PROSE BYTES MOVE HERE, AND `composeStageInstruction` IS UNTOUCHED.**
// Every entry below is a THIN WRAPPER that reconstructs today's
// `(task, plan, context)` call from an engine-assembled input set. The
// specialisation per stage lives INSIDE the prose module (it branches on
// `task.stage`), which is exactly why the four wrappers share one body: the
// table's distinction is the KEY, not the prose. A1's 37 goldens are the
// instrument that keeps that honest.
//
// ⚠ **NO FALLBACK ENTRY, EVER.** An entry-point string this table does not
// carry is a PREFLIGHT REFUSAL (slice-19 §3.5), not a quiet degrade to a
// generic briefing: a node whose composer could not be resolved must spawn
// nothing rather than dispatch a worker with the wrong words.

// ── the TENANT-SIDE input types (slice-19 A7 ⟨signed⟩) ───────────────────────
//
// The engine declares `BriefingInputSet` in core; this is its STRUCTURAL TWIN,
// declared LOCALLY and derived from the already-surfaced `TaskRecord`. The two
// are joined where both are legal imports — the daemon — and never here:
// `packages/ext-host/surface.json` is signed and does NOT grow for this slice,
// so the tenant expresses the projected record as the `Omit` it is rather than
// importing an engine type through a widened surface.

/**
 * The record a composer receives for the `instance.record` input kind: the task
 * record MINUS exactly the three fields that ARE other input kinds' content
 * (slice-19 §3.2). The engine's `projectInstanceRecord` produces it; the twin
 * below is how the tenant names it.
 *
 * All three omitted fields are OPTIONAL upstream, which is what keeps a
 * projected record usable wherever a full record is expected — the projection
 * removes keys that were always allowed to be absent, and adds nothing.
 */
export type ProjectedTaskRecord = Omit<
  TaskRecord,
  'lastReview' | 'lastCompletion' | 'planArtifactHash'
>;

/**
 * What a composer is handed: ONLY the input kinds its node DECLARED, and among
 * those only the ones that turned out to be present. Every field is optional
 * for two different reasons — undeclared (the engine never read it) and
 * declared-but-absent (it read, and there was nothing) — and a composer treats
 * them the same way.
 */
export interface BriefingInputs {
  /** `instance.record` — the projection, never the raw record. */
  readonly record?: ProjectedTaskRecord;
  /** `artifact:plan` — the approved plan's text. */
  readonly planText?: string;
  /** `report:last-review` — the review that failed the previous attempt. */
  readonly lastReview?: ReportReviewPayload;
  /** `report:last-completion` — the previous attempt's worklog. */
  readonly lastCompletion?: ReportCompletionPayload;
}

/** A Tier-1 briefing composer: an input set in, the briefing's bytes out. */
export type BriefingComposer = (inputs: BriefingInputs) => string;

// ── the degenerate second argument (slice-19 §0.7) ───────────────────────────
//
// The prose module's second parameter is a `StageRunnerPlan`, and that union
// has been SINGLE-VALUED since D46 deleted the resume variant: `{mode:'spawn'}`
// is the only value there is. It is an ENGINE fact with no input-kind home, and
// it is degenerate — so it never crosses the declaration boundary and is
// supplied HERE, inside the wrapper, as the constant it is. If the union ever
// grows a second member, this constant is the site that has to be reconsidered
// (and slice-19's kill criterion is the rule that says so).
const SPAWN: StageRunnerPlan = { mode: 'spawn' };

/**
 * Rebuild today's optional third argument from the input set.
 *
 * ⚠ **ABSENT STAYS ABSENT, AND AN EMPTY CONTEXT IS `undefined`.** Both halves
 * are byte-load-bearing and are lifted verbatim from the dispatcher's own
 * idiom: a present-but-`undefined` key is not the same as an absent one, and an
 * EMPTY context must be passed as no context at all, because that is what keeps
 * a first-pass briefing byte-identical to the call shape that predates the
 * context parameter.
 *
 * The mapping is §3.2's, one input kind per field: plan text → `plan`; the
 * review's `criteria` and the completion's `worklog` → the fix-seed's two
 * halves. Nothing else is reachable — the engine assembled only what the node
 * declared, so a kind this task's node never named is not merely unread here,
 * it is not in the set.
 */
function reconstructContext(inputs: BriefingInputs): StageInstructionContext | undefined {
  const reviewFeedback = inputs.lastReview?.criteria;
  const worklog = inputs.lastCompletion?.worklog;
  const context: StageInstructionContext = {
    ...(inputs.planText === undefined ? {} : { plan: inputs.planText }),
    ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
    ...(worklog === undefined ? {} : { worklog }),
  };
  return Object.keys(context).length === 0 ? undefined : context;
}

/**
 * The one wrapper body, shared by all four entries.
 *
 * ⚠ A briefing that did not declare `instance.record` cannot be composed: every
 * briefing in this tenant is ABOUT an instance, and there is no honest text to
 * emit without one. It THROWS, deliberately — slice-19 §3.5 makes compose-threw
 * a pre-spawn refusal that creates no worktree and spawns nothing, which is the
 * correct outcome for a declaration that omitted the thing it is describing.
 * A silent empty briefing would dispatch a worker with no work order.
 */
function composeFromInputs(entryPoint: string, inputs: BriefingInputs): string {
  const record = inputs.record;
  if (record === undefined) {
    throw new Error(
      `"${entryPoint}" needs the \`instance.record\` input, and this node's briefing did not declare it.`,
    );
  }
  // The projection is assignable here precisely BECAUSE the three fields it
  // removes are optional upstream — see `ProjectedTaskRecord`. The prose module
  // therefore reads exactly the fields the declaration allowed it to see, and
  // the undeclared report kinds are unreachable rather than merely unread.
  return composeStageInstruction(record, SPAWN, reconstructContext(inputs));
}

/**
 * The Tier-1 composer table: entry-point string → composer. EXACTLY the four
 * entries this tenant declares, and no fallback row.
 *
 * `briefings/planning`, `briefings/implementing` and `briefings/review` are the
 * three the shipped manifest names (they are also, by construction, the whole
 * dispatchable domain — recon fact 1). `briefings/generic` is the fourth: the
 * stage-generic briefing the prose module falls through to, given a name so a
 * node that wants it can declare it rather than reaching it by accident.
 */
export const briefingComposers: Record<string, BriefingComposer> = {
  'briefings/planning': (inputs) => composeFromInputs('briefings/planning', inputs),
  'briefings/implementing': (inputs) => composeFromInputs('briefings/implementing', inputs),
  'briefings/review': (inputs) => composeFromInputs('briefings/review', inputs),
  'briefings/generic': (inputs) => composeFromInputs('briefings/generic', inputs),
};
