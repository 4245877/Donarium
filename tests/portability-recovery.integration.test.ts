import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { ZipFile } from 'yazl';
import Fastify from 'fastify';
import type { Config } from '../apps/api/src/config.js';
import { TransferService } from '../apps/api/src/transfer/service.js';
import { TABLES, type Manifest, type Row, type TableName } from '../apps/api/src/transfer/format.js';
import { PostgresRepository } from '../apps/api/src/catalog/postgres.js';
import { registerStorageRoutes } from '../apps/api/src/storage/routes.js';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
let maintenance: pg.Pool;
let pool: pg.Pool;
let temporary: string;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixtures = new Map([
  ['model.stl', Buffer.from('solid recovery\nendsolid recovery\n')],
  ['documentation.txt', Buffer.from('Оригинальная документация\n')],
]);
const productId = randomUUID();
const assetIds = new Map([...fixtures.keys()].map(name => [name, randomUUID()]));

before(async () => {
  if (!testUrl) return;
  assert.match(decodeURIComponent(new URL(testUrl).pathname.slice(1)), /^donarium_test(?:_[a-z0-9]+)*$/, 'Use only a separate DONARIUM test database');
  maintenance = new pg.Pool({ connectionString: testUrl });
  await maintenance.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await maintenance.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema},public` });
  for (const name of (await readdir(new URL('../db/migrations/', import.meta.url))).sort()) {
    if (name.endsWith('.sql')) await pool.query(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  temporary = await mkdtemp(join(tmpdir(), 'donarium-recovery-'));
  await mkdir(join(temporary, 'originals'));
  for (const [name, bytes] of fixtures) await writeFile(join(temporary, 'originals', name), bytes);
});
after(async () => {
  await pool?.end();
  if (maintenance) { await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await maintenance.end(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function config(kind: string): Config {
  return { host: '127.0.0.1', port: 4180, dataMode: 'postgres', logLevel: 'silent', staticDir: join(temporary, 'no-static'),
    storageRoots: [{ key: 'ORIGINALS', name: 'Untouched originals', path: join(temporary, 'originals') }],
    managedRoot: join(temporary, kind, 'uploads'), workRoot: join(temporary, kind, 'work'), maxArchiveBytes: 1024 * 1024 };
}
async function assertOriginals() {
  for (const [name, expected] of fixtures) {
    const bytes = await readFile(join(temporary, 'originals', name));
    assert.deepEqual(bytes, expected, `Original contents: ${name}`);
    assert.equal(digest(bytes), digest(expected), `Original checksum: ${name}`);
  }
}
async function archiveFixture() {
  const createdAt = new Date().toISOString();
  const categoryId = randomUUID(), tagId = randomUUID();
  const data: Record<TableName, Row[]> = {
    products: [{ id: productId, sku: null, title: 'Восстанавливаемая модель', description: 'Проверка отката', status: 'ready', cover_asset_id: null,
      image_url: null, image_alt: null, source_url: null, created_at: createdAt, updated_at: createdAt }],
    categories: [{ id: categoryId, slug: 'recovery', name: 'Восстановление', parent_id: null }],
    tags: [{ id: tagId, name: 'Откат' }],
    product_categories: [{ product_id: productId, category_id: categoryId }],
    product_tags: [{ product_id: productId, tag_id: tagId }],
    assets: [...fixtures].map(([name, bytes]) => ({ id: assetIds.get(name), product_id: productId, kind: name.endsWith('.stl') ? 'model' : 'other',
      name, media_type: 'application/octet-stream', size_bytes: String(bytes.length), sha256: digest(bytes), version: null, external_url: null,
      created_at: createdAt, origin: 'external', archive_path: `files/${assetIds.get(name)}/${name}` })),
    external_links: [],
  };
  const zip = new ZipFile();
  const manifest: Manifest = { format: 'donarium', version: 1, createdAt, tables: {} as Manifest['tables'] };
  for (const table of TABLES) {
    const bytes = Buffer.from(data[table].map(row => JSON.stringify(row) + '\n').join(''));
    manifest.tables[table] = { count: data[table].length, sha256: digest(bytes) };
    zip.addBuffer(bytes, `${table}.ndjson`);
  }
  for (const [name, bytes] of fixtures) zip.addBuffer(bytes, `files/${assetIds.get(name)}/${name}`);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  const collected = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.on('error', reject); zip.outputStream.on('error', reject);
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  zip.end({ forceZip64Format: true, comment: '' });
  return collected;
}
async function waitJob(service: TransferService, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const job = service.get(id);
    if (!['running', 'uploading'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Recovery job timeout');
}

test('restore rolls back metadata and moved files when COMMIT fails, then succeeds on retry', { skip: !testUrl }, async () => {
  const settings = config('rollback');
  const service = new TransferService(pool, settings);
  await service.init();
  let triggerInstalled = false;
  try {
    await pool.query(`CREATE FUNCTION reject_recovery_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected deferred restore failure'; END; $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_recovery_commit AFTER INSERT ON assets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_recovery_commit()`);
    triggerInstalled = true;
    const archive = await archiveFixture();
    const uploaded = await service.upload(Readable.from([archive]));
    assert.equal((await waitJob(service, uploaded.id)).status, 'ready');
    await service.confirm(uploaded.id, 'skip');
    const failed = await waitJob(service, uploaded.id);
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.ok(failed.error);
    // A deferred constraint fires at COMMIT, after files have already moved into their final directory.
    for (const table of [...TABLES, 'storage_locations', 'transfer_receipts']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table} must roll back`);
    }
    assert.equal(await stat(join(settings.managedRoot!, 'restored', uploaded.id)).then(() => true, () => false), false, 'Failed commit must leave no final files');
    for (const [name, expected] of fixtures) {
      const staged = join(settings.managedRoot!, `.restore-stage-${uploaded.id}`, 'files', assetIds.get(name)!, name);
      assert.deepEqual(await readFile(staged), expected, 'Moved files return to staging after rollback');
    }
    await assertOriginals();
    await pool.query('DROP TRIGGER reject_recovery_commit ON assets'); triggerInstalled = false;
    await pool.query('DROP FUNCTION reject_recovery_commit()');
    const retry = await service.upload(Readable.from([archive]));
    assert.equal((await waitJob(service, retry.id)).status, 'ready');
    await service.confirm(retry.id, 'skip');
    const restored = await waitJob(service, retry.id);
    assert.equal(restored.status, 'completed', JSON.stringify(restored));
    assert.equal(restored.result?.imported, 1); assert.equal(restored.result?.assets, fixtures.size);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM transfer_receipts WHERE id=$1', [retry.id])).rows[0].count, 1);
    for (const [name, expected] of fixtures) {
      assert.deepEqual(await readFile(join(settings.managedRoot!, 'restored', retry.id, assetIds.get(name)!, name)), expected);
    }
    await assertOriginals();
  } finally {
    await service.close();
    if (triggerInstalled) await pool.query('DROP TRIGGER IF EXISTS reject_recovery_commit ON assets');
    await pool.query('DROP FUNCTION IF EXISTS reject_recovery_commit()');
  }
});

test('restart uses a commit receipt to retain completed files and returns uncommitted files to staging', { skip: !testUrl }, async () => {
  const settings = config('restart');
  await mkdir(settings.workRoot!, { recursive: true });
  await mkdir(settings.managedRoot!, { recursive: true });
  const committedId = randomUUID(), interruptedId = randomUUID();
  const committedResult = { imported: 1, assets: 1, skipped: 0, copied: 0 };
  for (const id of [committedId, interruptedId]) {
    const directory = join(settings.workRoot!, `transfer-${id}`);
    await mkdir(directory);
    await writeFile(join(directory, 'job.json'), JSON.stringify({ id, kind: 'restore', status: 'running', progress: 1,
      createdAt: new Date().toISOString(), directory: '/untrusted-old-location' }));
    await mkdir(join(settings.managedRoot!, `.restore-stage-${id}`));
    await writeFile(join(settings.managedRoot!, `.restore-stage-${id}`, 'metadata-marker'), 'keep staging metadata');
    await mkdir(join(settings.managedRoot!, 'restored', id, 'fixture'), { recursive: true });
    await writeFile(join(settings.managedRoot!, 'restored', id, 'fixture', 'model.stl'), fixtures.get('model.stl')!);
  }
  await pool.query('INSERT INTO transfer_receipts(id,result) VALUES($1,$2)', [committedId, committedResult]);
  const restarted = new TransferService(pool, settings);
  try {
    await restarted.init();
    const committed = restarted.get(committedId);
    assert.equal(committed.status, 'completed'); assert.deepEqual(committed.result, committedResult); assert.equal(committed.error, undefined);
    assert.deepEqual(await readFile(join(settings.managedRoot!, 'restored', committedId, 'fixture', 'model.stl')), fixtures.get('model.stl'));
    const interrupted = restarted.get(interruptedId);
    assert.equal(interrupted.status, 'failed'); assert.match(interrupted.error!, /перезапуском/);
    assert.equal(await stat(join(settings.managedRoot!, 'restored', interruptedId)).then(() => true, () => false), false);
    assert.deepEqual(await readFile(join(settings.managedRoot!, `.restore-stage-${interruptedId}`, 'files', 'fixture', 'model.stl')), fixtures.get('model.stl'));
    const persisted = JSON.parse(await readFile(join(settings.workRoot!, `transfer-${interruptedId}`, 'job.json'), 'utf8'));
    assert.equal(persisted.status, 'failed'); assert.equal(persisted.directory, join(settings.workRoot!, `transfer-${interruptedId}`));
    await restarted.cancel(committedId);
    assert.deepEqual(await readFile(join(settings.managedRoot!, 'restored', committedId, 'fixture', 'model.stl')), fixtures.get('model.stl'), 'Deleting a finished job must retain committed library files');
    await assertOriginals();
  } finally { await restarted.close(); }
});

test('a lost COMMIT response is resolved through its durable receipt and restored files remain downloadable', { skip: !testUrl }, async () => {
  const settings = config('lost-commit-response');
  const beforeProducts = (await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count;
  const beforeAssets = (await pool.query('SELECT count(*)::int AS count FROM assets')).rows[0].count;
  let lostResponse = false;
  let receiptLookups = 0;
  // The transaction really commits in PostgreSQL. Only its acknowledgement is lost.
  // Pool-level queries use the untouched real pool, so receipt reconciliation gets another connection.
  const uncertainPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, member) {
            if (member === 'query') return async (sql: string, values?: unknown[]) => {
              const result = await connection.query(sql, values);
              if (sql.trim().toUpperCase() === 'COMMIT' && !lostResponse) {
                lostResponse = true;
                throw Object.assign(new Error('Simulated connection loss after committed transaction'), { code: 'ECONNRESET' });
              }
              return result;
            };
            const value = Reflect.get(connection, member, connection);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('SELECT result FROM transfer_receipts')) receiptLookups++;
        return target.query(sql, values);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new TransferService(uncertainPool, settings);
  const downloads = Fastify();
  try {
    await service.init();
    const uploaded = await service.upload(Readable.from([await archiveFixture()]));
    assert.equal((await waitJob(service, uploaded.id)).status, 'ready');
    await service.confirm(uploaded.id, 'copy');
    const result = await waitJob(service, uploaded.id);
    assert.equal(lostResponse, true, 'The test must lose an actual COMMIT acknowledgement');
    assert.ok(receiptLookups > 0, 'The uncertain outcome must be checked through the durable receipt');
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result?.imported, 1); assert.equal(result.result?.assets, fixtures.size);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM products')).rows[0].count, beforeProducts + 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM assets')).rows[0].count, beforeAssets + fixtures.size);
    const receipt = await pool.query('SELECT result FROM transfer_receipts WHERE id=$1', [uploaded.id]);
    assert.equal(receipt.rowCount, 1); assert.deepEqual(receipt.rows[0].result, result.result);
    const assets = await pool.query<{ id: string; name: string; relative_path: string; sha256: string }>(
      'SELECT id,name,relative_path,sha256 FROM assets WHERE relative_path LIKE $1', [`restored/${uploaded.id}/%`]);
    assert.equal(assets.rowCount, fixtures.size);
    await registerStorageRoutes(downloads, pool, new PostgresRepository(pool), settings);
    for (const asset of assets.rows) {
      const response = await downloads.inject(`/api/v1/assets/${asset.id}/download`);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, fixtures.get(asset.name));
      assert.equal(digest(response.rawPayload), asset.sha256);
    }
    await service.cancel(uploaded.id);
    for (const asset of assets.rows) {
      assert.equal((await downloads.inject(`/api/v1/assets/${asset.id}/download`)).statusCode, 200, 'Removing the transfer job must retain committed files');
    }
    await assertOriginals();
  } finally { await downloads.close(); await service.close(); }
});
