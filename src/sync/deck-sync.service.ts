import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Bot } from 'grammy';
import { isBlockedError } from '../bot/telegram-utils';
import { escapeHtml } from '../cards/templates';
import { ENV, type Env } from '../config/env';
import { parseImport } from '../import/contract';
import { ImportService, type ImportReport } from '../import/import.service';
import { BOT, type BotContext } from '../telegram/telegram.module';
import { UsersService } from '../users/users.service';

export interface SyncFileResult {
  file: string;
  ok: boolean;
  errors?: string[];
  report?: ImportReport;
}

/** Recursively lists *.json files, sorted, so "0001-…", "0002-…" import in order. */
export function listDeckFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listDeckFiles(full));
    else if (name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * Git → bot: on every start (= every deploy) the files in `decks/` are imported into the
 * owner's account. Imports are idempotent and never touch learning progress, so running
 * this on each boot is safe. New/changed notes are reported to the owner in Telegram.
 */
@Injectable()
export class DeckSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeckSyncService.name);

  constructor(
    private readonly importer: ImportService,
    private readonly users: UsersService,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  ownerTelegramId(): number | undefined {
    return this.env.OWNER_TELEGRAM_ID ?? this.env.ALLOWED_TELEGRAM_IDS[0];
  }

  onApplicationBootstrap(): void {
    // do not block the HTTP server / health check
    setImmediate(() => {
      this.syncFromDisk().catch((e: unknown) => this.logger.error('deck sync failed', e as Error));
    });
  }

  async syncFromDisk(
    dir = path.resolve(process.cwd(), this.env.DECKS_DIR),
  ): Promise<SyncFileResult[]> {
    const ownerId = this.ownerTelegramId();
    const files = listDeckFiles(dir);
    if (!ownerId || files.length === 0) {
      if (files.length)
        this.logger.warn(
          'decks/ found but OWNER_TELEGRAM_ID / ALLOWED_TELEGRAM_IDS is empty — skipping',
        );
      return [];
    }
    const owner = await this.users.upsertById(ownerId);
    const results: SyncFileResult[] = [];
    for (const file of files) {
      const rel = path.relative(dir, file);
      const parsed = parseImport(readFileSync(file, 'utf8'));
      if (!parsed.ok || !parsed.data) {
        results.push({ file: rel, ok: false, errors: parsed.errors });
        this.logger.error(`deck file ${rel} is invalid: ${parsed.errors.join('; ')}`);
        continue;
      }
      const preview = await this.importer.preview(owner.id, parsed.data);
      const report =
        preview.created || preview.updated
          ? await this.importer.apply(owner.id, parsed.data)
          : preview;
      results.push({ file: rel, ok: true, report });
    }
    const changed = results.filter((r) => r.report && (r.report.created || r.report.updated));
    const failed = results.filter((r) => !r.ok);
    this.logger.log(
      `deck sync: ${files.length} files, ${changed.length} changed, ${failed.length} invalid`,
    );
    if (changed.length || failed.length) await this.notify(ownerId, changed, failed);
    return results;
  }

  private async notify(
    chatId: number,
    changed: SyncFileResult[],
    failed: SyncFileResult[],
  ): Promise<void> {
    const lines = ['<b>📥 Колоды обновлены из репозитория</b>', ''];
    for (const r of changed) {
      const rep = r.report!;
      const parts = [
        rep.created && `➕ ${rep.created} новых (${rep.cardsCreated} карт.)`,
        rep.updated && `✏️ ${rep.updated} обновлено`,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `• <b>${escapeHtml(rep.deckName)}</b> — ${parts}${rep.withProgress ? `, 🧠 с прогрессом: ${rep.withProgress}` : ''}`,
      );
    }
    for (const r of failed)
      lines.push(
        `• ❌ <code>${escapeHtml(r.file)}</code>: ${escapeHtml(r.errors?.[0] ?? 'ошибка')}`,
      );
    lines.push('', 'Учить: /learn');
    try {
      await this.bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
    } catch (e) {
      // the owner may not have pressed /start yet — that's fine, the cards are imported anyway
      if (!isBlockedError(e)) this.logger.warn(`sync notification failed: ${(e as Error).message}`);
    }
  }
}
