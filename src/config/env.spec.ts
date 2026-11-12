import { loadEnv, pgConnection, telegramSecretToken } from './env';

const base = {
  BOT_TOKEN: '123456:abcdefghij',
  DATABASE_URL: 'postgresql://x',
  JOBS_SECRET: 'abcdefghijklmnop',
};

describe('env', () => {
  it('accepts Render-generated secrets and derives a Telegram-safe token', () => {
    const env = loadEnv({
      ...base,
      BOT_MODE: 'webhook',
      WEBHOOK_SECRET: 'aB+/=xyz0123456789==',
      RENDER_EXTERNAL_URL: 'https://x.onrender.com',
    });
    expect(env.PUBLIC_URL).toBe('https://x.onrender.com');
    expect(telegramSecretToken(env.WEBHOOK_SECRET!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('prefers an explicit PUBLIC_URL and requires a URL in webhook mode', () => {
    expect(
      loadEnv({
        ...base,
        BOT_MODE: 'webhook',
        WEBHOOK_SECRET: 'x'.repeat(16),
        PUBLIC_URL: 'https://a.test',
        RENDER_EXTERNAL_URL: 'https://b.test',
      }).PUBLIC_URL,
    ).toBe('https://a.test');
    expect(() => loadEnv({ ...base, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'x'.repeat(16) })).toThrow(
      /PUBLIC_URL/,
    );
  });

  it('moves sslmode from the URL into the TLS config', () => {
    expect(
      pgConnection('postgresql://u:p@ep.neon.tech/db?sslmode=require&channel_binding=require'),
    ).toEqual({
      connectionString: 'postgresql://u:p@ep.neon.tech/db?channel_binding=require',
      ssl: { rejectUnauthorized: true },
    });
    expect(pgConnection('postgresql://u:p@h/db?sslmode=require')).toEqual({
      connectionString: 'postgresql://u:p@h/db',
      ssl: { rejectUnauthorized: true },
    });
    expect(pgConnection('postgresql://anki:anki@localhost:5432/anki')).toEqual({
      connectionString: 'postgresql://anki:anki@localhost:5432/anki',
    });
  });
});
