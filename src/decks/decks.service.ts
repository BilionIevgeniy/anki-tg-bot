import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { type Deck, decks } from '../db/schema';
import { shiftTime } from '../notifications/schedule';

export type NotifyPatch = Partial<
  Pick<Deck, 'notifyEnabled' | 'notifyHour' | 'notifyMinute' | 'notifyMinDue'>
>;

@Injectable()
export class DecksService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(userId: number): Promise<Deck[]> {
    return this.db.select().from(decks).where(eq(decks.userId, userId)).orderBy(asc(decks.id));
  }

  async get(userId: number, deckId: number): Promise<Deck | undefined> {
    const [d] = await this.db
      .select()
      .from(decks)
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId)));
    return d;
  }

  private async update(
    userId: number,
    deckId: number,
    set: Partial<Deck>,
  ): Promise<Deck | undefined> {
    const [d] = await this.db
      .update(decks)
      .set(set)
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
      .returning();
    return d;
  }

  async changeNewPerDay(userId: number, deckId: number, delta: number): Promise<Deck | undefined> {
    const [d] = await this.db
      .update(decks)
      .set({ newPerDay: sql`greatest(0, least(500, ${decks.newPerDay} + ${delta}))` })
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
      .returning();
    return d;
  }

  async togglePause(userId: number, deckId: number): Promise<Deck | undefined> {
    const [d] = await this.db
      .update(decks)
      .set({ isPaused: sql`not ${decks.isPaused}` })
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
      .returning();
    return d;
  }

  updateNotify(userId: number, deckId: number, patch: NotifyPatch): Promise<Deck | undefined> {
    const set: NotifyPatch & { notifyLastSentOn?: null } = { ...patch };
    // changing the time re-arms today's reminder
    if (patch.notifyHour !== undefined || patch.notifyMinute !== undefined || patch.notifyEnabled) {
      set.notifyLastSentOn = null;
    }
    return this.update(userId, deckId, set);
  }

  async shiftNotifyTime(
    userId: number,
    deckId: number,
    deltaMin: number,
  ): Promise<Deck | undefined> {
    const deck = await this.get(userId, deckId);
    if (!deck) return undefined;
    const t = shiftTime(deck.notifyHour, deck.notifyMinute, deltaMin);
    return this.updateNotify(userId, deckId, { notifyHour: t.hour, notifyMinute: t.minute });
  }

  async markNotified(deckId: number, dayKey: string): Promise<void> {
    await this.db
      .update(decks)
      .set({ notifyLastSentOn: dayKey, notifySnoozedUntil: null })
      .where(eq(decks.id, deckId));
  }

  snooze(userId: number, deckId: number, until: Date): Promise<Deck | undefined> {
    return this.update(userId, deckId, { notifySnoozedUntil: until, notifyLastSentOn: null });
  }
}
