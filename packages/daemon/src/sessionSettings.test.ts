import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_SECRET_ENV_VAR,
  buildSessionSettings,
  envWithHookSecret,
  hookRelayCommand,
  mintHookChannel,
  mintSpawnSecret,
  removeSessionSettings,
  secretMatchesDigest,
  sha256,
  sessionSettingsPath,
  writeSessionSettings,
} from './sessionSettings.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-settings-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

// Read the relay command back out of a written settings file — the shape the
// Claude CLI actually consumes, rather than the builder's return value.
function relayCommandOf(settingsPath: string): string {
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return parsed.hooks.SessionStart![0]!.hooks[0]!.command;
}

describe('buildSessionSettings (C)', () => {
  it('registers all five hooks, each with the relay command; PreToolUse carries the all-tools matcher', () => {
    const settings = buildSessionSettings({ appSessionId: 'app-1', hookPort: 4601 });
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'].sort(),
    );
    const expectedCommand = hookRelayCommand({ appSessionId: 'app-1', hookPort: 4601 });
    for (const [name, entries] of Object.entries(settings.hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.hooks).toEqual([{ type: 'command', command: expectedCommand }]);
      if (name === 'PreToolUse') {
        expect(entries[0]!.matcher).toBe('*');
      } else {
        expect(entries[0]!.matcher).toBeUndefined();
      }
    }
  });

  it('the relay command posts the hook stdin to the local ingress with the bearer secret', () => {
    const command = hookRelayCommand({ appSessionId: 'app-xyz', hookPort: 4601 });
    expect(command).toContain('http://127.0.0.1:4601/hooks/app-xyz');
    expect(command).toContain(`Authorization: Bearer $${HOOK_SECRET_ENV_VAR}`);
    expect(command).toContain('--data-binary @-');
    expect(command.startsWith('curl -fsS -X POST')).toBe(true);
  });

  // THE POINT OF THE ENV CARRIER: nothing that lands in argv may contain the
  // bearer value. A command line is world-readable via /proc/<pid>/cmdline for
  // as long as the hook runs; the environment is not.
  it('the relay command carries the variable NAME, never a secret VALUE', () => {
    const command = hookRelayCommand({ appSessionId: 'app-xyz', hookPort: 4601 });
    // The builder takes no secret at all, so feed a real minted one through the
    // whole channel and prove it is absent from the command it produced.
    const { settingsPath, env } = mintHookChannel({
      dataDir: temporaryDirectory,
      appSessionId: 'app-argv',
      hookPort: 4601,
    });
    const secret = env[HOOK_SECRET_ENV_VAR]!;
    expect(secret.length).toBeGreaterThan(0);

    const relay = relayCommandOf(settingsPath);
    expect(relay).toContain(`Authorization: Bearer $${HOOK_SECRET_ENV_VAR}`);
    expect(relay).not.toContain(secret);
    expect(command).not.toContain(secret);
    // ...and not anywhere else in the settings file either.
    expect(readFileSync(settingsPath, 'utf8')).not.toContain(secret);
    removeSessionSettings(settingsPath);
  });

  // Quoting is load-bearing: single quotes would post the LITERAL string
  // "$VIMES_HOOK_SECRET" and every hook for that session would fail auth.
  it('the bearer header is double-quoted so the hook shell expands the variable', () => {
    const command = hookRelayCommand({ appSessionId: 'app-q', hookPort: 4601 });
    expect(command).toContain(`-H "Authorization: Bearer $${HOOK_SECRET_ENV_VAR}"`);
    expect(command).not.toContain("'Authorization: Bearer");

    // Feed the header EXACTLY as emitted to a POSIX shell and prove the shell
    // produces the secret's value, not the literal `$VIMES_HOOK_SECRET`. Single
    // quoting the header in the builder reddens this.
    const emittedHeader = /-H (".*?")/.exec(command)![1]!;
    const expanded = execFileSync('/bin/sh', ['-c', `printf %s ${emittedHeader}`], {
      env: { PATH: '/usr/bin:/bin', [HOOK_SECRET_ENV_VAR]: 'expanded-value' },
      encoding: 'utf8',
    });
    expect(expanded).toBe('Authorization: Bearer expanded-value');
  });
});

describe('mintHookChannel — the settings file and the secret env are one value', () => {
  it('writes the relay settings and returns the env + digest that make it authenticate', () => {
    const channel = mintHookChannel({
      dataDir: temporaryDirectory,
      appSessionId: 'app-channel',
      hookPort: 4601,
    });
    expect(channel.settingsPath).toBe(sessionSettingsPath(temporaryDirectory, 'app-channel'));

    // Exactly one variable, and it is the one the relay expands.
    expect(Object.keys(channel.env)).toEqual([HOOK_SECRET_ENV_VAR]);
    const secret = channel.env[HOOK_SECRET_ENV_VAR]!;

    // The digest the ingress registers is the digest OF the env's secret — if
    // these two ever drifted, every hook would fail auth.
    expect(secretMatchesDigest(secret, channel.digest)).toBe(true);
    expect(channel.digest).toEqual(sha256(secret));

    expect(relayCommandOf(channel.settingsPath)).toContain('/hooks/app-channel');
    removeSessionSettings(channel.settingsPath);
  });

  it('two channels never share a secret', () => {
    const first = mintHookChannel({ dataDir: temporaryDirectory, appSessionId: 'app-c1', hookPort: 4601 });
    const second = mintHookChannel({ dataDir: temporaryDirectory, appSessionId: 'app-c2', hookPort: 4601 });
    expect(first.env[HOOK_SECRET_ENV_VAR]).not.toBe(second.env[HOOK_SECRET_ENV_VAR]);
    removeSessionSettings(first.settingsPath);
    removeSessionSettings(second.settingsPath);
  });
});

describe('envWithHookSecret', () => {
  it('merges the secret on top of the base env, leaving the rest intact', () => {
    const channel = mintHookChannel({ dataDir: temporaryDirectory, appSessionId: 'app-env', hookPort: 4601 });
    const merged = envWithHookSecret({ PATH: '/usr/bin', HOME: '/home/wes' }, channel);
    expect(merged.PATH).toBe('/usr/bin');
    expect(merged.HOME).toBe('/home/wes');
    expect(merged[HOOK_SECRET_ENV_VAR]).toBe(channel.env[HOOK_SECRET_ENV_VAR]);
    removeSessionSettings(channel.settingsPath);
  });

  it('contributes nothing when there is no channel (no relays to authenticate)', () => {
    const merged = envWithHookSecret({ PATH: '/usr/bin' }, undefined);
    expect(merged).toEqual({ PATH: '/usr/bin' });
    expect(merged[HOOK_SECRET_ENV_VAR]).toBeUndefined();
  });

  it('does not mutate the base env it is given', () => {
    const channel = mintHookChannel({ dataDir: temporaryDirectory, appSessionId: 'app-pure', hookPort: 4601 });
    const base = { PATH: '/usr/bin' };
    envWithHookSecret(base, channel);
    expect(base).toEqual({ PATH: '/usr/bin' });
    removeSessionSettings(channel.settingsPath);
  });
});

describe('per-spawn secret (constant-time)', () => {
  it('a minted secret matches its own digest and rejects any other value', () => {
    const { secret, digest } = mintSpawnSecret();
    expect(digest).toEqual(sha256(secret));
    expect(secretMatchesDigest(secret, digest)).toBe(true);
    expect(secretMatchesDigest(`${secret}x`, digest)).toBe(false);
    expect(secretMatchesDigest('completely-different', digest)).toBe(false);
  });

  it('two mints are distinct', () => {
    expect(mintSpawnSecret().secret).not.toBe(mintSpawnSecret().secret);
  });
});

describe('settings file io (C)', () => {
  it('writes a mode-600 file and removes it', () => {
    const content = buildSessionSettings({ appSessionId: 'app-file', hookPort: 4601 });
    const path = writeSessionSettings(temporaryDirectory, 'app-file', content);
    expect(path).toBe(sessionSettingsPath(temporaryDirectory, 'app-file'));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof buildSessionSettings>;
    expect(Object.keys(parsed.hooks)).toContain('SessionStart');
    // Mode 600 — the file holds the bearer secret.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    removeSessionSettings(path);
    expect(() => readFileSync(path, 'utf8')).toThrow();
    // Removing an already-gone file is a no-op (best effort).
    expect(() => removeSessionSettings(path)).not.toThrow();
  });
});
