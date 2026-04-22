import { describe, expect, it } from 'vitest';
import {
  PluginRuntimeLogHistoryPayloadSchema,
  PluginRuntimeLogEntrySchema,
  WSMessageSchema,
  WSMessageType,
} from '../../index.js';

describe('plugin runtime log schema', () => {
  it('accepts a valid pluginRuntimeLog entry', () => {
    const entry = PluginRuntimeLogEntrySchema.parse({
      source: 'system',
      stage: 'load',
      level: 'error',
      message: 'No entry file found',
      timestamp: Date.now(),
      directoryName: 'broken-plugin',
      details: {
        candidates: ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs'],
      },
    });

    expect(entry.source).toBe('system');
    expect(entry.stage).toBe('load');
    expect(entry.directoryName).toBe('broken-plugin');
  });

  it('rejects unsupported runtime stage', () => {
    expect(() => PluginRuntimeLogEntrySchema.parse({
      source: 'system',
      stage: 'boot',
      level: 'info',
      message: 'invalid stage',
      timestamp: Date.now(),
    })).toThrow();
  });

  it('accepts websocket message envelope for pluginRuntimeLog', () => {
    const parsed = WSMessageSchema.parse({
      type: WSMessageType.PLUGIN_RUNTIME_LOG,
      timestamp: new Date().toISOString(),
      data: {
        source: 'system',
        stage: 'reload',
        level: 'info',
        message: 'Plugin reload started: all plugins',
        timestamp: Date.now(),
      },
    });

    expect(parsed.type).toBe(WSMessageType.PLUGIN_RUNTIME_LOG);
  });

  it('accepts runtime log history payload and websocket envelopes', () => {
    const payload = PluginRuntimeLogHistoryPayloadSchema.parse({
      entries: [
        {
          source: 'system',
          stage: 'scan',
          level: 'info',
          message: 'Scanning plugin directory',
          timestamp: Date.now() - 1000,
        },
        {
          source: 'system',
          stage: 'load',
          level: 'error',
          message: 'No entry file found',
          timestamp: Date.now(),
          directoryName: 'broken-plugin',
        },
      ],
    });
    expect(payload.entries).toHaveLength(2);

    const requestMessage = WSMessageSchema.parse({
      type: WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY,
      timestamp: new Date().toISOString(),
      data: { limit: 200 },
    });
    expect(requestMessage.type).toBe(WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY);

    const historyMessage = WSMessageSchema.parse({
      type: WSMessageType.PLUGIN_RUNTIME_LOG_HISTORY,
      timestamp: new Date().toISOString(),
      data: payload,
    });
    expect(historyMessage.type).toBe(WSMessageType.PLUGIN_RUNTIME_LOG_HISTORY);
  });
});
