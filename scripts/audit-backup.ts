/** Fresh read-only dump + metadata export, restored only in disposable PostgreSQL. */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { TransferService } from '../apps/api/src/transfer/service.js';
import { StorageService } from '../apps/api/src/storage/service.js';
import type { Config } from '../apps/api/src/config.js';

const directory=resolve('var/qa/independent-audit-20261028'); await mkdir(directory,{recursive:true,mode:0o700});
const temporary=await mkdtemp(join(tmpdir(),'donarium-audit-backup-'));
const tables=['products','categories','tags','product_categories','product_tags','assets','external_links','storage_locations','storage_files','import_sources','storage_matches','storage_events','storage_operations','storage_uploads'];
async function run(args:string[], input?:string, output?:string) {
  const child=spawn('docker',args,{stdio:[input?'pipe':'ignore',output?'pipe':'ignore','pipe']});
  const completion=new Promise<void>((done,fail)=>{child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error(`Docker ${args[0]} failed (${code})`)));});
  // Consume stderr without printing source data or credentials.
  child.stderr!.resume();
  await Promise.all([completion,input?pipeline(createReadStream(input),child.stdin!):Promise.resolve(),output?pipeline(child.stdout!,createWriteStream(output,{flags:'wx',mode:0o600})):Promise.resolve()]);
}
async function fingerprints(pool:pg.Pool, names:string[]) {
  const result:Record<string,unknown>={};const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for(const table of names) {const rows=(await client.query(`SELECT to_jsonb(t)::text AS data FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');result[table]={count:rows.length,sha256:hash.digest('hex')};}
    await client.query('ROLLBACK');return result;
  } finally {client.release();}
}
async function wait(service:TransferService,id:string) {
  for(let n=0;n<6000;n++){const job=service.get(id);if(!['running','uploading'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('Backup verification timed out');
}
const stamp=Date.now(),dumpDb=`donarium_test_audit_dump_${stamp}`,metadataDb=`donarium_test_audit_meta_${stamp}`;
const dumpPath=join(directory,`database-${stamp}.dump`);
let dumpCreated=false,metadataCreated=false,dumped:pg.Pool|undefined,restored:pg.Pool|undefined,exporter:TransferService|undefined,importer:TransferService|undefined;
try {
  await run(['exec','donarium-db-1','pg_dump','-U','donarium','-d','donarium','--format=custom','--no-owner','--no-acl'],undefined,dumpPath);
  await run(['exec','donarium-audit-test-db-1','createdb','-U','donarium_test',dumpDb]);dumpCreated=true;
  await run(['exec','-i','donarium-audit-test-db-1','pg_restore','-U','donarium_test','-d',dumpDb,'--no-owner','--no-acl','--exit-on-error'],dumpPath);
  const testUrl=(database:string)=>`postgresql://donarium_test@127.0.0.1:5549/${database}`;
  dumped=new pg.Pool({connectionString:testUrl(dumpDb),max:2});
  const baseline=JSON.parse(await readFile(join(directory,'production-before.json'),'utf8')).tables;
  const dumpFingerprint=await fingerprints(dumped,tables);
  const dumpEqual=JSON.stringify(baseline)===JSON.stringify(dumpFingerprint);
  if(!dumpEqual)throw new Error('Fresh dump differs from production baseline; inspect concurrent changes');
  // Source is the restored dump, never a production write connection. Registry references
  // retain the original NFS logical paths while temporary work stays below our temp dir.
  const settings:Config={host:'127.0.0.1',port:4199,dataMode:'postgres',logLevel:'silent',staticDir:temporary,
    managedRoot:join(temporary,'export-uploads'),workRoot:join(temporary,'export-work'),
    storageRoots:[{key:'LIBRARY',name:'Library',path:'/mnt/donarium/library'}]};
  exporter=new TransferService(dumped,settings);await exporter.init();
  const exported=await exporter.startExport('metadata');const complete=await wait(exporter,exported.id);
  if(complete.status!=='completed')throw new Error(`Metadata export ${complete.status}`);
  const archive=await readFile(exporter.download(exported.id));
  await writeFile(join(directory,`metadata-${stamp}.zip`),archive,{mode:0o600});
  await run(['exec','donarium-audit-test-db-1','createdb','-U','donarium_test',metadataDb]);metadataCreated=true;
  restored=new pg.Pool({connectionString:testUrl(metadataDb),max:5});
  const {readdir}=await import('node:fs/promises');
  for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await restored.query(await readFile(join('db/migrations',name),'utf8'));
  // Staging and extraction are isolated. Only reads of referenced original bytes use
  // the live NFS paths; even metadata staging must never enter production uploads.
  importer=new TransferService(restored,{...settings,managedRoot:join(temporary,'restore-uploads'),workRoot:join(temporary,'restore-work')});
  const originals=new StorageService({...settings,managedRoot:'/mnt/donarium/uploads'});
  const isolatedOpen=importer.storage.open.bind(importer.storage);
  importer.storage.open=(key,path,directory=false)=>key==='DONARIUM_UPLOADS'?originals.open(key,path,directory):isolatedOpen(key,path,directory);
  const journal=new Map<string,any>();
  for(const line of (await readFile('/mnt/donarium/inventory/library-sha256.ndjson','utf8')).trim().split('\n')) {const row=JSON.parse(line);journal.set(row.name,row);}
  const hashOriginal=importer.storage.hash.bind(importer.storage);
  importer.storage.hash=async(key,path,check=()=>undefined)=> {
    if(key!=='LIBRARY')return hashOriginal(key,path,check);
    check();const file=await originals.open(key,path);
    try {
      const info=await file.handle.stat({bigint:true}),record=journal.get(path);
      if(!record||BigInt(record.size)!==info.size||BigInt(record.mtime_ns)!==info.mtimeNs||BigInt(record.ctime_ns)!==info.ctimeNs)throw new Error('Library fingerprint changed');
      return record.sha256 as string;
    } finally {await file.handle.close();}
  };
  await importer.init();
  const upload=await importer.upload(Readable.from(archive));const preview=await wait(importer,upload.id);
  if(preview.status!=='ready')throw new Error(`Metadata preview ${preview.status}: ${preview.error}`);
  await importer.confirm(upload.id,'skip');const restoredJob=await wait(importer,upload.id);
  if(restoredJob.status!=='completed')throw new Error(`Metadata restore ${restoredJob.status}: ${restoredJob.error}`);
  // Logical identities are compared; host-specific storage UUIDs/check timestamps may change.
  const normalized=async(p:pg.Pool)=>({
    products:(await p.query('SELECT id,sku,title,description,status,cover_asset_id,created_at,updated_at FROM products ORDER BY id')).rows,
    assets:(await p.query('SELECT a.id,a.product_id,a.file_id,s.key,a.relative_path,a.external_url,a.name,a.kind,a.size_bytes::text,a.sha256,a.metadata,a.retired_at FROM assets a LEFT JOIN storage_locations s ON s.id=a.storage_id ORDER BY a.id')).rows,
    files:(await p.query('SELECT f.id,s.key,f.relative_path,f.name,f.size_bytes::text,f.sha256 FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id ORDER BY f.id')).rows,
    matches:(await p.query('SELECT id,product_id,file_id,status,source_name,method,candidates FROM storage_matches ORDER BY id')).rows,
    sources:(await p.query('SELECT * FROM external_links ORDER BY id')).rows,
    categories:(await p.query('SELECT * FROM categories ORDER BY id')).rows,
    categoryLinks:(await p.query('SELECT * FROM product_categories ORDER BY product_id,category_id')).rows,
  });
  const a=await normalized(dumped),b=await normalized(restored);const equality=Object.fromEntries(Object.keys(a).map(key=>[key,JSON.stringify(a[key as keyof typeof a])===JSON.stringify(b[key as keyof typeof b])]));
  if(Object.values(equality).some(v=>!v))throw new Error(`Metadata comparison failed: ${JSON.stringify(equality)}`);
  const report={checkedAt:new Date().toISOString(),dumpPath,dumpSha256:createHash('sha256').update(await readFile(dumpPath)).digest('hex'),dumpEqual,metadataBytes:archive.length,metadataEquality:equality,previewMissingFiles:preview.result?.missingFiles,restore:restoredJob.result,productionWrites:0,originalFileCopies:0,libraryVerification:'QA hash adapter uses saved SHA-256 only after exact size/mtime_ns/ctime_ns match; 394 GiB content is not rehashed. Uploads use actual SHA-256.'};
  await writeFile(join(directory,'backup-restore.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
} finally {
  await exporter?.close();await importer?.close();await dumped?.end();await restored?.end();
  if(dumpCreated)await run(['exec','donarium-audit-test-db-1','dropdb','-U','donarium_test',dumpDb]);
  if(metadataCreated)await run(['exec','donarium-audit-test-db-1','dropdb','-U','donarium_test',metadataDb]);
  await rm(temporary,{recursive:true,force:true});
}
