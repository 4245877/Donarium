import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataMode } from '@donarium/shared';

export interface StorageRootConfig { key: string; name: string; path: string; writable?: boolean; internal?: boolean }
export interface StorageGuard { path: string; source: string; marker: string; value: string }

export interface Config {
  host: string;
  port: number;
  dataMode: DataMode;
  databaseUrl?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  staticDir: string;
  storageRoot?: string;
  storageRoots?: StorageRootConfig[];
  managedRoot?: string;
  workRoot?: string;
  maxUploadBytes?: number;
  maxArchiveBytes?: number;
  storageGuards?: StorageGuard[];
  requireStorageGuards?: boolean;
  adminPassword?: string;
  secureCookie?: boolean;
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function loadConfig(): Config {
  const envPath = resolve(projectRoot, '.env');
  // Node's native loader preserves values already supplied by the service manager.
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const env = process.env;
  const dataMode = env.DATA_MODE ?? 'postgres';
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
  const adminPassword = env.ADMIN_PASSWORD || undefined;
  if (adminPassword && (adminPassword.length < 12 || adminPassword.startsWith('REPLACE_'))) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
  if (dataMode === 'postgres' && !adminPassword) throw new Error('ADMIN_PASSWORD is required in postgres mode');
  let storageRoots: StorageRootConfig[] = [];
  if (env.STORAGE_ROOTS) {
    let value: unknown;
    try { value = JSON.parse(env.STORAGE_ROOTS); } catch { throw new Error('STORAGE_ROOTS must be a JSON array'); }
    if (!Array.isArray(value) || value.length > 32) throw new Error('STORAGE_ROOTS must be an array of at most 32 roots');
    storageRoots = value.map(item => {
      if (!item || typeof item !== 'object' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.key) || item.key === 'DONARIUM_UPLOADS' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || typeof item.path !== 'string' || !item.path.startsWith('/')) throw new Error('Invalid STORAGE_ROOTS entry');
      return { key: item.key, name: item.name, path: resolve(item.path), writable: false, internal: item.internal === true };
    });
    if (new Set(storageRoots.map(root => root.key)).size !== storageRoots.length) throw new Error('Duplicate STORAGE_ROOTS key');
  } else if (env.STORAGE_ROOT) {
    storageRoots = [{ key: 'LIBRARY', name: 'Библиотека', path: resolve(projectRoot, env.STORAGE_ROOT), writable: false }];
  }
  const positiveLimit = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1024 || value > 10 * 1024 ** 4) throw new Error(`${key} must be a safe positive byte limit`);
    return value;
  };
  let storageGuards: StorageGuard[] = [];
  if (env.STORAGE_GUARDS) {
    const parsed = JSON.parse(env.STORAGE_GUARDS);
    if (!Array.isArray(parsed) || parsed.length > 34) throw new Error('Invalid STORAGE_GUARDS');
    storageGuards = parsed.map(g => {
      if (!g || typeof g.path !== 'string' || !g.path.startsWith('/') || typeof g.source !== 'string' || !g.source || typeof g.marker !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(g.marker) || typeof g.value !== 'string' || !g.value) throw new Error('Invalid STORAGE_GUARDS entry');
      return { path: resolve(g.path), source: g.source, marker: g.marker, value: g.value };
    });
  }
  return {
    host: env.HOST || '127.0.0.1',
    port,
    dataMode,
    databaseUrl,
    logLevel: logLevel as Config['logLevel'],
    staticDir: env.STATIC_DIR ? resolve(projectRoot, env.STATIC_DIR) : fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    storageRoot: env.STORAGE_ROOT ? resolve(projectRoot, env.STORAGE_ROOT) : undefined,
    storageRoots,
    managedRoot: resolve(projectRoot, env.MANAGED_STORAGE_ROOT || 'var/uploads'),
    workRoot: resolve(projectRoot, env.WORK_ROOT || 'var/work'),
    maxUploadBytes: positiveLimit('MAX_UPLOAD_BYTES', 20 * 1024 ** 3),
    maxArchiveBytes: positiveLimit('MAX_ARCHIVE_BYTES', 2 * 1024 ** 4),
    storageGuards, requireStorageGuards: env.STORAGE_REQUIRE_GUARDS === 'true',
    adminPassword,
    secureCookie: env.SECURE_COOKIE === 'true',
  };
}
