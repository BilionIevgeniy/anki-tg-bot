import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, min, notInArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import {
  type CardRow,
  cards,
  type Deck,
  decks,
  type Note,
  notes,
  reviewLogs,
  type User,
} from '../db/schema';
import { studyDayBounds, type StudyDayBounds } from './day';
import { State } from './fsrs.core';

/**
 * A note that already has a learning/review card due today (of an ENABLED template) will bury
 * its new sibling, so that new card is neither counted nor picked today.
 */
function siblingDueTodaySql(userId: number, dayEnd: Date) {
  return sql`${cards.noteId} not in (select c2.note_id from cards c2 join decks d2 on d2.id = c2.deck_id where c2.user_id = ${userId} and not c2.suspended and c2.state in (1,2,3) and c2.due < ${dayEnd} and c2.template = any(d2.enabled_templates))`;
}

/**
 * The der/die/das card is introduced only after the word itself (ru_de) has been learned,
 * and only if the note really has an article. (If ru_de is switched off or became a leech,
 * the article card is not introduced — acceptable for this personal bot.)
 */
const articleReady = sql`(${cards.template} <> 'article' or (exists (select 1 from notes n3 where n3.id = ${cards.noteId} and n3.fields->>'article' is not null) and exists (select 1 from cards c3 where c3.note_id = ${cards.noteId} and c3.template = 'ru_de' and c3.state = 2)))`;

/** Only templates switched on in the deck settings are studied (requires a join with decks). */
const templateEnabled = sql`${cards.template} = any(${decks.enabledTemplates})`;

/** Like Anki's "learn ahead limit": learning cards due within 20 min may be shown early. */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

export interface DeckCounts {
  deckId: number;
  /** (Re)learning cards due today */
  learning: number;
  /** Review cards due today, capped by the daily review limit */
  review: number;
  /** New cards still allowed today (limit and availability) */
  new: number;
  /** All cards in the deck (incl. suspended) and how many are suspended */
  total: number;
  suspended: number;
}

export interface Counts {
  learning: number;
  review: number;
  new: number;
}

export interface Progress {
  done: number;
  total: number;
}

export type NextResult =
  | {
      kind: 'card';
      card: CardRow;
      note: Note;
      deck: Deck;
      counts: Counts;
      progress: Progress;
      activeDecks: number;
    }
  | {
      kind: 'none';
      /** When the next learning card can be shown (its due minus the learn-ahead window) */
      nextLearningDue: Date | null;
      activeDecks: number;
      counts: Counts;
      progress: Progress;
    };

/** scope: 0 = all active decks of the user, otherwise a deck id */
export type Scope = number;

@Injectable()
export class QueueService {
  constructor(@Inject(DB) private readonly db: Db) {}

  dayOf(user: Pick<User, 'timezone' | 'dayRolloverHour'>, now: Date): StudyDayBounds {
    return studyDayBounds(now, user.timezone, user.dayRolloverHour);
  }

  async activeDecks(userId: number, scope: Scope): Promise<Deck[]> {
    return this.db
      .select()
      .from(decks)
      .where(
        and(
          eq(decks.userId, userId),
          eq(decks.isPaused, false),
          scope ? eq(decks.id, scope) : undefined,
        ),
      )
      .orderBy(asc(decks.id));
  }

  /** Per-deck counts for today, with daily limits applied. */
  async deckCounts(user: User, deckList: Deck[], now: Date): Promise<Map<number, DeckCounts>> {
    const result = new Map<number, DeckCounts>();
    if (deckList.length === 0) return result;
    const ids = deckList.map((d) => d.id);
    const day = this.dayOf(user, now);
    // a note that already has a learning/review card due today will bury its new sibling → count it once
    const noSiblingDueToday = siblingDueTodaySql(user.id, day.end);
    const notBuried = sql`${cards.noteId} not in (select ${reviewLogs.noteId} from ${reviewLogs} where ${reviewLogs.userId} = ${user.id} and ${reviewLogs.reviewedAt} >= ${day.start})`;

    const [cardRows, done] = await Promise.all([
      this.db
        .select({
          deckId: cards.deckId,
          learning:
            sql<number>`count(*) filter (where ${cards.state} in (1,3) and ${cards.due} < ${day.end} and not ${cards.suspended})`.mapWith(
              Number,
            ),
          // reviews and new cards: one per note (siblings are buried), minus notes seen today
          review:
            sql<number>`count(distinct ${cards.noteId}) filter (where ${cards.state} = 2 and ${cards.due} < ${day.end} and not ${cards.suspended} and ${notBuried})`.mapWith(
              Number,
            ),
          fresh:
            sql<number>`count(distinct ${cards.noteId}) filter (where ${cards.state} = 0 and not ${cards.suspended} and ${notBuried} and ${noSiblingDueToday} and ${articleReady})`.mapWith(
              Number,
            ),
          total: sql<number>`count(*)`.mapWith(Number),
          suspended: sql<number>`count(*) filter (where ${cards.suspended})`.mapWith(Number),
        })
        .from(cards)
        .innerJoin(decks, eq(decks.id, cards.deckId))
        .where(and(eq(cards.userId, user.id), inArray(cards.deckId, ids), templateEnabled))
        .groupBy(cards.deckId),
      this.doneToday(user.id, ids, day.start),
    ]);

    for (const deck of deckList) {
      const row = cardRows.find((r) => r.deckId === deck.id);
      const d = done.get(deck.id) ?? { newDone: 0, reviewDone: 0 };
      result.set(deck.id, {
        deckId: deck.id,
        learning: row?.learning ?? 0,
        review: Math.min(row?.review ?? 0, Math.max(0, deck.reviewsPerDay - d.reviewDone)),
        new: Math.min(row?.fresh ?? 0, Math.max(0, deck.newPerDay - d.newDone)),
        total: row?.total ?? 0,
        suspended: row?.suspended ?? 0,
      });
    }
    return result;
  }

  /**
   * Stable session progress, counted in CARDS (not answers):
   *   done  = cards answered today that are finished for today (not waiting in learning)
   *   total = done + cards still to do today
   * Pressing "Again" or a learning step does not change total; reopening the app does not either.
   */
  async progress(user: User, deckList: Deck[], remaining: Counts, now: Date): Promise<Progress> {
    const left = countTotal(remaining);
    if (deckList.length === 0) return { done: 0, total: left };
    const day = this.dayOf(user, now);
    const [row] = await this.db
      .select({
        done: sql<number>`count(distinct ${cards.id}) filter (where not (${cards.state} in (1,3) and ${cards.due} < ${day.end} and not ${cards.suspended}))`.mapWith(
          Number,
        ),
      })
      .from(reviewLogs)
      .innerJoin(cards, eq(cards.id, reviewLogs.cardId))
      .where(
        and(
          eq(reviewLogs.userId, user.id),
          inArray(
            reviewLogs.deckId,
            deckList.map((d) => d.id),
          ),
          gte(reviewLogs.reviewedAt, day.start),
        ),
      );
    const done = row?.done ?? 0;
    return { done, total: done + left };
  }

  async totals(user: User, scope: Scope, now: Date): Promise<Counts> {
    const list = await this.activeDecks(user.id, scope);
    const per = await this.deckCounts(user, list, now);
    return sumCounts([...per.values()]);
  }

  /** How many new / review answers were already given today, per deck. */
  async doneToday(
    userId: number,
    deckIds: number[],
    dayStart: Date,
  ): Promise<Map<number, { newDone: number; reviewDone: number }>> {
    if (deckIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        deckId: reviewLogs.deckId,
        newDone: sql<number>`count(*) filter (where ${reviewLogs.state} = 0)`.mapWith(Number),
        reviewDone: sql<number>`count(*) filter (where ${reviewLogs.state} = 2)`.mapWith(Number),
      })
      .from(reviewLogs)
      .where(
        and(
          eq(reviewLogs.userId, userId),
          inArray(reviewLogs.deckId, deckIds),
          gte(reviewLogs.reviewedAt, dayStart),
        ),
      )
      .groupBy(reviewLogs.deckId);
    return new Map(rows.map((r) => [r.deckId, { newDone: r.newDone, reviewDone: r.reviewDone }]));
  }

  /**
   * Picks the next card, Anki-style:
   * 1) learning cards that are due, 2) reviews due today, 3) new cards within the daily limit,
   * 4) learning cards due within 20 minutes. Siblings of notes already seen today are buried.
   */
  async next(user: User, scope: Scope, now: Date): Promise<NextResult> {
    const deckList = await this.activeDecks(user.id, scope);
    const empty = { learning: 0, review: 0, new: 0 };
    if (deckList.length === 0) {
      return {
        kind: 'none',
        nextLearningDue: null,
        activeDecks: 0,
        counts: empty,
        progress: { done: 0, total: 0 },
      };
    }

    const ids = deckList.map((d) => d.id);
    const day = this.dayOf(user, now);
    const per = await this.deckCounts(user, deckList, now);

    const buried = this.db
      .selectDistinct({ noteId: reviewLogs.noteId })
      .from(reviewLogs)
      .where(and(eq(reviewLogs.userId, user.id), gte(reviewLogs.reviewedAt, day.start)));

    const base = and(eq(cards.userId, user.id), eq(cards.suspended, false), templateEnabled);
    const learningStates = inArray(cards.state, [State.Learning, State.Relearning]);

    const pick = async (where: ReturnType<typeof and>, orderNew = false) => {
      const rows = await this.db
        .select({ card: cards, note: notes })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .innerJoin(decks, eq(decks.id, cards.deckId))
        .where(where)
        .orderBy(
          ...(orderNew
            ? // your own words first (FIFO), the old Noji backlog (tag "noji") after them
              [
                asc(sql`(${notes.tags} @> array['noji']::text[])`),
                asc(notes.createdAt),
                asc(notes.position),
                asc(cards.id),
              ]
            : [asc(cards.due), asc(cards.id)]),
        )
        .limit(1);
      return rows[0];
    };

    const reviewDecks = ids.filter((id) => (per.get(id)?.review ?? 0) > 0);
    const newDecks = ids.filter((id) => (per.get(id)?.new ?? 0) > 0);

    const found =
      (await pick(and(base, inArray(cards.deckId, ids), learningStates, lte(cards.due, now)))) ??
      (reviewDecks.length
        ? await pick(
            and(
              base,
              inArray(cards.deckId, reviewDecks),
              eq(cards.state, State.Review),
              lt(cards.due, day.end),
              notInArray(cards.noteId, buried),
            ),
          )
        : undefined) ??
      (newDecks.length
        ? await pick(
            and(
              base,
              inArray(cards.deckId, newDecks),
              eq(cards.state, State.New),
              notInArray(cards.noteId, buried),
              siblingDueTodaySql(user.id, day.end),
              articleReady,
            ),
            true,
          )
        : undefined) ??
      (await pick(
        and(
          base,
          inArray(cards.deckId, ids),
          learningStates,
          lte(cards.due, new Date(now.getTime() + LEARN_AHEAD_MS)),
        ),
      ));

    const counts = sumCounts([...per.values()]);
    const progress = await this.progress(user, deckList, counts, now);
    if (found) {
      const deck = deckList.find((d) => d.id === found.card.deckId)!;
      return {
        kind: 'card',
        card: found.card,
        note: found.note,
        deck,
        counts,
        progress,
        activeDecks: deckList.length,
      };
    }

    const [nextLearning] = await this.db
      .select({ due: min(cards.due) })
      .from(cards)
      .innerJoin(decks, eq(decks.id, cards.deckId))
      .where(and(base, inArray(cards.deckId, ids), learningStates));
    // learn-ahead: such a card becomes available 20 minutes before its due time
    const availableAt =
      nextLearning?.due && nextLearning.due < day.end // later than today = "tomorrow", no timer
        ? new Date(Math.max(now.getTime(), nextLearning.due.getTime() - LEARN_AHEAD_MS))
        : null;
    return {
      kind: 'none',
      nextLearningDue: availableAt,
      activeDecks: deckList.length,
      counts,
      progress,
    };
  }
}

export function sumCounts(list: Counts[]): Counts {
  return list.reduce<Counts>(
    (acc, c) => ({
      learning: acc.learning + c.learning,
      review: acc.review + c.review,
      new: acc.new + c.new,
    }),
    { learning: 0, review: 0, new: 0 },
  );
}

export function countTotal(c: Counts): number {
  return c.learning + c.review + c.new;
}
