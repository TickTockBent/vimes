import { describe, expect, it } from 'vitest';
import { createSdkCliVersionProbe, resolveSdkClaudeBinaryPath } from './runtimeChecks.js';

// SDK-channel version probe (E4, drift-checker fix). Both seams — binary
// resolution and `--version` execution — are injected here, so no test in this
// file ever runs a real Claude binary. The version-command runner doubles as the
// no-PATH-fallback witness: every execution the probe performs must arrive here
// with the resolved path, so a call count of zero proves nothing was exec'd.
describe('createSdkCliVersionProbe (SDK channel)', () => {
  function recordingVersionRunner(versionByBinaryPath: Record<string, string | null>): {
    run: (binaryPath: string) => Promise<string | null>;
    invokedPaths: string[];
  } {
    const invokedPaths: string[] = [];
    return {
      invokedPaths,
      run: async (binaryPath: string) => {
        invokedPaths.push(binaryPath);
        return versionByBinaryPath[binaryPath] ?? null;
      },
    };
  }

  it('returns null (never the PATH binary) when the SDK binary cannot be resolved', async () => {
    const runner = recordingVersionRunner({ claude: '2.1.217' });
    const probe = createSdkCliVersionProbe(() => null, runner.run);

    const observation = await probe();

    expect(observation).toEqual({ version: null, binaryPath: null });
    // The no-fallback property: with resolution failed the probe executed NOTHING
    // at all — in particular it never reached for a bare `claude` on PATH, which
    // would have re-introduced the very bug this probe exists to fix.
    expect(runner.invokedPaths).toEqual([]);
  });

  it('parses the version from the resolved binary and reports that binaryPath', async () => {
    const vendoredBinaryPath = '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
    const runner = recordingVersionRunner({ [vendoredBinaryPath]: '2.1.207' });
    const probe = createSdkCliVersionProbe(() => vendoredBinaryPath, runner.run);

    const observation = await probe();

    expect(observation).toEqual({ version: '2.1.207', binaryPath: vendoredBinaryPath });
    // The only binary consulted is the injected one — again, never PATH `claude`.
    expect(runner.invokedPaths).toEqual([vendoredBinaryPath]);
  });

  it('reports an unknown version but still names the binary when the runner reads nothing', async () => {
    const vendoredBinaryPath = '/fake/sdk/claude';
    const runner = recordingVersionRunner({});
    const probe = createSdkCliVersionProbe(() => vendoredBinaryPath, runner.run);

    expect(await probe()).toEqual({ version: null, binaryPath: vendoredBinaryPath });
  });

  it('the default resolver points at the SDK-vendored binary, not at a PATH lookup', () => {
    // Resolution only — nothing is executed. In this repo the platform package is
    // installed, so the resolver yields an absolute path ending in the vendored
    // `claude`; the assertion tolerates a machine where it is absent (null).
    const resolvedPath = resolveSdkClaudeBinaryPath();
    if (resolvedPath !== null) {
      expect(resolvedPath).toMatch(/@anthropic-ai[/\\]claude-agent-sdk-[^/\\]+[/\\]claude$/);
    }
  });
});
