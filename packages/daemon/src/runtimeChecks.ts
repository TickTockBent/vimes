import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

// Shared `--version` output parsing: the leading dotted-version token, else the
// trimmed output, else null. Both channel probes go through this so a version
// string is read identically no matter which binary produced it.
function parseVersionFromStdout(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match !== null ? match[1]! : stdout.trim().length > 0 ? stdout.trim() : null;
}

// Default runtime version probe for the **PTY channel** (E4): the PATH `claude`
// binary — the one a raw terminal / escape-hatch session runs. It is NOT the
// binary SDK-hosted sessions run (see createSdkCliVersionProbe below; observed
// 2026-07-22: PATH 2.1.217 vs SDK-vendored 2.1.207). `claude --version` → the
// leading dotted-version token, or null when the binary is missing /
// unparseable. Never throws; a 5 s timeout guards against a hung CLI.
export function createCliVersionProbe(): CliVersionProbe {
  return () =>
    new Promise((resolvePromise) => {
      execFile('claude', ['--version'], { timeout: 5_000 }, (error, stdout) => {
        if (error !== null) {
          resolvePromise(null);
          return;
        }
        resolvePromise(parseVersionFromStdout(stdout));
      });
    });
}

// ─── SDK channel version probe (E4, slice-6 drift-checker fix) ───────────────
//
// The Agent SDK VENDORS its own Claude Code binary and runs that for every SDK
// session — the D4 default channel — so a green PATH-`claude` check says nothing
// about the daily driver. This probe observes that vendored binary instead.

// A version observation that names the binary it came from, so a drift record
// can say WHICH file it looked at. `version` is null when unknown/unparseable;
// `binaryPath` is null when the binary could not be resolved at all.
export interface CliVersionObservation {
  version: string | null;
  binaryPath: string | null;
}

export type SdkCliVersionProbe = () => Promise<CliVersionObservation>;
// Injectable seams (tests never invoke a real Claude binary): where the vendored
// binary lives, and how `--version` is run against a given path.
export type SdkBinaryResolver = () => string | null;
export type VersionCommandRunner = (binaryPath: string) => Promise<string | null>;

// Resolve the Claude Code binary the Agent SDK vendors: the platform package
// `@anthropic-ai/claude-agent-sdk-${platform}-${arch}` ships an executable named
// `claude` beside its package.json. Rule-0.6 fragile surface — the layout is the
// SDK's, not ours — so every failure mode collapses to null.
export function resolveSdkClaudeBinaryPath(): string | null {
  try {
    const requireFromDaemon = createRequire(import.meta.url);
    const platformPackageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const platformPackageJsonPath = requireFromDaemon.resolve(`${platformPackageName}/package.json`);
    const candidateBinaryPath = join(dirname(platformPackageJsonPath), 'claude');
    return existsSync(candidateBinaryPath) ? candidateBinaryPath : null;
  } catch {
    return null;
  }
}

// Default `--version` runner: exec the binary AT THE GIVEN PATH. The path is a
// required argument, so this runner structurally cannot fall back to a PATH
// lookup — there is no code path here that execs a bare `claude`.
function runVersionCommandAtPath(binaryPath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(binaryPath, ['--version'], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolvePromise(null);
        return;
      }
      resolvePromise(parseVersionFromStdout(stdout));
    });
  });
}

// Version probe for the SDK channel. Both seams default to the real thing.
//
// ⚠ When the vendored binary cannot be resolved this returns
// `{ version: null, binaryPath: null }` and runs NOTHING. It never falls back to
// the PATH `claude` — that fallback would silently re-introduce the very bug
// this probe exists to fix while looking green. An honest unknown beats a
// confident wrong answer.
export function createSdkCliVersionProbe(
  resolveSdkBinaryPath: SdkBinaryResolver = resolveSdkClaudeBinaryPath,
  runVersionCommand: VersionCommandRunner = runVersionCommandAtPath,
): SdkCliVersionProbe {
  return async () => {
    const binaryPath = resolveSdkBinaryPath();
    if (binaryPath === null) {
      return { version: null, binaryPath: null };
    }
    return { version: await runVersionCommand(binaryPath), binaryPath };
  };
}
