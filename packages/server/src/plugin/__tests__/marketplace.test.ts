import { describe, expect, it, vi } from 'vitest';
import {
  fetchPluginMarketCatalog,
  resolvePluginMarketBaseUrl,
  resolvePluginMarketCatalogUrl,
} from '../marketplace.js';

describe('plugin marketplace helpers', () => {
  it('resolves the default OSS-only base url', () => {
    expect(resolvePluginMarketBaseUrl({} as NodeJS.ProcessEnv)).toBe(
      'https://dl.tx5dr.com/plugins/market',
    );
  });

  it('builds the nightly catalog url from env override', () => {
    const url = resolvePluginMarketCatalogUrl('nightly', {
      TX5DR_PLUGIN_MARKET_BASE_URL: 'cdn.example.com/custom-market/',
    });

    expect(url).toBe('https://cdn.example.com/custom-market/nightly/index.json');
  });

  it('fetches and validates the stable catalog', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-04-22T12:00:00.000Z',
      channel: 'stable',
      plugins: [
        {
          name: 'heartbeat-demo',
          title: 'Heartbeat Demo',
          description: 'Example timer and quick-action plugin.',
          latestVersion: '1.2.3',
          minHostVersion: '1.0.0',
          artifactUrl: 'https://cdn.example.com/plugins/heartbeat-demo-1.2.3.zip',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          size: 12345,
          publishedAt: '2026-04-22T12:00:00.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await fetchPluginMarketCatalog('stable', {
      fetchImpl,
      env: {
        TX5DR_PLUGIN_MARKET_BASE_URL: 'https://cdn.example.com/market',
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.com/market/stable/index.json',
      expect.objectContaining({
        headers: expect.objectContaining({ accept: 'application/json' }),
      }),
    );
    expect(result.catalog.plugins[0]?.name).toBe('heartbeat-demo');
  });

  it('rejects channel mismatch responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-04-22T12:00:00.000Z',
      channel: 'nightly',
      plugins: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchPluginMarketCatalog('stable', { fetchImpl })).rejects.toThrow(
      'Marketplace catalog channel mismatch',
    );
  });
});
