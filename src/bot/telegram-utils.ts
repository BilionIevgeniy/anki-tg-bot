import { GrammyError, type InlineKeyboard } from 'grammy';
import type { BotContext } from '../telegram/telegram.module';

export const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/** Edit the message the button belongs to; ignore "message is not modified". */
export async function safeEdit(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
  } catch (e) {
    if (e instanceof GrammyError && /not modified/i.test(e.description)) return;
    throw e;
  }
}

export async function reply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await ctx.reply(text, { ...HTML, reply_markup: keyboard });
}

export function isBlockedError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 403;
}
