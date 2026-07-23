import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MeterRecord } from '@vimes/core';

// ─── The usage endpoint adapter — the SOLE headroom authority (slice 5, U1/U3) ─
//
// `GET https://api.anthropic.com/api/oauth/usage` (the CLI's own
// `fetchUtilization`) is the ONLY account-wide usage source. Local sources
// (JSONL, OTel) see only the sessions VIMES hosts and are therefore
// account-BLIND (spike U3) — they supply attribution, never headroom.
//
// This is a fragile-adapter boundary (rule 0.6). Two rules shape every line:
//
//  1. **Never lie (pillar 4).** If the call fails — 401 because the ~6h OAuth
//     token expired (the NORMAL daily failure; the CLI owns refresh), a network
//     error, a non-JSON body — we emit NOTHING and return a classified failure.
//     No placeholder, no zero, no reuse of a previous body. The meters then age
//     out through their own `observedAt` and the pure derivations report
//     stale/unknown on their own.
//  2. **Never invent absolutes (D26).** The endpoint reports PERCENTAGES only.
//     Produced records carry `percent` + `unit: 'percent'` and deliberately
//     leave `used`/`limit` ABSENT — collapsing 29% into `used = 29, limit = 100`
//     would manufacture precision the source never gave us.
//
// The body's flat top-level buckets (`five_hour`, `seven_day`, and the internal
// codenamed nulls `tangelo` / `iguana_necktie` / `nimbus_quill` / …) are NEVER
// enumerated: we consume the already-normalized `limits[]` array only, so
// unknown keys are ignored BY CONSTRUCTION rather than by a maintained denylist.
//
// The OAuth token is read through an injectable seam and is NEVER logged,
// evented, echoed, or truncated anywhere — not in a warning, not in an event.

// ── injectable seams (mirrors search.ts's ripgrep seam) ──────────────────────
// CI injects fakes for both, so no test ever touches the network or the real
// credentials file.
export interface UsageHttpResponse {
  status: number;
  body: string;
}
export type UsageHttpFetch = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<UsageHttpResponse>;
// Resolves the OAuth access token, or null when none is available.
export type CredentialsReader = () => Promise<string | null>;

export const DEFAULT_USAGE_BASE_URL = 'https://api.anthropic.com';
export const USAGE_ENDPOINT_PATH = '/api/oauth/usage';
export const USAGE_METER_SOURCE = 'endpoint';

// Classified failures. Every one of them means "emit no samples".
export type UsageFailureReason =
  | 'no-credentials'
  | 'unauthorized'
  | 'http-error'
  | 'network-error'
  | 'unparseable';

export type UsageProbeResult =
  | { ok: true; meters: MeterRecord[] }
  | { ok: false; reason: UsageFailureReason; status: number | null };

// ── the kind mapping (U1's observed vocabulary) ──────────────────────────────
// An UNKNOWN kind is TOLERATED, never guessed: the entry is skipped. Guessing a
// mapping for a bucket Anthropic just invented is exactly how a meter starts
// lying (rule 0.6).
const METER_KIND_BY_ENDPOINT_KIND: Readonly<Record<string, MeterRecord['kind']>> = {
  session: 'rolling-window',
  weekly_all: 'weekly-cap',
  weekly_scoped: 'weekly-cap',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(container: Record<string, unknown>, key: string): string | undefined {
  const rawValue = container[key];
  return typeof rawValue === 'string' && rawValue.length > 0 ? rawValue : undefined;
}

// `scope.model.display_name` when present — e.g. the model a weekly cap is
// scoped to ("Fable"). Absent (not guessed, not defaulted) otherwise.
function readScopeDisplayName(limitEntry: Record<string, unknown>): string | undefined {
  const scopeObject = asRecord(limitEntry.scope);
  if (scopeObject === null) {
    return undefined;
  }
  const modelObject = asRecord(scopeObject.model);
  if (modelObject === null) {
    return undefined;
  }
  return readOptionalString(modelObject, 'display_name');
}

// Locate the `limits[]` array. The live endpoint returns the usage object
// directly; the captured golden fixture wraps it under `response` alongside a
// `_note`. Both are accepted, and neither shape is enumerated beyond `limits`.
function findLimitsArray(parsedBody: unknown): unknown[] | null {
  const topLevel = asRecord(parsedBody);
  if (topLevel === null) {
    return null;
  }
  if (Array.isArray(topLevel.limits)) {
    return topLevel.limits;
  }
  const wrappedResponse = asRecord(topLevel.response);
  if (wrappedResponse !== null && Array.isArray(wrappedResponse.limits)) {
    return wrappedResponse.limits;
  }
  return null;
}

// Stable, unique meter id per limit so no two sources can ever collide
// (principle 9): `endpoint:<kind>` plus the scope when the limit is scoped.
function buildMeterId(endpointKind: string, scopeDisplayName: string | undefined): string {
  return scopeDisplayName === undefined
    ? `${USAGE_METER_SOURCE}:${endpointKind}`
    : `${USAGE_METER_SOURCE}:${endpointKind}:${scopeDisplayName}`;
}

/**
 * Pure parser: usage-endpoint body → MeterRecord[]. `nowIso` is INJECTED (rule
 * 0.3) and becomes each record's `observedAt`.
 *
 * Never throws: a malformed body, an absent or unparsable `limits`, an unknown
 * `kind`, or a percent-less entry all degrade to "produce fewer records",
 * bottoming out at `[]`.
 */
export function parseUsageResponse(body: string, nowIso: string): MeterRecord[] {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return [];
  }
  const limitsArray = findLimitsArray(parsedBody);
  if (limitsArray === null) {
    return [];
  }

  const meters: MeterRecord[] = [];
  for (const limitEntryValue of limitsArray) {
    const limitEntry = asRecord(limitEntryValue);
    if (limitEntry === null) {
      continue;
    }
    const endpointKind = readOptionalString(limitEntry, 'kind');
    if (endpointKind === undefined) {
      continue;
    }
    const meterKind = METER_KIND_BY_ENDPOINT_KIND[endpointKind];
    if (meterKind === undefined) {
      // Unknown kind: tolerated and skipped, never guessed (rule 0.6).
      continue;
    }
    const percentValue = limitEntry.percent;
    if (typeof percentValue !== 'number' || !Number.isFinite(percentValue)) {
      // No percent means nothing truthful to say about this limit.
      continue;
    }
    const scopeDisplayName = readScopeDisplayName(limitEntry);
    const severityValue = readOptionalString(limitEntry, 'severity');
    const resetsAtValue = readOptionalString(limitEntry, 'resets_at');
    const isActiveValue = limitEntry.is_active;

    // D26: `used` and `limit` are NOT set here, and there is no code path in
    // this module that sets them. The endpoint supplies percentages only.
    const meterRecord: MeterRecord = {
      meterId: buildMeterId(endpointKind, scopeDisplayName),
      kind: meterKind,
      percent: percentValue,
      unit: 'percent',
      source: USAGE_METER_SOURCE,
      observedAt: nowIso,
    };
    if (scopeDisplayName !== undefined) {
      meterRecord.scope = scopeDisplayName;
    }
    if (severityValue !== undefined) {
      meterRecord.severity = severityValue;
    }
    if (resetsAtValue !== undefined) {
      meterRecord.resetsAt = resetsAtValue;
    }
    if (typeof isActiveValue === 'boolean') {
      meterRecord.isActive = isActiveValue;
    }
    meters.push(meterRecord);
  }
  return meters;
}

// ── the observation seam (slice 5 step 4b, rule 0.6) ─────────────────────────
//
// Classified failures emit NOTHING into the event log, which is correct for
// product state and terrible for visibility. This callback fires EXACTLY ONCE
// per probe, success or failure, so the daemon can keep a diagnostic record of
// what this fragile surface actually did.
//
// THE TOKEN NEVER REACHES IT. The observation carries the response body and
// status only; the request headers — the sole place the bearer exists — are not
// a field of this type and are never passed anywhere near it.
export interface UsageProbeObservation {
  outcome: 'ok' | UsageFailureReason;
  // Present only when a response actually arrived; null otherwise (UNKNOWN).
  httpStatus: number | null;
  // The RESPONSE body, verbatim, when one arrived; null otherwise.
  body: string | null;
  // How many MeterRecords the parser recovered from it.
  limitsParsed: number;
}
export type UsageProbeObserver = (observation: UsageProbeObservation) => void;

export interface UsageEndpointAdapterDeps {
  httpFetch: UsageHttpFetch;
  readCredentials: CredentialsReader;
  baseUrl?: string;
  // Single-line warning sink (no token, no body dump). Defaults to console.warn.
  warn?: (message: string) => void;
  // Called once per probe with the classified outcome. Absent → no observation
  // is recorded. A throw from it is swallowed: diagnostics never break a poll.
  observe?: UsageProbeObserver;
}

export interface UsageEndpointAdapter {
  probe(nowIso: string): Promise<UsageProbeResult>;
}

export function createUsageEndpointAdapter(deps: UsageEndpointAdapterDeps): UsageEndpointAdapter {
  const baseUrl = deps.baseUrl ?? DEFAULT_USAGE_BASE_URL;
  const requestUrl = `${baseUrl.replace(/\/+$/, '')}${USAGE_ENDPOINT_PATH}`;
  const warn =
    deps.warn ??
    ((message: string): void => {
      // The default sink is stderr on purpose: daemon diagnostics belong in the
      // journal (vimes.service), not in the event log — a poll warning is not a
      // fact about a session. Anything that needs them elsewhere injects `warn`,
      // which is also how tests capture them without touching stderr.
      console.warn(message);
    });

  // Fires the observation seam without ever letting it affect the probe.
  const observe = (observation: UsageProbeObservation): void => {
    if (deps.observe === undefined) {
      return;
    }
    try {
      deps.observe(observation);
    } catch {
      // A diagnostic sink that throws must not fail a poll.
    }
  };

  return {
    async probe(nowIso: string): Promise<UsageProbeResult> {
      let accessToken: string | null;
      try {
        accessToken = await deps.readCredentials();
      } catch {
        accessToken = null;
      }
      if (accessToken === null || accessToken === '') {
        // No token at all — not an error worth shouting about every tick.
        warn('vimes-daemon: usage endpoint skipped — no OAuth credentials available');
        observe({ outcome: 'no-credentials', httpStatus: null, body: null, limitsParsed: 0 });
        return { ok: false, reason: 'no-credentials', status: null };
      }

      let httpResponse: UsageHttpResponse;
      try {
        httpResponse = await deps.httpFetch(requestUrl, {
          // The token is used here and NOWHERE else. It is never logged.
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        });
      } catch {
        warn('vimes-daemon: usage endpoint unreachable — meters will age out to stale');
        observe({ outcome: 'network-error', httpStatus: null, body: null, limitsParsed: 0 });
        return { ok: false, reason: 'network-error', status: null };
      }

      if (httpResponse.status === 401 || httpResponse.status === 403) {
        // The EXPECTED daily failure: the OAuth token lives ~6h and the CLI owns
        // refresh. Emit nothing; the meters degrade to stale on their own.
        warn(
          `vimes-daemon: usage endpoint rejected the token (status ${httpResponse.status}) — meters will age out to stale`,
        );
        observe({
          outcome: 'unauthorized',
          httpStatus: httpResponse.status,
          body: httpResponse.body,
          limitsParsed: 0,
        });
        return { ok: false, reason: 'unauthorized', status: httpResponse.status };
      }
      if (httpResponse.status < 200 || httpResponse.status >= 300) {
        warn(`vimes-daemon: usage endpoint returned status ${httpResponse.status} — no samples emitted`);
        observe({
          outcome: 'http-error',
          httpStatus: httpResponse.status,
          body: httpResponse.body,
          limitsParsed: 0,
        });
        return { ok: false, reason: 'http-error', status: httpResponse.status };
      }

      const meters = parseUsageResponse(httpResponse.body, nowIso);
      if (meters.length === 0) {
        // A 200 we cannot understand is a shape drift — it must fail LOUDLY as a
        // classified failure rather than quietly emitting zero samples as success.
        warn('vimes-daemon: usage endpoint returned no recognizable limits — no samples emitted');
        observe({
          outcome: 'unparseable',
          httpStatus: httpResponse.status,
          body: httpResponse.body,
          limitsParsed: 0,
        });
        return { ok: false, reason: 'unparseable', status: httpResponse.status };
      }
      observe({
        outcome: 'ok',
        httpStatus: httpResponse.status,
        body: httpResponse.body,
        limitsParsed: meters.length,
      });
      return { ok: true, meters };
    },
  };
}

// ── the real (production) seams — never exercised by tests ───────────────────

export const defaultUsageHttpFetch: UsageHttpFetch = async (url, headers) => {
  const response = await fetch(url, { method: 'GET', headers: { ...headers } });
  return { status: response.status, body: await response.text() };
};

export function defaultCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

// Reads `claudeAiOauth.accessToken` from the CLI's own credentials file (mode
// 600). Any failure resolves to null — the adapter then degrades honestly. The
// token is returned to the caller and never touches a log line.
export function createCredentialsReader(credentialsPath = defaultCredentialsPath()): CredentialsReader {
  return async (): Promise<string | null> => {
    try {
      const fileContents = await readFile(credentialsPath, 'utf8');
      const parsedCredentials = asRecord(JSON.parse(fileContents));
      const oauthSection = parsedCredentials === null ? null : asRecord(parsedCredentials.claudeAiOauth);
      if (oauthSection === null) {
        return null;
      }
      const accessToken = oauthSection.accessToken;
      return typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : null;
    } catch {
      return null;
    }
  };
}
