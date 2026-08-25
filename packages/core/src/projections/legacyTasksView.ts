import type { TaskRecord, TaskStage } from '../schemas.js';
import type { InstanceRecord, InstancesState } from './instances.js';

// ─── S11·U1 (D72 Move 2) — the LEGACY TASK VIEW ──────────────────────────────
//
// A PURE derivation that reconstructs the shape the old task-projection source
// file used to fold, from the instances state that replaced it. Byte-for-byte under
// canonicalJson: this is the function S11-A1 runs the frozen 111-event migration
// fixture through, and a divergence is the slice's kill criterion (the core /
// payload split lost information q13's field list was supposed to carry — a
// finding about the SIGNED abstraction, not a bug to patch here).
//
// ─── S13·U4 (D72 Move 4, q24 close) — SURVIVED THE ALIAS'S DEATH ─────────────
//
// slice-11.md originally named exactly two consumers — the fixture exit gate
// and the legacy tasks-projection alias route — and planned this file's death
// alongside them. Both of those are now gone: the alias set was deleted (q24
// closed) and the fixture test (S13-A7) now pins the INSTANCES serialization
// directly, not through this view. But a THIRD consumer was there the whole
// time, bundled into the header's "the alias route" accounting rather than
// named separately: `app.ts`'s `readTasksAsLegacyView`, which feeds the
// `readTasks` callback four writer-side consumers still take —
// `InstanceWriter`, `TaskDispatcher`, `registerOrchestratorApi`,
// `TaskWatchdog` — none of which the alias tail was scheduled to touch.
//
// **ITS ONE REMAINING CONSUMER: `app.ts`'s `readTasksAsLegacyView`.**
//
// ─── S18·U2 — THE DEATH TRIGGER IS RE-DATED, AND THIS IS WHY ─────────────────
//
// S13·U4 named Move 4 (`packages/ext-tasks/`) above. Move 4 landed in slice 18
// and did NOT kill this file, because the trigger was verified one level deeper
// than S13·U4 could see: retiring the `readTasks` narrowing means
// `InstanceWriter`, `TaskDispatcher`, `registerOrchestratorApi` and
// `TaskWatchdog` stop asking for `TaskRecord[]` — but they FEED that type into
// ENGINE signatures (`decideDispatch` is `TaskRecord`-typed), so the honest
// retirement is per-declaration generalisation of those engine seams, not the
// relocation Move 4 performs.
//
// ITS ACTUAL DEATH TRIGGER, then: **the instance-store per-declaration move that
// genericizes the writer seam** — when `InstanceWriterDeps.readTasks` and its
// three siblings speak the generic instance shape and stop asking for this one
// at all. Recorded in `docs/slice-18.md` §3.7 branch (b), Wes-signed 2026-08-25,
// and in `docs/migration-map.md` Move 4's 2026-08-25 amendment (deviation iii),
// which is the ONE place all three of Move 4's narrowings are written down.
//
// Do not grow a fourth consumer in the meantime: every new reader of this shape
// is another thing that has to be migrated before Move 4 can delete it.
//
// ⚠ **IT IS A NARROWING, AND THE DROPPED FIELDS ARE THE POINT.** `nodeHistory`,
// `edgeTraversalCounts`, `attemptsPerNode` and `workflow` have no legacy
// spelling and are deliberately NOT surfaced: a legacy view that leaked new
// fields would change the bytes the frozen fixture pins, and the whole value of
// the fixture is that it cannot be quietly widened into agreement.

// ⚠ The two `as TaskStage` casts below are the ONE honest lie in this file, and
// they are load-bearing rather than lazy. A node id is `z.string()` in the
// generic vocabulary (workflows declare their own nodes — that is the carve-out
// this slice removed), while `TaskRecord.stage` is the compiled task enum. Every
// instance that reached this state through the alias table came from a legacy
// payload whose stage the enum ALREADY validated, so for the alias route's real
// traffic the cast is sound. For an instance created on a node outside the task
// enum — possible only once a second workflow exists, which is Move 3 — the
// legacy view is by definition unable to describe it, and the cast is where that
// impossibility is written down rather than papered over with a fallback stage
// that would put a fabricated node on the board.
function legacyTaskOf(instance: InstanceRecord): TaskRecord {
  return {
    taskId: instance.instanceId,
    projectRoot: instance.project,
    // ABSENT STAYS ABSENT for all five payload fields and for every optional
    // below — never `''`, never `undefined` written as a present key. A record
    // born before one of these fields existed folded to a record WITHOUT the
    // key, and the frozen fixture pins those exact bytes (I6).
    ...(instance.payload.title === undefined ? {} : { title: instance.payload.title }),
    ...(instance.payload.scope === undefined ? {} : { scope: instance.payload.scope }),
    ...(instance.payload.explicitlyOut === undefined
      ? {}
      : { explicitlyOut: instance.payload.explicitlyOut }),
    ...(instance.payload.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: instance.payload.acceptanceCriteria }),
    ...(instance.payload.killCriterion === undefined
      ? {}
      : { killCriterion: instance.payload.killCriterion }),
    // ABSENT UNTIL THE FIRST REVISION — the old fold set `workOrderRev` only in
    // its amendment case, so a never-amended task has NO such key and readers
    // spell the default `?? 0` themselves.
    ...(instance.payloadRev === undefined ? {} : { workOrderRev: instance.payloadRev }),
    ...(instance.planArtifactHash === undefined
      ? {}
      : { planArtifactHash: instance.planArtifactHash }),
    // ⚠ THE REPORT ADAPTER, RE-INVERTED. The old fold stored the WHOLE report
    // payload on the record; the generic event splits it into the identity tuple
    // plus a kind-specific body, so the view puts the four prefix keys back —
    // `taskId` from the instance itself, `stage`/`attempt`/`workOrderRev` from
    // the tuple — and spreads the body. That round trip (legacy payload → alias
    // adapter → record → here) is exactly what S11-A1 proves lossless.
    ...(instance.lastReview === undefined
      ? {}
      : {
          lastReview: {
            taskId: instance.instanceId,
            stage: instance.lastReview.node as TaskStage,
            attempt: instance.lastReview.attempt,
            workOrderRev: instance.lastReview.payloadRev,
            ...instance.lastReview.body,
          },
        }),
    ...(instance.lastCompletion === undefined
      ? {}
      : {
          lastCompletion: {
            taskId: instance.instanceId,
            stage: instance.lastCompletion.node as TaskStage,
            attempt: instance.lastCompletion.attempt,
            workOrderRev: instance.lastCompletion.payloadRev,
            ...instance.lastCompletion.body,
          },
        }),
    stage: instance.currentNode as TaskStage,
    manualReviewRequired: instance.manualReviewRequired,
    isolation: instance.isolation,
    gates: instance.gates,
    // `sessionRefs[].stage` was always `z.string()` on the legacy record (a ref
    // is a LABEL of which stage ran, never an authority over stage), so the node
    // name rides straight across with no cast and no narrowing.
    sessionRefs: instance.attachedSessions.map((attached) => ({
      stage: attached.node,
      appSessionId: attached.appSessionId,
    })),
    createdBy: instance.createdBy,
    // Both RETIRED by D34 and written by nothing since; carried at their birth
    // values so a reconstructed record is byte-identical to a folded one.
    lastHeartbeatAt: instance.lastHeartbeatAt,
    staleRetries: instance.staleRetries,
  };
}

export interface TasksState {
  tasks: Record<string, TaskRecord>;
}

// PURE: reads `state`, allocates a fresh view, mutates nothing. Callers may hold
// the result as long as they like — nothing here aliases the instance records
// (the arrays it builds are new; the leaf values are immutable JSON).
//
// Key insertion order is `Object.entries`' order, i.e. the instances Record's
// insertion order — which is irrelevant to the bytes, because the serializer is
// canonicalJson and it sorts keys deeply. Never hand-roll an ordering here to
// "match" the old projection: that would be pinning a property the byte contract
// deliberately does not have.
export function legacyTasksViewOf(state: InstancesState): TasksState {
  const tasks: Record<string, TaskRecord> = {};
  for (const [instanceId, instance] of Object.entries(state.instances)) {
    tasks[instanceId] = legacyTaskOf(instance);
  }
  return { tasks };
}
