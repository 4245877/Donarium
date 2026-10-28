import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFileName, safeRelativePath } from '../storage/service.js';
import { rows, sha256, validateRow, TransferError, uuid, TABLES, type Manifest, type Row } from './format.js';
export const EXTRA_TABLES=['storage_files','import_sources','storage_operations','storage_matches','storage_events'] as const;
export const allTables=()=>[...TABLES,...EXTRA_TABLES];
const object=(v:unknown)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export async function validateRegistryArchive(directory:string,entries:Set<string>,check:()=>void):Promise<Manifest> {
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as Manifest;
  if(manifest.format!=='donarium'||manifest.version!==2||!['metadata','files'].includes(manifest.fileMode??''))throw new TransferError('Неподдерживаемый формат реестра');
  const ids=new Map<string,Map<string,Row>>(),expected=new Set(['manifest.json']);
  for(const table of allTables()) {
    check();const info=manifest.tables[table];
    if(!info||!Number.isSafeInteger(info.count)||info.count<0||!/^[a-f0-9]{64}$/.test(info.sha256)||!entries.has(`${table}.ndjson`)||await sha256(join(directory,`${table}.ndjson`),check)!==info.sha256)throw new TransferError('Не совпала контрольная сумма метаданных');
    expected.add(`${table}.ndjson`);const found=new Map<string,Row>();ids.set(table,found);
    for await(const row of rows(join(directory,`${table}.ndjson`))) {
      check();
      if(table==='storage_files') {
        if(!uuid(row.id)||!/^[A-Z][A-Z0-9_]{0,63}$/.test(row.storage_key)||typeof row.relative_path!=='string'||typeof row.name!=='string'||typeof row.format!=='string'||row.format.length>100||!['image','model','archive','source','other'].includes(row.kind)||typeof row.media_type!=='string'||row.media_type.length>200||!(row.size_bytes===null||typeof row.size_bytes==='string'&&/^\d{1,19}$/.test(row.size_bytes)&&BigInt(row.size_bytes)<=9223372036854775807n)||!(row.sha256===null||typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256))||!['available','unverified','missing','corrupt','unavailable'].includes(row.status)||!Number.isFinite(Date.parse(row.created_at))||!object(row.metadata))throw new TransferError('Некорректная запись реестра файлов');
        safeRelativePath(row.relative_path);safeFileName(row.name);
        if(row.storage_key==='DONARIUM_UPLOADS'&&(row.relative_path.startsWith('.staging/')||row.relative_path.startsWith('.restore-stage-')))throw new TransferError('Незавершённый файл в реестре');
        if(row.archive_path!==null) {
          if(manifest.fileMode!=='files'||row.archive_path!==`files/${row.id}/${row.name}`||!entries.has(row.archive_path)||row.size_bytes===null||!row.sha256)throw new TransferError('Недопустимая запись файла в архиве');
          safeRelativePath(row.archive_path);expected.add(row.archive_path);
          if(String((await stat(join(directory,row.archive_path))).size)!==row.size_bytes||await sha256(join(directory,row.archive_path),check)!==row.sha256)throw new TransferError('Не совпала контрольная сумма или размер оригинала');
        } else if(manifest.fileMode==='files')throw new TransferError('В полном архиве отсутствует файл');
      } else if(table==='storage_operations') {
        if(!uuid(row.id)||typeof row.kind!=='string'||row.kind.length>100||!['running','completed','failed','interrupted'].includes(row.status)||!object(row.parameters)||!object(row.result)||!Number.isFinite(Date.parse(row.created_at))||!Number.isFinite(Date.parse(row.updated_at)))throw new TransferError('Некорректный журнал операций');
      } else if(table==='storage_matches') {
        if(!uuid(row.id)||!uuid(row.product_id)||(row.file_id!==null&&!uuid(row.file_id))||(row.operation_id!==null&&!uuid(row.operation_id))||!['exact','stem','normalized','ambiguous','missing','manual'].includes(row.method)||!['pending','confirmed','applied','rejected','rolled_back'].includes(row.status)||typeof row.source_name!=='string'||!Array.isArray(row.candidates)||row.candidates.some((id:unknown)=>!uuid(id))||!object(row.snapshot)||(row.applied_snapshot!==null&&!object(row.applied_snapshot)))throw new TransferError('Некорректный журнал сопоставлений');
      } else if(table==='storage_events') {
        if(!/^\d+$/.test(String(row.id))||(row.product_id!==null&&!uuid(row.product_id))||(row.file_id!==null&&!uuid(row.file_id))||(row.operation_id!==null&&!uuid(row.operation_id))||typeof row.action!=='string'||!object(row.details)||!Number.isFinite(Date.parse(row.created_at)))throw new TransferError('Некорректное событие хранилища');
      } else if(table==='import_sources') {if(!uuid(row.product_id)||!/^[A-Z][A-Z0-9_]{0,63}$/.test(row.storage_key)||typeof row.relative_path!=='string')throw new TransferError('Недопустимый источник импорта');safeRelativePath(row.relative_path,true);}
      else validateRow(table,row,true);
      const key=row.id??(table==='import_sources'?`${row.storage_key}:${row.relative_path}`:`${row.product_id}:${row.category_id??row.tag_id}`);
      if(found.has(key))throw new TransferError('Повторный идентификатор');found.set(key,row);
    }
    if(found.size!==info.count)throw new TransferError('Не совпало количество записей');
  }
  const files=ids.get('storage_files')!,products=ids.get('products')!,assets=ids.get('assets')!,categories=ids.get('categories')!,tags=ids.get('tags')!;
  const paths=new Set<string>();
  for(const f of files.values()){const key=`${f.storage_key}:${f.relative_path}`;if(paths.has(key))throw new TransferError('Повторный физический путь');paths.add(key);}
  for(const [table,list] of ids)for(const row of list.values()) {
    if(row.product_id&&!products.has(row.product_id)||row.category_id&&!categories.has(row.category_id)||row.tag_id&&!tags.has(row.tag_id))throw new TransferError('Потеряна связь каталога');
    if(['assets','storage_matches','storage_events'].includes(table)&&row.file_id&&!files.has(row.file_id))throw new TransferError('Потеряна связь реестра');
    if(table==='storage_matches') {
      if(row.candidates.some((id:string)=>!files.has(id)))throw new TransferError('Потерян кандидат сопоставления');
      for(const snapshot of [row.snapshot,row.applied_snapshot].filter(Boolean)) {
        if(!(snapshot.source_url===null||typeof snapshot.source_url==='string'&&/^https?:\/\//.test(snapshot.source_url))||typeof snapshot.description!=='string'||snapshot.description.length>100000||!Array.isArray(snapshot.assets)||snapshot.assets.length>10000)throw new TransferError('Недопустимый снимок миграции');
        // A historical attachment may have been deliberately detached. History remains
        // portable; rollback will reject a missing/changed live attachment separately.
        for(const a of snapshot.assets) {validateRow('assets',a,true);if(a.product_id!==row.product_id||(assets.has(a.id)&&assets.get(a.id)!.product_id!==row.product_id))throw new TransferError('Снимок ссылается на чужое вложение');}
        if(snapshot.newAsset&&(!uuid(snapshot.newAsset)||(assets.has(snapshot.newAsset)&&assets.get(snapshot.newAsset)!.product_id!==row.product_id)||!snapshot.assets.some((a:Row)=>a.id===snapshot.newAsset)))throw new TransferError('Потерян UUID созданного вложения');
      }
    }
    if(['storage_matches','storage_events'].includes(table)&&row.operation_id&&!ids.get('storage_operations')!.has(row.operation_id))throw new TransferError('Потеряна связь журнала');
    if(table==='products'&&row.cover_asset_id) {const cover=assets.get(row.cover_asset_id);if(!cover||cover.product_id!==row.id||cover.kind!=='image')throw new TransferError('Недопустимая обложка');}
  }
  for(const row of categories.values()) {
    const seen=new Set<string>();let current:Row|undefined=row;
    while(current?.parent_id){if(seen.has(current.id)||!categories.has(current.parent_id))throw new TransferError('Цикл или отсутствующая категория');seen.add(current.id);current=categories.get(current.parent_id);}
  }
  if(entries.size!==expected.size||[...entries].some(e=>!expected.has(e)))throw new TransferError('В архиве лишние файлы');
  return manifest;
}
