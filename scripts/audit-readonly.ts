/** Independent production inspection. Every SQL statement runs in a read-only snapshot. */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL!);
url.hostname = '127.0.0.1'; url.port = '5548';
if (url.pathname !== '/donarium') throw new Error('Expected dedicated production database');
const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
const tables = ['products','categories','tags','product_categories','product_tags','assets','external_links','storage_locations','storage_files','import_sources','storage_matches','storage_events','storage_operations','storage_uploads'];
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), mode: 'REPEATABLE READ READ ONLY' };
const client = await pool.connect();
let physicalRows: Record<string,any>[] = [];
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  const fingerprints: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS data FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    const hash = createHash('sha256'); for (const row of rows) hash.update(row.data + '\n');
    fingerprints[table] = { count: rows.length, sha256: hash.digest('hex') };
  }
  report.tables = fingerprints;
  const checks: Record<string, string> = {
    fileStatuses: 'SELECT status,count(*)::int FROM storage_files GROUP BY status ORDER BY status',
    matchStatuses: 'SELECT status,count(*)::int FROM storage_matches GROUP BY status ORDER BY status',
    matchMethods: 'SELECT method,count(*)::int FROM storage_matches GROUP BY method ORDER BY method',
    locations: 'SELECT s.key,count(f.id)::int AS files,sum(f.size_bytes)::text AS bytes FROM storage_locations s LEFT JOIN storage_files f ON f.storage_id=s.id GROUP BY s.key ORDER BY s.key',
    assetMismatch: `SELECT count(*)::int AS count FROM assets a JOIN storage_files f ON f.id=a.file_id WHERE a.storage_id IS DISTINCT FROM f.storage_id OR a.relative_path IS DISTINCT FROM f.relative_path`,
    missingRegistry: 'SELECT count(*)::int AS count FROM assets WHERE storage_id IS NOT NULL AND file_id IS NULL',
    duplicateAssets: 'SELECT count(*)::int AS count FROM (SELECT product_id,file_id FROM assets WHERE file_id IS NOT NULL GROUP BY product_id,file_id HAVING count(*)>1) x',
    invalidCovers: `SELECT count(*)::int AS count FROM products p LEFT JOIN assets a ON a.id=p.cover_asset_id WHERE p.cover_asset_id IS NOT NULL AND (a.id IS NULL OR a.product_id<>p.id OR a.kind<>'image' OR a.retired_at IS NOT NULL)`,
    invalidConstraints: 'SELECT conname,convalidated FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND NOT convalidated',
    invalidIndexes: 'SELECT indexrelid::regclass::text FROM pg_index WHERE NOT indisvalid AND indrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)',
    migrations: 'SELECT name,sha256 FROM schema_migrations ORDER BY name',
    foreignKeys: "SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' AND connamespace=current_schema()::regnamespace ORDER BY 1,2",
    indexes: 'SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname',
    historicalSources: 'SELECT system,count(*)::int AS count,count(DISTINCT product_id)::int AS products FROM external_links GROUP BY system ORDER BY system',
  };
  for (const [key, query] of Object.entries(checks)) report[key] = (await client.query(query)).rows;
  if(process.argv.includes('--files')) physicalRows=(await client.query('SELECT f.id,f.relative_path,f.size_bytes::text,f.sha256,s.key FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id ORDER BY f.id')).rows;
  for (const [name, sql] of Object.entries({
    catalogTitle: 'SELECT id,title FROM products ORDER BY lower(title),id LIMIT 24',
    catalogSearch: "SELECT id FROM products WHERE search_vector @@ plainto_tsquery('simple','dragon') OR search_text LIKE '%dragon%' LIMIT 24",
    files: 'SELECT id,name FROM storage_files ORDER BY lower(name),relative_path COLLATE "C",id LIMIT 50',
    candidates: `SELECT m.id,(SELECT jsonb_agg(c.id) FROM storage_files c WHERE m.candidates @> to_jsonb(ARRAY[c.id::text])) FROM storage_matches m ORDER BY m.id LIMIT 50`,
    candidatesIndexed: `SELECT m.id,(SELECT jsonb_agg(c.id) FROM jsonb_array_elements_text(m.candidates) AS candidate(id) JOIN storage_files c ON c.id=candidate.id::uuid) FROM storage_matches m ORDER BY m.id LIMIT 50`,
  })) report[`plan_${name}`] = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'];
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
if(physicalRows.length) {
  const journal=new Map<string,any>();
  for(const line of (await readFile('/mnt/donarium/inventory/library-sha256.ndjson','utf8')).trim().split('\n')) {const row=JSON.parse(line);journal.set(row.name,row);}
  let hashedUploads=0,checkedLibrary=0,bytes=0n;const failures:unknown[]=[];
  for(const row of physicalRows) {
    if(!['LIBRARY','DONARIUM_UPLOADS'].includes(row.key)||row.relative_path.startsWith('/')||row.relative_path.split('/').some((p:string)=>!p||p==='.'||p==='..')||row.relative_path.includes('\\'))throw new Error('Unexpected storage reference');
    const path=`/mnt/donarium/${row.key==='LIBRARY'?'library':'uploads'}/${row.relative_path}`;
    try {
      const info=await stat(path,{bigint:true});if(info.size!==BigInt(row.size_bytes))throw new Error('size');
      if(row.key==='DONARIUM_UPLOADS') {
        const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
        if(hash.digest('hex')!==row.sha256)throw new Error('SHA-256');hashedUploads++;bytes+=info.size;
      } else {
        const original=journal.get(row.relative_path);
        if(!original||original.sha256!==row.sha256||BigInt(original.size)!==info.size||BigInt(original.mtime_ns)!==info.mtimeNs||BigInt(original.ctime_ns)!==info.ctimeNs)throw new Error('journal/fingerprint');
        checkedLibrary++;
      }
    } catch(error) {failures.push({id:row.id,reason:error instanceof Error?error.message:'unavailable'});}
  }
  report.physical={hashedUploads,hashedBytes:String(bytes),checkedLibrary,libraryMethod:'size, mtime_ns, ctime_ns and saved SHA-256 inventory; library content not rehashed',failures};
}
const target = resolve(process.argv[2] || 'var/qa/independent-audit-20261028/production-before.json');
await mkdir(resolve(target,'..'), { recursive: true });
await writeFile(target, JSON.stringify(report,null,2)+'\n', { mode: 0o600 });
console.log(JSON.stringify({ report: target, tables: report.tables, matches: report.matchStatuses, locations: report.locations }));
