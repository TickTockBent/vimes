import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord } from '../schemas.js';
import { EVENT_TYPES, usageBlockPayloadSchema } from '../events.js';
import {
  cacheHitRate,
  classifyTtlTier,
  readCacheTokens,
  readServiceTier,
  type TtlTier,
} from '../cacheClassification.js';
import type { Projection } from './projection.js';

// Cache-observability read model (rule 0.3 — pure fold over the event log). THIS
// projection is the single source of cache observability (principle 9): it does
// NOT emit ttl_tier_observed / billing_bucket_observed events and does NOT feed
// the reserved session observedTtlTier / observedBillingBucket fields — the UI
// joins this projection to the session list by appSessionId. Two homes for one
// fact is the losing position.

// One session's accumulated cache picture.
export interface CacheObservabilityRecord {
  appSessionId: string;
  // Distinct usage snapshots counted into the totals (a repeated messageId is
  // counted once — see D17 dedupe below).
  sampleCount: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  inputTokens: number;
  outputTokens: number;
  // Derived from the accumulated totals after each counted block.
  cacheHitRate: number;
  // The latest observed block's TTL classification (idempotent for a repeat —
  // the repeat carries identical usage).
  ttlTier: TtlTier;
  // Raw service_tier from the latest block (D24 — no fabricated billing bucket),
  // or null when never observed.
  serviceTier: string | null;
  // The event `ts` (ISO string) of the MOST RECENTLY OBSERVED usage_block for
  // this session — an observed fact, never a clock read (rule 0.3, I6): the UI
  // ages it against its own now to infer cache warmth. Null until the first
  // block is observed. Follows the same latest-observation semantics as
  // ttlTier/serviceTier: a counted-repeat is a later observation of the same
  // turn, and for "last activity" it IS activity, so it advances this too.
  latestBlockAt: string | null;
  // The messageIds already folded into the totals, in append order — the D17
  // dedupe key set. Blocks with no messageId are counted but leave no entry
  // here (they cannot be deduped).
  countedMessageIds: string[];
}

export interface CacheObservabilityState {
  perSession: Record<string, CacheObservabilityRecord>;
}

function emptyRecord(appSessionId: string): CacheObservabilityRecord {
  return {
    appSessionId,
    sampleCount: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitRate: 0,
    ttlTier: 'none',
    serviceTier: null,
    latestBlockAt: null,
    countedMessageIds: [],
  };
}

export const cacheObservabilityProjection: Projection<CacheObservabilityState> = {
  id: 'cache-observability',

  init(): CacheObservabilityState {
    return { perSession: {} };
  },

  // TOTAL: only usage_block events matter; everything else is a no-op. A
  // malformed usage_block payload is ignored (safeParse). apply NEVER mutates
  // `state` — snapshots share references with live state.
  apply(state: CacheObservabilityState, event: EventRecord): CacheObservabilityState {
    if (event.type !== EVENT_TYPES.usageBlock) {
      return state;
    }
    const parsed = usageBlockPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      return state;
    }
    const payload = parsed.data;
    const usage = payload.usage as Record<string, unknown>;
    const priorRecord = state.perSession[payload.appSessionId] ?? emptyRecord(payload.appSessionId);

    // D17 dedupe: identical usage snapshots repeat within one API turn under the
    // SAME message.id. A block whose messageId is already counted is a repeat —
    // do NOT add its tokens again (that is the double-count D17 warns of). We
    // still refresh ttlTier/serviceTier to the latest observation, which is a
    // no-op in value for a genuine repeat (identical usage) but keeps the rule
    // simple. Blocks with no messageId cannot be deduped and are counted
    // individually.
    const messageId = payload.messageId;
    const isCountedRepeat =
      messageId !== undefined && priorRecord.countedMessageIds.includes(messageId);

    const latestTtlTier = classifyTtlTier(usage);
    const latestServiceTier = readServiceTier(usage);

    if (isCountedRepeat) {
      const refreshedRecord: CacheObservabilityRecord = {
        ...priorRecord,
        ttlTier: latestTtlTier,
        serviceTier: latestServiceTier,
        // A repeat is a later observation of the same turn — still activity, so
        // it advances "last observed block" like ttlTier/serviceTier above.
        latestBlockAt: event.ts,
      };
      return {
        perSession: { ...state.perSession, [payload.appSessionId]: refreshedRecord },
      };
    }

    // New messageId (or none): fold this block's tokens into the totals.
    const blockTokens = readCacheTokens(usage);
    const accumulatedCacheReadTokens = priorRecord.cacheReadTokens + blockTokens.cacheReadTokens;
    const accumulatedCacheCreateTokens =
      priorRecord.cacheCreateTokens + blockTokens.cacheCreateTokens;
    const accumulatedInputTokens = priorRecord.inputTokens + blockTokens.inputTokens;
    const accumulatedOutputTokens = priorRecord.outputTokens + blockTokens.outputTokens;

    const nextCountedMessageIds =
      messageId === undefined
        ? priorRecord.countedMessageIds
        : [...priorRecord.countedMessageIds, messageId];

    const nextRecord: CacheObservabilityRecord = {
      appSessionId: payload.appSessionId,
      sampleCount: priorRecord.sampleCount + 1,
      cacheReadTokens: accumulatedCacheReadTokens,
      cacheCreateTokens: accumulatedCacheCreateTokens,
      inputTokens: accumulatedInputTokens,
      outputTokens: accumulatedOutputTokens,
      cacheHitRate: cacheHitRate({
        cacheReadTokens: accumulatedCacheReadTokens,
        cacheCreateTokens: accumulatedCacheCreateTokens,
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
      }),
      ttlTier: latestTtlTier,
      serviceTier: latestServiceTier,
      // The event's OWN ts (I6 deterministic under replay), never a clock read.
      latestBlockAt: event.ts,
      countedMessageIds: nextCountedMessageIds,
    };

    return {
      perSession: { ...state.perSession, [payload.appSessionId]: nextRecord },
    };
  },

  serialize(state: CacheObservabilityState): string {
    return canonicalJson(state);
  },
};
