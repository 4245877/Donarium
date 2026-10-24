import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

const scrypt = promisify(derive);
const cookieName = 'donarium_session';
const lifetime = 12 * 60 * 60 * 1000;

/** One owner password, expiring process-local sessions; no accounts or roles. */
export async function registerAuth(app: FastifyInstance, config: Config) {
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  const salt = randomBytes(32);
  const expected = config.adminPassword ? await scrypt(config.adminPassword, salt, 64) as Buffer : undefined;
  const tokenFrom = (cookie?: string) => cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const authenticated = (cookie?: string) => {
    if (!expected) return config.dataMode === 'demo';
    const token = tokenFrom(cookie);
    if (!token) return false;
    const expiry = sessions.get(token);
    if (!expiry || expiry <= Date.now()) { sessions.delete(token); return false; }
    return true;
  };
  const cookie = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secureCookie ? '; Secure' : ''}`;
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let allowed = false;
        try { allowed = new URL(origin).host === request.headers.host && ['http:', 'https:'].includes(new URL(origin).protocol); } catch { /* rejected below */ }
        if (!allowed) return reply.code(403).send({ error: { code: 'ORIGIN_REJECTED', message: 'Запрос с другого сайта запрещён', requestId: request.id } });
      }
      if (path !== '/api/v1/auth/login' && path !== '/api/v1/auth/logout' && (config.dataMode !== 'postgres' || !expected)) {
        return reply.code(403).send({ error: { code: 'READ_ONLY', message: 'Для изменения каталога настройте PostgreSQL и ADMIN_PASSWORD', requestId: request.id } });
      }
    }
    if (path === '/api/v1/auth/session' || path === '/api/v1/auth/login') return;
    if (!authenticated(request.headers.cookie)) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Введите пароль владельца', requestId: request.id } });
  });
  app.get('/api/v1/auth/session', async request => ({ authenticated: authenticated(request.headers.cookie), configured: !!expected, readOnly: config.dataMode !== 'postgres' || !expected }));
  app.post<{ Body: { password: string } }>('/api/v1/auth/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    if (!expected) return reply.code(403).send({ error: { code: 'NOT_CONFIGURED', message: 'Пароль владельца не настроен', requestId: request.id } });
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const entry = attempts.get(request.ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 10 || attempts.size > 1000) return reply.code(429).header('Retry-After', '900').send({ error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Повторите через 15 минут', requestId: request.id } });
    entry.count++;
    attempts.set(request.ip, entry);
    const supplied = await scrypt(request.body.password, salt, 64) as Buffer;
    if (!timingSafeEqual(expected, supplied)) return reply.code(401).send({ error: { code: 'INVALID_PASSWORD', message: 'Неверный пароль', requestId: request.id } });
    attempts.delete(request.ip);
    for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + lifetime);
    return reply.header('Set-Cookie', cookie(token, lifetime / 1000)).send({ authenticated: true });
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = tokenFrom(request.headers.cookie);
    if (token) sessions.delete(token);
    return reply.header('Set-Cookie', cookie('', 0)).send({ authenticated: false });
  });
}
