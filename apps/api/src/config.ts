import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataMode } from '@donarium/shared';

export interface Config {
  host: string;
  port: number;
  dataMode: DataMode;
  databaseUrl?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  staticDir: string;
  storageRoot?: string;
  externalStorageBaseUrl?: string;
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function loadConfig(): Config {
  const envPath = resolve(projectRoot, '.env');
  // Node's native loader preserves values already supplied by the service manager.
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const env = process.env;
  const dataMode = env.DATA_MODE ?? 'demo';
  if (dataMode !== 'demo' && dataMode !== 'postgres') throw new Error('DATA_MODE must be demo or postgres');
  const port = Number(env.PORT ?? 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new Error('Invalid LOG_LEVEL');
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (dataMode === 'postgres' && !databaseUrl) throw new Error('DATABASE_URL is required in postgres mode');
  if (databaseUrl) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  const externalStorageBaseUrl = env.EXTERNAL_STORAGE_BASE_URL?.trim() || undefined;
  if (externalStorageBaseUrl) {
    let parsed: URL;
    try { parsed = new URL(externalStorageBaseUrl); } catch { throw new Error('EXTERNAL_STORAGE_BASE_URL must be an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('EXTERNAL_STORAGE_BASE_URL must be HTTP(S), without embedded credentials');
    }
  }
  return {
    host: env.HOST || '127.0.0.1',
    port,
    dataMode,
    databaseUrl,
    logLevel: logLevel as Config['logLevel'],
    staticDir: env.STATIC_DIR ? resolve(projectRoot, env.STATIC_DIR) : fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    storageRoot: env.STORAGE_ROOT ? resolve(projectRoot, env.STORAGE_ROOT) : undefined,
    externalStorageBaseUrl,
  };
}
