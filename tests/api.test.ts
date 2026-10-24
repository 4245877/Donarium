import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.js';
import type { Config } from '../apps/api/src/config.js';
import { DemoRepository, demoProducts } from '../apps/api/src/catalog/demo.js';

const temporary = await mkdtemp(join(tmpdir(), 'donarium-api-'));
const publicDir = join(temporary, 'public');
await mkdir(publicDir);
await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>DONARIUM test</title>');
await writeFile(join(temporary, 'private.txt'), 'DONARIUM_PRIVATE_MARKER');
await writeFile(join(publicDir, '.env'), 'DONARIUM_PRIVATE_MARKER');
const config: Config = { host: '127.0.0.1', port: 4180, dataMode: 'demo', logLevel: 'silent', staticDir: publicDir };
const app = await buildApp({ config, logger: false });
after(async () => { await app.close(); await rm(temporary, { recursive: true, force: true }); });

async function get(path: string) { return app.inject({ method: 'GET', url: path }); }

test('health explicitly identifies demo mode with no database connection', async () => {
  const response = await get('/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.json().mode, 'demo');
  assert.equal(response.json().database, 'not-configured');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('catalog search uses title, SKU, description and tags from backend', async () => {
  const all = (await get('/api/v1/products')).json();
  assert.equal(all.total, 6);
  assert.equal(all.categories.length, 3);
  for (const query of ['ваза', 'DN-001', 'спиральным', 'интерьер']) {
    const response = await get(`/api/v1/products?q=${encodeURIComponent(query)}`);
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().items.some((item: { sku: string }) => item.sku === 'DN-001'), query);
  }
  assert.equal((await get('/api/v1/products?q=nothing-matches')).json().total, 0);
});

test('category filtering and deterministic pagination do not repeat products', async () => {
  const decor = (await get('/api/v1/products?category=decor')).json();
  assert.equal(decor.total, 3);
  assert.ok(decor.items.every((item: { categories: { slug: string }[] }) => item.categories.some(category => category.slug === 'decor')));
  const first = (await get('/api/v1/products?pageSize=2&page=1')).json();
  const next = (await get('/api/v1/products?pageSize=2&page=2')).json();
  assert.equal(first.items.length, 2);
  assert.equal(next.items.length, 2);
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 4);
});

test('invalid and oversized requests return structured 400 errors', async () => {
  for (const query of ['page=0', 'pageSize=101', 'sort=unsafe', 'category=../etc', 'unknown=true', `q=${'x'.repeat(201)}`]) {
    const response = await get(`/api/v1/products?${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.ok(response.json().error.requestId);
  }
});

test('detail preserves stable identity and accurately reports unconnected model files', async () => {
  const response = await get(`/api/v1/products/${demoProducts[0]!.id}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().item.sku, 'DN-001');
  assert.equal(response.json().item.assets[0].externalUrl, null);
  assert.equal(response.json().item.assets[0].sha256, null);
  assert.equal((await get('/api/v1/products/not-a-uuid')).statusCode, 400);
  assert.equal((await get('/api/v1/products/99999999-9999-4999-8999-999999999999')).statusCode, 404);
});

test('SPA routes work and unknown API, missing assets and write operations are not disguised as HTML', async () => {
  for (const route of ['/', '/catalog', '/system', `/catalog/${demoProducts[0]!.id}`]) {
    const response = await get(route);
    assert.equal(response.statusCode, 200, route);
    assert.match(String(response.headers['content-type']), /text\/html/);
  }
  for (const route of ['/api/unknown', '/api/v1/products/unknown/download', '/assets/missing.js']) {
    const response = await get(route);
    assert.equal(response.statusCode, 404, route);
    assert.equal(response.json().error.code, 'NOT_FOUND');
  }
  const write = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { title: 'Unwanted' } });
  assert.equal(write.statusCode, 403);
  assert.equal((await get('/api/v1/products')).json().total, 6);
});

test('public static root cannot expose dotfiles or traverse to private files', async () => {
  for (const route of ['/.env', '/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/assets/%2e%2e%2f%2e%2e%2fprivate.txt']) {
    const response = await get(route);
    assert.ok([400, 403, 404].includes(response.statusCode), `${route}: ${response.statusCode}`);
    assert.ok(!response.body.includes('DONARIUM_PRIVATE_MARKER'));
  }
  const response = await get('/');
  assert.match(String(response.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('unexpected failures do not disclose connection credentials', async () => {
  class BrokenRepository extends DemoRepository { override async categories(): Promise<never> { throw new Error('postgres://secret:password@private/database'); } }
  const broken = await buildApp({ config, repository: new BrokenRepository(), logger: false });
  try {
    const response = await broken.inject('/api/v1/products');
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.ok(!response.body.includes('password'));
  } finally { await broken.close(); }
});

test('PostgreSQL outage is reported as 503 rather than silently switching to demo', async () => {
  const pool = { query: async () => { throw new Error('offline'); } } as unknown as Pool;
  const unavailable = await buildApp({ config: { ...config, dataMode: 'postgres' }, pool, repository: new DemoRepository(), logger: false });
  try {
    const response = await unavailable.inject('/health');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, 'unavailable');
    assert.equal(response.json().mode, 'postgres');
  } finally { await unavailable.close(); }
});
