/**
 * Integration test against a real PostgreSQL.
 * Run: TEST_DATABASE_URL=postgresql://... npm run test:e2e
 * The test database is wiped (all tables dropped) before the run.
 */
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { Env } from '../src/config/env';
import type { Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DecksService } from '../src/decks/decks.service';
import { parseImport } from '../src/import/contract';
import { ImportService } from '../src/import/import.service';
import { reminderDecision } from '../src/notifications/schedule';
import { Rating, State } from '../src/srs/fsrs.core';
import { QueueService } from '../src/srs/queue.service';
import { ReviewService } from '../src/srs/review.service';
import { StatsService } from '../src/stats/stats.service';
import { UsersService } from '../src/users/users.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const sample = (notes: unknown[], name = 'Deutsch B2') =>
  JSON.stringify({ schemaVersion: 1, deck: { key: 'de-b2', name }, notes });

const geraet = {
  externalId: 'de:geraet',
  type: 'vocab_de',
  fields: {
    lemma: 'Gerät',
    article: 'das',
    plural: 'die Geräte',
    pos: 'noun',
    translation: 'прибор',
  },
};
const schnell = {
  externalId: 'de:schnell',
  type: 'vocab_de',
  fields: { lemma: 'schnell', pos: 'adj', translation: 'быстрый' },
};
const migrated = {
  externalId: 'de:umgehend',
  type: 'vocab_de',
  fields: { lemma: 'umgehend', pos: 'adv', translation: 'незамедлительно' },
  srs: {
    de_ru: {
      state: 'review',
      due: '2026-12-01T08:00:00Z',
      stability: 30,
      difficulty: 5,
      reps: 6,
      lapses: 1,
      scheduledDays: 25,
      lastReview: '2026-11-06T08:00:00Z',
    },
  },
};

d('SRS flow (Postgres)', () => {
  let pool: Pool;
  let db: Db;
  let users: UsersService;
  let importer: ImportService;
  let queue: QueueService;
  let review: ReviewService;
  let decksSvc: DecksService;
  let stats: StatsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    const raw = drizzle(pool);
    await raw.execute(sql`drop schema if exists drizzle cascade`);
    await raw.execute(sql`drop schema public cascade`);
    await raw.execute(sql`create schema public`);
    await migrate(raw, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
    db = drizzle(pool, { schema });
    const env = { ALLOWED_TELEGRAM_IDS: [], DEFAULT_TIMEZONE: 'Europe/Berlin' } as unknown as Env;
    users = new UsersService(db, env);
    importer = new ImportService(db);
    queue = new QueueService(db);
    review = new ReviewService(db);
    decksSvc = new DecksService(db);
    stats = new StatsService(db, queue);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs import → review → undo → limits → export → re-import', async () => {
    const user = await users.upsert({ id: 111, first_name: 'Женя' });
    const other = await users.upsert({ id: 222 });
    const now = new Date('2026-11-12T09:00:00Z');

    // --- import (dry run, then apply)
    const file = parseImport(sample([geraet, schnell, migrated])).data!;
    const dry = await importer.preview(user.id, file);
    expect(dry).toMatchObject({ deckExists: false, created: 3, cardsCreated: 7, withProgress: 1 });
    expect(await decksSvc.list(user.id)).toHaveLength(0); // dry run wrote nothing

    const rep = await importer.apply(user.id, file);
    expect(rep).toMatchObject({ created: 3, cardsCreated: 7 });
    const [deck] = await decksSvc.list(user.id);
    expect(deck!.name).toBe('Deutsch B2');

    // tenant isolation
    expect((await queue.next(other, 0, now)).kind).toBe('none');

    // by default only RU→DE (+ article) is studied, like in Noji
    const byDefault = await queue.next(user, 0, now);
    if (byDefault.kind !== 'card') throw new Error('expected a card');
    expect(byDefault.card.template).toBe('ru_de');
    expect(byDefault.counts.new).toBe(4); // 3× ru_de + 1× article
    // switch DE→RU on for the rest of this test
    await decksSvc.toggleTemplate(user.id, deck!.id, 'de_ru');

    // --- first card: first new note in file order, de_ru template
    const first = await queue.next(user, 0, now);
    if (first.kind !== 'card') throw new Error('expected a card');
    expect(first.card.template).toBe('de_ru');
    expect((first.note.fields as { lemma: string }).lemma).toBe('Gerät');
    expect(first.counts.new).toBe(6); // migrated de_ru card is a review due in December

    const ans = await review.answer(user.id, first.card.id, Rating.Good, first.card.version, now);
    expect(ans.ok).toBe(true);
    // double tap on the same button is rejected
    expect(
      await review.answer(user.id, first.card.id, Rating.Good, first.card.version, now),
    ).toEqual({
      ok: false,
      reason: 'stale',
    });

    // --- siblings of Gerät are buried today → next is schnell
    const second = await queue.next(user, 0, new Date(now.getTime() + 1000));
    if (second.kind !== 'card') throw new Error('expected a card');
    expect((second.note.fields as { lemma: string }).lemma).toBe('schnell');

    // --- the learning card (Gerät, due in 10 min) comes back before new cards when due
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    const third = await queue.next(user, 0, later);
    if (third.kind !== 'card') throw new Error('expected a card');
    expect(third.card.id).toBe(first.card.id);
    expect(third.card.state).toBe(State.Learning);

    // --- undo restores the previous state
    const ans2 = await review.answer(
      user.id,
      third.card.id,
      Rating.Easy,
      third.card.version,
      later,
    );
    if (!ans2.ok) throw new Error('answer failed');
    expect(ans2.card.state).toBe(State.Review);
    expect((await review.undo(user.id, ans2.logId)).ok).toBe(true);
    const restored = await review.getCard(user.id, third.card.id);
    expect(restored!.card.state).toBe(State.Learning);
    expect(restored!.card.version).toBeGreaterThan(third.card.version); // old buttons are now stale
    expect((await review.undo(user.id, ans2.logId)).ok).toBe(false);

    // --- daily new limit
    await decksSvc.changeNewPerDay(user.id, deck!.id, -14); // 15 → 1, already used 1 today
    const totals = await queue.totals(user, deck!.id, later);
    expect(totals.new).toBe(0);
    await decksSvc.changeNewPerDay(user.id, deck!.id, -100);
    expect((await decksSvc.get(user.id, deck!.id))!.newPerDay).toBe(0); // clamped

    // --- migrated progress is kept
    const exported = await importer.exportDeck(user.id, deck!.id);
    const um = exported!.notes.find((n) => n.externalId === 'de:umgehend')!;
    expect((um.srs as Record<string, unknown> | undefined)?.de_ru).toMatchObject({
      state: 'review',
      stability: 30,
      lapses: 1,
    });

    // --- re-import with changed content: progress untouched, new template added
    const changedSchnell = {
      ...schnell,
      fields: { ...schnell.fields, translation: 'быстрый, скорый' },
    };
    const changedGeraet = { ...geraet, fields: { ...geraet.fields, example: 'Das Gerät läuft.' } };
    const rep2 = await importer.apply(
      user.id,
      parseImport(sample([changedGeraet, changedSchnell, migrated], 'Deutsch B2 ✨')).data!,
    );
    expect(rep2).toMatchObject({
      deckExists: true,
      created: 0,
      updated: 2,
      unchanged: 1,
      cardsCreated: 0,
    });
    const afterReimport = await review.getCard(user.id, first.card.id);
    expect(afterReimport!.card.state).toBe(State.Learning);
    expect((await decksSvc.get(user.id, deck!.id))!.name).toBe('Deutsch B2 ✨');

    // export → import round trip into another account keeps everything
    const roundTrip = await importer.apply(other.id, exported!);
    expect(roundTrip).toMatchObject({ created: 3, cardsCreated: 7, withProgress: 2 });

    // --- stats
    const s = await stats.forUser(user, later);
    expect(s).toMatchObject({ reviewedToday: 1, activeDaysLast7: 1, total: 7 });
  });

  it('suspends leeches and lets them come back', async () => {
    const user = await users.upsert({ id: 333 });
    await importer.apply(user.id, parseImport(sample([schnell])).data!);
    const [deck] = await decksSvc.list(user.id);
    let t = new Date('2026-11-12T09:00:00Z');

    // graduate the card, then fail it repeatedly
    const next = await queue.next(user, deck!.id, t);
    if (next.kind !== 'card') throw new Error('expected a card');
    const id = next.card.id;
    let res = await review.answer(user.id, id, Rating.Easy, next.card.version, t);
    let leechAt = -1;
    for (let i = 0; i < 40 && res.ok && !res.leech; i++) {
      t = new Date(res.due.getTime() + 1000);
      const card = (await review.getCard(user.id, id))!.card;
      // Again on review cards = lapse; Good to get back to review
      const grade = card.state === Number(State.Review) ? Rating.Again : Rating.Good;
      res = await review.answer(user.id, id, grade, card.version, t);
      if (res.ok && res.leech) leechAt = res.card.lapses;
    }
    expect(leechAt).toBe(8);
    expect(await review.leeches(user.id)).toHaveLength(1);
    expect(await review.unleech(user.id, id)).toBe(true);
    expect(await review.leeches(user.id)).toHaveLength(0);
  });

  it('per-deck reminder settings drive the decision', async () => {
    const user = await users.upsert({ id: 444 });
    await importer.apply(user.id, parseImport(sample([schnell])).data!);
    const [deck] = await decksSvc.list(user.id);
    let updated = await decksSvc.updateNotify(user.id, deck!.id, {
      notifyEnabled: true,
      notifyHour: 8,
      notifyMinute: 0,
    });
    updated = await decksSvc.shiftNotifyTime(user.id, deck!.id, -15);
    expect(updated).toMatchObject({ notifyHour: 7, notifyMinute: 45 });
    const now = new Date('2026-11-12T07:00:00Z'); // 08:00 Berlin
    const decision = reminderDecision(updated!, user, now);
    expect(decision).toEqual({ send: true, dayKey: '2026-11-12' });
    await decksSvc.markNotified(deck!.id, '2026-11-12');
    const afterSend = await decksSvc.get(user.id, deck!.id);
    expect(reminderDecision(afterSend!, user, now).send).toBe(false);
    const snoozed = await decksSvc.snooze(
      user.id,
      deck!.id,
      new Date(now.getTime() + 3 * 3600_000),
    );
    expect(reminderDecision(snoozed!, user, now).send).toBe(false);
    expect(reminderDecision(snoozed!, user, new Date(now.getTime() + 3 * 3600_000 + 1)).send).toBe(
      true,
    );
  });
});
