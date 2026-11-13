/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Multi-tenant from day one: every row belongs to a user and every query is scoped by userId.
 * There are no roles; `plan` is the hook for a future subscription.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const planEnum = pgEnum('plan', ['FREE', 'PRO']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  firstName: text('first_name'),
  languageCode: text('language_code'),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  /** Local hour when a new study day starts (Anki: "next day starts at"). */
  dayRolloverHour: integer('day_rollover_hour').notNull().default(4),
  plan: planEnum('plan').notNull().default('FREE'),
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  /** Set when Telegram answers 403 (user blocked the bot); cleared on /start. */
  botBlocked: boolean('bot_blocked').notNull().default(false),
  ...timestamps,
});

export const decks = pgTable(
  'decks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable slug used by imports, e.g. "de-b2". Unique per user. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isPaused: boolean('is_paused').notNull().default(false),
    newPerDay: integer('new_per_day').notNull().default(15),
    reviewsPerDay: integer('reviews_per_day').notNull().default(200),
    desiredRetention: doublePrecision('desired_retention').notNull().default(0.9),
    /** Card is suspended as a "leech" after this many lapses. */
    leechThreshold: integer('leech_threshold').notNull().default(8),
    /** "More new cards today": extra new-card allowance, valid only for the study day extraNewDay. */
    extraNew: integer('extra_new').notNull().default(0),
    extraNewDay: text('extra_new_day'),
    /** Which card templates of this deck are studied (cards of other templates stay dormant). */
    enabledTemplates: text('enabled_templates')
      .array()
      .notNull()
      .default(sql`'{ru_de,article,fwd,rev}'::text[]`),

    // Per-deck reminder, configured by the user via /notify
    notifyEnabled: boolean('notify_enabled').notNull().default(false),
    notifyHour: integer('notify_hour').notNull().default(9),
    notifyMinute: integer('notify_minute').notNull().default(0),
    /** Only remind when at least this many cards are waiting. */
    notifyMinDue: integer('notify_min_due').notNull().default(5),
    /** Study day (YYYY-MM-DD) of the last reminder sent. */
    notifyLastSentOn: text('notify_last_sent_on'),
    notifySnoozedUntil: timestamp('notify_snoozed_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('decks_user_key_uq').on(t.userId, t.key),
    index('decks_notify_idx').on(t.notifyEnabled),
  ],
);

/** A note is the content (a word, a question). One note produces one or more cards. */
export const notes = pgTable(
  'notes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deckId: integer('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    /** Stable id from the import file (e.g. "de:geraet"). Re-imports upsert by it. */
    externalId: text('external_id').notNull(),
    /** "vocab_de" | "basic" */
    type: text('type').notNull(),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contentHash: text('content_hash').notNull(),
    /** Order in which new cards are introduced. */
    position: integer('position').notNull().default(0),
    /**
     * Edited by the user in the Mini App: the deck sync (decks/ folder) no longer overwrites
     * this note's content — the user's version wins over the file.
     */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /**
     * Deleted by the user in the Mini App (soft delete): all its cards are suspended and the
     * deck sync never recreates or updates it. Kept so it can be restored manually.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('notes_deck_ext_uq').on(t.deckId, t.externalId)],
);

/** A card is one reviewable direction of a note, with its own FSRS memory state. */
export const cards = pgTable(
  'cards',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deckId: integer('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    noteId: integer('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** "de_ru" | "ru_de" | "article" | "fwd" | "rev" */
    template: text('template').notNull(),
    /** FSRS state: 0 New, 1 Learning, 2 Review, 3 Relearning */
    state: integer('state').notNull().default(0),
    due: timestamp('due', { withTimezone: true }).notNull().defaultNow(),
    stability: doublePrecision('stability').notNull().default(0),
    difficulty: doublePrecision('difficulty').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true }),
    suspended: boolean('suspended').notNull().default(false),
    isLeech: boolean('is_leech').notNull().default(false),
    /** Optimistic-lock counter: protects against double taps on stale buttons. */
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cards_note_template_uq').on(t.noteId, t.template),
    index('cards_user_due_idx').on(t.userId, t.suspended, t.due),
    index('cards_deck_state_due_idx').on(t.deckId, t.state, t.due),
  ],
);

export const reviewLogs = pgTable(
  'review_logs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deckId: integer('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    noteId: integer('note_id').notNull(),
    cardId: integer('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    /** 1 Again, 2 Hard, 3 Good, 4 Easy */
    rating: integer('rating').notNull(),
    /** State BEFORE the answer (0 = the card was new). */
    state: integer('state').notNull(),
    /** Resulting interval in days (0 for (re)learning steps). */
    scheduledDays: integer('scheduled_days').notNull().default(0),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms'),
    /** Card snapshot before the answer, used for undo. */
    prevCard: jsonb('prev_card').$type<CardSnapshot>().notNull(),
    source: text('source').notNull().default('bot'),
  },
  (t) => [
    index('review_logs_user_time_idx').on(t.userId, t.reviewedAt),
    index('review_logs_deck_time_idx').on(t.deckId, t.reviewedAt),
  ],
);

/** Small persistent conversation state (pending import, awaited input). Survives restarts. */
export const botSessions = pgTable('bot_sessions', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamps.updatedAt,
});

export interface CardSnapshot {
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: string | null;
  suspended: boolean;
  isLeech: boolean;
}

export type User = typeof users.$inferSelect;
export type Deck = typeof decks.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type ReviewLogRow = typeof reviewLogs.$inferSelect;
