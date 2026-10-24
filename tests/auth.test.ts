import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../apps/api/src/app.js';

const config = { host: '127.0.0.1', port: 4180, dataMode: 'demo' as const, logLevel: 'silent' as const, staticDir: '/tmp/donarium-no-static', adminPassword: 'test-owner-password-long' };
test('owner password protects API, images and exports, expires on logout and rejects cross-site writes', async () => {
  const app = await buildApp({ config, logger: false });
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/auth/session')).json().authenticated, false);
    for (const path of ['/api/v1/products', '/api/v1/assets/00000000-0000-4000-8000-000000000000/content', '/api/v1/exports/catalog.json']) assert.equal((await app.inject(path)).statusCode, 401);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'wrong' } }); assert.equal(invalid.statusCode, 401);
    const cross = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://attacker.invalid' }, payload: { password: config.adminPassword } }); assert.equal(cross.statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: config.adminPassword } }); assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal((await app.inject({ url: '/api/v1/products', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/products', headers: { cookie }, payload: { title: 'demo cannot write' } })).statusCode, 403);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    assert.equal((await app.inject({ url: '/api/v1/products', headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); }
});
test('login attempts are limited without exposing credentials', async () => {
  const app = await buildApp({ config, logger: false });
  try {
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'wrong' } })).statusCode, 401);
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: config.adminPassword } });
    assert.equal(result.statusCode, 429); assert.ok(!result.body.includes(config.adminPassword));
  } finally { await app.close(); }
});
