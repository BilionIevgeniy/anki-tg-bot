/**
 * Study-day math in the user's timezone, without extra dependencies (Intl only).
 *
 * A "study day" starts at `rolloverHour` local time (Anki default: 4:00),
 * so reviewing at 01:30 still counts for the previous day.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timeZone: string): LocalParts & { second: number } {
  const map: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return {
    year: map.year ?? 0,
    month: map.month ?? 0,
    day: map.day ?? 0,
    hour: map.hour ?? 0,
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC at instant `date`, in ms (Berlin summer: +7_200_000). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `timeZone` (DST-safe). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass fixes the case where the offset differs at the corrected instant (DST edges).
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Calendar date (in tz) of the study day that contains `now`, e.g. "2026-11-12". */
export function studyDayKey(now: Date, timeZone: string, rolloverHour: number): string {
  const b = studyDayBounds(now, timeZone, rolloverHour);
  return b.key;
}

export interface StudyDayBounds {
  key: string;
  start: Date;
  end: Date;
}

export function studyDayBounds(now: Date, timeZone: string, rolloverHour: number): StudyDayBounds {
  const p = localParts(now, timeZone);
  // Calendar day of the study day: today, or yesterday if we are before the rollover hour.
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < rolloverHour) base.setUTCDate(base.getUTCDate() - 1);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1));

  return {
    key: `${y}-${pad(m)}-${pad(d)}`,
    start: zonedTimeToUtc(y, m, d, rolloverHour, 0, timeZone),
    end: zonedTimeToUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      rolloverHour,
      0,
      timeZone,
    ),
  };
}

/** "09:05" */
export function formatHm(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}
