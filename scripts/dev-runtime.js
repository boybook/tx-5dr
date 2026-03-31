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
const LIVEKIT_CREDENTIAL_PATH = path.join(PROJECT_ROOT, '.tmp', 'livekit-credentials.env');
const LIVEKIT_CONFIG_PATH = path.join(PROJECT_ROOT, '.tmp', 'livekit.dev.yaml');

let livekitChild = null;
let turboChild = null;
let shuttingDown = false;
let livekitRuntime = {
  mode: 'disabled',
  reason: null,
};

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

function parseEnvFile(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function renderCredentialEnv(data) {
  return [
    '# Managed by TX-5DR dev runtime.',
    `LIVEKIT_API_KEY=${data.apiKey}`,
    `LIVEKIT_API_SECRET=${data.apiSecret}`,
    `LIVEKIT_CREDENTIALS_CREATED_AT=${data.createdAt}`,
    `LIVEKIT_CREDENTIALS_ROTATED_AT=${data.rotatedAt}`,
    '',
  ].join('\n');
}

function ensureLiveKitCredentials() {
  fs.mkdirSync(path.dirname(LIVEKIT_CREDENTIAL_PATH), { recursive: true });
  try {
    if (fs.existsSync(LIVEKIT_CREDENTIAL_PATH)) {
      const parsed = parseEnvFile(fs.readFileSync(LIVEKIT_CREDENTIAL_PATH, 'utf-8'));
      const apiKey = parsed.LIVEKIT_API_KEY && parsed.LIVEKIT_API_KEY.trim();
      const apiSecret = parsed.LIVEKIT_API_SECRET && parsed.LIVEKIT_API_SECRET.trim();
      if (apiKey && apiSecret) {
        const createdAt = (parsed.LIVEKIT_CREDENTIALS_CREATED_AT || '').trim() || new Date().toISOString();
        const rotatedAt = (parsed.LIVEKIT_CREDENTIALS_ROTATED_AT || '').trim() || createdAt;
        return { apiKey, apiSecret, createdAt, rotatedAt };
      }
    }
  } catch (error) {
    console.warn(`[dev-runtime] Failed to read existing LiveKit credentials, regenerating: ${error.message}`);
  }

  const now = new Date().toISOString();
  const data = {
    apiKey: `tx5dr-${randomHex(8)}`,
    apiSecret: randomHex(24),
    createdAt: now,
    rotatedAt: now,
  };
  fs.writeFileSync(LIVEKIT_CREDENTIAL_PATH, renderCredentialEnv(data), 'utf-8');
  return data;
}

function randomHex(bytes) {
  return require('crypto').randomBytes(bytes).toString('hex');
}

function ensureLiveKitBinary() {
  const binaryPath = findLiveKitBinary();
  if (!binaryPath) {
    throw new Error(getInstallHint());
  }
  return binaryPath;
}

function buildLiveKitConfig(credentials) {
  return [
    `port: ${LIVEKIT_SIGNAL_PORT}`,
    'rtc:',
    `  tcp_port: ${LIVEKIT_TCP_PORT}`,
    '  port_range_start: 50000',
    '  port_range_end: 50100',
    '  use_external_ip: false',
    'keys:',
    `  ${credentials.apiKey}: ${credentials.apiSecret}`,
    'logging:',
    '  level: info',
    '',
  ].join('\n');
}

function ensureLiveKitConfig() {
  fs.mkdirSync(path.dirname(LIVEKIT_CONFIG_PATH), { recursive: true });
  const credentials = ensureLiveKitCredentials();
  fs.writeFileSync(LIVEKIT_CONFIG_PATH, buildLiveKitConfig(credentials), 'utf-8');
  return credentials;
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
    if (
      (process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET)
      || process.env.LIVEKIT_CREDENTIALS_FILE
    ) {
      livekitRuntime = {
        mode: 'external-configured',
        reason: null,
      };
    } else {
      livekitRuntime = {
        mode: 'external-unknown',
        reason: 'Existing LiveKit is already listening on the signaling port, but its credentials are unknown to the dev runtime. Falling back to ws-compat to avoid issuing invalid tokens.',
      };
      console.warn(`[dev-runtime] ${livekitRuntime.reason}`);
    }
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
  livekitRuntime = {
    mode: 'managed',
    reason: null,
  };
}

function startTurbo() {
  const args = ['turbo', 'run', 'dev', '--parallel', '--filter=!@tx5dr/client-tools'];
  if (mode === 'web') {
    args.push('--filter=!@tx5dr/electron-main');
  }

  const env = {
    ...process.env,
    LIVEKIT_URL: `ws://127.0.0.1:${LIVEKIT_SIGNAL_PORT}`,
  };

  if (livekitRuntime.mode === 'managed') {
    ensureLiveKitCredentials();
    env.LIVEKIT_DISABLED = '0';
    delete env.LIVEKIT_API_KEY;
    delete env.LIVEKIT_API_SECRET;
    env.LIVEKIT_CREDENTIALS_FILE = LIVEKIT_CREDENTIAL_PATH;
    env.LIVEKIT_CONFIG_PATH = LIVEKIT_CONFIG_PATH;
  } else if (livekitRuntime.mode === 'external-configured') {
    env.LIVEKIT_DISABLED = '0';
  } else {
    env.LIVEKIT_DISABLED = '1';
    delete env.LIVEKIT_API_KEY;
    delete env.LIVEKIT_API_SECRET;
    delete env.LIVEKIT_CREDENTIALS_FILE;
    delete env.LIVEKIT_CONFIG_PATH;
  }

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
