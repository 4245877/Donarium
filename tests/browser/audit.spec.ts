import { test, expect } from '@playwright/test';

test('a partially successful batch upload immediately shows saved files and reports the failure', async ({ page }) => {
  test.skip(process.env.E2E_WRITE !== 'donarium_test' || !process.env.E2E_PASSWORD, 'Requires isolated write fixtures.');
  const login=await page.request.post('/api/v1/auth/login',{data:{password:process.env.E2E_PASSWORD}});expect(login.ok()).toBe(true);
  const name=`Успешный файл ${Date.now()}.stl`;
  await page.goto('/files');
  await expect(page.getByRole('heading',{name:'Файлы',exact:true})).toBeVisible();
  await expect(page.locator('.registry-list')).toBeAttached();
  await page.route('**/api/v1/files/upload?name=failed-batch.stl',route=>route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({error:{message:'Тест: недостаточно места'}})}));
  await page.locator('.files-page input[type=file]').setInputFiles([
    {name,mimeType:'application/octet-stream',buffer:Buffer.from(`solid ${name}\nendsolid\n`)},
    {name:'failed-batch.stl',mimeType:'application/octet-stream',buffer:Buffer.from('failed upload')},
  ]);
  await expect(page.getByRole('alert')).toContainText('Тест: недостаточно места');
  await expect(page.locator('.registry-row').filter({hasText:name})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Загружено: 1');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
