import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { APP_VERSION, type HealthResponse, type SystemResponse } from '@donarium/shared';
import { loadConfig, type Config } from './config.js';
import { createPool } from './db.js';
import { DemoRepository } from './catalog/demo.js';
import { PostgresRepository } from './catalog/postgres.js';
import type { CatalogRepository } from './catalog/repository.js';
import { registerAuth } from './auth.js';
import { registerStorageRoutes } from './storage/routes.js';
import { registerTransferRoutes } from './transfer/routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';

export interface AppOptions {
  config?: Config;
  repository?: CatalogRepository;
  pool?: Pool;
  logger?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      // Query strings may later carry private search terms or external URLs.
      serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0], hostname: request.hostname, remoteAddress: request.ip }) },
    },
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: false,
  });
  let pool = options.pool;
  if (config.dataMode === 'postgres' && !pool) pool = createPool(config.databaseUrl!);
  const repository = options.repository ?? (config.dataMode === 'postgres' ? new PostgresRepository(pool!) : new DemoRepository());
  if (pool && !options.pool) {
    pool.on('error', () => app.log.error('Database pool connection error'));
    app.addHook('onClose', async () => { await pool!.end(); });
  }

  await registerAuth(app, config);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте параметры запроса', requestId: request.id } });
    }
    if ('code' in error && error.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Такая запись или SKU уже существует', requestId: request.id } });
    if ('code' in error && ['23503', '23514', '22P02'].includes(error.code ?? '')) return reply.code(400).send({ error: { code: 'INVALID_REFERENCE', message: 'Проверьте поля и связанные записи', requestId: request.id } });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: 'BAD_REQUEST', message: error.name === 'StorageError' || error.constructor.name === 'StorageError' || error.constructor.name === 'CatalogInputError' || error.constructor.name === 'TransferError' ? error.message : 'Некорректный запрос', requestId: request.id } });
    }
    // Do not serialize DB errors, URLs, credentials or filesystem paths to logs/responses.
    request.log.error({ requestId: request.id }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить запрос', requestId: request.id } });
  });

  app.get('/health', async (_request, reply) => {
    let database: HealthResponse['database'] = 'not-configured';
    if (config.dataMode === 'postgres') {
      try { await pool!.query('SELECT 1'); database = 'connected'; }
      catch { database = 'unavailable'; }
    }
    const status = database === 'unavailable' ? 'degraded' : 'ok';
    const response: HealthResponse = { status, version: APP_VERSION, mode: config.dataMode, database, uptime: Math.floor(process.uptime()) };
    return reply.code(status === 'ok' ? 200 : 503).header('Cache-Control', 'no-store').send(response);
  });
  app.get('/api/v1/system', async () => {
    const response: SystemResponse = {
      name: 'DONARIUM', version: APP_VERSION, mode: config.dataMode, readOnly: config.dataMode !== 'postgres' || !config.adminPassword,
      storage: config.dataMode === 'demo' ? 'demo-metadata' : (config.managedRoot || config.storageRoots?.length || config.storageRoot) ? 'local-configured' : 'not-configured',
      features: { catalog: true, search: true, uploads: config.dataMode === 'postgres', import: config.dataMode === 'postgres', export: config.dataMode === 'postgres' },
    };
    return response;
  });
  await registerCatalogRoutes(app, repository, config.dataMode);

  if (pool && config.dataMode === 'postgres') {
    await registerStorageRoutes(app, pool, repository, config);
    await registerTransferRoutes(app, pool, config);
  }

  const hasFrontend = existsSync(join(config.staticDir, 'index.html'));
  if (hasFrontend) {
    await app.register(fastifyStatic, {
      root: config.staticDir,
      prefix: '/',
      wildcard: false,
      dotfiles: 'deny',
      index: false,
      setHeaders(reply, path) {
        reply.header('Cache-Control', /[/\\]assets[/\\]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    const sendApp = async (_request: FastifyRequest, reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    app.get('/', sendApp);
    app.get('/catalog', sendApp);
    app.get('/system', sendApp);
    app.get('/import', sendApp);
    app.get('/transfer', sendApp);
    app.get('/catalog/new', sendApp);
    app.get('/settings', sendApp);
    app.get('/catalog/:id/edit', sendApp);
    app.get<{ Params: { id: string } }>('/catalog/:id', {
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    }, async (_request, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));
  }
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Ресурс не найден', requestId: request.id } }));
  return app;
}
