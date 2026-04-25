import { describe, expect, it } from 'vitest';
import type { ProcessSnapshot } from '@tx5dr/contracts';
import { getHealthLevel } from '../useServerHealth';

function createSnapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    timestamp: 1,
    uptimeSeconds: 10,
    memory: {
      heapUsed: 128 * 1024 * 1024,
      heapTotal: 256 * 1024 * 1024,
      rss: 300 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    },
    cpu: {
      user: 150,
      system: 30,
      total: 180,
      capacity: 800,
      normalizedTotal: 22.5,
    },
    eventLoop: {
      mean: 10,
      p50: 12,
      p99: 20,
    },
    ...overrides,
  };
}

describe('getHealthLevel', () => {
  it('keeps high CPU load calm when the event loop is responsive', () => {
    expect(getHealthLevel(createSnapshot({
      cpu: {
        user: 150,
        system: 30,
        total: 180,
        capacity: 800,
        normalizedTotal: 22.5,
      },
      eventLoop: {
        mean: 10,
        p50: 12,
        p99: 20,
      },
    }))).toBe('good');
  });

  it('warns when event loop p99 indicates slower response', () => {
    expect(getHealthLevel(createSnapshot({
      eventLoop: {
        mean: 20,
        p50: 25,
        p99: 75,
      },
    }))).toBe('warn');
  });

  it('becomes critical when event loop p99 indicates visible delay', () => {
    expect(getHealthLevel(createSnapshot({
      eventLoop: {
        mean: 40,
        p50: 60,
        p99: 130,
      },
    }))).toBe('critical');
  });
});
