import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import yauzl from 'yauzl';
import sharp from 'sharp';
import { PostgresRepository } from '../apps/api/src/catalog/postgres.js';
import { registerStorageRoutes } from '../apps/api/src/storage/routes.js';

const testUrl = process.env.TEST_DATABASE_URL;
let maintenance: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;
let temporary: string;
let root: string;
let repository: PostgresRepository;
const schema = `storage_${randomUUID().replaceAll('-', '')}`;
before(async () => {
  if (!testUrl) return;
  assert.match(decodeURIComponent(new URL(testUrl).pathname.slice(1)), /^donarium_test(?:_[a-z0-9]+)*$/, 'Only a separate test database is allowed');
  maintenance = new pg.Pool({ connectionString: testUrl });
  await maintenance.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await maintenance.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema},public` });
  for (const migration of (await readdir(new URL('../db/migrations/', import.meta.url))).sort()) {
    if (migration.endsWith('.sql')) await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  temporary = await mkdtemp(join(tmpdir(), 'donarium-files-integration-'));
  root = join(temporary, 'library'); await mkdir(root);
  await writeFile(join(root, 'model.stl'), 'solid test\nendsolid test\n');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#8060a0' } }).png().toFile(join(root, 'cover.png'));
  await writeFile(join(temporary, 'secret.txt'), 'private marker');
  await symlink(join(temporary, 'secret.txt'), join(root, 'escape.txt'));
  repository = new PostgresRepository(pool);
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: { message: error instanceof Error ? error.message : 'Request failed' } }));
  await registerStorageRoutes(app, pool, repository, { host: '127.0.0.1', port: 4180, dataMode: 'postgres', logLevel: 'silent', staticDir: temporary,
    storageRoots: [{ key: 'TEST', name: 'Test', path: root }], managedRoot: join(temporary, 'uploads'), workRoot: join(temporary, 'work'), maxUploadBytes: 1024 * 1024 });
});
after(async () => {
  await app?.close(); await pool?.end();
  if (maintenance) { await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await maintenance.end(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function zipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('entry', entry => zip.openReadStream(entry, (readError, stream) => {
        if (readError || !stream) return reject(readError);
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
        stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      }));
      zip.on('end', () => resolve(entries)); zip.readEntry();
    });
  });
}
async function waitJob(id: string) {
  for (let i = 0; i < 500; i++) {
    const response = await app.inject(`/api/v1/imports/jobs/${id}`);
    const job = response.json();
    if (!['scanning', 'importing'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Import job timeout');
}

test('files API: real link, download, thumbnail, ZIP64, upload, missing file and safe unlink', { skip: !testUrl }, async () => {
  const product = await repository.create({ title: 'Файлы и фотографии' });
  let response = await app.inject({ method: 'POST', url: `/api/v1/products/${product.id}/assets/link`, payload: { root: 'TEST', paths: ['model.stl', 'cover.png'] } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().linked, 2);
  response = await app.inject({ method: 'POST', url: `/api/v1/products/${product.id}/assets/link`, payload: { root: 'TEST', paths: ['model.stl'] } });
  assert.equal(response.json().skipped, 1);
  const linked = (await repository.get(product.id))!;
  const model = linked.assets.find(asset => asset.name === 'model.stl')!;
  const image = linked.assets.find(asset => asset.name === 'cover.png')!;
  response = await app.inject(`/api/v1/assets/${model.id}/download`);
  assert.equal(response.statusCode, 200); assert.equal(response.body, 'solid test\nendsolid test\n');
  response = await app.inject(`/api/v1/assets/${image.id}/thumbnail`);
  assert.equal(response.statusCode, 200, response.body); assert.match(String(response.headers['content-type']), /image\/webp/);
  const images = await Promise.all(Array.from({ length: 8 }, () => app.inject(`/api/v1/assets/${image.id}/thumbnail`)));
  assert.ok(images.every(result => result.statusCode === 200));
  response = await app.inject(`/api/v1/products/${product.id}/download.zip`);
  assert.equal(response.statusCode, 200, response.body);
  const entries = await zipEntries(response.rawPayload);
  assert.equal(entries.size, 2); assert.equal(entries.get(`${model.id}/model.stl`)?.toString(), 'solid test\nendsolid test\n');
  response = await app.inject({ method: 'PUT', url: `/api/v1/products/${product.id}/assets/upload?name=uploaded.stl`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('upload bytes') });
  assert.equal(response.statusCode, 201, response.body);
  const uploaded = response.json().asset;
  assert.equal(uploaded.sha256, createHash('sha256').update('upload bytes').digest('hex'));
  assert.equal((await app.inject(`/api/v1/assets/${uploaded.id}/download`)).body, 'upload bytes');
  for (const path of ['../secret.txt', 'escape.txt']) {
    response = await app.inject({ method: 'POST', url: `/api/v1/products/${product.id}/assets/link`, payload: { root: 'TEST', paths: [path] } });
    assert.ok([400, 403, 404].includes(response.statusCode), response.body);
    assert.ok(!response.body.includes('private marker'));
  }
  await rm(join(root, 'model.stl'));
  response = await app.inject(`/api/v1/products/${product.id}/assets/status`);
  assert.equal(response.json().items.find((item: { id: string }) => item.id === model.id).status, 'missing');
  assert.equal((await app.inject(`/api/v1/assets/${model.id}/download`)).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/products/${product.id}/assets/${image.id}` })).statusCode, 204);
  assert.ok((await readFile(join(root, 'cover.png'))).length > 0);
  await repository.delete(product.id);
  assert.ok((await readFile(join(temporary, 'uploads', uploaded.relativePath))).length > 0);
});

test('folder import API previews nested library, recognizes covers, is idempotent and preserves originals', { skip: !testUrl }, async () => {
  const folder = join(root, 'Anime', 'Honolulu'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'part_01.stl'), 'part 1');
  await writeFile(join(folder, 'part_02.stl'), 'part 2');
  await sharp({ create: { width: 24, height: 24, channels: 3, background: '#a080c0' } }).jpeg().toFile(join(folder, 'cover.jpg'));
  let importedId: string | undefined;
  for (let run = 0; run < 2; run++) {
    if (run === 1) await writeFile(join(folder, 'part_01.stl'), 'part one updated');
    const start = await app.inject({ method: 'POST', url: '/api/v1/imports/scan', payload: { root: 'TEST', path: 'Anime' } });
    assert.equal(start.statusCode, 202, start.body);
    const preview = await waitJob(start.json().jobId);
    assert.equal(preview.status, 'preview'); assert.equal(preview.total, 1);
    assert.equal(preview.items[0].cover, 'Anime/Honolulu/cover.jpg');
    if (run === 1) assert.equal(preview.items[0].existingProductId, importedId);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/imports/jobs/${preview.id}/confirm`, payload: { paths: ['Anime/Honolulu'] } });
    assert.equal(confirmed.statusCode, 202, confirmed.body);
    const completed = await waitJob(preview.id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.report.errors, 0);
    assert.equal(completed.report[run ? 'updated' : 'created'], 1);
    const result = await pool.query<{ id: string; count: string }>(`SELECT p.id,(SELECT count(*) FROM assets WHERE product_id=p.id)::text AS count
      FROM products p JOIN import_sources i ON i.product_id=p.id WHERE i.relative_path='Anime/Honolulu'`);
    assert.equal(result.rowCount, 1); assert.equal(result.rows[0]!.count, '3'); importedId = result.rows[0]!.id;
    const card = (await repository.get(importedId))!;
    assert.ok(card.coverAssetId);
    assert.equal(card.assets.find(asset => asset.name === 'part_01.stl')?.sizeBytes, String(Buffer.byteLength(run ? 'part one updated' : 'part 1')));
  }
  assert.equal(await readFile(join(folder, 'part_01.stl'), 'utf8'), 'part one updated');
});

test('folder import adopts one manually linked card and rejects ambiguous, different-source and changed associations', { skip: !testUrl }, async () => {
  const path = 'Manual/CrystalDragon';
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, 'model.stl'), 'manual model original');
  await sharp({ create: { width: 24, height: 24, channels: 3, background: '#a080c0' } }).png().toFile(join(root, path, 'cover.png'));
  const manual = await repository.create({ title: 'Существующая карточка', description: 'Сохранить описание', tags: ['ручная привязка'] });
  const link = async (id: string, file: string) => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/products/${id}/assets/link`, payload: { root: 'TEST', paths: [file] } });
    assert.equal(response.statusCode, 200, response.body);
  };
  const scan = async (folder: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/imports/scan', payload: { root: 'TEST', path: folder } });
    assert.equal(response.statusCode, 202, response.body);
    const preview = await waitJob(response.json().jobId);
    assert.equal(preview.status, 'preview', JSON.stringify(preview));
    return preview;
  };
  await link(manual.id, `${path}/model.stl`);
  const countBefore = (await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count;
  const preview = await scan(path);
  assert.equal(preview.total, 1); assert.equal(preview.items[0].existingProductId, manual.id);
  const confirmed = await app.inject({ method: 'POST', url: `/api/v1/imports/jobs/${preview.id}/confirm`, payload: { paths: [path] } });
  assert.equal(confirmed.statusCode, 202, confirmed.body);
  const completed = await waitJob(preview.id);
  assert.deepEqual(completed.report, { created: 0, updated: 1, skipped: 0, errors: 0 });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count, countBefore, 'Manual links must not produce a second card');
  const adopted = (await repository.get(manual.id))!;
  assert.equal(adopted.title, manual.title); assert.equal(adopted.description, manual.description); assert.deepEqual(adopted.tags, manual.tags);
  assert.equal(adopted.assets.length, 2); assert.ok(adopted.coverAssetId);
  const source = await pool.query('SELECT product_id FROM import_sources WHERE relative_path=$1', [path]);
  assert.equal(source.rowCount, 1); assert.equal(source.rows[0].product_id, manual.id);

  const second = await repository.create({ title: 'Вторая карточка' });
  await link(second.id, `${path}/model.stl`);
  const ambiguous = await scan(path);
  assert.equal(ambiguous.total, 0);
  assert.ok(ambiguous.errors.some((error: string) => /несколькими карточками/.test(error)), JSON.stringify(ambiguous));
  const other = 'Manual/OtherFolder'; await mkdir(join(root, other));
  await writeFile(join(root, other, 'model.stl'), 'other original');
  await link(manual.id, `${other}/model.stl`);
  const differentSource = await scan(other);
  assert.equal(differentSource.total, 0);
  assert.ok(differentSource.errors.some((error: string) => /другой папки/.test(error)), JSON.stringify(differentSource));

  const changedPath = 'Manual/ChangedAfterPreview'; await mkdir(join(root, changedPath));
  await writeFile(join(root, changedPath, 'model.stl'), 'changed links original');
  const changed = await scan(changedPath);
  assert.equal(changed.total, 1); assert.equal(changed.items[0].existingProductId, null);
  await link(second.id, `${changedPath}/model.stl`);
  await app.inject({ method: 'POST', url: `/api/v1/imports/jobs/${changed.id}/confirm`, payload: { paths: [changedPath] } });
  const rejected = await waitJob(changed.id);
  assert.equal(rejected.report.created, 0); assert.equal(rejected.report.errors, 1);
  assert.ok(rejected.errors.some((error: string) => /Связи изменились/.test(error)));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count, countBefore + 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM import_sources WHERE relative_path=ANY($1::text[])', [[other, changedPath]])).rows[0].count, 0);
  assert.equal(await readFile(join(root, path, 'model.stl'), 'utf8'), 'manual model original');
  assert.equal(await readFile(join(root, other, 'model.stl'), 'utf8'), 'other original');
});
