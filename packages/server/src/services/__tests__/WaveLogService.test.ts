import { afterEach, describe, expect, it, vi } from 'vitest';

import { WaveLogService } from '../WaveLogService.js';
import type { QSORecord, WaveLogConfig } from '@tx5dr/contracts';

const baseConfig: WaveLogConfig = {
  url: 'https://example.com',
  apiKey: 'test-api-key',
  stationId: 'station-1',
  radioName: 'TX5DR',
  autoUploadQSO: true,
};

const baseQso: QSORecord = {
  id: 'qso-1',
  callsign: 'BG6VWX',
  frequency: 7074000,
  mode: 'FT8',
  startTime: Date.parse('2026-04-01T15:38:00Z'),
  endTime: Date.parse('2026-04-01T15:39:00Z'),
  messages: ['CQ BG5DRB'],
  myCallsign: 'BG5DRB',
  myGrid: 'PM01AA',
};

describe('WaveLogService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats duplicate upload responses as skipped instead of network failures', async () => {
    const service = new WaveLogService(baseConfig);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'abort',
        type: 'adif',
        messages: [
          '',
          'Date/Time: 2026-04-01 15:38:00 Callsign: BG6VWX Band: 40m Duplicate for BG5DRB<br>',
        ],
      }), {
        status: 400,
        statusText: 'Bad Request',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = await service.uploadQSO(baseQso);

    expect(result).toEqual({
      success: true,
      status: 'duplicate',
      message: 'Date/Time: 2026-04-01 15:38:00 Callsign: BG6VWX Band: 40m Duplicate for BG5DRB',
    });
  });

  it('returns failed status for non-duplicate business rejections', async () => {
    const service = new WaveLogService(baseConfig);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'abort',
        message: 'Station profile mismatch',
      }), {
        status: 400,
        statusText: 'Bad Request',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = await service.uploadQSO(baseQso);

    expect(result).toEqual({
      success: false,
      status: 'failed',
      message: 'Station profile mismatch',
    });
  });

  it('keeps network failures as network errors', async () => {
    const service = new WaveLogService(baseConfig);
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));

    vi.stubGlobal('fetch', fetchMock);

    await expect(service.uploadQSO(baseQso)).rejects.toThrow(
      'Network request failed: cannot connect to WaveLog server, check URL, network, and firewall'
    );
  });

  it('counts duplicate uploads as skipped in batch uploads', async () => {
    const service = new WaveLogService(baseConfig);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'created' }), {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'abort',
        messages: ['Duplicate for BG5DRB<br>'],
      }), {
        status: 400,
        statusText: 'Bad Request',
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'abort',
        message: 'API key rejected',
      }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'Content-Type': 'application/json',
        },
      }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await service.uploadMultipleQSOs([
      { ...baseQso, id: 'qso-created', callsign: 'BG1AAA' },
      { ...baseQso, id: 'qso-duplicate', callsign: 'BG6VWX' },
      { ...baseQso, id: 'qso-failed', callsign: 'BG9ZZZ' },
    ]);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Upload complete: 1 succeeded, 1 skipped, 1 failed');
    expect(result.uploadedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.errors).toEqual(['BG9ZZZ: API key rejected']);
  });
});
