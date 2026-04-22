import { describe, expect, it } from 'vitest';
import {
  appendPluginLogEntry,
  type PluginLogViewEntry,
} from '../pluginLogBuffer';

function createEntry(overrides: Partial<PluginLogViewEntry> = {}): PluginLogViewEntry {
  return {
    source: 'plugin',
    pluginName: 'standard-qso',
    level: 'info',
    message: 'test message',
    timestamp: 1,
    ...overrides,
  };
}

describe('pluginLogBuffer utils', () => {
  it('appends new entries and keeps chronological order', () => {
    const first = createEntry({ timestamp: 1, message: 'first' });
    const second = createEntry({ timestamp: 2, message: 'second' });

    const result = appendPluginLogEntry([first], second, 10);

    expect(result.map((entry) => entry.message)).toEqual(['first', 'second']);
  });

  it('trims the buffer to the configured limit', () => {
    const entries = [
      createEntry({ timestamp: 1, message: 'one' }),
      createEntry({ timestamp: 2, message: 'two' }),
    ];

    const result = appendPluginLogEntry(entries, createEntry({ timestamp: 3, message: 'three' }), 2);

    expect(result.map((entry) => entry.message)).toEqual(['two', 'three']);
  });
});
