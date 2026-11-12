# anki-tg-bot — notes for Claude

Personal Telegram spaced-repetition bot (FSRS) of Женя. NestJS 11 + grammY + Drizzle ORM + PostgreSQL (Neon), hosted on Render free.

## When Женя asks for cards
Read `docs/CARD_RULES.md` and `docs/IMPORT_FORMAT.md` first. Output = one JSON file in contract v1 that he sends to the bot. Never invent `externalId`s that clash with existing ones; keep them stable.

## Code map
- `src/srs/` — FSRS wrapper (`fsrs.core.ts`, pure), study-day math (`day.ts`, pure), queue + review services (DB)
- `src/cards/templates.ts` — which cards a note produces + Telegram HTML rendering (pure)
- `src/import/` — zod contract + import/export service (idempotent upsert, never resets progress)
- `src/notifications/` — per-deck reminders; `schedule.ts` is the pure decision, `/jobs/tick` triggers it
- `src/bot/` — grammY handlers; one callback router in `bot.service.ts`; callback data in `callback-data.ts` (≤ 64 bytes)
- `src/db/schema.ts` — Drizzle schema; every table is scoped by `user_id` (multi-tenant)

## Rules
- No in-process timers (free Render instance sleeps). Everything periodic goes through `POST /jobs/tick`.
- Never set `drop_pending_updates: true`.
- Schema change → edit `src/db/schema.ts`, run `npm run db:generate`, commit the SQL in `drizzle/`.
- Before committing: `npm run lint && npm run typecheck && npm test` and the e2e suite with a Postgres (`TEST_DATABASE_URL=… npm run test:e2e`).
