/** Rehearsal exclusively against a restored backup. Never addresses production. */
import { readFile,writeFile } from 'node:fs/promises';
import { join,extname } from 'node:path';
import pg from 'pg';
import { StorageService } from '../apps/api/src/storage/service.js';
import { FileRegistry } from '../apps/api/src/storage/registry.js';
import { StorageJobs } from '../apps/api/src/storage/jobs.js';
import { LibraryMatching } from '../apps/api/src/storage/matching.js';
const directory='backups/storage-registry-20261027';
const verification=JSON.parse(await readFile(join(directory,'restore-verification.json'),'utf8'));
if(!/^donarium_test_backup_\d+$/.test(verification.database)||verification.container!=='donarium-audit-test-db-1')throw new Error('Only isolated restored backup is allowed');
const pool=new pg.Pool({connectionString:`postgresql://donarium_test@127.0.0.1:5549/${verification.database}`});
const service=new StorageService({storageRoots:[{key:'LIBRARY',name:'Архивы моделей',path:'/mnt/donarium/library'}]});
const jobs=new StorageJobs(new FileRegistry(pool,service),pool);
try {
 const uploads=(await pool.query("SELECT a.id,a.relative_path,a.size_bytes::text,a.sha256 FROM assets a JOIN storage_locations s ON s.id=a.storage_id WHERE s.key='DONARIUM_UPLOADS' ORDER BY a.id")).rows;
 await writeFile(join(directory,'uploads-manifest.json'),JSON.stringify(uploads),{mode:0o600});
 const before=(await pool.query('SELECT id,product_id,external_url FROM assets ORDER BY id')).rows;
 if(!(await pool.query("SELECT to_regclass('storage_files') AS t")).rows[0].t)await pool.query(await readFile('db/migrations/006_storage_registry.sql','utf8'));
 const location=(await pool.query(`INSERT INTO storage_locations(key,name,kind) VALUES('LIBRARY','Архивы моделей','local') ON CONFLICT(key) DO UPDATE SET key=EXCLUDED.key RETURNING id`)).rows[0].id;
 const files=JSON.parse(await readFile(join(directory,'library-inventory.json'),'utf8'));
 for(const f of files)await pool.query(`INSERT INTO storage_files(storage_id,relative_path,name,format,kind,size_bytes) VALUES($1,$2,$2,$3,'archive',$4) ON CONFLICT(storage_id,relative_path) DO NOTHING`,[location,f.name,extname(f.name).slice(1).toLowerCase(),f.size]);
 const {jobId}=await new LibraryMatching(pool,jobs).preview('LIBRARY');
 while((await pool.query('SELECT status FROM storage_operations WHERE id=$1',[jobId])).rows[0].status==='running')await new Promise(r=>setTimeout(r,25));
 const operation=(await pool.query('SELECT * FROM storage_operations WHERE id=$1',[jobId])).rows[0];if(operation.status!=='completed')throw new Error(operation.error);
 const matches=(await pool.query(`SELECT m.product_id,p.title,m.source_name,m.method,m.status,f.name AS archive,f.id AS file_id FROM storage_matches m JOIN products p ON p.id=m.product_id LEFT JOIN storage_files f ON f.id=m.file_id ORDER BY m.method,p.title`)).rows;
 const unselected=(await pool.query(`SELECT f.id,f.name,f.size_bytes::text FROM storage_files f WHERE f.storage_id=$1 AND NOT EXISTS(SELECT 1 FROM storage_matches m WHERE m.file_id=f.id) ORDER BY f.name COLLATE "C"`,[location])).rows;
 const after=(await pool.query('SELECT id,product_id,external_url FROM assets ORDER BY id')).rows;
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Asset identities or active links changed during rehearsal');
 const report={generatedAt:new Date().toISOString(),mode:'rehearsal on restored backup; no production mutations',schemaMigration:'006_storage_registry.sql',products:matches.length,archives:files.length,counts:operation.result.counts,unselected:unselected.length,unmatched:matches.filter(m=>m.method==='missing'||m.method==='ambiguous'),preservedAssetUUIDs:before.length,registryRecords:Number((await pool.query('SELECT count(*) FROM storage_files')).rows[0].count),matches,unselectedFiles:unselected};
 await writeFile(join(directory,'migration-preview.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,matches:undefined,unselectedFiles:undefined},null,2));
}finally{await jobs.close();await pool.end();}
