import { describe, expect, it } from 'vitest';

import type { ImageHistoryEntry } from '@tx5dr/contracts';

import { groupImageHistoryByDay } from './imageHistoryGrouping';

function entry(id: string, occurredAt: number): ImageHistoryEntry {
  return {
    record: {
      id, artifactId: id, family: 'sstv', direction: 'rx', occurredAt,
      saveReason: 'manual', complete: true, truncated: false,
    },
    artifact: {
      id, family: 'sstv', direction: 'rx', codecMode: 'robot36', pixelFormat: 'rgb8',
      width: 320, height: 240, frequency: 14_230_000, complete: true, truncated: false,
      pinned: false, contentHash: id, createdAt: occurredAt, imageUrl: `/image/${id}`,
    },
  };
}

describe('groupImageHistoryByDay', () => {
  it('keeps newest records and days first', () => {
    const firstDay = new Date(2026, 7, 20, 10).getTime();
    const secondDay = new Date(2026, 7, 21, 10).getTime();
    const groups = groupImageHistoryByDay([
      entry('older', firstDay),
      entry('newer', secondDay + 1_000),
      entry('same-day', secondDay),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.entries.map((item) => item.record.id)).toEqual(['newer', 'same-day']);
    expect(groups[1]?.entries.map((item) => item.record.id)).toEqual(['older']);
  });
});
