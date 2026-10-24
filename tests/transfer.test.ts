import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { extractArchive, rows, TABLES, validateArchive, validateRow, type Manifest, type Row, type TableName } from '../apps/api/src/transfer/format.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function temporary(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'donarium-transfer-security-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small real ZIP fixtures permit malicious names that safe ZIP writers reject. */
function zip(entries: { name: string; data?: string; mode?: number; flags?: number }[]) {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data ?? '{}');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(item.flags ?? 0x800, 6); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags ?? 0x800, 8); central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0o100600) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
const product = (id = randomUUID()): Row => ({ id, sku: null, title: 'Тестовая фигурка', description: 'Описание', status: 'ready',
  cover_asset_id: null, image_url: null, image_alt: null, source_url: null,
  created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-02-03T04:05:06.000Z' });
const asset = (productId: string, content = 'STL fixture'): Row => {
  const id = randomUUID();
  return { id, product_id: productId, kind: 'model', name: 'модель.stl', media_type: 'model/stl', size_bytes: String(Buffer.byteLength(content)),
    sha256: hash(content), version: null, created_at: '2026-01-02T03:04:05.000Z', origin: 'external', external_url: null, archive_path: `files/${id}/model.stl` };
};
async function fixture(directory: string, records: Partial<Record<TableName, Row[]>> = {}, files: Record<string, string> = {}) {
  await mkdir(directory, { recursive: true });
  const manifest: Manifest = { format: 'donarium', version: 1, createdAt: '2026-01-02T03:04:05.000Z', tables: {} as Manifest['tables'] };
  const entries = new Set(['manifest.json']);
  for (const table of TABLES) {
    const value = (records[table] ?? []).map(row => JSON.stringify(row) + '\n').join('');
    manifest.tables[table] = { count: records[table]?.length ?? 0, sha256: hash(value) };
    await writeFile(join(directory, `${table}.ndjson`), value); entries.add(`${table}.ndjson`);
  }
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true }); await writeFile(join(directory, name), value); entries.add(name);
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { manifest, entries };
}

test('transfer: ZIP and metadata preserve Unicode, IDs, file bytes and valid relationships', async t => {
  const directory = await temporary(t), source = join(directory, 'source'), destination = join(directory, 'extracted');
  const p = product(), a = asset(p.id); a.kind = 'image'; p.cover_asset_id = a.id;
  const categoryId = randomUUID(), tagId = randomUUID();
  const data = await fixture(source, { products: [p], assets: [a], categories: [{ id: categoryId, slug: 'figures', name: 'Фигурки', parent_id: null }],
    tags: [{ id: tagId, name: 'Ёж' }], product_categories: [{ product_id: p.id, category_id: categoryId }], product_tags: [{ product_id: p.id, tag_id: tagId }] }, { [a.archive_path]: 'STL fixture' });
  const archive = zip(await Promise.all([...data.entries].map(async name => ({ name, data: await readFile(join(source, name), 'utf8') }))));
  const archivePath = join(directory, 'fixture.zip'); await writeFile(archivePath, archive);
  const entries = await extractArchive(archivePath, destination, 1024 * 1024, () => undefined);
  const manifest = await validateArchive(destination, entries, () => undefined);
  assert.equal(manifest.tables.products.count, 1);
  assert.equal(hash(await readFile(join(destination, a.archive_path))), a.sha256);
  const restored = []; for await (const row of rows(join(destination, 'products.ndjson'))) restored.push(row);
  assert.deepEqual(restored, [p]);
});

test('transfer: ZIP rejects traversal, absolute paths, backslashes, directories and unknown files', async t => {
  const directory = await temporary(t);
  const names = ['../escape', '/etc/passwd', 'C:\\windows\\file', 'files/../../escape', 'files/', '.env', 'files/not-a-uuid/file.stl'];
  for (const [index, name] of names.entries()) {
    const path = join(directory, `malicious-${index}.zip`); await writeFile(path, zip([{ name }]));
    await assert.rejects(extractArchive(path, join(directory, `out-${index}`), 1024 * 1024, () => undefined), name);
  }
});

test('transfer: ZIP rejects Unix symlinks, repeated names, encryption and oversized extraction', async t => {
  const directory = await temporary(t);
  const cases = [
    zip([{ name: 'manifest.json', mode: 0o120777, data: '/etc/passwd' }]),
    zip([{ name: 'manifest.json' }, { name: 'manifest.json' }]),
    zip([{ name: 'manifest.json', flags: 0x801 }]),
    zip([{ name: 'manifest.json', data: 'x'.repeat(100) }]),
  ];
  for (const [index, data] of cases.entries()) {
    const path = join(directory, `malicious-${index}.zip`); await writeFile(path, data);
    await assert.rejects(extractArchive(path, join(directory, `out-${index}`), index === 3 ? 50 : 1024 * 1024, () => undefined));
  }
});

test('transfer: row parser bounds malformed, incomplete and huge JSON records', async t => {
  const directory = await temporary(t), path = join(directory, 'rows.ndjson');
  const collect = async () => { const result = []; for await (const row of rows(path)) result.push(row); return result; };
  for (const value of ['{broken}\n', '{"ok":true}', 'x'.repeat(1024 * 1024 + 1), `${JSON.stringify({ text: 'x'.repeat(1024 * 1024) })}\n`]) {
    await writeFile(path, value); await assert.rejects(collect());
  }
  await writeFile(path, '{"name":"Ёж"}\n\n{"name":"Echidna"}\n');
  assert.deepEqual(await collect(), [{ name: 'Ёж' }, { name: 'Echidna' }]);
});

test('transfer: archive validation rejects unknown format, digest tampering and duplicate IDs', async t => {
  const directory = await temporary(t), p = product();
  const first = await fixture(join(directory, 'version'), { products: [p] });
  await writeFile(join(directory, 'version', 'manifest.json'), JSON.stringify({ ...first.manifest, version: 99 }));
  await assert.rejects(validateArchive(join(directory, 'version'), first.entries, () => undefined));
  const second = await fixture(join(directory, 'digest'), { products: [p] });
  await writeFile(join(directory, 'digest', 'products.ndjson'), `${JSON.stringify({ ...p, title: 'Changed' })}\n`);
  await assert.rejects(validateArchive(join(directory, 'digest'), second.entries, () => undefined));
  const third = await fixture(join(directory, 'duplicates'), { products: [p, p] });
  await assert.rejects(validateArchive(join(directory, 'duplicates'), third.entries, () => undefined));
  const fourth = await fixture(join(directory, 'count'), { products: [p] });
  fourth.manifest.tables.products.count = 2; await writeFile(join(directory, 'count', 'manifest.json'), JSON.stringify(fourth.manifest));
  await assert.rejects(validateArchive(join(directory, 'count'), fourth.entries, () => undefined));
});

test('transfer: archive validation rejects missing files, changed bytes and dangling relations', async t => {
  const directory = await temporary(t), p = product(), a = asset(p.id);
  const missing = await fixture(join(directory, 'missing'), { products: [p], assets: [a] });
  await assert.rejects(validateArchive(join(directory, 'missing'), missing.entries, () => undefined));
  const changed = await fixture(join(directory, 'changed'), { products: [p], assets: [a] }, { [a.archive_path]: 'bad fixture' });
  await assert.rejects(validateArchive(join(directory, 'changed'), changed.entries, () => undefined));
  const relation = await fixture(join(directory, 'relation'), { products: [p], product_tags: [{ product_id: p.id, tag_id: randomUUID() }] });
  await assert.rejects(validateArchive(join(directory, 'relation'), relation.entries, () => undefined));
});

test('transfer: cover ownership cannot be bypassed by reusing one cover in two products', async t => {
  const directory = await temporary(t), first = product(), second = product(), image = asset(second.id);
  image.kind = 'image'; first.cover_asset_id = image.id; second.cover_asset_id = image.id;
  const data = await fixture(directory, { products: [first, second], assets: [image] }, { [image.archive_path]: 'STL fixture' });
  await assert.rejects(validateArchive(directory, data.entries, () => undefined));
});

test('transfer: local paths, credentials, required fields and cancellation are validated', async t => {
  const p = product(), a = asset(p.id);
  for (const row of [{ ...p, title: ' ' }, { ...p, source_url: 'https://secret:password@example.invalid/file' }, { ...p, image_url: '/etc/passwd' }, { ...p, status: 'unknown' }]) {
    assert.throws(() => validateRow('products', row));
  }
  for (const archive_path of ['/etc/passwd', `files/${a.id}/../evil.stl`, `files/${a.id}/nested/evil.stl`, `files/${randomUUID()}/model.stl`]) {
    assert.throws(() => validateRow('assets', { ...a, archive_path }));
  }
  const directory = await temporary(t), path = join(directory, 'cancelled.zip');
  await writeFile(path, zip([{ name: 'manifest.json' }]));
  await assert.rejects(extractArchive(path, join(directory, 'cancelled'), 1024 * 1024, () => { throw new Error('cancelled'); }));
});
