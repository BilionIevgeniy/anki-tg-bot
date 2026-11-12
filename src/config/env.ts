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
    WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, 'WEBHOOK_SECRET: 16+ chars of A-Z a-z 0-9 _ -')
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
