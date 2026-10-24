import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import type { CatalogQuery } from '@donarium/shared';
import { createPool } from '../apps/api/src/db.js';
import { PostgresRepository } from '../apps/api/src/catalog/postgres.js';
import { demoProducts } from '../apps/api/src/catalog/demo.js';
import { buildApp } from '../apps/api/src/app.js';

const testUrl = process.env.TEST_DATABASE_URL;
let pool: Pool;
let repository: PostgresRepository;
const defaults: CatalogQuery = { q: '', category: '', page: 1, pageSize: 24, sort: 'newest' };

before(() => {
  if (!testUrl) return;
  const url = new URL(testUrl);
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^donarium_test(?:_[a-z0-9]+)*$/, 'Only a separate donarium_test database is allowed');
  pool = createPool(testUrl);
  repository = new PostgresRepository(pool);
});
after(async () => { if (pool) await pool.end(); });

test('PostgreSQL: seeded catalogue, categories and literal search', { skip: !testUrl }, async () => {
  const all = await repository.list(defaults);
  assert.equal(all.total, demoProducts.length);
  assert.equal(all.items.length, demoProducts.length);
  assert.equal((await repository.categories()).length, 3);
  for (const [query, sku] of [['Спираль', 'DN-001'], ['DN-003', 'DN-003'], ['фэнтези', 'DN-002'], ['ДРАКОН', 'DN-002']]) {
    const found = await repository.list({ ...defaults, q: query! });
    assert.equal(found.total, 1, `Search ${query}`);
    assert.equal(found.items[0]?.sku, sku);
  }
  for (const q of ['%', '_', "' OR 1=1 --", '\\']) {
    assert.equal((await repository.list({ ...defaults, q })).total, 0, `Literal input: ${q}`);
  }
});

test('PostgreSQL: category filter, stable pagination, product and missing ID', { skip: !testUrl }, async () => {
  const decor = await repository.list({ ...defaults, category: 'decor' });
  assert.equal(decor.total, 3);
  assert.ok(decor.items.every(item => item.categories.some(category => category.slug === 'decor')));
  const first = await repository.list({ ...defaults, pageSize: 2, sort: 'title' });
  const repeated = await repository.list({ ...defaults, pageSize: 2, sort: 'title' });
  const second = await repository.list({ ...defaults, page: 2, pageSize: 2, sort: 'title' });
  assert.deepEqual(first, repeated);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4);
  const outOfRange = await repository.list({ ...defaults, page: 99 });
  assert.equal(outOfRange.total, demoProducts.length);
  assert.deepEqual(outOfRange.items, []);
  const fixture = demoProducts[0]!;
  const product = await repository.get(fixture.id);
  assert.equal(product?.title, fixture.title);
  assert.equal(product?.assets[0]?.name, fixture.assets[0]?.name);
  assert.equal(await repository.get('00000000-0000-4000-8000-999999999999'), null);
});

test('PostgreSQL: unsafe paths rejected and bigint metadata preserved', { skip: !testUrl }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionRepository = new PostgresRepository(client);
    const fixture = demoProducts[0]!;
    const asset = fixture.assets[0]!;
    const storage = await client.query<{ storage_id: string }>('SELECT storage_id FROM assets WHERE id = $1', [asset.id]);
    for (const relativePath of ['../model.stl', '/etc/passwd', 'models/../../model.stl', 'models\\model.stl', './model.stl', 'models//model.stl']) {
      await client.query('SAVEPOINT invalid_path');
      await assert.rejects(client.query(`INSERT INTO assets (product_id, kind, name, storage_id, relative_path)
        VALUES ($1, 'model', 'unsafe.stl', $2, $3)`, [fixture.id, storage.rows[0]!.storage_id, relativePath]),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23514');
      await client.query('ROLLBACK TO SAVEPOINT invalid_path');
    }
    await client.query('UPDATE assets SET size_bytes = $1, sha256 = $2 WHERE id = $3', ['9007199254740993', 'a'.repeat(64), asset.id]);
    const product = await transactionRepository.get(fixture.id);
    assert.equal(product?.assets[0]?.sizeBytes, '9007199254740993');
    assert.equal(product?.assets[0]?.sha256, 'a'.repeat(64));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('PostgreSQL: real API health and frontend catalogue contract', { skip: !testUrl }, async () => {
  const app = await buildApp({ pool, logger: false, config: {
    host: '127.0.0.1', port: 4180, dataMode: 'postgres', databaseUrl: testUrl,
    logLevel: 'silent', staticDir: '/tmp/donarium-integration-no-static',
  } });
  try {
    const health = await app.inject('/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().database, 'connected');
    const catalog = await app.inject('/api/v1/products?q=DN-001');
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().mode, 'postgres');
    assert.equal(catalog.json().items[0].sku, 'DN-001');
  } finally {
    await app.close();
  }
});
