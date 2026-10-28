import pg from 'pg';

/** A dedicated DONARIUM database; the caller owns pool shutdown. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'donarium',
  });
}
