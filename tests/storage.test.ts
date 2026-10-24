import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, readFile, readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { StorageError, StorageService, safeRelativePath } from '../apps/api/src/storage/service.js';
import { FolderImports } from '../apps/api/src/storage/imports.js';
import type { Pool } from 'pg';

const temporary = await mkdtemp(join(tmpdir(), 'donarium-storage-'));
const original = join(temporary, 'library');
const outside = join(temporary, 'outside');
await mkdir(original); await mkdir(outside);
await writeFile(join(outside, 'secret.stl'), 'private');
await mkdir(join(original, 'Модели'));
await writeFile(join(original, 'Модели', 'dragon.stl'), 'solid dragon\nendsolid dragon\n');
const service = new StorageService({ storageRoots: [{ key: 'TEST', name: 'Тестовая библиотека', path: original }],
  managedRoot: join(temporary, 'uploads'), workRoot: join(temporary, 'work'), maxUploadBytes: 1024 });
await service.init();
after(async () => { await rm(temporary, { recursive: true, force: true }); });

test('storage rejects traversal, absolute paths, backslashes, Windows paths and special characters', async () => {
  for (const path of ['../outside/secret.stl', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', 'C:/Windows/file', 'a\nb']) {
    assert.throws(() => safeRelativePath(path), StorageError, path);
    await assert.rejects(service.open('TEST', path), StorageError, path);
  }
  await assert.rejects(service.open('UNAUTHORIZED', 'file'), StorageError);
  const file = await service.open('TEST', 'Модели/dragon.stl');
  assert.equal(file.stat.isFile(), true); await file.handle.close();
  assert.equal(await service.hash('TEST', 'Модели/dragon.stl'), createHash('sha256').update(await readFile(join(original, 'Модели', 'dragon.stl'))).digest('hex'));
});

test('storage never follows symlink files, symlink directories or configured root symlinks', async () => {
  await symlink(outside, join(original, 'escape'));
  await symlink(join(outside, 'secret.stl'), join(original, 'secret.stl'));
  await symlink(original, join(temporary, 'root-link'));
  for (const path of ['escape/secret.stl', 'secret.stl']) {
    await assert.rejects(service.open('TEST', path), StorageError);
    await assert.rejects(service.resolve('TEST', path), StorageError);
  }
  const linked = new StorageService({ storageRoots: [{ key: 'LINK', name: 'Link', path: join(temporary, 'root-link') }], managedRoot: service.managedRoot, workRoot: service.workRoot });
  await assert.rejects(linked.open('LINK', 'Модели/dragon.stl'), StorageError);
  const listing = await service.browse('TEST', '');
  assert.ok(!listing.entries.some(entry => entry.name === 'escape' || entry.name === 'secret.stl'));
});

test('already opened file stays attached to the original inode after symlink replacement', async () => {
  await writeFile(join(original, 'race.stl'), 'original');
  const file = await service.open('TEST', 'race.stl');
  await rename(join(original, 'race.stl'), join(original, 'race-original.stl'));
  await symlink(join(outside, 'secret.stl'), join(original, 'race.stl'));
  assert.equal(await file.handle.readFile('utf8'), 'original');
  await file.handle.close();
  await assert.rejects(service.open('TEST', 'race.stl'), StorageError);
});

test('uploads stream into a new managed folder, checksum matches, and originals stay unchanged', async () => {
  const before = await readFile(join(original, 'Модели', 'dragon.stl'));
  const uploaded = await service.writeUpload(Readable.from([Buffer.from('part 1'), Buffer.from('part 2')]), 'Модель.stl');
  assert.equal(uploaded.sizeBytes, '12');
  assert.equal(uploaded.sha256, createHash('sha256').update('part 1part 2').digest('hex'));
  assert.equal(await service.hash(uploaded.root, uploaded.relativePath), uploaded.sha256);
  assert.deepEqual(await readFile(join(original, 'Модели', 'dragon.stl')), before);
  await assert.rejects(service.writeUpload(Readable.from(['bad']), '../escape.stl'), StorageError);
});

test('oversize upload is rejected and partial content is removed', async () => {
  await assert.rejects(service.writeUpload(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 'too-large.stl'), (error: unknown) => error instanceof StorageError && error.statusCode === 413);
  for (const folder of await readdir(service.managedRoot)) assert.ok(!(await readdir(join(service.managedRoot, folder))).includes('too-large.stl'));
});

test('folder scan creates a bounded preview, detects nested files and never modifies originals', async () => {
  await mkdir(join(original, 'Anime', 'Honolulu'), { recursive: true });
  await writeFile(join(original, 'Anime', 'Honolulu', 'model.3mf'), 'test model');
  await writeFile(join(original, 'Anime', 'Honolulu', 'cover.jpg'), 'test image');
  const fakePool = { query: async (sql: string) => sql.includes('INSERT INTO storage_locations')
    ? { rows: [{ id: '00000000-0000-4000-8000-000000000001' }] }
    : { rows: [{ relative_path: 'Модели', product_id: '00000000-0000-4000-8000-000000000002' }] } } as unknown as Pool;
  const imports = new FolderImports(service, fakePool);
  try {
    const id = await imports.scan('TEST', '');
    for (let i = 0; imports.get(id).status === 'scanning' && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const job = imports.get(id);
    assert.equal(job.status, 'preview');
    assert.equal(job.items.find(item => item.path === 'Anime/Honolulu')?.cover, 'Anime/Honolulu/cover.jpg');
    assert.equal(job.items.find(item => item.path === 'Модели')?.existingProductId, '00000000-0000-4000-8000-000000000002');
    assert.ok(!job.items.some(item => item.path.startsWith('escape')));
    assert.equal(await readFile(join(original, 'Anime', 'Honolulu', 'model.3mf'), 'utf8'), 'test model');
    imports.cancel(id);
    assert.equal(imports.get(id).status, 'cancelled');
    assert.throws(() => imports.confirm(id, ['Anime/Honolulu']), StorageError);
  } finally { await imports.close(); }
});
