/**
 * Applies SQL migrations from ./drizzle. Runs before the app starts in production
 * (`npm run start:prod`) and locally via `npm run db:migrate`.
 */
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { pgConnection } from '../config/env';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ ...pgConnection(url), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    console.log('✅ Migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('❌ Migration failed', err);
  process.exit(1);
});
