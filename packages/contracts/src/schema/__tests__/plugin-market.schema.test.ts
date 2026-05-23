import { describe, expect, it } from 'vitest';
import {
  PluginMarketCatalogResponseSchema,
  PluginMarketCatalogSchema,
  PluginMarketChannelSchema,
  PluginManifestSchema,
  PluginPermissionSchema,
  PluginSourceSchema,
  PluginStatusSchema,
} from '../../index.js';

describe('plugin market schema', () => {
  it('accepts a valid stable catalog', () => {
    const catalog = PluginMarketCatalogSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-04-22T12:00:00.000Z',
      channel: 'stable',
      plugins: [
        {
          name: 'heartbeat-demo',
          title: 'Heartbeat Demo',
          description: 'Example timer and quick-action plugin.',
          readmeMarkdown: '# Heartbeat Demo\n\nExample timer and quick-action plugin.',
          readmeSourceUrl: 'https://github.com/boybook/tx-5dr-plugins/blob/main/heartbeat-demo/README.md',
          locales: {
            en: {
              pluginName: 'Heartbeat Demo',
              pluginDescription: 'Example timer and quick-action plugin.',
            },
            zh: {
              pluginName: '心跳演示',
              pluginDescription: '定时器与快捷操作演示插件。',
            },
          },
          latestVersion: '1.2.3',
          minHostVersion: '1.0.0',
          author: 'TX-5DR',
          license: 'GPL-3.0-only',
          repository: 'https://github.com/boybook/tx-5dr-plugins',
          homepage: 'https://tx5dr.example/plugins/heartbeat-demo',
          categories: ['demo'],
          keywords: ['timer', 'example'],
          permissions: [],
          screenshots: [
            {
              src: 'https://cdn.example.com/heartbeat-demo/cover.png',
              alt: 'Heartbeat Demo screenshot',
            },
          ],
          artifactUrl: 'https://cdn.example.com/plugins/heartbeat-demo-1.2.3.zip',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          size: 12345,
          publishedAt: '2026-04-22T12:00:00.000Z',
        },
      ],
    });

    expect(catalog.channel).toBe('stable');
    expect(catalog.plugins[0]?.name).toBe('heartbeat-demo');
    expect(catalog.plugins[0]?.readmeMarkdown).toContain('# Heartbeat Demo');
    expect(catalog.plugins[0]?.readmeSourceUrl).toContain('/heartbeat-demo/README.md');
  });

  it('rejects unsupported channels', () => {
    expect(() => PluginMarketChannelSchema.parse('beta')).toThrow();
  });

  it('accepts host settings permissions', () => {
    expect(PluginPermissionSchema.parse('host:hamlib')).toBe('host:hamlib');
    expect(PluginPermissionSchema.parse('operator:transmit-control')).toBe('operator:transmit-control');
    expect(PluginPermissionSchema.parse('settings:ft8')).toBe('settings:ft8');
    expect(PluginPermissionSchema.parse('settings:ntp')).toBe('settings:ntp');
    expect(() => PluginPermissionSchema.parse('operator:transmit')).toThrow();
  });

  it('accepts transmit-control permission and auto-call status in plugin snapshots', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'autocall-demo',
      version: '1.0.0',
      type: 'utility',
      permissions: ['operator:transmit-control'],
    });
    expect(manifest.permissions).toEqual(['operator:transmit-control']);

    const status = PluginStatusSchema.parse({
      name: 'autocall-demo',
      version: '1.0.0',
      type: 'utility',
      isBuiltIn: false,
      loaded: true,
      enabled: true,
      errorCount: 0,
      permissions: ['operator:transmit-control'],
      autoCallEnabledOperatorIds: ['operator-1'],
    });
    expect(status.autoCallEnabledOperatorIds).toEqual(['operator-1']);
  });

  it('accepts the route response envelope', () => {
    const response = PluginMarketCatalogResponseSchema.parse({
      sourceUrl: 'https://tx5dr.oss-cn-hangzhou.aliyuncs.com/tx-5dr/plugins/market/stable/index.json',
      catalog: {
        schemaVersion: 1,
        generatedAt: '2026-04-22T12:00:00.000Z',
        channel: 'stable',
        plugins: [],
      },
    });

    expect(response.catalog.plugins).toHaveLength(0);
  });

  it('accepts marketplace plugin source metadata', () => {
    const source = PluginSourceSchema.parse({
      kind: 'marketplace',
      version: '1.2.3',
      channel: 'nightly',
      artifactUrl: 'https://dl.tx5dr.com/plugins/market/nightly/heartbeat-demo.zip',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      installedAt: 1_777_000_000_000,
    });

    expect(source.kind).toBe('marketplace');
    expect(source.channel).toBe('nightly');
  });
});
