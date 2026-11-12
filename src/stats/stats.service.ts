import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { cards, decks, reviewLogs, type User } from '../db/schema';
import { QueueService } from '../srs/queue.service';

export interface UserStats {
  reviewedToday: number;
  /** Study days with at least one answer among the last 7 (incl. today) */
  activeDaysLast7: number;
  /** Share of review answers that were not "Again", last 30 days (null = no data) */
  retention30d: number | null;
  /** Cards with interval ≥ 21 days ("in long-term memory") */
  mature: number;
  young: number;
  learning: number;
  fresh: number;
  leeches: number;
  total: number;
}

@Injectable()
export class StatsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
  ) {}

  async forUser(user: User, now: Date): Promise<UserStats> {
    const day = this.queue.dayOf(user, now);
    const weekStart = new Date(day.start.getTime() - 6 * 86_400_000);
    const monthStart = new Date(now.getTime() - 30 * 86_400_000);
    const localDay = sql`((${reviewLogs.reviewedAt} at time zone ${user.timezone}) - make_interval(hours => ${user.dayRolloverHour}))::date`;

    const [[cardAgg], [logAgg], [weekAgg]] = await Promise.all([
      this.db
        .select({
          mature:
            sql<number>`count(*) filter (where ${cards.state} = 2 and ${cards.scheduledDays} >= 21)`.mapWith(
              Number,
            ),
          young:
            sql<number>`count(*) filter (where ${cards.state} = 2 and ${cards.scheduledDays} < 21)`.mapWith(
              Number,
            ),
          learning: sql<number>`count(*) filter (where ${cards.state} in (1,3))`.mapWith(Number),
          fresh: sql<number>`count(*) filter (where ${cards.state} = 0)`.mapWith(Number),
          leeches: sql<number>`count(*) filter (where ${cards.isLeech})`.mapWith(Number),
          total: sql<number>`count(*)`.mapWith(Number),
        })
        .from(cards)
        .innerJoin(decks, eq(decks.id, cards.deckId))
        .where(
          and(eq(cards.userId, user.id), sql`${cards.template} = any(${decks.enabledTemplates})`),
        ),
      this.db
        .select({
          today:
            sql<number>`count(*) filter (where ${reviewLogs.reviewedAt} >= ${day.start})`.mapWith(
              Number,
            ),
          reviews30: sql<number>`count(*) filter (where ${reviewLogs.state} = 2)`.mapWith(Number),
          passed30:
            sql<number>`count(*) filter (where ${reviewLogs.state} = 2 and ${reviewLogs.rating} > 1)`.mapWith(
              Number,
            ),
        })
        .from(reviewLogs)
        .where(and(eq(reviewLogs.userId, user.id), gte(reviewLogs.reviewedAt, monthStart))),
      this.db
        .select({ days: sql<number>`count(distinct ${localDay})`.mapWith(Number) })
        .from(reviewLogs)
        .where(and(eq(reviewLogs.userId, user.id), gte(reviewLogs.reviewedAt, weekStart))),
    ]);

    return {
      reviewedToday: logAgg?.today ?? 0,
      activeDaysLast7: weekAgg?.days ?? 0,
      retention30d: logAgg && logAgg.reviews30 > 0 ? logAgg.passed30 / logAgg.reviews30 : null,
      mature: cardAgg?.mature ?? 0,
      young: cardAgg?.young ?? 0,
      learning: cardAgg?.learning ?? 0,
      fresh: cardAgg?.fresh ?? 0,
      leeches: cardAgg?.leeches ?? 0,
      total: cardAgg?.total ?? 0,
    };
  }
}
