import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REDACTED_PLACEHOLDER,
  USAGE_OBSERVATION_LOG_MAX_LINES,
  UsageObservationLog,
  fingerprintBody,
  redactBody,
} from './usageObservationLog.js';

// ─── The usage observation log (slice 5 step 4b, deliverable 3) ─────────────
//
// No test here touches the real data dir: every log gets an injected path inside
// a temp directory.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-usage-obs-'));
let logFileCounter = 0;

function newLog(): UsageObservationLog {
  logFileCounter += 1;
  return new UsageObservationLog({ path: join(temporaryDirectory, `observations-${logFileCounter}.jsonl`) });
}

const OK_BODY = JSON.stringify({
  limits: [
    { kind: 'session', percent: 29, resets_at: '2026-07-21T15:19:59Z', is_active: false },
    { kind: 'weekly_all', percent: 52, resets_at: '2026-07-23T16:59:59Z', is_active: true },
  ],
  five_hour: { utilization: 29, limit_dollars: null },
  tangelo: null,
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('fingerprintBody', () => {
  it('is stable under VALUE movement — 29% → 60% is not drift', () => {
    const atTwentyNine = fingerprintBody(JSON.stringify({ limits: [{ kind: 'session', percent: 29 }] }));
    const atSixty = fingerprintBody(JSON.stringify({ limits: [{ kind: 'session', percent: 60 }] }));
    expect(atTwentyNine).toBe(atSixty);
    expect(atTwentyNine).not.toBeNull();
  });

  it('CHANGES when a key appears or vanishes — that is the drift we watch for', () => {
    const before = fingerprintBody(JSON.stringify({ limits: [{ kind: 'session', percent: 29 }] }));
    const after = fingerprintBody(
      JSON.stringify({ limits: [{ kind: 'session', percent: 29, brand_new_field: 1 }] }),
    );
    expect(after).not.toBe(before);
  });

  it('is stable when an array simply gains an element of the same shape', () => {
    const twoLimits = fingerprintBody(
      JSON.stringify({ limits: [{ kind: 'session' }, { kind: 'weekly_all' }] }),
    );
    const threeLimits = fingerprintBody(
      JSON.stringify({ limits: [{ kind: 'session' }, { kind: 'weekly_all' }, { kind: 'weekly_scoped' }] }),
    );
    expect(threeLimits).toBe(twoLimits);
  });

  it('is null (UNKNOWN) for an absent or unparseable body — never a shared empty shape', () => {
    expect(fingerprintBody(null)).toBeNull();
    expect(fingerprintBody('<html>gateway timeout</html>')).toBeNull();
  });
});

describe('redactBody', () => {
  it('blanks identity VALUES and keeps their keys, matching the U2 fixture convention', () => {
    const redacted = redactBody(
      JSON.stringify({ user: { email: 'wes@example.com', account_uuid: 'abc-123' }, percent: 42 }),
    ) as { user: { email: string; account_uuid: string }; percent: number };
    expect(redacted.user.email).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.user.account_uuid).toBe(REDACTED_PLACEHOLDER);
    // Keys survive — they ARE the contract we are watching for drift.
    expect(Object.keys(redacted.user)).toEqual(['email', 'account_uuid']);
    expect(redacted.percent).toBe(42);
  });

  it('blanks a token-SHAPED value wherever it appears, regardless of the key', () => {
    const redacted = redactBody(
      JSON.stringify({ error: { message: 'invalid token sk-ant-oat01-SECRET-VALUE' } }),
    ) as { error: { message: string } };
    expect(redacted.error.message).not.toContain('sk-ant-oat01');
    expect(redacted.error.message).toContain(REDACTED_PLACEHOLDER);
  });

  it('keeps an unparseable body as text (it IS the drift evidence) with tokens blanked', () => {
    const redacted = redactBody('Unauthorized: Bearer sk-ant-oat01-SECRET-VALUE rejected');
    expect(typeof redacted).toBe('string');
    expect(redacted as string).not.toContain('SECRET-VALUE');
  });
});

describe('UsageObservationLog', () => {
  it('writes ONE line per attempt, including every classified failure', () => {
    const log = newLog();
    log.record('2026-07-21T12:00:00.000Z', { outcome: 'ok', httpStatus: 200, body: OK_BODY, limitsParsed: 2 });
    log.record('2026-07-21T12:05:00.000Z', {
      outcome: 'unauthorized',
      httpStatus: 401,
      body: '{"error":"expired"}',
      limitsParsed: 0,
    });
    log.record('2026-07-21T12:10:00.000Z', {
      outcome: 'network-error',
      httpStatus: null,
      body: null,
      limitsParsed: 0,
    });
    log.record('2026-07-21T12:15:00.000Z', {
      outcome: 'no-credentials',
      httpStatus: null,
      body: null,
      limitsParsed: 0,
    });

    const lines = log.readLines();
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.outcome)).toEqual([
      'ok',
      'unauthorized',
      'network-error',
      'no-credentials',
    ]);
    expect(lines[0]!.httpStatus).toBe(200);
    expect(lines[0]!.limitsParsed).toBe(2);
    // No response, no status, no fingerprint — null is UNKNOWN, never 0.
    expect(lines[2]!.httpStatus).toBeNull();
    expect(lines[2]!.fingerprint).toBeNull();
  });

  it('stores the full body the FIRST time a fingerprint is seen, and not again', () => {
    const log = newLog();
    log.record('2026-07-21T12:00:00.000Z', { outcome: 'ok', httpStatus: 200, body: OK_BODY, limitsParsed: 2 });
    // Same shape, different numbers — ordinary movement, no new evidence.
    const movedBody = OK_BODY.replace('"percent":29', '"percent":61');
    log.record('2026-07-21T12:05:00.000Z', { outcome: 'ok', httpStatus: 200, body: movedBody, limitsParsed: 2 });
    // A genuinely new shape — evidence worth keeping.
    log.record('2026-07-21T12:10:00.000Z', {
      outcome: 'ok',
      httpStatus: 200,
      body: JSON.stringify({ limits: [{ kind: 'session', percent: 1, brand_new: true }] }),
      limitsParsed: 1,
    });

    const lines = log.readLines();
    expect(lines[0]!.body).toBeDefined();
    expect(lines[1]!.body).toBeUndefined();
    expect(lines[1]!.fingerprint).toBe(lines[0]!.fingerprint);
    expect(lines[2]!.body).toBeDefined();
    expect(lines[2]!.fingerprint).not.toBe(lines[0]!.fingerprint);
  });

  it('a fingerprint captured in a PREVIOUS process is not re-captured after a restart', () => {
    logFileCounter += 1;
    const logPath = join(temporaryDirectory, `observations-restart-${logFileCounter}.jsonl`);
    const firstLog = new UsageObservationLog({ path: logPath });
    firstLog.record('2026-07-21T12:00:00.000Z', {
      outcome: 'ok',
      httpStatus: 200,
      body: OK_BODY,
      limitsParsed: 2,
    });
    const secondLog = new UsageObservationLog({ path: logPath });
    secondLog.record('2026-07-21T12:05:00.000Z', {
      outcome: 'ok',
      httpStatus: 200,
      body: OK_BODY,
      limitsParsed: 2,
    });
    const lines = secondLog.readLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]!.body).toBeUndefined();
  });

  it('NEVER writes the OAuth token — grep the produced file for the token value', () => {
    const log = newLog();
    const oauthTokenValue = 'sk-ant-oat01-THIS-EXACT-TOKEN-MUST-NEVER-BE-WRITTEN';
    // Every hostile shape at once: the endpoint echoing the bearer back in an
    // error, in a nested field, and under an innocuous key name.
    log.record('2026-07-21T12:00:00.000Z', {
      outcome: 'unauthorized',
      httpStatus: 401,
      body: JSON.stringify({
        error: { type: 'authentication_error', message: `token ${oauthTokenValue} has expired` },
        request: { authorization: `Bearer ${oauthTokenValue}` },
        note: oauthTokenValue,
      }),
      limitsParsed: 0,
    });
    log.record('2026-07-21T12:01:00.000Z', {
      outcome: 'http-error',
      httpStatus: 502,
      body: `upstream rejected Bearer ${oauthTokenValue}`,
      limitsParsed: 0,
    });

    const fileContents = readFileSync(log.logPath(), 'utf8');
    expect(fileContents).not.toContain(oauthTokenValue);
    expect(fileContents).not.toContain('THIS-EXACT-TOKEN');
    // And not even a fragment of it: no truncation, no prefix.
    expect(fileContents).not.toContain('sk-ant-oat01');
  });

  it('is BOUNDED: it drops the oldest lines rather than growing forever', () => {
    const log = newLog();
    const totalWrites = USAGE_OBSERVATION_LOG_MAX_LINES + 25;
    for (let writeIndex = 0; writeIndex < totalWrites; writeIndex += 1) {
      log.record(`2026-07-21T12:00:${String(writeIndex % 60).padStart(2, '0')}.000Z`, {
        outcome: 'network-error',
        httpStatus: null,
        body: null,
        limitsParsed: 0,
      });
    }
    expect(log.readLines()).toHaveLength(USAGE_OBSERVATION_LOG_MAX_LINES);
  });

  it('a write failure is never fatal — an unwritable path is swallowed', () => {
    // A path whose PARENT is a regular file: mkdir/append both fail with
    // ENOTDIR. Entirely inside the temp dir, so nothing outside it is touched.
    const blockingFilePath = join(temporaryDirectory, 'not-a-directory');
    writeFileSync(blockingFilePath, 'this is a file, not a directory');
    const unwritableLog = new UsageObservationLog({
      path: join(blockingFilePath, 'observations.jsonl'),
    });
    expect(() =>
      unwritableLog.record('2026-07-21T12:00:00.000Z', {
        outcome: 'ok',
        httpStatus: 200,
        body: OK_BODY,
        limitsParsed: 2,
      }),
    ).not.toThrow();
  });
});
