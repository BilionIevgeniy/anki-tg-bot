import { isValidTimezone, studyDayBounds, zonedTimeToUtc } from './day';

const TZ = 'Europe/Berlin';

describe('day math', () => {
  it('converts Berlin wall time to UTC in winter and summer', () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(zonedTimeToUtc(2026, 7, 15, 9, 0, TZ).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('study day starts at the rollover hour', () => {
    const b = studyDayBounds(new Date('2026-11-12T13:00:00Z'), TZ, 4);
    expect(b.key).toBe('2026-11-12');
    expect(b.start.toISOString()).toBe('2026-11-12T03:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-11-13T03:00:00.000Z');
  });

  it('01:30 local still belongs to the previous study day', () => {
    // 01:30 Berlin on Nov 13 = 00:30Z
    const b = studyDayBounds(new Date('2026-11-13T00:30:00Z'), TZ, 4);
    expect(b.key).toBe('2026-11-12');
  });

  it('handles the DST switch day (23h long)', () => {
    // 2026-03-29: clocks jump from 02:00 to 03:00 in Berlin
    const b = studyDayBounds(new Date('2026-03-29T12:00:00Z'), TZ, 4);
    expect(b.start.toISOString()).toBe('2026-03-29T02:00:00.000Z'); // 04:00 CEST
    expect(b.end.toISOString()).toBe('2026-03-30T02:00:00.000Z');
    const prev = studyDayBounds(new Date('2026-03-28T12:00:00Z'), TZ, 4);
    expect(prev.start.toISOString()).toBe('2026-03-28T03:00:00.000Z'); // 04:00 CET
    expect(prev.end.getTime()).toBe(b.start.getTime());
  });

  it('validates timezones', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
