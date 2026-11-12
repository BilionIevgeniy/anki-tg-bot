/**
 * Thin, framework-free wrapper around ts-fsrs (FSRS-6).
 * Converts between our DB row shape and ts-fsrs Card, previews the 4 buttons and applies an answer.
 */
import {
  type Card as FsrsCard,
  fsrs,
  type FSRS,
  generatorParameters,
  type Grade,
  Rating,
  State,
} from 'ts-fsrs';

export { Rating, State };
export type { Grade };

export const GRADES: readonly Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

/** The scheduling part of a card row (DB-agnostic). */
export interface SchedulingFields {
  state: number;
  due: Date;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: Date | null;
}

export interface GradePreview {
  grade: Grade;
  due: Date;
  /** Short human label, e.g. "10м", "3д". */
  label: string;
}

const schedulers = new Map<number, FSRS>();

/** One scheduler per desired retention (decks can differ). Fuzz spreads reviews like Anki. */
export function getScheduler(desiredRetention = 0.9): FSRS {
  const key = Math.round(desiredRetention * 1000) / 1000;
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = fsrs(
      generatorParameters({
        request_retention: key,
        enable_fuzz: true,
        enable_short_term: true,
        maximum_interval: 36500,
      }),
    );
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

export function toFsrsCard(row: SchedulingFields): FsrsCard {
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: 0,
    scheduled_days: row.scheduledDays,
    learning_steps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.lastReview ?? undefined,
  };
}

export function fromFsrsCard(card: FsrsCard): SchedulingFields {
  return {
    state: card.state,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review ?? null,
  };
}

/** What each of the 4 buttons would do right now. */
export function previewGrades(
  row: SchedulingFields,
  now: Date,
  desiredRetention = 0.9,
): GradePreview[] {
  const preview = getScheduler(desiredRetention).repeat(toFsrsCard(row), now);
  return GRADES.map((grade) => {
    const due = preview[grade].card.due;
    return { grade, due, label: formatInterval(now, due) };
  });
}

export interface AnswerResult {
  next: SchedulingFields;
  /** Interval in whole days (0 while in (re)learning steps). */
  scheduledDays: number;
}

export function applyGrade(
  row: SchedulingFields,
  grade: Grade,
  now: Date,
  desiredRetention = 0.9,
): AnswerResult {
  const { card } = getScheduler(desiredRetention).next(toFsrsCard(row), now, grade);
  const next = fromFsrsCard(card);
  return { next, scheduledDays: next.scheduledDays };
}

/** "45с", "10м", "3ч", "4д", "2мес", "1.5г" */
export function formatInterval(from: Date, to: Date): string {
  const minutes = Math.max(0, (to.getTime() - from.getTime()) / 60000);
  if (minutes < 1) return '<1м';
  if (minutes < 60) return `${Math.round(minutes)}м`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}ч`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}д`;
  const months = days / 30.44;
  if (months < 12) return `${roundHalf(months)}мес`;
  return `${roundHalf(days / 365.25)}г`;
}

function roundHalf(n: number): string {
  const r = Math.round(n * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function isGrade(n: number): n is Grade {
  return n === 1 || n === 2 || n === 3 || n === 4;
}
