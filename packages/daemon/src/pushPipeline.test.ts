import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { WebSocket, type RawData } from 'ws';
import {
  SteppingClock,
  attentionCleared,
  gateFired,
  notificationTrigger,
  runCompleted,
  seen,
  sessionCreated,
  withNotificationTrigger,
  type EventRecord,
  type IdSource,
} from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import { shouldSuppressPush } from './pushPipeline.js';
import { DEFAULT_PUSH_TTL_SECONDS } from './pushService.js';
import type { PushSender, PushSendOptions, PushSubscriptionRecord } from './pushService.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-push-pipe-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';
// Two daemons boot over the SAME db file in the restart test; unique eventIds are
// required (host_started/host_stopped append on every boot). Mirror production.
const uniqueIds: IdSource = { uuid: () => randomUUID() };

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `pipe-${databaseFileCounter}.db`);
}

function buildConfig(dbPath: string): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath,
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    expectedSdkCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    // The stage-run watchdog (slice 6 step 5b): DISABLED in tests — 0 means the
    // daemon never creates the timer, so no test daemon can wake up and write
    // attention/notifications behind a case's back. The policy values are inert
    // while the interval is 0.
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    // Worker isolation (slice 6 step 8): OFF in tests, which is also the shipped
    // default — so no test daemon can create a worktree, and this root is never
    // touched. The flip is a human's; see taskDispatcher.ts's isolation block.
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
  };
}

interface RecordedSend {
  endpoint: string;
  payloadJson: string;
  options?: PushSendOptions;
}

// The injected fake sender — a real push service NEVER runs in CI (spec §7). It
// records each send (with the caller's urgency/TTL choice) and returns a
// configurable outcome per endpoint.
class FakePushSender implements PushSender {
  readonly sends: RecordedSend[] = [];
  outcomeFor: (endpoint: string) => { ok: boolean; statusCode?: number } = () => ({ ok: true, statusCode: 201 });

  async send(
    subscription: PushSubscriptionRecord,
    payloadJson: string,
    options?: PushSendOptions,
  ): Promise<{ ok: boolean; statusCode?: number }> {
    this.sends.push({ endpoint: subscription.endpoint, payloadJson, options });
    return this.outcomeFor(subscription.endpoint);
  }
}

// A shared clock keeps timestamps monotonic ACROSS a restart (a fresh clock per
// daemon would reset ts, making an old seenAt wrongly post-date a new gate and
// falsely suppress it — D9 compares ts).
function startDaemon(dbPath: string, pushSender: PushSender, clock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000)): Promise<Daemon> {
  const daemon = createDaemon({
    config: buildConfig(dbPath),
    clock,
    ids: uniqueIds,
    verifier: permissiveVerifier,
    pushSender,
  });
  return daemon.start().then(() => daemon);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

// Let the fire-and-forget sends + their push_sent/push_failed emits settle.
function flush(): Promise<void> {
  return delay(20);
}

const SUBSCRIPTION: PushSubscriptionRecord = {
  endpoint: 'https://push.example.com/ep-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

function systemEvents(daemon: Daemon): EventRecord[] {
  return daemon.store.read('system', 1);
}

function pushEventsOf(daemon: Daemon, type: 'push_sent' | 'push_failed'): EventRecord[] {
  return systemEvents(daemon).filter((event) => event.type === type);
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('shouldSuppressPush (pure, D9)', () => {
  const base = {
    appSessionId: 'app-1',
    channel: 'sdk' as const,
    cwd: '/x',
    claudeSessionIds: [],
    liveness: 'running' as const,
    forkedFrom: null,
    taskRef: null,
    observedTtlTier: 'unknown' as const,
    observedBillingBucket: 'unknown' as const,
    name: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    provider: 'claude-code',
    custody: 'host' as const,
  };

  it('does not suppress when attention is set and never seen', () => {
    expect(shouldSuppressPush({ ...base, needsAttention: { reason: 'gate', since: 'B' }, seenAt: null })).toBe(false);
  });
  it('suppresses when seenAt is at/after the current attention (acknowledged)', () => {
    expect(shouldSuppressPush({ ...base, needsAttention: { reason: 'gate', since: 'B' }, seenAt: 'C' })).toBe(true);
    expect(shouldSuppressPush({ ...base, needsAttention: { reason: 'gate', since: 'B' }, seenAt: 'B' })).toBe(true);
  });
  it('does not suppress when a NEW attention post-dates the last view', () => {
    expect(shouldSuppressPush({ ...base, needsAttention: { reason: 'gate', since: 'C' }, seenAt: 'B' })).toBe(false);
  });
  it('suppresses when attention is cleared or the session is unknown', () => {
    expect(shouldSuppressPush({ ...base, needsAttention: null, seenAt: 'B' })).toBe(true);
    expect(shouldSuppressPush(undefined)).toBe(true);
  });
});

describe('push pipeline — I5 end-to-end (real daemon, fake sender)', () => {
  it('sends on a gate, suppresses a re-alert after seen, resends after clear, survives restart, prunes a dead sub', async () => {
    const dbPath = nextDatabasePath();
    const sharedClock = new SteppingClock('2026-01-01T00:00:00.000Z', 1000);
    const sender = new FakePushSender();
    const daemon = await startDaemon(dbPath, sender, sharedClock);

    try {
      // A subscription is registered, and a host session exists + is watched (in
      // production the host's onSessionCreated callback calls watch()).
      daemon.pushSubscriptions.save(SUBSCRIPTION);
      daemon.router.emit([
        sessionCreated({ appSessionId: 'app-1', channel: 'sdk', cwd: '/x', name: 'Dongfu build', forkedFrom: null, taskRef: null }),
      ]);
      daemon.pushPipeline.watch('app-1');

      // 1) Gate fires → notification_trigger → exactly one send with the deep link.
      daemon.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-1', prompt: 'approve edit?', requestId: 'req-1' })));
      await flush();
      expect(sender.sends).toHaveLength(1);
      expect(sender.sends[0]!.endpoint).toBe(SUBSCRIPTION.endpoint);
      const payload = JSON.parse(sender.sends[0]!.payloadJson) as { title: string; body: string; url: string };
      expect(payload.url).toBe('/#/session/app-1');
      expect(payload.title).toBe('Dongfu build');
      // push_sent evented (system stream), carrying the attention reason only.
      const sentAfterFirst = pushEventsOf(daemon, 'push_sent');
      expect(sentAfterFirst).toHaveLength(1);
      expect(sentAfterFirst[0]!.payload).toEqual({ appSessionId: 'app-1', reason: 'gate' });

      // 2) seen (acks the notification), then a SECOND trigger for the SAME still-set
      //    attention → suppressed (no send, no push_sent).
      daemon.router.emit([seen({ appSessionId: 'app-1' })]);
      daemon.router.emit([notificationTrigger({ appSessionId: 'app-1', reason: 'gate' })]);
      await flush();
      expect(sender.sends).toHaveLength(1);
      expect(pushEventsOf(daemon, 'push_sent')).toHaveLength(1);

      // 3) attention_cleared + a NEW gate → sends again (post-dates the last view).
      daemon.router.emit([attentionCleared({ appSessionId: 'app-1', cause: 'dismissed' })]);
      daemon.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-1', prompt: 'approve again?', requestId: 'req-2' })));
      await flush();
      expect(sender.sends).toHaveLength(2);
      expect(pushEventsOf(daemon, 'push_sent')).toHaveLength(2);
    } finally {
      await daemon.stop();
    }

    // 4) Restart over the SAME db: the subscription survives (table), and the
    //    pipeline re-registers app-1 from the log (start(), no manual watch) so a
    //    fresh gate still pushes.
    const sender2 = new FakePushSender();
    const daemon2 = await startDaemon(dbPath, sender2, sharedClock);
    try {
      expect(daemon2.pushSubscriptions.count()).toBe(1);
      daemon2.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-1', prompt: 'post-restart gate', requestId: 'req-3' })));
      await flush();
      expect(sender2.sends).toHaveLength(1);
      expect(sender2.sends[0]!.endpoint).toBe(SUBSCRIPTION.endpoint);

      // 5) The push service reports the subscription gone (410) → push_failed with
      //    the statusCode, and the dead subscription is pruned.
      sender2.outcomeFor = () => ({ ok: false, statusCode: 410 });
      daemon2.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-1', prompt: 'dead-sub gate', requestId: 'req-4' })));
      await flush();
      const failed = pushEventsOf(daemon2, 'push_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toEqual({ appSessionId: 'app-1', reason: 'gate', statusCode: 410 });
      expect(daemon2.pushSubscriptions.count()).toBe(0);
    } finally {
      await daemon2.stop();
    }

    // 6) Endpoint privacy: NO event payload anywhere in the log carries the
    //    subscription endpoint (or its host). push_sent/push_failed are clean.
    const rawDatabase = new Database(dbPath, { readonly: true });
    try {
      const rows = rawDatabase.prepare('SELECT payload FROM events').all() as Array<{ payload: string }>;
      const allPayloads = rows.map((row) => row.payload).join('\n');
      expect(allPayloads).not.toContain('push.example.com');
      expect(allPayloads).not.toContain('ep-1');
      expect(allPayloads).not.toContain('p256dh-key');
      expect(allPayloads).not.toContain('auth-key');
    } finally {
      rawDatabase.close();
    }
  });

  it('sends a blocking gate at HIGH urgency but a routine completion at NORMAL (D29), both with a bounded TTL', async () => {
    const sender = new FakePushSender();
    const daemon = await startDaemon(nextDatabasePath(), sender);
    try {
      daemon.pushSubscriptions.save(SUBSCRIPTION);
      daemon.router.emit([
        sessionCreated({ appSessionId: 'app-u', channel: 'sdk', cwd: '/x', name: 'urgency probe', forkedFrom: null, taskRef: null }),
      ]);
      daemon.pushPipeline.watch('app-u');

      // A gate blocks on the human → HIGH (wakes the radio).
      daemon.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-u', prompt: 'approve?', requestId: 'req-g' })));
      await flush();
      expect(sender.sends).toHaveLength(1);
      expect(sender.sends[0]!.options?.urgency).toBe('high');
      expect(sender.sends[0]!.options?.ttlSeconds).toBe(DEFAULT_PUSH_TTL_SECONDS);

      // Ack it, then a run COMPLETED → informational ("merely true") → NORMAL.
      daemon.router.emit([seen({ appSessionId: 'app-u' })]);
      daemon.router.emit(withNotificationTrigger(runCompleted({ appSessionId: 'app-u' })));
      await flush();
      expect(sender.sends).toHaveLength(2);
      expect(sender.sends[1]!.options?.urgency).toBe('normal');
      expect(sender.sends[1]!.options?.ttlSeconds).toBe(DEFAULT_PUSH_TTL_SECONDS);
    } finally {
      await daemon.stop();
    }
  });

  it('does not push for a session with no subscriptions', async () => {
    const sender = new FakePushSender();
    const daemon = await startDaemon(nextDatabasePath(), sender);
    try {
      daemon.router.emit([
        sessionCreated({ appSessionId: 'app-lonely', channel: 'sdk', cwd: '/x', name: null, forkedFrom: null, taskRef: null }),
      ]);
      daemon.pushPipeline.watch('app-lonely');
      daemon.router.emit(withNotificationTrigger(gateFired({ appSessionId: 'app-lonely', prompt: 'anyone?', requestId: 'req-x' })));
      await flush();
      expect(sender.sends).toHaveLength(0);
      expect(pushEventsOf(daemon, 'push_sent')).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });
});

// ─── WS push subscription ops (protocol v0.3) ────────────────────────────────
class WsTestClient {
  readonly socket: WebSocket;
  readonly messages: Array<{ op: string; [key: string]: unknown }> = [];
  closeCode: number | undefined;

  constructor(port: number, token: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'cf-access-jwt-assertion': token } });
    this.socket.on('message', (rawData: RawData) => {
      this.messages.push(JSON.parse(rawData.toString()) as { op: string });
    });
    this.socket.on('close', (code: number) => {
      this.closeCode = code;
    });
  }

  opened(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket.once('open', () => resolvePromise());
      this.socket.once('error', rejectPromise);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

describe('WS push_subscribe / push_unsubscribe (protocol v0.3)', () => {
  it('persists a valid subscription, refuses a malformed one (socket survives), and unsubscribes', async () => {
    const daemon = await startDaemon(nextDatabasePath(), new FakePushSender());
    const client = new WsTestClient(daemon.port, ANY_TOKEN);
    try {
      await client.opened();

      // Valid subscription → persisted, no refusal.
      client.send({ op: 'push_subscribe', subscription: SUBSCRIPTION });
      await delay(30);
      expect(daemon.pushSubscriptions.count()).toBe(1);

      // Malformed subscription (endpoint is not a URL) → refused; socket stays open.
      client.send({ op: 'push_subscribe', subscription: { endpoint: 'not-a-url', keys: { p256dh: 'k', auth: 'a' } } });
      await delay(30);
      const refusal = client.messages.find((message) => message.op === 'refused');
      expect(refusal).toMatchObject({ refusedOp: 'push_subscribe', reason: 'invalid-subscription' });
      expect(daemon.pushSubscriptions.count()).toBe(1);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);

      // A structurally-invalid envelope (subscription missing keys) → error frame,
      // socket still open (hostile-input posture).
      client.send({ op: 'push_subscribe', subscription: { endpoint: 'https://push.example.com/x' } });
      await delay(30);
      expect(client.messages.some((message) => message.op === 'error')).toBe(true);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);

      // Unsubscribe by endpoint → removed.
      client.send({ op: 'push_unsubscribe', endpoint: SUBSCRIPTION.endpoint });
      await delay(30);
      expect(daemon.pushSubscriptions.count()).toBe(0);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});
