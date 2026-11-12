import { Injectable } from '@nestjs/common';
import { type Bot, InlineKeyboard } from 'grammy';
import {
  clampMessage,
  escapeHtml,
  noteTitle,
  renderBack,
  renderFront,
  type Template,
  TEMPLATE_LABEL,
} from '../cards/templates';
import type { Deck, Note } from '../db/schema';
import { ARTICLES, type VocabDeFields } from '../import/contract';
import { formatInterval, isGrade, Rating } from '../srs/fsrs.core';
import { countTotal, type Counts, QueueService } from '../srs/queue.service';
import { ReviewService } from '../srs/review.service';
import type { BotContext } from '../telegram/telegram.module';
import { type Callback, encode } from './callback-data';
import { frontKeyboard, GRADE_UI, gradeKeyboard, learnButton } from './keyboards';
import { reply, safeEdit } from './telegram-utils';
import { countsLine } from './texts';

const SEP = '\n\n➖➖➖➖➖\n';

function header(deck: Deck, template: string, state: number, counts: Counts): string {
  const kind = state === 0 ? '🆕 новая' : state === 2 ? '🔁 повторение' : '📖 обучение';
  return `<b>${escapeHtml(deck.name)}</b> · ${TEMPLATE_LABEL[template as Template] ?? template} · ${kind}\n<i>${countsLine(counts)}</i>\n\n`;
}

/** Learning session: shows cards, reveals answers, applies grades. Stateless — everything is in callback data. */
@Injectable()
export class ReviewHandler {
  constructor(
    private readonly queue: QueueService,
    private readonly review: ReviewService,
  ) {}

  register(bot: Bot<BotContext>): void {
    bot.command('learn', (ctx) => this.sendNext(ctx, 0));
  }

  /** Returns true when the callback belongs to this handler. */
  async onCallback(ctx: BotContext, cb: Callback): Promise<boolean> {
    switch (cb.a) {
      case 'learn':
        await ctx.answerCallbackQuery();
        await this.sendNext(ctx, cb.scope);
        return true;
      case 'stop':
        await ctx.answerCallbackQuery({ text: 'Остановлено' });
        await safeEdit(ctx, '⏹ Остановлено. Продолжишь, когда удобно: /learn');
        return true;
      case 'show':
        await this.showAnswer(ctx, cb.cardId, cb.version, cb.scope);
        return true;
      case 'rate':
        if (isGrade(cb.rating)) await this.rate(ctx, cb.cardId, cb.rating, cb.version, cb.scope);
        else await ctx.answerCallbackQuery();
        return true;
      case 'art':
        await this.answerArticle(ctx, cb.cardId, cb.choice, cb.version, cb.scope);
        return true;
      case 'undo':
        await this.undo(ctx, cb.logId, cb.scope);
        return true;
      default:
        return false;
    }
  }

  async sendNext(ctx: BotContext, scope: number, undoLogId?: number): Promise<void> {
    const now = new Date();
    const next = await this.queue.next(ctx.user, scope, now);
    if (next.kind === 'card') {
      const text =
        header(next.deck, next.card.template, next.card.state, next.counts) +
        renderFront(next.note, next.card.template as Template);
      return reply(ctx, clampMessage(text), frontKeyboard(next.card, scope, undoLogId));
    }
    if (next.activeDecks === 0) {
      return reply(
        ctx,
        'Пока нет активных колод. Загрузи карточки через /import или сними колоду с паузы в /decks.',
      );
    }
    const lines = ['🎉 <b>На сейчас всё!</b>'];
    if (next.nextLearningDue) {
      lines.push(
        `Следующая карточка из обучения — через ${formatInterval(now, next.nextLearningDue)}.`,
      );
    } else {
      lines.push('На сегодня карточек больше нет. Завтра будут новые. Отдыхай 🙌');
    }
    const kb = undoLogId
      ? new InlineKeyboard()
          .text('↩️ Отменить ответ', encode({ a: 'undo', logId: undoLogId, scope }))
          .row()
      : new InlineKeyboard();
    if (next.nextLearningDue) kb.text('🔄 Проверить ещё раз', encode({ a: 'learn', scope }));
    return reply(ctx, lines.join('\n'), kb);
  }

  private async load(ctx: BotContext, cardId: number, version: number) {
    const row = await this.review.getCard(ctx.user.id, cardId);
    if (!row || row.card.version !== version || row.card.suspended) {
      await ctx.answerCallbackQuery({ text: 'Эта карточка уже неактуальна' });
      await safeEdit(ctx, '⌛ Устаревшая карточка.', learnButton('▶️ Продолжить', 0)).catch(
        () => undefined,
      );
      return null;
    }
    return row;
  }

  private async showAnswer(
    ctx: BotContext,
    cardId: number,
    version: number,
    scope: number,
  ): Promise<void> {
    const row = await this.load(ctx, cardId, version);
    if (!row) return;
    await ctx.answerCallbackQuery();
    const now = new Date();
    const counts = await this.queue.totals(ctx.user, scope, now);
    const tpl = row.card.template as Template;
    const previews = await this.review.preview(row.card, row.deck.desiredRetention, now);
    const text =
      header(row.deck, tpl, row.card.state, counts) +
      renderFront(row.note, tpl) +
      SEP +
      renderBack(row.note, tpl);
    await safeEdit(ctx, clampMessage(text), gradeKeyboard(row.card, previews, scope));
  }

  private async rate(
    ctx: BotContext,
    cardId: number,
    grade: 1 | 2 | 3 | 4,
    version: number,
    scope: number,
  ): Promise<void> {
    const row = await this.review.getCard(ctx.user.id, cardId);
    const now = new Date();
    const res = await this.review.answer(ctx.user.id, cardId, grade, version, now);
    if (!res.ok || !row) {
      await ctx.answerCallbackQuery({ text: 'Уже отвечено' });
      return;
    }
    await ctx.answerCallbackQuery();
    const tpl = row.card.template as Template;
    const ui = GRADE_UI[grade]!;
    const text =
      renderFront(row.note, tpl) +
      SEP +
      renderBack(row.note, tpl) +
      `\n\n${ui.emoji} ${ui.name} → снова через ${formatInterval(now, res.due)}` +
      (res.leech ? leechText(row.note) : '');
    await safeEdit(ctx, clampMessage(text));
    await this.sendNext(ctx, scope, res.logId);
  }

  private async answerArticle(
    ctx: BotContext,
    cardId: number,
    choice: number,
    version: number,
    scope: number,
  ): Promise<void> {
    const row = await this.load(ctx, cardId, version);
    if (!row) return;
    const f = row.note.fields as VocabDeFields;
    const picked = ARTICLES[choice - 1];
    const correct = picked === f.article;
    const now = new Date();
    const res = await this.review.answer(
      ctx.user.id,
      cardId,
      correct ? Rating.Good : Rating.Again,
      version,
      now,
    );
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: 'Уже отвечено' });
      return;
    }
    await ctx.answerCallbackQuery({
      text: correct ? '✅ Верно!' : `❌ Правильно: ${f.article ?? ''}`,
    });
    const verdict = correct
      ? '✅ <b>Верно!</b>'
      : `❌ Ты выбрал <b>${picked ?? '?'}</b>, правильно:`;
    const text =
      `${verdict}\n\n${renderBack(row.note, 'article')}` +
      `\n\n→ снова через ${formatInterval(now, res.due)}` +
      (res.leech ? leechText(row.note) : '');
    await safeEdit(ctx, clampMessage(text));
    await this.sendNext(ctx, scope, res.logId);
  }

  private async undo(ctx: BotContext, logId: number, scope: number): Promise<void> {
    const res = await this.review.undo(ctx.user.id, logId);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: 'Отменить можно только самый последний ответ' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '↩️ Ответ отменён' });
    await safeEdit(ctx, '↩️ Ответ отменён — повторим эту карточку.');
    const row = await this.review.getCard(ctx.user.id, res.cardId);
    if (!row) return this.sendNext(ctx, scope);
    const counts = await this.queue.totals(ctx.user, scope, new Date());
    const text =
      header(row.deck, row.card.template, row.card.state, counts) +
      renderFront(row.note, row.card.template as Template);
    await reply(ctx, clampMessage(text), frontKeyboard(row.card, scope));
  }

  /** "Learn" buttons for /today */
  static todayKeyboard(perDeck: { deck: Deck; total: number }[], all: Counts): InlineKeyboard {
    const kb = new InlineKeyboard();
    const total = countTotal(all);
    if (total > 0) kb.text(`▶️ Учить всё (${total})`, encode({ a: 'learn', scope: 0 })).row();
    perDeck
      .filter((d) => d.total > 0)
      .forEach((d) =>
        kb.text(`▶️ ${d.deck.name} (${d.total})`, encode({ a: 'learn', scope: d.deck.id })).row(),
      );
    return kb;
  }
}

function leechText(note: Note): string {
  return `\n\n🩸 <b>«${escapeHtml(noteTitle(note))}»</b> никак не запоминается, поэтому я её отложил. Перешли Claude, пусть переформулирует или разобьёт. Вернуть её можно в /leeches.`;
}
