import { constants } from 'node:fs';
import { open, stat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';

const execute = promisify(execFile);
export const usesNfs = env => (env.COMPOSE_FILE || '').split(':').some(file => /(^|\/)compose\.nfs\.yml$/.test(file));

export function backupRoots(env) {
  const nfs = usesNfs(env);
  const uploads = env.MANAGED_STORAGE_ROOT || 'var/uploads';
  const configured = env.BACKUP_STORAGE_ROOTS || (nfs ? null : env.STORAGE_ROOTS);
  const roots = configured ? JSON.parse(configured) : nfs
    ? [{ key: 'LIBRARY', path: join(dirname(resolve(uploads)), 'library') }, { key: 'INVENTORY', path: join(dirname(resolve(uploads)), 'inventory') }]
    : env.STORAGE_ROOT ? [{ key: 'LIBRARY', path: env.STORAGE_ROOT }] : [];
  if (!Array.isArray(roots)) throw new Error('BACKUP_STORAGE_ROOTS must be a JSON array');
  if (nfs && !['LIBRARY', 'INVENTORY'].every(key => roots.some(root => root?.key === key))) {
    throw new Error('NFS backup must include LIBRARY and INVENTORY host paths');
  }
  return [...roots, { key: 'DONARIUM_UPLOADS', path: uploads }];
}

async function mount(path) {
  const { stdout } = await execute('findmnt', ['--json', '--target', path, '--output', 'SOURCE,FSTYPE']);
  const result = JSON.parse(stdout).filesystems?.[0];
  if (!result) throw new Error('Cannot identify backup filesystem');
  return result;
}

export async function assertNfsBackupRoots(roots) {
  for (const [key, name] of [['LIBRARY', 'library'], ['DONARIUM_UPLOADS', 'uploads'], ['INVENTORY', 'inventory']]) {
    const root = roots.find(root => root.key === key);
    const mounted = await mount(root.path);
    if (!['nfs', 'nfs4'].includes(mounted.fstype) || mounted.source !== `192.168.0.141:/${name}`) {
      throw new Error(`Required NFS backup root ${key} is unavailable; local fallback is forbidden`);
    }
    const marker = await open(join(root.path, '.donarium-volume'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await marker.stat();
      if (!info.isFile() || info.size > 512 || (await marker.readFile('utf8')).trim() !== `donarium:76d90fb2-6d59-4fdb-8280-81154e6c93d9:${name}`) {
        throw new Error(`Incorrect NFS identity for ${key}`);
      }
    } finally { await marker.close(); }
  }
}

export async function assertBackupDestination(parent, roots) {
  const destination = await stat(parent);
  if (destination.dev === (await stat('/')).dev) throw new Error('Full file backup on the system filesystem is forbidden; select an independent mounted disk/server');
  for (const root of roots) {
    if (destination.dev === (await stat(root.path)).dev) throw new Error('Backup destination shares a source filesystem');
  }
  const target = await mount(await realpath(parent));
  if (['tmpfs', 'ramfs', 'overlay'].includes(target.fstype)) throw new Error('Backup destination must be persistent storage');
  // Different NFS exports can have different device IDs while sharing one disk.
  if (['nfs', 'nfs4'].includes(target.fstype)) {
    for (const root of roots) {
      const source = await mount(root.path);
      if (['nfs', 'nfs4'].includes(source.fstype) && target.source.split(':')[0] === source.source.split(':')[0]) {
        throw new Error('Use a different backup server/disk; NFS exports on the source server are not independent');
      }
    }
  }
}
