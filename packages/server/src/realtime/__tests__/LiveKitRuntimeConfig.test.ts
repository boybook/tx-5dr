import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildLiveKitRuntimeConfigYaml,
  loadManagedLiveKitSettingsFromConfigFile,
  normalizeManagedLiveKitSettings,
  validateManagedLiveKitSettings,
} from '../LiveKitRuntimeConfig.js';

describe('LiveKitRuntimeConfig', () => {
  it('defaults to lan mode when config is missing', async () => {
    const settings = await loadManagedLiveKitSettingsFromConfigFile('/tmp/tx5dr-missing-config.json');

    expect(settings).toEqual({
      networkMode: 'lan',
      nodeIp: null,
    });
  });

  it('reads the managed network mode from config.json', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-livekit-runtime-'));
    const configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      livekitNetworkMode: 'internet-manual',
      livekitNodeIp: '203.0.113.10',
    }), 'utf-8');

    const settings = await loadManagedLiveKitSettingsFromConfigFile(configPath);

    expect(settings).toEqual({
      networkMode: 'internet-manual',
      nodeIp: '203.0.113.10',
    });
  });

  it('renders use_external_ip for internet-auto mode', () => {
    const yaml = buildLiveKitRuntimeConfigYaml(
      {
        networkMode: 'internet-auto',
        nodeIp: null,
      },
      {
        signalPort: 7880,
        tcpPort: 7881,
        udpStart: 50000,
        udpEnd: 50100,
      },
      'tx5dr-test',
      'secret',
    );

    expect(yaml).toContain('  use_external_ip: true');
    expect(yaml).not.toContain('node_ip:');
  });

  it('renders node_ip for internet-manual mode', () => {
    const yaml = buildLiveKitRuntimeConfigYaml(
      {
        networkMode: 'internet-manual',
        nodeIp: '203.0.113.10',
      },
      {
        signalPort: 7880,
        tcpPort: 7881,
        udpStart: 50000,
        udpEnd: 50100,
      },
      'tx5dr-test',
      'secret',
    );

    expect(yaml).toContain('  use_external_ip: false');
    expect(yaml).toContain('  node_ip: 203.0.113.10');
  });

  it('rejects manual mode without a valid IPv4 address', () => {
    expect(() => validateManagedLiveKitSettings(normalizeManagedLiveKitSettings({
      networkMode: 'internet-manual',
      nodeIp: 'radio.example.test',
    }))).toThrow(/Invalid LiveKit nodeIp/);
  });
});
