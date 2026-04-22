import { describe, expect, it } from 'vitest';
import {
  formatPluginLogLine,
  mergePluginLogEntries,
  toPluginLogViewEntry,
  toPluginRuntimeLogViewEntry,
} from '../PluginLogPanel';

describe('PluginLogPanel logic helpers', () => {
  it('normalizes plugin and runtime websocket logs into one shared view model', () => {
    const pluginView = toPluginLogViewEntry({
      pluginName: 'hello-plugin',
      level: 'info',
      message: 'plugin log',
      data: { count: 1 },
      timestamp: 1713744000000,
    });
    const runtimeView = toPluginRuntimeLogViewEntry({
      source: 'system',
      stage: 'load',
      level: 'error',
      message: 'No entry file found',
      timestamp: 1713744001000,
      directoryName: 'broken-folder',
      details: { candidates: ['plugin.js'] },
    });

    expect(pluginView).toMatchObject({
      source: 'plugin',
      pluginName: 'hello-plugin',
      details: { count: 1 },
    });
    expect(runtimeView).toMatchObject({
      source: 'system',
      stage: 'load',
      directoryName: 'broken-folder',
      details: { candidates: ['plugin.js'] },
    });
  });

  it('formats unified log entries into plain text lines', () => {
    const systemLine = formatPluginLogLine({
      source: 'system',
      stage: 'load',
      directoryName: 'bad-folder',
      level: 'error',
      message: 'missing entry file',
      details: { candidates: ['plugin.js', 'plugin.mjs'] },
      timestamp: 1713744000000,
    });
    const pluginLine = formatPluginLogLine({
      source: 'plugin',
      pluginName: 'hello-plugin',
      level: 'info',
      message: 'plugin started',
      timestamp: 1713744001000,
    });

    expect(systemLine).toContain('[error]');
    expect(systemLine).toContain('[System/load]');
    expect(systemLine).toContain('[dir:bad-folder]');
    expect(systemLine).toContain('missing entry file');
    expect(systemLine).toContain('details={"candidates":["plugin.js","plugin.mjs"]}');

    expect(pluginLine).toContain('[info]');
    expect(pluginLine).toContain('[Plugin]');
    expect(pluginLine).toContain('[hello-plugin]');
    expect(pluginLine).toContain('plugin started');
    expect(pluginLine).not.toContain('details=');

    const scanLine = formatPluginLogLine({
      source: 'system',
      stage: 'scan',
      level: 'info',
      message: 'Scanning plugin directory',
      timestamp: 1713744002000,
      details: { pluginDir: '/tmp/plugins' },
    });
    expect(scanLine).toContain('[dir:/tmp/plugins]');
    expect(scanLine).not.toContain('[unknown]');
  });

  it('merges runtime history with realtime entries and deduplicates identical records', () => {
    const realtimeEntries = [
      {
        source: 'system' as const,
        stage: 'reload' as const,
        level: 'info' as const,
        message: 'Plugin reload completed: all plugins',
        timestamp: 1713744002000,
        details: { reason: 'all plugins' },
      },
    ];
    const historyEntries = [
      {
        source: 'system' as const,
        stage: 'scan' as const,
        level: 'info' as const,
        message: 'Scanning plugin directory',
        timestamp: 1713744000000,
      },
      {
        source: 'system' as const,
        stage: 'reload' as const,
        level: 'info' as const,
        message: 'Plugin reload completed: all plugins',
        timestamp: 1713744002000,
        details: { reason: 'all plugins' },
      },
    ];

    const merged = mergePluginLogEntries(realtimeEntries, historyEntries);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.message).toBe('Scanning plugin directory');
    expect(merged[1]?.message).toBe('Plugin reload completed: all plugins');
  });
});
