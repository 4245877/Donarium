import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRoots, assertBackupDestination, assertNfsBackupRoots } from '../scripts/backup-storage.mjs';

test('NFS backup includes the live library and inventory even when container STORAGE_ROOTS is empty', () => {
  const env = { COMPOSE_FILE: 'compose.yml:compose.postgres.yml:compose.nfs.yml', MANAGED_STORAGE_ROOT: '/mnt/donarium/uploads', STORAGE_ROOTS: '[]' };
  assert.deepEqual(backupRoots(env), [
    { key: 'LIBRARY', path: '/mnt/donarium/library' }, { key: 'INVENTORY', path: '/mnt/donarium/inventory' }, { key: 'DONARIUM_UPLOADS', path: '/mnt/donarium/uploads' },
  ]);
  assert.throws(() => backupRoots({ ...env, BACKUP_STORAGE_ROOTS: '[]' }), /must include LIBRARY/);
});

test('full backup rejects a system disk destination before any archive is created', async () => {
  await assert.rejects(assertBackupDestination('/', []), /system filesystem/);
});

test('a local directory with a copied identity marker cannot replace an NFS backup source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'donarium-backup-guard-'));
  try {
    await writeFile(join(directory, '.donarium-volume'), 'donarium:76d90fb2-6d59-4fdb-8280-81154e6c93d9:library');
    await assert.rejects(assertNfsBackupRoots([{ key: 'LIBRARY', path: directory }]), /local fallback is forbidden/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
