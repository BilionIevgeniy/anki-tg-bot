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

  /** Switch a card template (e.g. "de_ru") on or off for this deck. */
  async toggleTemplate(
    userId: number,
    deckId: number,
    template: string,
  ): Promise<Deck | undefined> {
    const deck = await this.get(userId, deckId);
    if (!deck) return undefined;
    const set = new Set(deck.enabledTemplates);
    if (set.has(template)) set.delete(template);
    else set.add(template);
    return this.update(userId, deckId, { enabledTemplates: [...set] });
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

  /**
   * Atomically claims today's reminder for a deck. Returns false if another tick already did,
   * so overlapping ticks never send the same reminder twice.
   */
  async claimReminder(deckId: number, dayKey: string): Promise<boolean> {
    const rows = await this.db
      .update(decks)
      .set({ notifyLastSentOn: dayKey, notifySnoozedUntil: null })
      .where(and(eq(decks.id, deckId), sql`${decks.notifyLastSentOn} is distinct from ${dayKey}`))
      .returning({ id: decks.id });
    return rows.length > 0;
  }

  /** Gives the claim back when sending failed, so the next tick can retry. */
  async releaseReminder(deckId: number, dayKey: string): Promise<void> {
    await this.db
      .update(decks)
      .set({ notifyLastSentOn: null })
      .where(and(eq(decks.id, deckId), eq(decks.notifyLastSentOn, dayKey)));
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
