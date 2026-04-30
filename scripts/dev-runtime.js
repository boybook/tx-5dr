const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const mode = process.argv[2] || process.env.TX5DR_DEV_MODE || 'web';
if (!['web', 'electron'].includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SERVER_PORT = 4000;
const DEFAULT_WEB_PORT = 8076;
let turboChild = null;
let shuttingDown = false;
let selectedServerPort = Number(process.env.PORT || DEFAULT_SERVER_PORT);
let selectedWebPort = Number(process.env.WEB_PORT || process.env.TX5DR_WEB_DEV_PORT || DEFAULT_WEB_PORT);
const serverReadyFile = process.env.TX5DR_SERVER_READY_FILE
  || path.join(os.tmpdir(), `tx5dr-server-ready-${process.pid}.json`);
const hasExplicitServerPort = Boolean(process.env.PORT && process.env.PORT.trim());
const strictServerPort = process.env.TX5DR_SERVER_PORT_STRICT === '1'
  || ['0', 'false', 'no', 'off'].includes(String(process.env.TX5DR_SERVER_PORT_AUTO || '').toLowerCase());
if (!Number.isInteger(selectedServerPort) || selectedServerPort <= 0 || selectedServerPort > 65535) {
  selectedServerPort = DEFAULT_SERVER_PORT;
}
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

async function findFreePort(start, maxStep = 50, host = '0.0.0.0', avoid) {
  for (let i = 0; i <= maxStep; i += 1) {
    const candidate = start + i;
    if (avoid && candidate === avoid) continue;
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
  selectedServerPort = hasExplicitServerPort
    ? selectedServerPort
    : strictServerPort
      ? selectedServerPort
      : await findFreePort(selectedServerPort, 50, '0.0.0.0');
  selectedWebPort = await findFreePort(selectedWebPort, 50, '0.0.0.0', selectedServerPort);
  try {
    fs.unlinkSync(serverReadyFile);
  } catch {
    // No stale ready file to remove.
  }
  console.log(`[dev-runtime] Server port: ${selectedServerPort}${hasExplicitServerPort ? ' (explicit)' : strictServerPort ? ' (strict)' : ''}`);
  console.log(`[dev-runtime] Web dev server port: ${selectedWebPort}`);
  console.log(`[dev-runtime] Server ready file: ${serverReadyFile}`);
  console.log(`[dev-runtime] rtc-data-audio UDP port: ${process.env.RTC_DATA_AUDIO_UDP_PORT || '50110'}`);

  const args = ['turbo', 'run', 'dev', '--parallel', '--filter=!@tx5dr/client-tools'];
  if (mode === 'web') {
    args.push('--filter=!@tx5dr/electron-main');
  }

  const env = {
    ...process.env,
    PORT: String(selectedServerPort),
    TX5DR_BACKEND_TARGET: `http://127.0.0.1:${selectedServerPort}`,
    TX5DR_SERVER_READY_FILE: serverReadyFile,
    TX5DR_SERVER_PORT_AUTO: process.env.TX5DR_SERVER_PORT_AUTO || (hasExplicitServerPort ? '0' : '1'),
    TX5DR_SERVER_PORT_SCAN_STEPS: process.env.TX5DR_SERVER_PORT_SCAN_STEPS || '50',
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
