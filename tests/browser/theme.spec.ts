import { test, expect, type Page } from '@playwright/test';

const root = (page: Page) => page.locator('html');
const themeSwitch = (page: Page) => page.getByRole('switch', { name: 'Тёмная тема' });
const signedOut = (page: Page) => page.route('**/api/v1/auth/session', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true, authenticated: false, readOnly: false }) }));

test('theme follows the system until chosen on the login screen, then remembers the choice', async ({ page }) => {
  await signedOut(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByLabel('Пароль владельца')).toBeVisible();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await themeSwitch(page).click();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d0d10');
  expect(await page.evaluate(() => localStorage.getItem('donarium-theme'))).toBe('dark');
  await page.reload();
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
});

test('the remembered theme is painted before the application starts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('donarium-theme', 'light'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route(/\/assets\/.*\.js$/, route => route.abort());
  await page.goto('/');
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(245, 243, 239)');
});

test('top bar switch works from the keyboard and keeps the theme across sections', async ({ page }) => {
  test.skip(!process.env.E2E_PASSWORD, 'Requires a test installation password.');
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const login = await page.request.post('/api/v1/auth/login', { data: { password: process.env.E2E_PASSWORD } });
  expect(login.ok()).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/catalog');
  await themeSwitch(page).focus();
  await page.keyboard.press('Space');
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.getByRole('link', { name: 'Настройки и состояние', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Настройки и состояние', exact: true })).toBeVisible();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await expect(themeSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await themeSwitch(page).press('Enter');
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});
