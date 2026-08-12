export type { Clock, IdSource } from './ids.js';
export { SteppingClock, CountingIdSource } from './ids.js';
export * from './schemas.js';
export type { EventStore } from './eventStore.js';
export { MemoryEventStore } from './memoryEventStore.js';
export { EventRouter, type OnEvent } from './router.js';
// S7·4 (rule 0.5) — the content-addressed artifact store, injected
// infrastructure with NO live consumer yet (S7·5 is the first). Port + memory
// fake here mirror EventStore/MemoryEventStore; the durable adapter is
// packages/daemon/src/sqliteArtifactStore.ts.
export {
  computeArtifactHash,
  buildArtifactEnvelope,
  ArtifactEnvelopeValidationError,
  type ArtifactStore,
  type ArtifactPutMeta,
} from './artifactStore.js';
export { MemoryArtifactStore } from './memoryArtifactStore.js';

export { canonicalJson } from './canonicalJson.js';
export {
  TerminalRingBuffer,
  DEFAULT_TERMINAL_BUFFER_BYTES,
  type TerminalReplay,
} from './ringBuffer.js';
export * from './events.js';
export {
  LIVENESS_EDGES,
  INITIAL_LIVENESS,
  canTransition,
  assertLogRespectsEdges,
  assertAttentionBatchRule,
  type LivenessViolation,
  type LivenessScanResult,
  type AttentionBatchViolation,
  type AttentionBatchScanResult,
} from './sessionMachine.js';

export {
  MemorySnapshotStore,
  streamHighWaterMarks,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
  bootFromSnapshot,
  type Projection,
  type SnapshotStore,
} from './projections/projection.js';
export { sessionsProjection, type SessionsState } from './projections/sessions.js';
// Q3: what a session is CALLED — the auto-title derivation and THE identity
// ladder. One module, so no consumer grows a second opinion (principle 9).
export {
  deriveSessionTitle,
  extractMessageText,
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
  FALLBACK_LABEL_ID_LENGTH,
  HARNESS_WRAPPER_TITLE_PREFIXES,
  SESSION_TITLE_MAX_LENGTH,
  UNKNOWN_SESSION_LABEL,
  type SessionLabelInputs,
} from './sessionIdentity.js';
// D79 (slice-14 F4) — short session ids, RENDERING and RESOLUTION as two
// functions. The old `SHORT_SESSION_ID_LENGTH` export is GONE and the name stays
// dead: a consumer that wants a collision-safe ADDRESSABLE HANDLE calls
// `shortSessionIds` with the whole estate, and gets `SHORT_SESSION_ID_BASE_LENGTH`
// as the floor that group collisions extend from.
//
// ⚠ **`FALLBACK_LABEL_ID_LENGTH` above is a different fact and is not this one**
// (S14-F1, signed): the label ladder's fallback slice is a display distinguisher
// handed one session and no estate, so it cannot extend and keeps its own width.
// Same shape, different question — see the comment over it in sessionIdentity.ts.
export {
  shortSessionIds,
  resolveShortSessionId,
  SHORT_SESSION_ID_BASE_LENGTH,
  type ShortSessionIdResolution,
} from './sessionShortIds.js';
export {
  metersProjection,
  meterSample,
  meterHistory,
  METER_SAMPLE_TYPE,
  METER_HISTORY_LIMIT,
  USAGE_STREAM,
  type MetersState,
  type MeterHistorySample,
} from './projections/meters.js';
export {
  meterFreshness,
  headroomPercent,
  burnRatePercentPerHour,
  samplesSinceLastReset,
  projectedExhaustion,
  projectedExhaustionWithReason,
  evaluateHeadroomGate,
  evaluateMeterAlerts,
  rememberMeterAlert,
  type ExhaustionReason,
  type ProjectedExhaustion,
  type FiredMeterAlert,
  type MeterAlertMemory,
  type MeterFreshness,
  type HeadroomGate,
  type HeadroomGateVerdict,
  type HeadroomGateReason,
  type HeadroomGateResult,
} from './meterDerivations.js';
// S11·U1 (D72 Move 2): the INSTANCE store replaced the task store, and the old
// task-projection source file was deleted in the same unit (D72: a unit that
// leaves both paths live is not finished). `legacyTasksViewOf` + `TasksState`
// are the narrowing. S13·U4 deleted its original two consumers (the legacy
// tasks-projection alias route and the frozen-fixture exit gate, which now
// pins the instances serialization directly) — its one remaining consumer and
// its Move-4 death trigger are named in legacyTasksView.ts's own header.
export {
  instancesProjection,
  type InstanceRecord,
  type InstancesState,
  type NodeHistoryEntry,
  type FiledReport,
} from './projections/instances.js';
export { legacyTasksViewOf, type TasksState } from './projections/legacyTasksView.js';
// S8·1 D42 — the project registry: the fold, and `projectForCwd`, which is THE
// ONLY ATTRIBUTION AUTHORITY (see its note). A consumer that needs "which project
// owns this cwd?" imports it from here and never re-derives prefix matching.
// `projectRecordSchema`/`ProjectRecord` arrive via the `export * from
// './schemas.js'` above, and the four `project_*` constructors/payload schemas via
// `export * from './events.js'` below; nothing redundant is re-exported here.
// `isWithinProjectRoot` is the containment rule `projectForCwd` matches on,
// exported for S8·3's board scoping (which has a projectRoot in hand rather than a
// cwd to attribute) so there is still only ONE spelling of the segment-boundary
// guard in the codebase.
export {
  projectsProjection,
  projectForCwd,
  isWithinProjectRoot,
  projectDisplayName,
  type ProjectsState,
} from './projections/projects.js';
// S9·1 (E2) — the session forest: the fold, its read-time derivations, and the
// ONE subtree aggregation. Unexported until now because nothing outside core had
// a consumer (rule 0.5); S14 gives it two, the tree read model below and the
// daemon's node writer + `/api/tree` route.
export {
  nodesProjection,
  nodeIdForSession,
  isEffectivelyClosed,
  subtreeNodeIds,
  type NodeRecord,
  type NodesState,
} from './projections/nodes.js';
export {
  rollupNode,
  ATTENTION_SEVERITY_ORDER_VERSION,
  ATTENTION_SEVERITY_RANKS,
  type AttentionSeverity,
  type NodeRollup,
} from './projections/nodeRollup.js';
// S14·U2 (§3b) — the ONE liveness+attention → severity join. `rollupNode`'s
// severity callback has one implementation and this is it.
export { sessionSeverityOf } from './projections/sessionSeverity.js';
// S14·U2 (§3 F1/F2) — the composed tree read model. `treeOf` is what
// `GET /api/tree` serves; `defaultRootForSession` is F2's named derivation, and
// `projectRootId` / `UNFILED_ROOT_ID` are the virtual-id grammar a client
// addresses roots with.
export {
  treeOf,
  defaultRootForSession,
  projectRootId,
  PROJECT_ROOT_ID_PREFIX,
  UNFILED_ROOT_ID,
  UNFILED_ROOT_NAME,
  type TreeResponse,
  type TreeRoot,
  type TreeNode,
  type TreeSession,
  type TreeOptions,
  type TreeOverlays,
} from './projections/tree.js';
// S8·3 D56 — the standing orchestrator's briefing composers. A separate module
// (and export) from `composeStageInstruction` for the reason those two are apart
// from each other: this composes what a PERSISTENT CONVERSATION PARTNER is told at
// (re)founding and at resume, which is a different job from what a dispatched
// worker is told about one task.
export {
  composeOrchestratorFounding,
  composeOrchestratorReorientation,
  summarizeBoardForOrchestrator,
  type OrchestratorBoardSummary,
  type OrchestratorBoardTask,
  type OrchestratorFoundingInput,
  type OrchestratorReorientationInput,
} from './orchestrator/founding.js';
// S8·4 (D57/D64) — the transcript lifecycle's pure policy: escalating capture
// nudges, the compaction door, and the words for both.
export {
  V0_COMPACTION_STEWARD_CONFIG,
  EMPTY_COMPACTION_NUDGE_MEMORY,
  sumContextTokens,
  rememberCompactionNudge,
  evaluateCompactionNudge,
  decideCompactionGate,
  composeCompactionNudge,
  composeCompactionResumeContext,
  type CompactionStewardConfig,
  type CompactionNudgeThreshold,
  type CompactionNudgeMemory,
  type CompactionMemoryEntry,
  type CompactionNudgeInput,
  type CompactionGateInput,
  type CompactionGateDecision,
} from './orchestrator/compactionSteward.js';
// The transitional vocabulary module (D72 Move 3, S12·U3): the task tenant's
// stages, proposer classes and refusal reasons, plus the rule for what an
// accepted move RECORDS. Legality itself moved to the extension's declaration
// and is adjudicated by `extensions/proposeMove.ts` — see the module banner.
export {
  TASK_STAGES,
  taskStageSchema,
  transitionProposedBySchema,
  transitionRejectionReasonSchema,
  nextTaskForAcceptedTransition,
  type TaskStage,
  type TransitionProposal,
  type TransitionProposedBy,
  type TransitionRejectionReason,
} from './tasks/taskStateMachine.js';
export {
  DISPATCHABLE_TASK_STAGES,
  NON_DISPATCHABLE_TASK_STAGES,
  dispatchRefuseReasonSchema,
  dispatchDeferReasonSchema,
  isDispatchableStage,
  decideDispatch,
  // S7·7c — the OTHER dispatch question: does this EDGE start work (D53's
  // dispatch-as-mechanics), as opposed to `decideDispatch`'s "should this TASK
  // run right now". The transitions route is its only caller; it must never
  // re-derive the rule locally (principle 10).
  shouldDispatchOnTransition,
  type DispatchInput,
  type DispatchDecision,
  type DispatchRefuseReason,
  type DispatchDeferReason,
} from './tasks/dispatchDecision.js';
// Step 7 — WHO runs a stage, kept a separate export (and a separate module) from
// WHETHER it runs. See stageRunner.ts for why the two questions never merge.
export { resolveStageRunner, type StageRunnerPlan } from './tasks/stageRunner.js';
// The dispatcher's instruction seam — WHAT a dispatched worker is told. Kept a
// separate export (and a separate module) from stageRunner.ts for the same
// reason WHO and WHETHER stay apart: this only composes words from a
// (task, plan) pair and never decides who runs the stage or whether it runs.
export { composeStageInstruction } from './tasks/stageInstruction.js';
// S7·7a — the OPTIONAL out-of-band context the composer needs but cannot read
// (the daemon-fetched plan blob). Reserved to grow with S7·7b's fix-seed.
export type { StageInstructionContext } from './tasks/stageInstruction.js';
// S7·6a — the pure review verdict → proposed-stage function. Kept a separate export
// (and module) like the other task decisions: it decides WHERE a reported review
// sends the task, and S7·6b's dispatcher reads the result to propose the transition
// through the state machine (I7). The `reviewReported` / `completionReported` event
// constructors already flow through `export * from './events.js'` below, so nothing
// redundant is re-exported here.
export { deriveReviewOutcome } from './tasks/reviewOutcome.js';
// Step 8 — WHERE a stage runs, derived from the taskId alone. Pure and total, and
// in core (not beside the daemon's manager) because a worktree's identity must be
// re-derivable by the board, a future GC and any replay without a daemon running.
export {
  TASK_WORKTREE_BRANCH_PREFIX,
  TASK_WORKTREE_DIR_PREFIX,
  taskWorktreeBranch,
  taskWorktreeDirName,
} from './tasks/worktreePaths.js';
// S7·1 (rule 0.5) — the task-as-work-order shapes, reserved with NO consumer.
// `acceptanceCriterionSchema`/`AcceptanceCriterion` already flow through the
// `export * from './schemas.js'` above, and `workOrderAmended`/
// `WorkOrderAmendedPayload` already flow through `export * from './events.js'`
// below; nothing redundant is re-exported here.
//
// ⚠ S7·7b: `reportReviewPayloadSchema` / `reportCompletionPayloadSchema` (and
// their types) now LIVE in schemas.ts and so ALSO arrive via the star export
// above. They are kept in this explicit list anyway — an explicit named export
// wins over `export *`, both names bind the same object, and listing them here is
// what makes the hoist invisible to `@vimes/core`'s consumers. Same story for
// `taskStageSchema`/`TaskStage` in the taskStateMachine block above.
export {
  stageRunIdentitySchema,
  artifactEnvelopeSchema,
  submitPlanPayloadSchema,
  reportReviewPayloadSchema,
  reportCompletionPayloadSchema,
  scopedTokenBindingSchema,
  createTaskToolPayloadSchema,
  type StageRunIdentity,
  type ArtifactEnvelope,
  type SubmitPlanPayload,
  type ReportReviewPayload,
  type ReportCompletionPayload,
  type ScopedTokenBinding,
  type CreateTaskToolPayload,
} from './tasks/workOrder.js';
export {
  WATCHDOG_GOVERNED_LIVENESS,
  ALL_SESSION_LIVENESS,
  NON_GOVERNED_SESSION_LIVENESS,
  WATCHDOG_BLOCKING_ATTENTION_REASONS,
  ALL_ATTENTION_REASONS,
  NON_BLOCKING_ATTENTION_REASONS,
  TRANSCRIPT_APPEND_EVENT_TYPES,
  ALL_EVENT_TYPES,
  NON_HEARTBEAT_EVENT_TYPES,
  isWatchdogGovernedLiveness,
  isBlockingAttentionReason,
  isTranscriptAppendEventType,
  assessStageRun,
  type StageRunObservation,
  type WatchdogPolicy,
  type WatchdogVerdict,
  type WatchdogHealthyReason,
} from './tasks/watchdogDecision.js';
export {
  cacheObservabilityProjection,
  type CacheObservabilityState,
  type CacheObservabilityRecord,
} from './projections/cacheObservability.js';
export {
  classifyTtlTier,
  readCacheTokens,
  cacheHitRate,
  readServiceTier,
  type TtlTier,
  type CacheTokenTotals,
} from './cacheClassification.js';

export {
  TranscriptTail,
  DEFAULT_MAX_LINE_BYTES,
  type TailOutput,
  type TailQuarantineReason,
} from './transcript/tail.js';
export { mapTranscriptOutputs } from './transcript/mapper.js';

export {
  SLICE_5B_PRICE_TABLE,
  PRICE_TABLE_EFFECTIVE_DATE,
  PINNED_MODEL_BASE_PRICES,
  NANO_DOLLARS_PER_DOLLAR,
  NANO_DOLLARS_PER_MICRO_DOLLAR,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  buildPriceTable,
  deriveModelRateSet,
  dollarsPerMTokToNanoPerToken,
  applyCacheMultiplier,
  normalizeModelToKey,
  nanoDollarsToMicroDollars,
  formatUsd,
  type PriceTable,
  type ModelRateSet,
  type PinnedModelBasePrice,
  type CacheMultiplier,
} from './pricing/priceTable.js';
export {
  priceUsageRow,
  totalNanoDollars,
  type PriceableUsageRow,
  type PricedRow,
  type PriceStatus,
  type PriceFlagReason,
  type PricedCategoryAmounts,
} from './pricing/priceUsageRow.js';
export {
  buildCostTree,
  buildParentMap,
  resolveDirectoryKey,
  sessionDisplayLabel,
  findReconciliationViolations,
  assertTreeReconciles,
  OUTSIDE_ROOTS_PROJECT_KEY,
  UNKNOWN_DIRECTORY_KEY,
  UNKNOWN_SESSION_KEY,
  ABSENT_ATTRIBUTION_KEY,
  type CostTreeInputRow,
  type CostTree,
  type DirectoryNode,
  type SessionNode,
  type AgentNode,
  type AttributionGroup,
  type RollupTotals,
  type RowTokenCounts,
  type PriceStatusCounts,
  type AgentParentEdge,
  type ExplicitAgentParentEdge,
  type BuildCostTreeOptions,
  type ReconciliationViolation,
} from './pricing/costTree.js';
export {
  buildCostLedgerReadModel,
  COST_LEDGER_SCOPE_LABEL,
  UNKNOWN_DAY_KEY,
  type CostLedgerInputRow,
  type CostLedgerReadModel,
  type BuildCostLedgerOptions,
  type MoneyAmount,
  type RollupView,
  type DirectoryView,
  type SessionView,
  type AgentView,
  type AttributionView,
  type SpendHistory,
  type SpendHistoryPoint,
  type DirectorySpendSeries,
  type PriceStatusCountsView,
} from './pricing/costLedgerReadModel.js';

// B1 — the usage-poller auth-failure backoff DECISION (pure reducer). The
// daemon boundary (app.ts) owns the actual setTimeout; this only says how long
// to wait given the last poll's outcome. Not the token-refresh fix (A / D49).
export {
  nextUsageBackoff,
  initialUsageBackoffState,
  type UsageBackoffState,
  type UsageBackoffConfig,
} from './usageBackoff.js';

export * from './harness/index.js';

// S10·Move-1b — the manifest parser reaches its first consumer. Move 1a landed
// `extensions/manifest.ts` unexported on purpose (nothing outside core needed
// it yet, rule 0.5); the daemon-side registry
// (`packages/daemon/src/extensionRegistry.ts`) is that consumer, and the
// package's convention is the barrel. A NAMED list rather than `export *`:
// the parser's vocabulary is large and generically-spelled, and a wildcard
// would put ~40 names into a barrel the UI also reads from.
export {
  parseExtensionManifest,
  preParseApiVersion,
  isSemver,
  isSemverRange,
  API_VERSION,
  KNOWN_CAPABILITIES,
  KNOWN_ATTENTION_RANKS,
  RESERVED_AUTHORITY_PROPERTIES,
  type ParseManifestOptions,
  type ParseManifestResult,
  type ParsedManifest,
  type ParsedVerb,
  type ParsedWorkflow,
  type ManifestIssue,
  type ManifestError,
  type ManifestWarning,
} from './extensions/manifest.js';

// S12·U1 (D72 Move 3) — the declaration-reading move adjudicator. Named, not
// wildcarded, for the same reason the parser's list above is named. The old
// compiled-table machine is still the runtime path this slice; U2 flips the
// writer onto this one.
// S13·U1 adds `engineRefusalReasonSchema` — the CLOSED half of the two-channel
// refusal vocabulary (slice-13 F1), exported so the engine's exact membership is
// assertable from outside and so read-side code can tell an engine refusal from a
// declared one WITHOUT the engine enumerating declared strings.
export {
  proposeMove,
  engineRefusalReasonSchema,
  type MoveProposal,
  type MoveDecision,
  type EngineRefusalReason,
} from './extensions/proposeMove.js';
