// ─── slice 5b step 4a — the cost-ledger endpoint read model (thin, I/O only) ──
//
// Mirrors `usageDerived` / `/api/usage/derived`: the LOGIC lives in pure core
// (`buildCostLedgerReadModel`); this file only reads the durable ledger store,
// maps each `CostUsageRow` to the core input row field-for-field, and hands it
// off. It re-prices nothing and re-trees nothing.
//
// Rule 0.3: the daemon owns the I/O boundary (the store read); the core owns the
// meaning. When ingestion is disabled the store is null and there is nothing to
// read — the body says so honestly rather than fabricating a zero-ledger.

import {
  buildCostLedgerReadModel,
  type CostLedgerInputRow,
  type CostLedgerReadModel,
  type ExplicitAgentParentEdge,
} from '@vimes/core';
import type { CostUsageRow } from './costCorpus.js';
import type { SqliteCostStore } from './sqliteCostStore.js';

export interface CostLedgerBody {
  // FALSE = cost ingestion is disabled (costIngestIntervalMs 0), so no store was
  // opened and there is no ledger. Mirrors how the derived-usage body signals a
  // disabled poller: never a crash, never a fabricated empty ledger presented as
  // if it were an observed truth.
  ingestionEnabled: boolean;
  // The priced read model, or null when ingestion is disabled. When enabled but
  // the corpus is empty this is a real, populated envelope with an empty tree —
  // "nothing ingested yet" is distinct from "feature off".
  ledger: CostLedgerReadModel | null;
}

// Map the daemon's stored row to the core input row, field-for-field. Only the
// fields pricing / the tree / the history need are carried; the store's dedupe
// bookkeeping (rowKey, undedupable, settledScore, requestId, …) is not.
function toInputRow(storedRow: CostUsageRow): CostLedgerInputRow {
  return {
    model: storedRow.model,
    inputTokens: storedRow.inputTokens,
    outputTokens: storedRow.outputTokens,
    cacheReadInputTokens: storedRow.cacheReadInputTokens,
    cacheCreationInputTokens: storedRow.cacheCreationInputTokens,
    cacheCreation5mInputTokens: storedRow.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: storedRow.cacheCreation1hInputTokens,
    speed: storedRow.speed,
    serviceTier: storedRow.serviceTier,
    inferenceGeo: storedRow.inferenceGeo,
    sessionId: storedRow.sessionId,
    agentId: storedRow.agentId,
    toolUseResultAgentId: storedRow.toolUseResultAgentId,
    projectSlug: storedRow.projectSlug,
    projectCwd: storedRow.projectCwd,
    insideProjectRoots: storedRow.insideProjectRoots,
    attributionAgent: storedRow.attributionAgent,
    attributionSkill: storedRow.attributionSkill,
    sourceKind: storedRow.sourceKind,
    timestamp: storedRow.timestamp,
  };
}

export interface CurrentCostLedgerArgs {
  // Null when ingestion is disabled.
  costLedgerStore: SqliteCostStore | null;
  // VIMES_PROJECT_ROOTS (D21) — passed through so project classification matches
  // rule 7.
  projectRoots: readonly string[];
}

/**
 * Build the cost-ledger body GET /api/cost/ledger serves.
 *
 * Disabled ingestion → `{ ingestionEnabled: false, ledger: null }`, never a
 * crash. Enabled → reads every stored row and builds the read model. If the
 * built tree fails to reconcile, `buildCostLedgerReadModel` throws (a rule-0.1
 * finding); the throw propagates so the route turns it into a 500 rather than
 * serving a wrong number.
 */
export function currentCostLedger(args: CurrentCostLedgerArgs): CostLedgerBody {
  if (args.costLedgerStore === null) {
    return { ingestionEnabled: false, ledger: null };
  }
  const inputRows = args.costLedgerStore.readUsageRows().map(toInputRow);
  // The agent→agent parent edges harvested out-of-band from no-usage records. The
  // usage rows carry no toolUseResult.agentId edge (the whole reason the tree came
  // out flat), so these injected edges are what let core nest the agents.
  const parentEdges: ExplicitAgentParentEdge[] = args.costLedgerStore
    .readAgentEdges()
    .map((edge) => ({
      sessionId: edge.sessionId,
      childAgentId: edge.childAgentId,
      parentAgentId: edge.parentAgentId,
    }));
  const ledger = buildCostLedgerReadModel(inputRows, {
    projectRoots: args.projectRoots,
    parentEdges,
  });
  return { ingestionEnabled: true, ledger };
}
