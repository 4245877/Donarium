import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect, request } from '@playwright/test';

process.loadEnvFile('.env');
const directory = process.argv[2];
assert.ok(directory);
const plan = JSON.parse(await readFile(`${directory}/plan.json`, 'utf8'));
const rows = plan.products.filter(p => p.status === 'ready');
const baseURL = 'http://192.168.0.151:4180';
const api = await request.newContext({ baseURL });
const login = await api.post('/api/v1/auth/login', { data: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.status(), 200);
const result = { at: new Date().toISOString(), passed: false, apiProducts: 0, byteRangeDownloads: 0, editorProducts: [], screenshots: [], errors: [] };
let browser;
try {
  assert.equal((await (await api.get('/health')).json()).status, 'ok');
  const linked = [];
  for (const row of plan.products) {
    const response = await api.get(`/api/v1/products/${row.productId}`);
    assert.equal(response.status(), 200);
    const product = (await response.json()).item;
    assert.equal(product.title, row.title);
    if (row.status === 'ready') {
      assert.ok(product.figureFile);
      assert.equal(product.figureFile.relativePath, row.path);
      assert.equal(product.figureFile.storageKey, row.root);
      assert.equal(product.figureFile.fileId, row.fileId);
      linked.push({ row, product });
    } else assert.equal(product.figureFile, null, `Unapproved product was linked: ${row.title}`);
    result.apiProducts++;
  }
  // Every newly linked file is actually readable through its saved asset UUID.
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < linked.length) {
      const { product } = linked[next++];
      const response = await api.get(`/api/v1/assets/${product.figureFile.id}/download`, { headers: { Range: 'bytes=0-15' } });
      assert.equal(response.status(), 206);
      assert.equal((await response.body()).length, 16);
      result.byteRangeDownloads++;
    }
  }));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, storageState: await api.storageState() });
  const page = await context.newPage();
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) result.errors.push(`HTTP ${response.status()} ${response.url().split('?')[0]}`); });
  const selected = [
    rows.find(r => r.path.includes('Gengar_1')),
    rows.find(r => r.path.includes('Gengar_2')),
    rows.find(r => r.path.includes('Eren_Yeager')),
    rows.find(r => r.title.includes('Сагири')),
    rows.find(r => r.path.includes('nsfw')),
  ].filter(Boolean);
  for (const [index, row] of selected.entries()) {
    await page.goto(`/catalog/${row.productId}/edit`);
    const field = page.getByRole('group', { name: 'Файл фигурки', exact: true });
    await expect(field).toContainText(row.path);
    await expect(field.getByRole('status')).toContainText('Файл доступен');
    result.editorProducts.push({ id: row.productId, path: row.path });
    if (index === 0) {
      const path = `${directory}/editor-desktop.png`;
      await field.screenshot({ path }); result.screenshots.push(path);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(field.getByRole('status')).toContainText('Файл доступен');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const mobile = `${directory}/editor-mobile.png`;
      await field.screenshot({ path: mobile }); result.screenshots.push(mobile);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  const manual = plan.products.find(r => r.title === 'Зоро - Ван пис');
  assert.ok(manual && manual.status !== 'ready');
  await page.goto(`/catalog/${manual.productId}/edit`);
  await expect(page.getByRole('group', { name: 'Файл фигурки', exact: true }).getByRole('button', { name: 'Выбрать файл фигурки', exact: true })).toBeVisible();
  result.manualEditorUnlinked = true;
  assert.deepEqual(result.errors, []);
  result.passed = true;
  await context.close();
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close(); await api.dispose();
  await writeFile(`${directory}/http-browser-verification.json`, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
