import {
  captureRecorded,
  evaluateAcceptance,
  reportFiled,
  type AcceptanceEvidence,
  type AcceptanceEvaluation,
  type AcceptanceUnevaluableReason,
  type EventInput,
  type ParsedWorkflow,
  type ReportCompletionPayload,
  type ReportReviewPayload,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import {
  acceptanceFor,
  nodeDeclaringReportVerb,
  type AcceptanceDeclarationAbsence,
} from './acceptanceDeclarations.js';

// ─── S20·U2 (slice-20 §3.3/§3.4/§3.7) — THE DECLARED ROUTING PATH ────────────
//
// One question: **a report was filed / a capture was taken by THIS session —
// which instance does it belong to, what identity does the fact carry, and where
// does the declaration send the instance next?**
//
// ⚠ **NOTHING CALLS THIS YET, AND NOTHING FLIPPED IN U2.** The three compiled
// routings in `taskDispatcher.ts` (`recordPlan` :892, `recordReview` :988,
// `recordCompletion` :1080) still govern production byte-for-byte; this module is
// the DECLARED half built BESIDE them, and `acceptanceRouting.differential.test.ts`
// is the instrument that proves the two agree cell for cell. U3 is what swaps each
// `record*` body onto one call here and deletes the compiled half — rule 0.5, the
// shapes land first and the consumer arrives next.
//
// ── what "declared" means here, concretely (§0.5's four literal classes) ─────
//
// The compiled halves spell a stage literal FOUR times per path, and slice-20
// §3.3 requires all four to derive from ONE resolved node id — a partial
// derivation is the internally inconsistent identity Sol round-2 P1b names (an
// attempt filter keyed on a literal while the lookup is keyed on a declaration
// yields `attempt: 0`, which `report_filed`'s schema forbids). So every function
// below resolves the node id ONCE, at the top, and the four consumers read that
// one binding:
//
//   (a) the reverse-lookup key      — `sessionRef.stage === resolvedNodeId`
//   (b) the attempt-count filter    — over the SAME `resolvedNodeId`
//   (c) the emitted identity        — `node: resolvedNodeId`
//   (d) plan-only: the envelope     — `taskRef.stage: resolvedNodeId`
//
// ── EVERYTHING INJECTED, NOTHING STATEFUL, NEVER A THROW ────────────────────
//
// These functions take the boot-resolved `ParsedWorkflow` and a `readTasks()`
// snapshot and return a DECISION. No clock, no id source, no artifact store, no
// event bus, no module-level state (rule 0.3) — and no `throw` on any input: a
// verb nothing declares, a session no task claims, a node with no acceptance
// table are each a TYPED result. A throw at this depth would surface as an
// unhandled rejection inside a report-filing callback, after the report had
// already been recorded.
//
// ⚠ **IT DECIDES, IT DOES NOT ACT.** Nothing here emits, stores, or proposes.
// The caller (U3) does all three, in the order the `record*` contract fixes —
// store the blob → emit the fact → propose the move — and the move still goes
// through `instanceWriter.proposeMove` (I7's choke point). And there is NO
// LOGGING in this unit: the typed `unevaluable` reason IS the whole interface,
// and the one-warning discipline (§3.6) is U3's wiring decision, not a side
// effect buried in a decision function.

// ── the payload types, DERIVED from the event factories rather than retyped ──
//
// `CaptureRecordedPayload` and `ReportFiledPayload` are declared in core's
// `events.ts` and are not on core's barrel (which exports a NAMED list). Widening
// that barrel is not this unit's business and hand-copying the shapes would
// create structural twins that rot silently — so they are reached off the two
// FACTORIES the barrel does export, which is the same "derive, never re-declare"
// idiom `briefingDeclarations.ts` uses for `ParsedBriefing`. A payload field
// renamed upstream reddens here rather than drifting.
type CaptureRecordedPayload = Parameters<typeof captureRecorded>[0];
type ReportFiledPayload = Parameters<typeof reportFiled>[0];

/**
 * The `capture_recorded` payload MINUS `artifactHash`.
 *
 * ⚠ **THE HASH IS THE CALLER'S, AND THAT IS THE POINT.** A content hash only
 * exists after the blob has been PUT, and the store is I/O — so a pure decision
 * function cannot produce one without becoming impure. The routing carries every
 * DECLARED field of the payload (§0.5(c)'s identity included) and the caller
 * completes it with the hash its own `artifactStore.put` returned, preserving the
 * `record*` store→emit ordering contract: the hash the event carries always names
 * content that already exists.
 */
export type DeclaredCapturePayload = Omit<CaptureRecordedPayload, 'artifactHash'>;

/**
 * A capture's NAME, taken from the event payload's own closed vocabulary rather
 * than widened to `string`. `capture_recorded.captureKind` is the catalogue
 * (§1.8.3's one entry, `'plan'`), and typing the input as anything looser would
 * let a caller ask this module to route a capture the log cannot record.
 */
export type DeclaredCaptureName = CaptureRecordedPayload['captureKind'];

/**
 * The artifact envelope's DECLARED metadata — `ArtifactPutMeta` minus `createdAt`.
 *
 * Same rule as the hash above: `createdAt` comes from the injected clock, which
 * is the caller's (rule 0.3). What this carries is §0.5(d)'s identity —
 * `taskRef.stage` derived from the resolved node id rather than the literal
 * `'planning'` the compiled half spells — plus the kind and the rev, which is
 * exactly what slice-20 A2 compares.
 */
export interface DeclaredCaptureEnvelope {
  readonly kind: string;
  readonly taskRef: { readonly taskId: string; readonly stage: string };
  readonly rev: number;
  readonly createdBy: { readonly appSessionId: string };
}

/**
 * Why a routing produced NOTHING AT ALL — not even a recorded fact.
 *
 * A CLOSED vocabulary, and deliberately distinct from `unevaluable`: these are the
 * cases where the compiled half `return`s early, before it emits anything, so the
 * declared half must too or the differential is comparing a no-op against a
 * recorded event.
 */
export type DeclaredRoutingNoOpReason =
  /** §3.3/A5 — no node's `acceptance.report` names this verb (the preserved guard). */
  | 'verb-not-declared'
  /** No node's `briefing.capture` arms this capture name — the capture twin of the above. */
  | 'capture-not-declared'
  /** No task carries a session ref binding this session to the resolved node. */
  | 'no-owning-task'
  /** The compiled empty-plan guard, preserved: a whitespace-only capture captured nothing. */
  | 'empty-capture';

/**
 * Why a table could not be judged, WIDENED by the two declaration-lookup absences.
 *
 * The evaluator's own reasons cover the evidence side; `acceptanceFor` can also
 * answer "no such node" / "that node declares no acceptance". The first is
 * unreachable through a report (the node was found BY its acceptance table) but is
 * mapped rather than asserted, because this module never throws. The second IS
 * reachable on the capture path: a node may arm a capture and declare no
 * acceptance at all (node-kit §1.8.4 (f) NONE), and the honest answer is that the
 * capture records and nothing routes.
 */
export type DeclaredRoutingUnevaluableReason =
  | AcceptanceUnevaluableReason
  | AcceptanceDeclarationAbsence;

/**
 * Where the declaration sends the instance, once the fact has been recorded.
 *
 *   • `propose`     — the declaration named a target; the caller proposes it
 *                     through `instanceWriter.proposeMove` (I7), never directly.
 *   • `rest`        — evaluated fine, no target declared (§3.4 UNSET MEANS REST),
 *                     or the evidence is genuinely incomplete (§3.6).
 *   • `unevaluable` — a named reason, never a guess. The fact still recorded.
 */
export type DeclaredOutcome =
  | { readonly kind: 'propose'; readonly toStage: string }
  | { readonly kind: 'rest' }
  | { readonly kind: 'unevaluable'; readonly reason: DeclaredRoutingUnevaluableReason };

/** The D46 identity tuple, all four fields derived from the one resolved node id. */
export interface DeclaredIdentity {
  readonly instanceId: string;
  readonly node: string;
  readonly attempt: number;
  readonly payloadRev: number;
}

/**
 * The total answer for a filed REPORT: a no-op, or the fact to record plus where
 * to go afterwards.
 *
 * ⚠ **THE FACT IS NOT CONDITIONAL ON THE ROUTING** — `event` is present on every
 * `record` result, including the `rest` and `unevaluable` ones. That is §3.4's
 * "fact before consequence" made structural: a caller cannot accidentally skip
 * the report because nothing routed, because the routing is a FIELD of the result
 * that carries the event, not an alternative to it.
 */
export type DeclaredReportRouting =
  | { readonly kind: 'no-op'; readonly reason: DeclaredRoutingNoOpReason }
  | {
      readonly kind: 'record';
      readonly taskId: string;
      readonly identity: DeclaredIdentity;
      /** The COMPLETE `report_filed` event — the factories stamp nothing (events.ts). */
      readonly event: EventInput;
      readonly outcome: DeclaredOutcome;
    };

/**
 * The total answer for a recorded CAPTURE. Same shape as the report case, minus
 * the completed event and plus the two halves the caller finishes: the envelope
 * metadata to `put` with, and the capture payload to emit with the resulting hash.
 */
export type DeclaredCaptureRouting =
  | { readonly kind: 'no-op'; readonly reason: DeclaredRoutingNoOpReason }
  | {
      readonly kind: 'record';
      readonly taskId: string;
      readonly identity: DeclaredIdentity;
      readonly envelope: DeclaredCaptureEnvelope;
      readonly capture: DeclaredCapturePayload;
      readonly outcome: DeclaredOutcome;
    };

// ── the shared inner machinery ──────────────────────────────────────────────

/**
 * §0.5(a) — the REVERSE LOOKUP, keyed on the RESOLVED node id.
 *
 * The compiled halves spell `sessionRef.stage === 'planning' | 'review' |
 * 'implementing'`; this takes whichever node id the declaration resolved. Fresh
 * snapshot in, first match out — the same `Object.values(...).find(...)` the
 * compiled halves run, so the tie-breaking behaviour on a (impossible) double
 * binding is identical rather than merely equivalent.
 */
function taskOwningSessionAtNode(
  tasks: TasksState,
  nodeId: string,
  appSessionId: string,
): TaskRecord | undefined {
  return Object.values(tasks.tasks).find((task) =>
    task.sessionRefs.some(
      (sessionRef) => sessionRef.stage === nodeId && sessionRef.appSessionId === appSessionId,
    ),
  );
}

/**
 * §0.5(b) — the ATTEMPT COUNT, over the SAME resolved node id as the lookup above.
 *
 * ⚠ **THE UNCOUNTED TWIN.** This filter and the lookup MUST read the same binding:
 * a lookup keyed on a declaration paired with a count keyed on a literal returns
 * `0` the moment the two disagree, and `report_filed`'s schema requires a positive
 * int (events.ts:1411) — so the divergence would not be a wrong number, it would
 * be an invalid event. It is a separate function only so the sabotage that pins
 * this has somewhere to bite; the caller passes it the one resolved id.
 */
function attemptsAtNode(task: TaskRecord, nodeId: string): number {
  return task.sessionRefs.filter((sessionRef) => sessionRef.stage === nodeId).length;
}

/** `workOrderRev` defaults to 0 until the first amendment — the record's absent-until-amended field. */
function payloadRevOf(task: TaskRecord): number {
  return task.workOrderRev ?? 0;
}

/**
 * `criteria_from = "instance.acceptanceCriteria"` is a closed one-value vocabulary
 * (§3.2, refused at parse otherwise), so the ONE lookup it names is resolved here
 * and handed to the evaluator, which holds no path language of its own.
 */
function instanceCriterionIdsOf(task: TaskRecord): readonly string[] {
  return task.acceptanceCriteria?.map((criterion) => criterion.id) ?? [];
}

/**
 * The evaluator's answer, mapped onto the caller's vocabulary. ONE place, so
 * "route → propose" and "rest → nothing" cannot be half-applied on one path.
 */
function outcomeOf(evaluation: AcceptanceEvaluation): DeclaredOutcome {
  switch (evaluation.outcome) {
    case 'route':
      return { kind: 'propose', toStage: evaluation.toNode };
    case 'rest':
      return { kind: 'rest' };
    case 'unevaluable':
      return { kind: 'unevaluable', reason: evaluation.reason };
  }
}

/**
 * Read the resolved node's acceptance table and evaluate it — the last step every
 * path shares. The declaration-lookup absences become `unevaluable` rather than
 * exceptions (see `DeclaredRoutingUnevaluableReason`).
 */
function evaluateAtNode(
  workflow: ParsedWorkflow,
  nodeId: string,
  evidence: AcceptanceEvidence,
  instanceCriterionIds: readonly string[],
): DeclaredOutcome {
  const declaration = acceptanceFor(workflow, nodeId);
  if (!declaration.declared) {
    return { kind: 'unevaluable', reason: declaration.absence };
  }
  return outcomeOf(evaluateAcceptance(declaration.acceptance, evidence, { instanceCriterionIds }));
}

// ── the REPORT paths (`recordReview` / `recordCompletion`, declared) ─────────

/** What both report routings need, before the body that distinguishes them. */
export interface DeclaredReportRoutingInput {
  /** The BOOT-RESOLVED declaration — F2's one-boot-declaration law, injected, never re-resolved. */
  readonly workflow: ParsedWorkflow;
  /** A FRESH `readTasks()` snapshot; the caller reads it, this never caches one. */
  readonly tasks: TasksState;
  /** The session that filed the report. */
  readonly appSessionId: string;
  /** The verb it filed through — the whole of the §3.3 binding. */
  readonly verbId: string;
}

/**
 * The shared body of both report routings. They differ ONLY in the verb the
 * caller passes and the body they carry, so the binding, the identity, the
 * ordering and the evaluation are written once — a second copy is how the two
 * paths drift into disagreeing about what `attempt` counts.
 */
function declaredReportRouting(
  input: DeclaredReportRoutingInput,
  buildPayload: (identity: DeclaredIdentity) => ReportFiledPayload,
  evidenceCriteria: ReportReviewPayload['criteria'] | undefined,
): DeclaredReportRouting {
  // 1. THE BINDING (§3.3): which node's acceptance does this verb satisfy? A verb
  // no node declares is A5's preserved guard — a spurious call is a total no-op,
  // the same answer the compiled half gives a session no task claims.
  const binding = nodeDeclaringReportVerb(input.workflow, input.verbId);
  if (!binding.bound) {
    return { kind: 'no-op', reason: 'verb-not-declared' };
  }
  const resolvedNodeId = binding.nodeId;

  // 2. THE REVERSE LOOKUP (§0.5(a)), keyed on the resolved id.
  const owningTask = taskOwningSessionAtNode(input.tasks, resolvedNodeId, input.appSessionId);
  if (owningTask === undefined) {
    return { kind: 'no-op', reason: 'no-owning-task' };
  }

  // 3. THE IDENTITY (§0.5(b)/(c)) — attempt filter and emitted `node:` both off
  // the ONE resolved id.
  const identity: DeclaredIdentity = {
    instanceId: owningTask.taskId,
    node: resolvedNodeId,
    attempt: attemptsAtNode(owningTask, resolvedNodeId),
    payloadRev: payloadRevOf(owningTask),
  };

  // 4. THE FACT, whole. The event factories stamp nothing (`reportFiled` is a
  // pure `{ stream, type, payload }` wrapper), so the declared path can carry the
  // COMPLETE `EventInput` and the differential can compare it byte for byte
  // against what the dispatcher emitted.
  const event = reportFiled(buildPayload(identity));

  // 5. THE ROUTING. `criteria` is present only when the verb's body carries them;
  // the `report` kind ignores it either way (§3.5's asymmetry).
  const evidence: AcceptanceEvidence =
    evidenceCriteria === undefined
      ? { kind: 'report', verbId: input.verbId }
      : { kind: 'report', verbId: input.verbId, criteria: evidenceCriteria };
  const outcome = evaluateAtNode(
    input.workflow,
    resolvedNodeId,
    evidence,
    instanceCriterionIdsOf(owningTask),
  );

  return { kind: 'record', taskId: owningTask.taskId, identity, event, outcome };
}

/**
 * `recordReview`, declared (taskDispatcher.ts:988's contract).
 *
 * The rubric arm derives the verdict from the reported criteria against the
 * instance's own acceptance list, and the declaration names both targets — where
 * the compiled half calls `deriveReviewOutcome` and proposes its two stage
 * literals. U3 deletes that call; A2 is what proves the two agree first.
 */
export function declaredReviewRouting(
  input: DeclaredReportRoutingInput & { readonly criteria: ReportReviewPayload['criteria'] },
): DeclaredReportRouting {
  return declaredReportRouting(
    input,
    (identity) => ({ ...identity, reportKind: 'review', body: { criteria: input.criteria } }),
    input.criteria,
  );
}

/**
 * `recordCompletion`, declared (taskDispatcher.ts:1080's contract).
 *
 * The `report` kind is EXISTENCE-ONLY (node-kit §1.8.4 (e)): the worklog's
 * contents are never read, and there is no failure row — which is why the compiled
 * half has nothing to derive and proposes one literal. `criteria` is deliberately
 * ABSENT from the evidence: a worklog body carries none.
 */
export function declaredCompletionRouting(
  input: DeclaredReportRoutingInput & { readonly worklog: ReportCompletionPayload['worklog'] },
): DeclaredReportRouting {
  return declaredReportRouting(
    input,
    (identity) => ({ ...identity, reportKind: 'completion', body: { worklog: input.worklog } }),
    undefined,
  );
}

// ── the CAPTURE path (`recordPlan`, declared) ───────────────────────────────

/** What the capture routing needs. */
export interface DeclaredCaptureRoutingInput {
  readonly workflow: ParsedWorkflow;
  readonly tasks: TasksState;
  /** The session that produced the capture. */
  readonly appSessionId: string;
  /**
   * The capture's NAME as the declaration spells it (`briefing.capture` /
   * `requires = ["capture:<name>"]`) — `'plan'` is v1's whole catalogue. It is an
   * INPUT rather than a literal here because the caller is the seam that
   * intercepted this particular capture and knows which one it was.
   */
  readonly captureName: DeclaredCaptureName;
  /** The captured content. Only the empty guard reads it; the blob is the caller's to store. */
  readonly captureText: string;
}

/**
 * `recordPlan`, declared (taskDispatcher.ts:892's contract).
 *
 * ⚠ **THE BINDING IS THE SESSION'S OWN NODE REF** (slice-20 §3.3's capture
 * binding): the captured artifact satisfies the acceptance of THE NODE THAT ARMED
 * THE CAPTURE. So the resolution runs in two steps rather than one — the workflow
 * says which nodes arm this capture name (`briefing.capture` contains it), and the
 * session's own ref says which of those it was actually running. Nothing here
 * spells `'planning'`; that literal is exactly what U3 deletes, and hard-coding it
 * would make the A3 perturbation prove nothing.
 */
export function declaredPlanRouting(input: DeclaredCaptureRoutingInput): DeclaredCaptureRouting {
  // 1. THE EMPTY GUARD, preserved verbatim from the compiled half and FIRST, like
  // it: a whitespace-only capture captured nothing, and storing an empty-hash
  // artifact plus eventing a `capture_recorded` for it would be a false fact in an
  // append-only log — the plan that never was.
  if (input.captureText.trim() === '') {
    return { kind: 'no-op', reason: 'empty-capture' };
  }

  // 2. WHICH NODES ARM THIS CAPTURE? Read off the declaration, never assumed.
  const armingNodeIds = new Set(
    input.workflow.nodes
      .filter((node) => node.briefing?.capture.includes(input.captureName) === true)
      .map((node) => node.id),
  );
  if (armingNodeIds.size === 0) {
    return { kind: 'no-op', reason: 'capture-not-declared' };
  }

  // 3. THE REVERSE LOOKUP (§0.5(a)) — the session's own ref, constrained to the
  // arming nodes. The ref that matched IS the resolved binding, which is why this
  // finds the REF and not just the task: with two arming nodes the task alone
  // would not say which one this session was at.
  let resolvedNodeId: string | undefined;
  const owningTask = Object.values(input.tasks.tasks).find((task) => {
    const matchedRef = task.sessionRefs.find(
      (sessionRef) =>
        armingNodeIds.has(sessionRef.stage) && sessionRef.appSessionId === input.appSessionId,
    );
    if (matchedRef === undefined) return false;
    resolvedNodeId = matchedRef.stage;
    return true;
  });
  if (owningTask === undefined || resolvedNodeId === undefined) {
    return { kind: 'no-op', reason: 'no-owning-task' };
  }

  // 4. THE IDENTITY (§0.5(b)/(c)/(d)) — attempt filter, emitted `node:`, AND the
  // envelope's `taskRef.stage`, all three off the ONE resolved id. The plan path is
  // the one with the fourth class, and it is the reason A2 compares the envelope.
  const payloadRev = payloadRevOf(owningTask);
  const identity: DeclaredIdentity = {
    instanceId: owningTask.taskId,
    node: resolvedNodeId,
    attempt: attemptsAtNode(owningTask, resolvedNodeId),
    payloadRev,
  };
  const envelope: DeclaredCaptureEnvelope = {
    kind: input.captureName,
    taskRef: { taskId: owningTask.taskId, stage: resolvedNodeId },
    rev: payloadRev,
    createdBy: { appSessionId: input.appSessionId },
  };
  const capture: DeclaredCapturePayload = {
    ...identity,
    captureKind: input.captureName,
    capturedFrom: { appSessionId: input.appSessionId },
  };

  // 5. THE ROUTING, against the ARTIFACT table of the node that armed the capture.
  // The evidence is the capture JUST RECORDED: the instance record carries no
  // capture list to read back, and v1's catalogue has exactly one entry, so
  // `["capture:plan"]` is satisfied by `['plan']` (§3.6's all-present row). A
  // multi-entry `requires` would REST here awaiting the others, which is the
  // evaluator's rule and not something this module second-guesses.
  const outcome = evaluateAtNode(
    input.workflow,
    resolvedNodeId,
    { kind: 'captures', recorded: [input.captureName] },
    instanceCriterionIdsOf(owningTask),
  );

  return { kind: 'record', taskId: owningTask.taskId, identity, envelope, capture, outcome };
}
