import { z } from 'zod';

export const sessionRecordSchema = z.object({
  appSessionId: z.string(),
  channel: z.enum(['sdk', 'pty']),
  cwd: z.string(),
  claudeSessionIds: z.array(
    z.object({
      id: z.string(),
      jsonlPath: z.string(),
      observedAt: z.string(),
    }),
  ),
  liveness: z.enum(['spawning', 'running', 'dormant', 'interrupted', 'dead']),
  needsAttention: z
    .object({
      // 'rate-limited' and 'brake' are reserved (rule 0.5): no setter emits
      // them yet — 'rate-limited' lands with slice 5 (StopFailure/
      // rate_limit_event), 'brake' with slice 7 (cascade guard).
      reason: z.enum(['gate', 'question', 'completed', 'stale', 'quarantined', 'rate-limited', 'brake']),
      since: z.string(),
    })
    .nullable(),
  seenAt: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  taskRef: z
    .object({
      taskId: z.string(),
      stage: z.string(),
    })
    .nullable(),
  observedTtlTier: z.enum(['1h', '5m', 'mixed', 'unknown']),
  observedBillingBucket: z.enum(['interactive', 'non-interactive', 'unknown']),
  name: z.string().nullable(),
  createdAt: z.string(),
  // D18 (E1): which provider hosts this session. MVP is Claude-only, so the
  // sessions projection stamps 'claude-code' whenever session_created omits it;
  // the field is reserved now so later payloads inherit the neutrality review.
  // Old snapshots (cache-class, rebuilt from the log) may lack it at runtime —
  // tolerated: nothing validates a snapshot's records against this schema on
  // load, and the next snapshot save self-heals.
  provider: z.string(),
  // D10: custody of the session's Claude process. 'host' — VIMES spawned it and
  // owns the process (writable, killable, resumable). 'external' — a
  // terminal-started/historical session VIMES only mirrors read-only via the
  // tailer; the host never writes to it and attention setters never fire for it,
  // until it is adopted (explicit or resume-through-VIMES). Defaulted to 'host'
  // at the projection when session_created omits it, so old logs/snapshots
  // tolerate — same neutrality posture as provider.
  custody: z.enum(['host', 'external']),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const eventRecordSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().positive(),
  stream: z.string(),
  ts: z.string(),
  type: z.string(),
  payload: z.unknown(),
});
export type EventRecord = z.infer<typeof eventRecordSchema>;

export const eventInputSchema = z.object({
  stream: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
});
export type EventInput = z.infer<typeof eventInputSchema>;

export const projectionSnapshotSchema = z.object({
  projectionId: z.string(),
  lastAppliedSeq: z.record(z.string(), z.number()),
  state: z.unknown(),
  savedAt: z.string(),
});
export type ProjectionSnapshot = z.infer<typeof projectionSnapshotSchema>;

export const taskRecordSchema = z.object({
  taskId: z.string(),
  projectRoot: z.string(),
  stage: z.enum([
    'backlog',
    'planning',
    'plan-ready',
    'implementing',
    'review',
    'done',
    'blocked-external',
    'quarantined',
  ]),
  manualReviewRequired: z.boolean(),
  isolation: z.enum(['shared-dir', 'worktree']),
  gates: z.object({
    deferUntilReset: z.string().optional(),
    requireHeadroom: z
      .object({
        meterId: z.string(),
        pct: z.number(),
      })
      .optional(),
  }),
  sessionRefs: z.array(
    z.object({
      stage: z.string(),
      appSessionId: z.string(),
    }),
  ),
  createdBy: z.enum(['human', 'orchestrator']),
  lastHeartbeatAt: z.string().nullable(),
  staleRetries: z.number(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const meterRecordSchema = z.object({
  meterId: z.string(),
  kind: z.enum(['rolling-window', 'weekly-cap', 'monthly-credit']),
  scope: z.enum(['all-models', 'model-family', 'non-interactive']),
  modelFamily: z.string().nullable(),
  used: z.number(),
  limit: z.number().nullable(),
  unit: z.enum(['tokens', 'percent', 'usd']),
  resetsAt: z.string().nullable(),
  source: z.enum(['jsonl', 'otel', 'endpoint']),
  observedAt: z.string(),
  stale: z.boolean(),
});
export type MeterRecord = z.infer<typeof meterRecordSchema>;

export const achievementProgressSchema = z.object({
  achievementId: z.string(),
  progress: z.number(),
  target: z.number(),
  unlockedAt: z.string().nullable(),
  sourceEventIds: z.array(z.string()),
});
export type AchievementProgress = z.infer<typeof achievementProgressSchema>;
