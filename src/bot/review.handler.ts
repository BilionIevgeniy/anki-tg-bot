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
import { countTotal, type Counts, type Progress, QueueService } from '../srs/queue.service';
import { ReviewService } from '../srs/review.service';
import type { BotContext } from '../telegram/telegram.module';
import { type Callback, encode } from './callback-data';
import { frontKeyboard, GRADE_UI, gradeKeyboard } from './keyboards';
import { reply, safeEdit } from './telegram-utils';
import { countsLine } from './texts';

const SEP = '\n\n➖➖➖➖➖\n';

function header(
  deck: Deck,
  template: string,
  state: number,
  counts: Counts,
  progress?: Progress,
): string {
  const kind = state === 0 ? '🆕 новая' : state === 2 ? '🔁 повторение' : '📖 обучение';
  const label = TEMPLATE_LABEL[template as Template] ?? template;
  const done = progress ? `✓ ${progress.done}/${progress.total} · ` : '';
  return `<b>${escapeHtml(deck.name)}</b> · ${label} · ${kind}\n<i>${done}${countsLine(counts)}</i>\n\n`;
}

function leechText(note: Note): string {
  return `\n🩸 «${escapeHtml(noteTitle(note))}» никак не запоминается — отложил её. Попроси Claude переформулировать; вернуть: /leeches`;
}

export interface NextOptions {
  /** Shown as an "undo" button under the next card */
  undoLogId?: number;
  /** One line about the previous answer, shown above the next card */
  notice?: string;
  /** Edit the current message instead of sending a new one */
  edit?: boolean;
}

/**
 * Learning session in ONE message: the message is edited card after card, so the chat
 * does not fill up with history. Stateless — everything needed is in the callback data.
 */
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
        await this.sendNext(ctx, cb.scope, { edit: true });
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
      case 'more': {
        const added = await this.queue.addMoreNew(ctx.user, cb.scope, new Date());
        await ctx.answerCallbackQuery({
          text: added ? `➕ Ещё ${added} новых на сегодня` : 'Новых слов больше нет',
        });
        await this.sendNext(ctx, cb.scope, { edit: true });
        return true;
      }
      default:
        return false;
    }
  }

  async sendNext(ctx: BotContext, scope: number, opts: NextOptions = {}): Promise<void> {
    const show = (text: string, kb?: InlineKeyboard) =>
      opts.edit ? safeEdit(ctx, text, kb) : reply(ctx, text, kb);
    const notice = opts.notice ? `<i>${opts.notice}</i>\n\n` : '';
    const now = new Date();
    const next = await this.queue.next(ctx.user, scope, now);

    if (next.kind === 'card') {
      const text =
        notice +
        header(next.deck, next.card.template, next.card.state, next.counts, next.progress) +
        renderFront(next.note, next.card.template as Template);
      return show(clampMessage(text), frontKeyboard(next.card, scope, opts.undoLogId));
    }
    if (next.activeDecks === 0) {
      return show(
        scope
          ? '⏸ Эта колода на паузе или удалена. Сними паузу в /decks или учи всё: /learn'
          : 'Пока нет активных колод. Загрузи карточки через /import или сними колоду с паузы в /decks.',
      );
    }
    const lines = [
      `${notice}🎉 <b>На сейчас всё!</b>${next.progress.done ? ` Сегодня пройдено: ${next.progress.done}` : ''}`,
    ];
    if (next.nextLearningDue) {
      lines.push(
        `Карточка из обучения будет готова через ${formatInterval(now, next.nextLearningDue)} — нажми «Проверить ещё раз», когда время придёт.`,
      );
    } else {
      lines.push('На сегодня карточек больше нет. Завтра будут новые. Отдыхай 🙌');
    }
    const kb = new InlineKeyboard();
    if (opts.undoLogId) {
      kb.text('↩️ Отменить ответ', encode({ a: 'undo', logId: opts.undoLogId, scope })).row();
    }
    if (next.nextLearningDue) kb.text('🔄 Проверить ещё раз', encode({ a: 'learn', scope })).row();
    if (next.moreNew > 0) {
      lines.push('', `Новые слова на сегодня закончились (лимит). Ещё доступно: ${next.moreNew}.`);
      kb.text(`➕ Ещё ${Math.min(10, next.moreNew)} новых`, encode({ a: 'more', scope }));
    }
    return show(lines.join('\n'), kb);
  }

  private async countsAndProgress(ctx: BotContext, scope: number, now: Date) {
    const deckList = await this.queue.activeDecks(ctx.user.id, scope);
    const counts = await this.queue.totals(ctx.user, scope, now);
    return { counts, progress: await this.queue.progress(ctx.user, deckList, counts, now) };
  }

  private async load(ctx: BotContext, cardId: number, version: number) {
    const row = await this.review.getCard(ctx.user.id, cardId);
    const f = row?.note.fields as Partial<VocabDeFields> | undefined;
    const brokenArticle = row?.card.template === 'article' && !f?.article;
    if (!row || row.card.version !== version || row.card.suspended || brokenArticle) {
      // only a toast: the message may already show the next card (double tap)
      await ctx.answerCallbackQuery({ text: 'Эта карточка уже неактуальна — /learn' });
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
    const { counts, progress } = await this.countsAndProgress(ctx, scope, now);
    const tpl = row.card.template as Template;
    const previews = await this.review.preview(row.card, row.deck.desiredRetention, now);
    const text =
      header(row.deck, tpl, row.card.state, counts, progress) +
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
    const ui = GRADE_UI[grade]!;
    const when = formatInterval(now, res.due);
    await ctx.answerCallbackQuery({ text: `${ui.emoji} ${ui.name} → снова через ${when}` });
    const notice =
      `${escapeHtml(noteTitle(row.note))} · ${ui.emoji} ${ui.name} → ${when}` +
      (res.leech ? leechText(row.note) : '');
    await this.sendNext(ctx, scope, { undoLogId: res.logId, notice, edit: true });
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
    const word = `${f.article ?? ''} ${f.lemma}`;
    await ctx.answerCallbackQuery({
      text: correct ? `✅ Верно: ${word}` : `❌ Правильно: ${word} (ты выбрал ${picked ?? '?'})`,
      show_alert: !correct, // a wrong article deserves a second look
    });
    const notice =
      (correct
        ? `✅ ${escapeHtml(word)}`
        : `❌ ${escapeHtml(word)} — ты выбрал ${escapeHtml(picked ?? '?')}`) +
      ` → ${formatInterval(now, res.due)}` +
      (res.leech ? leechText(row.note) : '');
    await this.sendNext(ctx, scope, { undoLogId: res.logId, notice, edit: true });
  }

  private async undo(ctx: BotContext, logId: number, scope: number): Promise<void> {
    const res = await this.review.undo(ctx.user.id, logId);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: 'Отменить можно только самый последний ответ' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '↩️ Ответ отменён' });
    const row = await this.review.getCard(ctx.user.id, res.cardId);
    if (!row) return this.sendNext(ctx, scope, { edit: true });
    const { counts, progress } = await this.countsAndProgress(ctx, scope, new Date());
    const text =
      '<i>↩️ Ответ отменён — повторим эту карточку</i>\n\n' +
      header(row.deck, row.card.template, row.card.state, counts, progress) +
      renderFront(row.note, row.card.template as Template);
    await safeEdit(ctx, clampMessage(text), frontKeyboard(row.card, scope));
  }

  /** "Learn" buttons for /today */
  static todayKeyboard(
    perDeck: { deck: Deck; total: number }[],
    all: Counts,
    appUrl?: string,
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (appUrl) kb.webApp('📱 Открыть приложение', appUrl).row();
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
