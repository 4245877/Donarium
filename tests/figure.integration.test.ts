import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app.js';
import { parseStl } from '../apps/web/src/stl.js';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `figure_${randomUUID().replaceAll('-', '')}`;
const stl = 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n';
const reference = { root: 'MODELS', path: 'Фигурки #1/Дракон 100%.STL' };
let app: FastifyInstance, pool: pg.Pool, admin: pg.Pool, temporary: string, library: string, cookie: string;
const headers = () => ({ cookie });
const fileUrl = (action = '', file = reference) => `/api/v1/storage/figure-file${action}?${new URLSearchParams(file)}`;
const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers: headers(), ...(payload === undefined ? {} : { payload }) });
before(async () => {
  if (!testUrl) return;
  assert.match(new URL(testUrl).pathname, /^\/donarium_test(?:_[a-z0-9]+)*$/);
  admin = new pg.Pool({ connectionString: testUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema},public` });
  for (const filename of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(join('db/migrations', filename), 'utf8'));
  temporary = await mkdtemp(join(tmpdir(), 'donarium-figure-')); library = join(temporary, 'library');
  await mkdir(join(library, 'Фигурки #1'), { recursive: true });
  await writeFile(join(library, reference.path), stl);
  await writeFile(join(library, 'replacement.rar'), 'archive fixture');
  await writeFile(join(library, 'notes.txt'), 'not a model');
  await writeFile(join(temporary, 'private.stl'), 'secret outside root');
  await symlink(join(temporary, 'private.stl'), join(library, 'escape.stl'));
  await symlink(temporary, join(library, 'escape-directory'));
  app = await buildApp({ pool, logger: false, config: { host: '127.0.0.1', port: 4180, dataMode: 'postgres', logLevel: 'silent', staticDir: temporary, adminPassword: 'figure-test-password', storageRoots: [{ key: 'MODELS', name: 'Models', path: library }, { key: 'PRIVATE', name: 'Internal', path: temporary, internal: true }], managedRoot: join(temporary, 'uploads'), workRoot: join(temporary, 'work') } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'figure-test-password' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
after(async () => {
  await app?.close(); await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('STL preview parses ASCII and binary, bounds geometry and rejects malformed input', () => {
  const bytes = Buffer.from(stl); const ascii = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(ascii.length, 9); assert.ok(ascii.every(value => Math.abs(value) <= 0.5));
  const binary = new ArrayBuffer(134), view = new DataView(binary); view.setUint32(80, 1, true);
  for (const [index, value] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) view.setFloat32(96 + index * 4, value, true);
  assert.deepEqual(parseStl(binary), ascii);
  view.setFloat32(96, NaN, true); assert.throws(() => parseStl(binary), /геометрию/);
  assert.throws(() => parseStl(new ArrayBuffer(0)), /прочитать/);
  assert.throws(() => parseStl(new ArrayBuffer(33 * 1024 ** 2)), /лимит/);
});

test('figure browser searches live nested paths, filters formats and streams original/preview with auth', { skip: !testUrl }, async () => {
  assert.equal((await app.inject(fileUrl())).statusCode, 401);
  const roots = await app.inject({ url: '/api/v1/storage/roots', headers: headers() });
  assert.ok(!roots.json().roots.some((root: { key: string }) => root.key === 'PRIVATE'));
  const browse = await app.inject({ url: '/api/v1/storage/browse?root=MODELS&figuresOnly=true&pageSize=1', headers: headers() });
  assert.equal(browse.statusCode, 200); assert.equal(browse.json().total, 2); assert.equal(browse.json().entries[0].type, 'directory');
  const search = await app.inject({ url: '/api/v1/storage/figure-search?' + new URLSearchParams({ root: 'MODELS', q: 'дРАКОН' }), headers: headers() });
  assert.equal(search.statusCode, 200, search.body); assert.equal(search.json().entries[0].path, reference.path);
  assert.equal(search.json().entries.length, 1);
  const info = await app.inject({ url: fileUrl(), headers: headers() });
  assert.equal(info.json().sizeBytes, String(Buffer.byteLength(stl)));
  assert.equal((await app.inject({ url: fileUrl('/preview'), headers: headers() })).body, stl);
  const range = await app.inject({ url: fileUrl('/download'), headers: { ...headers(), range: 'bytes=0-4' } });
  assert.equal(range.statusCode, 206); assert.equal(range.body, 'solid');
  assert.match(String(range.headers['content-disposition']), /attachment/);
  assert.equal((await app.inject({ url: fileUrl('/preview', { root: 'MODELS', path: 'replacement.rar' }), headers: headers() })).statusCode, 400);
});

test('figure selection is atomic, idempotent, replaceable and detachable without copying or deleting originals', { skip: !testUrl }, async () => {
  const originalStat = await stat(join(library, reference.path));
  let response = await call('POST', '/api/v1/products', { title: 'Фигурка', figureFile: reference });
  assert.equal(response.statusCode, 201, response.body); const id = response.json().item.id;
  const url = `/api/v1/products/${id}`;
  let product = response.json().item; const assetId = product.figureFile.id;
  assert.equal(product.figureFile.relativePath, reference.path); assert.equal(product.figureFile.storageKey, 'MODELS');
  assert.equal(product.assets.length, 1); assert.equal(product.figureFile.externalUrl, null);
  response = await call('PUT', url, { title: 'Повтор', figureFile: reference });
  assert.equal(response.json().item.figureFile.id, assetId);
  response = await call('PUT', url, { title: 'Обычная правка' });
  assert.equal(response.json().item.figureFile.id, assetId);
  response = await call('PUT', url, { title: 'Не сохранять', figureFile: { root: 'MODELS', path: 'missing.stl' } });
  assert.equal(response.statusCode, 404);
  product = (await app.inject({ url, headers: headers() })).json().item;
  assert.equal(product.title, 'Обычная правка'); assert.equal(product.figureFile.id, assetId);
  const failedCreate = await call('POST', '/api/v1/products', { title: 'Откат создания', figureFile: { root: 'MODELS', path: 'missing.stl' } });
  assert.equal(failedCreate.statusCode, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM products WHERE title='Откат создания'")).rows[0].n, 0);
  response = await call('PUT', url, { title: 'Замена', figureFile: { root: 'MODELS', path: 'replacement.rar' } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().item.figureFile.name, 'replacement.rar'); assert.equal(response.json().item.assets.length, 1);
  const simultaneous = await Promise.all([reference, { root: 'MODELS', path: 'replacement.rar' }].map(figureFile => call('PUT', url, { title: 'Одновременная правка', figureFile })));
  assert.ok(simultaneous.every(result => result.statusCode === 200));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM assets WHERE product_id=$1 AND metadata->>'role'='figure'", [id])).rows[0].n, 1);
  response = await call('PUT', url, { title: 'Без файла', figureFile: null });
  assert.equal(response.json().item.figureFile, null); assert.deepEqual(response.json().item.assets, []);
  assert.equal(await readFile(join(library, reference.path), 'utf8'), stl); assert.equal((await stat(join(library, reference.path))).ino, originalStat.ino);
  assert.equal(await readFile(join(library, 'replacement.rar'), 'utf8'), 'archive fixture');
  assert.deepEqual(await readdir(join(temporary, 'uploads')), []);
  await call('PUT', url, { title: 'Удаление карточки', figureFile: reference }); await call('DELETE', url);
  assert.equal(await readFile(join(library, reference.path), 'utf8'), stl);
});

test('figure reuses existing attachment; invalid paths, symlinks, hidden roots, wrong types and changed files are rejected', { skip: !testUrl }, async () => {
  const created = await call('POST', '/api/v1/products', { title: 'Security' }); const url = `/api/v1/products/${created.json().item.id}`;
  const linked = await call('POST', `${url}/assets/link`, { root: 'MODELS', paths: [reference.path] }); assert.equal(linked.statusCode, 200);
  const selected = await call('PUT', url, { title: 'Reused', figureFile: reference }); assert.equal(selected.json().item.assets.length, 1);
  const existingId = selected.json().item.figureFile.id;
  await pool.query('UPDATE assets SET retired_at=now() WHERE id=$1', [existingId]);
  const reactivated = await call('PUT', url, { title: 'Reactivated', figureFile: reference });
  assert.equal(reactivated.json().item.figureFile.id, existingId);
  for (const file of [
    { root: 'MODELS', path: '../private.stl' }, { root: 'MODELS', path: '/etc/private.stl' },
    { root: 'MODELS', path: '\\\\192.168.0.141\\library\\model.stl' }, { root: 'MODELS', path: 'escape.stl' },
    { root: 'MODELS', path: 'escape-directory/private.stl' }, { root: 'MODELS', path: 'notes.txt' },
    { root: 'PRIVATE', path: 'private.stl' }, { root: 'UNKNOWN', path: 'part.stl' },
  ]) {
    const response = await call('PUT', url, { title: 'Must not persist', figureFile: file });
    assert.ok([400, 403, 404].includes(response.statusCode), response.body);
    assert.ok(!response.body.includes(temporary));
  }
  const csrf = await app.inject({ method: 'PUT', url, headers: { ...headers(), origin: 'https://attacker.example' }, payload: { title: 'CSRF', figureFile: reference } });
  assert.equal(csrf.statusCode, 403);
  await writeFile(join(library, 'changed.stl'), stl);
  const ref = { root: 'MODELS', path: 'changed.stl' };
  assert.equal((await call('PUT', url, { title: 'Changed', figureFile: ref })).statusCode, 200);
  await writeFile(join(library, 'changed.stl'), stl + '\n');
  assert.equal((await call('PUT', url, { title: 'Do not save', figureFile: ref })).statusCode, 409);
  await rm(join(library, 'changed.stl'));
  const missing = await app.inject({ url: fileUrl('', ref), headers: headers() }); assert.equal(missing.statusCode, 404);
  const metadataOnly = await call('PUT', url, { title: 'Metadata still editable' }); assert.equal(metadataOnly.statusCode, 200);
  const cleared = await call('PUT', url, { title: 'Cleared missing link', figureFile: null }); assert.equal(cleared.statusCode, 200);
});

test('figure search and preview enforce result and byte limits', { skip: !testUrl }, async () => {
  await mkdir(join(library, 'bounded'));
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(library, 'bounded', `result-${index}.stl`), stl)));
  const response = await app.inject({ url: '/api/v1/storage/figure-search?root=MODELS&path=bounded&q=result', headers: headers() });
  assert.equal(response.json().entries.length, 200); assert.equal(response.json().truncated, true);
  const { open } = await import('node:fs/promises'); const large = await open(join(library, 'large.stl'), 'w');
  try { await large.truncate(33 * 1024 ** 2); } finally { await large.close(); }
  const preview = await app.inject({ url: fileUrl('/preview', { root: 'MODELS', path: 'large.stl' }), headers: headers() });
  assert.equal(preview.statusCode, 413);
  for (const url of ['/api/v1/storage/browse?root=PRIVATE', '/api/v1/storage/figure-search?root=PRIVATE&q=private']) {
    assert.equal((await app.inject({ url, headers: headers() })).statusCode, 403);
  }
});
