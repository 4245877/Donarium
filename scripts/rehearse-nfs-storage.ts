/** Real-data rehearsal. Only a verified, isolated backup database can be modified. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {StorageService} from '../apps/api/src/storage/service.js';
import {FileRegistry} from '../apps/api/src/storage/registry.js';
import {StorageJobs} from '../apps/api/src/storage/jobs.js';
import {LibraryMatching} from '../apps/api/src/storage/matching.js';
const directory=resolve(process.argv[2]??'');
if(!directory.startsWith(resolve('backups')+sep))throw new Error('A verified backup directory is required');
const proof=JSON.parse(await readFile(join(directory,'restore-verification.json'),'utf8'));
if(!/^donarium_test_backup_\d+$/.test(proof.database)||proof.container!=='donarium-audit-test-db-1'||proof.checksumErrors!==0)throw new Error('Only an isolated verified backup is allowed');
const pool=new pg.Pool({connectionString:`postgresql://donarium_test@127.0.0.1:5549/${proof.database}`,max:5});
const guards=['library','uploads','work','inventory'].map(name=>({path:`/mnt/donarium/${name}`,source:`192.168.0.141:/${name}`,marker:'.donarium-volume',value:`donarium:76d90fb2-6d59-4fdb-8280-81154e6c93d9:${name}`}));
const storage=new StorageService({managedRoot:'/mnt/donarium/uploads',workRoot:'/mnt/donarium/work',storageRoots:[{key:'LIBRARY',name:'Архивы моделей',path:'/mnt/donarium/library'},{key:'INVENTORY',name:'Описи',path:'/mnt/donarium/inventory',internal:true}],requireStorageGuards:true,storageGuards:guards});
const jobs=new StorageJobs(new FileRegistry(pool,storage),pool);
async function wait(id:string) {
 let last=0;
 for(;;){const job=(await pool.query('SELECT * FROM storage_operations WHERE id=$1',[id])).rows[0];if(job.status!=='running'){if(job.status!=='completed')throw new Error(job.error??'Rehearsal operation failed');return job.result;}
 if(Date.now()-last>10000){console.log(`${job.kind}: ${job.progress}/${job.total}`);last=Date.now();}
 await new Promise(r=>setTimeout(r,250));}
}
try {
 const beforeProducts=(await pool.query('SELECT to_jsonb(p) AS row FROM products p ORDER BY id')).rows;
 const beforeAssets=(await pool.query("SELECT to_jsonb(a)-'file_id'-'metadata'-'retired_at' AS row FROM assets a ORDER BY id")).rows;
 if(!(await pool.query("SELECT to_regclass('storage_files') AS t")).rows[0].t){
  const sql=await readFile('db/migrations/006_storage_registry.sql','utf8');
  const client=await pool.connect();try{await client.query('BEGIN');await client.query(sql);await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',['006_storage_registry.sql',createHash('sha256').update(sql).digest('hex')]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const inventory=await wait((await jobs.inventory('LIBRARY')).jobId);
 const checksums=await wait((await jobs.syncChecksums()).jobId);
 const uploads=await wait((await jobs.verify('DONARIUM_UPLOADS')).jobId);
 const matching=await wait((await new LibraryMatching(pool,jobs).preview('LIBRARY')).jobId);
 const afterProducts=(await pool.query('SELECT to_jsonb(p) AS row FROM products p ORDER BY id')).rows;
 const afterAssets=(await pool.query("SELECT to_jsonb(a)-'file_id'-'metadata'-'retired_at' AS row FROM assets a ORDER BY id")).rows;
 if(JSON.stringify(beforeProducts)!==JSON.stringify(afterProducts)||JSON.stringify(beforeAssets)!==JSON.stringify(afterAssets))throw new Error('Rehearsal changed original product/asset data');
 const summary=(await pool.query(`SELECT count(*)::int AS files,count(*) FILTER(WHERE status='available')::int AS available,count(*) FILTER(WHERE status='unverified')::int AS unverified,count(*) FILTER(WHERE status IN ('missing','corrupt','unavailable'))::int AS issues FROM storage_files`)).rows[0];
 const matches=(await pool.query(`SELECT m.product_id,p.title,m.source_name,m.method,m.status,f.name AS archive,f.sha256,f.status AS file_status FROM storage_matches m JOIN products p ON p.id=m.product_id LEFT JOIN storage_files f ON f.id=m.file_id ORDER BY m.method,p.title`)).rows;
 const report={database:proof.database,scope:'isolated verified backup; real NFS data read only',inventory,checksums,uploads,matching,summary,preservedProducts:beforeProducts.length,preservedAssets:beforeAssets.length,productionChanged:false,generatedAt:new Date().toISOString(),matches};
 await writeFile(join(directory,'nfs-rehearsal.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,matches:undefined},null,2));
 if(inventory.errorCount!==0||checksums.conflicts!==0||checksums.available!==inventory.registered||uploads.available!==proof.checked||summary.files!==proof.checked+inventory.registered||summary.available!==summary.files||summary.issues!==0||summary.unverified!==0)throw new Error('Real NFS rehearsal did not verify every registered file');
}finally{await jobs.close();await pool.end();}
