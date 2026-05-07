import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDisplayProfile, type DisplayProfile } from './profiles/displayProfiles.js';

export interface DeviceUiConfig {
  serverBaseUrl: string;
  socketPath: string;
  profile: DisplayProfile;
  renderer: 'auto' | 'mock' | 'tft-sdl' | 'oled-sdl' | 'native';
  fixture?: string;
  deviceId: string;
  tokenPath: string;
  helperSocketPath: string;
  ackTimeoutMs: number;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): DeviceUiConfig {
  const args = parseArgs(argv);
  const profileId = args.profile ?? env.TX5DR_DEVICE_UI_PROFILE ?? defaultProfileForRenderer(args.renderer ?? env.TX5DR_DEVICE_UI_RENDERER);
  const configDir = env.TX5DR_CONFIG_DIR ?? (process.platform === 'linux' ? '/var/lib/tx5dr/config' : join(tmpdir(), 'tx5dr-config'));
  return {
    serverBaseUrl: args.server ?? env.TX5DR_SERVER_URL ?? 'http://127.0.0.1:8076',
    socketPath: args.socket ?? env.TX5DR_DEVICE_UI_SOCKET ?? join(tmpdir(), 'tx5dr-device-ui-panel.sock'),
    profile: getDisplayProfile(profileId),
    renderer: normalizeRenderer(args.renderer ?? env.TX5DR_DEVICE_UI_RENDERER),
    fixture: args.fixture ?? env.TX5DR_DEVICE_UI_FIXTURE,
    deviceId: env.TX5DR_DEVICE_ID ?? getDeviceId(configDir),
    tokenPath: env.TX5DR_DEVICE_UI_TOKEN ?? join(configDir, '.device-ui-token'),
    helperSocketPath: env.TX5DR_NETWORK_HELPER_SOCKET ?? '/run/tx5dr/network-helper.sock',
    ackTimeoutMs: Number(args.ackTimeoutMs ?? env.TX5DR_DEVICE_UI_ACK_TIMEOUT_MS ?? 1500),
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    out[key] = inlineValue ?? argv[index + 1] ?? 'true';
    if (inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) index += 1;
  }
  return out;
}

function defaultProfileForRenderer(renderer?: string): string {
  if (renderer?.startsWith('oled')) return 'oled-ssd1306-128x64-1btn';
  return 'tft-ili9486-320x480-touch';
}

function normalizeRenderer(renderer?: string): DeviceUiConfig['renderer'] {
  if (renderer === 'mock' || renderer === 'tft-sdl' || renderer === 'oled-sdl' || renderer === 'native') return renderer;
  return 'auto';
}

function getDeviceId(configDir: string): string {
  const machineIdPath = '/etc/machine-id';
  const seed = process.platform === 'linux' && existsSync(machineIdPath)
    ? readFileSync(machineIdPath, 'utf8').trim()
    : `${hostname()}:${configDir}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}
