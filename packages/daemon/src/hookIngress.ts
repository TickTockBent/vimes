import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import {
  SYSTEM_STREAM,
  hookEventPayloadSchema,
  lineQuarantined,
  type EventInput,
  type EventRouter,
} from '@vimes/core';
import { AUTH_REJECTED_EVENT_TYPE } from './auth.js';

// ─── Hook ingress — a SEPARATE local listener (structural I14 posture) ────────
//
// Binds 127.0.0.1:hookPort ONLY. The cloudflared tunnel routes ONLY to the
// product port, so this ingress never traverses the tunnel — that is the
// designed exemption from the Access-JWT wall (slice-2 §Architecture). In its
// place: a per-spawn bearer secret (constant-time compare, host-owned) gates
// every POST. It serves ONLY `POST /hooks/:appSessionId`; everything else 404s.
//
// Rule 0.6: the hook body is a fragile external surface — validated LOOSE
// (passthrough) and never trusted for shape. Rule: NEVER log or event the secret
// or the payload body at info level; auth_rejected carries only {path, reason}.

// The maximum raw-body bytes copied into a quarantine event (forensics without
// unbounded growth from a hostile poster).
const MAX_QUARANTINE_RAW_BYTES = 4_096;

export type HookAuthResult = 'ok' | 'unknown-session' | 'missing-secret' | 'bad-secret';
export type HookIngestResult = { status: 'emitted' } | { status: 'unknown-event' };

// The narrow host surface the ingress needs — SessionHost implements it. Keeps
// domain logic (secret custody, correlation dedupe, hook vocabulary) in the host;
// the ingress is a thin authenticated transport.
export interface HookHost {
  verifyHookSecret(appSessionId: string, presentedSecret: string | undefined): HookAuthResult;
  ingestHook(appSessionId: string, body: Record<string, unknown>): HookIngestResult;
}

export interface HookIngressDeps {
  host: HookHost;
  router: EventRouter;
  hookPort: number;
  bindHost: string;
}

export interface HookIngress {
  readonly httpServer: Server;
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function bearerFromHeader(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match !== null ? match[1] : undefined;
}

function capRaw(raw: string): string {
  return raw.length > MAX_QUARANTINE_RAW_BYTES ? raw.slice(0, MAX_QUARANTINE_RAW_BYTES) : raw;
}

export function createHookIngress(deps: HookIngressDeps): HookIngress {
  const { host, router, hookPort, bindHost } = deps;

  const emitAuthRejected = (path: string, reason: string): void => {
    // Never the secret or body — path + classified reason only (I14 discipline).
    router.emit([
      { stream: SYSTEM_STREAM, type: AUTH_REJECTED_EVENT_TYPE, payload: { path, reason } },
    ]);
  };
  const emitQuarantine = (events: EventInput[]): void => {
    router.emit(events);
  };

  const app = new Hono();

  app.post('/hooks/:appSessionId', async (context) => {
    const appSessionId = context.req.param('appSessionId');
    const path = context.req.path;

    // 1) Auth FIRST — a bad or missing secret leaks zero bytes and no payload.
    const presented = bearerFromHeader(context.req.header('authorization'));
    const auth = host.verifyHookSecret(appSessionId, presented);
    if (auth !== 'ok') {
      emitAuthRejected(path, auth);
      return context.text('unauthorized', 401);
    }

    // 2) Parse — malformed JSON is quarantined, never a crash.
    const rawBody = await context.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      emitQuarantine([lineQuarantined({ appSessionId, raw: capRaw(rawBody), reason: 'hook-malformed' })]);
      return context.text('malformed', 400);
    }

    // 3) Loose validation (rule 0.6): stamp appSessionId from the URL, then a
    // passthrough schema tolerates any extra fields. A non-object body folds to
    // {} and falls through to the unknown-event path below.
    const bodyObject =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const validated = hookEventPayloadSchema.safeParse({ ...bodyObject, appSessionId });
    if (!validated.success) {
      emitQuarantine([lineQuarantined({ appSessionId, raw: capRaw(rawBody), reason: 'hook-invalid' })]);
      return context.text('invalid', 400);
    }

    // 4) Ingest — the host emits the hook event (+ correlation for SessionStart).
    // An unrecognized hook_event_name is quarantined but still accepted (the
    // relay is well-formed and authed; nothing to route on).
    const result = host.ingestHook(appSessionId, validated.data as Record<string, unknown>);
    if (result.status === 'unknown-event') {
      emitQuarantine([lineQuarantined({ appSessionId, raw: capRaw(rawBody), reason: 'hook-unknown-event' })]);
    }
    return context.text('ok', 200);
  });

  // Everything else — any other path or method — is 404. There is no product
  // surface here.
  app.all('*', (context) => context.text('not found', 404));

  const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;

  return {
    httpServer,
    get port(): number {
      const address = httpServer.address();
      return address !== null && typeof address === 'object' ? (address as AddressInfo).port : hookPort;
    },
    async start(): Promise<void> {
      await new Promise<void>((resolveStart, rejectStart) => {
        const onListenError = (error: Error): void => rejectStart(error);
        httpServer.once('error', onListenError);
        httpServer.listen(hookPort, bindHost, () => {
          httpServer.removeListener('error', onListenError);
          resolveStart();
        });
      });
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolveStop) => {
        httpServer.close(() => resolveStop());
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections();
        }
      });
    },
  };
}
