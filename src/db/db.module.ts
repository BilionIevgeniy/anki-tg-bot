import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ENV, type Env, loadEnv, pgConnection } from '../config/env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

@Injectable()
class PoolCloser implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) => {
        const pool = new Pool({ ...pgConnection(env.DATABASE_URL), max: 5 });
        // an idle connection dropped by Neon (compute restart) must not crash the process
        pool.on('error', (err) => new Logger('Postgres').warn(`idle client error: ${err.message}`));
        return pool;
      },
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool): Db => drizzle(pool, { schema }) },
    PoolCloser,
  ],
  exports: [ENV, DB, PG_POOL],
})
export class DbModule {}
