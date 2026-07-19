import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Spawn preflight + runtime version probe (slice-2 step 1, E3/E4) ──────────
//
// determinism-exempt (rule 0.3): real fs + child_process at the daemon boundary.
// Both probes are INJECTABLE — CI never runs the real thing (real Claude never
// runs in the harness). The SessionHost's default preflight is a permissive
// no-op; the real credential probe below is wired in at composition (app.ts),
// exactly like the SDK/PTY factories.

export type PreflightResult = { ok: true } | { ok: false; reason: string };
export type PreflightProbe = () => PreflightResult;

// Default preflight (E3): a cheap, NON-BURNING "authenticated, not just
// installed" check. Chosen signal = credential PRESENCE, not `claude auth
// status`:
//   - ANTHROPIC_API_KEY set (non-empty), OR
//   - ~/.claude/.credentials.json exists (the OAuth token store — observed on
//     this box as { claudeAiOauth: { accessToken, ... }, organizationUuid }).
// Rationale: `claude auth status` IS more authoritative, but it spawns a
// process and makes a network round-trip on every cache-miss of the hot spawn
// path; a credential-file stat is zero-burn and sub-millisecond. The probe is
// injectable, so a stricter check (e.g. `claude auth status`) can be swapped in
// without touching the host. This is a rule-0.6 fragile surface (the credential
// path is Claude Code's, not ours).
export function createCredentialPreflightProbe(env: NodeJS.ProcessEnv = process.env): PreflightProbe {
  return () => {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      return { ok: true };
    }
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(credentialsPath)) {
      return { ok: true };
    }
    return { ok: false, reason: 'no-credentials' };
  };
}

export type CliVersionProbe = () => Promise<string | null>;

// Default runtime version probe (E4): `claude --version` → the leading
// dotted-version token, or null when the binary is missing / unparseable.
// Never throws; a 5 s timeout guards against a hung CLI.
export function createCliVersionProbe(): CliVersionProbe {
  return () =>
    new Promise((resolvePromise) => {
      execFile('claude', ['--version'], { timeout: 5_000 }, (error, stdout) => {
        if (error !== null) {
          resolvePromise(null);
          return;
        }
        const match = /(\d+\.\d+\.\d+)/.exec(stdout);
        resolvePromise(match !== null ? match[1]! : stdout.trim().length > 0 ? stdout.trim() : null);
      });
    });
}
