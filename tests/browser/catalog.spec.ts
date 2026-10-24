import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  if (process.env.E2E_PASSWORD) {
    const login = await page.request.post('/api/v1/auth/login', { data: { password: process.env.E2E_PASSWORD } });
    expect(login.ok()).toBe(true);
  }
});

test('catalog search, filters and persistent URL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: /^Каталог моделей/ })).toBeVisible();
  await expect(page.getByText('API подключён', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск моделей' }).fill('нет-такой-модели-000');
  await expect(page.getByRole('heading', { name: 'Модели не найдены' })).toBeVisible();
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Поиск моделей' })).toHaveValue('нет-такой-модели-000');
  await page.getByRole('button', { name: 'Показать все модели' }).click();
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole('combobox', { name: 'Сортировка' }).selectOption('updated');
  await expect(page).toHaveURL(/sort=updated/);
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('processing');
  await expect(page).toHaveURL(/status=processing/);
  await expect(page.getByRole('link', { name: 'Коллекции', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile navigation and server state are accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: /^Каталог моделей/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await page.getByRole('link', { name: 'Настройки и состояние', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Настройки и состояние', exact: true })).toBeVisible();
  await expect(page.getByText('Подключён', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('backend failure and retry', async ({ page }) => {
  await page.route('**/api/v1/products?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Тестовая недоступность API', requestId: 'qa' } }) }));
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: 'Не удалось получить данные' })).toBeVisible();
  await page.unroute('**/api/v1/products?*');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Не удалось получить данные' })).toHaveCount(0);
});
