import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_STATION_ID,
  REMOTE_GATEWAY_PORT_RANGE,
  allocateGatewayPort,
  createRemoteStationProfile,
  decodeStationSettings,
  gatewayOrigin,
  normalizeStationUrl,
  removeRemoteStation,
  stationPartition,
  upsertRemoteStation,
  type RemoteStationProfile,
} from '../stationProfiles.js';

function profile(overrides: Partial<RemoteStationProfile> = {}): RemoteStationProfile {
  return {
    id: 'aaaaaaaa-1111-4222-8333-444444444444',
    label: 'Shack',
    url: 'http://192.168.1.10:8076',
    gatewayPort: REMOTE_GATEWAY_PORT_RANGE.start,
    ...overrides,
  };
}

describe('normalizeStationUrl', () => {
  it('defaults a bare host to the station web port', () => {
    expect(normalizeStationUrl('192.168.1.10')).toEqual({ ok: true, url: 'http://192.168.1.10:8076' });
    expect(normalizeStationUrl('  shack.local:9000/ ')).toEqual({ ok: true, url: 'http://shack.local:9000' });
    expect(normalizeStationUrl('[fd00::5]')).toEqual({ ok: true, url: 'http://[fd00::5]:8076' });
  });

  it('keeps an explicit scheme and its default port', () => {
    expect(normalizeStationUrl('https://station.example')).toEqual({ ok: true, url: 'https://station.example' });
    expect(normalizeStationUrl('HTTPS://Station.Example:8443')).toEqual({ ok: true, url: 'https://station.example:8443' });
  });

  it('rejects other schemes, paths and credentials', () => {
    expect(normalizeStationUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeStationUrl('ftp://host')).toEqual({ ok: false, reason: 'unsupported_protocol' });
    expect(normalizeStationUrl('http://host/app')).toEqual({ ok: false, reason: 'has_path_or_credentials' });
    expect(normalizeStationUrl('http://user:pw@host')).toEqual({ ok: false, reason: 'has_path_or_credentials' });
  });
});

describe('station settings', () => {
  it('drops invalid or duplicate profiles and falls back to the embedded station', () => {
    const settings = decodeStationSettings({
      activeStationId: 'missing-station',
      profiles: [
        profile(),
        profile({ id: 'bbbbbbbb-1111-4222-8333-444444444444' }), // duplicate port
        { ...profile({ id: 'cccccccc-1111-4222-8333-444444444444', gatewayPort: REMOTE_GATEWAY_PORT_RANGE.start + 1 }), url: 'ftp://x' },
        'garbage',
      ],
    });
    expect(settings.profiles.map(item => item.id)).toEqual([profile().id]);
    expect(settings.activeStationId).toBe(EMBEDDED_STATION_ID);
    expect(decodeStationSettings(undefined)).toEqual({ activeStationId: EMBEDDED_STATION_ID, profiles: [] });
  });

  it('keeps a valid active remote station', () => {
    const settings = decodeStationSettings({ activeStationId: profile().id, profiles: [profile()] });
    expect(settings.activeStationId).toBe(profile().id);
  });

  it('allocates unique gateway ports and skips unusable ones', () => {
    const first = profile();
    expect(allocateGatewayPort([first])).toBe(REMOTE_GATEWAY_PORT_RANGE.start + 1);
    expect(allocateGatewayPort([first], port => port !== REMOTE_GATEWAY_PORT_RANGE.start + 1)).toBe(REMOTE_GATEWAY_PORT_RANGE.start + 2);
    expect(allocateGatewayPort([], () => true, new Set([REMOTE_GATEWAY_PORT_RANGE.start]))).toBe(REMOTE_GATEWAY_PORT_RANGE.start + 1);
  });

  it('creates, updates and removes remote profiles', () => {
    const created = createRemoteStationProfile({ label: ' ', url: '10.0.0.2' }, [], { generateId: () => 'dddddddd-1111-4222-8333-444444444444' });
    expect(created).toMatchObject({ label: '10.0.0.2:8076', url: 'http://10.0.0.2:8076', gatewayPort: REMOTE_GATEWAY_PORT_RANGE.start });
    expect(stationPartition(created)).toBe('persist:station-dddddddd-1111-4222-8333-444444444444');
    expect(gatewayOrigin(created)).toBe(`http://127.0.0.1:${REMOTE_GATEWAY_PORT_RANGE.start}`);

    let settings = upsertRemoteStation({ activeStationId: created.id, profiles: [] }, created);
    settings = upsertRemoteStation(settings, { ...created, label: 'Renamed' });
    expect(settings.profiles).toHaveLength(1);
    expect(settings.profiles[0].label).toBe('Renamed');

    settings = removeRemoteStation(settings, created.id);
    expect(settings).toEqual({ activeStationId: EMBEDDED_STATION_ID, profiles: [] });
  });
});
