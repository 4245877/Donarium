import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

if (existsSync('.env')) process.loadEnvFile('.env');
function execute(command, args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } });
    child.once('error', () => fail(new Error(`${command} is unavailable; install the PostgreSQL client and tar`)));
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${command} failed; backup is incomplete`)));
  });
}
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function containerDump(container, database, username, destination) {
  const labels = await new Promise((done, fail) => {
    const child = spawn('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}', container], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.once('error', () => fail(new Error('Docker is unavailable')));
    child.once('exit', code => code === 0 ? done(text.trim()) : fail(new Error('Cannot inspect the DONARIUM database container')));
  });
  if (!/^donarium(?:-audit-test)? db$/.test(labels)) throw new Error('BACKUP_DB_CONTAINER must be the db service of donarium or donarium-audit-test');
  const child = spawn('docker', ['exec', container, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '--username', username, '--dbname', database], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exit = new Promise((done, fail) => {
    child.once('error', () => fail(new Error('Cannot start container pg_dump')));
    child.once('exit', code => code === 0 ? done() : fail(new Error('Container pg_dump failed; backup is incomplete')));
  });
  await Promise.all([pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 })), exit]);
}

try {
  if (process.env.BACKUP_CONFIRM !== 'donarium' || process.env.BACKUP_QUIESCED !== 'donarium') {
    throw new Error('Stop DONARIUM writes, then set BACKUP_CONFIRM=donarium and BACKUP_QUIESCED=donarium.');
  }
  const url = new URL(process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL || '');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^donarium(?:_[a-z0-9]+)*$/.test(database)) {
    throw new Error('Backup requires a dedicated database named donarium or donarium_<suffix>.');
  }
  const requested = resolve(process.argv[2] || `donarium-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  // Resolve the existing parent so a symlink cannot put a backup inside its source tree.
  const destination = resolve(await realpath(dirname(requested)), basename(requested));
  const backupRoots = process.env.BACKUP_STORAGE_ROOTS || process.env.STORAGE_ROOTS;
  let configured = backupRoots ? JSON.parse(backupRoots) : process.env.STORAGE_ROOT ? [{ key: 'LIBRARY', path: process.env.STORAGE_ROOT }] : [];
  if (!Array.isArray(configured)) throw new Error('STORAGE_ROOTS must be a JSON array');
  configured = [...configured, { key: 'DONARIUM_UPLOADS', path: process.env.MANAGED_STORAGE_ROOT || 'var/uploads' }];
  const keys = new Set();
  const roots = [];
  for (const entry of configured) {
    if (!entry || typeof entry.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.key) || keys.has(entry.key) || typeof entry.path !== 'string') throw new Error('Invalid or duplicate storage root');
    keys.add(entry.key);
    const path = await realpath(resolve(entry.path));
    const child = relative(path, destination);
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) throw new Error('Backup destination must be outside every storage root');
    roots.push({ key: entry.key, path });
  }
  await mkdir(destination, { mode: 0o700 }); // Never overwrite an existing backup.
  const files = [];
  const databaseFile = resolve(destination, 'database.dump');
  if (process.env.BACKUP_DB_CONTAINER) {
    await containerDump(process.env.BACKUP_DB_CONTAINER, database, decodeURIComponent(url.username), databaseFile);
  } else {
    await execute('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', databaseFile], {
      PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: database,
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10',
    });
  }
  await chmod(databaseFile, 0o600);
  files.push({ file: 'database.dump', sha256: await checksum(databaseFile) });
  const storage = [];
  for (const root of roots) {
    const file = `storage-${root.key}.tar`;
    const path = resolve(destination, file);
    // tar preserves relative names and symlinks without following links or changing originals.
    await execute('tar', ['--create', '--file', path, '--directory', root.path, '--', '.']);
    await chmod(path, 0o600);
    files.push({ file, sha256: await checksum(path) });
    storage.push({ key: root.key, originalPath: root.path, archive: file });
  }
  await writeFile(resolve(destination, 'backup.json'), `${JSON.stringify({ format: 'donarium-backup', version: 1, createdAt: new Date().toISOString(), database, storage, files }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Backup complete: ${destination}`);
} catch (error) {
  // Never echo PostgreSQL credentials or a child process's raw errors.
  console.error(error instanceof Error && !error.message.includes('Invalid URL') ? error.message : 'Invalid backup configuration');
  process.exitCode = 1;
}
