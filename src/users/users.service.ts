import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ENV, type Env } from '../config/env';
import { DB, type Db } from '../db/db.module';
import { botSessions, type User, users } from '../db/schema';

export interface TelegramProfile {
  id: number;
  first_name?: string;
  language_code?: string;
}

/** Shape of the small persistent per-user session. */
export interface SessionData {
  /** Validated import waiting for confirmation (stored as raw JSON text). */
  pendingImport?: string;
  /** What free text the bot is waiting for. */
  awaiting?: 'import' | 'timezone';
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  isAllowed(telegramId: number): boolean {
    return (
      this.env.ALLOWED_TELEGRAM_IDS.length === 0 ||
      this.env.ALLOWED_TELEGRAM_IDS.includes(telegramId)
    );
  }

  /** Creates the user on first contact; any message also proves the bot is not blocked. */
  async upsert(profile: TelegramProfile): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        telegramId: profile.id,
        firstName: profile.first_name ?? null,
        languageCode: profile.language_code ?? null,
        timezone: this.env.DEFAULT_TIMEZONE,
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: {
          firstName: profile.first_name ?? null,
          languageCode: profile.language_code ?? null,
          botBlocked: false,
        },
      })
      .returning();
    return row!;
  }

  async setTimezone(userId: number, timezone: string): Promise<void> {
    await this.db.update(users).set({ timezone }).where(eq(users.id, userId));
  }

  async markBlocked(userId: number): Promise<void> {
    await this.db.update(users).set({ botBlocked: true }).where(eq(users.id, userId));
  }

  async getSession(userId: number): Promise<SessionData> {
    const row = await this.db.query.botSessions.findFirst({
      where: eq(botSessions.userId, userId),
    });
    return row?.data ?? {};
  }

  async setSession(userId: number, data: SessionData): Promise<void> {
    await this.db
      .insert(botSessions)
      .values({ userId, data: data as Record<string, unknown> })
      .onConflictDoUpdate({
        target: botSessions.userId,
        set: { data: data as Record<string, unknown>, updatedAt: sql`now()` },
      });
  }

  async patchSession(userId: number, patch: Partial<SessionData>): Promise<SessionData> {
    const next = { ...(await this.getSession(userId)), ...patch };
    for (const k of Object.keys(next) as (keyof SessionData)[]) {
      if (next[k] === undefined) delete next[k];
    }
    await this.setSession(userId, next);
    return next;
  }
}
