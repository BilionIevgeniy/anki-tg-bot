import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { webhookCallback } from 'grammy';
import { BotService, WEBHOOK_PATH } from './bot/bot.service';
import { type Env, telegramSecretToken } from './config/env';
import { WEBAPP_PATH } from './webapp/webapp-url';

/**
 * HTTP setup shared by production (main.ts) and the e2e tests, so tests exercise exactly
 * what runs on Render. Create the app with { bodyParser: false } and call this before init.
 */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.enableShutdownHooks();
  // explicit JSON parser for the Mini App API (POST bodies)
  app.useBodyParser('json', { limit: '1mb' });

  if (env.BOT_MODE === 'webhook') {
    const bot = app.get(BotService).instance;
    app.use(
      WEBHOOK_PATH,
      express.json({ limit: '1mb' }),
      webhookCallback(bot, 'express', { secretToken: telegramSecretToken(env.WEBHOOK_SECRET!) }),
    );
  }

  // Telegram Mini App (built from webapp/ into webapp/dist)
  const webDist = path.resolve(process.cwd(), 'webapp', 'dist');
  if (existsSync(webDist)) {
    app.use(WEBAPP_PATH, express.static(webDist, { index: 'index.html', maxAge: '1h' }));
  }
}
