import { test,expect } from '@playwright/test';
test('registry UI uploads once, reuses files on cards, replaces and unlinks without losing originals',async({page})=> {
 test.skip(process.env.E2E_WRITE!=='donarium_test'||!process.env.E2E_PASSWORD,'Requires isolated QA installation');test.setTimeout(90000);
 const login=await page.request.post('/api/v1/auth/login',{data:{password:process.env.E2E_PASSWORD}});expect(login.ok()).toBe(true);
 const suffix=String(Date.now()),first=`registry-${suffix}.rar`,second=`replacement-${suffix}.zip`;
 const a=(await (await page.request.post('/api/v1/products',{data:{title:`Registry A ${suffix}`}})).json()).item;
 const b=(await (await page.request.post('/api/v1/products',{data:{title:`Registry B ${suffix}`}})).json()).item;
 try {
  await page.goto('/files');await expect(page.getByRole('heading',{name:'Файлы',exact:true})).toBeVisible();
  await page.locator('input[type=file]').setInputFiles([{name:first,mimeType:'application/octet-stream',buffer:Buffer.from('original model')},{name:second,mimeType:'application/octet-stream',buffer:Buffer.from('replacement model')}]);
  const row=page.locator('.registry-row').filter({has:page.getByText(first,{exact:true})});await expect(row).toBeVisible();
  await row.getByText('Товары и связи',{exact:true}).click();await row.getByLabel('Привязать к товару').fill(a.title);await row.getByRole('button',{name:a.title,exact:true}).click();await expect(row.getByRole('link',{name:a.title,exact:true})).toBeVisible();
  await page.goto(`/catalog/${b.id}`);await page.getByRole('button',{name:'Выбрать из библиотеки'}).click();await page.getByLabel('Поиск по имени или SHA-256').fill(first);
  await page.locator('.file-picker .registry-row').filter({has:page.getByText(first,{exact:true})}).getByRole('button',{name:'Выбрать',exact:true}).click();await expect(page.getByRole('heading',{name:first,exact:true})).toBeVisible();
  const before=(await (await page.request.get(`/api/v1/products/${a.id}`)).json()).item;const originalAsset=before.assets[0].id,firstFile=before.assets[0].fileId;
  await page.goto(`/catalog/${a.id}`);await page.getByRole('button',{name:'Заменить',exact:true}).click();await page.getByLabel('Поиск по имени или SHA-256').fill(second);await page.locator('.file-picker .registry-row').filter({has:page.getByText(second,{exact:true})}).getByRole('button',{name:'Выбрать',exact:true}).click();
  await expect(page.getByRole('heading',{name:second,exact:true})).toBeVisible();const after=(await (await page.request.get(`/api/v1/products/${a.id}`)).json()).item;expect(after.assets[0].id).toBe(originalAsset);expect(after.assets[0].fileId).not.toBe(firstFile);
  await page.getByRole('button',{name:`Отвязать ${second}`,exact:true}).click();await page.getByRole('button',{name:'Подтвердить отвязку',exact:true}).click();await expect(page.locator('.asset-row')).toHaveCount(0);
  const original=await page.request.get(`/api/v1/files/${firstFile}/download`);expect(await original.text()).toBe('original model');
  await page.goto('/files');await page.getByLabel('Непривязанные',{exact:true}).check();await page.getByLabel('Имя или SHA-256',{exact:true}).fill(second);await expect(page.locator('.registry-row')).toHaveCount(1);
  await page.screenshot({path:'var/qa/storage-files-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await expect(page.locator('.registry-row')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'var/qa/storage-files-mobile.png',fullPage:true});
 }finally{await page.request.delete(`/api/v1/products/${a.id}`);await page.request.delete(`/api/v1/products/${b.id}`);}
});

test('matching UI requires confirmation before applying an archive to a product',async({page})=> {
 test.skip(process.env.E2E_WRITE!=='donarium_test'||!process.env.E2E_PASSWORD,'Requires isolated QA installation');test.setTimeout(60000);
 expect((await page.request.post('/api/v1/auth/login',{data:{password:process.env.E2E_PASSWORD}})).ok()).toBe(true);
 const start=await page.request.post('/api/v1/files/inventory',{data:{root:'MATCH_FIXTURES'}});expect(start.status()).toBe(202);
 const waitJob=async(id:string)=>{await expect.poll(async()=> (await (await page.request.get(`/api/v1/storage/operations/${id}`)).json()).status).toBe('completed');};
 await waitJob((await start.json()).jobId);
 const verify=await page.request.post('/api/v1/files/verify',{data:{root:'MATCH_FIXTURES'}});await waitJob((await verify.json()).jobId);
 await page.goto('/files');await page.getByRole('combobox',{name:'Хранилище',exact:true}).selectOption('MATCH_FIXTURES');
 await page.getByRole('button',{name:'Сопоставление товаров',exact:true}).click();
 const preview=page.waitForResponse(r=>r.url().endsWith('/storage/matches/preview')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Подготовить соответствия',exact:true}).click();await waitJob((await (await preview).json()).jobId);
 await page.getByRole('button',{name:'Обновить',exact:true}).click();
 const row=page.locator('.match-row').filter({has:page.getByRole('link',{name:'Matching fixture',exact:true})});
 await expect(row).toContainText('normalized');await expect(row).toContainText('pending');
 await expect(page.getByRole('button',{name:'Применить подтверждённые (0)',exact:true})).toBeDisabled();
 await row.getByRole('button',{name:'Подтвердить этот архив',exact:true}).click();
 await page.getByRole('combobox',{name:'Состояние',exact:true}).selectOption('confirmed');
 await row.getByLabel('Применить Matching fixture',{exact:true}).check();
 const applied=page.waitForResponse(r=>r.url().endsWith('/storage/matches/apply')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Применить подтверждённые (1)',exact:true}).click();await waitJob((await (await applied).json()).jobId);
 await page.getByRole('combobox',{name:'Состояние',exact:true}).selectOption('applied');await row.getByRole('link',{name:'Matching fixture',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Match-Model.rar',exact:true})).toBeVisible();
});
