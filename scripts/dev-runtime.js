const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const mode = process.argv[2] || process.env.TX5DR_DEV_MODE || 'web';
if (!['web', 'electron'].includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LIVEKIT_SIGNAL_PORT = Number(process.env.LIVEKIT_SIGNAL_PORT || 7880);
const LIVEKIT_TCP_PORT = Number(process.env.LIVEKIT_TCP_PORT || 7881);
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'tx5drdev';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'tx5dr-dev-secret-0123456789abcdef';
const LIVEKIT_CONFIG_PATH = path.join(PROJECT_ROOT, '.tmp', 'livekit.dev.yaml');

let livekitChild = null;
let turboChild = null;
let shuttingDown = false;

function triplet() {
  const platform = process.env.PLATFORM || process.platform;
  const arch = process.env.ARCH || process.arch;
  return `${platform}-${arch}`;
}

function livekitBinaryPath() {
  if (process.env.LIVEKIT_BINARY_PATH) {
    return process.env.LIVEKIT_BINARY_PATH;
  }
  const exe = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
  return path.join(PROJECT_ROOT, 'resources', 'bin', triplet(), exe);
}

function resolveCommand(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [command], { encoding: 'utf8', env: process.env })
    : spawnSync('which', [command], { encoding: 'utf8', env: process.env });
  if (probe.status !== 0) {
    return null;
  }
  const lines = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] || null;
}

function findLiveKitBinary() {
  const packagedBinary = livekitBinaryPath();
  const candidates = [
    packagedBinary,
    resolveCommand(process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'),
  ];

  if (process.platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/livekit-server',
      '/opt/homebrew/opt/livekit/bin/livekit-server',
      '/usr/local/bin/livekit-server',
      '/usr/local/opt/livekit/bin/livekit-server'
    );
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin/livekit-server', '/usr/bin/livekit-server');
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getInstallHint() {
  if (process.platform === 'darwin') {
    return [
      'LiveKit server not found on this Mac.',
      'Install it with Homebrew:',
      '  brew install livekit',
      'Or set LIVEKIT_BINARY_PATH to an existing livekit-server binary.',
    ].join('\n');
  }

  if (process.platform === 'linux') {
    return [
      'LiveKit server not found on this machine.',
      'Install it with:',
      '  curl -sSL https://get.livekit.io | bash',
      'Or set LIVEKIT_BINARY_PATH to an existing livekit-server binary.',
    ].join('\n');
  }

  if (process.platform === 'win32') {
    return [
      'LiveKit server not found on this machine.',
      'Install the latest Windows release from the LiveKit releases page,',
      'or set LIVEKIT_BINARY_PATH to an existing livekit-server.exe binary.',
    ].join('\n');
  }

  return 'LiveKit server not found. Install livekit-server locally or set LIVEKIT_BINARY_PATH.';
}

function ensureLiveKitBinary() {
  const binaryPath = findLiveKitBinary();
  if (!binaryPath) {
    throw new Error(getInstallHint());
  }
  return binaryPath;
}

function buildLiveKitConfig() {
  return [
    `port: ${LIVEKIT_SIGNAL_PORT}`,
    'rtc:',
    `  tcp_port: ${LIVEKIT_TCP_PORT}`,
    '  port_range_start: 50000',
    '  port_range_end: 50100',
    '  use_external_ip: false',
    'keys:',
    `  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}`,
    'logging:',
    '  level: info',
    '',
  ].join('\n');
}

function ensureLiveKitConfig() {
  fs.mkdirSync(path.dirname(LIVEKIT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LIVEKIT_CONFIG_PATH, buildLiveKitConfig(), 'utf-8');
}

function waitForHttp(url, timeoutMs = 15000, intervalMs = 250) {
  const started = Date.now();
  return new Promise((resolve) => {
    function probe() {
      try {
        const target = new URL(url);
        const req = http.request(
          {
            hostname: target.hostname,
            port: Number(target.port || 80),
            path: target.pathname || '/',
            method: 'GET',
            timeout: 1500,
          },
          (res) => {
            res.resume();
            resolve(Boolean(res.statusCode) && res.statusCode >= 200 && res.statusCode < 500);
          }
        );
        req.on('error', retry);
        req.on('timeout', () => {
          req.destroy();
          retry();
        });
        req.end();
      } catch {
        retry();
      }
    }

    function retry() {
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(probe, intervalMs);
    }

    probe();
  });
}

function terminate(child, signal = 'SIGTERM') {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

async function startLiveKit() {
  const ready = await waitForHttp(`http://127.0.0.1:${LIVEKIT_SIGNAL_PORT}`, 500, 100);
  if (ready) {
    console.log(`[dev-runtime] Reusing existing LiveKit on http://127.0.0.1:${LIVEKIT_SIGNAL_PORT}`);
    return;
  }

  const binaryPath = ensureLiveKitBinary();
  ensureLiveKitConfig();

  console.log(`[dev-runtime] Starting LiveKit: ${binaryPath}`);
  livekitChild = spawn(binaryPath, ['--config', LIVEKIT_CONFIG_PATH], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  livekitChild.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-runtime] LiveKit exited unexpectedly (code=${code}, signal=${signal})`);
    terminate(turboChild, 'SIGTERM');
    process.exit(code || 1);
  });

  const livekitOk = await waitForHttp(`http://127.0.0.1:${LIVEKIT_SIGNAL_PORT}`, 15000, 200);
  if (!livekitOk) {
    throw new Error('LiveKit did not become ready in time');
  }
}

function startTurbo() {
  const args = ['turbo', 'run', 'dev', '--parallel', '--filter=!@tx5dr/client-tools'];
  if (mode === 'web') {
    args.push('--filter=!@tx5dr/electron-main');
  }

  const env = {
    ...process.env,
    LIVEKIT_URL: `ws://127.0.0.1:${LIVEKIT_SIGNAL_PORT}`,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  };

  turboChild = spawn('yarn', args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env,
    shell: true,
  });

  turboChild.on('exit', (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      terminate(livekitChild, 'SIGTERM');
    }
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
    terminate(livekitChild, signal);
    setTimeout(() => process.exit(0), 200);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

(async () => {
  try {
    installSignalHandlers();
    await startLiveKit();
    startTurbo();
  } catch (error) {
    console.error(`[dev-runtime] ${error instanceof Error ? error.message : String(error)}`);
    terminate(livekitChild, 'SIGTERM');
    process.exit(1);
  }
})();
