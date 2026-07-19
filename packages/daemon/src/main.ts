import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfigFromEnv } from './config.js';
import { productionClock, productionIdSource } from './prodIds.js';
import { createDaemon } from './app.js';
import { createCliVersionProbe, createCredentialPreflightProbe } from './runtimeChecks.js';

// The daemon entry point: read env config, build the verifier (real if Access is
// configured, fail-closed otherwise), boot, and register graceful shutdown.
async function runDaemon(): Promise<void> {
  const config = loadConfigFromEnv();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });

  // Production injects the REAL probes (determinism-exempt boundary): a
  // credential-presence preflight and a `claude --version` runtime check.
  const daemon = createDaemon({
    config,
    clock: productionClock,
    ids: productionIdSource,
    preflightProbe: createCredentialPreflightProbe(),
    cliVersionProbe: createCliVersionProbe(),
  });
  await daemon.start();

  // One line, no secrets: product port, hook port, db path, whether Access is configured.
  process.stdout.write(
    `vimes-daemon listening on ${config.bindHost}:${daemon.port} (hooks ${config.bindHost}:${daemon.hookPort}) — db=${config.dbPath} — auth=${daemon.authConfigured ? 'configured' : 'UNCONFIGURED (fail-closed)'}\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`vimes-daemon received ${signal}, shutting down\n`);
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`vimes-daemon shutdown error: ${String(error)}\n`);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

runDaemon().catch((error: unknown) => {
  process.stderr.write(`vimes-daemon failed to start: ${String(error)}\n`);
  process.exit(1);
});
