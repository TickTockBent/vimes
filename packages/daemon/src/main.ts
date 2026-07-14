import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfigFromEnv } from './config.js';
import { productionClock, productionIdSource } from './prodIds.js';
import { createDaemon } from './app.js';

// The daemon entry point: read env config, build the verifier (real if Access is
// configured, fail-closed otherwise), boot, and register graceful shutdown.
async function runDaemon(): Promise<void> {
  const config = loadConfigFromEnv();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const daemon = createDaemon({ config, clock: productionClock, ids: productionIdSource });
  await daemon.start();

  // One line, no secrets: port, db path, whether Access is configured.
  process.stdout.write(
    `vimes-daemon listening on ${config.bindHost}:${daemon.port} — db=${config.dbPath} — auth=${daemon.authConfigured ? 'configured' : 'UNCONFIGURED (fail-closed)'}\n`,
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
