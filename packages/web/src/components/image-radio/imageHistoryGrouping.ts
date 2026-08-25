import type { ImageHistoryEntry } from '@tx5dr/contracts';

export interface ImageHistoryDayGroup {
  dayStart: number;
  entries: ImageHistoryEntry[];
}

export function groupImageHistoryByDay(entries: ImageHistoryEntry[]): ImageHistoryDayGroup[] {
  const groups = new Map<number, ImageHistoryEntry[]>();
  for (const entry of entries) {
    const date = new Date(entry.record.occurredAt);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const group = groups.get(dayStart);
    if (group) group.push(entry);
    else groups.set(dayStart, [entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([dayStart, dayEntries]) => ({
      dayStart,
      entries: [...dayEntries].sort((a, b) => b.record.occurredAt - a.record.occurredAt || b.record.id.localeCompare(a.record.id)),
    }));
}
