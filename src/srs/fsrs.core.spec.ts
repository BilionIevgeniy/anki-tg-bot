import {
  applyGrade,
  formatInterval,
  previewGrades,
  Rating,
  type SchedulingFields,
  State,
} from './fsrs.core';

const now = new Date('2026-11-12T10:00:00Z');

const newCard = (): SchedulingFields => ({
  state: State.New,
  due: now,
  stability: 0,
  difficulty: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  lastReview: null,
});

describe('fsrs core', () => {
  it('previews four increasing intervals for a new card', () => {
    const p = previewGrades(newCard(), now);
    expect(p.map((x) => x.grade)).toEqual([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
    const times = p.map((x) => x.due.getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(p[0]!.label).toBe('1м'); // default learning step
    expect(p[3]!.label).toMatch(/д$/); // Easy graduates straight to days
  });

  it('Good moves a new card into learning, then to review', () => {
    const first = applyGrade(newCard(), Rating.Good, now);
    expect(first.next.state).toBe(State.Learning);
    expect(first.next.reps).toBe(1);

    const later = new Date(first.next.due.getTime() + 1000);
    const second = applyGrade(first.next, Rating.Good, later);
    expect(second.next.state).toBe(State.Review);
    expect(second.scheduledDays).toBeGreaterThanOrEqual(1);
  });

  it('Again on a review card counts a lapse', () => {
    let card = applyGrade(newCard(), Rating.Easy, now).next;
    expect(card.state).toBe(State.Review);
    card = applyGrade(card, Rating.Again, card.due).next;
    expect(card.state).toBe(State.Relearning);
    expect(card.lapses).toBe(1);
  });

  it('"Again" is always 1 minute — for new, learning and review cards', () => {
    expect(previewGrades(newCard(), now)[0]!.label).toBe('1м');
    const learning = applyGrade(newCard(), Rating.Good, now).next;
    expect(previewGrades(learning, learning.due)[0]!.label).toBe('1м');
    const review = applyGrade(newCard(), Rating.Easy, now).next;
    expect(review.state).toBe(State.Review);
    const p = previewGrades(review, review.due);
    expect(p[0]!.label).toBe('1м');
    // after a lapse: 1m → Good → 10m check → Good → back to review (days)
    let card = applyGrade(review, Rating.Again, review.due).next;
    expect(card.state).toBe(State.Relearning);
    const step2 = applyGrade(card, Rating.Good, card.due);
    expect(Math.round((step2.next.due.getTime() - card.due.getTime()) / 60000)).toBe(10);
    card = applyGrade(step2.next, Rating.Good, step2.next.due).next;
    expect(card.state).toBe(State.Review);
  });

  it('the interval on a button equals the one applied when tapped (stable fuzz seed)', () => {
    let card = { ...applyGrade(newCard(), Rating.Easy, now).next, cardId: 42 };
    card = { ...applyGrade(card, Rating.Good, card.due).next, cardId: 42 }; // a mature-ish card
    const shownAt = card.due;
    const tappedAt = new Date(shownAt.getTime() + 3 * 60 * 1000); // thought about it for 3 minutes
    const previews = previewGrades(card, shownAt);
    for (const grade of [Rating.Hard, Rating.Good, Rating.Easy] as const) {
      const applied = applyGrade(card, grade, tappedAt).next.due;
      const shown = previews.find((p) => p.grade === grade)!.due;
      const days = (d: Date, from: Date) => Math.round((d.getTime() - from.getTime()) / 86_400_000);
      expect(days(applied, tappedAt)).toBe(days(shown, shownAt));
    }
  });

  it('formats intervals', () => {
    const at = (min: number) => new Date(now.getTime() + min * 60000);
    expect(formatInterval(now, at(0.5))).toBe('<1м');
    expect(formatInterval(now, at(10))).toBe('10м');
    expect(formatInterval(now, at(180))).toBe('3ч');
    expect(formatInterval(now, at(60 * 24 * 4))).toBe('4д');
    expect(formatInterval(now, at(60 * 24 * 61))).toBe('2мес');
    expect(formatInterval(now, at(60 * 24 * 550))).toBe('1.5г');
  });
});
