import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import type { CatalogQuery } from '@donarium/shared';
import { createPool } from '../apps/api/src/db.js';
import { CatalogInputError, PostgresRepository } from '../apps/api/src/catalog/postgres.js';

const testUrl = process.env.TEST_DATABASE_URL;
const defaults: CatalogQuery = { q: '', category: '', tag: '', status: '', page: 1, pageSize: 24, sort: 'newest' };
let pool: Pool;
let repository: PostgresRepository;
before(() => {
  if (!testUrl) return;
  assert.match(decodeURIComponent(new URL(testUrl).pathname.slice(1)), /^donarium_test(?:_[a-z0-9]+)*$/, 'Use a separate test database');
  pool = createPool(testUrl);
  repository = new PostgresRepository(pool);
});
after(async () => { if (pool) await pool.end(); });

test('catalog: optional SKU, Cyrillic search, categories, tags, status, update and deletion', { skip: !testUrl }, async () => {
  const token = randomUUID();
  const category = await repository.createCategory({ name: `Тест ${token}` });
  let productId: string | undefined;
  try {
    const created = await repository.create({ title: `Фигурка Ёж ${token}`, description: 'Коллекционная модель',
      status: 'processing', categoryIds: [category.id], tags: [`Кириллица-${token}`, `кириллица-${token}`] });
    productId = created.id;
    assert.equal(created.sku, null);
    assert.equal(created.status, 'processing');
    assert.equal(created.tags.length, 1);
    assert.equal(created.categories[0]?.id, category.id);
    assert.equal((await repository.get(created.id))?.title, created.title);
    assert.equal((await repository.list({ ...defaults, q: `ЁЖ ${token}` })).items[0]?.id, created.id);
    assert.equal((await repository.list({ ...defaults, q: 'КОЛЛЕКЦИОННАЯ', category: category.slug })).total, 1);
    assert.equal((await repository.list({ ...defaults, tag: `КИРИЛЛИЦА-${token}`, status: 'processing' })).total, 1);
    assert.equal((await repository.list({ ...defaults, tag: `КИРИЛЛИЦА-${token}`, status: 'ready' })).total, 0);
    const changed = await repository.update(created.id, { title: `Обновлено ${token}`, sku: `sku-${token}`, status: 'ready', tags: ['новый'] });
    assert.equal(changed?.sku, `sku-${token}`);
    assert.deepEqual(changed?.categories, []);
    assert.deepEqual(changed?.tags, ['новый']);
    assert.ok(changed && changed.updatedAt >= created.updatedAt);
    assert.equal((await repository.list({ ...defaults, q: `SKU-${token}`, sort: 'updated' })).items[0]?.id, created.id);
    assert.equal(await repository.delete(created.id), true);
    assert.equal(await repository.get(created.id), null);
    assert.equal(await repository.delete(created.id), false);
  } finally {
    if (productId) await repository.delete(productId);
    await pool.query('DELETE FROM categories WHERE id=$1', [category.id]);
    await pool.query('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM product_tags WHERE tag_id=tags.id) AND (name=$1 OR name=$2)', [`кириллица-${token}`, 'новый']);
  }
});

test('catalog: failed metadata edit is atomic, duplicate SKU is rejected, cover belongs to its card', { skip: !testUrl }, async () => {
  const token = randomUUID();
  const first = await repository.create({ title: `First ${token}`, sku: `atomic-${token}`, tags: ['original'] });
  let secondId: string | undefined;
  try {
    await assert.rejects(repository.create({ title: `Invalid ${token}`, categoryIds: [randomUUID()] }), CatalogInputError);
    assert.equal((await repository.list({ ...defaults, q: `Invalid ${token}` })).total, 0);
    await assert.rejects(repository.update(first.id, { title: 'Must not persist', categoryIds: [randomUUID()] }), CatalogInputError);
    assert.equal((await repository.get(first.id))?.title, first.title);
    assert.deepEqual((await repository.get(first.id))?.tags, ['original']);
    await assert.rejects(repository.create({ title: 'Duplicate', sku: first.sku }), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23505');
    const second = await repository.create({ title: `Second ${token}` });
    secondId = second.id;
    const image = await pool.query<{ id: string }>(`INSERT INTO assets (product_id,kind,name,external_url)
      VALUES ($1,'image','cover.png','https://example.invalid/cover.png') RETURNING id`, [first.id]);
    await assert.rejects(repository.update(second.id, { title: second.title, coverAssetId: image.rows[0]!.id }), CatalogInputError);
    const withCover = await repository.update(first.id, { title: first.title, coverAssetId: image.rows[0]!.id });
    assert.equal(withCover?.image?.url, `/api/v1/assets/${image.rows[0]!.id}/thumbnail`);
    await pool.query('DELETE FROM assets WHERE id=$1', [image.rows[0]!.id]);
    assert.equal((await repository.get(first.id))?.coverAssetId, null);
  } finally {
    await repository.delete(first.id);
    if (secondId) await repository.delete(secondId);
    await pool.query("DELETE FROM tags WHERE name='original' AND NOT EXISTS (SELECT 1 FROM product_tags WHERE tag_id=tags.id)");
  }
});
