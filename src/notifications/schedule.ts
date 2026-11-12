/**
 * Pure decision: is it time to send a deck reminder right now?
 * The external cron calls /jobs/tick every 15 minutes (more often burns Neon CU-hours);
 * this function makes each tick idempotent.
 */
import { localParts, studyDayBounds } from '../srs/day';

export interface ReminderSettings {
  notifyEnabled: boolean;
  isPaused: boolean;
  notifyHour: number;
  notifyMinute: number;
  notifyLastSentOn: string | null;
  notifySnoozedUntil: Date | null;
}

export interface UserClock {
  timezone: string;
  dayRolloverHour: number;
  botBlocked: boolean;
}

export type ReminderDecision =
  | { send: false; reason: 'disabled' | 'blocked' | 'already-sent' | 'snoozed' | 'too-early' }
  | { send: true; dayKey: string };

export function reminderDecision(
  deck: ReminderSettings,
  user: UserClock,
  now: Date,
): ReminderDecision {
  if (!deck.notifyEnabled || deck.isPaused) return { send: false, reason: 'disabled' };
  if (user.botBlocked) return { send: false, reason: 'blocked' };

  const day = studyDayBounds(now, user.timezone, user.dayRolloverHour);
  if (deck.notifyLastSentOn === day.key) return { send: false, reason: 'already-sent' };

  const snooze = deck.notifySnoozedUntil;
  if (snooze && snooze.getTime() > now.getTime()) return { send: false, reason: 'snoozed' };
  // a snooze that ended today fires right away; one from an earlier day is ignored,
  // otherwise it would trigger a reminder at 04:00 the next morning
  if (snooze && snooze.getTime() >= day.start.getTime()) return { send: true, dayKey: day.key };

  const p = localParts(now, user.timezone);
  const nowMin = minutesIntoStudyDay(p.hour, p.minute, user.dayRolloverHour);
  const targetMin = minutesIntoStudyDay(deck.notifyHour, deck.notifyMinute, user.dayRolloverHour);
  if (nowMin < targetMin) return { send: false, reason: 'too-early' };
  return { send: true, dayKey: day.key };
}

/** Minutes since the study day started (e.g. rollover 4:00 → 04:00 = 0, 03:59 = 1439). */
export function minutesIntoStudyDay(hour: number, minute: number, rolloverHour: number): number {
  return (((hour - rolloverHour + 24) % 24) * 60 + minute) % 1440;
}

/** Shift a time-of-day by delta minutes, wrapping around midnight. */
export function shiftTime(
  hour: number,
  minute: number,
  deltaMin: number,
): { hour: number; minute: number } {
  const total = (((hour * 60 + minute + deltaMin) % 1440) + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}
