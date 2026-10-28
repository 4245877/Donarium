import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import type { Config } from '../apps/api/src/config.js';
import { TransferService } from '../apps/api/src/transfer/service.js';
import { StorageService, StorageError } from '../apps/api/src/storage/service.js';
import { FileRegistry, registerFile } from '../apps/api/src/storage/registry.js';
import { StorageJobs } from '../apps/api/src/storage/jobs.js';
import { LibraryMatching, chooseMatches } from '../apps/api/src/storage/matching.js';
import { FolderImports } from '../apps/api/src/storage/imports.js';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `audit_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool, pool: pg.Pool, directory: string;
before(async () => {
  if (!testUrl) return;
  assert.match(new URL(testUrl).pathname, /^\/donarium_test(?:_[a-z0-9]+)*$/);
  admin = new pg.Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, max: 5, options: `-c search_path=${schema},public` });
  for (const name of (await readdir('db/migrations')).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(join('db/migrations', name), 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'donarium-audit-regression-'));
});
after(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
function config(name: string): Config {
  return { host: '127.0.0.1', port: 4199, dataMode: 'postgres', logLevel: 'silent', staticDir: directory,
    managedRoot: join(directory, name, 'uploads'), workRoot: join(directory, name, 'work') };
}

test('storage worker releases its pool connection when advisory lock acquisition fails', async () => {
  let released = 0;
  let destroyed = false;
  const failure = new Error('Connection lost before lock acquisition');
  const client = { query: async () => { throw failure; }, release: (destroy: boolean) => { released++; destroyed = destroy; } };
  const failedPool = { connect: async () => client } as unknown as pg.Pool;
  const jobs = new StorageJobs(undefined as unknown as FileRegistry, failedPool);
  await assert.rejects(jobs.start('test', {}, async () => undefined), error => error === failure);
  assert.equal(released, 1, 'A failed lock query must not leak the pool lease');
  assert.equal(destroyed, true, 'An uncertain lock must not return its session to the pool');
});

test('cancelled file verification leaves the existing integrity status unchanged', { skip: !testUrl }, async () => {
  const settings = config('verify-cancellation');
  const service = new StorageService(settings); await service.init();
  await writeFile(join(service.managedRoot, 'cancel.stl'), 'local verification fixture');
  const file = await registerFile(pool, service, 'DONARIUM_UPLOADS', 'cancel.stl');
  const registry = new FileRegistry(pool, service); await registry.verify(file.id);
  const before = (await pool.query('SELECT * FROM storage_files WHERE id=$1', [file.id])).rows[0];
  const cancelled = new StorageError('Operation interrupted', 503);
  let cancelledDuringHash = false;
  const hash = service.hash.bind(service);
  service.hash = async (key, path, check) => { cancelledDuringHash = true; return hash(key, path, check); };
  await assert.rejects(registry.verify(file.id, true, () => { if (cancelledDuringHash) throw cancelled; }), error => error === cancelled);
  assert.deepEqual((await pool.query('SELECT * FROM storage_files WHERE id=$1', [file.id])).rows[0], before);
});

test('folder import recognizes the same MAX, TAR and GZ model packages as the figure picker', { skip: !testUrl }, async () => {
  const settings = config('import-formats');
  const service = new StorageService(settings); await service.init();
  for (const extension of ['max', 'tar', 'gz']) {
    await mkdir(join(service.managedRoot, extension));
    await writeFile(join(service.managedRoot, extension, `model.${extension}`), 'format fixture');
  }
  const imports = new FolderImports(service, pool);
  try {
    const id = await imports.scan('DONARIUM_UPLOADS', '');
    for (let n = 0; n < 100 && imports.get(id).status === 'scanning'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(imports.get(id).status, 'preview');
    assert.deepEqual(imports.get(id).items.map(item => item.path).sort(), ['gz', 'max', 'tar']);
    imports.confirm(id, ['gz', 'max', 'tar']);
    for (let n = 0; n < 100 && imports.get(id).status === 'importing'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(imports.get(id).report?.created, 3);
    assert.equal(imports.get(id).report?.errors, 0);
  } finally { await imports.close(); }
});
test('extension-free matching handles models and sources and keeps duplicates ambiguous', () => {
  for(const name of ['Лиса.STL','Лиса.3mf','Лиса.blend','Лиса.tar.gz'])assert.equal(chooseMatches('Лиса',[{id:'test',name}]).method,'stem',name);
  const duplicate=chooseMatches('Лиса',[{id:'a',name:'Лиса.stl'},{id:'b',name:'Лиса.STL'}]);
  assert.equal(duplicate.method,'ambiguous');assert.equal(duplicate.fileId,null);
  assert.equal(chooseMatches('',[{id:'test',name:'Лиса.stl'}]).method,'missing');
});
async function waitTransfer(service: TransferService, id: string) {
  for (let n = 0; n < 500; n++) { const job = service.get(id); if (!['running','uploading'].includes(job.status)) { await service.close(); return job; } await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Transfer timeout');
}
async function exportMetadata() {
  const service = new TransferService(pool, config(randomUUID())); await service.init();
  try {
    const job = await service.startExport('metadata'); const done = await waitTransfer(service, job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done)); return await readFile(service.download(job.id));
  } finally { await service.close(); }
}
async function waitOperation(id: string) {
  for (let n = 0; n < 500; n++) { const row = (await pool.query('SELECT * FROM storage_operations WHERE id=$1',[id])).rows[0]; if (row.status !== 'running') return row; await new Promise(r => setTimeout(r,10)); }
  throw new Error('Operation timeout');
}
async function matchingFixture(name: string, existing = false, driveImage = false) {
  const settings = config(name), library = join(directory, name, 'library'); await mkdir(library,{recursive:true});
  settings.storageRoots = [{key:'AUDIT_LIBRARY',name:'Audit',path:library}];
  const storage = new StorageService(settings); await storage.init();
  const registry = new FileRegistry(pool, storage), jobs = new StorageJobs(registry,pool), matching = new LibraryMatching(pool,jobs);
  const source = `https://drive.google.com/file/d/${name}/view`;
  const product = (await pool.query('INSERT INTO products(title,description,source_url) VALUES($1,$2,$3) RETURNING *',[name,`Archive ${source}${driveImage?' Photo https://drive.google.com/file/d/unrelated-photo/view':''}`,source])).rows[0];
  await pool.query("INSERT INTO external_links(product_id,system,external_id,metadata) VALUES($1::uuid,'audit',$1::text,$2)",[product.id,{source_fields:{'Имя STL/ZIP-файла':name}}]);
  await writeFile(join(library,`${name}.rar`),`archive ${name}`);
  const file = await registerFile(pool,storage,'AUDIT_LIBRARY',`${name}.rar`);
  let asset: string | undefined;
  if (existing) asset = (await registry.attach(product.id,file.id)).id;
  else asset = (await pool.query("INSERT INTO assets(product_id,kind,name,external_url) VALUES($1,'archive','Archive',$2) RETURNING id",[product.id,source])).rows[0].id;
  let image: string | undefined;
  if (driveImage) image = (await pool.query("INSERT INTO assets(product_id,kind,name,external_url,created_at) VALUES($1,'image','Drive photo',$2,now()-interval '1 day') RETURNING id",[product.id,'https://drive.google.com/file/d/unrelated-photo/view'])).rows[0].id;
  await registry.verify(file.id);
  await waitOperation((await matching.preview('AUDIT_LIBRARY')).jobId);
  const match = (await pool.query('SELECT * FROM storage_matches WHERE product_id=$1',[product.id])).rows[0];
  await matching.confirm(match.id,file.id); const applied = await waitOperation((await matching.apply([match.id])).jobId);
  assert.equal(applied.result.applied,1,JSON.stringify(applied.result));
  return {settings,storage,registry,jobs,matching,product,file,asset:asset!,image,match};
}

test('transfer accepts a retry after a transient storage guard failure', {skip:!testUrl}, async () => {
  const service = new TransferService(pool,config('guard-retry')); await service.init();
  const original = service.storage.assertPath.bind(service.storage); let fail = true;
  service.storage.assertPath = async path => { if (fail) { fail = false; throw new StorageError('Simulated unavailable NFS',503); } await original(path); };
  try {
    await assert.rejects(service.startExport('metadata'),/unavailable NFS/);
    const retry = await service.startExport('metadata');
    assert.equal((await waitTransfer(service,retry.id)).status,'completed');
  } finally { await service.close(); }
});

test('export enforces the archive byte limit on actual ZIP output and removes incomplete output', {skip:!testUrl}, async () => {
  const service=new TransferService(pool,{...config('archive-output-limit'),maxArchiveBytes:1024});await service.init();
  try {
    const job=await service.startExport('metadata');const result=await waitTransfer(service,job.id);
    assert.equal(result.status,'failed','Metadata and ZIP headers must also obey the archive limit');
    assert.match(result.error!,/размер/);
    assert.equal(await stat(join(service.storage.workRoot,`transfer-${job.id}`,'archive.zip')).then(()=>true,()=>false),false);
  } finally {await service.close();}
});

test('metadata restore resolves a lost real COMMIT acknowledgement using its receipt', {skip:!testUrl}, async () => {
  const archive = await exportMetadata(); let lost = false;
  const uncertainPool = new Proxy(pool,{get(target,key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client,{get(connection,member) {
        if (member === 'query') return async (sql:string,values?:unknown[]) => {
          const result = await connection.query(sql,values);
          if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Lost COMMIT acknowledgement'); }
          return result;
        };
        const value = Reflect.get(connection,member,connection); return typeof value === 'function' ? value.bind(connection) : value;
      }});
    };
    const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const service = new TransferService(uncertainPool,config('metadata-commit')); await service.init();
  try {
    const uploaded = await service.upload(Readable.from(archive));
    for (let n=0;service.get(uploaded.id).status==='running'&&n<500;n++) await new Promise(r=>setTimeout(r,10));
    assert.equal(service.get(uploaded.id).status,'ready');
    await service.confirm(uploaded.id,'skip');
    assert.equal((await waitTransfer(service,uploaded.id)).status,'completed'); assert.equal(lost,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM transfer_receipts WHERE id=$1',[uploaded.id])).rows[0].n,1);
    assert.equal(await stat(join(service.storage.managedRoot,`.restore-stage-${uploaded.id}`)).then(()=>true,()=>false),false,'A reconciled COMMIT must clean extracted temporary files');
  } finally { await service.close(); }
});

test('restore releases its database client when NFS disappears before BEGIN', {skip:!testUrl}, async () => {
  const archive = await exportMetadata(); const leased = new Set<pg.PoolClient>();
  const trackedPool = new Proxy(pool,{get(target,key) {
    if(key==='connect') return async()=> {
      const client=await target.connect(); leased.add(client);
      return new Proxy(client,{get(connection,member) {
        if(member==='release') return ()=>{leased.delete(client);client.release();};
        const value=Reflect.get(connection,member,connection);return typeof value==='function'?value.bind(connection):value;
      }});
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const service=new TransferService(trackedPool,config('guard-client')); await service.init();
  try {
    const uploaded=await service.upload(Readable.from(archive));
    for(let n=0;service.get(uploaded.id).status==='running'&&n<500;n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(service.get(uploaded.id).status,'ready');
    const original=service.storage.assertPath.bind(service.storage);
    service.storage.assertPath=async path=>{if(path===service.storage.managedRoot)throw new StorageError('Simulated unavailable NFS',503);await original(path);};
    await service.confirm(uploaded.id,'skip'); assert.equal((await waitTransfer(service,uploaded.id)).status,'failed');
    assert.equal(leased.size,0,'All acquired clients must be released after a guard failure');
  } finally {await service.close();for(const client of leased)client.release();}
});

test('matching rollback retains a local attachment that existed before matching', {skip:!testUrl}, async () => {
  const f=await matchingFixture('existing-link',true);
  try {
    await f.matching.rollback(f.match.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets WHERE id=$1',[f.asset])).rows[0].n,1);
    assert.deepEqual((await pool.query('SELECT metadata FROM assets WHERE id=$1',[f.asset])).rows[0].metadata,{});
  } finally {await f.jobs.close();}
});

test('an interrupted upload leaves no object or attachment and a subsequent retry succeeds', {skip:!testUrl}, async () => {
  const storage=new StorageService(config('aborted-upload'));await storage.init();
  const registry=new FileRegistry(pool,storage);
  const before=(await pool.query('SELECT count(*)::int AS n FROM storage_files')).rows[0].n;
  let read=false;const source=new Readable({read(){if(read)return;read=true;this.push(Buffer.from('incomplete bytes'));queueMicrotask(()=>this.destroy(new Error('Simulated client disconnect')));}});
  await assert.rejects(registry.upload(source,'aborted-test.rar'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_files')).rows[0].n,before);
  assert.deepEqual(await readdir(join(storage.managedRoot,'.staging')),[]);
  assert.equal((await pool.query("SELECT status FROM storage_uploads WHERE name='aborted-test.rar'")).rows[0].status,'failed');
  const retried=await registry.upload(Readable.from('complete bytes after retry'),'retry-test.rar');
  assert.equal(await storage.hash('DONARIUM_UPLOADS',retried.file.relative_path),retried.file.sha256);
});

test('matching preserves unrelated Google Drive images and their description URLs', {skip:!testUrl}, async () => {
  const f=await matchingFixture('drive-image',false,true);
  try {
    const image=(await pool.query('SELECT * FROM assets WHERE id=$1',[f.image])).rows[0];
    assert.equal(image.kind,'image'); assert.equal(image.external_url,'https://drive.google.com/file/d/unrelated-photo/view'); assert.equal(image.retired_at,null);
    assert.match((await pool.query('SELECT description FROM products WHERE id=$1',[f.product.id])).rows[0].description,/https:\/\/drive.google.com\/file\/d\/unrelated-photo\/view/);
  } finally {await f.jobs.close();}
});

test('restoring matching history preserves conflict detection for later user attachment edits', {skip:!testUrl}, async () => {
  const f=await matchingFixture('edited-history');
  const unchanged=await matchingFixture('unchanged-existing-history',true);
  const restoredSchema=`audit_restore_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${restoredSchema}`);
  const target=new pg.Pool({connectionString:testUrl,options:`-c search_path=${restoredSchema},public`});
  const settings={...f.settings,managedRoot:join(directory,'edited-target','uploads'),workRoot:join(directory,'edited-target','work')};
  const service=new TransferService(target,settings);
  try {
    await pool.query('UPDATE assets SET name=$2 WHERE id=$1',[f.asset,'User renamed archive.rar']);
    for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await target.query(await readFile(join('db/migrations',name),'utf8'));
    await service.init(); const uploaded=await service.upload(Readable.from(await exportMetadata()));
    for(let n=0;service.get(uploaded.id).status==='running'&&n<500;n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(service.get(uploaded.id).status,'ready',JSON.stringify(service.get(uploaded.id)));
    await service.confirm(uploaded.id,'skip');assert.equal((await waitTransfer(service,uploaded.id)).status,'completed');
    const jobs=new StorageJobs(new FileRegistry(target,new StorageService(settings)),target);
    try {
      const matching=new LibraryMatching(target,jobs);
      await assert.rejects(matching.rollback(f.match.id),/Связи изменены/);
      await matching.rollback(unchanged.match.id);
      assert.equal((await target.query('SELECT count(*)::int AS n FROM assets WHERE id=$1',[unchanged.asset])).rows[0].n,1,'An unchanged, previously verified local link must remain usable after restore');
    }
    finally {await jobs.close();}
    assert.equal((await target.query('SELECT name FROM assets WHERE id=$1',[f.asset])).rows[0].name,'User renamed archive.rar');
  } finally {await f.jobs.close();await unchanged.jobs.close();await service.close();await target.end();await admin.query(`DROP SCHEMA ${restoredSchema} CASCADE`);}
});

test('metadata archive remains restorable after detaching an attachment recorded in matching history', {skip:!testUrl}, async () => {
  const f=await matchingFixture('detached-history');
  try {
    await pool.query('DELETE FROM assets WHERE id=$1',[f.asset]);
    const archive=await exportMetadata(); const service=new TransferService(pool,config('history-preview'));await service.init();
    try {
      const uploaded=await service.upload(Readable.from(archive)); const preview=await waitTransfer(service,uploaded.id);
      assert.equal(preview.status,'ready',JSON.stringify(preview));
    } finally {await service.close();}
  } finally {await f.jobs.close();}
});
