import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Module,
  Post,
  Query,
  Inject,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { BotService } from './bot/bot.service';
import { DecksHandler } from './bot/decks.handler';
import { ImportHandler } from './bot/import.handler';
import { ReviewHandler } from './bot/review.handler';
import { ENV, type Env } from './config/env';
import { DbModule } from './db/db.module';
import { DecksService } from './decks/decks.service';
import { ImportService } from './import/import.service';
import { NotificationsService, type TickReport } from './notifications/notifications.service';
import { QueueService } from './srs/queue.service';
import { ReviewService } from './srs/review.service';
import { StatsService } from './stats/stats.service';
import { TelegramModule } from './telegram/telegram.module';
import { UsersService } from './users/users.service';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Controller()
export class HealthController {
  /** Also used by the external pinger to keep the free Render instance awake. */
  @Get('health')
  health() {
    return { ok: true, time: new Date().toISOString() };
  }
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Called every 5–15 minutes by an external cron (cron-job.org, UptimeRobot, GitHub Actions).
   * GET is allowed too (secret in ?secret=) for pingers that cannot send POST or headers.
   * No in-process timers: a sleeping free instance would miss them.
   */
  @Post('tick')
  @Get('tick')
  @HttpCode(200)
  async tick(
    @Headers('x-jobs-secret') header?: string,
    @Query('secret') query?: string,
  ): Promise<TickReport> {
    const given = header ?? query ?? '';
    if (!safeEqual(given, this.env.JOBS_SECRET)) throw new ForbiddenException();
    return this.notifications.tick();
  }
}

@Module({
  imports: [DbModule, TelegramModule],
  controllers: [HealthController, JobsController],
  providers: [
    UsersService,
    DecksService,
    QueueService,
    ReviewService,
    ImportService,
    StatsService,
    NotificationsService,
    ReviewHandler,
    DecksHandler,
    ImportHandler,
    BotService,
  ],
})
export class AppModule {}
