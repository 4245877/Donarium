import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app.js';
import { PostgresRepository } from '../apps/api/src/catalog/postgres.js';
import { linkFile } from '../apps/api/src/storage/imports.js';
import { StorageService } from '../apps/api/src/storage/service.js';

const sourceUrl = process.env.TEST_DATABASE_URL, restoreUrl = process.env.RESTORE_DATABASE_URL;
const skip = !sourceUrl || !restoreUrl;
const schema = `portable_${randomUUID().replaceAll('-', '')}`;
let source: pg.Pool, restored: pg.Pool, sourceAdmin: pg.Pool, restoreAdmin: pg.Pool;
let temporary: string, sourceApp: FastifyInstance, restoreApp: FastifyInstance;
let sourceCookie: string, restoreCookie: string;
const password = 'isolated-roundtrip-password';
let productId: string, archive: Buffer;
let original: Awaited<ReturnType<PostgresRepository['get']>>;
const fixtures = new Map<string, Buffer>();

async function login(app: FastifyInstance) { const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password } }); assert.equal(response.statusCode, 200, response.body); return String(response.headers['set-cookie']).split(';')[0]!; }
async function poll(app: FastifyInstance, cookie: string, id: string) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const response = await app.inject({ url: `/api/v1/transfers/${id}`, headers: { cookie } }); assert.equal(response.statusCode, 200, response.body);
    const job = response.json(); if (!['uploading', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Transfer timeout');
}
async function prepareDatabase(url: string) {
  const parsed = new URL(url); assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^donarium_test(?:_[a-z0-9]+)*$/, 'Only explicitly separate test databases are allowed');
  const admin = new pg.Pool({ connectionString: url }); await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public'); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  for (const migration of (await readdir(new URL('../db/migrations/', import.meta.url))).sort()) if (migration.endsWith('.sql')) await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  return { admin, pool };
}
before(async () => {
  if (skip) return;
  assert.notEqual(new URL(sourceUrl!).pathname, new URL(restoreUrl!).pathname, 'Roundtrip must use two different databases');
  const a = await prepareDatabase(sourceUrl!), b = await prepareDatabase(restoreUrl!); sourceAdmin = a.admin; source = a.pool; restoreAdmin = b.admin; restored = b.pool;
  temporary = await mkdtemp(join(tmpdir(), 'donarium-portability-')); await mkdir(join(temporary, 'originals'));
  fixtures.set('dragon.stl', Buffer.from('solid дракон\n facet normal 0 0 1\nendsolid\n'));
  fixtures.set('cover.png', await sharp({ create: { width: 48, height: 36, channels: 3, background: '#8572ab' } }).png().toBuffer());
  fixtures.set('readme.txt', Buffer.from('Документация модели\n'));
  for (const [name, bytes] of fixtures) await writeFile(join(temporary, 'originals', name), bytes);
  const config = (kind: string) => ({ host: '127.0.0.1', port: 4180, dataMode: 'postgres' as const, logLevel: 'silent' as const, staticDir: join(temporary, 'no-static'), adminPassword: password,
    storageRoots: kind === 'source' ? [{ key: 'ORIGINALS', name: 'Оригиналы', path: join(temporary, 'originals') }] : [], managedRoot: join(temporary, kind, 'uploads'), workRoot: join(temporary, kind, 'work') });
  sourceApp = await buildApp({ pool: source, logger: false, config: config('source') }); restoreApp = await buildApp({ pool: restored, logger: false, config: config('restore') });
  sourceCookie = await login(sourceApp); restoreCookie = await login(restoreApp);
  // User-facing CRUD, followed by safe links to existing originals.
  let response = await sourceApp.inject({ method: 'POST', url: '/api/v1/categories', headers: { cookie: sourceCookie }, payload: { name: 'Драконы', slug: 'dragons' } });
  assert.equal(response.statusCode, 201, response.body); const category = response.json().item;
  response = await sourceApp.inject({ method: 'POST', url: '/api/v1/products', headers: { cookie: sourceCookie }, payload: { title: 'Кристальный дракон', sku: 'DRAGON-01', description: 'Модель и документация', categoryIds: [category.id], tags: ['Печать', 'Фэнтези'], status: 'processing' } });
  assert.equal(response.statusCode, 201, response.body); productId = response.json().item.id;
  const storage = new StorageService(config('source'));
  for (const name of fixtures.keys()) await linkFile(source, storage, productId, 'ORIGINALS', name);
  const repo = new PostgresRepository(source, storage); const linked = (await repo.get(productId))!;
  await repo.update(productId, { title: linked.title, sku: linked.sku, description: linked.description, categoryIds: linked.categories.map(item => item.id), tags: linked.tags, status: linked.status, coverAssetId: linked.assets.find(asset => asset.kind === 'image')!.id, figureFile: { root: 'ORIGINALS', path: 'dragon.stl' } });
  await repo.create({ title: '=SUM(1,2)', description: 'Optional SKU', tags: ['без SKU'] });
  original = await repo.get(productId);
});
after(async () => {
  await sourceApp?.close(); await restoreApp?.close(); await source?.end(); await restored?.end();
  if (sourceAdmin) { await sourceAdmin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await sourceAdmin.end(); }
  if (restoreAdmin) { await restoreAdmin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await restoreAdmin.end(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('portable catalogue exports JSON/CSV and restores a full ZIP into separate empty PostgreSQL and storage', { skip }, async () => {
  let response = await sourceApp.inject({ url: '/api/v1/exports/catalog.json', headers: { cookie: sourceCookie } }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().version, 2); assert.equal(response.json().products.length, 2); assert.equal(response.json().assets.length, 3); assert.ok(!response.body.includes(temporary));
  response = await sourceApp.inject({ url: '/api/v1/exports/catalog.csv', headers: { cookie: sourceCookie } }); assert.equal(response.statusCode, 200, response.body); assert.ok(response.body.includes('categories_json')); assert.ok(response.body.includes("'=SUM(1,2)"));
  response = await sourceApp.inject({ method: 'POST', url: '/api/v1/exports/archive', headers: { cookie: sourceCookie } }); assert.equal(response.statusCode, 202, response.body);
  const exported = await poll(sourceApp, sourceCookie, response.json().id); assert.equal(exported.status, 'completed', JSON.stringify(exported));
  response = await sourceApp.inject({ url: `/api/v1/transfers/${exported.id}/download`, headers: { cookie: sourceCookie } }); assert.equal(response.statusCode, 200); archive = response.rawPayload;
  response = await restoreApp.inject({ method: 'PUT', url: '/api/v1/restores/preview?filename=library.zip', headers: { cookie: restoreCookie, 'content-type': 'application/octet-stream' }, payload: archive }); assert.equal(response.statusCode, 202, response.body);
  let job = await poll(restoreApp, restoreCookie, response.json().id); assert.equal(job.status, 'ready', JSON.stringify(job)); assert.equal(job.result.counts.products, 2); assert.equal(job.result.conflicts, 0);
  assert.equal((await restored.query('SELECT count(*)::int AS count FROM products')).rows[0].count, 0, 'Preview must not create products');
  response = await restoreApp.inject({ method: 'POST', url: `/api/v1/restores/${job.id}/confirm`, headers: { cookie: restoreCookie }, payload: { conflict: 'skip' } }); assert.equal(response.statusCode, 202, response.body);
  job = await poll(restoreApp, restoreCookie, job.id); assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.result.imported, 2);
  const product = (await new PostgresRepository(restored).get(productId))!;
  for (const field of ['id', 'sku', 'title', 'description', 'status', 'coverAssetId', 'categories', 'tags', 'createdAt', 'updatedAt'] as const) assert.deepEqual(product[field], original![field], field);
  assert.deepEqual(product.assets.map(asset => asset.id).sort(), original!.assets.map(asset => asset.id).sort());
  assert.equal(product.figureFile?.id, original!.figureFile?.id);
  assert.equal(product.figureFile?.role, 'figure');
  assert.equal(product.figureFile?.storageKey, 'DONARIUM_UPLOADS');
  for (const asset of product.assets) {
    const bytes = fixtures.get(asset.name)!; const downloaded = await restoreApp.inject({ url: `/api/v1/assets/${asset.id}/download`, headers: { cookie: restoreCookie } });
    assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.rawPayload, bytes);
    assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(asset.relativePath?.startsWith('restored/')); assert.equal(asset.storageKey, 'DONARIUM_UPLOADS');
    assert.deepEqual(await readFile(join(temporary, 'originals', asset.name)), bytes, 'Original unchanged');
  }
});

test('reimport previews conflicts, skips duplicates, copies with new IDs and never deletes restored files', { skip }, async () => {
  assert.ok(archive);
  for (const mode of ['skip', 'copy'] as const) {
    const uploaded = await restoreApp.inject({ method: 'PUT', url: '/api/v1/restores/preview', headers: { cookie: restoreCookie, 'content-type': 'application/octet-stream' }, payload: archive });
    let job = await poll(restoreApp, restoreCookie, uploaded.json().id); assert.equal(job.status, 'ready', JSON.stringify(job)); assert.equal(job.result.conflicts, 2);
    await restoreApp.inject({ method: 'POST', url: `/api/v1/restores/${job.id}/confirm`, headers: { cookie: restoreCookie }, payload: { conflict: mode } });
    job = await poll(restoreApp, restoreCookie, job.id); assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.result.imported, mode === 'skip' ? 0 : 2);
    await restoreApp.inject({ method: 'DELETE', url: `/api/v1/transfers/${job.id}`, headers: { cookie: restoreCookie } });
  }
  assert.equal((await restored.query('SELECT count(*)::int AS count FROM products')).rows[0].count, 4);
  assert.equal((await restored.query('SELECT count(*)::int AS count FROM storage_files')).rows[0].count,3,'Repeated restores reuse physical file UUIDs');
  const countFiles=async(path:string):Promise<number>=>{let count=0;for(const entry of await readdir(path,{withFileTypes:true}))count+=entry.isDirectory()?await countFiles(join(path,entry.name)):1;return count;};
  assert.equal(await countFiles(join(temporary,'restore','uploads','restored')),3,'No extra original bytes remain after repeated restores');
  const product = (await new PostgresRepository(restored).get(productId))!;
  for (const asset of product.assets) assert.equal((await restoreApp.inject({ url: `/api/v1/assets/${asset.id}/download`, headers: { cookie: restoreCookie } })).statusCode, 200);
});
