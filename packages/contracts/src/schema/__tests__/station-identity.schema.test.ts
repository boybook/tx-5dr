import { describe, expect, it } from 'vitest';
import {
  DESKTOP_BRIDGE_VERSION,
  DesktopBridgeInfoSchema,
  StationIdentitySchema,
} from '../station-identity.schema.js';

const identity = {
  identityVersion: 1,
  product: 'tx5dr',
  instanceId: '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10',
  hostVersion: '1.0.1',
  sourceSha: '87153c48',
  channel: 'release',
  distribution: 'linux-service',
  auth: { enabled: true, allowPublicViewing: false },
  desktopBridge: { minVersion: 1 },
};

describe('StationIdentitySchema', () => {
  it('accepts a complete identity document', () => {
    expect(StationIdentitySchema.parse(identity)).toEqual(identity);
  });

  it('rejects another product or identity version', () => {
    expect(StationIdentitySchema.safeParse({ ...identity, product: 'other' }).success).toBe(false);
    expect(StationIdentitySchema.safeParse({ ...identity, identityVersion: 2 }).success).toBe(false);
  });

  it('strips fields outside the public contract', () => {
    const parsed = StationIdentitySchema.parse({ ...identity, dataDir: '/var/lib/tx5dr', callsign: 'BG7XXX' });
    expect(parsed).not.toHaveProperty('dataDir');
    expect(parsed).not.toHaveProperty('callsign');
  });
});

describe('DesktopBridgeInfoSchema', () => {
  it('accepts the current bridge version and known capabilities', () => {
    expect(DesktopBridgeInfoSchema.parse({
      version: DESKTOP_BRIDGE_VERSION,
      kind: 'remote',
      capabilities: ['windows', 'saveFile'],
    }).kind).toBe('remote');
  });

  it('rejects unknown capability names', () => {
    expect(DesktopBridgeInfoSchema.safeParse({
      version: DESKTOP_BRIDGE_VERSION,
      kind: 'embedded',
      capabilities: ['rawPtt'],
    }).success).toBe(false);
  });
});

describe('desktop station schemas', () => {
  it('decodes the station manager state and probe results', async () => {
    const { DesktopStationsStateSchema, DesktopStationProbeResultSchema, DesktopCurrentStationSchema } = await import('../desktop-stations.schema.js');
    const state = DesktopStationsStateSchema.parse({
      activeStationId: 'embedded',
      openStationIds: ['embedded'],
      embedded: { id: 'embedded', status: 'ready', error: null },
      profiles: [{ id: 'a', label: 'Shack', url: 'http://10.0.0.2:8076', pinnedFingerprint256: null, lastIdentity: null }],
      connections: { a: { stationId: 'a', phase: 'needs-trust', certificate: { fingerprint256: 'AB', subject: null, issuer: null, validTo: null } } },
      discovered: [],
    });
    expect(state.connections.a.phase).toBe('needs-trust');
    expect(DesktopStationProbeResultSchema.parse({ kind: 'unreachable', url: 'http://h', code: 'ECONNREFUSED' }).kind).toBe('unreachable');
    expect(DesktopStationProbeResultSchema.safeParse({ kind: 'ok', url: 'http://h' }).success).toBe(false);
    expect(DesktopCurrentStationSchema.parse({ stationId: 'embedded', kind: 'embedded', label: null, url: null }).kind).toBe('embedded');
  });
});
