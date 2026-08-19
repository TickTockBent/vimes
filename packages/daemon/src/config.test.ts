import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv } from './config.js';

// ─── D73's four version pins, as env parsing (S16·U1) ────────────────────────
//
// A narrow suite on purpose: the rest of `loadConfigFromEnv` is asserted where its
// values are consumed (taskDispatcher.test.ts for the isolation flag, and so on).
// What is pinned here is the half of D73 that lives in the ENVIRONMENT, including
// the deliberate REMOVAL — the old `VIMES_EXPECTED_CLI_VERSION` had different
// semantics, so a stale value left in `/etc/vimes/env` must read as "no floor
// pinned" and say so on the boot line, rather than silently becoming a floor
// nobody chose.

// Only VIMES_* keys reach the parser, so a minimal env is a complete one.
const MINIMAL_ENV: NodeJS.ProcessEnv = { VIMES_DB_PATH: '/tmp/vimes-config-test/events.db' };

describe('loadConfigFromEnv — the D73 version pins', () => {
  it('reads all four pins verbatim', () => {
    const config = loadConfigFromEnv({
      ...MINIMAL_ENV,
      VIMES_CLI_VERSION_FLOOR: '2.1.224',
      VIMES_CLI_VERSION_LAST_VERIFIED: '2.1.224',
      VIMES_SDK_CLI_VERSION_FLOOR: '2.1.207',
      VIMES_SDK_CLI_VERSION_LAST_VERIFIED: '2.1.207',
    });
    expect(config.cliVersionFloor).toBe('2.1.224');
    expect(config.cliVersionLastVerified).toBe('2.1.224');
    expect(config.sdkCliVersionFloor).toBe('2.1.207');
    expect(config.sdkCliVersionLastVerified).toBe('2.1.207');
  });

  it('all four default to UNSET — an unpinned channel is report-only, which is the shipped SDK posture', () => {
    const config = loadConfigFromEnv({ ...MINIMAL_ENV });
    expect(config.cliVersionFloor).toBeUndefined();
    expect(config.cliVersionLastVerified).toBeUndefined();
    expect(config.sdkCliVersionFloor).toBeUndefined();
    expect(config.sdkCliVersionLastVerified).toBeUndefined();
  });

  it('an EMPTY value is UNSET, not an empty floor', () => {
    // An env var present-but-empty is a var an operator cleared, not a version
    // they chose. `''` would parse as `unknown` at boot and warn forever.
    const config = loadConfigFromEnv({
      ...MINIMAL_ENV,
      VIMES_CLI_VERSION_FLOOR: '',
      VIMES_CLI_VERSION_LAST_VERIFIED: '',
      VIMES_SDK_CLI_VERSION_FLOOR: '',
      VIMES_SDK_CLI_VERSION_LAST_VERIFIED: '',
    });
    expect(config.cliVersionFloor).toBeUndefined();
    expect(config.cliVersionLastVerified).toBeUndefined();
    expect(config.sdkCliVersionFloor).toBeUndefined();
    expect(config.sdkCliVersionLastVerified).toBeUndefined();
  });

  it('does NOT validate the pin — a malformed value is carried through and answered honestly at boot', () => {
    // Refusing to start because someone typed `v2.1.224` would be a far worse
    // failure than a boot line that says the version is unparseable and that the
    // floor was NOT CHECKED. The parser has no opinion; versionCompare.ts does.
    const config = loadConfigFromEnv({ ...MINIMAL_ENV, VIMES_CLI_VERSION_FLOOR: 'v2.1.224' });
    expect(config.cliVersionFloor).toBe('v2.1.224');
  });

  it('THE REMOVED PIN IS REALLY REMOVED: a stale VIMES_EXPECTED_CLI_VERSION sets no floor', () => {
    // The whole reason the names changed with the semantics. A box still carrying
    // the old env var boots with NO floor — visible on the boot line as
    // `floor (unset)` — instead of inheriting an equality pin as a floor.
    const config = loadConfigFromEnv({
      ...MINIMAL_ENV,
      VIMES_EXPECTED_CLI_VERSION: '2.1.224',
      VIMES_EXPECTED_SDK_CLI_VERSION: '2.1.207',
    });
    expect(config.cliVersionFloor).toBeUndefined();
    expect(config.sdkCliVersionFloor).toBeUndefined();
    expect(config).not.toHaveProperty('expectedCliVersion');
    expect(config).not.toHaveProperty('expectedSdkCliVersion');
  });
});
