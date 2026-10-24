import type { FastifyInstance } from 'fastify';
import type { CatalogQuery, CatalogResponse, CategoryInput, DataMode, ProductInput } from '@donarium/shared';
import { CatalogInputError } from './postgres.js';
import type { CatalogRepository } from './repository.js';

const idParams = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};
const productBody = {
  type: 'object', additionalProperties: false, required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 },
    sku: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }] },
    description: { type: 'string', maxLength: 100000 },
    status: { type: 'string', enum: ['ready', 'processing'] },
    categoryIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
    tags: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 100 } },
    coverAssetId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
  },
};

function validateInput(input: ProductInput) {
  if (!input.title.trim() || input.tags?.some(tag => !tag.trim())) throw new CatalogInputError('Укажите название и непустые теги');
}

export async function registerCatalogRoutes(app: FastifyInstance, repository: CatalogRepository, mode: DataMode) {
  app.get<{ Querystring: CatalogQuery }>('/api/v1/products', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 200, default: '' },
        category: { type: 'string', maxLength: 80, pattern: '^[a-z0-9-]*$', default: '' },
        tag: { type: 'string', maxLength: 100, default: '' },
        status: { type: 'string', enum: ['', 'ready', 'processing'], default: '' },
        page: { type: 'integer', minimum: 1, maximum: 10000000, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
        sort: { type: 'string', enum: ['newest', 'updated', 'title'], default: 'newest' },
      },
    } },
  }, async request => {
    request.query.q = request.query.q.trim();
    request.query.tag = request.query.tag?.trim();
    const [result, categories] = await Promise.all([repository.list(request.query), repository.categories()]);
    const response: CatalogResponse = { ...result, page: request.query.page, pageSize: request.query.pageSize, mode, categories };
    return response;
  });

  app.get<{ Params: { id: string } }>('/api/v1/products/:id', {
    schema: { params: idParams },
  }, async (request, reply) => {
    const item = await repository.get(request.params.id);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Запись не найдена', requestId: request.id } });
    return { item, mode };
  });

  app.get('/api/v1/categories', async () => ({ items: await repository.categories() }));

  // Demonstration fixtures remain explicitly read-only and are never a write fallback.
  if (mode !== 'postgres') return;
  app.post<{ Body: ProductInput }>('/api/v1/products', {
    schema: { body: productBody }, bodyLimit: 256 * 1024,
  }, async (request, reply) => {
    validateInput(request.body);
    const item = await repository.create!(request.body);
    return reply.code(201).send({ item, mode });
  });
  app.put<{ Params: { id: string }; Body: ProductInput }>('/api/v1/products/:id', {
    schema: { params: idParams, body: productBody }, bodyLimit: 256 * 1024,
  }, async (request, reply) => {
    validateInput(request.body);
    const item = await repository.update!(request.params.id, request.body);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Запись не найдена', requestId: request.id } });
    return { item, mode };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/products/:id', {
    schema: { params: idParams },
  }, async (request, reply) => {
    if (!await repository.delete!(request.params.id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Запись не найдена', requestId: request.id } });
    return reply.code(204).send();
  });
  app.post<{ Body: CategoryInput }>('/api/v1/categories', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        slug: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      },
    } },
  }, async (request, reply) => {
    if (!request.body.name.trim()) throw new CatalogInputError('Укажите название категории');
    return reply.code(201).send({ item: await repository.createCategory!(request.body) });
  });
}
