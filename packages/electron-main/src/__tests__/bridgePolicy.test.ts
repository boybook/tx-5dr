import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopBridgeCapabilitySchema } from '@tx5dr/contracts';
import {
  buildBridgeArguments,
  classifyBridgeSender,
  evaluateBridgeCall,
  getCapabilitiesForKind,
  isValidBridgeConfigValue,
  listBridgeChannels,
  type BridgeSenderInput,
} from '../bridgePolicy.js';

const LOADING_PAGE = 'file:///Applications/TX-5DR.app/Contents/Resources/app/packages/electron-main/assets/loading.html';

function embeddedInput(frameUrl: string, overrides: Partial<BridgeSenderInput> = {}): BridgeSenderInput {
  return {
    isMainFrame: true,
    frameUrl,
    station: { kind: 'embedded', origin: 'http://127.0.0.1:8076' },
    shellPageUrls: [LOADING_PAGE],
    ...overrides,
  };
}

function remoteInput(frameUrl: string): BridgeSenderInput {
  return {
    isMainFrame: true,
    frameUrl,
    station: { kind: 'remote', origin: 'http://127.0.0.1:18101' },
    shellPageUrls: [LOADING_PAGE],
  };
}

describe('desktop bridge policy', () => {
  it('lets the embedded station page use desktop updates and local directories', () => {
    expect(evaluateBridgeCall('updater:download', embeddedInput('http://127.0.0.1:8076/')).allowed).toBe(true);
    expect(evaluateBridgeCall('shell:openPath', embeddedInput('http://127.0.0.1:8076/#settings')).allowed).toBe(true);
  });

  it('keeps privileged capabilities away from standalone plugin pages', () => {
    const pluginPage = embeddedInput('http://127.0.0.1:8076/plugin-page.html?plugin=x&page=y');
    expect(evaluateBridgeCall('updater:installAndRestart', pluginPage)).toEqual({ allowed: false, reason: 'capability_denied' });
    expect(evaluateBridgeCall('shell:openPath', pluginPage)).toEqual({ allowed: false, reason: 'capability_denied' });
    expect(evaluateBridgeCall('fs:saveFile', pluginPage).allowed).toBe(true);
  });

  it('rejects subframes, other origins and other sessions', () => {
    expect(evaluateBridgeCall('app:getVersion', embeddedInput('http://127.0.0.1:8076/', { isMainFrame: false })))
      .toEqual({ allowed: false, reason: 'untrusted_sender' });
    expect(evaluateBridgeCall('app:getVersion', embeddedInput('http://127.0.0.1:9999/')))
      .toEqual({ allowed: false, reason: 'untrusted_sender' });
    expect(evaluateBridgeCall('app:getVersion', embeddedInput('https://evil.example/')))
      .toEqual({ allowed: false, reason: 'untrusted_sender' });
    expect(evaluateBridgeCall('app:getVersion', embeddedInput('http://127.0.0.1:8076/', { station: null })))
      .toEqual({ allowed: false, reason: 'untrusted_sender' });
  });

  it('limits a remote station to capabilities that are safe to grant it', () => {
    const page = remoteInput('http://127.0.0.1:18101/');
    for (const channel of ['window:openLogbook', 'shell:openExternal', 'fs:saveFile', 'app:getVersion', 'config:get', 'shortcuts:setConfig']) {
      expect(evaluateBridgeCall(channel, page).allowed, channel).toBe(true);
    }
    for (const channel of [
      'shell:openPath', 'fs:selectFile', 'fs:selectDirectory', 'app:quit', 'app:restart',
      'updater:download', 'https:applySettings', 'remoteAccess:applyPreset', 'startupLogs:subscribe',
    ]) {
      expect(evaluateBridgeCall(channel, page), channel).toEqual({ allowed: false, reason: 'capability_denied' });
    }
  });

  it('treats only the shipped shell pages as local shell senders', () => {
    expect(classifyBridgeSender(embeddedInput(`${LOADING_PAGE}?retry=1#x`))).toEqual({ kind: 'shell', isPluginPage: false });
    expect(classifyBridgeSender(embeddedInput('file:///tmp/evil.html'))).toBeNull();
    expect(evaluateBridgeCall('startupLogs:subscribe', embeddedInput(LOADING_PAGE)).allowed).toBe(true);
    expect(evaluateBridgeCall('updater:check', embeddedInput(LOADING_PAGE))).toEqual({ allowed: false, reason: 'capability_denied' });
  });

  it('lets station pages open the station manager but only shell pages manage stations', () => {
    expect(evaluateBridgeCall('stations:openManager', embeddedInput('http://127.0.0.1:8076/')).allowed).toBe(true);
    expect(evaluateBridgeCall('stations:openManager', remoteInput('http://127.0.0.1:18101/')).allowed).toBe(true);
    for (const channel of ['stations:connect', 'stations:save', 'stations:trustCertificate', 'stations:probe']) {
      expect(evaluateBridgeCall(channel, embeddedInput('http://127.0.0.1:8076/')), channel).toEqual({ allowed: false, reason: 'capability_denied' });
      expect(evaluateBridgeCall(channel, remoteInput('http://127.0.0.1:18101/')), channel).toEqual({ allowed: false, reason: 'capability_denied' });
      expect(evaluateBridgeCall(channel, embeddedInput(LOADING_PAGE)).allowed, channel).toBe(true);
    }
    expect(evaluateBridgeCall('stations:openManager', embeddedInput('http://127.0.0.1:8076/plugin-page.html')))
      .toEqual({ allowed: false, reason: 'capability_denied' });
  });

  it('recognizes a development shell page served over http by its exact URL', () => {
    const devManager = 'http://localhost:8521/station-manager.html';
    const input = { ...remoteInput(`${devManager}?mode=connect`), shellPageUrls: [LOADING_PAGE, devManager] };
    expect(evaluateBridgeCall('stations:connect', input).allowed).toBe(true);
    expect(evaluateBridgeCall('stations:connect', { ...input, frameUrl: 'http://localhost:8521/index.html' }).allowed).toBe(false);
  });

  it('lets station pages read their own station but not manage stations', () => {
    expect(evaluateBridgeCall('stations:getCurrent', remoteInput('http://127.0.0.1:18101/')).allowed).toBe(true);
    expect(evaluateBridgeCall('stations:getCurrent', embeddedInput('http://127.0.0.1:8076/')).allowed).toBe(true);
  });

  it('rejects channels missing from the table', () => {
    expect(evaluateBridgeCall('fs:readFile', embeddedInput('http://127.0.0.1:8076/')))
      .toEqual({ allowed: false, reason: 'unknown_channel' });
  });

  it('validates config values by key', () => {
    expect(isValidBridgeConfigValue('closeBehavior', 'tray')).toBe(true);
    expect(isValidBridgeConfigValue('closeBehavior', 'explode')).toBe(false);
    expect(isValidBridgeConfigValue('remoteAccessPreset', 'public')).toBe(false);
    expect(isValidBridgeConfigValue('__proto__', {})).toBe(false);
  });

  it('passes version, kind and the granted capability list to the preload', () => {
    expect(buildBridgeArguments('remote', [LOADING_PAGE, 'http://localhost:8521/station-manager.html'])).toEqual([
      '--tx5dr-station-kind=remote',
      '--tx5dr-bridge-version=1',
      `--tx5dr-bridge-capabilities=${getCapabilitiesForKind('remote').join(',')}`,
      `--tx5dr-shell-pages=${encodeURIComponent(LOADING_PAGE)},${encodeURIComponent('http://localhost:8521/station-manager.html')}`,
    ]);
  });
});

describe('desktop bridge wiring', () => {
  const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
  const preloadSource = readFileSync(join(__dirname, '..', '..', '..', 'electron-preload', 'src', 'preload.ts'), 'utf8');

  it('routes every main-process IPC handler through the policy table', () => {
    const registered = [...mainSource.matchAll(/handleBridge\('([^']+)'/g)].map(match => match[1]).sort();
    expect(registered).toEqual(listBridgeChannels().sort());
    expect(mainSource.match(/ipcMain\.handle\(/g)).toHaveLength(1);
  });

  it('keeps the preload shell-page grant aligned with the policy', () => {
    const list = preloadSource.match(/const SHELL_PAGE_CAPABILITIES: BridgeCapability\[\] = \[([^\]]+)\]/)?.[1] ?? '';
    const names = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    expect(names).toEqual(getCapabilitiesForKind('shell').sort());
  });

  it('keeps the preload capability names aligned with the contract', () => {
    const union = preloadSource.match(/type BridgeCapability =([^;]+);/)?.[1] ?? '';
    const names = [...union.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    expect(names).toEqual([...DesktopBridgeCapabilitySchema.options].sort());
  });
});
