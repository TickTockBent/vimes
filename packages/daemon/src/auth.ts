import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';

// The I14 choke point (spec §3.11, tech-stack §8). One verifier runs in front of
// EVERY HTTP route (including static) and in the WS upgrade handler. It never
// logs or events token contents or header values — only the classified reason.

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const AUTH_REJECTED_EVENT_TYPE = 'auth_rejected';

export type VerifyResult = { ok: true; email?: string } | { ok: false; reason: string };

export interface AccessVerifier {
  verify(token: string | undefined): Promise<VerifyResult>;
}

export interface AuthRejectedInfo {
  path: string;
  reason: string;
}

export type EmitAuthRejected = (info: AuthRejectedInfo) => void;

// jose surfaces a stable `.code` on its error classes; classify by code (robust
// across jose minor versions) into the fixed reason vocabulary. A token signed
// by a key absent from the JWKS (wrong-key) surfaces as no-matching-key, which
// is — from the verifier's seat — an unverifiable signature.
function classifyJoseFailure(thrown: unknown): string {
  const errorCode = (thrown as { code?: string } | null)?.code;
  const failedClaim = (thrown as { claim?: string } | null)?.claim;
  switch (errorCode) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return failedClaim === 'aud' ? 'wrong-aud' : 'malformed';
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'invalid-signature';
    default:
      return 'malformed';
  }
}

// jwtVerify's key-resolver slot: a JWKS getter (remote or local), a raw key, or
// a secret. Both createRemoteJWKSet and createLocalJWKSet return values assignable
// here, so the CI-minted local JWKS exercises the very same verify path as prod.
type KeyResolver = Parameters<typeof jwtVerify>[1];

function createVerifierOverJwks(jwks: KeyResolver, aud: string): AccessVerifier {
  return {
    async verify(token: string | undefined): Promise<VerifyResult> {
      if (token === undefined || token === '') {
        return { ok: false, reason: 'missing-token' };
      }
      try {
        const { payload } = await jwtVerify(token, jwks, { audience: aud });
        const email = typeof payload.email === 'string' ? payload.email : undefined;
        return email === undefined ? { ok: true } : { ok: true, email };
      } catch (thrown) {
        return { ok: false, reason: classifyJoseFailure(thrown) };
      }
    },
  };
}

export function createCloudflareAccessVerifier(options: { teamDomain: string; aud: string }): AccessVerifier {
  const jwksUrl = new URL(`https://${options.teamDomain}/cdn-cgi/access/certs`);
  return createVerifierOverJwks(createRemoteJWKSet(jwksUrl), options.aud);
}

// Test seam: the exact prod verify/classify logic over a locally-minted JWKS,
// no network. Referenced by the I14 CI matrix.
export function createLocalAccessVerifier(options: {
  jwks: Parameters<typeof createLocalJWKSet>[0];
  aud: string;
}): AccessVerifier {
  return createVerifierOverJwks(createLocalJWKSet(options.jwks), options.aud);
}

// FAIL-CLOSED: used whenever team domain or aud is unset. The daemon must be safe
// to run behind the already-live public tunnel BEFORE Cloudflare Access exists —
// so with no configured verifier, everything is rejected, distinctly (503).
export function createUnconfiguredVerifier(): AccessVerifier {
  return {
    async verify(): Promise<VerifyResult> {
      return { ok: false, reason: 'auth-not-configured' };
    },
  };
}

export function createAccessAuthMiddleware(deps: {
  verifier: AccessVerifier;
  emitAuthRejected: EmitAuthRejected;
}): MiddlewareHandler {
  return async (context, next) => {
    const token = context.req.header(ACCESS_JWT_HEADER);
    const result = await deps.verifier.verify(token);
    if (result.ok) {
      await next();
      return;
    }
    // Zero product bytes on rejection: a bare plain-text status line only.
    deps.emitAuthRejected({ path: context.req.path, reason: result.reason });
    if (result.reason === 'auth-not-configured') {
      return context.text('auth not configured', 503);
    }
    return context.text('unauthorized', 401);
  };
}

// ——— WS upgrade helpers (raw socket, pre-handshake) ———

export function readAccessTokenFromRequest(request: IncomingMessage): string | undefined {
  const headerValue = request.headers[ACCESS_JWT_HEADER];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

// A minimal raw 401/503 with zero body, then the socket is destroyed — the WS
// handshake never completes, so no product bytes cross the wire.
export function writeUpgradeAuthFailure(socket: Duplex, reason: string): void {
  const statusLine = reason === 'auth-not-configured' ? '503 Service Unavailable' : '401 Unauthorized';
  // end() flushes the status line before the FIN, so the WS client reads a proper
  // HTTP response (and reports the status) rather than a bare socket error.
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
