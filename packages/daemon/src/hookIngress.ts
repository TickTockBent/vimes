import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import {
  SYSTEM_STREAM,
  hookEventPayloadSchema,
  lineQuarantined,
  type CompactionGateDecision,
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
  // S8·4 (D64) — the two ANSWER paths. Both return the daemon's decision; the
  // host owns the policy, this module owns only the wire shape.
  //
  // `decideCompactionGateFor` answers a PreCompact: `'hold'` vetoes, `'allow'`
  // proceeds. `compactResumeContextFor` returns the paragraph to hand back to a
  // just-compacted ORCHESTRATOR session, or null for anything else.
  decideCompactionGateFor(appSessionId: string): CompactionGateDecision;
  compactResumeContextFor(appSessionId: string): string | null;
}

// The hook names this ingress ANSWERS rather than only records. Named here
// because the answer shapes below are this module's wire contract.
const PRE_COMPACT_HOOK_EVENT_NAME = 'PreCompact';
const SESSION_START_HOOK_EVENT_NAME = 'SessionStart';
// The CLI's own `SessionStart` source value for a post-compaction start —
// OBSERVED at SP8·1 (`hook_name: "SessionStart:compact"` in the SDK stream, and
// `source: "compact"` in the hook body). Rule 0.7: this literal is a fact we saw,
// not one we read in a doc.
const COMPACT_SESSION_START_SOURCE = 'compact';

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
    const validatedBody = validated.data as Record<string, unknown>;
    const result = host.ingestHook(appSessionId, validatedBody);
    if (result.status === 'unknown-event') {
      emitQuarantine([lineQuarantined({ appSessionId, raw: capRaw(rawBody), reason: 'hook-unknown-event' })]);
    }

    // 5) ANSWER (S8·4, D64). Recording comes FIRST, above, so the log carries the
    // hook fire whatever the answer turns out to be. Only two hooks are answered;
    // every other event keeps the byte-identical `ok` body it has always had.
    const hookEventName =
      typeof validatedBody.hook_event_name === 'string' ? validatedBody.hook_event_name : undefined;

    if (hookEventName === PRE_COMPACT_HOOK_EVENT_NAME) {
      // ⚠ THE BODY IS THE PROTOCOL, and it is a BARE WORD on purpose. The relay
      // that reads it is `[ "$RESPONSE" = "hold" ]` in a POSIX shell — no JSON
      // parser, no `jq` dependency — because a hook that cannot parse its own
      // answer fails in the direction that wedges compaction. See
      // sessionSettings.ts's `hookRelayCommand`.
      return context.text(host.decideCompactionGateFor(appSessionId), 200);
    }

    if (
      hookEventName === SESSION_START_HOOK_EVENT_NAME &&
      validatedBody.source === COMPACT_SESSION_START_SOURCE
    ) {
      const resumeContext = host.compactResumeContextFor(appSessionId);
      if (resumeContext !== null) {
        // FRAGILE-ADAPTER (rule 0.6): the envelope shape is Claude Code's, and it
        // is SCHEMA-CHECKED at the far end — SP8·1 OBSERVED the CLI rejecting a
        // malformed hook output with "Hook JSON output validation failed" and
        // proceeding as if the hook had said nothing. `SessionStart` IS among the
        // accepted `hookSpecificOutput` variants (unlike PreCompact, which is
        // not), which is the whole reason the post-compaction pointer rides this
        // hook rather than the one that fires at the boundary.
        return context.json({
          hookSpecificOutput: {
            hookEventName: SESSION_START_HOOK_EVENT_NAME,
            additionalContext: resumeContext,
          },
        });
      }
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
