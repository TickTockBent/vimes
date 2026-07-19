import {
  EVENT_TYPES,
  notificationTriggerPayloadSchema,
  pushFailed,
  pushSent,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionsProjection,
  type AttentionReason,
  type EventRecord,
  type EventRouter,
  type EventStore,
  type SessionRecord,
} from '@vimes/core';
import type { PushSubscriptionRecord } from './pushService.js';
import { PushSubscriptions } from './pushSubscriptions.js';
import { buildPushPayload, type PushSender } from './pushService.js';

// ─── Push pipeline (slice-2 step 3) ──────────────────────────────────────────
//
// The daemon-side subscriber that turns notification_trigger events into web-push
// deliveries. It registers ONE router subscription per session stream (the router
// fans out per stream; the host tells us of a new session via watch()). On a
// trigger it applies the D9 re-alert suppression, then fires a send to EVERY
// subscription — fire-and-forget, NEVER blocking the event path. Each outcome is
// evented (push_sent / push_failed); a dead subscription (404/410) is pruned.

// D9 (ack semantics): viewing a session sets seenAt; a session whose seenAt is
// at-or-after the current needsAttention.since has been acknowledged, so a repeat
// trigger for that same attention must NOT re-alert. Pure + total (ISO ts compare
// lexically). Returns true when the push should be SUPPRESSED.
export function shouldSuppressPush(session: SessionRecord | undefined): boolean {
  if (session === undefined) {
    return true; // unknown session — nothing to notify about (defensive)
  }
  const attention = session.needsAttention;
  if (attention === null) {
    return true; // attention already cleared (dismissed / answered / resumed)
  }
  return session.seenAt !== null && session.seenAt >= attention.since;
}

export interface PushPipelineDeps {
  router: EventRouter;
  store: EventStore;
  sender: PushSender;
  subscriptions: PushSubscriptions;
}

export class PushPipeline {
  private readonly router: EventRouter;
  private readonly store: EventStore;
  private readonly sender: PushSender;
  private readonly subscriptions: PushSubscriptions;
  // One unsubscribe per watched session stream (idempotent — watch() is a no-op
  // for a stream already watched).
  private readonly unsubscribeByStream = new Map<string, () => void>();
  // Set on stop() so an in-flight async send resolving during shutdown does not
  // emit onto a disposed store.
  private stopped = false;

  constructor(deps: PushPipelineDeps) {
    this.router = deps.router;
    this.store = deps.store;
    this.sender = deps.sender;
    this.subscriptions = deps.subscriptions;
  }

  // Subscribe to every session stream already in the log (a prior boot's sessions
  // may fire triggers after a resume). New sessions arrive via watch() (the host's
  // onSessionCreated callback). Subscribing at current head means only FUTURE
  // triggers push — a boot never re-alerts historical triggers.
  start(): void {
    for (const appSessionId of Object.keys(this.currentSessions())) {
      this.watch(appSessionId);
    }
  }

  // Register a per-stream subscription from the stream's current head, delivering
  // only notification_trigger events to the handler. Idempotent.
  watch(appSessionId: string): void {
    if (this.unsubscribeByStream.has(appSessionId)) {
      return;
    }
    const head = this.store.head(appSessionId);
    const unsubscribe = this.router.subscribe(appSessionId, head, (record) => {
      if (record.type === EVENT_TYPES.notificationTrigger) {
        this.handleTrigger(record);
      }
    });
    this.unsubscribeByStream.set(appSessionId, unsubscribe);
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribeByStream.values()) {
      unsubscribe();
    }
    this.unsubscribeByStream.clear();
  }

  watchedStreamCount(): number {
    return this.unsubscribeByStream.size;
  }

  private handleTrigger(record: EventRecord): void {
    const parsed = notificationTriggerPayloadSchema.safeParse(record.payload);
    if (!parsed.success) {
      return;
    }
    const { appSessionId, reason } = parsed.data;
    // D9 suppression: fold the log (persist-before-broadcast I13 means the
    // attention setter batched with this trigger is already applied).
    const session = this.currentSessions()[appSessionId];
    if (shouldSuppressPush(session)) {
      return;
    }
    const payload = buildPushPayload({ appSessionId, name: session!.name, reason });
    const payloadJson = JSON.stringify(payload);
    // Fire-and-forget per subscription: the send is async and its outcome event is
    // emitted from a later microtask, so the event path (this dispatch) is never
    // blocked by network latency.
    for (const subscription of this.subscriptions.all()) {
      void this.deliver(subscription, payloadJson, appSessionId, reason);
    }
  }

  private async deliver(
    subscription: PushSubscriptionRecord,
    payloadJson: string,
    appSessionId: string,
    reason: AttentionReason,
  ): Promise<void> {
    let outcome: { ok: boolean; statusCode?: number };
    try {
      outcome = await this.sender.send(subscription, payloadJson);
    } catch {
      // The sender contract is not to throw, but stay defensive — a throw becomes
      // a failure with no statusCode rather than an unhandled rejection.
      outcome = { ok: false };
    }
    // Shutdown race: the store may have been disposed while this send was in
    // flight. Do not emit onto it (the delivery still happened; the outcome event
    // is best-effort).
    if (this.stopped) {
      return;
    }
    if (outcome.ok) {
      this.router.emit([pushSent({ appSessionId, reason })]);
      return;
    }
    this.router.emit([
      outcome.statusCode === undefined
        ? pushFailed({ appSessionId, reason })
        : pushFailed({ appSessionId, reason, statusCode: outcome.statusCode }),
    ]);
    // A gone subscription (404/410) is pruned so it is not retried forever.
    if (outcome.statusCode === 404 || outcome.statusCode === 410) {
      this.subscriptions.remove(subscription.endpoint);
    }
  }

  private currentSessions(): Record<string, SessionRecord> {
    return replayFromEmpty(sessionsProjection, readAllStreamsGrouped(this.store)).sessions;
  }
}
