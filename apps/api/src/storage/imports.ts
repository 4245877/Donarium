import { basename, extname } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { FIGURE_FILE_EXTENSIONS } from '@donarium/shared';
import { fileMetadata, safeRelativePath, StorageError, StorageService } from './service.js';
import { location as storageId, registerFile } from './registry.js';

export interface FolderCandidate {
  path: string; title: string; files: number; cover: string | null; existingProductId: string | null;
}
export interface ImportJob {
  id: string; root: string; path: string;
  status: 'scanning' | 'preview' | 'importing' | 'completed' | 'failed' | 'cancelled';
  items: FolderCandidate[]; errors: string[]; error?: string;
  report?: { created: number; updated: number; skipped: number; errors: number };
  visited: number; createdAt: number;
}
const modelExtensions = new Set(FIGURE_FILE_EXTENSIONS.map(extension => `.${extension}`));
const supportedExtensions = new Set([...modelExtensions, '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.pdf', '.txt', '.md', '.docx', '.xlsx', '.ini', '.gcode', '.cfg']);
export function supportedFile(path: string) { return supportedExtensions.has(extname(path).toLowerCase()); }

export async function linkFile(client: Pick<PoolClient, 'query'>, service: StorageService, productId: string,
  key: string, path: string, origin = 'external', checksum: string | null = null) {
  await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[productId]);
  const file = await registerFile(client, service, key, path, checksum ? { sha256: checksum } : {});
  const result = await client.query<{ id: string }>(`INSERT INTO assets
    (product_id,file_id,kind,name,media_type,origin) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING RETURNING id`, [productId,file.id,file.kind,file.name,file.media_type,origin]);
  if(result.rowCount) await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[productId]);
  return result.rows[0]?.id ?? null;
}

/** Existing direct file links are authoritative only when they identify exactly one card.
 * A card already imported from another folder cannot silently adopt a second source. */
async function folderProduct(client: Pick<PoolClient, 'query'>, location: string, path: string, files: string[], knownSourceId?: string): Promise<string | null> {
  const linked = await client.query<{ product_id: string; source_storage_id: string | null; source_relative_path: string | null }>(`SELECT DISTINCT
    a.product_id,s.storage_id AS source_storage_id,s.relative_path AS source_relative_path
    FROM assets a LEFT JOIN import_sources s ON s.product_id=a.product_id
    WHERE a.storage_id=$1 AND a.relative_path=ANY($2::text[])`, [location, files]);
  const products = new Set(linked.rows.map(row => row.product_id));
  if (knownSourceId) products.add(knownSourceId);
  if (products.size > 1) throw new StorageError('Файлы этой папки связаны с несколькими карточками; уточните связи перед импортом', 409);
  const productId = products.values().next().value as string | undefined;
  if (!productId) return null;
  const source = linked.rows.find(row => row.product_id === productId && row.source_storage_id);
  if (source && (source.source_storage_id !== location || source.source_relative_path !== path)) {
    throw new StorageError('Связанная карточка уже импортируется из другой папки; уточните связи перед импортом', 409);
  }
  return productId;
}

/** One resource-intensive folder operation per application process; bounded previews expire on restart. */
export class FolderImports {
  private jobs = new Map<string, ImportJob>();
  private busy = false;
  private activeTasks = new Set<Promise<void>>();
  constructor(private service: StorageService, private pool: Pool) {}
  private launch(work: () => Promise<void>) {
    const task = work(); this.activeTasks.add(task);
    void task.finally(() => this.activeTasks.delete(task));
  }
  async close() {
    for (const job of this.jobs.values()) if (job.status === 'scanning' || job.status === 'importing') job.status = 'cancelled';
    await Promise.allSettled(this.activeTasks);
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new StorageError('Операция не найдена или истекла; повторите сканирование', 404);
    return job;
  }
  private reserve() {
    if (this.busy) throw new StorageError('Другая операция импорта ещё выполняется', 409);
    for (const [id, job] of this.jobs) if (Date.now() - job.createdAt > 3600_000 && job.status !== 'importing' && job.status !== 'scanning') this.jobs.delete(id);
    if (this.jobs.size >= 20) throw new StorageError('Слишком много предварительных просмотров; отмените ненужные', 409);
  }
  async scan(root: string, path: string) {
    safeRelativePath(path, true); this.service.root(root); this.reserve();
    const folder = await this.service.open(root, path, true); await folder.handle.close();
    const job: ImportJob = { id: randomUUID(), root, path, status: 'scanning', items: [], errors: [], visited: 0, createdAt: Date.now() };
    this.jobs.set(job.id, job); this.busy = true;
    this.launch(async () => {
      try {
        const location = await storageId(this.pool, this.service, root);
        const existing = await this.pool.query<{ relative_path: string; product_id: string }>('SELECT relative_path,product_id FROM import_sources WHERE storage_id=$1', [location]);
        const existingMap = new Map(existing.rows.map(row => [row.relative_path, row.product_id]));
        await this.walk(job, path, 0, existingMap, location);
        if (job.status === 'scanning') job.status = 'preview';
      } catch (error) {
        if (job.status !== 'cancelled') { job.status = 'failed'; job.error = error instanceof StorageError ? error.message : 'Сканирование не завершено'; }
      } finally { this.busy = false; }
    });
    return job.id;
  }
  private async walk(job: ImportJob, path: string, depth: number, existing: Map<string, string>, location: string) {
    if (job.status === 'cancelled') return;
    if (depth > 50 || job.visited > 200_000 || job.items.length >= 10_000) throw new StorageError('Достигнут лимит сканирования: выберите меньшую папку');
    let folder;
    try { folder = await this.service.open(job.root, path, true); }
    catch { job.errors.push(`Нет доступа к папке: ${path || '/'}`); return; }
    let entries;
    try { entries = await readdir(process.platform === 'linux' ? `/proc/self/fd/${folder.handle.fd}` : folder.path, { withFileTypes: true }); }
    catch { job.errors.push(`Не удалось прочитать папку: ${path || '/'}`); return; }
    finally { await folder.handle.close(); }
    job.visited += entries.length;
    if (job.visited > 200_000) throw new StorageError('Достигнут лимит 200000 файлов: выберите меньшую папку');
    const files = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && supportedFile(entry.name));
    if (files.length > 10_000) throw new StorageError('В одной папке более 10000 поддерживаемых файлов: разделите импорт');
    if (files.some(entry => modelExtensions.has(extname(entry.name).toLowerCase()))) {
      const images = files.filter(entry => fileMetadata(entry.name).kind === 'image');
      images.sort((a, b) => Number(/^(cover|preview|front|обложка)[._-]/i.test(b.name)) - Number(/^(cover|preview|front|обложка)[._-]/i.test(a.name)) || a.name.localeCompare(b.name));
      const coverName = images[0]?.name;
      try {
        const directPaths = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => path ? `${path}/${entry.name}` : entry.name);
        const existingProductId = await folderProduct(this.pool, location, path, directPaths, existing.get(path));
        job.items.push({ path, title: basename(path) || this.service.root(job.root).name, files: files.length,
          cover: coverName ? (path ? `${path}/${coverName}` : coverName) : null, existingProductId });
      } catch (error) {
        if (!(error instanceof StorageError) || error.statusCode !== 409) throw error;
        job.errors.push(`${path || '/'}: ${error.message}`);
      }
    }
    for (const entry of entries) {
      if (this.get(job.id).status === 'cancelled') break;
      if (entry.isDirectory() && !entry.name.startsWith('.')) await this.walk(job, path ? `${path}/${entry.name}` : entry.name, depth + 1, existing, location);
    }
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'importing') throw new StorageError('Импорт уже подтверждён; дождитесь завершения', 409);
    job.status = 'cancelled'; job.items = []; return job;
  }
  confirm(id: string, paths: string[], categoryId?: string) {
    const job = this.get(id);
    if (job.status !== 'preview') throw new StorageError('Предварительный просмотр ещё не готов или уже использован', 409);
    if (this.busy) throw new StorageError('Другая операция импорта выполняется', 409);
    const selected = new Set(paths);
    if (!selected.size || selected.size > 10_000 || [...selected].some(path => !job.items.some(item => item.path === path))) throw new StorageError('Выберите записи из предварительного просмотра');
    this.busy = true; job.status = 'importing'; job.report = { created: 0, updated: 0, skipped: 0, errors: 0 };
    this.launch(async () => {
      try {
        if (categoryId && !(await this.pool.query('SELECT id FROM categories WHERE id=$1', [categoryId])).rowCount) throw new StorageError('Категория не найдена');
        for (const candidate of job.items) {
          if (this.get(job.id).status === 'cancelled') break;
          if (!selected.has(candidate.path)) { job.report!.skipped++; continue; }
          try {
            const result = await this.importFolder(job.root, candidate, categoryId);
            job.report![result]++;
          } catch (error) {
            job.report!.errors++;
            job.errors.push(`Не импортирована папка ${candidate.path || '/'}${error instanceof StorageError ? `: ${error.message}` : ''}`);
          }
        }
        if (this.get(job.id).status !== 'cancelled') job.status = 'completed';
      } catch (error) { job.status = 'failed'; job.error = error instanceof StorageError ? error.message : 'Импорт не завершён'; }
      finally { this.busy = false; }
    });
    return job.id;
  }
  private async importFolder(root: string, candidate: FolderCandidate, categoryId?: string): Promise<'created' | 'updated'> {
    const folder = await this.service.open(root, candidate.path, true);
    let entries;
    try { entries = await readdir(process.platform === 'linux' ? `/proc/self/fd/${folder.handle.fd}` : folder.path, { withFileTypes: true }); }
    finally { await folder.handle.close(); }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const location = await storageId(client, this.service, root);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`donarium-folder:${location}:${candidate.path}`]);
      const previous = await client.query<{ product_id: string }>('SELECT product_id FROM import_sources WHERE storage_id=$1 AND relative_path=$2', [location, candidate.path]);
      const directPaths = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => candidate.path ? `${candidate.path}/${entry.name}` : entry.name);
      const existingId = await folderProduct(client, location, candidate.path, directPaths, previous.rows[0]?.product_id);
      if (existingId !== candidate.existingProductId) throw new StorageError('Связи изменились после просмотра; повторите сканирование', 409);
      const id = existingId ?? randomUUID();
      if (!existingId) {
        await client.query('INSERT INTO products(id,title,status) VALUES($1,$2,\'processing\')', [id, candidate.title.slice(0, 300)]);
      } else {
        await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [id]);
        // Another root can race to adopt the same card; recheck after its row lock.
        await folderProduct(client, location, candidate.path, directPaths, previous.rows[0]?.product_id);
      }
      if (!previous.rowCount) await client.query('INSERT INTO import_sources(storage_id,relative_path,product_id) VALUES($1,$2,$3)', [location, candidate.path, id]);
      if (categoryId) await client.query('INSERT INTO product_categories(product_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, categoryId]);
      let coverId: string | null = null;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.') || !supportedFile(entry.name)) continue;
        const path = candidate.path ? `${candidate.path}/${entry.name}` : entry.name;
        const assetId = await linkFile(client, this.service, id, root, path);
        if (path === candidate.cover) {
          coverId = assetId ?? (await client.query<{ id: string }>('SELECT id FROM assets WHERE product_id=$1 AND storage_id=$2 AND relative_path=$3', [id, location, path])).rows[0]?.id ?? null;
        }
      }
      if (coverId) await client.query('UPDATE products SET cover_asset_id=COALESCE(cover_asset_id,$2) WHERE id=$1', [id, coverId]);
      await client.query('COMMIT'); return existingId ? 'updated' : 'created';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
