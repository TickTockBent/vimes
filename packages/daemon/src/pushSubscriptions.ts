import Database from 'better-sqlite3';
import type { Clock } from '@vimes/core';
import type { PushSubscriptionRecord } from './pushService.js';

// ─── Push subscription cache (slice-2 step 3) ────────────────────────────────
//
// CACHE-CLASS, over the SAME sqlite db file as the event log — but NOT the event
// log: a subscription is overwritten (re-subscribe) or deleted (unsubscribe / dead
// endpoint 404-410), so there are no append-only triggers here and the `events`
// triggers are untouched. The subscription JSON (endpoint + keys) is transport
// material; it lives ONLY in this table, never in the event log.
const PUSH_SUBSCRIPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscriptionJson TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`;

interface PushSubscriptionRow {
  endpoint: string;
  subscriptionJson: string;
  createdAt: string;
}

export class PushSubscriptions {
  private readonly database: Database.Database;
  private readonly clock: Clock;
  private readonly upsertStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;
  private readonly allStatement: Database.Statement;

  constructor(options: { path: string; clock: Clock }) {
    this.clock = options.clock;
    this.database = new Database(options.path);
    if (options.path !== ':memory:') {
      this.database.pragma('journal_mode = WAL');
    }
    this.database.pragma('synchronous = NORMAL');
    // A third connection to the same file (event store + snapshot store own the
    // others); wait rather than fail on a brief write-lock contention.
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(PUSH_SUBSCRIPTIONS_SCHEMA);

    this.upsertStatement = this.database.prepare(
      `INSERT INTO push_subscriptions (endpoint, subscriptionJson, createdAt)
       VALUES (@endpoint, @subscriptionJson, @createdAt)
       ON CONFLICT(endpoint) DO UPDATE SET
         subscriptionJson = excluded.subscriptionJson`,
    );
    this.deleteStatement = this.database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    this.allStatement = this.database.prepare(
      'SELECT endpoint, subscriptionJson, createdAt FROM push_subscriptions ORDER BY createdAt ASC, endpoint ASC',
    );
  }

  // Overwrite-by-endpoint (a browser re-subscribing keeps one row per endpoint).
  save(subscription: PushSubscriptionRecord): void {
    this.upsertStatement.run({
      endpoint: subscription.endpoint,
      subscriptionJson: JSON.stringify(subscription),
      createdAt: this.clock.now(),
    });
  }

  remove(endpoint: string): void {
    this.deleteStatement.run(endpoint);
  }

  all(): PushSubscriptionRecord[] {
    const rows = this.allStatement.all() as PushSubscriptionRow[];
    const subscriptions: PushSubscriptionRecord[] = [];
    for (const row of rows) {
      try {
        subscriptions.push(JSON.parse(row.subscriptionJson) as PushSubscriptionRecord);
      } catch {
        // A corrupt row is skipped, never fatal (cache-class).
      }
    }
    return subscriptions;
  }

  count(): number {
    return this.all().length;
  }

  dispose(): void {
    this.database.close();
  }
}
