const DAY_ALIASES: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

export interface ScheduleTime {
  hour: number;
  minute: number;
}

export function parseScheduleTime(value: unknown): ScheduleTime | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function dayTokenToIsoDay(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return null;
  if (/^[1-7]$/.test(normalized)) return Number(normalized);
  return DAY_ALIASES[normalized] ?? null;
}

export function parseScheduleDays(value: unknown): Set<number> | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw || raw === '*' || raw === 'daily' || raw === 'everyday' || raw === 'all') {
    return new Set([1, 2, 3, 4, 5, 6, 7]);
  }

  const days = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.split('-');
    if (range.length === 2) {
      const start = dayTokenToIsoDay(range[0] ?? '');
      const end = dayTokenToIsoDay(range[1] ?? '');
      if (!start || !end) return null;
      let current = start;
      for (let i = 0; i < 7; i += 1) {
        days.add(current);
        if (current === end) break;
        current = current === 7 ? 1 : current + 1;
      }
      continue;
    }

    const day = dayTokenToIsoDay(trimmed);
    if (!day) return null;
    days.add(day);
  }

  return days.size > 0 ? days : null;
}

export function getIsoDay(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

export function isScheduleDayActive(days: Set<number>, date: Date): boolean {
  return days.has(getIsoDay(date));
}

export function isSameScheduleMinute(date: Date, time: ScheduleTime): boolean {
  return date.getHours() === time.hour && date.getMinutes() === time.minute;
}

function toMinuteOfDay(time: ScheduleTime): number {
  return time.hour * 60 + time.minute;
}

export function isTimeInScheduleRange(date: Date, start: ScheduleTime, end: ScheduleTime): boolean {
  const current = date.getHours() * 60 + date.getMinutes();
  const startMinute = toMinuteOfDay(start);
  const endMinute = toMinuteOfDay(end);
  if (startMinute === endMinute) return current === startMinute;
  if (startMinute < endMinute) return current >= startMinute && current < endMinute;
  return current >= startMinute || current < endMinute;
}

export function normalizeFrequencyMhzToHz(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 1_000_000);
}
