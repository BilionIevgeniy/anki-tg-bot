import {
  minutesIntoStudyDay,
  reminderDecision,
  type ReminderSettings,
  shiftTime,
} from './schedule';

const user = { timezone: 'Europe/Berlin', dayRolloverHour: 4, botBlocked: false };
const deck = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
  notifyEnabled: true,
  isPaused: false,
  notifyHour: 9,
  notifyMinute: 30,
  notifyLastSentOn: null,
  notifySnoozedUntil: null,
  ...over,
});

// 2026-11-12 is winter time in Berlin (UTC+1)
const at = (hhmmLocal: string) => new Date(`2026-11-12T${hhmmLocal}:00+01:00`);

describe('reminderDecision', () => {
  it('waits until the configured local time', () => {
    expect(reminderDecision(deck(), user, at('09:20'))).toEqual({
      send: false,
      reason: 'too-early',
    });
    expect(reminderDecision(deck(), user, at('09:30'))).toEqual({
      send: true,
      dayKey: '2026-11-12',
    });
    expect(reminderDecision(deck(), user, at('22:00'))).toEqual({
      send: true,
      dayKey: '2026-11-12',
    });
  });

  it('sends at most once per study day', () => {
    const d = deck({ notifyLastSentOn: '2026-11-12' });
    expect(reminderDecision(d, user, at('12:00'))).toEqual({ send: false, reason: 'already-sent' });
    // after midnight but before rollover it is still the same study day
    expect(reminderDecision(d, user, new Date('2026-11-13T02:00:00+01:00'))).toEqual({
      send: false,
      reason: 'already-sent',
    });
  });

  it('respects snooze and fires once it expires', () => {
    const snoozed = deck({ notifySnoozedUntil: at('13:00') });
    expect(reminderDecision(snoozed, user, at('12:00')).send).toBe(false);
    expect(reminderDecision(snoozed, user, at('13:05')).send).toBe(true);
  });

  it('ignores a snooze left over from a previous day (no 04:00 reminder)', () => {
    const stale = deck({ notifySnoozedUntil: new Date('2026-11-11T23:00:00+01:00') });
    expect(reminderDecision(stale, user, at('05:00'))).toEqual({
      send: false,
      reason: 'too-early',
    });
    expect(reminderDecision(stale, user, at('09:30')).send).toBe(true);
  });

  it('skips disabled, paused and blocked', () => {
    expect(reminderDecision(deck({ notifyEnabled: false }), user, at('10:00')).send).toBe(false);
    expect(reminderDecision(deck({ isPaused: true }), user, at('10:00')).send).toBe(false);
    expect(reminderDecision(deck(), { ...user, botBlocked: true }, at('10:00')).send).toBe(false);
  });
});

describe('time helpers', () => {
  it('counts minutes from the rollover', () => {
    expect(minutesIntoStudyDay(4, 0, 4)).toBe(0);
    expect(minutesIntoStudyDay(3, 59, 4)).toBe(1439);
    expect(minutesIntoStudyDay(9, 30, 4)).toBe(330);
  });
  it('shifts time with wrap-around', () => {
    expect(shiftTime(23, 30, 60)).toEqual({ hour: 0, minute: 30 });
    expect(shiftTime(0, 0, -15)).toEqual({ hour: 23, minute: 45 });
  });
});
