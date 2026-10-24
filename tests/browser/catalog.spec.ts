import { test, expect } from '@playwright/test';

test('home, API catalog, search and real product card', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Обзор библиотеки' })).toBeVisible();
  await expect(page.getByText('API подключён', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Открыть каталог', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(6);
  await expect(page.getByText('Демонстрационная библиотека', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск моделей' }).fill('ваза');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.product-card')).toContainText('Спиральная ваза');
  await expect(page).toHaveURL(/q=/);
  await page.locator('.product-card').click();
  await expect(page.getByRole('heading', { name: 'Спиральная ваза', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^spiral-vase\.stl/ })).toBeVisible();
  await expect(page.getByText(/Демо-файлы не размещены/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Спиральная ваза', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('filter, sort, SKU, empty results and reset', async ({ page }) => {
  await page.goto('/catalog');
  await expect(page.locator('.product-card')).toHaveCount(6);
  await page.getByRole('button', { name: 'Декор', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Сортировка' }).selectOption('title');
  await expect(page).toHaveURL(/sort=title/);
  await page.getByRole('searchbox').fill('DN-001');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.getByRole('searchbox').fill('нет-такой-модели-000');
  await expect(page.getByRole('heading', { name: 'Модели не найдены' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать все модели' }).click();
  await expect(page.locator('.product-card')).toHaveCount(6);
  await page.screenshot({ path: 'var/qa/catalog-desktop.png', fullPage: true });
  await page.goto('/catalog?page=99');
  await expect(page.getByRole('heading', { name: 'Модели не найдены' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать все модели' }).click();
  await expect(page.locator('.product-card')).toHaveCount(6);
});

test('mobile layout and system status remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalog');
  await expect(page.locator('.product-card')).toHaveCount(6);
  await expect.poll(() => page.locator('.product-card img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'var/qa/catalog-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await page.getByRole('link', { name: 'О системе', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'О системе', exact: true })).toBeVisible();
  await expect(page.getByText('Подключён', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('backend failure is visible and retry reconnects the catalog', async ({ page }) => {
  await page.route('**/api/v1/products?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Тестовая недоступность API', requestId: 'qa' } }) }));
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: 'Не удалось получить данные' })).toBeVisible();
  await page.unroute('**/api/v1/products?*');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(6);
});
