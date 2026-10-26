import { describe, it, expect, vi } from 'vitest';
import { WavelogProtocol, type WaveLogPluginConfig } from './protocol.js';
const config: WaveLogPluginConfig = { url: 'https://example.test', apiKey: 'wl2_secret', apiVersion: 'v2', stationId: '1', autoUploadQSO: true };
const response = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers });
const adif = '<call:6>N0CALL <qso_date:8>20260417 <time_on:6>120000 <mode:3>FT8 <freq:6>14.074 <eor>';
describe('Wavelog wire adapters', () => {
  it('uses v2 token scopes and maps stations without transmitting a legacy key', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ data: { scopes: ['station:read', 'qso:read', 'qso:write', 'confirmation:read'] } }));
    fetch.mockResolvedValueOnce(response({ data: { scopes: ['station:read', 'qso:read', 'qso:write', 'confirmation:read'] } }))
      .mockResolvedValueOnce(response({ data: [{ id: 1, name: 'Home', callsign: 'BG5DRB', gridsquare: 'PM01AA' }] }));
    const api = new WavelogProtocol(fetch, config);
    expect(await api.stations()).toEqual([{ station_id: '1', station_profile_name: 'Home', station_callsign: 'BG5DRB', station_gridsquare: 'PM01AA' }]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer wl2_secret' });
    expect(fetch.mock.calls[0]?.[0]).not.toContain('wl2_secret');
  });
  it('reports missing scopes and does not write a test QSO', async () => {
    const fetch = vi.fn(async () => response({ data: { scopes: ['station:read', 'qso:read'] } }));
    await expect(new WavelogProtocol(fetch, config).stations(['qso:write'])).rejects.toThrow('qso:write');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts a successful v2 batch with duplicates as a complete batch summary', async () => {
    const fetch = vi.fn(async () => response({ data: { parsed: 100, imported: 10, skipped: 90, messages: [] } }, 201));
    const result = await new WavelogProtocol(fetch, config).upload(adif, 100);
    expect(result).toMatchObject({ imported: 10, skipped: 90, complete: true }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { exported: 1, lastfetchedid: 0, adif },
    { exported: 2, lastfetchedid: 2, adif },
  ])('rejects incomplete pages without inventing identity fields', async data => {
    await expect(new WavelogProtocol(async () => response({ data }), config).download(0)).rejects.toThrow();
  });
  it('skips an invalid remote record so the cursor can advance', async () => {
    const bad = '<call:6>N0CALL <qso_date:8>20260417 <time_on:6>120000 <mode:3>FT8 <eor>';
    const page = await new WavelogProtocol(async () => response({ data: { exported: 2, lastfetchedid: 12, adif: adif + bad } }), config).download(0);
    expect(page.records).toHaveLength(1);
    expect(page.cursor).toBe(12);
    expect(page.invalid).toEqual([{ reason: 'ADIF record is missing identity fields', qsoCallsign: 'N0CALL' }]);
  });
  it('skips an invalid confirmation row instead of failing the page', async () => {
    const valid = { qso_id: 1, callsign: 'N0CALL', qso_date: '2026-04-17 12:00:00', mode: 'FT8', band: '20m', type: 'LoTW' };
    const invalid = { qso_id: 2, callsign: 'N0CALL', qso_date: 'not-a-date', mode: 'FT8', band: '20m', type: 'LoTW' };
    const page = await new WavelogProtocol(async () => response({ data: [valid, invalid], meta: { has_more: false } }), config).confirmations('2026-01-01', 1);
    expect(page.records).toHaveLength(1);
    expect(page.invalid).toHaveLength(1);
    expect(page.more).toBe(false);
  });
  it('does not retry writes, authentication errors or long rate-limit waits', async () => {
    for (const status of [401, 403, 429]) {
      const fetch = vi.fn(async () => response({ error: { message: `Rejected ${config.apiKey}` } }, status, { 'Retry-After': '60' }));
      await expect(new WavelogProtocol(fetch, config).upload(adif, 1)).rejects.not.toThrow(config.apiKey);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => response({ error: { message: 'Limited' } }, 429, { 'Retry-After': '60' }));
    await expect(new WavelogProtocol(fetch, config).download(0)).rejects.toMatchObject({ httpStatus: 429, nextAttemptAt: expect.any(Number) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
