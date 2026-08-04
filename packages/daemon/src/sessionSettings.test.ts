import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANSWERING_HOOK_EVENT_NAME,
  COMPACTION_GATE_ALLOW_BODY,
  COMPACTION_GATE_HOLD_BODY,
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

// The relay command as it stood BEFORE S8·4 made the builder per-event —
// spelled out as a literal, not re-derived from the builder, so the
// byte-identical assertions below cannot pass by both sides changing together.
const PRE_S8_4_RELAY_COMMAND =
  `curl -fsS -X POST --data-binary @- -H "Authorization: Bearer $VIMES_HOOK_SECRET" http://127.0.0.1:4601/hooks/app-1`;

describe('buildSessionSettings (C)', () => {
  it('registers all SIX hooks; PreToolUse carries the all-tools matcher', () => {
    const settings = buildSessionSettings({ appSessionId: 'app-1', hookPort: 4601 });
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'].sort(),
    );
    for (const [name, entries] of Object.entries(settings.hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.hooks).toEqual([
        { type: 'command', command: hookRelayCommand({ appSessionId: 'app-1', hookPort: 4601 }, name) },
      ]);
      if (name === 'PreToolUse') {
        expect(entries[0]!.matcher).toBe('*');
      } else {
        expect(entries[0]!.matcher).toBeUndefined();
      }
    }
  });

  // ⚠ THE REGRESSION GUARD FOR THE PER-EVENT SPLIT. Making the builder per-event
  // is the kind of change that quietly rewrites five working relays to fix one;
  // this pins the other five against a hard-coded pre-S8·4 literal.
  it('every NON-PreCompact relay command is byte-identical to the pre-S8·4 command', () => {
    const settings = buildSessionSettings({ appSessionId: 'app-1', hookPort: 4601 });
    for (const [name, entries] of Object.entries(settings.hooks)) {
      if (name === ANSWERING_HOOK_EVENT_NAME) {
        continue;
      }
      expect(entries[0]!.hooks[0]!.command).toBe(PRE_S8_4_RELAY_COMMAND);
    }
    // ...and the PreCompact one is the ONLY one that differs.
    expect(settings.hooks[ANSWERING_HOOK_EVENT_NAME]![0]!.hooks[0]!.command).not.toBe(
      PRE_S8_4_RELAY_COMMAND,
    );
  });

  it('the relay command posts the hook stdin to the local ingress with the bearer secret', () => {
    const command = hookRelayCommand({ appSessionId: 'app-xyz', hookPort: 4601 }, 'SessionStart');
    expect(command).toContain('http://127.0.0.1:4601/hooks/app-xyz');
    expect(command).toContain(`Authorization: Bearer $${HOOK_SECRET_ENV_VAR}`);
    expect(command).toContain('--data-binary @-');
    expect(command.startsWith('curl -fsS -X POST')).toBe(true);
  });

  // THE POINT OF THE ENV CARRIER: nothing that lands in argv may contain the
  // bearer value. A command line is world-readable via /proc/<pid>/cmdline for
  // as long as the hook runs; the environment is not.
  it('the relay command carries the variable NAME, never a secret VALUE', () => {
    const command = hookRelayCommand({ appSessionId: 'app-xyz', hookPort: 4601 }, 'SessionStart');
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
    const command = hookRelayCommand({ appSessionId: 'app-q', hookPort: 4601 }, 'Stop');
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

// ─── the PreCompact relay: the daemon's answer, carried as an exit code ──────
//
// ⚠ THESE TESTS EXECUTE THE GENERATED STRING, not a paraphrase of it. Exit 2 is
// the only channel the CLI honors (OBSERVED SP8·1 Q3a, re-verified on CLI 2.1.221
// at the S8·4 step-0 gate), so a relay that composes the right words but exits
// the wrong number vetoes nothing — and the failure is SILENT, because the CLI
// logs an ignored non-veto as a successful hook. A string assertion alone cannot
// see that; running it under /bin/sh can.
describe('the PreCompact relay command (S8·4 / D64 — the compaction door)', () => {
  const preCompactCommand = hookRelayCommand(
    { appSessionId: 'app-gate', hookPort: 4601 },
    ANSWERING_HOOK_EVENT_NAME,
  );

  // Run the REAL generated command with a scripted `curl` shim first on PATH, so
  // the shell semantics under test are exactly the ones the hook will run under.
  function runRelayWithScriptedCurl(curlScript: string): { status: number; stdout: string } {
    const shimDirectory = mkdtempSync(join(temporaryDirectory, 'curl-shim-'));
    const shimPath = join(shimDirectory, 'curl');
    writeFileSync(shimPath, `#!/bin/sh\n${curlScript}\n`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', ['-c', preCompactCommand], {
      env: { PATH: `${shimDirectory}:/usr/bin:/bin`, [HOOK_SECRET_ENV_VAR]: 'test-secret' },
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout };
  }

  it('still POSTs the hook stdin to the same ingress with the same bearer', () => {
    // The answering relay WRAPS the bare post; it does not replace it. The auth
    // and transport contract is unchanged.
    expect(preCompactCommand).toContain('http://127.0.0.1:4601/hooks/app-gate');
    expect(preCompactCommand).toContain(`-H "Authorization: Bearer $${HOOK_SECRET_ENV_VAR}"`);
    expect(preCompactCommand).toContain('curl -fsS -X POST --data-binary @-');
  });

  it('is a SINGLE LINE of POSIX sh (the hook runs under `sh -c`)', () => {
    expect(preCompactCommand).not.toContain('\n');
    // Bashisms that would break under dash — the shell /bin/sh is on Debian/Ubuntu.
    expect(preCompactCommand).not.toContain('[[');
    expect(preCompactCommand).not.toContain('set -o pipefail');
  });

  it('EXECUTES: a `hold` body exits 2 — the only channel that actually vetoes', () => {
    expect(runRelayWithScriptedCurl(`printf %s ${COMPACTION_GATE_HOLD_BODY}`).status).toBe(2);
  });

  it('EXECUTES: an `allow` body exits 0', () => {
    expect(runRelayWithScriptedCurl(`printf %s ${COMPACTION_GATE_ALLOW_BODY}`).status).toBe(0);
  });

  it('EXECUTES: a curl FAILURE exits 0 — the door fails open when the daemon does', () => {
    // `curl -fsS` against a dead/erroring daemon: empty stdout, nonzero status.
    // A daemon that is down must not become a permanent veto on compaction.
    expect(runRelayWithScriptedCurl('echo "curl: (7) Failed to connect" >&2; exit 7').status).toBe(0);
  });

  it('EXECUTES: any UNRECOGNIZED body exits 0 — only the literal `hold` vetoes', () => {
    expect(runRelayWithScriptedCurl('printf %s HOLD').status).toBe(0);
    expect(runRelayWithScriptedCurl('printf %s "hold "').status).toBe(0);
    expect(runRelayWithScriptedCurl('printf %s \'{"decision":"block"}\'').status).toBe(0);
    expect(runRelayWithScriptedCurl('exit 0').status).toBe(0);
  });

  it('EXECUTES: writes NOTHING to stdout — the body is captured, never echoed', () => {
    // A PreCompact hook has no usable stdout channel (its hookSpecificOutput
    // variant is rejected by the CLI's own schema, OBSERVED SP8·1 Q3b(i)), so
    // leaking the answer there would only pollute the transcript's hook record.
    expect(runRelayWithScriptedCurl(`printf %s ${COMPACTION_GATE_HOLD_BODY}`).stdout).toBe('');
    expect(runRelayWithScriptedCurl(`printf %s ${COMPACTION_GATE_ALLOW_BODY}`).stdout).toBe('');
  });

  it('never emits a JSON decision — the shape the CLI accepts and ignores', () => {
    // The trap SP8·1 named explicitly: `{"decision":"block"}` is schema-checked,
    // logged as a SUCCESS, and does not block. Nothing in this relay may look
    // like an attempt to use it.
    expect(preCompactCommand).not.toContain('decision');
    expect(preCompactCommand).not.toContain('continue');
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
