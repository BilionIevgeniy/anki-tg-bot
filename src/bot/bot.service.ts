import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Bot, GrammyError, HttpError } from 'grammy';
import { ENV, type Env, telegramSecretToken } from '../config/env';
import { BOT, type BotContext } from '../telegram/telegram.module';
import { UsersService } from '../users/users.service';
import { decode } from './callback-data';
import { DecksHandler } from './decks.handler';
import { ImportHandler } from './import.handler';
import { ReviewHandler } from './review.handler';
import { reply } from './telegram-utils';
import { COMMANDS, HELP_TEXT, startText } from './texts';

export const WEBHOOK_PATH = '/telegram/webhook';

@Injectable()
export class BotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @Inject(ENV) private readonly env: Env,
    private readonly users: UsersService,
    private readonly review: ReviewHandler,
    private readonly decks: DecksHandler,
    private readonly importer: ImportHandler,
  ) {
    this.setup();
  }

  private setup(): void {
    const bot = this.bot;

    // 1) Load (or create) the user for every update; enforce the optional allowlist.
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      if (!from || from.is_bot) return;
      if (!this.users.isAllowed(from.id)) {
        if (ctx.message) await ctx.reply('🔒 Это приватный бот.');
        return;
      }
      ctx.user = await this.users.upsert(from);
      await next();
    });

    bot.command('start', (ctx) => reply(ctx, startText(ctx.user)));
    bot.command('help', (ctx) => reply(ctx, HELP_TEXT));
    bot.command('cancel', async (ctx) => {
      await this.users.setSession(ctx.user.id, {});
      await reply(ctx, 'Ок, отменил. Что дальше? /learn · /help');
    });

    this.review.register(bot);
    this.decks.register(bot);
    this.importer.register(bot);

    // 2) One router for all inline buttons
    bot.on('callback_query:data', async (ctx) => {
      const cb = decode(ctx.callbackQuery.data);
      if (cb) {
        for (const h of [this.review, this.decks, this.importer]) {
          if (await h.onCallback(ctx, cb)) return;
        }
      }
      await ctx.answerCallbackQuery({ text: 'Кнопка устарела' });
    });

    bot.on('message', (ctx) =>
      reply(ctx, 'Не понял 🤔 Нажми /learn, чтобы учить, или /help — там всё.'),
    );

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) this.logger.error(`Telegram error: ${e.description}`);
      else if (e instanceof HttpError) this.logger.error(`Network error: ${e.message}`);
      else this.logger.error('Handler error', e as Error);
      void err.ctx.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => undefined);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bot.init();
    await this.bot.api.setMyCommands([...COMMANDS]);
    if (this.env.BOT_MODE === 'webhook') {
      const url = `${this.env.PUBLIC_URL!.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      await this.bot.api.setWebhook(url, {
        secret_token: telegramSecretToken(this.env.WEBHOOK_SECRET!),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false, // never lose answers sent while the service was asleep
      });
      this.logger.log(`Webhook set: ${url}`);
    } else {
      await this.bot.api.deleteWebhook();
      void this.bot.start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (me) => this.logger.log(`Polling as @${me.username}`),
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.env.BOT_MODE === 'polling' && this.bot.isRunning()) await this.bot.stop();
  }

  get instance(): Bot<BotContext> {
    return this.bot;
  }
}
