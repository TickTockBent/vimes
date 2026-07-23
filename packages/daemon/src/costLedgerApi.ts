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
  type SessionsState,
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
  // VIMES_PROJECT_ROOTS (D21) — passed through so directory classification
  // matches binding data rule 9 (cwd + insideProjectRoots, never the slug).
  projectRoots: readonly string[];
  // The sessions projection, read FRESH per request (same pattern the watchdog
  // and the hub already use). It supplies the top rung of the identity ladder —
  // `name ?? derivedTitle`. Absent → every session falls to the distinguishing
  // fallback rung; a title is never fabricated.
  readSessions?: () => SessionsState;
}

/**
 * The join between the sessions projection and the cost rows: cost rows are keyed
 * by the CLAUDE session id (the `sessionId` field of the transcript JSONL), while
 * the projection is keyed by the VIMES app session id and records the claude ids
 * it has observed for each. Both are mapped to the same title so a cost row joins
 * whichever id it happens to carry — the two id spaces are both uuids and never
 * collide.
 *
 * ⚠ **`name ?? derivedTitle`, and the ORDER is the whole of Q3.** `name` is
 * HUMAN-supplied and only ever human-supplied (`session_created` from the spawn
 * op, `session_renamed` from the WS rename op — nothing else writes it);
 * `derivedTitle` is what the projection auto-derived from the first qualifying
 * user message. A human rename therefore wins here for the same reason it wins
 * everywhere: not because a rule says so, but because the auto-titler never
 * touched the field it would have to overwrite.
 *
 * Named "titles", not "names", because after this resolution the two are
 * indistinguishable downstream — calling the merged value a "name" would invite
 * a later reader to treat an auto-title as human intent.
 *
 * A blank title is dropped rather than mapped: the ladder must fall through to
 * the distinguishing fallback, not render an empty leaf.
 *
 * FIRST-WINS per id. A resumed or forked session can leave the same claude id
 * observed under two app sessions; first-wins makes the label a deterministic
 * function of the event log rather than of map-iteration luck.
 */
export function sessionTitlesByCostSessionId(
  sessionsState: SessionsState,
): Record<string, string> {
  const titlesBySessionId: Record<string, string> = {};
  const claimId = (sessionId: string, title: string): void => {
    if (!Object.hasOwn(titlesBySessionId, sessionId)) {
      titlesBySessionId[sessionId] = title;
    }
  };
  for (const sessionRecord of Object.values(sessionsState.sessions)) {
    // `name` first: a human rename outranks whatever the system derived.
    const humanName = sessionRecord.name;
    const derivedTitle = sessionRecord.derivedTitle;
    const title =
      humanName !== null && humanName.trim().length > 0
        ? humanName
        : derivedTitle !== undefined && derivedTitle.trim().length > 0
          ? derivedTitle
          : null;
    if (title === null) {
      continue;
    }
    claimId(sessionRecord.appSessionId, title);
    for (const claudeSessionId of sessionRecord.claudeSessionIds) {
      claimId(claudeSessionId.id, title);
    }
  }
  return titlesBySessionId;
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
  // The session titles (`name ?? derivedTitle` — the identity ladder's top rung).
  // Read only when a reader was wired; the tree degrades to the distinguishing
  // fallback otherwise rather than inventing a second source of session titles.
  const sessionTitles =
    args.readSessions === undefined ? undefined : sessionTitlesByCostSessionId(args.readSessions());
  const ledger = buildCostLedgerReadModel(inputRows, {
    projectRoots: args.projectRoots,
    parentEdges,
    sessionTitles,
  });
  return { ingestionEnabled: true, ledger };
}
