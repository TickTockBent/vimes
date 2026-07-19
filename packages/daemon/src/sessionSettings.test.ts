import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSessionSettings,
  hookRelayCommand,
  mintSpawnSecret,
  removeSessionSettings,
  secretMatchesDigest,
  sha256,
  sessionSettingsPath,
  writeSessionSettings,
} from './sessionSettings.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-settings-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('buildSessionSettings (C)', () => {
  it('registers all five hooks, each with the relay command; PreToolUse carries the all-tools matcher', () => {
    const settings = buildSessionSettings({ appSessionId: 'app-1', hookPort: 4601, secret: 'sekret' });
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'].sort(),
    );
    const expectedCommand = hookRelayCommand({ appSessionId: 'app-1', hookPort: 4601, secret: 'sekret' });
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
    const command = hookRelayCommand({ appSessionId: 'app-xyz', hookPort: 4601, secret: 'the-secret' });
    expect(command).toContain('http://127.0.0.1:4601/hooks/app-xyz');
    expect(command).toContain('Authorization: Bearer the-secret');
    expect(command).toContain('--data-binary @-');
    expect(command.startsWith('curl -fsS -X POST')).toBe(true);
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
    const content = buildSessionSettings({ appSessionId: 'app-file', hookPort: 4601, secret: 's' });
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
