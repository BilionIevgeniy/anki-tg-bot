import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app, env);

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`🚀 anki-tg-bot on :${env.PORT} (${env.BOT_MODE})`, 'Bootstrap');
}

void bootstrap();
