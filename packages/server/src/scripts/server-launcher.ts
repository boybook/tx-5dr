import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ServerCpuProfileManager } from '../services/ServerCpuProfileManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ServerLauncher');

function resolveDefaultServerEntry(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(path.dirname(currentFile)), 'index.js');
}

async function main() {
  const entryAbs = process.env.TX5DR_SERVER_ENTRY || process.argv[2] || resolveDefaultServerEntry();
  const manager = await ServerCpuProfileManager.create({ env: process.env });
  const buildResult = await manager.buildServerNodeArgs();
  const child = spawn(process.execPath, [...buildResult.args, entryAbs], {
    cwd: path.dirname(entryAbs),
    env: process.env,
    stdio: 'inherit',
  });

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | string | null = null;

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  };

  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  child.on('error', async (error) => {
    logger.error('Child failed to start', error);
    await manager.completeLaunchSession({
      launchSession: buildResult.launchSession,
      exitCode: 1,
      signal: null,
    });
    process.exit(1);
  });

  child.on('exit', async (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    await manager.completeLaunchSession({
      launchSession: buildResult.launchSession,
      exitCode,
      signal: exitSignal,
    });

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  logger.error('Failed', error);
  process.exit(1);
});
