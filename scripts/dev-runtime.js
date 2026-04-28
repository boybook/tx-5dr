const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const mode = process.argv[2] || process.env.TX5DR_DEV_MODE || 'web';
if (!['web', 'electron'].includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WEB_PORT = 8076;
let turboChild = null;
let shuttingDown = false;
let selectedWebPort = Number(process.env.WEB_PORT || process.env.TX5DR_WEB_DEV_PORT || DEFAULT_WEB_PORT);
if (!Number.isInteger(selectedWebPort) || selectedWebPort <= 0 || selectedWebPort > 65535) {
  selectedWebPort = DEFAULT_WEB_PORT;
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findFreePort(start, maxStep = 50, host = '0.0.0.0') {
  for (let i = 0; i <= maxStep; i += 1) {
    const candidate = start + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate, host)) {
      return candidate;
    }
  }
  throw new Error(`No free web port found from ${start} to ${start + maxStep}`);
}

function terminate(child, signal = 'SIGTERM') {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

async function startTurbo() {
  selectedWebPort = await findFreePort(selectedWebPort, 50, '0.0.0.0');
  console.log(`[dev-runtime] Web dev server port: ${selectedWebPort}`);
  console.log(`[dev-runtime] rtc-data-audio UDP port: ${process.env.RTC_DATA_AUDIO_UDP_PORT || '50110'}`);

  const args = ['turbo', 'run', 'dev', '--parallel', '--filter=!@tx5dr/client-tools'];
  if (mode === 'web') {
    args.push('--filter=!@tx5dr/electron-main');
  }

  const env = {
    ...process.env,
    WEB_PORT: String(selectedWebPort),
    TX5DR_WEB_DEV_PORT: String(selectedWebPort),
    RTC_DATA_AUDIO_UDP_PORT: process.env.RTC_DATA_AUDIO_UDP_PORT || '50110',
    RTC_DATA_AUDIO_ICE_UDP_MUX: process.env.RTC_DATA_AUDIO_ICE_UDP_MUX || '1',
  };

  turboChild = spawn('yarn', args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env,
    shell: true,
  });

  turboChild.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function installSignalHandlers() {
  const handler = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminate(turboChild, signal);
    setTimeout(() => process.exit(0), 200);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

(async () => {
  try {
    installSignalHandlers();
    await startTurbo();
  } catch (error) {
    console.error(`[dev-runtime] ${error instanceof Error ? error.message : String(error)}`);
    terminate(turboChild, 'SIGTERM');
    process.exit(1);
  }
})();
