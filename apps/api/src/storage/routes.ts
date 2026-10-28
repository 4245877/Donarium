import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { ZipFile } from 'yazl';
import type { Config } from '../config.js';
import type { CatalogRepository } from '../catalog/repository.js';
import { FolderImports, linkFile } from './imports.js';
import { fileMetadata, safeFileName, StorageError, StorageService } from './service.js';

import { registerRegistryRoutes } from './registry-routes.js';
import { disposition, sendPhysical } from './download.js';
const uuid = { type: 'string', format: 'uuid' };
const productParams = { type: 'object', required: ['id'], properties: { id: uuid } };
const rootPath = { root: { type: 'string', maxLength: 64 }, path: { type: 'string', maxLength: 4096, default: '' } };
interface DbAsset { id: string; name: string; kind: string; media_type: string; relative_path: string | null; key: string | null; external_url: string | null; size_bytes: string | null; sha256: string | null; status: string | null }
export async function registerStorageRoutes(app: FastifyInstance, pool: Pool, repository: CatalogRepository, config: Config) {
  const service = new StorageService(config);
  if (config.managedRoot && config.workRoot) await service.init();
  const registry = await registerRegistryRoutes(app, pool, service);
  const imports = new FolderImports(service, pool);
  app.addHook('onClose', async () => { await imports.close(); });
  const findAsset = async (id: string) => {
    const result = await pool.query<DbAsset>(`SELECT a.id,a.name,a.kind,a.media_type,coalesce(f.relative_path,a.relative_path) AS relative_path,a.external_url,s.key,f.size_bytes::text,f.sha256,f.status
      FROM assets a LEFT JOIN storage_files f ON f.id=a.file_id LEFT JOIN storage_locations s ON s.id=coalesce(f.storage_id,a.storage_id) WHERE a.id=$1 AND a.retired_at IS NULL`, [id]);
    const asset = result.rows[0];
    if (!asset) throw new StorageError('Ресурс не найден', 404);
    return asset;
  };
  const assertProduct = async (id: string) => {
    if (!(await pool.query('SELECT id FROM products WHERE id=$1', [id])).rowCount) throw new StorageError('Карточка не найдена', 404);
  };
  app.get('/api/v1/storage/roots', async () => ({ roots: service.listRoots(), inventoryAvailable: service.roots.some(root=>root.key==='INVENTORY') }));
  app.get<{ Querystring: { root: string; path: string; page: number; pageSize: number } }>('/api/v1/storage/browse', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['root'], properties: {
      ...rootPath, page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    } } },
  }, request => service.browse(request.query.root, request.query.path, request.query.page, request.query.pageSize));
  app.post<{ Params: { id: string }; Body: { root: string; paths: string[]; recursive?: boolean } }>('/api/v1/products/:id/assets/link', {
    bodyLimit: 2 * 1024 * 1024,
    schema: { params: productParams, body: { type: 'object', additionalProperties: false, required: ['root', 'paths'], properties: {
      root: rootPath.root, paths: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } }, recursive: { type: 'boolean', default: false },
    } } },
  }, async request => {
    await assertProduct(request.params.id);
    const paths = new Set<string>();
    let visited = 0;
    const collect = async (path: string, depth = 0): Promise<void> => {
      if (++visited > 10000 || depth > 30) throw new StorageError('Привязывайте не более 10000 файлов за одну операцию');
      try {
        const file = await service.open(request.body.root, path); await file.handle.close(); paths.add(path);
      } catch (error) {
        // Opening a directory as a regular file intentionally fails; a second safe open verifies it.
        if (!request.body.recursive) throw error;
        const directory = await service.open(request.body.root, path, true); await directory.handle.close();
        let page = 1;
        while (true) {
          const listing = await service.browse(request.body.root, path, page, 200);
          for (const entry of listing.entries) await collect(entry.path, depth + 1);
          if (page * listing.pageSize >= listing.total) break;
          page++;
        }
      }
    };
    for (const path of request.body.paths) await collect(path);
    const client = await pool.connect();
    let linked = 0;
    try {
      await client.query('BEGIN');
      for (const path of paths) if (await linkFile(client, service, request.params.id, request.body.root, path)) linked++;
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { linked, skipped: paths.size - linked };
  });
  await app.register(async uploadApp => {
    uploadApp.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    uploadApp.put<{ Params: { id: string }; Querystring: { name: string }; Body: Readable }>('/api/v1/products/:id/assets/upload', {
      bodyLimit: service.maxUploadBytes,
      schema: { params: productParams, querystring: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 250 } } } },
    }, async (request, reply) => {
      await assertProduct(request.params.id);
      safeFileName(request.query.name);
      const result = await registry.upload(request.body, request.query.name, request.params.id);
      return reply.code(201).send(result);
    });
  });
  app.delete<{ Params: { id: string; assetId: string } }>('/api/v1/products/:id/assets/:assetId', {
    schema: { params: { type: 'object', required: ['id', 'assetId'], properties: { id: uuid, assetId: uuid } } },
  }, async (request, reply) => {
    await registry.transaction(async client => {
      await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[request.params.id]);
      const result = await client.query('DELETE FROM assets WHERE id=$1 AND product_id=$2 RETURNING file_id', [request.params.assetId, request.params.id]);
      if (!result.rowCount) throw new StorageError('Ресурс не найден', 404);
      await client.query('UPDATE products SET updated_at=now() WHERE id=$1', [request.params.id]);
      await client.query(`INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'detach',$3)`, [result.rows[0].file_id,request.params.id,JSON.stringify({assetId:request.params.assetId})]);
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/v1/products/:id/assets/status', { schema: { params: productParams } }, async request => {
    const product = await repository.get(request.params.id);
    if (!product) throw new StorageError('Карточка не найдена', 404);
    const items = [];
    for (const asset of product.assets) {
      let status = 'unavailable';
      if (asset.externalUrl) status = 'external';
      else if (asset.storageKey && asset.relativePath) {
        try { const file = await service.open(asset.storageKey, asset.relativePath); const size=String(file.stat.size);await file.handle.close(); status = asset.fileStatus === 'corrupt' || asset.sizeBytes!==null&&asset.sizeBytes!==size ? 'corrupt' : 'available';
          if(status==='corrupt'&&asset.fileId)await pool.query("UPDATE storage_files SET status='corrupt',checked_at=now() WHERE id=$1",[asset.fileId]);
        }
        catch (error) { status = error instanceof StorageError && error.statusCode === 404 ? 'missing' : 'unavailable'; }
      }
      items.push({ id: asset.id, status });
    }
    return { items };
  });
  const sendAsset = async (id: string, request: FastifyRequest, reply: FastifyReply, inline = false) => {
    const asset = await findAsset(id);
    if (!asset.key || !asset.relative_path) throw new StorageError('Файл не подключён к локальному хранилищу', 404);
    if(asset.status==='corrupt') throw new StorageError('Файл повреждён; требуется проверка',409);
    return sendPhysical(service,asset.key,asset.relative_path,asset.name,request,reply,{inline:inline&&fileMetadata(asset.name).kind==='image',size:asset.size_bytes,sha256:asset.sha256});
  };
  for (const action of ['download', 'content']) {
    app.get<{ Params: { id: string } }>(`/api/v1/assets/:id/${action}`, { schema: { params: productParams } }, (request, reply) => sendAsset(request.params.id, request, reply, action === 'content'));
  }
  let thumbnails = 0;
  const thumbnailWaiters: Array<() => void> = [];
  const thumbnailCache = new Map<string, Buffer>();
  const acquireThumbnail = async () => {
    if (thumbnails < 2) { thumbnails++; return; }
    if (thumbnailWaiters.length >= 100) throw new StorageError('Слишком много запросов миниатюр; повторите позже', 429);
    await new Promise<void>(resolve => thumbnailWaiters.push(resolve));
  };
  const releaseThumbnail = () => {
    const next = thumbnailWaiters.shift();
    if (next) next(); else thumbnails--;
  };
  app.get<{ Params: { id: string } }>('/api/v1/assets/:id/thumbnail', { schema: { params: productParams } }, async (request, reply) => {
    const asset = await findAsset(request.params.id);
    if (asset.kind !== 'image' || !asset.key || !asset.relative_path) throw new StorageError('Изображение не найдено', 404);
    const checked = await service.open(asset.key, asset.relative_path);
    const cacheKey = `${asset.id}:${checked.stat.mtimeMs}:${checked.stat.size}`;
    await checked.handle.close();
    const cached = thumbnailCache.get(cacheKey);
    if (cached) return reply.type('image/webp').header('Cache-Control', 'private, max-age=3600').send(cached);
    await acquireThumbnail();
    try {
      const file = await service.readStream(asset.key, asset.relative_path);
      const image = sharp({ limitInputPixels: 80_000_000, animated: false }).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 });
      file.stream.on('error', error => image.destroy(error));
      file.stream.pipe(image);
      image.once('close', () => { file.stream.destroy(); });
      // Only the bounded 480px result is buffered. Originals are always streamed.
      const bytes = await image.toBuffer();
      if (thumbnailCache.size >= 256) thumbnailCache.delete(thumbnailCache.keys().next().value!);
      thumbnailCache.set(cacheKey, bytes);
      return reply.type('image/webp').header('Cache-Control', 'private, max-age=3600').send(bytes);
    } finally { releaseThumbnail(); }
  });
  let zipCount = 0;
  app.get<{ Params: { id: string } }>('/api/v1/products/:id/download.zip', { schema: { params: productParams } }, async (request, reply) => {
    const product = await repository.get(request.params.id);
    if (!product) throw new StorageError('Карточка не найдена', 404);
    if (!product.assets.length) throw new StorageError('В карточке нет файлов', 400);
    // Verify availability before sending headers; no silent partial archives.
    for (const asset of product.assets) {
      if(asset.fileStatus==='corrupt')throw new StorageError('Один из оригиналов повреждён; выполните проверку',409);
      if (!asset.storageKey || !asset.relativePath) throw new StorageError('Один из файлов не подключён к хранилищу', 409);
      const file = await service.open(asset.storageKey, asset.relativePath); const size=String(file.stat.size);await file.handle.close();
      if(asset.sizeBytes!==null&&asset.sizeBytes!==size)throw new StorageError('Размер оригинала изменился; выполните проверку',409);
    }
    if (zipCount >= 2) throw new StorageError('Уже скачиваются два архива; повторите позже', 429);
    zipCount++;
    const zip = new ZipFile();
    const activeStreams = new Set<Readable>();
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    for (const asset of product.assets) {
      zip.addReadStreamLazy(`${asset.id}/${safeFileName(asset.name)}`, { compress: false, forceZip64Format: true }, callback => {
        void service.readStream(asset.storageKey!, asset.relativePath!).then(file => {
          activeStreams.add(file.stream);
          file.stream.once('close', () => activeStreams.delete(file.stream));
          if ((zip.outputStream as Readable).destroyed) file.stream.destroy();
          callback(null, file.stream);
        }, error => callback(error, null as unknown as Readable));
      });
    }
    zip.end({ forceZip64Format: true, comment: '' });
    (zip.outputStream as Readable).once('close', () => { zipCount--; for (const stream of activeStreams) stream.destroy(); });
    reply.raw.on('close', () => (zip.outputStream as Readable).destroy());
    return reply.type('application/zip').header('Content-Disposition', disposition(`donarium-${product.id}.zip`)).send(zip.outputStream);
  });
  app.post<{ Body: { root: string; path: string } }>('/api/v1/imports/scan', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['root'], properties: rootPath } },
  }, async (request, reply) => reply.code(202).send({ jobId: await imports.scan(request.body.root, request.body.path ?? '') }));
  const jobParams = { type: 'object', required: ['id'], properties: { id: uuid } };
  app.get<{ Params: { id: string }; Querystring: { page: number; pageSize: number } }>('/api/v1/imports/jobs/:id', {
    schema: { params: jobParams, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  }, async request => {
    const job = imports.get(request.params.id);
    const { page, pageSize } = request.query;
    return { ...job, items: job.items.slice((page - 1) * pageSize, page * pageSize), total: job.items.length, page, pageSize, pages: Math.ceil(job.items.length / pageSize), errors: job.errors.slice(0, 100) };
  });
  app.post<{ Params: { id: string }; Body: { paths: string[]; categoryId?: string } }>('/api/v1/imports/jobs/:id/confirm', {
    bodyLimit: 8 * 1024 * 1024,
    schema: { params: jobParams, body: { type: 'object', additionalProperties: false, required: ['paths'], properties: {
      paths: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: { type: 'string', maxLength: 4096 } }, categoryId: uuid,
    } } },
  }, async (request, reply) => reply.code(202).send({ jobId: imports.confirm(request.params.id, request.body.paths, request.body.categoryId) }));
  app.delete<{ Params: { id: string } }>('/api/v1/imports/jobs/:id', { schema: { params: jobParams } }, async request => {
    imports.cancel(request.params.id); return { cancelled: true };
  });
  return service;
}
