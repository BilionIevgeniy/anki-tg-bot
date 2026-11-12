import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { type CardRow, cards, type CardSnapshot, decks, notes, reviewLogs } from '../db/schema';
import {
  applyGrade,
  type Grade,
  previewGrades,
  type GradePreview,
  type SchedulingFields,
  State,
} from './fsrs.core';

export type AnswerOutcome =
  | { ok: false; reason: 'not-found' | 'stale' }
  | {
      ok: true;
      card: CardRow;
      logId: number;
      /** When the card comes back */
      due: Date;
      /** The card just became a leech and was suspended */
      leech: boolean;
    };

export function snapshot(card: CardRow): CardSnapshot {
  return {
    state: card.state,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.lastReview ? card.lastReview.toISOString() : null,
    suspended: card.suspended,
    isLeech: card.isLeech,
  };
}

function scheduling(card: CardRow): SchedulingFields {
  return {
    state: card.state,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.lastReview,
  };
}

@Injectable()
export class ReviewService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async preview(card: CardRow, desiredRetention: number, now: Date): Promise<GradePreview[]> {
    return Promise.resolve(previewGrades(scheduling(card), now, desiredRetention));
  }

  async getCard(userId: number, cardId: number) {
    const [row] = await this.db
      .select({ card: cards, note: notes, deck: decks })
      .from(cards)
      .innerJoin(notes, eq(notes.id, cards.noteId))
      .innerJoin(decks, eq(decks.id, cards.deckId))
      .where(and(eq(cards.id, cardId), eq(cards.userId, userId)));
    return row;
  }

  /**
   * Applies an answer atomically. `expectedVersion` makes old buttons harmless:
   * tapping "Good" twice, or on a message from yesterday, is rejected as stale.
   */
  async answer(
    userId: number,
    cardId: number,
    grade: Grade,
    expectedVersion: number,
    now: Date,
  ): Promise<AnswerOutcome> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ card: cards, deck: decks })
        .from(cards)
        .innerJoin(decks, eq(decks.id, cards.deckId))
        .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
        .for('update', { of: cards });
      if (!row) return { ok: false, reason: 'not-found' } as const;
      const { card, deck } = row;
      if (card.version !== expectedVersion || card.suspended)
        return { ok: false, reason: 'stale' } as const;

      const { next, scheduledDays } = applyGrade(
        scheduling(card),
        grade,
        now,
        deck.desiredRetention,
      );
      const lapsedNow = next.lapses > card.lapses;
      const leech = lapsedNow && isLeechLapse(next.lapses, deck.leechThreshold);

      const [updated] = await tx
        .update(cards)
        .set({
          ...next,
          version: card.version + 1,
          ...(leech ? { suspended: true, isLeech: true } : {}),
        })
        .where(eq(cards.id, card.id))
        .returning();

      const [log] = await tx
        .insert(reviewLogs)
        .values({
          userId,
          deckId: card.deckId,
          noteId: card.noteId,
          cardId: card.id,
          rating: grade,
          state: card.state,
          scheduledDays,
          reviewedAt: now,
          prevCard: snapshot(card),
        })
        .returning({ id: reviewLogs.id });

      return { ok: true, card: updated!, logId: log!.id, due: next.due, leech } as const;
    });
  }

  /** Undo the user's most recent answer (only the latest one, like Anki's Ctrl+Z). */
  async undo(userId: number, logId: number): Promise<{ ok: true; cardId: number } | { ok: false }> {
    return this.db.transaction(async (tx) => {
      const [last] = await tx
        .select()
        .from(reviewLogs)
        .where(eq(reviewLogs.userId, userId))
        .orderBy(desc(reviewLogs.id))
        .limit(1)
        .for('update');
      if (!last || last.id !== logId) return { ok: false } as const;
      const s = last.prevCard;
      await tx
        .update(cards)
        .set({
          state: s.state,
          due: new Date(s.due),
          stability: s.stability,
          difficulty: s.difficulty,
          scheduledDays: s.scheduledDays,
          learningSteps: s.learningSteps,
          reps: s.reps,
          lapses: s.lapses,
          lastReview: s.lastReview ? new Date(s.lastReview) : null,
          suspended: s.suspended,
          isLeech: s.isLeech,
        })
        .where(and(eq(cards.id, last.cardId), eq(cards.userId, userId)));
      // bump version separately so stale buttons for this card become invalid
      const [c] = await tx
        .select({ version: cards.version })
        .from(cards)
        .where(eq(cards.id, last.cardId));
      await tx
        .update(cards)
        .set({ version: (c?.version ?? 0) + 1 })
        .where(eq(cards.id, last.cardId));
      await tx.delete(reviewLogs).where(eq(reviewLogs.id, last.id));
      return { ok: true, cardId: last.cardId } as const;
    });
  }

  async leeches(userId: number) {
    return this.db
      .select({ card: cards, note: notes, deckName: decks.name })
      .from(cards)
      .innerJoin(notes, eq(notes.id, cards.noteId))
      .innerJoin(decks, eq(decks.id, cards.deckId))
      .where(and(eq(cards.userId, userId), eq(cards.isLeech, true), eq(cards.suspended, true)))
      .orderBy(desc(cards.lapses))
      .limit(30);
  }

  /** Bring a leech back: unsuspend and give it a fresh start in relearning. */
  async unleech(userId: number, cardId: number): Promise<boolean> {
    const res = await this.db
      .update(cards)
      .set({ suspended: false, isLeech: false, due: new Date() })
      .where(and(eq(cards.id, cardId), eq(cards.userId, userId), eq(cards.isLeech, true)))
      .returning({ id: cards.id });
    return res.length > 0;
  }
}

/** Anki rule: a leech at `threshold` lapses, and again every half-threshold after that. */
export function isLeechLapse(lapses: number, threshold: number): boolean {
  if (threshold <= 0 || lapses < threshold) return false;
  return (lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}

export { State };
