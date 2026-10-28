import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  test.skip(process.env.E2E_WRITE !== 'donarium_test' || !process.env.E2E_PASSWORD, 'Requires isolated QA installation');
  expect((await page.request.post('/api/v1/auth/login', { data: { password: process.env.E2E_PASSWORD } })).ok()).toBe(true);
});

test('figure field browses folders, searches, previews STL, saves, cancels, replaces and detaches on mobile', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/catalog/new');
  await page.getByRole('textbox', { name: 'Название', exact: true }).fill(`Figure ${Date.now()}`);
  const field = page.getByRole('group', { name: 'Файл фигурки', exact: true });
  await field.getByRole('button', { name: 'Выбрать файл фигурки', exact: true }).click();
  await page.getByRole('combobox', { name: 'Хранилище моделей' }).selectOption('FIGURE_FIXTURES');
  await page.getByRole('button', { name: 'Example Model', exact: true }).click();
  await expect(page.getByRole('button', { name: 'part.stl', exact: true })).toHaveCount(0);
  await expect(page.getByText('part.stl', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'На уровень выше', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Поиск моделей в этой папке и вложенных папках' }).fill('дРАКОН');
  const row = page.locator('.figure-picker .browser-entry').filter({ hasText: 'Дракон 100%.STL' });
  await row.getByRole('button', { name: 'Просмотреть Дракон 100%.STL', exact: true }).click();
  await expect(page.getByRole('img', { name: '3D-предпросмотр STL' })).toBeVisible();
  await page.getByRole('img', { name: '3D-предпросмотр STL' }).press('ArrowRight');
  await expect(page).toHaveURL(/\/catalog\/new$/);
  await row.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(field.getByRole('status')).toContainText('Файл доступен');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(field).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await field.screenshot({ path: 'test-results/figure-field-mobile.png' });
  await page.getByRole('button', { name: 'Сохранить карточку', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/[0-9a-f-]+$/);
  const id = new URL(page.url()).pathname.split('/').pop()!, url = `/api/v1/products/${id}`;
  const read = async () => (await (await page.request.get(url)).json()).item;
  const original = (await read()).figureFile;
  expect(original.relativePath).toBe('Example Model/Вложенная папка/Дракон 100%.STL');
  try {
    const chooseReplacement = async () => {
      await page.getByRole('button', { name: 'Заменить файл фигурки', exact: true }).click();
      await page.getByRole('navigation', { name: 'Путь к моделям' }).getByRole('button', { name: 'FIGURE_FIXTURES', exact: true }).click();
      await page.locator('.figure-picker .browser-entry').filter({ hasText: 'replacement.zip' }).getByRole('button', { name: 'Выбрать', exact: true }).click();
    };
    await page.getByRole('link', { name: 'Редактировать', exact: true }).click(); await chooseReplacement();
    await page.getByRole('link', { name: 'Отмена', exact: true }).click(); expect((await read()).figureFile.id).toBe(original.id);
    await page.getByRole('link', { name: 'Редактировать', exact: true }).click(); await chooseReplacement();
    await field.getByRole('button', { name: 'Просмотреть файл фигурки', exact: true }).click();
    await expect(page.getByText('Это архив моделей.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Сохранить карточку', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/catalog/${id}$`));
    expect((await read()).figureFile.name).toBe('replacement.zip');
    await page.getByRole('link', { name: 'Редактировать', exact: true }).click();
    await page.getByRole('button', { name: 'Удалить привязку', exact: true }).click();
    expect((await read()).figureFile.name).toBe('replacement.zip');
    await page.getByRole('button', { name: 'Сохранить карточку', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/catalog/${id}$`));
    expect((await read()).figureFile).toBe(null);
    const download = await page.request.get(`/api/v1/files/${original.fileId}/download`);
    expect(download.ok()).toBe(true); expect(await download.text()).toContain('solid browser_fixture');
    const archive = await page.request.get('/api/v1/storage/figure-file/download?root=FIGURE_FIXTURES&path=replacement.zip');
    expect(await archive.text()).toBe('existing archive fixture');
    expect(errors).toEqual([]);
  } finally { await page.request.delete(url); }
});

test('unavailable figure file shows a retry and never submits the parent editor', async ({ page }) => {
  await page.goto('/catalog/new'); await page.getByRole('textbox', { name: 'Название', exact: true }).fill('Availability fixture');
  await page.getByRole('button', { name: 'Выбрать файл фигурки', exact: true }).click();
  await page.getByRole('combobox', { name: 'Хранилище моделей' }).selectOption('FIGURE_FIXTURES');
  await page.route('**/api/v1/storage/browse?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Сетевой диск недоступен' } }) }));
  await page.getByRole('button', { name: 'Обновить список моделей' }).click();
  await expect(page.getByText('Сетевой диск недоступен', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/new$/);
  await page.unroute('**/api/v1/storage/browse?*'); await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  const row = page.locator('.figure-picker .browser-entry').filter({ hasText: 'replacement.zip' });
  await expect(row).toBeVisible();
  await page.route('**/api/v1/storage/figure-file?*', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Файл или папка отсутствует' } }) }));
  await row.getByRole('button', { name: 'Выбрать', exact: true }).click(); await expect(page.getByText('Файл или папка отсутствует', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/new$/);
});
