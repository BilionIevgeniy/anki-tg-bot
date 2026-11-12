import { Global, Module } from '@nestjs/common';
import { Bot, type Context } from 'grammy';
import { ENV, type Env } from '../config/env';
import type { User } from '../db/schema';

/** grammY context enriched by our middleware with the DB user. */
export type BotContext = Context & { user: User };

export const BOT = Symbol('BOT');

/**
 * Owns the single grammY Bot instance so that both the update handlers (BotModule)
 * and background senders (notifications) can use the same Telegram API client.
 */
@Global()
@Module({
  providers: [
    {
      provide: BOT,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Bot<BotContext>(env.BOT_TOKEN, {
          client: env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : undefined,
        }),
    },
  ],
  exports: [BOT],
})
export class TelegramModule {}
