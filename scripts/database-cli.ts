import { existsSync } from 'node:fs';
import { createPool } from '../apps/api/src/db.js';

if (existsSync('.env')) process.loadEnvFile('.env');

/** Explicit guard against accidentally running write tools on a neighbouring project's database. */
export function databaseForMaintenance() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required. Use a separate DONARIUM database.');
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !/^donarium(?:_[a-z0-9]+)*$/.test(databaseName)) {
    throw new Error('Maintenance is restricted to a dedicated database named donarium or donarium_<suffix>.');
  }
  if (process.env.DB_MIGRATION_CONFIRM !== 'donarium') {
    throw new Error('Set DB_MIGRATION_CONFIRM=donarium after verifying the dedicated DATABASE_URL.');
  }
  return createPool(databaseUrl);
}

export function reportMaintenanceError(error: unknown): void {
  // pg connection errors can carry the connection string: never dump configuration or the error object.
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (error instanceof Error && /^(DATABASE_URL|Maintenance is restricted|Set DB_MIGRATION_CONFIRM|Migration |Seed )/.test(error.message)) {
    console.error(error.message);
  } else {
    console.error(`Database maintenance failed${code ? ` (${code})` : ''}. Check database access and the migration SQL.`);
  }
  process.exitCode = 1;
}
