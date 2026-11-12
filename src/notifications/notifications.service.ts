import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { webAppUrl } from '../webapp/webapp-url';
import { reminderKeyboard } from '../bot/keyboards';
import { ENV, type Env } from '../config/env';
import { isBlockedError } from '../bot/telegram-utils';
import { escapeHtml } from '../cards/templates';
import { DB, type Db } from '../db/db.module';
import { decks, users } from '../db/schema';
import { DecksService } from '../decks/decks.service';
import { countTotal, QueueService } from '../srs/queue.service';
import { BOT, type BotContext } from '../telegram/telegram.module';
import { UsersService } from '../users/users.service';
import { reminderDecision } from './schedule';

export interface TickReport {
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly queue: QueueService,
    private readonly decksService: DecksService,
    private readonly users: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Called by the external cron (POST /jobs/tick). Safe to call as often as you like. */
  async tick(now = new Date()): Promise<TickReport> {
    const rows = await this.db
      .select({ deck: decks, user: users })
      .from(decks)
      .innerJoin(users, eq(users.id, decks.userId))
      .where(
        and(eq(decks.notifyEnabled, true), eq(decks.isPaused, false), eq(users.botBlocked, false)),
      );

    const report: TickReport = { checked: rows.length, sent: 0, skipped: 0, failed: 0 };
    for (const { deck, user } of rows) {
      const decision = reminderDecision(deck, user, now);
      if (!decision.send) {
        report.skipped++;
        continue;
      }
      const counts = (await this.queue.deckCounts(user, [deck], now)).get(deck.id)!;
      const total = countTotal(counts);
      if (total < deck.notifyMinDue) {
        report.skipped++; // re-checked on the next tick, cards may become due later today
        continue;
      }
      const text = [
        `🔔 <b>${escapeHtml(deck.name)}</b>: ждут ${total} ${plural(total)}`,
        `🆕 новых ${counts.new} · 📖 в обучении ${counts.learning} · 🔁 повторений ${counts.review}`,
        '',
        '<i>Даже 5 минут сегодня лучше, чем час завтра 😉</i>',
      ].join('\n');
      try {
        await this.bot.api.sendMessage(user.telegramId, text, {
          parse_mode: 'HTML',
          reply_markup: reminderKeyboard(deck, webAppUrl(this.env)),
        });
        await this.decksService.markNotified(deck.id, decision.dayKey);
        report.sent++;
      } catch (e) {
        report.failed++;
        if (isBlockedError(e)) await this.users.markBlocked(user.id);
        else this.logger.warn(`reminder for deck ${deck.id} failed: ${(e as Error).message}`);
      }
    }
    return report;
  }
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'карточка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'карточки';
  return 'карточек';
}
