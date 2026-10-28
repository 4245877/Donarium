import { basename, extname } from 'node:path';
import type { PoolClient } from 'pg';
import { isFigureFileName, type FileReference } from '@donarium/shared';
import { attachFile, registerFile } from './registry.js';
import { StorageError, type StorageService } from './service.js';

export async function figureFileInfo(service: StorageService, reference: FileReference) {
  if (service.root(reference.root).internal) throw new StorageError('Хранилище не разрешено', 403);
  if (!isFigureFileName(reference.path)) throw new StorageError('Выберите 3D-модель, исходник или архив моделей');
  const file = await service.open(reference.root, reference.path);
  try {
    return { ...reference, name: basename(reference.path), sizeBytes: String(file.stat.size), format: extname(reference.path).slice(1).toLowerCase(), modifiedAt: file.stat.mtime.toISOString() };
  } finally { await file.handle.close(); }
}

/** Runs inside the product transaction. Neither replacement nor detach writes to the filesystem. */
export async function saveFigureFile(client: Pick<PoolClient, 'query'>, service: StorageService | undefined, productId: string, reference: FileReference | null) {
  const previous = (await client.query<{ id: string; file_id: string; metadata: Record<string, unknown> }>(
    "SELECT id,file_id,metadata FROM assets WHERE product_id=$1 AND metadata->>'role'='figure' AND retired_at IS NULL", [productId])).rows[0];
  let next: { id: string; inserted: boolean } | undefined;
  if (reference) {
    if (!service) throw new StorageError('Файловое хранилище не настроено', 503);
    await figureFileInfo(service, reference);
    const file = await registerFile(client, service, reference.root, reference.path);
    next = await attachFile(client, service, productId, file.id);
  }
  if (previous && previous.id !== next?.id) {
    // Selecting an existing attachment only borrows its figure role. Clearing that
    // role must retain the attachment, its UUID and all unrelated metadata.
    if (previous.metadata.figure_reused_attachment === true) {
      await client.query("UPDATE assets SET metadata=metadata - 'role' - 'figure_reused_attachment' WHERE id=$1", [previous.id]);
    } else await client.query('DELETE FROM assets WHERE id=$1', [previous.id]);
    await client.query("INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'figure-detach',$3)", [previous.file_id, productId, { assetId: previous.id }]);
  }
  if (next) await client.query("UPDATE assets SET retired_at=NULL,metadata=metadata || $2::jsonb || '{\"role\":\"figure\"}'::jsonb WHERE id=$1", [next.id,
    !next.inserted && next.id !== previous?.id ? { figure_reused_attachment: true } : {}]);
}
