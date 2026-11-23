import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StationIdentitySchema } from '@tx5dr/contracts';
import { STATION_INSTANCE_FILE_NAME, StationIdentityService } from '../StationIdentityService.js';

const ID_A = '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10';
const ID_B = '0b8f5d1a-7e2c-4a6b-8d3e-9c1f2a3b4c5d';

describe('StationIdentityService', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-station-identity-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  function createService(ids: string[] = [ID_A, ID_B]) {
    const queue = [...ids];
    return new StationIdentityService({
      getConfigDir: async () => configDir,
      getAuthStatus: () => ({ enabled: true, allowPublicViewing: false }),
      getDistribution: async () => 'linux-service',
      buildInfo: { version: '1.2.3', commit: 'abcdef1234567890', channel: 'release' },
      generateId: () => queue.shift() ?? ID_B,
    });
  }

  it('builds a schema-valid identity without private station data', async () => {
    const identity = await createService().getIdentity();

    expect(StationIdentitySchema.parse(identity)).toEqual(identity);
    expect(identity).toEqual({
      identityVersion: 1,
      product: 'tx5dr',
      instanceId: ID_A,
      hostVersion: '1.2.3',
      sourceSha: 'abcdef1234567890',
      channel: 'release',
      distribution: 'linux-service',
      auth: { enabled: true, allowPublicViewing: false },
      desktopBridge: { minVersion: 1 },
    });
  });

  it('keeps the instance ID stable across service instances', async () => {
    const first = await createService([ID_A]).getInstanceId();
    const second = await createService([ID_B]).getInstanceId();

    expect(first).toBe(ID_A);
    expect(second).toBe(ID_A);
    const stored = JSON.parse(await readFile(join(configDir, STATION_INSTANCE_FILE_NAME), 'utf8'));
    expect(stored).toEqual({ instanceId: ID_A });
  });

  it('archives an unrecoverable file before generating a new ID', async () => {
    await writeFile(join(configDir, STATION_INSTANCE_FILE_NAME), '{not json');

    const instanceId = await createService([ID_B]).getInstanceId();

    expect(instanceId).toBe(ID_B);
    const files = await readdir(configDir);
    expect(files.some(name => name.startsWith(`${STATION_INSTANCE_FILE_NAME}.corrupt-`))).toBe(true);
    const stored = JSON.parse(await readFile(join(configDir, STATION_INSTANCE_FILE_NAME), 'utf8'));
    expect(stored).toEqual({ instanceId: ID_B });
  });
});
