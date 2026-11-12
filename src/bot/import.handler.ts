import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import { ENV, type Env } from '../config/env';
import { parseImport } from '../import/contract';
import { ImportService } from '../import/import.service';
import type { BotContext } from '../telegram/telegram.module';
import { UsersService } from '../users/users.service';
import type { Callback } from './callback-data';
import { importConfirmKeyboard } from './keyboards';
import { reply, safeEdit } from './telegram-utils';
import { IMPORT_HELP, importReportText } from './texts';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** /import: receive a JSON file (or pasted JSON), show a dry-run report, apply on confirmation. */
@Injectable()
export class ImportHandler {
  private readonly logger = new Logger(ImportHandler.name);

  constructor(
    private readonly importer: ImportService,
    private readonly users: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  register(bot: Bot<BotContext>): void {
    bot.command('import', async (ctx) => {
      await this.users.patchSession(ctx.user.id, { awaiting: 'import' });
      await reply(ctx, IMPORT_HELP);
    });

    bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc.file_name ?? '';
      if (!/\.json$/i.test(name) && doc.mime_type !== 'application/json') {
        return reply(
          ctx,
          'Я понимаю только файлы <code>.json</code> в формате импорта. Подробности: /import',
        );
      }
      if ((doc.file_size ?? 0) > MAX_FILE_BYTES)
        return reply(ctx, '❌ Файл больше 10 МБ — разбей его на части.');
      const file = await ctx.getFile();
      const res = await fetch(
        `https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${file.file_path}`,
      );
      if (!res.ok) return reply(ctx, '❌ Не получилось скачать файл, попробуй ещё раз.');
      await this.handleRaw(ctx, await res.text());
    });

    // pasted JSON: either after /import, or any message that looks like a contract
    bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return next();
      const looksLikeJson = text.startsWith('{');
      const session = await this.users.getSession(ctx.user.id);
      if (looksLikeJson) return this.handleRaw(ctx, text);
      if (session.awaiting === 'import') {
        // not JSON: leave import mode instead of answering "not JSON" forever
        await this.users.patchSession(ctx.user.id, { awaiting: undefined });
        return reply(
          ctx,
          'Это не похоже на JSON, импорт отменён. Пришли файл <code>.json</code> или снова /import.',
        );
      }
      return next();
    });
  }

  async onCallback(ctx: BotContext, cb: Callback): Promise<boolean> {
    if (cb.a === 'impNo') {
      await this.users.patchSession(ctx.user.id, { pendingImport: undefined, awaiting: undefined });
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      await safeEdit(ctx, '❌ Импорт отменён.');
      return true;
    }
    if (cb.a !== 'impOk') return false;

    const session = await this.users.getSession(ctx.user.id);
    const parsed = session.pendingImport ? parseImport(session.pendingImport) : undefined;
    if (!parsed?.data) {
      await ctx.answerCallbackQuery({ text: 'Нечего импортировать — пришли файл ещё раз' });
      return true;
    }
    await ctx.answerCallbackQuery({ text: '⏳ Импортирую…' });
    await safeEdit(ctx, '⏳ Импортирую…');
    try {
      const report = await this.importer.apply(ctx.user.id, parsed.data);
      await this.users.patchSession(ctx.user.id, { pendingImport: undefined, awaiting: undefined });
      await safeEdit(
        ctx,
        `${importReportText(report, false)}\n\nПоехали: /learn · напоминания: /notify`,
      );
    } catch (e) {
      this.logger.error('import failed', e as Error);
      await safeEdit(ctx, '❌ Импорт не удался, ничего не изменено. Попробуй ещё раз позже.');
    }
    return true;
  }

  private async handleRaw(ctx: BotContext, raw: string): Promise<void> {
    const parsed = parseImport(raw);
    if (!parsed.ok || !parsed.data) {
      return reply(
        ctx,
        [
          '<b>❌ Файл не прошёл проверку</b>',
          '',
          ...parsed.errors.map((e) => `• ${escape(e)}`),
          '',
          'Исправь и пришли снова.',
        ].join('\n'),
      );
    }
    const report = await this.importer.preview(ctx.user.id, parsed.data);
    await this.users.patchSession(ctx.user.id, { pendingImport: raw, awaiting: undefined });
    await reply(ctx, importReportText(report, true), importConfirmKeyboard());
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
