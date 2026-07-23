import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTERED_HOOK_EVENT_NAMES } from '@vimes/core';

// ─── Per-session settings injection + per-spawn hook secret (slice-2 step 1) ──
//
// determinism-exempt (rule 0.3): real crypto + fs live here, the daemon boundary.
// The core never imports this module. A settings file registers the five hook
// relays; each relay reads a per-spawn bearer secret out of the ENVIRONMENT
// (`$VIMES_HOOK_SECRET`, expanded by the hook's own shell at run time) and the
// hook ingress verifies it constant-time.
//
// Why the environment and not the command line: a command line is world-readable
// via `ps` / `/proc/<pid>/cmdline` for as long as the hook runs, so any local
// process could lift the bearer. `/proc/<pid>/environ` is mode 0400, owner-only.
// The wire contract is unchanged — same header, same value, different carrier.
// The secret is NEVER logged (see the daemon's no-secrets discipline) and no
// longer appears in the settings file at all.

export interface SpawnSecret {
  // The bearer value the child carries in its environment (never in argv, never
  // in the settings file).
  secret: string;
  // sha256(secret) — the ingress compares digests constant-time so a length or
  // content mismatch never short-circuits the comparison.
  digest: Buffer;
}

// The environment variable the injected relay expands at hook-run time. Named
// once, here: the command builder and the env builder both derive from this
// constant, so the two can never drift apart.
export const HOOK_SECRET_ENV_VAR = 'VIMES_HOOK_SECRET';

// Everything a spawn needs to have a working hook relay, minted as ONE value so
// the two halves cannot be used apart: the settings file registers a relay that
// reads `$VIMES_HOOK_SECRET`, and `env` is the only thing that puts that
// variable in the child's environment. A caller that has a `settingsPath` to
// pass necessarily has the matching `env` in hand (see mintHookChannel).
export interface HookChannel {
  // Path of the written per-session settings file (the `--settings` / SDK
  // `settings` argument).
  readonly settingsPath: string;
  // Exactly `{ VIMES_HOOK_SECRET: <secret> }` — merge into the child env.
  readonly env: Readonly<Record<string, string>>;
  // sha256(secret), for the ingress registry.
  readonly digest: Buffer;
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function mintSpawnSecret(): SpawnSecret {
  // 32 random bytes, url-safe so it slots into the relay command with no escaping.
  const secret = randomBytes(32).toString('base64url');
  return { secret, digest: sha256(secret) };
}

// Constant-time secret check. Both sides are fixed-length sha256 digests, so
// timingSafeEqual never throws on a length mismatch and leaks no timing signal.
export function secretMatchesDigest(presented: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(sha256(presented), expectedDigest);
}

// The relay the injected hook runs: POST the hook's stdin body (observed
// contract) to the local ingress with the per-spawn bearer. `curl -fsS` fails
// loudly on a non-2xx without dumping progress noise into the hook log.
//
// The bearer is `$VIMES_HOOK_SECRET`, expanded by the hook's own shell at run
// time — so it never lands in argv. The header MUST stay in DOUBLE quotes:
// single quotes would send the literal string `$VIMES_HOOK_SECRET` and every
// hook would fail auth. There is deliberately no `secret` parameter here — the
// builder cannot embed a secret it is never given.
export function hookRelayCommand(args: { appSessionId: string; hookPort: number }): string {
  const url = `http://127.0.0.1:${args.hookPort}/hooks/${args.appSessionId}`;
  return `curl -fsS -X POST --data-binary @- -H "Authorization: Bearer $${HOOK_SECRET_ENV_VAR}" ${url}`;
}

// The per-session settings object registering all five hooks with the relay.
// FRAGILE-ADAPTER (rule 0.6): the hooks-block shape is Claude Code's, pinned by
// the step-0a spike (settingSources ['project'] MERGES with the project's own
// hooks — D14 holds). PreToolUse carries an all-tools matcher; the lifecycle
// hooks take none. The exact accepted shape is re-verified live, never in CI.
export function buildSessionSettings(args: { appSessionId: string; hookPort: number }): {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>>;
} {
  const command = hookRelayCommand(args);
  const hooks: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>
  > = {};
  for (const name of REGISTERED_HOOK_EVENT_NAMES) {
    const entry: { matcher?: string; hooks: Array<{ type: 'command'; command: string }> } = {
      hooks: [{ type: 'command', command }],
    };
    if (name === 'PreToolUse') {
      entry.matcher = '*';
    }
    hooks[name] = [entry];
  }
  return { hooks };
}

export function sessionSettingsDir(dataDir: string): string {
  return join(dataDir, 'session-settings');
}

export function sessionSettingsPath(dataDir: string, appSessionId: string): string {
  return join(sessionSettingsDir(dataDir), `${appSessionId}.json`);
}

// Write the per-session settings file (mode 600 — owner-only: it is per-session
// daemon-owned config naming the private ingress port, and the mode predates and
// outlives the secret ever being in it). Returns the path. Throws only on a
// genuine fs failure; the caller treats a throw as spawn-fatal (a session with no
// settings would have no hook relay).
export function writeSessionSettings(dataDir: string, appSessionId: string, content: unknown): string {
  const directory = sessionSettingsDir(dataDir);
  mkdirSync(directory, { recursive: true });
  const path = sessionSettingsPath(dataDir, appSessionId);
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

// Mint a whole hook channel for one spawn: a fresh secret, the settings file
// registering the five relays, and the environment fragment that carries the
// secret to the child. THE POINT OF THIS FUNCTION IS THAT IT IS THE ONLY WAY TO
// GET A settingsPath — a caller cannot obtain the file (and thus register the
// relays) without also receiving the `env` that makes those relays authenticate.
// Wiring one without the other would leave every hook posting `Bearer ` and the
// daemon would go deaf while still looking alive.
//
// Throws only on an fs failure from writeSessionSettings; the caller degrades to
// "no settings file at all", which means no relays are registered — hooks are
// absent, never silently unauthenticated.
export function mintHookChannel(args: {
  dataDir: string;
  appSessionId: string;
  hookPort: number;
}): HookChannel {
  const { secret, digest } = mintSpawnSecret();
  const content = buildSessionSettings({ appSessionId: args.appSessionId, hookPort: args.hookPort });
  const settingsPath = writeSessionSettings(args.dataDir, args.appSessionId, content);
  return { settingsPath, env: { [HOOK_SECRET_ENV_VAR]: secret }, digest };
}

// Merge a hook channel's secret into a child environment. Applied LAST so the
// variable survives any filtering the caller did on the base env (e.g. D15's
// CLAUDE* scrub). An absent channel contributes nothing — there are no relays to
// authenticate in that case.
export function envWithHookSecret<EnvValue extends string | undefined>(
  baseEnv: Record<string, EnvValue>,
  channel: HookChannel | undefined,
): Record<string, EnvValue | string> {
  return channel === undefined ? { ...baseEnv } : { ...baseEnv, ...channel.env };
}

// Best-effort removal (session exit / daemon shutdown). Never throws.
export function removeSessionSettings(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The file may already be gone; removal is best-effort by contract.
  }
}
