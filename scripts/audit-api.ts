/** Non-destructive HTTP security and download checks against the working instance. */
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
process.loadEnvFile('.env');
const base='http://192.168.0.151:4180',checks:Record<string,unknown>[]=[];
async function check(path:string,expected:number,init:RequestInit={}) {
  const response=await fetch(base+path,{...init,signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,expected,path);checks.push({path,status:response.status});return response;
}
const health=await (await check('/health',200)).json();
for(const path of ['/api/v1/products','/api/v1/files','/api/v1/storage/browse?root=LIBRARY','/api/v1/exports/catalog.json','/api/v1/assets/00000000-0000-4000-8000-000000000000/content'])await check(path,401);
for(const path of ['/.env','/backups/database.dump','/var/uploads/','/%2e%2e%2fetc/passwd'])await check(path,404);
const login=await check('/api/v1/auth/login',200,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:process.env.ADMIN_PASSWORD})});
const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
try {
  const headers={cookie};
  await check('/api/v1/products/not-a-uuid',400,{headers});
  await check('/api/v1/files/%2e%2e%2fetc%2fpasswd/download',400,{headers});
  await check('/api/v1/storage/browse?root=SYSTEM&path=etc',403,{headers});
  for(const path of ['../etc','%2Fetc%2Fpasswd','folder%2F..%2Fsecret','a%5Cb','a%00b'])await check(`/api/v1/storage/browse?root=LIBRARY&path=${path}`,400,{headers});
  await check('/api/v1/products',403,{method:'POST',headers:{cookie,origin:'https://attacker.invalid','content-type':'application/json'},body:JSON.stringify({title:'must not be created'})});
  const injection=await check(`/api/v1/products?q=${encodeURIComponent("' OR 1=1; --")}`,200,{headers});assert.equal((await injection.json()).total,0);
  const list=await (await check('/api/v1/files?root=LIBRARY&pageSize=1',200,{headers})).json();
  const id=list.items[0].id,path=`/api/v1/files/${id}/download`;
  const partial=await check(path,206,{headers:{cookie,range:'bytes=0-63'}});assert.equal((await partial.arrayBuffer()).byteLength,64);
  assert.equal(partial.headers.get('x-content-type-options'),'nosniff');assert.match(partial.headers.get('content-disposition')!,/^attachment;/);
  await check(path,416,{headers:{cookie,range:'bytes=9999999999999999-'}});
  const head=await check(path,200,{method:'HEAD',headers});assert.equal((await head.arrayBuffer()).byteLength,0);
} finally {await check('/api/v1/auth/logout',200,{method:'POST',headers:{cookie}});}
await writeFile('var/qa/independent-audit-20261028/production-api.json',JSON.stringify({checkedAt:new Date().toISOString(),health,checks,passed:checks.length,workingCatalogMutations:0},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:checks.length,workingCatalogMutations:0,health}));
