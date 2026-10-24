import type { FastifyInstance } from 'fastify';
import type { CatalogQuery, CatalogResponse, DataMode } from '@donarium/shared';
import type { CatalogRepository } from './repository.js';

export async function registerCatalogRoutes(app: FastifyInstance, repository: CatalogRepository, mode: DataMode) {
  app.get<{ Querystring: CatalogQuery }>('/api/v1/products', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 200, default: '' },
        category: { type: 'string', maxLength: 80, pattern: '^[a-z0-9-]*$', default: '' },
        page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
        sort: { type: 'string', enum: ['newest', 'title'], default: 'newest' },
      },
    } },
  }, async request => {
    request.query.q = request.query.q.trim();
    const [result, categories] = await Promise.all([repository.list(request.query), repository.categories()]);
    const response: CatalogResponse = { ...result, page: request.query.page, pageSize: request.query.pageSize, mode, categories };
    return response;
  });

  app.get<{ Params: { id: string } }>('/api/v1/products/:id', {
    schema: { params: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } },
    } },
  }, async (request, reply) => {
    const item = await repository.get(request.params.id);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Запись не найдена', requestId: request.id } });
    return { item, mode };
  });
}
