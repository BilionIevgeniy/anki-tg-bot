import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidTimezone } from '../srs/day';

const schema = z
  .object({
    BOT_TOKEN: z.string().min(10, 'BOT_TOKEN is required'),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    PUBLIC_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Set automatically by Render; used when PUBLIC_URL is empty. */
    RENDER_EXTERNAL_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Any string of 16+ chars; it is hashed into a Telegram-compatible secret_token. */
    WEBHOOK_SECRET: z
      .string()
      .min(16, 'WEBHOOK_SECRET: at least 16 characters')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JOBS_SECRET: z.string().min(3, 'JOBS_SECRET is required'),
    ALLOWED_TELEGRAM_IDS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map(Number),
      ),
    DEFAULT_TIMEZONE: z
      .string()
      .default('Europe/Berlin')
      .refine(isValidTimezone, 'DEFAULT_TIMEZONE is not a valid IANA timezone'),
    PORT: z.coerce.number().int().default(3000),
  })
  .transform((env) => ({ ...env, PUBLIC_URL: env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL }))
  .superRefine((env, ctx) => {
    if (env.BOT_MODE === 'webhook') {
      if (!env.PUBLIC_URL)
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'required in webhook mode' });
      if (!env.WEBHOOK_SECRET)
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_SECRET'],
          message: 'required in webhook mode',
        });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const res = schema.safeParse(source);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  if (source === process.env) cached = res.data;
  return res.data;
}

export const ENV = Symbol('ENV');

/** Telegram allows only A-Z a-z 0-9 _ - (1–256 chars) in secret_token, so derive one. */
export function telegramSecretToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** pg warns about sslmode=require; drop it from the URL and configure TLS explicitly instead. */
export function pgConnection(url: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  const needsTls = /sslmode=(require|verify-full|verify-ca|prefer)|neon\.tech/.test(url);
  const connectionString = url
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_m, p1: string, p2: string) => (p2 ? p1 : ''))
    .replace(/[?&]$/, '');
  return needsTls ? { connectionString, ssl: { rejectUnauthorized: true } } : { connectionString };
}
