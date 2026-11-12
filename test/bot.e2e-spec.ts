/**
 * Full-app test: real Nest app + real Postgres, Telegram API replaced by an in-memory fake.
 * Simulates a user tapping through import → learn → grade → undo → settings → reminders.
 * Run: TEST_DATABASE_URL=postgresql://... npm run test:e2e
 */
import path from 'node:path';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Pool } from 'pg';
import { AppModule, JobsController } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import { cards } from '../src/db/schema';
import { NotificationsService } from '../src/notifications/notifications.service';
import { DeckSyncService } from '../src/sync/deck-sync.service';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BOT, type BotContext } from '../src/telegram/telegram.module';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

const USER = { id: 4242, is_bot: false, first_name: 'Женя', language_code: 'ru' };
const CHAT = { id: 4242, type: 'private' as const, first_name: 'Женя' };

const deckFile = {
  schemaVersion: 1,
  deck: { key: 'de-b2', name: 'Deutsch B2' },
  notes: [
    {
      externalId: 'de:geraet',
      type: 'vocab_de',
      fields: {
        lemma: 'Gerät',
        article: 'das',
        plural: 'die Geräte',
        pos: 'noun',
        translation: 'прибор',
        example: 'Das Gerät ist kaputt.',
        exampleTranslation: 'Прибор сломан.',
      },
    },
    {
      externalId: 'de:verzichten',
      type: 'vocab_de',
      fields: {
        lemma: 'verzichten',
        pos: 'verb',
        translation: 'отказываться',
        praeteritum: 'verzichtete',
        perfekt: 'hat verzichtet',
        rektion: 'auf + Akk.',
      },
    },
  ],
};

d('Bot (full app, fake Telegram)', () => {
  let app: INestApplication;
  let bot: Bot<BotContext>;
  const calls: ApiCall[] = [];
  let updateId = 1;
  let messageId = 100;

  const callsOf = (method: string) => calls.filter((c) => c.method === method);
  const last = (method: string) => callsOf(method).at(-1)!;
  const buttons = (call: ApiCall): string[] => {
    const markup = call.payload.reply_markup as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
  };
  const buttonLabels = (call: ApiCall): string[] => {
    const markup = call.payload.reply_markup as
      { inline_keyboard?: { text: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.text);
  };

  const send = (text: string) => {
    const isCmd = text.startsWith('/');
    const update: Update = {
      update_id: updateId++,
      message: {
        message_id: messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        text,
        ...(isCmd
          ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
          : {}),
      },
    };
    return bot.handleUpdate(update);
  };
  const press = (data: string, messageText = '') =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: USER,
        chat_instance: 'ci',
        data,
        message: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: CHAT,
          text: messageText,
        },
      },
    });
  const sendDocument = (fileName: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        document: {
          file_id: 'F1',
          file_unique_id: 'U1',
          file_name: fileName,
          mime_type: 'application/json',
          file_size: 900,
        },
      },
    });

  beforeAll(async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const raw = drizzle(pool);
    await raw.execute(sql`drop schema if exists drizzle cascade`);
    await raw.execute(sql`drop schema public cascade`);
    await raw.execute(sql`create schema public`);
    await migrate(raw, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
    await pool.end();

    Object.assign(process.env, {
      BOT_TOKEN: '123456:TEST_TOKEN_abcdefghijklmnop',
      BOT_MODE: 'webhook',
      PUBLIC_URL: 'https://example.test',
      WEBHOOK_SECRET: 'test+secret/1234567890==',
      DATABASE_URL: url,
      JOBS_SECRET: 'jobs-secret',
      ALLOWED_TELEGRAM_IDS: '',
      OWNER_TELEGRAM_ID: '5555',
      DECKS_DIR: 'no-such-dir-in-tests',
    });

    bot = new Bot<BotContext>(process.env.BOT_TOKEN!, { botInfo });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload });
      const p = payload as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'sendMessage' || method === 'sendDocument') {
        result = { message_id: messageId++, date: 0, chat: CHAT, text: p.text ?? '' };
      } else if (method === 'getFile') {
        result = { file_id: 'F1', file_unique_id: 'U1', file_path: 'documents/file.json' };
      }
      return Promise.resolve({ ok: true, result } as never);
    });

    jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(deckFile), { status: 200 })),
      );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BOT)
      .useValue(bot)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sets the webhook without dropping pending updates', () => {
    const wh = last('setWebhook');
    expect(wh.payload).toMatchObject({
      url: 'https://example.test/telegram/webhook',
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(callsOf('setMyCommands')).toHaveLength(1);
  });

  it('greets on /start', async () => {
    await send('/start');
    expect(String(last('sendMessage').payload.text)).toContain('Привет, Женя');
  });

  it('imports a JSON file after a dry-run confirmation', async () => {
    await sendDocument('deutsch.json');
    const preview = last('sendMessage');
    expect(String(preview.payload.text)).toContain('Проверка файла');
    expect(String(preview.payload.text)).toContain('Новых записей: 2 (карточек: 5)');
    expect(buttons(preview)).toEqual(['iy', 'in']);

    await press('iy');
    expect(String(last('editMessageText').payload.text)).toContain('Импорт завершён');
  });

  it('runs a learning session: show → grade → next with undo → undo', async () => {
    await send('/learn');
    const front = last('sendMessage');
    expect(String(front.payload.text)).toContain('<b>das Gerät</b>');
    expect(String(front.payload.text)).toContain('🆕 новая');
    const show = buttons(front).find((b) => b.startsWith('s:'))!;

    await press(show);
    const answer = last('editMessageText');
    expect(String(answer.payload.text)).toContain('прибор');
    expect(String(answer.payload.text)).toContain('Pl.: die Geräte');
    const labels = buttonLabels(answer);
    expect(labels[0]).toMatch(/^❌ Снова · 1м$/);
    const good = buttons(answer).find((b) => b.startsWith('r:') && b.split(':')[2] === '3')!;

    await press(good);
    expect(String(last('editMessageText').payload.text)).toMatch(/✅ Хорошо → снова через \d+м/);
    const next = last('sendMessage');
    // sibling cards of Gerät are buried → next word
    expect(String(next.payload.text)).toContain('<b>verzichten</b>');
    const undo = buttons(next).find((b) => b.startsWith('u:'))!;
    expect(undo).toBeDefined();

    // a second tap on the same grade button is harmless
    const before = callsOf('sendMessage').length;
    await press(good);
    expect(callsOf('sendMessage').length).toBe(before);

    await press(undo);
    expect(String(last('sendMessage').payload.text)).toContain('<b>das Gerät</b>');
  });

  it('auto-grades the article card (der/die/das buttons)', async () => {
    const db = app.get<Db>(DB);
    const [card] = await db.select().from(cards).where(eq(cards.template, 'article'));
    expect(card).toBeDefined();
    await press(`a:${card!.id}:2:${card!.version}:0`); // "die" — wrong
    const res = String(last('editMessageText').payload.text);
    expect(res).toContain('Ты выбрал <b>die</b>');
    expect(res).toContain('<b>das Gerät</b>');
    const after = (await db.select().from(cards).where(eq(cards.id, card!.id)))[0]!;
    expect(after.reps).toBe(1);
    expect(after.version).toBe(card!.version + 1);
  });

  it('shows today, decks and lets the user tune limits and reminders per deck', async () => {
    await send('/today');
    expect(String(last('sendMessage').payload.text)).toContain('Deutsch B2');

    await send('/decks');
    const deckBtn = buttons(last('sendMessage')).find((b) => b.startsWith('d:'))!;
    await press(deckBtn, '📚 Твои колоды');
    const menu = last('editMessageText');
    expect(String(menu.payload.text)).toContain('Новых в день: 15');
    const plus5 = buttons(menu).find((b) => b.startsWith('ds:') && b.endsWith(':0:5'))!;
    await press(plus5, '📚 Deutsch B2');
    expect(String(last('editMessageText').payload.text)).toContain('Новых в день: 20');

    await send('/notify');
    const nBtn = buttons(last('sendMessage')).find((b) => b.startsWith('n:'))!;
    await press(nBtn, '🔔 Напоминания');
    const deckId = Number(nBtn.split(':')[1]);
    await press(`ns:${deckId}:0:1`, '🔔 Напоминания · Deutsch B2'); // enable
    await press(`ns:${deckId}:2:${7 * 60}`, '🔔 Напоминания · Deutsch B2'); // 07:00
    await press(`ns:${deckId}:1:-60`, '🔔 Напоминания · Deutsch B2'); // → 06:00
    const nm = String(last('editMessageText').payload.text);
    expect(nm).toContain('✅ включены');
    expect(nm).toContain('<b>06:00</b>');
  });

  it('sends a reminder from the cron tick once per day, with snooze', async () => {
    const notifications = app.get(NotificationsService);
    // 23:00 Berlin — way after 06:00
    const evening = new Date();
    evening.setUTCHours(22, 0, 0, 0);
    const r1 = await notifications.tick(evening);
    expect(r1).toMatchObject({ checked: 1, sent: 1 });
    const msg = last('sendMessage');
    expect(String(msg.payload.text)).toContain('🔔 <b>Deutsch B2</b>');
    const snooze = buttons(msg).find((b) => b.startsWith('z:'))!;
    expect((await notifications.tick(evening)).sent).toBe(0); // only once per study day

    await press(snooze, String(msg.payload.text));
    expect(last('answerCallbackQuery').payload.text).toContain('3 часа');

    const jobs = app.get(JobsController);
    await expect(jobs.tick('wrong', undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(jobs.tick('jobs-secret', undefined)).resolves.toHaveProperty('checked');
  });

  it('handles stats, leeches, timezone, export and garbage', async () => {
    await send('/stats');
    expect(String(last('sendMessage').payload.text)).toContain('Статистика');
    await send('/leeches');
    expect(String(last('sendMessage').payload.text)).toContain('Пиявок нет');
    await send('/timezone Mars/Base');
    expect(String(last('sendMessage').payload.text)).toContain('Не знаю такой пояс');
    await send('/timezone Europe/Kyiv');
    expect(String(last('sendMessage').payload.text)).toContain('Europe/Kyiv');
    await send('/export');
    expect(last('sendDocument')).toBeDefined();
    await send('{"schemaVersion": 1, "deck": {}}');
    expect(String(last('sendMessage').payload.text)).toContain('не прошёл проверку');
    await send('привет');
    expect(String(last('sendMessage').payload.text)).toContain('Не понял');
    await press('garbage');
    expect(last('answerCallbackQuery').payload.text).toBe('Кнопка устарела');
  });

  it('imports decks from the repo folder on deploy and reports to the owner', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decks-'));
    mkdirSync(path.join(dir, 'de'));
    writeFileSync(path.join(dir, 'de', '0001-a.json'), JSON.stringify(deckFile));
    writeFileSync(path.join(dir, 'de', '0002-broken.json'), '{"schemaVersion": 1}');
    const sync = app.get(DeckSyncService);

    const first = await sync.syncFromDisk(dir);
    expect(first.map((r) => [r.file, r.ok])).toEqual([
      [path.join('de', '0001-a.json'), true],
      [path.join('de', '0002-broken.json'), false],
    ]);
    expect(first[0]!.report).toMatchObject({ created: 2, cardsCreated: 5 });
    const msg = last('sendMessage');
    expect(msg.payload.chat_id).toBe(5555);
    expect(String(msg.payload.text)).toContain('➕ 2 новых');
    expect(String(msg.payload.text)).toContain('0002-broken.json');

    // second deploy with the same files: nothing changes, nothing is re-imported
    writeFileSync(
      path.join(dir, 'de', '0002-broken.json'),
      JSON.stringify({
        ...deckFile,
        deck: { key: 'other', name: 'Other' },
        notes: [deckFile.notes[1]],
      }),
    );
    const before = callsOf('sendMessage').length;
    const second = await sync.syncFromDisk(dir);
    expect(second[0]!.report).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(second[1]!.report).toMatchObject({ created: 1 });
    expect(callsOf('sendMessage').length).toBe(before + 1);
  });
});
