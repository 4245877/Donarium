import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import yazl from 'yazl';
import type { Config } from '../config.js';
import { StorageService, safeFileName } from '../storage/service.js';
import { EXTRA_TABLES, allTables } from './registry-format.js';
import { TABLES, TransferError, extractArchive, validateArchive, rows, sha256, type TableName, type Manifest, type Row } from './format.js';

type JobStatus = 'uploading' | 'running' | 'ready' | 'completed' | 'failed' | 'cancelled';
export interface TransferJob { id: string; kind: 'export' | 'restore'; status: JobStatus; progress: number; createdAt: string; error?: string; result?: Row; }
interface InternalJob extends TransferJob { directory: string; cancelled?: boolean; manifest?: Manifest; fileMode?: 'metadata' | 'files'; }
type PortableTable = TableName | typeof EXTRA_TABLES[number];
const fields: Record<PortableTable, string> = {
  products: 'id,sku,title,description,status,cover_asset_id,image_url,image_alt,source_url,created_at,updated_at',
  categories: 'id,slug,name,parent_id', tags: 'id,name', product_categories: 'product_id,category_id', product_tags: 'product_id,tag_id',
  assets: 'a.id,a.product_id,a.kind,a.name,a.media_type,a.size_bytes::text,a.sha256,a.version,a.external_url,a.created_at,a.origin,a.file_id,a.metadata,a.retired_at,s.key AS storage_key,a.relative_path',
  external_links: 'id,product_id,system,external_id,url,metadata',
  storage_files: 'f.id,s.key AS storage_key,f.relative_path,f.name,f.format,f.kind,f.media_type,f.size_bytes::text,f.sha256,f.status,f.created_at,f.checked_at,f.verified_at,f.metadata',
  import_sources: 'i.product_id,s.key AS storage_key,i.relative_path',
  storage_operations: 'id,kind,status,progress::text,total::text,parameters,result,error,created_at,updated_at',
  storage_matches: 'id,product_id,file_id,method,source_name,candidates,status,snapshot,applied_snapshot,operation_id,updated_at',
  storage_events: 'id::text,operation_id,file_id,product_id,action,details,created_at',
};
async function* databaseRows(client: PoolClient, table: PortableTable) {
  const source = table === 'storage_files' ? 'storage_files f JOIN storage_locations s ON s.id=f.storage_id' : table === 'import_sources' ? 'import_sources i JOIN storage_locations s ON s.id=i.storage_id' : table === 'assets' ? 'assets a LEFT JOIN storage_locations s ON s.id=a.storage_id' : table;
  const order = table === 'storage_files' ? 'f.id' : table === 'import_sources' ? 'i.product_id' : table === 'product_categories' ? 'product_id,category_id' : table === 'product_tags' ? 'product_id,tag_id' : table === 'assets' ? 'a.id' : 'id';
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
  readonly transferLimit: number;
  constructor(private pool: Pool, config: Config) { this.storage = new StorageService(config); this.transferLimit=Math.min(config.maxArchiveBytes??4*1024**3,4*1024**3); }
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
    await this.storage.assertPath(this.storage.workRoot);
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
    try {
      await this.storage.assertPath(this.storage.workRoot);
      await this.storage.assertPath(this.storage.managedRoot);
      await mkdir(directory, { mode: 0o700 });
    }
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
  async startExport(mode: 'metadata' | 'files' = 'files') {
    if(mode==='files') {
      const size=BigInt((await this.pool.query('SELECT coalesce(sum(size_bytes),0)::text AS bytes FROM storage_files')).rows[0].bytes);
      if(size>4n*1024n**3n)throw new TransferError('Библиотека больше 4 ГиБ. Экспортируйте метаданные отдельно и резервируйте оригиналы потоковым rsync на другой диск',409);
    }
    const job=await this.create('export','running');job.fileMode=mode;this.launch(job,()=>this.archive(job));return this.get(job.id);
  }
  async upload(source: Readable) {
    const job = await this.create('restore', 'uploading');
    const target = join(job.directory, 'upload.zip');
    let size = 0;
    try {
      await pipeline(source, new Transform({ transform: (chunk: Buffer, _enc, callback) => { try { this.check(job); size += chunk.length; if (size > this.transferLimit) throw new TransferError('ZIP больше допустимого лимита (до 4 ГиБ); используйте метаданные и отдельную копию оригиналов', 413); callback(null, chunk); } catch (error) { callback(error as Error); } } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    } catch (error) { job.status = 'failed'; job.error = 'Загрузка прервана или превышен допустимый размер'; this.busy = false; await this.persist(job); await rm(target, { force: true }); throw error; }
    job.status = 'running';
    try { await this.persist(job); } catch { this.busy = false; job.status = 'failed'; throw new TransferError('Не удалось сохранить состояние загрузки', 507); }
    this.launch(job, async () => {
      const entries = await extractArchive(target, this.staging(job.id), this.transferLimit, () => this.check(job));
      job.manifest = await validateArchive(this.staging(job.id), entries, () => this.check(job));
      const conflicts = await this.conflicts(job); const missingFiles=job.manifest.version===2?await this.checkRegistryFiles(job):[];
      job.result = { counts: Object.fromEntries((job.manifest.version===2?allTables():TABLES).map(table => [table, job.manifest!.tables[table].count])), conflicts, missingFiles, fileMode:job.manifest.fileMode };
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
  private async checkRegistryFiles(job:InternalJob) {
    const missing:{id:string;name:string;status:string}[]=[];
    for await(const f of rows(join(this.staging(job.id),'storage_files.ndjson'))) {
      if(f.archive_path)continue;
      this.check(job);
      try {
        const opened=await this.storage.open(f.storage_key,f.relative_path);const size=String(opened.stat.size);await opened.handle.close();
        if(f.size_bytes!==null&&size!==f.size_bytes||f.sha256&&await this.storage.hash(f.storage_key,f.relative_path,()=>this.check(job))!==f.sha256)missing.push({id:f.id,name:f.name,status:'corrupt'});
      } catch {missing.push({id:f.id,name:f.name,status:'unavailable'});}
    }
    return missing;
  }
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
      yield `{"format":"donarium-metadata","version":2,"createdAt":${JSON.stringify(new Date().toISOString())}`;
      for (const table of allTables()) { yield `,${JSON.stringify(table)}:[`; let first = true; for await (const row of databaseRows(client, table)) { if (!first) yield ','; first = false; yield JSON.stringify(row); } yield ']'; }
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
        const assets = await client.query("SELECT a.id,a.name,s.key AS storage_key,a.relative_path,a.external_url,a.metadata->>'role' AS role FROM assets a LEFT JOIN storage_locations s ON s.id=a.storage_id WHERE a.product_id=$1 ORDER BY a.id", [row.id]);
        yield [row.id, row.sku, row.title, row.description, row.status, categories.rows, tags.rows, assets.rows, row.cover_asset_id, row.created_at.toISOString(), row.updated_at.toISOString()].map(csv).join(',') + '\r\n';
      }
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  private async archive(job: InternalJob) {
    const client = await this.pool.connect();
    const zip = new yazl.ZipFile();
    const activeStreams=new Set<Readable>();
    (zip.outputStream as Readable).once('close',()=>{for(const stream of activeStreams)stream.destroy();});
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    let outputBytes=0,originalBytes=0;
    const output = pipeline(zip.outputStream, new Transform({transform:(chunk:Buffer,_encoding,done)=> {
      outputBytes+=chunk.length;
      done(outputBytes>this.transferLimit?new TransferError('Архив превышает допустимый размер',413):null,chunk);
    }}), createWriteStream(join(job.directory, 'archive.zip'), { flags: 'wx', mode: 0o600 }));
    // Attach a rejection handler immediately; preparation can fail before awaiting output.
    let outputError: unknown; void output.catch(error => { outputError = error; });
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const manifest: Manifest = { format: 'donarium', version: 2, fileMode:job.fileMode??'files', createdAt: new Date().toISOString(), tables: {} as Manifest['tables'] };
      for (const table of allTables()) {
        this.check(job); const path = join(job.directory, `${table}.ndjson`); const destination = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        let count = 0;
        // Prevent unhandled write failures while DB/files are being read.
        let writeError: Error | undefined; destination.on('error', error => { writeError = error; });
        try {
          for await (const original of databaseRows(client, table)) {
            this.check(job); if (writeError) throw writeError; if (outputError) throw outputError;
            const row = serializable(original);
            if(table==='assets') { delete row.storage_key;delete row.relative_path; }
            if(table==='storage_files') {
              row.archive_path=null;
              if(manifest.fileMode==='files') {
                const opened=await this.storage.open(row.storage_key,row.relative_path);const size=String(opened.stat.size);await opened.handle.close();
                originalBytes+=Number(size);
                if(!Number.isSafeInteger(originalBytes)||originalBytes>this.transferLimit)throw new TransferError('Архив превышает допустимый размер; используйте экспорт метаданных',413);
                const hash=await this.storage.hash(row.storage_key,row.relative_path,()=>this.check(job));
                if(row.size_bytes!==null&&size!==row.size_bytes||row.sha256&&hash!==row.sha256)throw new TransferError('Нарушена целостность оригинала; экспорт остановлен');
                row.size_bytes=size;row.sha256=hash;row.status='available';row.verified_at=new Date().toISOString();
                row.archive_path=`files/${row.id}/${safeFileName(row.name)}`;
                const key=row.storage_key,path=row.relative_path,expected=hash;
                zip.addReadStreamLazy(row.archive_path,{compress:false,size:Number(size),forceZip64Format:true},callback=> {
                  void this.storage.readStream(key,path).then(file=> {
                    if((zip.outputStream as Readable).destroyed){file.stream.destroy();callback(new TransferError('Экспорт прерван'),null as unknown as Readable);return;}
                    const digest=createHash('sha256');const verifier=new Transform({transform:(chunk:Buffer,_enc,done)=>{try{this.check(job);digest.update(chunk);done(null,chunk);}catch(error){done(error as Error);}},flush(done){done(digest.digest('hex')===expected?undefined:new TransferError('Оригинал изменился во время экспорта'));}});
                    activeStreams.add(verifier);verifier.once('close',()=>activeStreams.delete(verifier));
                    file.stream.on('error',error=>verifier.destroy(error));verifier.on('close',()=>file.stream.destroy());file.stream.pipe(verifier);callback(null,verifier);
                  }).catch(error=>callback(error,null as unknown as Readable));
                });
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
      job.result = { counts: Object.fromEntries(allTables().map(table => [table, manifest.tables[table].count])), bytes: String((await stat(join(job.directory, 'archive.zip'))).size) };
    } catch (error) { (zip.outputStream as Readable).destroy(error as Error); await output.catch(() => undefined); throw error; }
    finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  private async restore(job: InternalJob, conflict: 'skip' | 'copy') {
    const stage = this.staging(job.id), destination = join(this.storage.managedRoot, 'restored', job.id);
    const client = await this.pool.connect(); let moved = false, committed = false, commitAttempted = false;
    const newCategoryIds = new Set<string>();
    const fileIds = new Map<string,string>();
    const productIds = new Map<string, string>(), categoryIds = new Map<string, string>(), tagIds = new Map<string, string>(), assetIds = new Map<string, string>();
    let skipped = 0, copied = 0;
    try {
      await this.storage.assertPath(this.storage.managedRoot);
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('donarium_restore'))");
      const storage = await client.query<{ id: string }>(`INSERT INTO storage_locations(key,name,kind) VALUES('DONARIUM_UPLOADS','Загрузки DONARIUM','local') ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
      if(job.manifest?.version===2) {
        for await(const f of rows(join(stage,'storage_files.ndjson'))) {
          this.check(job);
          const existing=(await client.query('SELECT f.*,s.key AS storage_key FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE f.id=$1',[f.id])).rows[0];
          if(existing) {
            if(existing.sha256&&f.sha256&&existing.sha256!==f.sha256||existing.size_bytes!==null&&f.size_bytes!==null&&String(existing.size_bytes)!==f.size_bytes)throw new TransferError('UUID файла конфликтует с существующим содержимым');
            if(f.archive_path) {
              let checksum:string;
              try {checksum=await this.storage.hash(existing.storage_key,existing.relative_path,()=>this.check(job));}
              catch {throw new TransferError('Существующий оригинал недоступен. Проверьте хранилище перед повторным восстановлением; исходные связи сохранены');}
              if(checksum!==f.sha256)throw new TransferError('Содержимое существующего UUID отличается. Оригинал не перезаписан; требуется разрешить конфликт файла');
              await rm(join(stage,'files',f.id),{recursive:true,force:true});
              await client.query(`UPDATE storage_files SET sha256=coalesce(sha256,$2),size_bytes=coalesce(size_bytes,$3),status='available',checked_at=now(),verified_at=now() WHERE id=$1`,[existing.id,f.sha256,f.size_bytes]);
            }
            fileIds.set(f.id,existing.id);continue;
          }
          const path=f.archive_path?`restored/${job.id}/${f.archive_path.slice('files/'.length)}`:f.relative_path;
          const key=f.archive_path?'DONARIUM_UPLOADS':f.storage_key;
          const location=(await client.query(`INSERT INTO storage_locations(key,name,kind) VALUES($1,$1,'local') ON CONFLICT(key) DO UPDATE SET key=EXCLUDED.key RETURNING id`,[key])).rows[0].id;
          const samePath=(await client.query('SELECT id,sha256,size_bytes::text FROM storage_files WHERE storage_id=$1 AND relative_path=$2',[location,path])).rows[0];
          if(samePath) {
            if(samePath.sha256!==f.sha256||samePath.size_bytes!==f.size_bytes)throw new TransferError('Физический путь уже занят другим файлом');
            fileIds.set(f.id,samePath.id);continue;
          }
          let status=f.status;
          if(!f.archive_path) { try {const opened=await this.storage.open(key,path);const size=String(opened.stat.size);await opened.handle.close();if(f.size_bytes!==null&&size!==f.size_bytes||f.sha256&&await this.storage.hash(key,path,()=>this.check(job))!==f.sha256)status='corrupt';else status=f.sha256?'available':'unverified';}catch{status='unavailable';} }
          await client.query(`INSERT INTO storage_files(id,storage_id,relative_path,name,format,kind,media_type,size_bytes,sha256,status,created_at,checked_at,verified_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)`,[f.id,location,path,f.name,f.format,f.kind,f.media_type,f.size_bytes,f.sha256,status,f.created_at,status==='available'?new Date():f.verified_at,f.metadata]);
          fileIds.set(f.id,f.id);
        }
      }
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
        if(job.manifest?.version===2) {
          await client.query(`INSERT INTO assets(id,product_id,file_id,kind,name,media_type,size_bytes,sha256,version,external_url,origin,created_at,metadata,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,product,row.file_id?fileIds.get(row.file_id):null,row.kind,row.name,row.media_type,row.size_bytes,row.sha256,row.version,row.external_url,row.origin,row.created_at,row.metadata,row.retired_at]);continue;
        }
        const path = row.archive_path ? `restored/${job.id}/${row.archive_path.slice('files/'.length)}` : null;
        await client.query(`INSERT INTO assets(id,product_id,kind,name,media_type,size_bytes,sha256,version,storage_id,relative_path,external_url,origin,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, product, row.kind, row.name, row.media_type, row.size_bytes, row.sha256, row.version, path ? storage.rows[0]!.id : null, path, row.external_url, path ? 'uploaded' : 'external', row.created_at]);
      }
      if(job.manifest?.version===2)for await(const row of rows(join(stage,'import_sources.ndjson'))) {
        const product=productIds.get(row.product_id);if(!product)continue;
        const location=(await client.query(`INSERT INTO storage_locations(key,name,kind) VALUES($1,$1,'local') ON CONFLICT(key) DO UPDATE SET key=EXCLUDED.key RETURNING id`,[row.storage_key])).rows[0].id;
        await client.query('INSERT INTO import_sources(storage_id,relative_path,product_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[location,row.relative_path,product]);
      }
      // Trigger changes updated_at when setting cover; restore exported dates after it explicitly.
      await client.query("SET LOCAL donarium.preserve_updated_at = 'on'");
      const translateUrls=(value:string)=>value.replace(/\/api\/v1\/assets\/([0-9a-f-]{36})\/(download|content|thumbnail)/gi,(original,id,action)=>assetIds.has(id)?`/api/v1/assets/${assetIds.get(id)}/${action}`:original);
      for await(const row of rows(join(stage,'products.ndjson')))if(productIds.has(row.id)) {
        const description=translateUrls(row.description),imageUrl=row.image_url?translateUrls(row.image_url):null;
        if(description!==row.description||imageUrl!==row.image_url)await client.query('UPDATE products SET description=$2,image_url=$3 WHERE id=$1',[productIds.get(row.id),description,imageUrl]);
      }
      for await (const row of rows(join(stage, 'products.ndjson'))) if (productIds.has(row.id) && row.cover_asset_id) {
        await client.query('UPDATE products SET cover_asset_id=$2 WHERE id=$1', [productIds.get(row.id), assetIds.get(row.cover_asset_id)]);
      }
      for await (const row of rows(join(stage, 'external_links.ndjson'))) {
        const product = productIds.get(row.product_id); if (!product) continue; this.check(job);
        const copied=product!==row.product_id;
        await client.query(`INSERT INTO external_links(id,product_id,system,external_id,url,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [copied?randomUUID():row.id, product, copied?'donarium-copy':row.system, copied?`${row.id}:${product}`:row.external_id, row.url, copied?{...row.metadata,original_external_link:{id:row.id,product_id:row.product_id,system:row.system,external_id:row.external_id,url:row.url}}:row.metadata]);
      }
      if(job.manifest?.version===2) {
        for await(const row of rows(join(stage,'storage_operations.ndjson')))await client.query(`INSERT INTO storage_operations(id,kind,status,progress,total,parameters,result,error,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[row.id,row.kind,row.status==='running'?'interrupted':row.status,row.progress,row.total,row.parameters,row.result,row.error,row.created_at,row.updated_at]);
        // Remap physical identities without replacing historical values with today's
        // asset rows: doing so would erase rollback's detection of later user edits.
        const translateSnapshot=async(snapshot:Row|null,product:string):Promise<Row|null>=> {
          if(!snapshot)return null;
          const assets:Row[]=[];
          for(const original of snapshot.assets) {
            const a={...original,id:assetIds.get(original.id)??original.id,product_id:product};
            if(a.file_id) {
              a.file_id=fileIds.get(a.file_id)??a.file_id;
              const file=(await client.query('SELECT storage_id,relative_path,size_bytes::text,sha256 FROM storage_files WHERE id=$1',[a.file_id])).rows[0];
              // These four fields are registry mirrors rewritten by the asset trigger
              // on restore; normalize them while preserving user-editable history.
              if(file)Object.assign(a,file);
            }
            assets.push(a);
          }
          return {...snapshot,description:translateUrls(snapshot.description),assets,
            ...(snapshot.newAsset?{newAsset:assetIds.get(snapshot.newAsset)??snapshot.newAsset}:{})};
        };
        for await(const row of rows(join(stage,'storage_matches.ndjson'))) {
          const product=productIds.get(row.product_id);if(!product)continue;
          const snapshot=await translateSnapshot(row.snapshot,product);
          const after=await translateSnapshot(row.applied_snapshot,product);
          const id=product===row.product_id?row.id:randomUUID();
          await client.query(`INSERT INTO storage_matches(id,product_id,file_id,method,source_name,candidates,status,snapshot,applied_snapshot,operation_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[id,product,row.file_id?fileIds.get(row.file_id):null,row.method,row.source_name,JSON.stringify(row.candidates.map((id:string)=>fileIds.get(id)??id)),row.status,snapshot,after,row.operation_id,row.updated_at]);
        }
        for await(const row of rows(join(stage,'storage_events.ndjson'))) {
          if(row.product_id&&!productIds.has(row.product_id))continue;
          await client.query(`INSERT INTO storage_events(operation_id,file_id,product_id,action,details,created_at) VALUES($1,$2,$3,$4,$5,$6)`,[row.operation_id,row.file_id?fileIds.get(row.file_id):null,row.product_id?productIds.get(row.product_id):null,row.action,{...row.details,restoredEventId:row.id},row.created_at]);
        }
      }
      this.check(job);
      if ((assetIds.size || fileIds.size) && (await stat(join(stage, 'files')).catch(() => undefined))?.isDirectory() && (await readdir(join(stage,'files'))).length>0) { await mkdir(join(this.storage.managedRoot, 'restored'), { recursive: true, mode: 0o700 }); await rename(join(stage, 'files'), destination); moved = true; }
      const result = { imported: productIds.size, skipped, copied, assets: assetIds.size, files:fileIds.size, fileAliases:Object.fromEntries([...fileIds].filter(([old,id])=>old!==id)) };
      await client.query('INSERT INTO transfer_receipts(id,result) VALUES($1,$2)', [job.id, result]);
      commitAttempted = true;
      await client.query('COMMIT'); committed = true;
      job.result = result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((moved || commitAttempted) && !committed) {
        // COMMIT may have reached PostgreSQL even when its response was lost.
        // Query the durable receipt on a new connection before moving any bytes back.
        const receipt = await this.pool.query('SELECT result FROM transfer_receipts WHERE id=$1', [job.id]).catch(() => undefined);
        if (receipt?.rowCount) { committed = true; job.result = receipt.rows[0].result; }
        else if (receipt) { if(moved) await rename(destination, join(stage, 'files')).catch(() => undefined); }
        else throw new TransferError('БД недоступна: результат COMMIT пока неизвестен. Файлы сохранены; перезапустите приложение после восстановления БД');
      }
      if(!committed)throw error;
    } finally { client.release(); }
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(job.directory, 'upload.zip'), { force: true }).catch(() => undefined);
  }
}
