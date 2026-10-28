import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry } from 'yauzl';
import { validateRegistryArchive } from './registry-format.js';
import { safeRelativePath } from '../storage/service.js';

export const FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;
export const TABLES = ['products', 'categories', 'tags', 'product_categories', 'product_tags', 'assets', 'external_links'] as const;
export type TableName = typeof TABLES[number];
export type Row = Record<string, any>;
export interface Manifest { format: 'donarium'; version: 1 | 2; fileMode?: 'metadata' | 'files'; createdAt: string; tables: Record<TableName | 'storage_files' | 'import_sources' | 'storage_operations' | 'storage_matches' | 'storage_events', { count: number; sha256: string }>; }
export class TransferError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, max: number, nonempty = false): value is string => typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
const nullable = (value: unknown, max: number) => value === null || text(value, max);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const url = (value: unknown) => { if (value === null) return true; try { const parsed = new URL(String(value)); return typeof value === 'string' && value.length <= 4096 && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } };

export function validateRow(table: TableName, row: Row, registry = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TransferError(`Некорректная запись ${table}`);
  const valid = table === 'products' ? uuid(row.id) && text(row.title, 300, true) && nullable(row.sku, 100) && text(row.description, 100000) && ['ready', 'processing'].includes(row.status) && (row.cover_asset_id === null || uuid(row.cover_asset_id)) && date(row.created_at) && date(row.updated_at) && nullable(row.image_url, 4096) && nullable(row.image_alt, 1000) && url(row.source_url)
    : table === 'categories' ? uuid(row.id) && text(row.name, 120, true) && text(row.slug, 100, true) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.slug) && (row.parent_id === null || uuid(row.parent_id))
    : table === 'tags' ? uuid(row.id) && text(row.name, 100, true)
    : table === 'product_categories' ? uuid(row.product_id) && uuid(row.category_id)
    : table === 'product_tags' ? uuid(row.product_id) && uuid(row.tag_id)
    : table === 'external_links' ? uuid(row.id) && uuid(row.product_id) && text(row.system, 100, true) && text(row.external_id, 300, true) && url(row.url) && row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    : uuid(row.id) && uuid(row.product_id) && ['image', 'model', 'archive', 'source', 'other'].includes(row.kind) && text(row.name, 300, true) && text(row.media_type, 200, true) && (row.size_bytes === null || typeof row.size_bytes === 'string' && /^\d{1,19}$/.test(row.size_bytes) && BigInt(row.size_bytes) <= 9223372036854775807n) && (row.sha256 === null || digest(row.sha256)) && nullable(row.version, 300) && date(row.created_at) && ['external', 'uploaded'].includes(row.origin) && url(row.external_url);
  if (!valid) throw new TransferError(`Некорректные поля ${table}`);
  if (table === 'products' && row.image_url !== null && !url(row.image_url) && !/^\/(?:api\/v1\/assets\/[0-9a-f-]+\/(?:content|thumbnail)|illustrations\/[a-z0-9-]+\.svg)$/.test(row.image_url)) throw new TransferError('Недопустимый URL изображения');
  if (table === 'assets' && registry) {
    if ((row.file_id !== null && !uuid(row.file_id)) || (!!row.file_id === !!row.external_url) || !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata) || (row.retired_at !== null && !date(row.retired_at))) throw new TransferError('Недопустимая связь файла');
  }
  if (table === 'assets' && !registry) {
    if (row.external_url) {
      if (row.archive_path !== null) throw new TransferError('Внешний ресурс не должен содержать архивный путь');
    } else {
      if (!text(row.archive_path, 1000, true) || !row.archive_path.startsWith(`files/${row.id}/`) || !digest(row.sha256) || row.size_bytes === null) throw new TransferError('Локальный ресурс без файла или контрольной суммы');
      safeRelativePath(row.archive_path);
      if (row.archive_path.split('/').length !== 3) throw new TransferError('Некорректный путь ресурса');
    }
  }
}

/** Bounded line parser, including malicious archives with a single huge JSON line. */
export async function* rows(path: string): AsyncGenerator<Row> {
  let buffered = '';
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      if (end > 1024 * 1024) throw new TransferError('Слишком большая запись метаданных');
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (line) { try { yield JSON.parse(line); } catch { throw new TransferError('Повреждён JSON метаданных'); } }
    }
    if (buffered.length > 1024 * 1024) throw new TransferError('Слишком большая запись метаданных');
  }
  if (buffered.trim()) throw new TransferError('Незавершённая запись метаданных');
}
export async function sha256(path: string, check: () => void = () => undefined) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) { check(); hash.update(chunk); } return hash.digest('hex'); }

export async function extractArchive(zipPath: string, destination: string, limit: number, check: () => void) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip!)));
  let total = 0, entries = 0;
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => { archive.close(); reject(error instanceof TransferError ? error : new TransferError('Повреждён или недопустим ZIP-архив')); };
    archive.on('error', fail); archive.on('end', resolve);
    archive.on('entry', (entry: Entry) => { void (async () => {
      check();
      if (++entries > 2_000_000) throw new TransferError('Слишком много файлов в архиве');
      const name = safeRelativePath(entry.fileName);
      const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if ((fileType && fileType !== 0o100000) || entry.isEncrypted() || seen.has(name)) throw new TransferError('Ссылки, каталоги, шифрование и повторные пути запрещены');
      if (!(name === 'manifest.json' || [...TABLES,'storage_files','import_sources','storage_operations','storage_matches','storage_events'].some(table => name === `${table}.ndjson`) || /^files\/[0-9a-f-]{36}\/[^/]+$/i.test(name))) throw new TransferError('Неизвестный файл в архиве');
      seen.add(name);
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > limit || (!name.startsWith('files/') && entry.uncompressedSize > 256 * 1024 ** 2) || (name === 'manifest.json' && entry.uncompressedSize > 1024 * 1024)) throw new TransferError('Архив превышает разрешённый размер');
      const target = join(destination, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const source = await new Promise<Readable>((resolve, reject) => archive.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)));
      let actual = 0;
      await pipeline(source, new Transform({ transform(chunk: Buffer, _enc, callback) { try { check(); actual += chunk.length; if (actual > entry.uncompressedSize) throw new TransferError('Неверный размер файла'); callback(null, chunk); } catch (error) { callback(error as Error); } } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      archive.readEntry();
    })().catch(fail); });
    archive.readEntry();
  });
  return seen;
}

export async function validateArchive(directory: string, entries: Set<string>, check: () => void): Promise<Manifest> {
  let manifest: Manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); } catch { throw new TransferError('Не найден корректный manifest.json'); }
  if (manifest.version === 2) return validateRegistryArchive(directory, entries, check);
  if (manifest.format !== 'donarium' || manifest.version !== LEGACY_FORMAT_VERSION || !manifest.tables) throw new TransferError('Неподдерживаемая версия формата DONARIUM');
  const ids = new Map<TableName, Set<string>>();
  for (const table of TABLES) {
    check();
    const info = manifest.tables[table];
    if (!info || !Number.isSafeInteger(info.count) || info.count < 0 || !digest(info.sha256) || !entries.has(`${table}.ndjson`)) throw new TransferError('Некорректный манифест');
    if (await sha256(join(directory, `${table}.ndjson`), check) !== info.sha256) throw new TransferError('Не совпала контрольная сумма метаданных');
    const tableIds = new Set<string>(); ids.set(table, tableIds);
    let count = 0;
    for await (const row of rows(join(directory, `${table}.ndjson`))) {
      check(); validateRow(table, row); count++;
      const key = row.id ?? `${row.product_id}:${row.category_id ?? row.tag_id}`;
      if (tableIds.has(key)) throw new TransferError('Повторный идентификатор в архиве');
      tableIds.add(key);
      if (table === 'assets' && row.archive_path) {
        if (!entries.has(row.archive_path)) throw new TransferError('В архиве отсутствует связанный файл');
        if (String((await stat(join(directory, row.archive_path))).size) !== row.size_bytes || await sha256(join(directory, row.archive_path), check) !== row.sha256) throw new TransferError('Не совпала контрольная сумма или размер файла');
      }
    }
    if (count !== info.count) throw new TransferError('Не совпало количество записей');
  }
  for (const table of TABLES) for await (const row of rows(join(directory, `${table}.ndjson`))) {
    check();
    if (row.product_id && !ids.get('products')!.has(row.product_id)) throw new TransferError('Потеряна связь с карточкой');
    if (row.category_id && !ids.get('categories')!.has(row.category_id)) throw new TransferError('Потеряна связь категории');
    if (row.tag_id && !ids.get('tags')!.has(row.tag_id)) throw new TransferError('Потеряна связь тега');
    if (table === 'categories' && row.parent_id && (!ids.get('categories')!.has(row.parent_id) || row.id === row.parent_id)) throw new TransferError('Потеряна связь родительской категории');
    if (table === 'products' && row.cover_asset_id && !ids.get('assets')!.has(row.cover_asset_id)) throw new TransferError('Потеряна связь обложки');
  }
  const assets = new Map<string, { product: string; kind: string }>();
  const expectedEntries = new Set<string>(['manifest.json', ...TABLES.map(table => `${table}.ndjson`)]);
  for await (const row of rows(join(directory, 'assets.ndjson'))) {
    assets.set(row.id, { product: row.product_id, kind: row.kind });
    if (row.archive_path) expectedEntries.add(row.archive_path);
  }
  for await (const row of rows(join(directory, 'products.ndjson'))) if (row.cover_asset_id) {
    const cover = assets.get(row.cover_asset_id);
    if (!cover || cover.product !== row.id || cover.kind !== 'image') throw new TransferError('Обложка принадлежит другой карточке');
  }
  if (entries.size !== expectedEntries.size || [...entries].some(entry => !expectedEntries.has(entry))) throw new TransferError('Архив содержит лишние файлы');
  const parents = new Map<string, string>();
  for await (const row of rows(join(directory, 'categories.ndjson'))) if (row.parent_id) parents.set(row.id, row.parent_id);
  const finished = new Set<string>();
  for (const id of parents.keys()) {
    const branch = new Set<string>(); let current: string | undefined = id;
    while (current && !finished.has(current)) {
      if (branch.has(current)) throw new TransferError('Цикл в иерархии категорий');
      branch.add(current); current = parents.get(current);
    }
    for (const visited of branch) finished.add(visited);
  }
  return manifest;
}
