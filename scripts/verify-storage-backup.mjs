import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
const directory = resolve(process.argv[2] || 'backups/storage-registry-20261027');
const database = `donarium_test_backup_${Date.now()}`;
const container = 'donarium-audit-test-db-1';
async function run(args, input) {
  const child = spawn('docker', args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const exit = new Promise((ok, fail) => { child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(error))); });
  await Promise.all([exit, input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve()]);
}
async function hash(path) { const h = createHash('sha256'); for await (const part of createReadStream(path)) h.update(part); return h.digest('hex'); }
for (const line of (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const [expected, file] = line.split(/\s+/, 2);
  if (await hash(resolve(file)) !== expected) throw new Error('Backup checksum mismatch');
}
await run(['exec', container, 'createdb', '-U', 'donarium_test', database]);
await run(['exec', '-i', container, 'pg_restore', '-U', 'donarium_test', '-d', database, '--no-owner', '--no-acl', '--exit-on-error'], join(directory, 'database.dump'));
const extracted = join(directory, 'verified-uploads'); await mkdir(extracted, { mode: 0o700 });
const tar = spawn('tar', ['-xf', join(directory, 'uploads.tar'), '-C', extracted], { stdio: 'inherit' });
await new Promise((ok, fail) => tar.once('exit', code => code === 0 ? ok() : fail(new Error('tar extraction failed'))));
const pool = new pg.Pool({ connectionString: `postgresql://donarium_test@127.0.0.1:5549/${database}` });
try {
  const files = await pool.query('SELECT a.id,a.relative_path,a.size_bytes::text,a.sha256 FROM assets a JOIN storage_locations s ON s.id=a.storage_id WHERE s.key=\'DONARIUM_UPLOADS\'');
  let checked = 0;
  for (const f of files.rows) {
    if (!f.relative_path || f.relative_path.split('/').some(p => !p || p === '..' || p === '.') || f.relative_path.startsWith('/') || f.relative_path.includes('\\')) throw new Error('Unsafe backup path');
    const path = join(extracted, f.relative_path);
    const { stat } = await import('node:fs/promises');
    if (String((await stat(path)).size) !== f.size_bytes || !f.sha256 || await hash(path) !== f.sha256) throw new Error(`Invalid backed up asset ${f.id}`);
    checked++;
  }
  const counts = (await pool.query("SELECT (SELECT count(*) FROM products)::int AS products,(SELECT count(*) FROM assets)::int AS assets,(SELECT count(*) FROM categories)::int AS categories")).rows[0];
  const report = { database, container, counts, checked, checksumErrors: 0, restoredAt: new Date().toISOString(), method: 'online pg_dump + immutable attachments; every referenced restored file verified' };
  await writeFile(join(directory, 'restore-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { await pool.end(); }
