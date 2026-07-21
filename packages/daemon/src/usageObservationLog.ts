import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UsageFailureReason } from './usageEndpoint.js';

// ─── The usage OBSERVATION LOG (slice 5 step 4b, deliverable 3) ──────────────
//
// Rule 0.6 drift detection for the one fragile adapter that matters.
//
// WHY IT EXISTS. Classified poll failures deliberately emit NOTHING into the
// event log — correct for product state (a failed poll must never become a
// meter), but it also makes them INVISIBLE. Per spike U1 the *normal* daily
// failure is a 401 at the ~6h OAuth token roll, and we have never actually
// observed one in the wild. Equally, a shape change in Anthropic's response
// would surface only as a meter quietly vanishing from the strip. This log is
// the evidence trail for both.
//
// WHY IT IS NOT AN EVENT. It is diagnostic evidence about an EXTERNAL SURFACE,
// not product state. It never enters the event spine and no projection reads it,
// so it can be deleted, rotated or ignored with zero effect on what VIMES
// believes. Putting it in the log would make Anthropic's HTTP statuses part of
// our replayable history, which they are not.
//
// ─── THE TOKEN RULE (checked on every write path) ────────────────────────────
// The OAuth access token is NEVER written here — not truncated, not hashed, not
// in an error path. Two independent guarantees, because one is not enough:
//   1. STRUCTURAL: this module is never given the token. `record()` receives an
//      outcome, an HTTP status and the RESPONSE BODY. Request headers (the only
//      place the bearer lives) are not a parameter of any function here.
//   2. DEFENSIVE: every captured body passes through `redactBody`, which blanks
//      identity-shaped keys AND any token-shaped string value wherever it
//      appears — including inside a server error message that echoed it back.

export const USAGE_OBSERVATION_LOG_FILENAME = 'usage-observations.jsonl';

// Bounds. PLAIN CONSTANTS, not ⟨tune⟩ bands (rule 0.2): they shape only this
// file's disk footprint, never a behavioral verdict. Nothing reads the log to
// decide anything, so no value here can be "wrong" in a way a calibration would
// fix — it can only be bigger or smaller. They exist so an append-only file
// cannot grow without limit on a long-lived daemon.
export const USAGE_OBSERVATION_LOG_MAX_LINES = 2_000;
export const USAGE_OBSERVATION_LOG_MAX_BYTES = 2 * 1024 * 1024;

export type UsageObservationOutcome = 'ok' | UsageFailureReason;

export interface UsageObservation {
  outcome: UsageObservationOutcome;
  // The HTTP status when a response actually arrived; null for no-credentials
  // and network-error, where there was none. Null is UNKNOWN, never 0.
  httpStatus: number | null;
  // The raw response body when one arrived, else null. NEVER a request header.
  body: string | null;
  // How many limits the adapter managed to parse out of the body.
  limitsParsed: number;
}

// One line of the log, as written.
export interface UsageObservationLine {
  at: string;
  outcome: UsageObservationOutcome;
  httpStatus: number | null;
  limitsParsed: number;
  // A stable hash over the response's KEY STRUCTURE (see fingerprintBody), or
  // null when there was no parseable body to fingerprint.
  fingerprint: string | null;
  // The redacted body — present ONLY on the first line that carries a
  // previously-unseen fingerprint. Ordinary percentage movement does not change
  // the fingerprint, so this stays rare by construction.
  body?: unknown;
}

// ─── the fingerprint ─────────────────────────────────────────────────────────
//
// A hash over the SORTED SET OF KEY PATHS, never over values. `session` moving
// from 29% to 60% must not churn the fingerprint — only a genuinely new or
// vanished key should. Arrays collapse to a single `[]` segment and their
// elements' paths are unioned, so a response with three `limits[]` entries
// fingerprints identically to one with four unless the entries' own shape
// changed. That is exactly the drift we want to be told about.
function collectKeyPaths(value: unknown, prefix: string, into: Set<string>): void {
  if (Array.isArray(value)) {
    const arrayPath = `${prefix}[]`;
    into.add(arrayPath);
    for (const element of value) {
      collectKeyPaths(element, arrayPath, into);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = prefix === '' ? key : `${prefix}.${key}`;
      into.add(keyPath);
      collectKeyPaths(nested, keyPath, into);
    }
    return;
  }
  // Scalars contribute nothing: their VALUE is not part of the shape.
}

/**
 * Fingerprint the key structure of a JSON body, or null when it does not parse
 * (an unparseable body has no structure to compare — UNKNOWN, not "empty
 * shape", which would collide with every other unparseable response).
 */
export function fingerprintBody(body: string | null): string | null {
  if (body === null || body.length === 0) {
    return null;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return null;
  }
  const keyPaths = new Set<string>();
  collectKeyPaths(parsedBody, '', keyPaths);
  const canonicalPaths = [...keyPaths].sort().join('\n');
  return createHash('sha256').update(canonicalPaths).digest('hex').slice(0, 16);
}

// ─── redaction ───────────────────────────────────────────────────────────────
//
// Matches how `fixtures/usage/otlp-metrics-2026-07-21.json` was redacted for the
// U2 spike: KEYS are preserved (they are the contract we are watching for
// drift), identity VALUES are replaced with the literal `<redacted>`.
export const REDACTED_PLACEHOLDER = '<redacted>';

// Key names whose string values are identity or secret material. Matched
// case-insensitively on the LAST path segment, substring-style, so
// `user.account_uuid`, `accountId` and `organization_id` all match without
// enumerating every casing Anthropic might ship (rule 0.6: the surface drifts).
const IDENTITY_KEY_FRAGMENTS: readonly string[] = [
  'email',
  'token',
  'secret',
  'password',
  'authorization',
  'bearer',
  'credential',
  'apikey',
  'api_key',
  'account_uuid',
  'account_id',
  'accountid',
  'accountuuid',
  'organization_id',
  'organizationid',
  'organization_uuid',
  'user_id',
  'userid',
  'uuid',
  'session_id',
  'sessionid',
];

function keyLooksLikeIdentity(key: string): boolean {
  const loweredKey = key.toLowerCase();
  return IDENTITY_KEY_FRAGMENTS.some((fragment) => loweredKey.includes(fragment));
}

// Token-SHAPED values, blanked wherever they appear regardless of key. This is
// the second belt: an upstream error body that echoes the bearer back
// ("invalid token sk-ant-oat01-…") must not land in the file just because the
// key was called `message`. The patterns cover the observed OAuth/API token
// prefixes plus a bare `Bearer <something>`.
const TOKEN_SHAPED_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9._~+/-]+=*/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

function redactTokenShapedText(text: string): string {
  let redactedText = text;
  for (const pattern of TOKEN_SHAPED_PATTERNS) {
    redactedText = redactedText.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return redactedText;
}

function redactValue(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    return keyLooksLikeIdentity(key) ? REDACTED_PLACEHOLDER : redactTokenShapedText(value);
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactValue(element, key));
  }
  if (typeof value === 'object' && value !== null) {
    const redactedObject: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      redactedObject[nestedKey] = redactValue(nestedValue, nestedKey);
    }
    return redactedObject;
  }
  return value;
}

/**
 * Redact a raw body for storage. Returns the parsed-and-redacted JSON value, or
 * — when the body does not parse — the raw text with token-shaped runs blanked
 * (an unparseable body is exactly the drift evidence worth keeping, so it is
 * kept as text rather than dropped).
 */
export function redactBody(body: string): unknown {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return redactTokenShapedText(body);
  }
  return redactValue(parsedBody, '');
}

// ─── the log itself ──────────────────────────────────────────────────────────

export interface UsageObservationLogDeps {
  // INJECTABLE so no test ever writes to the real data dir.
  path: string;
}

export function defaultUsageObservationLogPath(dataDir: string): string {
  return join(dataDir, USAGE_OBSERVATION_LOG_FILENAME);
}

export class UsageObservationLog {
  private readonly path: string;
  // Fingerprints whose full body has already been captured. Seeded lazily from
  // the file on first use so a restart does not re-capture every known shape.
  //
  // NOTE ON THE BOUND: rotation can drop a body-carrying line, after which a
  // later boot re-seeds without that fingerprint and captures the body once
  // more. That degrades toward MORE evidence, never less — the safe direction
  // for a diagnostic file, and the reason the bound is allowed to be dumb.
  private readonly capturedFingerprints = new Set<string>();
  private seeded = false;

  constructor(deps: UsageObservationLogDeps) {
    this.path = deps.path;
  }

  logPath(): string {
    return this.path;
  }

  /**
   * Append ONE line for ONE poll attempt — success or classified failure alike.
   * Never throws: a diagnostic file that cannot be written must not take the
   * poll (or the daemon) down with it.
   */
  record(nowIso: string, observation: UsageObservation): void {
    try {
      this.seedFromFile();
      const fingerprint = fingerprintBody(observation.body);
      const line: UsageObservationLine = {
        at: nowIso,
        outcome: observation.outcome,
        httpStatus: observation.httpStatus,
        limitsParsed: observation.limitsParsed,
        fingerprint,
      };
      // First sighting of a shape → keep the whole (redacted) body as evidence.
      // Every later poll with the same shape costs one short line.
      if (fingerprint !== null && !this.capturedFingerprints.has(fingerprint)) {
        this.capturedFingerprints.add(fingerprint);
        line.body = redactBody(observation.body ?? '');
      }
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf8');
      this.enforceBounds();
    } catch {
      // Deliberately swallowed — see the doc comment.
    }
  }

  // Read every line currently in the file (diagnostics + tests). Malformed lines
  // are skipped rather than thrown on.
  readLines(): UsageObservationLine[] {
    if (!existsSync(this.path)) {
      return [];
    }
    const lines: UsageObservationLine[] = [];
    for (const rawLine of readFileSync(this.path, 'utf8').split('\n')) {
      if (rawLine.trim().length === 0) {
        continue;
      }
      try {
        lines.push(JSON.parse(rawLine) as UsageObservationLine);
      } catch {
        continue;
      }
    }
    return lines;
  }

  private seedFromFile(): void {
    if (this.seeded) {
      return;
    }
    this.seeded = true;
    for (const line of this.readLines()) {
      if (typeof line.fingerprint === 'string' && line.body !== undefined) {
        this.capturedFingerprints.add(line.fingerprint);
      }
    }
  }

  // Drop the OLDEST lines until both bounds hold. Oldest-first because the
  // interesting question is always "what is the surface doing lately".
  private enforceBounds(): void {
    const fileContents = readFileSync(this.path, 'utf8');
    const rawLines = fileContents.split('\n').filter((line) => line.length > 0);
    if (rawLines.length <= USAGE_OBSERVATION_LOG_MAX_LINES && Buffer.byteLength(fileContents, 'utf8') <= USAGE_OBSERVATION_LOG_MAX_BYTES) {
      return;
    }
    let keptLines = rawLines;
    if (keptLines.length > USAGE_OBSERVATION_LOG_MAX_LINES) {
      keptLines = keptLines.slice(keptLines.length - USAGE_OBSERVATION_LOG_MAX_LINES);
    }
    while (
      keptLines.length > 1 &&
      Buffer.byteLength(`${keptLines.join('\n')}\n`, 'utf8') > USAGE_OBSERVATION_LOG_MAX_BYTES
    ) {
      keptLines = keptLines.slice(1);
    }
    writeFileSync(this.path, `${keptLines.join('\n')}\n`, 'utf8');
  }
}
