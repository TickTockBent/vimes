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

// D26 (2026-07-21, signed off): the authoritative usage source reports
// PERCENTAGES ONLY. `percent` + `unit` are explicit; `used`/`limit` are optional
// and present ONLY when a source actually supplies absolutes. A percentage is
// NEVER collapsed into `used = 29, limit = 100` — manufacturing an absolute the
// source never gave is precisely the lying meter pillar 4 forbids.
//
// Every widening here is OPTIONAL-only, so records written against the slice-0
// shape (the `budget-wall` harness profile, the daemon boot tests) still
// validate unchanged and serialize to the same bytes.
export const meterRecordSchema = z.object({
  meterId: z.string(),
  kind: z.enum(['rolling-window', 'weekly-cap', 'monthly-credit']),
  // Widened from the slice-0 enum to a free string: the endpoint's `limits[]`
  // entries scope a weekly cap to a model name (U1), which no closed enum can
  // enumerate without drifting (rule 0.6). The old enum values still validate.
  scope: z.string().nullable().optional(),
  // Legacy, superseded by `scope`. Optional so a percent-only source need not
  // invent it.
  modelFamily: z.string().nullable().optional(),
  // 0..100 — the observed utilization, the ONLY quantity the endpoint gives us.
  percent: z.number().nullable().optional(),
  // Absolutes: present only when a source genuinely supplies them (D26).
  used: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  // What `used`/`limit` are denominated in; null/absent when there are none.
  unit: z.enum(['tokens', 'percent', 'usd']).nullable().optional(),
  // The SERVER's own judgement (U1) — preferred over a local ⟨tune 80%⟩
  // threshold wherever it is present.
  severity: z.string().nullable().optional(),
  // Whether this is the currently BINDING limit, per the source (U1).
  isActive: z.boolean().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  source: z.enum(['jsonl', 'otel', 'endpoint']),
  // REQUIRED on every sample, so freshness is always DERIVABLE.
  observedAt: z.string(),
  // DEPRECATED (D26): freshness is derived by `meterFreshness`, never stored —
  // a stored flag lets a stale record masquerade as fresh. Retained as an
  // optional field only so slice-0-era records keep validating; no derivation
  // in meterDerivations.ts reads it.
  stale: z.boolean().nullable().optional(),
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
