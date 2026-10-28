import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { TransferService } from './service.js';

export async function registerTransferRoutes(app: FastifyInstance, pool: Pool, config: Config) {
  const service = new TransferService(pool, config);
  if (config.managedRoot && config.workRoot) await service.init();
  app.addHook('onClose', async () => service.close());
  const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  app.get('/api/v1/exports/catalog.json', async (_request, reply) => reply.type('application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="donarium-catalog.json"').send(Readable.from(service.json())));
  app.get('/api/v1/exports/catalog.csv', async (_request, reply) => reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="donarium-catalog.csv"').send(Readable.from(service.csvRows())));
  app.post('/api/v1/exports/metadata', async (_request, reply) => { if (!config.managedRoot || !config.workRoot) await service.init(); return reply.code(202).send(await service.startExport('metadata')); });
  app.post('/api/v1/exports/archive', async (_request, reply) => { if (!config.managedRoot || !config.workRoot) await service.init(); return reply.code(202).send(await service.startExport()); });
  app.get<{ Params: { id: string } }>('/api/v1/transfers/:id', { schema: { params } }, async request => service.get(request.params.id));
  app.get<{ Params: { id: string } }>('/api/v1/transfers/:id/download', { schema: { params } }, async (request, reply) => reply.type('application/zip').header('Content-Disposition', 'attachment; filename="donarium-library.zip"').send(createReadStream(service.download(request.params.id))));
  app.get<{ Params: { id: string } }>('/api/v1/transfers/:id/preview', { schema: { params } }, async request => service.preview(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/v1/transfers/:id', { schema: { params } }, async request => service.cancel(request.params.id));
  app.post<{ Params: { id: string }; Body: { conflict: 'skip' | 'copy' } }>('/api/v1/restores/:id/confirm', {
    schema: { params, body: { type: 'object', additionalProperties: false, required: ['conflict'], properties: { conflict: { type: 'string', enum: ['skip', 'copy'] } } } },
  }, async (request, reply) => reply.code(202).send(await service.confirm(request.params.id, request.body.conflict)));
  await app.register(async uploads => {
    uploads.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    uploads.put<{ Body: Readable }>('/api/v1/restores/preview', { bodyLimit: service.transferLimit }, async (request, reply) => { if (!config.managedRoot || !config.workRoot) await service.init(); return reply.code(202).send(await service.upload(request.body)); });
  });
  return service;
}
