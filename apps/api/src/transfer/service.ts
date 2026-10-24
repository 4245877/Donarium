import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import yazl from 'yazl';
import type { Config } from '../config.js';
import { StorageService, safeFileName } from '../storage/service.js';
import { TABLES, FORMAT_VERSION, TransferError, extractArchive, validateArchive, rows, sha256, type TableName, type Manifest, type Row } from './format.js';

type JobStatus = 'uploading' | 'running' | 'ready' | 'completed' | 'failed' | 'cancelled';
export interface TransferJob { id: string; kind: 'export' | 'restore'; status: JobStatus; progress: number; createdAt: string; error?: string; result?: Row; }
interface InternalJob extends TransferJob { directory: string; cancelled?: boolean; manifest?: Manifest; }
const fields: Record<TableName, string> = {
  products: 'id,sku,title,description,status,cover_asset_id,image_url,image_alt,source_url,created_at,updated_at',
  categories: 'id,slug,name,parent_id', tags: 'id,name', product_categories: 'product_id,category_id', product_tags: 'product_id,tag_id',
  assets: 'a.id,a.product_id,a.kind,a.name,a.media_type,a.size_bytes::text,a.sha256,a.version,a.external_url,a.created_at,a.origin,s.key AS storage_key,a.relative_path',
  external_links: 'id,product_id,system,external_id,url,metadata',
};
async function* databaseRows(client: PoolClient, table: TableName) {
  const source = table === 'assets' ? 'assets a LEFT JOIN storage_locations s ON s.id=a.storage_id' : table;
  const order = table === 'product_categories' ? 'product_id,category_id' : table === 'product_tags' ? 'product_id,tag_id' : table === 'assets' ? 'a.id' : 'id';
  await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR SELECT ${fields[table]} FROM ${source} ORDER BY ${order}`);
  try { for (;;) { const batch = await client.query('FETCH 500 FROM export_cursor'); if (!batch.rowCount) break; for (const row of batch.rows) yield row as Row; } }
  finally { await client.query('CLOSE export_cursor'); }
}
const serializable = (row: Row) => JSON.parse(JSON.stringify(row)) as Row;
const csv = (value: unknown) => { let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

/** Jobs are bounded, persisted locally and survive a process restart with an explicit interrupted state. */
export class TransferService {
  private jobs = new Map<string, InternalJob>();
  private busy = false;
  private closing = false;
  private tasks = new Set<Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  readonly storage: StorageService;
  constructor(private pool: Pool, private config: Config) { this.storage = new StorageService(config); }
  async init() {
    await this.storage.init();
    for (const name of await readdir(this.storage.workRoot)) {
      if (!/^transfer-[0-9a-f-]{36}$/.test(name)) continue;
      const directory = join(this.storage.workRoot, name);
      try {
        const job = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8')) as InternalJob;
        if (!['export', 'restore'].includes(job.kind) || name !== `transfer-${job.id}`) continue;
        let canExpire = true;
        job.directory = directory;
        if (job.status === 'running' || job.status === 'uploading' || (job.kind === 'restore' && job.status === 'failed')) {
          job.status = 'failed'; job.error = 'Операция прервана перезапуском. Повторите её';
          if (job.kind === 'restore') {
            const receipt = await this.pool.query('SELECT result FROM transfer_receipts WHERE id=$1', [job.id]).catch(() => undefined);
            if (!receipt) canExpire = false;
            if (receipt?.rowCount) { job.status = 'completed'; job.result = receipt.rows[0].result; delete job.error; }
            else if (receipt) {
              const movedFiles = join(this.storage.managedRoot, 'restored', job.id);
              if ((await stat(movedFiles).catch(() => undefined))?.isDirectory() && !(await stat(join(this.staging(job.id), 'files')).catch(() => undefined))) await rename(movedFiles, join(this.staging(job.id), 'files'));
            }
          }
          await this.persist(job);
        }
        if (canExpire && Date.now() - Date.parse(job.createdAt) > 24 * 60 * 60 * 1000) { await rm(directory, { recursive: true, force: true }); await rm(this.staging(job.id), { recursive: true, force: true }); continue; }
        this.jobs.set(job.id, job);
      } catch { /* Unrecognized directories are left intact. */ }
    }
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) if (job.status === 'running' || job.status === 'uploading') job.cancelled = true;
    await Promise.allSettled(this.tasks);
  }
  private launch(job: InternalJob, operation: () => Promise<void>, success: JobStatus = 'completed') {
    const task = this.run(job, operation, success).catch(() => { job.status = 'failed'; job.error = 'Ошибка временного хранилища'; });
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  }
  private staging(id: string) { return join(this.storage.managedRoot, `.restore-stage-${id}`); }
  private async persist(job: InternalJob) {
    const previous = this.writes.get(job.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await writeFile(join(job.directory, 'job.json.tmp'), JSON.stringify(job), { mode: 0o600 });
      await rename(join(job.directory, 'job.json.tmp'), join(job.directory, 'job.json'));
    });
    this.writes.set(job.id, operation);
    try { await operation; } finally { if (this.writes.get(job.id) === operation) this.writes.delete(job.id); }
  }
  private check(job: InternalJob) { if (job.cancelled) throw new TransferError('Операция отменена'); }
  private async create(kind: InternalJob['kind'], status: JobStatus) {
    if (this.closing) throw new TransferError('Приложение завершает работу', 503);
    if (this.busy) throw new TransferError('Дождитесь завершения текущего переноса', 409);
    if (this.jobs.size >= 100) throw new TransferError('Удалите завершённые операции переноса', 409);
    this.busy = true;
    const id = randomUUID(), directory = join(this.storage.workRoot, `transfer-${id}`);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { this.busy = false; throw error; }
    const job: InternalJob = { id, kind, status, progress: 0, createdAt: new Date().toISOString(), directory };
    this.jobs.set(id, job);
    try { await this.persist(job); } catch { this.busy = false; this.jobs.delete(id); throw new TransferError('Нет места или доступа к временному хранилищу', 507); }
    return job;
  }
  get(id: string): TransferJob {
    const job = this.internal(id);
    return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}) };
  }
  private internal(id: string) { const job = this.jobs.get(id); if (!job) throw new TransferError('Операция не найдена', 404); return job; }
  private async run(job: InternalJob, operation: () => Promise<void>, success: JobStatus = 'completed') {
    try { await operation(); job.status = success; }
    catch (error) { job.status = job.cancelled ? 'cancelled' : 'failed'; job.error = error instanceof TransferError ? error.message : 'Не удалось завершить перенос. Проверьте доступность файлов, свободное место и базу данных'; }
    finally { this.busy = false; await this.persist(job).catch(() => undefined); if (job.status === 'failed' || job.status === 'cancelled') await rm(join(job.directory, 'archive.zip'), { force: true }); }
  }
  async cancel(id: string) {
    const job = this.internal(id); job.cancelled = true;
    if (job.status === 'running' || job.status === 'uploading') { await this.persist(job); return this.get(id); }
    await this.writes.get(id)?.catch(() => undefined);
    await rm(job.directory, { recursive: true, force: true }); await rm(this.staging(id), { recursive: true, force: true }); this.jobs.delete(id); return { id, status: 'cancelled' };
  }
  async startExport() { const job = await this.create('export', 'running'); this.launch(job, () => this.archive(job)); return this.get(job.id); }
  async upload(source: Readable) {
    const job = await this.create('restore', 'uploading');
    const target = join(job.directory, 'upload.zip');
    let size = 0;
    try {
      await pipeline(source, new Transform({ transform: (chunk: Buffer, _enc, callback) => { try { this.check(job); size += chunk.length; if (size > (this.config.maxArchiveBytes ?? 2 * 1024 ** 4)) throw new TransferError('Архив превышает допустимый размер', 413); callback(null, chunk); } catch (error) { callback(error as Error); } } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    } catch (error) { job.status = 'failed'; job.error = 'Загрузка прервана или превышен допустимый размер'; this.busy = false; await this.persist(job); await rm(target, { force: true }); throw error; }
    job.status = 'running';
    try { await this.persist(job); } catch { this.busy = false; job.status = 'failed'; throw new TransferError('Не удалось сохранить состояние загрузки', 507); }
    this.launch(job, async () => {
      const entries = await extractArchive(target, this.staging(job.id), this.config.maxArchiveBytes ?? 2 * 1024 ** 4, () => this.check(job));
      job.manifest = await validateArchive(this.staging(job.id), entries, () => this.check(job));
      const conflicts = await this.conflicts(job); job.result = { counts: Object.fromEntries(TABLES.map(table => [table, job.manifest!.tables[table].count])), conflicts, missingFiles: 0 };
    }, 'ready');
    return this.get(job.id);
  }
  preview(id: string) { const job = this.internal(id); if (job.kind !== 'restore' || job.status !== 'ready') throw new TransferError('Предварительный просмотр ещё не готов', 409); return job.result; }
  async confirm(id: string, conflict: 'skip' | 'copy') {
    const job = this.internal(id); if (job.kind !== 'restore' || job.status !== 'ready' || this.busy || this.closing) throw new TransferError('Операция ещё не готова или выполняется другой перенос', 409);
    this.busy = true; job.status = 'running'; job.cancelled = false;
    try { await this.persist(job); } catch { this.busy = false; job.status = 'ready'; throw new TransferError('Не удалось сохранить состояние переноса', 507); }
    this.launch(job, () => this.restore(job, conflict)); return this.get(id);
  }
  download(id: string) { const job = this.internal(id); if (job.kind !== 'export' || job.status !== 'completed') throw new TransferError('Архив ещё не готов', 409); return join(job.directory, 'archive.zip'); }
  private async conflicts(job: InternalJob) {
    let count = 0;
    for await (const row of rows(join(this.staging(job.id), 'products.ndjson'))) {
      this.check(job); const found = await this.pool.query('SELECT id FROM products WHERE id=$1 OR (sku IS NOT NULL AND sku=$2)', [row.id, row.sku]); if (found.rowCount) count++;
    }
    return count;
  }
  async *json() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      yield `{"format":"donarium-metadata","version":${FORMAT_VERSION},"createdAt":${JSON.stringify(new Date().toISOString())}`;
      for (const table of TABLES) { yield `,${JSON.stringify(table)}:[`; let first = true; for await (const row of databaseRows(client, table)) { if (!first) yield ','; first = false; yield JSON.stringify(row); } yield ']'; }
      yield '}'; await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  async *csvRows() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      yield '\ufeff' + ['id', 'sku', 'title', 'description', 'status', 'categories_json', 'tags_json', 'assets_json', 'cover_asset_id', 'created_at', 'updated_at'].map(csv).join(',') + '\r\n';
      for await (const row of databaseRows(client, 'products')) {
        const categories = await client.query('SELECT c.id,c.slug,c.name FROM product_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.product_id=$1 ORDER BY c.id', [row.id]);
        const tags = await client.query('SELECT t.id,t.name FROM product_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.product_id=$1 ORDER BY t.id', [row.id]);
        const assets = await client.query('SELECT a.id,a.name,s.key AS storage_key,a.relative_path,a.external_url FROM assets a LEFT JOIN storage_locations s ON s.id=a.storage_id WHERE a.product_id=$1 ORDER BY a.id', [row.id]);
        yield [row.id, row.sku, row.title, row.description, row.status, categories.rows, tags.rows, assets.rows, row.cover_asset_id, row.created_at.toISOString(), row.updated_at.toISOString()].map(csv).join(',') + '\r\n';
      }
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  private async archive(job: InternalJob) {
    const client = await this.pool.connect();
    const zip = new yazl.ZipFile();
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    const output = pipeline(zip.outputStream, createWriteStream(join(job.directory, 'archive.zip'), { flags: 'wx', mode: 0o600 }));
    // Attach a rejection handler immediately; preparation can fail before awaiting output.
    let outputError: unknown; void output.catch(error => { outputError = error; });
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const manifest: Manifest = { format: 'donarium', version: FORMAT_VERSION, createdAt: new Date().toISOString(), tables: {} as Manifest['tables'] };
      for (const table of TABLES) {
        this.check(job); const path = join(job.directory, `${table}.ndjson`); const destination = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        let count = 0;
        // Prevent unhandled write failures while DB/files are being read.
        let writeError: Error | undefined; destination.on('error', error => { writeError = error; });
        try {
          for await (const original of databaseRows(client, table)) {
            this.check(job); if (writeError) throw writeError; if (outputError) throw outputError;
            const row = serializable(original);
            if (table === 'assets') {
              row.archive_path = null;
              if (!row.external_url) {
                if (!row.storage_key || !row.relative_path) throw new TransferError('У ресурса отсутствует разрешённое хранилище');
                const file = await this.storage.open(row.storage_key, row.relative_path); row.size_bytes = String(file.stat.size); await file.handle.close();
                try { row.sha256 = await this.storage.hash(row.storage_key, row.relative_path, () => this.check(job)); } catch { throw new TransferError('Не найден или недоступен связанный файл. Исправьте связь перед полным экспортом'); }
                const name = safeFileName(row.name); row.archive_path = `files/${row.id}/${name}`;
                const key = row.storage_key, relativePath = row.relative_path, expected = row.sha256;
                zip.addReadStreamLazy(row.archive_path, { compress: false, size: Number(row.size_bytes), forceZip64Format: true }, callback => {
                  void this.storage.readStream(key, relativePath).then(file => {
                    const hash = createHash('sha256');
                    const verifier = new Transform({ transform: (chunk: Buffer, _enc, done) => { try { this.check(job); hash.update(chunk); done(null, chunk); } catch (error) { done(error as Error); } }, flush(done) { done(hash.digest('hex') === expected ? undefined : new TransferError('Файл изменился во время экспорта. Повторите экспорт')); } });
                    file.stream.on('error', error => verifier.destroy(error)); verifier.on('close', () => file.stream.destroy()); file.stream.pipe(verifier); callback(null, verifier);
                  }).catch(error => callback(error, null as unknown as Readable));
                });
                delete row.storage_key; delete row.relative_path;
              }
            }
            if (!destination.write(JSON.stringify(row) + '\n')) await once(destination, 'drain'); count++; job.progress++;
          }
          if (writeError) throw writeError;
          destination.end(); await once(destination, 'finish');
        } catch (error) { destination.destroy(); throw error; }
        manifest.tables[table] = { count, sha256: await sha256(path) }; zip.addFile(path, `${table}.ndjson`, { compress: true });
      }
      await client.query('COMMIT');
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json'); zip.end({ forceZip64Format: true, comment: '' }); await output;
      job.result = { counts: Object.fromEntries(TABLES.map(table => [table, manifest.tables[table].count])), bytes: String((await stat(join(job.directory, 'archive.zip'))).size) };
    } catch (error) { (zip.outputStream as Readable).destroy(error as Error); await output.catch(() => undefined); throw error; }
    finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  private async restore(job: InternalJob, conflict: 'skip' | 'copy') {
    const stage = this.staging(job.id), destination = join(this.storage.managedRoot, 'restored', job.id);
    const client = await this.pool.connect(); let moved = false, committed = false;
    const newCategoryIds = new Set<string>();
    const productIds = new Map<string, string>(), categoryIds = new Map<string, string>(), tagIds = new Map<string, string>(), assetIds = new Map<string, string>();
    let skipped = 0, copied = 0;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('donarium_restore'))");
      const storage = await client.query<{ id: string }>(`INSERT INTO storage_locations(key,name,kind) VALUES('DONARIUM_UPLOADS','Загрузки DONARIUM','local') ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
      for await (const row of rows(join(stage, 'categories.ndjson'))) {
        this.check(job); const found = await client.query('SELECT id FROM categories WHERE id=$1 OR slug=$2 ORDER BY (id=$1) DESC LIMIT 1', [row.id, row.slug]);
        const id = found.rows[0]?.id ?? row.id; categoryIds.set(row.id, id);
        if (!found.rowCount) { await client.query('INSERT INTO categories(id,slug,name) VALUES($1,$2,$3)', [id, row.slug, row.name]); newCategoryIds.add(id); }
      }
      for await (const row of rows(join(stage, 'categories.ndjson'))) if (row.parent_id && newCategoryIds.has(categoryIds.get(row.id)!)) {
        // Only new categories receive imported hierarchy; existing organization stays intact.
        await client.query('UPDATE categories SET parent_id=$2 WHERE id=$1 AND parent_id IS NULL AND id<>$2', [categoryIds.get(row.id), categoryIds.get(row.parent_id)]);
      }
      for await (const row of rows(join(stage, 'tags.ndjson'))) {
        this.check(job); const found = await client.query('SELECT id FROM tags WHERE id=$1 OR lower(name)=lower($2) ORDER BY (id=$1) DESC LIMIT 1', [row.id, row.name]);
        const id = found.rows[0]?.id ?? row.id; tagIds.set(row.id, id);
        if (!found.rowCount) await client.query('INSERT INTO tags(id,name) VALUES($1,$2)', [id, row.name]);
      }
      for await (const row of rows(join(stage, 'products.ndjson'))) {
        this.check(job); const found = await client.query('SELECT id FROM products WHERE id=$1 OR (sku IS NOT NULL AND sku=$2)', [row.id, row.sku]);
        if (found.rowCount && conflict === 'skip') { skipped++; continue; }
        const id = found.rowCount ? randomUUID() : row.id; if (found.rowCount) copied++; productIds.set(row.id, id);
        await client.query(`INSERT INTO products(id,sku,title,description,status,image_url,image_alt,source_url,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, found.rowCount ? null : row.sku, row.title, row.description, row.status, row.image_url, row.image_alt, row.source_url, row.created_at, row.updated_at]); job.progress++;
      }
      for (const table of ['product_categories', 'product_tags'] as const) for await (const row of rows(join(stage, `${table}.ndjson`))) {
        this.check(job); const product = productIds.get(row.product_id); if (!product) continue;
        if (table === 'product_categories') await client.query('INSERT INTO product_categories(product_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [product, categoryIds.get(row.category_id)]);
        else await client.query('INSERT INTO product_tags(product_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [product, tagIds.get(row.tag_id)]);
      }
      for await (const row of rows(join(stage, 'assets.ndjson'))) {
        this.check(job); const product = productIds.get(row.product_id); if (!product) { if (row.archive_path) await rm(join(stage, 'files', row.id), { recursive: true, force: true }); continue; }
        const exists = await client.query('SELECT id FROM assets WHERE id=$1', [row.id]); const id = exists.rowCount ? randomUUID() : row.id; assetIds.set(row.id, id);
        const path = row.archive_path ? `restored/${job.id}/${row.archive_path.slice('files/'.length)}` : null;
        await client.query(`INSERT INTO assets(id,product_id,kind,name,media_type,size_bytes,sha256,version,storage_id,relative_path,external_url,origin,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, product, row.kind, row.name, row.media_type, row.size_bytes, row.sha256, row.version, path ? storage.rows[0]!.id : null, path, row.external_url, path ? 'uploaded' : 'external', row.created_at]);
      }
      // Trigger changes updated_at when setting cover; restore exported dates after it explicitly.
      await client.query("SET LOCAL donarium.preserve_updated_at = 'on'");
      for await (const row of rows(join(stage, 'products.ndjson'))) if (productIds.has(row.id) && row.cover_asset_id) {
        await client.query('UPDATE products SET cover_asset_id=$2 WHERE id=$1', [productIds.get(row.id), assetIds.get(row.cover_asset_id)]);
      }
      for await (const row of rows(join(stage, 'external_links.ndjson'))) {
        const product = productIds.get(row.product_id); if (!product) continue; this.check(job);
        await client.query(`INSERT INTO external_links(id,product_id,system,external_id,url,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [row.id, product, row.system, row.external_id, row.url, row.metadata]);
      }
      this.check(job);
      if (assetIds.size && (await stat(join(stage, 'files')).catch(() => undefined))?.isDirectory()) { await mkdir(join(this.storage.managedRoot, 'restored'), { recursive: true, mode: 0o700 }); await rename(join(stage, 'files'), destination); moved = true; }
      const result = { imported: productIds.size, skipped, copied, assets: assetIds.size };
      await client.query('INSERT INTO transfer_receipts(id,result) VALUES($1,$2)', [job.id, result]);
      await client.query('COMMIT'); committed = true;
      job.result = result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (moved && !committed) {
        // COMMIT may have reached PostgreSQL even when its response was lost.
        // Query the durable receipt on a new connection before moving any bytes back.
        const receipt = await this.pool.query('SELECT result FROM transfer_receipts WHERE id=$1', [job.id]).catch(() => undefined);
        if (receipt?.rowCount) { committed = true; job.result = receipt.rows[0].result; return; }
        if (receipt) await rename(destination, join(stage, 'files')).catch(() => undefined);
        else throw new TransferError('БД недоступна: результат COMMIT пока неизвестен. Файлы сохранены; перезапустите приложение после восстановления БД');
      }
      throw error;
    } finally { client.release(); }
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(job.directory, 'upload.zip'), { force: true }).catch(() => undefined);
  }
}
