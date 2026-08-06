import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, TaskRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  RETIRED_EVENT_KINDS,
  captureRecordedPayloadSchema,
  instanceCreatedPayloadSchema,
  instanceMovedPayloadSchema,
  instancePayloadRevisedPayloadSchema,
  instanceRunAttachedPayloadSchema,
  reportFiledPayloadSchema,
  type InstancePayload,
  type ReportFiledPayload,
  type WorkflowRef,
} from '../events.js';

// ─── S11·U1 (D72 Move 2) — the INSTANCE store ────────────────────────────────
//
// The generalisation of `projections/tasks.ts`, which this file REPLACES (it is
// deleted in the same unit — D72's rule is that a unit which leaves both paths
// live is not finished). Every fold rule below is the old one, re-spelled: an
// INSTANCE of a workflow sitting on a NODE (node-kit §1.7) rather than a task
// sitting in a stage. The seam moved; the state did not.
//
// Folded from the 'tasks' stream — the stream name is NOT part of the rename
// (slice-11.md): it is persisted state, and (stream, seq) contiguity lives on it.
// No instance state is written anywhere but the log (I12); this is the only
// place it is READ back into a shape a UI or a dispatcher can look at.
//
// ⚠ THE PROJECTION APPLIES WHAT WAS RECORDED — IT NEVER RE-DECIDES.
// `proposeTransition` is deliberately NOT called here, and must not be added.
// The dispatcher already decided each move, and `instance_moved` is the record
// of that decision. Re-validating a recorded move on replay would make the
// projection a SECOND authority over an instance's node (principle 10), and the
// day the workflow's edges change it would silently rewrite history — old,
// legitimately-accepted moves would stop folding and the board would disagree
// with its own log. The log is truth; this fold obeys it.
//
// ⚠ ONE FOLD PATH, NOT TWO. Legacy kinds are resolved through
// `RETIRED_EVENT_KINDS` (events.ts) into their generic siblings BEFORE the
// switch, so a recorded `task_created` and a written `instance_created` reach
// the same case with the same payload shape. The alternative — a legacy case
// beside every generic one — is two folds of one fact that diverge the first
// time somebody fixes only the case they were looking at (principle 9).

// The instance's tenant-shaped payload. The engine never reads a field in here
// to decide anything (node-kit §1.7); it is carried, revised and rendered.
export type { InstancePayload };

// One filed report, generic over its kind-specific body. The
// `(node, attempt, payloadRev)` identity tuple is D46's: it is what makes a
// stored report attributable to a specific run, and dropping it would leave a
// reader unable to say WHICH attempt a piece of feedback judged. `instanceId` is
// not restated — the record it hangs on already is the instance.
export interface FiledReport<BodyType> {
  node: string;
  attempt: number;
  payloadRev: number;
  body: BodyType;
}

type ReviewBody = Extract<ReportFiledPayload, { reportKind: 'review' }>['body'];
type CompletionBody = Extract<ReportFiledPayload, { reportKind: 'completion' }>['body'];

// One entry into a node, recorded as it happened. NEW in S11 and fold-derived:
// nothing consumes it until Move 3 (see the fold), and it is reserved now
// because the fold is the only place it can be derived from — a projection that
// has already thrown the history away cannot grow it later without a replay.
export interface NodeHistoryEntry {
  node: string;
  proposedBy: string;
  ts: string;
}

// ⚠ THE RECORD SPLIT (slice-11.md, q13 applied) — three groups, and the middle
// era is where carve-outs hide, so all three are named:
//
//   • CORE — q13's exhaustive list. Engine-owned, generic, workflow-agnostic.
//   • PAYLOAD — opaque and tenant-shaped, under ONE key. The engine never reads
//     a field in it to decide anything.
//   • TRANSITIONAL CORE — fields the engine still reads to DECIDE, which is
//     exactly why the payload-opacity rule forbids putting them in `payload`.
//     **EACH ONE IS NAMED WITH THE MOVE THAT RETIRES IT.** A transitional field
//     with no named retirement move is a carve-out (principle 16); the comments
//     below are the fence, copied from the slice doc.
export interface InstanceRecord {
  // ── core ──────────────────────────────────────────────────────────────────
  instanceId: string;
  project: string;
  // The workflow this is an instance OF. **`null` for every instance this slice
  // creates**, deliberately: no pinned workflow definition governs adjudication
  // until Move 3, and stamping an identity nothing pinned would be declared
  // truth over observed (rule 0.7). See instanceCreatedPayloadSchema.
  workflow: WorkflowRef | null;
  currentNode: string;
  // NEW in S11, fold-derived, and **CONSUMED BY NOTHING UNTIL MOVE 3** — the
  // move that puts workflow definitions in charge of adjudication. They land
  // now because they can only be derived at fold time: `edgeTraversalCounts` is
  // what Move 3's `max_traversals` edge rule reads, and neither it nor the
  // history can be reconstructed from a record that never accumulated them.
  // Deterministic by construction (counters and appends over recorded facts —
  // no clock, no id minting), so replay from a snapshot equals replay from
  // empty (I6).
  //
  // MOVES ONLY. Creation does not seed a history entry: an instance that has
  // never moved has an EMPTY history, which is the honest reading of "where has
  // this been?" — its birth node is `currentNode`, already recorded above.
  nodeHistory: NodeHistoryEntry[];
  // Keyed `${fromNode}->${toNode}` with a plain ASCII arrow. The key is DATA in
  // a serialized projection, so it stays in the printable ASCII range: an
  // exotic separator is a byte somebody has to escape correctly in every reader
  // forever, and a control byte in a canonicalJson blob is a corruption nobody
  // sees until it is persisted.
  edgeTraversalCounts: Record<string, number>;
  // ENTRIES INTO A NODE, counted. Creation counts as entry 1 for the node the
  // instance is born on (being placed there IS an entry — a fresh instance has
  // attempt 1 on its first node, not attempt 0), and every `instance_moved`
  // increments its `toNode`.
  attemptsPerNode: Record<string, number>;
  // The payload revision this record currently reflects (D43: revisioned, not
  // mutated). ABSENT UNTIL THE FIRST REVISION — a never-revised instance has no
  // such key, exactly as `TaskRecord.workOrderRev` had none before its first
  // amendment, and readers that need a number spell that `?? 0` rather than the
  // record defaulting it.
  payloadRev?: number;
  // The runs of this instance's nodes, in log order. The ONE accumulating field.
  attachedSessions: { node: string; appSessionId: string }[];
  createdBy: TaskRecord['createdBy'];

  // ── payload (opaque, tenant-shaped) ───────────────────────────────────────
  payload: InstancePayload;

  // ── transitional core — each field with the move that retires it ──────────
  // → node-kind declaration.
  isolation: TaskRecord['isolation'];
  // → dispatch-gates declaration.
  gates: TaskRecord['gates'];
  // → workflow data (Move 3).
  manualReviewRequired: boolean;
  // → the capture record.
  planArtifactHash?: string;
  // → the acceptance/report store.
  lastReview?: FiledReport<ReviewBody>;
  lastCompletion?: FiledReport<CompletionBody>;
  // → the watchdog custody split. Both were RETIRED by D34 already and nothing
  // writes either: the heartbeat lives on `SessionRecord.lastAppendAt` and the
  // stale count on `SessionRecord.staleEpisodes` (a projection may fold only
  // its own stream). Carried at their birth values so the legacy view can
  // reconstruct byte-identical records; read the heartbeat off the session.
  lastHeartbeatAt: string | null;
  staleRetries: number;
}

export interface InstancesState {
  instances: Record<string, InstanceRecord>;
}

// Immutably replace one instance; a no-op when the instance is unknown (log is
// truth, nothing throws — events for instances we never saw created are ignored
// and never fabricate a record). Mirrors `withTask` in the projection this file
// replaces, and `withSession` in projections/sessions.ts.
//
// ⚠ RETURNS `state` BY IDENTITY on the unknown-instance path, never a copy. A
// no-op that rebuilt an equal object would be indistinguishable in the bytes and
// wrong in the contract: callers (and tests) read reference equality as "this
// event changed nothing", and a fold that allocated on every ignored event would
// also churn snapshots that share references with live state.
function withInstance(
  state: InstancesState,
  instanceId: string,
  update: (instance: InstanceRecord) => InstanceRecord,
): InstancesState {
  const existingInstance = state.instances[instanceId];
  if (existingInstance === undefined) {
    return state;
  }
  return {
    instances: { ...state.instances, [instanceId]: update(existingInstance) },
  };
}

// The resolved (kind, payload) an event folds AS. A legacy kind is resolved
// through the alias table; anything else folds as itself.
//
// `null` means "recorded, but nothing to fold": a retired kind whose legacy
// payload did not parse. It is deliberately distinct from "unknown kind", even
// though both end in the same no-op, because the two are different facts about
// the log and a future reader should not have to guess which one happened.
function resolveKind(event: EventRecord): { type: string; payload: unknown } | null {
  const retired = RETIRED_EVENT_KINDS[event.type];
  if (retired === undefined) {
    return { type: event.type, payload: event.payload };
  }
  const adapted = retired.adapt(event.payload);
  if (adapted === null) {
    return null;
  }
  return { type: retired.canonical, payload: adapted };
}

export const instancesProjection: Projection<InstancesState> = {
  id: 'instances',

  init(): InstancesState {
    return { instances: {} };
  },

  // TOTAL: unknown event types are no-ops; events for unknown instances are
  // no-ops; a malformed payload is a no-op. Nothing throws (I8's spirit —
  // hostile input must not crash a fold). PURE: `state` is never mutated,
  // because snapshots share references with live state and boot replays a
  // snapshot forward.
  //
  // ⚠ EVERY NO-OP PATH RETURNS `state` ITSELF, never `{ ...state }`.
  apply(state: InstancesState, event: EventRecord): InstancesState {
    const resolved = resolveKind(event);
    if (resolved === null) {
      // A retired kind with a payload its own legacy schema refuses. The log
      // keeps the record; the fold keeps nothing.
      return state;
    }

    switch (resolved.type) {
      case EVENT_TYPES.instanceCreated: {
        const parsed = instanceCreatedPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        if (state.instances[payload.instanceId] !== undefined) {
          // Duplicate creation is a no-op — never clobber an existing record.
          // Replay safety: a re-delivered or re-appended birth record must not
          // reset an instance that has since moved through several nodes.
          return state;
        }
        // The birth record carries only what the creator NAMED. Everything else
        // is the record's documented starting value, filled in here rather than
        // in the event, so the event stays a statement of intent and the
        // projection owns the record shape.
        const bornInstance: InstanceRecord = {
          instanceId: payload.instanceId,
          project: payload.project,
          workflow: payload.workflow,
          currentNode: payload.node,
          // Empty at birth — see the field's note: creation seeds no history
          // entry, because being created is not a move.
          nodeHistory: [],
          edgeTraversalCounts: {},
          // Being placed on the birth node IS an entry into it, so the first
          // run on that node is attempt 1 and not attempt 0.
          attemptsPerNode: { [payload.node]: 1 },
          attachedSessions: [],
          createdBy: payload.createdBy,
          // ⚠ SPREAD RATHER THAN DEFAULTED, field by field, and the asymmetry
          // with `gates` below is the whole point — carried verbatim from the
          // projection this replaces: `gates` folds ABSENT → `{}` because an
          // ungated instance and an instance with no gates are the same fact,
          // while a title, a scope, an explicitly-out list, an acceptance list
          // or a kill criterion has NO such neutral value. `''` is a title
          // someone chose; an empty scope is a scope someone chose. An
          // `undefined` written as a present key would also change the
          // serialized bytes of every record written before the field existed
          // and break I6. Absent stays absent.
          payload: {
            ...(payload.payload.title === undefined ? {} : { title: payload.payload.title }),
            ...(payload.payload.scope === undefined ? {} : { scope: payload.payload.scope }),
            ...(payload.payload.explicitlyOut === undefined
              ? {}
              : { explicitlyOut: payload.payload.explicitlyOut }),
            ...(payload.payload.acceptanceCriteria === undefined
              ? {}
              : { acceptanceCriteria: payload.payload.acceptanceCriteria }),
            ...(payload.payload.killCriterion === undefined
              ? {}
              : { killCriterion: payload.payload.killCriterion }),
          },
          isolation: payload.isolation,
          // ABSENT → `{}`, byte-for-byte what every previously-written birth
          // record folded to before the field existed, so old logs replay
          // identically (I6). Present → folded verbatim; the creator's gates are
          // the ONLY way `requireHeadroom` / `deferUntilReset` reach a record,
          // and therefore the only way I10's refusal is reachable outside a test.
          gates: payload.gates ?? {},
          manualReviewRequired: false,
          lastHeartbeatAt: null,
          staleRetries: 0,
        };
        return {
          instances: { ...state.instances, [payload.instanceId]: bornInstance },
        };
      }

      case EVENT_TYPES.instanceMoved: {
        const parsed = instanceMovedPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Applied TOTALLY — the edge was already adjudicated before this event
        // was written (see the header note). Note the payload's `fromNode` is
        // deliberately NOT checked against the record: that would be re-deciding,
        // and a mismatch is a dispatcher bug to be found in the log, not a
        // divergence to be papered over here.
        //
        // ⚠ `fromNode` IS used to KEY the traversal counter, which is a
        // different act entirely: the counter records what the event SAID was
        // traversed. Believing the record over the event there would make the
        // count disagree with the log it was folded from.
        return withInstance(state, payload.instanceId, (instance) => {
          const edgeKey = `${payload.fromNode}->${payload.toNode}`;
          return {
            ...instance,
            currentNode: payload.toNode,
            // The RESULTING convergence flag as the machine decided it (only
            // the `→ done` edge can turn it on; every other edge carries the
            // instance's existing value through, which the emitter recorded).
            manualReviewRequired: payload.manualReviewRequired,
            // APPEND, never sort, and a NEW array rather than a push — the
            // previous one may be shared with a snapshot.
            nodeHistory: [
              ...instance.nodeHistory,
              // `ts` is the EVENT's timestamp, copied. Nothing here reads a
              // clock: rule 0.3, and a fold that stamped its own time would
              // serialize differently on every replay and break I6 outright.
              { node: payload.toNode, proposedBy: payload.proposedBy, ts: event.ts },
            ],
            edgeTraversalCounts: {
              ...instance.edgeTraversalCounts,
              [edgeKey]: (instance.edgeTraversalCounts[edgeKey] ?? 0) + 1,
            },
            attemptsPerNode: {
              ...instance.attemptsPerNode,
              [payload.toNode]: (instance.attemptsPerNode[payload.toNode] ?? 0) + 1,
            },
          };
        });
      }

      case EVENT_TYPES.instanceRunAttached: {
        const parsed = instanceRunAttachedPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown instance → no-op, exactly like `instance_moved` above: a ref
        // for an instance we never saw created must never fabricate a record.
        return withInstance(state, payload.instanceId, (instance) => {
          // IDEMPOTENT ON REPLAY, keyed on `appSessionId`. `attachedSessions` is
          // the only field of an InstanceRecord that ACCUMULATES a caller-
          // supplied fact rather than being overwritten, so it is the one place
          // where folding the same event twice leaves a trace — every other case
          // in this fold is naturally idempotent (a node assignment applied
          // twice is the same node).
          //
          // ⚠ Stated precisely, because the plausible version is wrong and was
          // checked by breaking this line: I6 does NOT catch a duplicate append.
          // Cut points replay the SAME record sequence either way, so a fold
          // that appends twice appends twice in both paths and replay
          // equivalence still holds. What this guard defends is the fold being
          // handed the same event MORE THAN ONCE — an at-least-once delivery, an
          // overlapping tail read, an operator re-appending a record — where the
          // board would sprout a phantom second run that never existed. The
          // dedicated idempotence test, not I6, is what holds this line.
          //
          // Keyed on `appSessionId` and deliberately NOT on node: the same
          // session cannot run twice, while one instance legitimately
          // accumulates several refs across nodes AND several within one node
          // (a re-run after a quarantine is a NEW session, and must be kept).
          if (
            instance.attachedSessions.some(
              (existingRef) => existingRef.appSessionId === payload.appSessionId,
            )
          ) {
            return instance;
          }
          return {
            ...instance,
            // APPEND, never sort: the refs are a chronological trail of which
            // sessions ran this instance, and the log order is the only order
            // that means anything. New array, never a push onto the shared one —
            // snapshots share references with live state.
            attachedSessions: [
              ...instance.attachedSessions,
              { node: payload.node, appSessionId: payload.appSessionId },
            ],
          };
        });
      }

      case EVENT_TYPES.captureRecorded: {
        const parsed = captureRecordedPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown instance → no-op, exactly like every case above: a capture for
        // an instance we never saw created must never fabricate a record.
        return withInstance(state, payload.instanceId, (instance) => ({
          ...instance,
          // AUGMENT, not a move: a capture records a fact ABOUT the instance
          // (which artifact is current) without moving `currentNode`. The
          // planning -> plan-ready move is a SEPARATE `instance_moved`, emitted
          // by the dispatcher once it has observed this event; folding a node
          // change in here too would give the record two authorities over its
          // own node (principle 9).
          //
          // LATEST-WINS, unlike `attachedSessions`' accumulation. A re-capture
          // (a fresh plan after a review sends the instance back) SUPERSEDES the
          // prior one — the board and the handoff want the CURRENT artifact,
          // never a history of every plan ever drafted — so an ordinary
          // overwrite is the right shape and is naturally idempotent: folding
          // the SAME capture twice leaves the field at the same single hash,
          // with no accumulating trace. That is why this case needs no dedicated
          // idempotence guard the way the attach case does above.
          //
          // Only the hash is folded. The rest of the payload
          // (captureKind/node/attempt/payloadRev/capturedFrom) stays recorded on
          // the EVENT for audit/replay — the handoff locates the artifact by
          // hash alone, and the artifact envelope carries the rest, so restating
          // them on the record would be a second source of the same facts.
          //
          // ⚠ `captureKind` is not branched on, and with a one-entry catalogue
          // it cannot be: the day a second capture kind exists it needs its own
          // record field and its own decision, NOT a widened meaning for this
          // one. `planArtifactHash` retires into the capture record then.
          planArtifactHash: payload.artifactHash,
        }));
      }

      // ── the FIX-SEED fold (D46), now one case for both report kinds ────────
      //
      // AUGMENTS the record exactly as a capture does above — it records a fact
      // ABOUT the instance (the verdict that judged it / the worklog of the
      // attempt that just ended) without moving `currentNode`. The node moves
      // are SEPARATE `instance_moved` events the dispatcher emits after deriving
      // the target (`deriveReviewOutcome` for a review; implementing → review for
      // a completion, D53); folding a node change in here too would give the
      // record two authorities over its own node (principle 9).
      //
      // LATEST-WINS, like `planArtifactHash`: the LOG keeps every report ever
      // filed — that is the audit trail and the per-attempt cost story D46 relies
      // on — while the RECORD keeps only the newest, because the fix-seed a fresh
      // implementer needs is the review that just failed it, never a history of
      // every lap. Naturally idempotent for the same reason a capture is, so
      // neither needs the dedup guard the attach case carries.
      //
      // The identity tuple `(node, attempt, payloadRev)` is stored beside the
      // body, not dropped: it is what makes a stored report attributable to a
      // specific run (D46), and without it the board cannot say WHICH attempt a
      // piece of feedback judged.
      case EVENT_TYPES.reportFiled: {
        const parsed = reportFiledPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown instance → no-op (I8 totality), exactly like every case above:
        // a report for an instance we never saw created must never fabricate a
        // record.
        return withInstance(state, payload.instanceId, (instance) => {
          const filed = {
            node: payload.node,
            attempt: payload.attempt,
            payloadRev: payload.payloadRev,
          };
          // ⚠ The two kinds land on DIFFERENT fields and never on a shared
          // "last report" one. They are two different facts a fixer needs at
          // once (D46's rider: the review that sent it back AND the worklog of
          // the attempt that ended), so collapsing them would make each new
          // report erase the other half of the seed.
          return payload.reportKind === 'review'
            ? { ...instance, lastReview: { ...filed, body: payload.body } }
            : { ...instance, lastCompletion: { ...filed, body: payload.body } };
        });
      }

      // ── the REVISION fold (D43 — revisioned, never mutated) ────────────────
      //
      // The one case in this fold that rewrites what the BIRTH RECORD said. D43's
      // discipline is that a payload is corrected by APPENDING a revision, never
      // by editing the creation event that started it, so the log keeps every
      // revision the instance ever had and the record keeps the current one.
      //
      // PATCH SEMANTICS, field by field: **present in the patch → REPLACES the
      // record's field; absent → the record's field is left exactly as it was.**
      // A revision that narrows only `scope` omits the other three and they
      // survive untouched — restating them would be the only alternative, and it
      // would make every revision a full rewrite that silently clobbers whatever
      // a concurrent one just changed.
      //
      // ⚠ AN EXPLICIT `acceptanceCriteria: []` IS A REPLACEMENT, NOT AN OMISSION.
      // Clearing the criteria list is a legal revision (a payload that stops
      // claiming checkable outcomes), and it is a DIFFERENT fact from a revision
      // that never mentioned the list — which is exactly why the writer is
      // careful to omit absent fields rather than send `undefined` for them.
      //
      // ⚠ `payloadRev` IS RECORDED, NEVER COMPUTED. The event carries the rev the
      // record reflects AFTER this revision, and this fold writes down what the
      // event says. A fold that incremented a counter of its own would be a
      // second authority over the rev (principle 9) and would break replay the
      // first time a log was folded from a snapshot rather than from empty (I6):
      // the stored number is the truth.
      //
      // `revisedBy` is deliberately NOT folded onto the record, exactly as
      // `instance_moved`'s `proposedBy` is not folded onto `currentNode`'s
      // neighbourhood: the record is CURRENT STATE, and who authored a given
      // revision is audit — it lives in the log, where a reviewer reads the whole
      // revision history rather than only its last line. (`nodeHistory` is not a
      // counter-example: it is a recorded trail, not the current state of one
      // field, and Move 3 reads it.)
      case EVENT_TYPES.instancePayloadRevised: {
        const parsed = instancePayloadRevisedPayloadSchema.safeParse(resolved.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown instance → no-op (I8 totality): a revision for an instance we
        // never saw created must never fabricate a record.
        return withInstance(state, payload.instanceId, (instance) => ({
          // I12: a NEW record by spread — the previous one is never mutated in
          // place, because snapshots share references with live state.
          ...instance,
          payload: {
            ...instance.payload,
            ...(payload.patch.scope === undefined ? {} : { scope: payload.patch.scope }),
            ...(payload.patch.explicitlyOut === undefined
              ? {}
              : { explicitlyOut: payload.patch.explicitlyOut }),
            ...(payload.patch.acceptanceCriteria === undefined
              ? {}
              : { acceptanceCriteria: payload.patch.acceptanceCriteria }),
            ...(payload.patch.killCriterion === undefined
              ? {}
              : { killCriterion: payload.patch.killCriterion }),
          },
          payloadRev: payload.payloadRev,
        }));
      }

      // ── deliberately NOT folded ────────────────────────────────────────────
      //
      // `instance_move_rejected` (and its retired spelling
      //   `task_transition_rejected`) — a rejection changed NOTHING about
      //   instance state; the instance is still on `fromNode`. It is I7's
      //   *evidence*, and it lives in the log where a reviewer reads it. This
      //   projection is state, not audit; folding a non-change would invent one.
      //   ⚠ It HAS an alias row all the same — the rename is settled even though
      //   the fold ignores it — and it reaches `default` here, which is what
      //   keeps a rejection returning the SAME state object rather than an equal
      //   copy.
      //
      // `dispatch_refused` — I10's refusal record. The spawn did not happen and
      //   the instance stayed exactly where it was. Same reason: nothing to fold.
      //   Deliberately absent from the alias table too (slice-11.md: its generic
      //   sibling arrives with the dispatcher split).
      //
      // `task_quarantined` — lives on the SESSION stream and is a fact about a
      //   node run (it raises `needsAttention` in projections/sessions.ts), NOT
      //   the authority for an instance's node. A move to `quarantined` arrives
      //   as an ordinary `instance_moved` from the dispatcher. Principle 9, one
      //   source of record per fact: folding both would make the node derivable
      //   from two places, and they would eventually disagree.
      //
      // `task_worktree_created` — never folded (the record has no worktree
      //   field), and not renamed this slice: its generic sibling arrives with
      //   the E2 tree store.
      //
      // ...along with every other event type, which does not change an
      // InstanceRecord.
      default:
        return state;
    }
  },

  serialize(state: InstancesState): string {
    // canonicalJson sorts keys deeply, so the `instances` Record's INSERTION
    // order cannot leak into the bytes. Never hand-roll the ordering here.
    return canonicalJson(state);
  },
};
