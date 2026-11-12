import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { webhookCallback } from 'grammy';
import { AppModule } from './app.module';
import { BotService, WEBHOOK_PATH } from './bot/bot.service';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.enableShutdownHooks();

  if (env.BOT_MODE === 'webhook') {
    const bot = app.get(BotService).instance;
    app.use(
      WEBHOOK_PATH,
      express.json({ limit: '1mb' }),
      webhookCallback(bot, 'express', { secretToken: env.WEBHOOK_SECRET }),
    );
  }

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`🚀 anki-tg-bot on :${env.PORT} (${env.BOT_MODE})`, 'Bootstrap');
}

void bootstrap();
