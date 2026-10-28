import { extname } from 'node:path';
import type { Pool } from 'pg';
import { attachFile, getFile } from './registry.js';
import { StorageError, fileMetadata } from './service.js';
import { StorageJobs } from './jobs.js';

export const isDrive=(value:string|null)=> {try{return !!value && ['drive.google.com','docs.google.com'].includes(new URL(value).hostname);}catch{return false;}};
const canonical=(value:any):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const drivePattern=/https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"')]+/gi;
// Photos and documents are independent resources, even when hosted on Drive.
const modelLink=(asset:any)=>isDrive(asset.external_url)&&['archive','model','source'].includes(asset.kind);
export const stem=(name:string)=> {
  if(!['archive','model','source'].includes(fileMetadata(name).kind))return name;
  return /\.tar\.gz$/i.test(name)?name.slice(0,-7):name.slice(0,-extname(name).length);
};
export const normalized=(name:string)=>stem(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function chooseMatches(source:string,files:{id:string;name:string}[]) {
  if(!source.trim())return {method:'missing',candidates:[] as string[],fileId:null};
  const tests:[string,(name:string)=>boolean][]=[['exact',name=>name===source],['stem',name=>stem(name)===stem(source)],['normalized',name=>normalized(name)===normalized(source)]];
  for(const [method,test] of tests) {const found=files.filter(file=>test(file.name));if(found.length)return {method:found.length===1?method:'ambiguous',candidates:found.map(f=>f.id),fileId:found.length===1?found[0]!.id:null};}
  return {method:'missing',candidates:[],fileId:null};
}
export class LibraryMatching {
  constructor(readonly pool:Pool,readonly jobs:StorageJobs){}
  async preview(root:string) {
    this.jobs.registry.service.root(root);
    return this.jobs.start('match-preview',{root},async(operation,client)=> {
      const files=(await client.query(`SELECT f.id,f.name FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE s.key=$1 AND f.kind IN ('archive','model','source') ORDER BY f.relative_path COLLATE "C"`,[root])).rows;
      if(!files.length)throw new StorageError('Сначала зарегистрируйте файлы библиотеки',409);
      const products=(await client.query(`SELECT p.*,coalesce((SELECT jsonb_agg(e.metadata) FROM external_links e WHERE e.product_id=p.id),'[]'::jsonb) AS sources FROM products p ORDER BY p.id`)).rows;
      await client.query('UPDATE storage_operations SET total=$2 WHERE id=$1',[operation,products.length]);
      const counts:Record<string,number>={};
      for(const p of products) {
        const names=new Set<string>();
        for(const meta of p.sources) { const value=meta.source_fields?.['Имя STL/ZIP-файла']??meta.portable_record?.['Имя STL/ZIP-файла']; if(typeof value==='string'&&value.trim())names.add(value.trim()); }
        const source=[...names][0]??'';
        const match=chooseMatches(source,files);
        if(names.size>1) {const alternatives=[...names].map(n=>chooseMatches(n,files));const ids=new Set(alternatives.flatMap(m=>m.candidates));if(ids.size!==1||alternatives.some(m=>!m.fileId)) {match.method='ambiguous';match.fileId=null;match.candidates=[...ids];}}
        const assets=(await client.query('SELECT * FROM assets WHERE product_id=$1 ORDER BY created_at,id',[p.id])).rows.filter(modelLink);
        const snapshot={source_url:p.source_url,description:p.description,assets};
        await client.query(`INSERT INTO storage_matches(product_id,file_id,method,source_name,candidates,snapshot,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(product_id) DO UPDATE SET file_id=EXCLUDED.file_id,method=EXCLUDED.method,source_name=EXCLUDED.source_name,candidates=EXCLUDED.candidates,snapshot=EXCLUDED.snapshot,status='pending',operation_id=EXCLUDED.operation_id,updated_at=now()
          WHERE storage_matches.status IN ('pending','confirmed','rejected','rolled_back')`,[p.id,match.fileId,match.method,source,JSON.stringify(match.candidates),snapshot,operation]);
        counts[match.method]=(counts[match.method]??0)+1;
        await client.query('UPDATE storage_operations SET progress=progress+1 WHERE id=$1',[operation]);
      }
      return {products:products.length,files:files.length,counts,requiresConfirmation:true};
    });
  }
  async confirm(id:string,fileId:string,reject=false) {
    return this.jobs.registry.transaction(async client=> {
      const match=(await client.query('SELECT * FROM storage_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!match)throw new StorageError('Соответствие не найдено',404);
      if(match.status==='applied')throw new StorageError('Соответствие уже применено',409);
      if(!reject) {const file=await getFile(client,fileId);if(file.status!=='available'||!file.sha256||!file.verified_at)throw new StorageError('Подтверждать можно только проверенный файл с SHA-256',409);}
      await client.query(`UPDATE storage_matches SET file_id=$2,status=$3,method=CASE WHEN file_id IS DISTINCT FROM $2 THEN 'manual' ELSE method END,updated_at=now() WHERE id=$1`,[id,reject?match.file_id:fileId,reject?'rejected':'confirmed']);
      return {confirmed:!reject};
    });
  }
  apply(ids:string[]) {
    return this.jobs.start('match-apply',{ids},async(operation,client)=> {
      const matches=(await client.query(`SELECT id FROM storage_matches WHERE id=ANY($1::uuid[]) AND status IN ('confirmed','applied') ORDER BY id`,[ids])).rows;
      if(matches.length!==ids.length)throw new StorageError('Выберите только подтверждённые соответствия',409);
      await client.query('UPDATE storage_operations SET total=$2 WHERE id=$1',[operation,matches.length]);
      let applied=0,skipped=0;const errors:{id:string;message:string}[]=[];
      for(const {id} of matches) {
        this.jobs.check();
        try { await this.jobs.registry.transaction(async tx=> {
          const m=(await tx.query('SELECT * FROM storage_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
          if(m.status==='applied'){skipped++;return;}
          if(m.status!=='confirmed')throw new StorageError('Подтверждение изменилось',409);
          const p=(await tx.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[m.product_id])).rows[0];
          if(p.source_url!==m.snapshot.source_url||p.description!==m.snapshot.description)throw new StorageError('Карточка изменена после предпросмотра; повторите сопоставление',409);
          const file=await getFile(tx,m.file_id);
          if(file.status!=='available'||!file.sha256)throw new StorageError('Файл не проверен или недоступен',409);
          const allAssets=(await tx.query('SELECT * FROM assets WHERE product_id=$1 ORDER BY created_at,id FOR UPDATE',[p.id])).rows;
          const oldAssets=allAssets.filter(modelLink);
          // Older previews included every Drive link. Require a fresh preview rather than
          // applying that unsafe selection or silently changing its snapshot.
          if(canonical(oldAssets)!==canonical(m.snapshot.assets))throw new StorageError('Вложения изменились после предпросмотра; подготовьте соответствия заново',409);
          if(new Set(oldAssets.map(a=>a.external_url)).size>1)throw new StorageError('В карточке несколько разных архивов Drive; уточните связи перед сопоставлением',409);
          const original=oldAssets[0];
          const linked=await attachFile(tx,this.jobs.registry.service,p.id,file.id,original?{replaceAssetId:original.id}:{});
          if(original||linked.inserted)await tx.query(`UPDATE assets SET metadata=metadata || jsonb_build_object('migration_origin',$2::jsonb) WHERE id=$1`,[linked.id,JSON.stringify({operation,original:original??null,sourceUrl:p.source_url,description:p.description})]);
          for(const old of oldAssets.slice(1))await tx.query('UPDATE assets SET retired_at=now() WHERE id=$1',[old.id]);
          const migratedUrls=new Set([...(isDrive(p.source_url)?[p.source_url]:[]),...oldAssets.map(a=>a.external_url)]);
          const description=p.description.replace(drivePattern,(url:string)=>migratedUrls.has(url)?`/api/v1/assets/${linked.id}/download`:url);
          await tx.query('UPDATE products SET source_url=$2,description=$3 WHERE id=$1',[p.id,isDrive(p.source_url)?null:p.source_url,description]);
          const afterAssets=(await tx.query('SELECT * FROM assets WHERE id=ANY($1::uuid[]) ORDER BY created_at,id',[[linked.id,...oldAssets.slice(1).map(a=>a.id)]])).rows;
          const after={source_url:isDrive(p.source_url)?null:p.source_url,description,assets:afterAssets,newAsset:!original&&linked.inserted?linked.id:null};
          await tx.query(`UPDATE storage_matches SET status='applied',applied_snapshot=$2,operation_id=$3,updated_at=now() WHERE id=$1`,[id,after,operation]);
          await tx.query(`INSERT INTO storage_events(operation_id,file_id,product_id,action,details) VALUES($1,$2,$3,'migrate',$4)`,[operation,file.id,p.id,JSON.stringify({matchId:id,assetId:linked.id})]);applied++;
        });}catch(error){errors.push({id,message:error instanceof StorageError?error.message:'Ошибка применения; транзакция отменена'});}
        await client.query('UPDATE storage_operations SET progress=progress+1,result=$2,updated_at=now() WHERE id=$1',[operation,{applied,skipped,errors}]);
      }
      return {applied,skipped,errors};
    });
  }
  async rollback(id:string) {
    return this.jobs.registry.transaction(async tx=> {
      const m=(await tx.query('SELECT * FROM storage_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(m?.status==='rolled_back')return {rolledBack:true};
      if(!m||m.status!=='applied')throw new StorageError('Применённое соответствие не найдено',409);
      const p=(await tx.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[m.product_id])).rows[0],after=m.applied_snapshot;
      if(p.source_url!==after.source_url||p.description!==after.description)throw new StorageError('Описание или источник изменены пользователем; автоматический откат остановлен',409);
      const assets=(await tx.query('SELECT * FROM assets WHERE id=ANY($1::uuid[]) ORDER BY created_at,id FOR UPDATE',[after.assets.map((a:any)=>a.id)])).rows;
      if(canonical(assets)!==canonical(after.assets))throw new StorageError('Связи изменены пользователем; автоматический откат остановлен',409);
      if(after.newAsset)await tx.query('DELETE FROM assets WHERE id=$1',[after.newAsset]);
      for(const a of m.snapshot.assets)await tx.query(`UPDATE assets SET file_id=NULL,storage_id=$2,relative_path=$3,external_url=$4,name=$5,kind=$6,media_type=$7,size_bytes=$8,sha256=$9,origin=$10,metadata=$11,retired_at=$12 WHERE id=$1`,[a.id,a.storage_id,a.relative_path,a.external_url,a.name,a.kind,a.media_type,a.size_bytes,a.sha256,a.origin,a.metadata,a.retired_at]);
      await tx.query('UPDATE products SET source_url=$2,description=$3 WHERE id=$1',[p.id,m.snapshot.source_url,m.snapshot.description]);
      await tx.query(`UPDATE storage_matches SET status='rolled_back',updated_at=now() WHERE id=$1`,[id]);
      await tx.query(`INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'migration-rollback',$3)`,[m.file_id,p.id,JSON.stringify({matchId:id})]);
      return {rolledBack:true};
    });
  }
}
