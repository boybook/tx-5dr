import { describe, expect, it } from 'vitest';
import {
  PluginArtifactManifestSchema,
  PluginMarketCatalogResponseSchema,
  PluginMarketIndexSchema,
  PluginMarketInstallRequestSchema,
  PluginMarketPluginSchema,
  PluginMarketVersionSchema,
  PluginManifestSchema,
  PluginPermissionSchema,
  PluginsConfigSchema,
  PluginSourceSchema,
  PluginStatusSchema,
} from '../../index.js';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function version(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.2.3',
    minPluginApiVersion: '2.5.0',
    artifactUrl: 'https://dl.tx5dr.com/plugins/market/artifacts/heartbeat-demo/1.2.3.zip',
    sha256: SHA,
    size: 12345,
    publishedAt: '2026-11-07T12:00:00.000Z',
    artifactManifestVersion: 1,
    ...overrides,
  };
}

function plugin(overrides: Record<string, unknown> = {}) {
  return {
    name: 'heartbeat-demo',
    title: 'Heartbeat Demo',
    description: 'Example timer and quick-action plugin.',
    readmeMarkdown: '# Heartbeat Demo',
    locales: { zh: { pluginName: '心跳演示' } },
    repository: 'https://github.com/boybook/tx-5dr-plugins',
    versions: [version(), version({ version: '1.0.0', minPluginApiVersion: '1.2.0' })],
    ...overrides,
  };
}

describe('plugin market schema', () => {
  it('accepts a channel-free v3 index with version history', () => {
    const index = PluginMarketIndexSchema.parse({
      schemaVersion: 3,
      generatedAt: '2026-11-07T12:00:00.000Z',
      plugins: [plugin()],
    });

    expect(index.plugins[0]?.versions).toHaveLength(2);
    expect(index.plugins[0]?.versions[0]).toMatchObject({ yanked: false, permissions: [] });
    expect('channel' in index).toBe(false);
  });

  it('rejects older index schemas', () => {
    expect(PluginMarketIndexSchema.safeParse({
      schemaVersion: 2,
      generatedAt: '2026-11-07T12:00:00.000Z',
      channel: 'nightly',
      plugins: [],
    }).success).toBe(false);
  });

  it('rejects duplicate plugins and duplicate versions', () => {
    expect(PluginMarketIndexSchema.safeParse({
      schemaVersion: 3,
      generatedAt: '2026-11-07T12:00:00.000Z',
      plugins: [plugin(), plugin()],
    }).success).toBe(false);
    expect(PluginMarketPluginSchema.safeParse(plugin({ versions: [version(), version()] })).success).toBe(false);
  });

  it('requires a static artifact manifest and a valid Plugin API floor per version', () => {
    expect(PluginMarketVersionSchema.safeParse(version({ artifactManifestVersion: undefined })).success).toBe(false);
    expect(PluginMarketVersionSchema.safeParse(version({ minPluginApiVersion: 'current' })).success).toBe(false);
    expect(PluginMarketVersionSchema.safeParse(version({ version: 'next' })).success).toBe(false);
  });

  it('accepts yanked versions with a reason', () => {
    expect(PluginMarketVersionSchema.parse(version({ yanked: true, yankedReason: 'broken upload' })))
      .toMatchObject({ yanked: true, yankedReason: 'broken upload' });
  });

  it('accepts the resolved route response envelope', () => {
    const response = PluginMarketCatalogResponseSchema.parse({
      sourceUrl: 'https://dl.tx5dr.com/plugins/market/index.json',
      generatedAt: '2026-11-07T12:00:00.000Z',
      pluginApiVersion: '2.6.0',
      plugins: [{
        ...plugin(),
        latest: version(),
        installable: null,
        availability: 'plugin-outdated',
        installed: { version: '1.0.0', compatible: false },
      }],
    });

    expect(response.plugins[0]?.availability).toBe('plugin-outdated');
    expect(response.plugins[0]?.installable).toBeNull();
  });

  it('accepts optional pinned install versions', () => {
    expect(PluginMarketInstallRequestSchema.parse({})).toEqual({});
    expect(PluginMarketInstallRequestSchema.parse({ version: '1.0.0' })).toEqual({ version: '1.0.0' });
    expect(PluginMarketInstallRequestSchema.safeParse({ version: 'latest' }).success).toBe(false);
  });

  it('validates a static artifact manifest', () => {
    expect(PluginArtifactManifestSchema.parse({
      schemaVersion: 1,
      name: 'heartbeat-demo',
      version: '1.0.0',
      minPluginApiVersion: '1.2.0',
      type: 'utility',
      permissions: [],
    })).toMatchObject({
      instanceScope: 'operator',
      minPluginApiVersion: '1.2.0',
    });
  });

  it('accepts host settings permissions', () => {
    expect(PluginPermissionSchema.parse('plugin:event-bus')).toBe('plugin:event-bus');
    expect(PluginPermissionSchema.parse('host:hamlib')).toBe('host:hamlib');
    expect(PluginPermissionSchema.parse('operator:transmit-control')).toBe('operator:transmit-control');
    expect(PluginPermissionSchema.parse('logbook:session')).toBe('logbook:session');
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
      capabilities: ['auto_call_control'],
      autoCallEnabledOperatorIds: ['operator-1'],
      pausedOperatorIds: ['operator-2'],
    });
    expect(status.autoCallEnabledOperatorIds).toEqual(['operator-1']);
    expect(status.pausedOperatorIds).toEqual(['operator-2']);
    expect(status.capabilities).toContain('auto_call_control');
  });

  it('accepts persisted operator plugin pause state with defaults', () => {
    const emptyConfig = PluginsConfigSchema.parse({});
    expect(emptyConfig.operatorPluginPauses).toEqual({});

    const config = PluginsConfigSchema.parse({
      operatorPluginPauses: {
        'operator-1': ['scheduled-cq-autocall'],
      },
    });
    expect(config.operatorPluginPauses['operator-1']).toEqual(['scheduled-cq-autocall']);
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

  it('accepts channel-free marketplace source metadata', () => {
    const source = PluginSourceSchema.parse({
      kind: 'marketplace',
      version: '1.2.3',
      artifactUrl: 'https://dl.tx5dr.com/plugins/market/artifacts/heartbeat-demo/1.2.3.zip',
      sha256: SHA,
      installedAt: 1_777_000_000_000,
    });

    expect(source.channel).toBeUndefined();
  });
});
