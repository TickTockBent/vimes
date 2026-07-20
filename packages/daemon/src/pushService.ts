import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import type { AttentionReason } from '@vimes/core';

// ─── Web push service (slice-2 step 3) ───────────────────────────────────────
//
// determinism-exempt (rule 0.3): real crypto (VAPID keygen) + network (the push
// service POST) live here, the daemon boundary. The core never imports this. The
// send seam is an injected interface so CI runs a fake recorder — a real browser
// / push service NEVER runs in the harness (spec §7).
//
// PRIVACY: a subscription's endpoint + keys are transport material. They live in
// the cache-class push_subscriptions table and are handed to the sender; they are
// NEVER written to the event log (push_sent/push_failed carry no endpoint).

// A W3C Push API subscription, validated LOOSE (rule 0.6): the shape is the
// browser's, so beyond endpoint + keys everything rides through.
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh?: string; auth?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// The one send seam. Resolves with the outcome; NEVER throws (a transport error
// resolves to { ok: false }), so the fire-and-forget pipeline can classify it.
export interface PushSender {
  send(
    subscription: PushSubscriptionRecord,
    payloadJson: string,
  ): Promise<{ ok: boolean; statusCode?: number }>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// Loose runtime check that a parsed object looks like a subscription (endpoint
// URL + a keys object). Used by the WS ingress before persisting one.
export function isValidPushSubscription(candidate: unknown): candidate is PushSubscriptionRecord {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) {
    return false;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(record.endpoint);
  } catch {
    return false;
  }
  return typeof record.keys === 'object' && record.keys !== null && !Array.isArray(record.keys);
}

// VAPID keys are generated ONCE at first boot and reused thereafter. Stored as
// <dataDir>/vapid.json, mode 600 (the private key is signing material). Loaded on
// every subsequent boot so the public key the client subscribed against is stable.
export function vapidKeyPath(dataDir: string): string {
  return join(dataDir, 'vapid.json');
}

export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const path = vapidKeyPath(dataDir);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
    // A corrupt file is regenerated rather than crashing the daemon (cache-class).
  }
  // determinism-exempt: real VAPID keypair (local crypto, no network).
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is masked by umask on create; chmod pins 600 regardless.
  chmodSync(path, 0o600);
  return keys;
}

// The real sender wrapping web-push. determinism-exempt: network POST to the push
// service. NEVER constructed in CI (deps.pushSender injects a fake).
export function createWebPushSender(args: { vapid: VapidKeys; subject: string }): PushSender {
  return {
    async send(subscription, payloadJson) {
      try {
        const result = await webpush.sendNotification(
          subscription as unknown as webpush.PushSubscription,
          payloadJson,
          {
            vapidDetails: {
              subject: args.subject,
              publicKey: args.vapid.publicKey,
              privateKey: args.vapid.privateKey,
            },
          },
        );
        return { ok: true, statusCode: result.statusCode };
      } catch (error) {
        // web-push throws WebPushError with a numeric statusCode on an HTTP error
        // (404/410 = gone). A bare network failure has no statusCode.
        const statusCode =
          typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : undefined;
        return statusCode === undefined ? { ok: false } : { ok: false, statusCode };
      }
    },
  };
}

// ─── Payload builder (pure) ──────────────────────────────────────────────────
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

// A short, reason-specific one-liner for the notification body.
export function reasonBody(reason: AttentionReason): string {
  switch (reason) {
    case 'gate':
      return 'Waiting for your approval';
    case 'question':
      return 'Claude has a question for you';
    case 'completed':
      return 'The run finished';
    case 'stale':
      return 'This session looks stuck';
    case 'quarantined':
      return 'A task was quarantined';
    // Reserved (rule 0.5): no setter emits these yet — 'rate-limited' lands
    // slice 5, 'brake' lands slice 7. Bodies included now so this switch
    // stays exhaustive over AttentionReason.
    case 'rate-limited':
      return 'Hit a rate limit';
    case 'brake':
      return 'Held by a brake';
    default:
      return 'Needs your attention';
  }
}

// Build the notification payload. Title prefers the session name; falls back to an
// id prefix. The deep link is the client hash route for the exact session.
export function buildPushPayload(args: {
  appSessionId: string;
  name: string | null;
  reason: AttentionReason;
}): PushPayload {
  const title = args.name !== null && args.name.length > 0 ? args.name : args.appSessionId.slice(0, 8);
  return {
    title,
    body: reasonBody(args.reason),
    url: `/#/session/${args.appSessionId}`,
  };
}
