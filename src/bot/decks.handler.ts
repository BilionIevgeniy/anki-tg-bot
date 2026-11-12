import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { webAppUrl } from '../webapp/webapp-url';
import { type Bot, InlineKeyboard, InputFile } from 'grammy';
import { escapeHtml, noteTitle } from '../cards/templates';
import { DecksService } from '../decks/decks.service';
import { ImportService } from '../import/import.service';
import { formatHm, isValidTimezone } from '../srs/day';
import { countTotal, QueueService, sumCounts } from '../srs/queue.service';
import { ReviewService } from '../srs/review.service';
import { StatsService } from '../stats/stats.service';
import type { BotContext } from '../telegram/telegram.module';
import { UsersService } from '../users/users.service';
import { type Callback, encode } from './callback-data';
import { deckMenuKeyboard, notifyKeyboard } from './keyboards';
import { ReviewHandler } from './review.handler';
import { reply, safeEdit } from './telegram-utils';
import { countsLine, deckMenuText, notifyText, statsText } from './texts';

const SNOOZE_MS = 3 * 60 * 60 * 1000;

/** Decks, per-deck settings and reminders, stats, leeches, timezone, export. */
@Injectable()
export class DecksHandler {
  constructor(
    private readonly decks: DecksService,
    private readonly queue: QueueService,
    private readonly review: ReviewService,
    private readonly stats: StatsService,
    private readonly importer: ImportService,
    private readonly users: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  register(bot: Bot<BotContext>): void {
    bot.command('today', (ctx) => this.today(ctx));
    bot.command('decks', (ctx) => this.deckList(ctx, false));
    bot.command('notify', (ctx) => this.notifyList(ctx, false));
    bot.command('stats', async (ctx) =>
      reply(ctx, statsText(await this.stats.forUser(ctx.user, new Date()))),
    );
    bot.command('leeches', (ctx) => this.leeches(ctx));
    bot.command('export', (ctx) => this.exportAll(ctx));
    bot.command('timezone', (ctx) => this.timezone(ctx, ctx.match.trim()));
  }

  async onCallback(ctx: BotContext, cb: Callback): Promise<boolean> {
    const uid = ctx.user.id;
    switch (cb.a) {
      case 'decks':
        await ctx.answerCallbackQuery();
        await this.deckList(ctx, true);
        return true;
      case 'deck':
        await ctx.answerCallbackQuery();
        await this.deckMenu(ctx, cb.deckId);
        return true;
      case 'deckSet': {
        if (cb.field === 0) await this.decks.changeNewPerDay(uid, cb.deckId, cb.value);
        else if (cb.field === 1) await this.decks.togglePause(uid, cb.deckId);
        else await this.decks.toggleTemplate(uid, cb.deckId, 'de_ru');
        await ctx.answerCallbackQuery();
        await this.deckMenu(ctx, cb.deckId);
        return true;
      }
      case 'notifyList':
        await ctx.answerCallbackQuery();
        await this.notifyList(ctx, true);
        return true;
      case 'notify':
        await ctx.answerCallbackQuery();
        await this.notifyMenu(ctx, cb.deckId);
        return true;
      case 'nSet': {
        const fromReminder = !(await this.isNotifyMenuMessage(ctx));
        if (cb.field === 0)
          await this.decks.updateNotify(uid, cb.deckId, { notifyEnabled: cb.value === 1 });
        if (cb.field === 1) await this.decks.shiftNotifyTime(uid, cb.deckId, cb.value);
        if (cb.field === 2) {
          const v = Math.max(0, Math.min(1439, cb.value));
          await this.decks.updateNotify(uid, cb.deckId, {
            notifyHour: Math.floor(v / 60),
            notifyMinute: v % 60,
          });
        }
        if (cb.field === 3)
          await this.decks.updateNotify(uid, cb.deckId, { notifyMinDue: Math.max(1, cb.value) });
        if (fromReminder && cb.field === 0 && cb.value === 0) {
          await ctx.answerCallbackQuery({ text: '🔕 Напоминания для этой колоды выключены' });
          await ctx
            .editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
            .catch(() => undefined);
          return true;
        }
        await ctx.answerCallbackQuery();
        await this.notifyMenu(ctx, cb.deckId);
        return true;
      }
      case 'snooze': {
        const until = new Date(Date.now() + SNOOZE_MS);
        await this.decks.snooze(uid, cb.deckId, until);
        await ctx.answerCallbackQuery({ text: '💤 Напомню через 3 часа' });
        await ctx
          .editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
          .catch(() => undefined);
        return true;
      }
      case 'unleech': {
        const ok = await this.review.unleech(uid, cb.cardId);
        await ctx.answerCallbackQuery({
          text: ok ? '↩️ Карточка вернулась в повторение' : 'Уже возвращена',
        });
        await this.leeches(ctx, true);
        return true;
      }
      case 'export':
        await ctx.answerCallbackQuery({ text: '📤 Готовлю файл…' });
        await this.exportDeck(ctx, cb.deckId);
        return true;
      default:
        return false;
    }
  }

  /** The notify menu message contains "Напоминания ·" in its text; reminders do not. */
  private isNotifyMenuMessage(ctx: BotContext): Promise<boolean> {
    const text =
      ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text
        : '';
    return Promise.resolve((text ?? '').startsWith('🔔 Напоминания'));
  }

  private async today(ctx: BotContext): Promise<void> {
    const list = await this.decks.list(ctx.user.id);
    if (list.length === 0) return reply(ctx, 'Колод пока нет. Загрузи карточки: /import');
    const active = list.filter((d) => !d.isPaused);
    const per = await this.queue.deckCounts(ctx.user, active, new Date());
    const rows = active.map((deck) => ({ deck, counts: per.get(deck.id)! }));
    const all = sumCounts(rows.map((r) => r.counts));
    const lines = ['<b>📅 На сегодня</b>', ''];
    for (const r of rows)
      lines.push(`• <b>${escapeHtml(r.deck.name)}</b> — ${countsLine(r.counts)}`);
    for (const d of list.filter((x) => x.isPaused))
      lines.push(`• ${escapeHtml(d.name)} — ⏸ на паузе`);
    lines.push('', '<i>🆕 новые · 📖 в обучении · 🔁 повторения</i>');
    if (countTotal(all) === 0) lines.push('', '🎉 Всё сделано! Можно отдыхать.');
    await reply(
      ctx,
      lines.join('\n'),
      ReviewHandler.todayKeyboard(
        rows.map((r) => ({ deck: r.deck, total: countTotal(r.counts) })),
        all,
        webAppUrl(this.env),
      ),
    );
  }

  private async deckList(ctx: BotContext, edit: boolean): Promise<void> {
    const list = await this.decks.list(ctx.user.id);
    if (list.length === 0) {
      const text = 'Колод пока нет. Пришли файл с карточками: /import';
      return edit ? safeEdit(ctx, text) : reply(ctx, text);
    }
    const kb = new InlineKeyboard();
    list.forEach((d) =>
      kb.text(`${d.isPaused ? '⏸' : '📚'} ${d.name}`, encode({ a: 'deck', deckId: d.id })).row(),
    );
    const text = '<b>📚 Твои колоды</b>\nВыбери колоду, чтобы увидеть детали и настройки.';
    return edit ? safeEdit(ctx, text, kb) : reply(ctx, text, kb);
  }

  private async deckMenu(ctx: BotContext, deckId: number): Promise<void> {
    const deck = await this.decks.get(ctx.user.id, deckId);
    if (!deck) return safeEdit(ctx, 'Колода не найдена.');
    const c = (await this.queue.deckCounts(ctx.user, [deck], new Date())).get(deck.id)!;
    const due = deck.isPaused ? 0 : countTotal(c);
    await safeEdit(
      ctx,
      deckMenuText(deck, c, c.total, c.suspended, ctx.user.timezone),
      deckMenuKeyboard(deck, due),
    );
  }

  private async notifyList(ctx: BotContext, edit: boolean): Promise<void> {
    const list = await this.decks.list(ctx.user.id);
    if (list.length === 0) {
      const text = 'Сначала загрузи колоду: /import';
      return edit ? safeEdit(ctx, text) : reply(ctx, text);
    }
    const kb = new InlineKeyboard();
    list.forEach((d) =>
      kb
        .text(
          `${d.notifyEnabled ? `🔔 ${formatHm(d.notifyHour, d.notifyMinute)}` : '🔕'} · ${d.name}`,
          encode({ a: 'notify', deckId: d.id }),
        )
        .row(),
    );
    const text = [
      '<b>🔔 Напоминания</b>',
      `Свои для каждой колоды. Часовой пояс: <code>${escapeHtml(ctx.user.timezone)}</code> (/timezone)`,
      '',
      'Выбери колоду:',
    ].join('\n');
    return edit ? safeEdit(ctx, text, kb) : reply(ctx, text, kb);
  }

  private async notifyMenu(ctx: BotContext, deckId: number): Promise<void> {
    const deck = await this.decks.get(ctx.user.id, deckId);
    if (!deck) return safeEdit(ctx, 'Колода не найдена.');
    const text = notifyText(deck, ctx.user.timezone);
    // opened from a reminder message → send a fresh menu instead of overwriting the reminder
    if (
      !(await this.isNotifyMenuMessage(ctx)) &&
      ctx.callbackQuery?.message &&
      !this.isMenuMessage(ctx)
    ) {
      return reply(ctx, text, notifyKeyboard(deck));
    }
    await safeEdit(ctx, text, notifyKeyboard(deck));
  }

  /** Deck menu / lists are ours to edit; reminders are kept as they are. */
  private isMenuMessage(ctx: BotContext): boolean {
    const m = ctx.callbackQuery?.message;
    const text = m && 'text' in m ? (m.text ?? '') : '';
    return text.startsWith('📚') || text.startsWith('🔔 Напоминания');
  }

  private async leeches(ctx: BotContext, edit = false): Promise<void> {
    const rows = await this.review.leeches(ctx.user.id);
    if (rows.length === 0) {
      const text = '🩸 Пиявок нет. Все карточки запоминаются 💪';
      return edit ? safeEdit(ctx, text) : reply(ctx, text);
    }
    const kb = new InlineKeyboard();
    const lines = [
      '<b>🩸 Пиявки</b> — карточки, которые никак не запоминаются.',
      'Лучшее лекарство — переформулировать: перешли этот список Claude, он перепишет карточки, а ты сделаешь /import.',
      '',
    ];
    rows.forEach((r, i) => {
      lines.push(
        `${i + 1}. ${escapeHtml(noteTitle(r.note))} <i>(${escapeHtml(r.deckName)}, ошибок: ${r.card.lapses})</i>`,
      );
      kb.text(`↩️ Вернуть ${i + 1}`, encode({ a: 'unleech', cardId: r.card.id }));
      if (i % 4 === 3) kb.row();
    });
    return edit ? safeEdit(ctx, lines.join('\n'), kb) : reply(ctx, lines.join('\n'), kb);
  }

  private async timezone(ctx: BotContext, arg: string): Promise<void> {
    if (!arg) {
      return reply(
        ctx,
        `🌍 Твой часовой пояс: <code>${escapeHtml(ctx.user.timezone)}</code>\nНовый учебный день начинается в ${formatHm(ctx.user.dayRolloverHour, 0)}.\n\nСменить: <code>/timezone Europe/Berlin</code>`,
      );
    }
    if (!isValidTimezone(arg)) {
      return reply(
        ctx,
        '❌ Не знаю такой пояс. Нужен формат IANA, например <code>Europe/Berlin</code> или <code>Europe/Kyiv</code>.',
      );
    }
    await this.users.setTimezone(ctx.user.id, arg);
    await reply(ctx, `✅ Часовой пояс: <code>${escapeHtml(arg)}</code>`);
  }

  private async exportAll(ctx: BotContext): Promise<void> {
    const list = await this.decks.list(ctx.user.id);
    if (list.length === 0) return reply(ctx, 'Нечего экспортировать — колод пока нет.');
    for (const d of list) await this.exportDeck(ctx, d.id);
  }

  private async exportDeck(ctx: BotContext, deckId: number): Promise<void> {
    const file = await this.importer.exportDeck(ctx.user.id, deckId);
    if (!file) return reply(ctx, 'Колода не найдена.');
    const date = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(JSON.stringify(file, null, 2)), `${file.deck.key}-${date}.json`),
      {
        caption: `📤 ${file.deck.name}: ${file.notes.length} записей, с прогрессом. Этот файл можно импортировать обратно.`,
      },
    );
  }
}
