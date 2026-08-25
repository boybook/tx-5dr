import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type ImageArtifact, type ImageHistoryRecord } from '@tx5dr/contracts';
import { PNG } from 'pngjs';

const rxRecord: ImageHistoryRecord = {
  id: 'rx-record', artifactId: 'rx-image', family: 'sstv', direction: 'rx', occurredAt: 10,
  saveReason: 'manual', complete: true, truncated: false,
};
const txRecord: ImageHistoryRecord = {
  id: 'tx-record', artifactId: 'tx-image', family: 'sstv', direction: 'tx', occurredAt: 20,
  operatorId: 'op-a', sessionId: 'session', startedAt: 20, outcome: 'completed',
};
const artifacts = new Map<string, ImageArtifact>([
  ['rx-image', {
    id: 'rx-image', family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8',
    width: 320, height: 240, frequency: 14_230_000, complete: true, truncated: false,
    pinned: false, contentHash: 'rx', createdAt: 10, imageUrl: '/rx',
  }],
  ['tx-image', {
    id: 'tx-image', family: 'sstv', direction: 'tx', operatorId: 'op-a', codecMode: 'robot36', pixelFormat: 'rgb8',
    width: 320, height: 240, frequency: 14_230_000, complete: true, truncated: false,
    pinned: false, contentHash: 'tx', createdAt: 20, imageUrl: '/tx',
  }],
]);

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getHistory: vi.fn(),
  deleteHistory: vi.fn(),
  linkHistoryQso: vi.fn(),
  linkArtifactQso: vi.fn(),
  getBackground: vi.fn(),
  saveBackground: vi.fn(),
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getImageArtifactStore: () => ({
        get: (id: string) => artifacts.get(id) ?? null,
        linkQso: mocks.linkArtifactQso,
      }),
      getImageComposerBackgroundStore: () => ({ get: mocks.getBackground, save: mocks.saveBackground }),
      getImageHistoryStore: () => ({
        list: mocks.list,
        get: mocks.getHistory,
        delete: mocks.deleteHistory,
        linkQso: mocks.linkHistoryQso,
        referencesArtifact: () => true,
      }),
      getImageTemplateStore: () => ({ referencesArtifact: () => false }),
      getImageRadioService: () => null,
    }),
  },
}));

describe('image radio history authorization', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.list.mockReset().mockImplementation((options: { direction: string; txOperatorId?: string }) => ({
      records: options.direction === 'rx' ? [rxRecord] : options.txOperatorId === 'op-a' ? [txRecord, rxRecord] : [rxRecord],
    }));
    mocks.getHistory.mockReset().mockReturnValue(txRecord);
    mocks.deleteHistory.mockReset().mockResolvedValue(txRecord);
    mocks.linkHistoryQso.mockReset().mockResolvedValue({ ...txRecord, qsoId: 'qso' });
    mocks.linkArtifactQso.mockReset().mockResolvedValue({ ...artifacts.get('tx-image'), qsoId: 'qso' });
    mocks.getBackground.mockReset().mockReturnValue({ operatorId: 'op-a', width: 320, height: 240, updatedAt: 1, imageUrl: '/background' });
    mocks.saveBackground.mockReset().mockResolvedValue({ operatorId: 'op-a', width: 2, height: 2, updatedAt: 2, imageUrl: '/background' });
    const { imageRadioRoutes } = await import('../image-radio.js');
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'] as UserRole | undefined;
      request.authUser = role ? {
        tokenId: 'test', role, operatorIds: ['op-a'], iat: 0, exp: 0,
      } : null;
    });
    await app.register(multipart);
    await app.register(imageRadioRoutes, { prefix: '/api/image-radio' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('projects a public all-history request to received records only', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/image-radio/history?direction=all' });

    expect(response.statusCode).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ direction: 'rx', txOperatorId: undefined }));
    expect(response.json().entries).toHaveLength(1);
    expect(response.json().entries[0].record.direction).toBe('rx');
  });

  it('returns shared receive and the selected operator transmit history', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/image-radio/history?direction=all&operatorId=op-a',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ direction: 'all', txOperatorId: 'op-a' }));
    expect(response.json().entries.map((entry: { record: ImageHistoryRecord }) => entry.record.direction)).toEqual(['tx', 'rx']);
  });

  it('rejects attempts to read or delete another operator transmit history', async () => {
    const read = await app.inject({
      method: 'GET', url: '/api/image-radio/history?direction=tx&operatorId=op-b',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    mocks.getHistory.mockReturnValue({ ...txRecord, operatorId: 'op-b' });
    const remove = await app.inject({
      method: 'DELETE', url: '/api/image-radio/history/tx-record',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(read.statusCode).toBe(403);
    expect(remove.statusCode).toBe(403);
    expect(mocks.deleteHistory).not.toHaveBeenCalled();
  });

  it('links a QSO to both the transmission event and its protected image', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/image-radio/history/tx-record',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { qsoId: 'qso' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.linkHistoryQso).toHaveBeenCalledWith('tx-record', 'qso');
    expect(mocks.linkArtifactQso).toHaveBeenCalledWith('tx-image', 'qso');
  });

  it('keeps composer backgrounds scoped to an authorized operator', async () => {
    const allowed = await app.inject({
      method: 'GET', url: '/api/image-radio/composer-backgrounds/op-a',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    const denied = await app.inject({
      method: 'GET', url: '/api/image-radio/composer-backgrounds/op-b',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().background).toMatchObject({ operatorId: 'op-a' });
    expect(denied.statusCode).toBe(403);
  });

  it('accepts a normalized PNG background for the authorized operator', async () => {
    const boundary = 'tx5dr-background-boundary';
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="background.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'PUT', url: '/api/image-radio/composer-backgrounds/op-a',
      headers: { 'x-role': UserRole.OPERATOR, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.saveBackground).toHaveBeenCalledWith('op-a', expect.any(Buffer));
  });
});
