import { describe, expect, it } from 'vitest';
import type { PluginLogEntry } from '@tx5dr/contracts';
import {
  appendPluginLogEntry,
  filterPluginLogEntries,
} from '../pluginLogBuffer';

function createEntry(overrides: Partial<PluginLogEntry> = {}): PluginLogEntry {
  return {
    pluginName: 'standard-qso',
    level: 'info',
    message: 'test message',
    timestamp: 1,
    ...overrides,
  };
}

describe('pluginLogBuffer utils', () => {
  it('prepends new entries and keeps newest first', () => {
    const first = createEntry({ timestamp: 1, message: 'first' });
    const second = createEntry({ timestamp: 2, message: 'second' });

    const result = appendPluginLogEntry([first], second, 10);

    expect(result.map((entry) => entry.message)).toEqual(['second', 'first']);
  });

  it('trims the buffer to the configured limit', () => {
    const entries = [
      createEntry({ timestamp: 1, message: 'one' }),
      createEntry({ timestamp: 2, message: 'two' }),
    ];

    const result = appendPluginLogEntry(entries, createEntry({ timestamp: 3, message: 'three' }), 2);

    expect(result.map((entry) => entry.message)).toEqual(['three', 'one']);
  });

  it('filters by plugin name and level', () => {
    const entries = [
      createEntry({ pluginName: 'standard-qso', level: 'info', message: 'a' }),
      createEntry({ pluginName: 'heartbeat-demo', level: 'debug', message: 'b' }),
      createEntry({ pluginName: 'heartbeat-demo', level: 'error', message: 'c' }),
    ];

    expect(filterPluginLogEntries(entries, {
      pluginName: 'heartbeat-demo',
      level: 'all',
    }).map((entry) => entry.message)).toEqual(['b', 'c']);

    expect(filterPluginLogEntries(entries, {
      pluginName: 'heartbeat-demo',
      level: 'error',
    }).map((entry) => entry.message)).toEqual(['c']);
  });
});
