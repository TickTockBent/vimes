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
  HARNESS_WRAPPER_TITLE_PREFIXES,
  SESSION_TITLE_MAX_LENGTH,
  SHORT_SESSION_ID_LENGTH,
  UNKNOWN_SESSION_LABEL,
  type SessionLabelInputs,
} from './sessionIdentity.js';
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
export { tasksProjection, type TasksState } from './projections/tasks.js';
export {
  TASK_STAGES,
  TASK_STAGE_EDGES,
  INITIAL_TASK_STAGE,
  taskStageSchema,
  transitionProposedBySchema,
  transitionRejectionReasonSchema,
  isLegalTaskEdge,
  proposeTransition,
  taskStageEdgesRecord,
  type TaskStage,
  type TransitionProposal,
  type TransitionProposedBy,
  type TransitionOutcome,
  type TransitionRejectionReason,
} from './tasks/taskStateMachine.js';
export {
  DISPATCHABLE_TASK_STAGES,
  NON_DISPATCHABLE_TASK_STAGES,
  dispatchRefuseReasonSchema,
  dispatchDeferReasonSchema,
  isDispatchableStage,
  decideDispatch,
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
  type StageRunIdentity,
  type ArtifactEnvelope,
  type SubmitPlanPayload,
  type ReportReviewPayload,
  type ReportCompletionPayload,
  type ScopedTokenBinding,
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
