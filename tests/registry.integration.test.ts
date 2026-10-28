import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import Fastify,{type FastifyInstance} from 'fastify';
import { StorageService } from '../apps/api/src/storage/service.js';
import { FileRegistry,registerFile } from '../apps/api/src/storage/registry.js';
import { PostgresRepository } from '../apps/api/src/catalog/postgres.js';
import { registerStorageRoutes } from '../apps/api/src/storage/routes.js';
import { registerTransferRoutes } from '../apps/api/src/transfer/routes.js';
import { LibraryMatching, chooseMatches } from '../apps/api/src/storage/matching.js';
import { StorageJobs } from '../apps/api/src/storage/jobs.js';
import type { Config } from '../apps/api/src/config.js';
const testUrl=process.env.TEST_DATABASE_URL;
const schema=`registry_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool,pool:pg.Pool,temp:string,library:string,storage:StorageService,registry:FileRegistry,repo:PostgresRepository,app:FastifyInstance,config:Config;
before(async()=> {
 if(!testUrl)return;
 assert.match(new URL(testUrl).pathname,/^\/donarium_test(?:_[a-z0-9]+)*$/);
 admin=new pg.Pool({connectionString:testUrl});await admin.query(`CREATE SCHEMA ${schema}`);
 pool=new pg.Pool({connectionString:testUrl,options:`-c search_path=${schema},public`});
 for(const file of (await readdir(new URL('../db/migrations/',import.meta.url))).sort())if(file.endsWith('.sql'))await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
 temp=await mkdtemp(join(tmpdir(),'donarium-registry-'));library=join(temp,'library');await mkdir(library);await mkdir(join(temp,'inventory'));await writeFile(join(temp,'inventory','library-hash-status.json'),JSON.stringify({checked:2,total:607,bytes:123,total_bytes:423519933278,complete:false,updated_at:1}));
 config={host:'127.0.0.1',port:4180,dataMode:'postgres',logLevel:'silent',staticDir:temp,storageRoots:[{key:'LIBRARY',name:'Library',path:library},{key:'INVENTORY',name:'Inventory',path:join(temp,'inventory'),internal:true}],managedRoot:join(temp,'uploads'),workRoot:join(temp,'work')};
 storage=new StorageService(config);await storage.init();registry=new FileRegistry(pool,storage);repo=new PostgresRepository(pool);
 app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code((error as any).statusCode??500).send({error:{message:error instanceof Error?error.message:'Error'}}));
 await registerStorageRoutes(app,pool,repo,config);await registerTransferRoutes(app,pool,config);
});
after(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}if(temp)await rm(temp,{recursive:true,force:true});});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function operation(id:string) {
 for(let n=0;n<1000;n++){const job=(await app.inject(`/api/v1/storage/operations/${id}`)).json();if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,10));}throw new Error('Job timeout');
}
async function transfer(id:string) {
 for(let n=0;n<1000;n++){const job=(await app.inject(`/api/v1/transfers/${id}`)).json();if(!['running','uploading'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('Transfer timeout');
}
test('guarded storage refuses a local-directory fallback before creating any file',async()=> {
 const temp=await mkdtemp(join(tmpdir(),'donarium-guard-'));
 try {
  const storage=new StorageService({managedRoot:join(temp,'uploads'),workRoot:join(temp,'work'),requireStorageGuards:true});
  await assert.rejects(storage.writeUpload(Readable.from('bytes'),'x.rar'),/заблокированы/);
  assert.deepEqual(await readdir(temp),[]);
  const wrong=new StorageService({managedRoot:temp,workRoot:temp,storageGuards:[{path:temp,source:'192.168.0.141:/uploads',marker:'.donarium-volume',value:'expected'}]});
  await writeFile(join(temp,'.donarium-volume'),'expected');await assert.rejects(wrong.init(),/заблокированы/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('concurrent duplicate uploads keep one physical object and one registry record across products', {skip:!testUrl},async()=> {
 const roots=(await app.inject('/api/v1/storage/roots')).json();assert.equal(roots.inventoryAvailable,true);assert.ok(!roots.roots.some((root:any)=>root.key==='INVENTORY'));
 assert.equal((await app.inject('/api/v1/storage/inventory-status')).json().checked,2);
 const a=await repo.create({title:'Upload A'}),b=await repo.create({title:'Upload B'});
 const result=await Promise.all([registry.upload(Readable.from('same file'),'one.rar',a.id),registry.upload(Readable.from('same file'),'two.rar',b.id)]);
 assert.equal(result[0].file.id,result[1].file.id);assert.equal(result.filter(r=>r.deduplicated).length,1);
 const file=result[0].file;
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_files WHERE sha256=$1',[digest('same file')])).rows[0].n,1);
 assert.deepEqual(await readdir(join(temp,'uploads','.staging')),[]);
 assert.equal((await registry.attach(a.id,file.id)).id,result[0].asset!.id);
 const detail=(await app.inject(`/api/v1/files/${file.id}`)).json();assert.equal(detail.products.length,2);
 const search=await app.inject('/api/v1/files?q=one&unlinked=false');assert.equal(search.statusCode,200,search.body);assert.equal(search.json().items.length,1);
 const range=await app.inject({url:`/api/v1/assets/${result[0].asset!.id}/download`,headers:{range:'bytes=2-5'}});assert.equal(range.statusCode,206,range.body);assert.equal(range.body,'me f');
 assert.equal((await app.inject({url:`/api/v1/files/${file.id}/download`,headers:{range:'bytes=50-60'}})).statusCode,416);
 await app.inject({method:'DELETE',url:`/api/v1/products/${a.id}/assets/${result[0].asset!.id}`});
 await app.inject({method:'DELETE',url:`/api/v1/products/${b.id}/assets/${result[1].asset!.id}`});
 assert.equal((await app.inject('/api/v1/files?unlinked=true')).json().items.some((f:any)=>f.id===file.id),true);
 assert.equal(await readFile(join(temp,'uploads',file.relative_path),'utf8'),'same file');
 const interrupted=randomUUID(),lease=await pool.connect();
 await pool.query(`INSERT INTO storage_uploads(id,name,status) VALUES($1,'partial.rar','receiving')`,[interrupted]);
 await writeFile(join(temp,'uploads','.staging',interrupted),'partial');
 await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`donarium-upload:${interrupted}`]);
 try {
   const unsafeLink=await app.inject({method:'POST',url:`/api/v1/products/${a.id}/assets/link`,payload:{root:'DONARIUM_UPLOADS',paths:[`.staging/${interrupted}`]}});assert.equal(unsafeLink.statusCode,403);
   await app.inject({method:'POST',url:'/api/v1/storage/uploads/recover'});assert.equal((await pool.query('SELECT status FROM storage_uploads WHERE id=$1',[interrupted])).rows[0].status,'receiving');
 }finally{await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`donarium-upload:${interrupted}`]);lease.release();}
 await app.inject({method:'POST',url:'/api/v1/storage/uploads/recover'});assert.equal((await pool.query('SELECT status FROM storage_uploads WHERE id=$1',[interrupted])).rows[0].status,'interrupted');
 assert.equal((await app.inject({method:'DELETE',url:`/api/v1/storage/uploads/${interrupted}`})).statusCode,200);
 assert.equal(await readFile(join(temp,'uploads',file.relative_path),'utf8'),'same file');
});
test('case-sensitive originals remain separate; SHA-256 detects same-size corruption and disappearance', {skip:!testUrl},async()=> {
 await writeFile(join(library,'2b.rar'),'left');await writeFile(join(library,'2B.rar'),'left');
 const a=await registerFile(pool,storage,'LIBRARY','2b.rar'),b=await registerFile(pool,storage,'LIBRARY','2B.rar');assert.notEqual(a.id,b.id);
 const journal=[];for(const name of ['2b.rar','2B.rar']){const info=await stat(join(library,name),{bigint:true});journal.push({name,size:Number(info.size),sha256:digest('left'),mtime_ns:info.mtimeNs.toString(),ctime_ns:info.ctimeNs.toString()});}
 await writeFile(join(temp,'inventory','library-sha256.ndjson'),journal.map(row=>JSON.stringify(row)+'\n').join(''));
 const sync=await app.inject({method:'POST',url:'/api/v1/files/sync-checksums'});assert.equal(sync.statusCode,202,sync.body);assert.deepEqual((await operation(sync.json().jobId)).result.available,2);
 await registry.verify(a.id);await registry.verify(b.id);
 assert.equal((await app.inject('/api/v1/files?duplicates=true')).json().items.length,2);
 await writeFile(join(library,'2b.rar'),'xxxx');assert.equal((await registry.verify(a.id)).status,'corrupt');
 assert.equal((await registry.verify(a.id,false)).status,'corrupt','A presence-only probe must never clear a checksum failure');
 assert.equal((await pool.query('SELECT sha256 FROM storage_files WHERE id=$1',[a.id])).rows[0].sha256,digest('left'));
 assert.equal((await app.inject(`/api/v1/files/${a.id}/download`)).statusCode,409);
 await rm(join(library,'2B.rar'));assert.equal((await registry.verify(b.id)).status,'missing');
 const bulk=await app.inject({method:'POST',url:'/api/v1/files/verify',payload:{root:'LIBRARY'}});assert.equal(bulk.statusCode,202,bulk.body);
 assert.deepEqual((await operation(bulk.json().jobId)).result,{corrupt:1,missing:1},'Bulk verification must read each file, not only enumerate identifiers');
 await symlink('/etc/passwd',join(temp,'uploads','.staging','escape'));await assert.rejects(storage.open('DONARIUM_UPLOADS','.staging/escape'));
});
test('preview, explicit normalized confirmation, idempotent application and conditional rollback preserve UUIDs and user edits', {skip:!testUrl},async()=> {
 assert.equal(chooseMatches('2b',[{id:'a',name:'2b.rar'},{id:'b',name:'2B.rar'}]).method,'stem');
 assert.equal(chooseMatches('2 b',[{id:'a',name:'2b.rar'},{id:'b',name:'2B.rar'}]).method,'ambiguous');
 const p=await repo.create({title:'Migration card'}),url='https://drive.google.com/file/d/original/view';
 await pool.query('UPDATE products SET source_url=$2,description=$3 WHERE id=$1',[p.id,url,`Model ${url}`]);
 const old=(await pool.query(`INSERT INTO assets(product_id,kind,name,external_url) VALUES($1,'archive','Drive model',$2) RETURNING id`,[p.id,url])).rows[0].id;
 await pool.query(`INSERT INTO external_links(product_id,system,external_id,metadata) VALUES($1::uuid,'notion',$1::text,$2)`,[p.id,{source_fields:{'Имя STL/ZIP-файла':'My_Model'}}]);
 await writeFile(join(library,'My-Model.rar'),'model bytes');const f=await registerFile(pool,storage,'LIBRARY','My-Model.rar');await registry.verify(f.id);
 const start=await app.inject({method:'POST',url:'/api/v1/storage/matches/preview',payload:{root:'LIBRARY'}});assert.equal(start.statusCode,202,start.body);assert.equal((await operation(start.json().jobId)).status,'completed');
 const m=(await app.inject('/api/v1/storage/matches?q=Migration')).json().items[0];assert.equal(m.method,'normalized');assert.equal(m.status,'pending');
 assert.equal((await repo.get(p.id))!.assets[0]!.externalUrl,url);
 await app.inject({method:'POST',url:`/api/v1/storage/matches/${m.id}/confirm`,payload:{fileId:f.id}});
 const apply=await app.inject({method:'POST',url:'/api/v1/storage/matches/apply',payload:{ids:[m.id]}});const applied=await operation(apply.json().jobId);assert.equal(applied.result.applied,1,JSON.stringify(applied));
 const updated=(await repo.get(p.id))!;assert.equal(updated.assets[0]!.id,old);assert.equal(updated.sourceUrl,null);assert.equal(updated.assets[0]!.fileId,f.id);assert.ok(!updated.description.includes('drive.google.com'));
 const repeat=await app.inject({method:'POST',url:'/api/v1/storage/matches/apply',payload:{ids:[m.id]}});assert.equal((await operation(repeat.json().jobId)).result.skipped,1);
 await pool.query('UPDATE products SET description=$2,title=$3 WHERE id=$1',[p.id,'User edit','User title']);
 assert.equal((await app.inject({method:'POST',url:`/api/v1/storage/matches/${m.id}/rollback`})).statusCode,409);
 await pool.query('UPDATE products SET description=$2 WHERE id=$1',[p.id,updated.description]);
 const rolled=await app.inject({method:'POST',url:`/api/v1/storage/matches/${m.id}/rollback`});assert.equal(rolled.statusCode,200,rolled.body);
 const original=(await repo.get(p.id))!;assert.equal(original.title,'User title');assert.equal(original.assets[0]!.id,old);assert.equal(original.sourceUrl,url);assert.equal(original.assets[0]!.externalUrl,url);assert.equal(await readFile(join(library,'My-Model.rar'),'utf8'),'model bytes');
});
test('metadata-only v2 exports all registry records and sources, validates and restores without copying original bytes', {skip:!testUrl},async()=> {
 const appliedMatch=(await pool.query("SELECT id,file_id FROM storage_matches WHERE status='rolled_back' LIMIT 1")).rows[0];
 await app.inject({method:'POST',url:`/api/v1/storage/matches/${appliedMatch.id}/confirm`,payload:{fileId:appliedMatch.file_id}});
 const appliedAgain=await app.inject({method:'POST',url:'/api/v1/storage/matches/apply',payload:{ids:[appliedMatch.id]}});assert.equal((await operation(appliedAgain.json().jobId)).result.applied,1);
 const p=await repo.create({title:'Portable shared'});
 await writeFile(join(library,'portable.rar'),'portable');const f=await registerFile(pool,storage,'LIBRARY','portable.rar');await registry.verify(f.id);await registry.attach(p.id,f.id);
 const loc=(await pool.query("SELECT id FROM storage_locations WHERE key='LIBRARY'")).rows[0].id;
 await pool.query('INSERT INTO import_sources(storage_id,relative_path,product_id) VALUES($1,$2,$3)',[loc,'portable-folder',p.id]);
 const start=await app.inject({method:'POST',url:'/api/v1/exports/metadata'});assert.equal(start.statusCode,202,start.body);const exported=await transfer(start.json().id);assert.equal(exported.status,'completed',JSON.stringify(exported));
 const bytes=(await app.inject(`/api/v1/transfers/${exported.id}/download`)).rawPayload;assert.ok(bytes.length<100000);
 const restoredSchema=`registry_restore_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${restoredSchema}`);
 const restored=new pg.Pool({connectionString:testUrl,options:`-c search_path=${restoredSchema},public`});
 let target:FastifyInstance|undefined;
 try {
  for(const name of (await readdir(new URL('../db/migrations/',import.meta.url))).sort())if(name.endsWith('.sql'))await restored.query(await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8'));
  const targetConfig={...config,managedRoot:join(temp,'restore','uploads'),workRoot:join(temp,'restore','work')};
  target=Fastify();await registerTransferRoutes(target,restored,targetConfig);
  const uploaded=await target.inject({method:'PUT',url:'/api/v1/restores/preview',headers:{'content-type':'application/octet-stream'},payload:bytes});assert.equal(uploaded.statusCode,202,uploaded.body);
  let job:any;
  for(let i=0;i<1000;i++){job=(await target.inject(`/api/v1/transfers/${uploaded.json().id}`)).json();if(!['running','uploading'].includes(job.status))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'ready',JSON.stringify(job));assert.ok(job.result.missingFiles.length>=1);
  await target.inject({method:'POST',url:`/api/v1/restores/${job.id}/confirm`,payload:{conflict:'skip'}});
  for(let i=0;i<1000;i++){job=(await target.inject(`/api/v1/transfers/${job.id}`)).json();if(job.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'completed',JSON.stringify(job));
  const card=(await new PostgresRepository(restored).get(p.id))!;assert.equal(card.assets[0]!.fileId,f.id);assert.equal(card.assets[0]!.storageKey,'LIBRARY');assert.equal(card.assets[0]!.relativePath,'portable.rar');
  assert.equal((await restored.query('SELECT count(*)::int AS n FROM import_sources')).rows[0].n,1);
  assert.equal((await restored.query('SELECT count(*)::int AS n FROM storage_files')).rows[0].n,(await pool.query('SELECT count(*)::int AS n FROM storage_files')).rows[0].n);
  const restoredJobs=new StorageJobs(new FileRegistry(restored,new StorageService(targetConfig)),restored);
  await new LibraryMatching(restored,restoredJobs).rollback(appliedMatch.id);
  assert.equal((await restored.query('SELECT status FROM storage_matches WHERE id=$1',[appliedMatch.id])).rows[0].status,'rolled_back','Migration rollback must remain usable after moving logical roots');
 }finally{await target?.close();await restored.end();await admin.query(`DROP SCHEMA ${restoredSchema} CASCADE`);}
});
