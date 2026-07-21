import {
  EVENT_TYPES,
  USAGE_STREAM,
  meterAlertPayloadSchema,
  rememberMeterAlert,
  type EventStore,
  type MeterAlertMemory,
  type MeterAlertPayload,
} from '@vimes/core';
import type { PushPayload, PushSender, PushSubscriptionRecord } from './pushService.js';
import type { PushSubscriptions } from './pushSubscriptions.js';

// ─── Meter alerts at the daemon boundary (slice 5 step 4b, deliverable 4) ────
//
// 4a landed the PURE evaluator (`evaluateMeterAlerts`): edge-triggered, re-armed
// only on a window reset, suppression driven entirely by a `MeterAlertMemory`
// handed to it. This module supplies that memory from the event log and turns
// the returned payloads into `meter_alert` events plus one push each.
//
// It deliberately does NOT go through `PushPipeline`. That class is
// SESSION-scoped and applies D9 *seen*-based suppression — "has the human looked
// at this session" — which is the wrong question entirely for an account-wide
// meter that belongs to no session. 4a's evaluator owns suppression here.

// ─── the alert memory, rebuilt from the log ─────────────────────────────────
//
// DERIVABLE, NOT STATEFUL. The memory is exactly `fold(rememberMeterAlert)` over
// every `meter_alert` event on the 'usage' stream. A daemon restart therefore
// re-derives the same suppression state it had before, and cannot re-alert a
// threshold already fired in the still-current window — the same discipline
// `PushPipeline.start()` uses when it subscribes at current head so a boot never
// re-alerts history.
//
// ─── THE BOUNDED-READ RULE (finding, step 4a) ────────────────────────────────
// The step-4a finding: *absence of evidence of a reset was read as evidence of a
// reset*, because running off the end of a bounded buffer looked identical to a
// rollover. The same trap exists here, one layer out: if this fold ever ran off
// the end of a bounded read — a query LIMIT, a snapshot horizon, a "last N
// events" window — the missing alerts would look like alerts that never fired,
// and every one of them would re-fire.
//
// So this fold is structurally incapable of running off an end:
//   * it starts at seq 1 (the true beginning of the stream), never at a snapshot
//     mark and never at head;
//   * `EventStore.read(stream, fromSeq)` has NO limit — it returns every record
//     from `fromSeq` to head;
//   * it advances `nextSeqToFold` only past records it actually folded, so a
//     later call resumes exactly where the previous one stopped.
// If a bounded read is ever introduced here, the correct degradation is to keep
// the PREVIOUS memory and STAY SUPPRESSED — never to treat the unread span as
// "nothing fired".
export class MeterAlertLedger {
  private readonly store: EventStore;
  private memory: MeterAlertMemory = {};
  // The next 'usage' stream sequence this ledger has not folded yet. Streams are
  // 1-based (the store assigns head+1), so 1 IS the beginning.
  private nextSeqToFold = 1;

  constructor(store: EventStore) {
    this.store = store;
  }

  /**
   * The alert memory as of the current head of the 'usage' stream. Folds any
   * `meter_alert` events appended since the last call, then returns the memory.
   */
  current(): MeterAlertMemory {
    const newRecords = this.store.read(USAGE_STREAM, this.nextSeqToFold);
    for (const record of newRecords) {
      if (record.seq >= this.nextSeqToFold) {
        this.nextSeqToFold = record.seq + 1;
      }
      if (record.type !== EVENT_TYPES.meterAlert) {
        continue;
      }
      const parsedPayload = meterAlertPayloadSchema.safeParse(record.payload);
      if (!parsedPayload.success) {
        // An unreadable alert event is skipped, not guessed at. It cannot
        // re-arm anything: it simply is not in the memory, which is the quiet
        // direction only because a MISSING alert is the loud one — hence the
        // schema being validated at emit time too.
        continue;
      }
      this.memory = rememberMeterAlert(this.memory, parsedPayload.data);
    }
    return this.memory;
  }
}

// ─── the push payload ────────────────────────────────────────────────────────

// A human label for the meter. `scope` (e.g. a model display name from a
// weekly_scoped limit) is appended when the source gave one; it is never
// invented.
export function meterAlertLabel(alert: MeterAlertPayload): string {
  const kindLabel =
    alert.kind === 'rolling-window'
      ? 'Rolling window'
      : alert.kind === 'weekly-cap'
        ? 'Weekly cap'
        : 'Monthly credit';
  const scopeName = alert.scope ?? null;
  return scopeName === null || scopeName.length === 0 ? kindLabel : `${kindLabel} (${scopeName})`;
}

// "1h 20m" / "45m" / "2d 3h" — the countdown to the window rolling over. Null
// (and therefore OMITTED from the notification) when `resetsAt` is absent or
// unparseable, or already past. Never "0m": a countdown we cannot compute is not
// a countdown of zero.
export function resetCountdownText(resetsAt: string | null | undefined, nowIso: string): string | null {
  if (typeof resetsAt !== 'string' || resetsAt.length === 0) {
    return null;
  }
  const resetsAtMs = Date.parse(resetsAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Deliberately NOT `buildPushPayload`'s session wording. Its {title, body, url}
// CONVENTION is reused (that is the contract the service worker renders), but a
// meter alert names a budget, not a session, and its deep link is the meters
// view rather than a session stream.
//
// `/#/meters` is the reserved meters deep link. The client router falls through
// to the home screen for an unrecognized hash, and the meters strip lives on the
// home screen — so this link is correct today and stays correct when a dedicated
// meters view lands.
export const METER_ALERT_DEEP_LINK = '/#/meters';

export function buildMeterAlertPushPayload(alert: MeterAlertPayload, nowIso: string): PushPayload {
  const observedPercentText = `${Math.round(alert.observedPercent)}%`;
  const countdown = resetCountdownText(alert.resetsAt ?? null, nowIso);
  const thresholdSentence = `Crossed ${alert.thresholdPercent}% — now at ${observedPercentText}.`;
  return {
    title: `${meterAlertLabel(alert)} at ${observedPercentText}`,
    body: countdown === null ? thresholdSentence : `${thresholdSentence} Resets in ${countdown}.`,
    url: METER_ALERT_DEEP_LINK,
  };
}

// ─── delivery ────────────────────────────────────────────────────────────────

export interface MeterAlertPushDeps {
  sender: PushSender;
  subscriptions: PushSubscriptions;
  // Single-line warning sink (never a payload dump). Defaults to console.warn.
  warn?: (message: string) => void;
}

/**
 * Send ONE alert to every registered subscription. Fire-and-forget per
 * subscription and NEVER fatal: a push failure is logged, not thrown, so a dead
 * push service can never take the usage poll down with it.
 *
 * A gone subscription (404/410) is PRUNED, exactly as `PushPipeline.deliver`
 * does — a stale subscription left by a cleared PWA install produced a real 410
 * in this project, and retrying it forever is pure waste.
 */
export async function sendMeterAlertPush(
  alert: MeterAlertPayload,
  nowIso: string,
  deps: MeterAlertPushDeps,
): Promise<void> {
  const warn =
    deps.warn ??
    ((message: string): void => {
      // eslint-disable-next-line no-console
      console.warn(message);
    });
  const payloadJson = JSON.stringify(buildMeterAlertPushPayload(alert, nowIso));
  const subscriptions: PushSubscriptionRecord[] = deps.subscriptions.all();
  for (const subscription of subscriptions) {
    let outcome: { ok: boolean; statusCode?: number };
    try {
      outcome = await deps.sender.send(subscription, payloadJson);
    } catch {
      // The sender contract is not to throw, but stay defensive.
      outcome = { ok: false };
    }
    if (outcome.ok) {
      continue;
    }
    warn(
      `vimes-daemon: meter alert push failed for ${alert.meterId} (status ${outcome.statusCode ?? 'none'})`,
    );
    if (outcome.statusCode === 404 || outcome.statusCode === 410) {
      deps.subscriptions.remove(subscription.endpoint);
    }
  }
}
