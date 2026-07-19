import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTERED_HOOK_EVENT_NAMES } from '@vimes/core';

// ─── Per-session settings injection + per-spawn hook secret (slice-2 step 1) ──
//
// determinism-exempt (rule 0.3): real crypto + fs live here, the daemon boundary.
// The core never imports this module. A settings file registers the five hook
// relays; each relay carries a per-spawn bearer secret the hook ingress verifies
// constant-time. The secret at rest is mode-600 (it grants hook-emit for one
// session); it is NEVER logged (see the daemon's no-secrets discipline).

export interface SpawnSecret {
  // The bearer value baked verbatim into the relay command (and settings file).
  secret: string;
  // sha256(secret) — the ingress compares digests constant-time so a length or
  // content mismatch never short-circuits the comparison.
  digest: Buffer;
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
export function hookRelayCommand(args: { appSessionId: string; hookPort: number; secret: string }): string {
  const url = `http://127.0.0.1:${args.hookPort}/hooks/${args.appSessionId}`;
  return `curl -fsS -X POST --data-binary @- -H "Authorization: Bearer ${args.secret}" ${url}`;
}

// The per-session settings object registering all five hooks with the relay.
// FRAGILE-ADAPTER (rule 0.6): the hooks-block shape is Claude Code's, pinned by
// the step-0a spike (settingSources ['project'] MERGES with the project's own
// hooks — D14 holds). PreToolUse carries an all-tools matcher; the lifecycle
// hooks take none. The exact accepted shape is re-verified live, never in CI.
export function buildSessionSettings(args: { appSessionId: string; hookPort: number; secret: string }): {
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

// Write the per-session settings file (mode 600 — it holds the bearer secret).
// Returns the path. Throws only on a genuine fs failure; the caller treats a
// throw as spawn-fatal (a session with no settings would have no hook relay).
export function writeSessionSettings(dataDir: string, appSessionId: string, content: unknown): string {
  const directory = sessionSettingsDir(dataDir);
  mkdirSync(directory, { recursive: true });
  const path = sessionSettingsPath(dataDir, appSessionId);
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

// Best-effort removal (session exit / daemon shutdown). Never throws.
export function removeSessionSettings(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The file may already be gone; removal is best-effort by contract.
  }
}
