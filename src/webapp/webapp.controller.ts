import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  type CanActivate,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import type { User } from '../db/schema';
import { DecksService } from '../decks/decks.service';
import { formatInterval, isGrade } from '../srs/fsrs.core';
import { countTotal, type Counts, QueueService } from '../srs/queue.service';
import { ReviewService } from '../srs/review.service';
import { UsersService } from '../users/users.service';
import { validateInitData } from './telegram-auth';

type AuthedRequest = Request & { user?: User };

/** Authorization: tma <initData>  — validated with the bot token. */
@Injectable()
export class TelegramWebAppGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const tgUser = initData ? validateInitData(initData, this.env.BOT_TOKEN) : null;
    if (!tgUser) throw new UnauthorizedException('invalid Telegram init data');
    if (!this.users.isAllowed(tgUser.id)) throw new ForbiddenException('private bot');
    req.user = await this.users.upsert(tgUser);
    return true;
  }
}

const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);

export interface CardDto {
  id: number;
  version: number;
  template: string;
  state: number;
  deckId: number;
  deckName: string;
  note: { type: string; fields: Record<string, unknown> };
  /** Next interval per button, e.g. [{ grade: 1, label: "1м" }, …] */
  previews: { grade: number; label: string }[];
}

export interface NextDto {
  card: CardDto | null;
  counts: Counts & { total: number };
  /** When the next learning card becomes due (if nothing is due right now) */
  nextLearningDue: string | null;
  activeDecks: number;
}

const answerBody = z.object({
  cardId: z.number().int(),
  version: z.number().int(),
  grade: z.number().int(),
  scope: z.number().int().default(0),
});
const undoBody = z.object({ logId: z.number().int(), scope: z.number().int().default(0) });

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (!res.success)
    throw new BadRequestException(res.error.issues.map((i) => i.message).join('; '));
  return res.data;
}

/** JSON API for the Telegram Mini App (webapp/). Same queue and FSRS logic as the chat. */
@Controller('api/app')
@UseGuards(TelegramWebAppGuard)
export class WebAppController {
  constructor(
    private readonly queue: QueueService,
    private readonly review: ReviewService,
    private readonly decks: DecksService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: User) {
    const list = await this.decks.list(user.id);
    const active = list.filter((d) => !d.isPaused);
    const per = await this.queue.deckCounts(user, active, new Date());
    return {
      firstName: user.firstName,
      decks: active.map((d) => ({ id: d.id, name: d.name, due: countTotal(per.get(d.id)!) })),
    };
  }

  @Get('next')
  next(@CurrentUser() user: User, @Query('scope') scope?: string): Promise<NextDto> {
    return this.nextFor(user, Number(scope) || 0);
  }

  @Post('answer')
  async answer(@CurrentUser() user: User, @Body() raw: unknown) {
    const body = parseBody(answerBody, raw);
    if (!isGrade(body.grade)) throw new ForbiddenException('bad grade');
    const now = new Date();
    const res = await this.review.answer(user.id, body.cardId, body.grade, body.version, now);
    const next = await this.nextFor(user, body.scope);
    if (!res.ok) return { ok: false as const, reason: res.reason, next };
    return {
      ok: true as const,
      logId: res.logId,
      label: formatInterval(now, res.due),
      leech: res.leech,
      next,
    };
  }

  @Post('undo')
  async undo(@CurrentUser() user: User, @Body() raw: unknown) {
    const body = parseBody(undoBody, raw);
    const res = await this.review.undo(user.id, body.logId);
    if (!res.ok) return { ok: false as const, next: await this.nextFor(user, body.scope) };
    const row = await this.review.getCard(user.id, res.cardId);
    const now = new Date();
    const counts = await this.queue.totals(user, body.scope, now);
    return {
      ok: true as const,
      next: {
        card: row ? await this.toDto(row.card, row.note, row.deck, now) : null,
        counts: { ...counts, total: countTotal(counts) },
        nextLearningDue: null,
        activeDecks: 1,
      } satisfies NextDto,
    };
  }

  private async nextFor(user: User, scope: number): Promise<NextDto> {
    const now = new Date();
    const res = await this.queue.next(user, scope, now);
    if (res.kind === 'card') {
      return {
        card: await this.toDto(res.card, res.note, res.deck, now),
        counts: { ...res.counts, total: countTotal(res.counts) },
        nextLearningDue: null,
        activeDecks: 1,
      };
    }
    const counts = await this.queue.totals(user, scope, now);
    return {
      card: null,
      counts: { ...counts, total: countTotal(counts) },
      nextLearningDue: res.nextLearningDue?.toISOString() ?? null,
      activeDecks: res.activeDecks,
    };
  }

  private async toDto(
    card: Parameters<ReviewService['preview']>[0],
    note: { type: string; fields: unknown },
    deck: { id: number; name: string; desiredRetention: number },
    now: Date,
  ): Promise<CardDto> {
    const previews = await this.review.preview(card, deck.desiredRetention, now);
    return {
      id: card.id,
      version: card.version,
      template: card.template,
      state: card.state,
      deckId: deck.id,
      deckName: deck.name,
      note: { type: note.type, fields: note.fields as Record<string, unknown> },
      previews: previews.map((p) => ({ grade: p.grade, label: p.label })),
    };
  }
}
