import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { StorageService, StorageError, fileMetadata } from './service.js';

type Query = Pick<PoolClient,'query'>;
export interface FileRow {
  id:string; storage_id:string; storage_key:string; relative_path:string; name:string; format:string; kind:string;
  media_type:string; size_bytes:string|null; sha256:string|null; status:string; created_at:Date; checked_at:Date|null; verified_at:Date|null; metadata:Record<string,any>;
}
export async function location(client:Query,service:StorageService,key:string) {
  const root=service.root(key);
  return (await client.query<{id:string}>(`INSERT INTO storage_locations(key,name,kind) VALUES($1,$2,'local') ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[key,root.name])).rows[0]!.id;
}
export async function getFile(client:Query,id:string,lock=false) {
  const row=(await client.query<FileRow>(`SELECT f.*,f.size_bytes::text,s.key AS storage_key FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE f.id=$1 ${lock?'FOR UPDATE OF f':''}`,[id])).rows[0];
  if(!row) throw new StorageError('Файл не найден в реестре',404); return row;
}
export async function registerFile(client:Query,service:StorageService,key:string,path:string,options:{name?:string;sha256?:string;sizeBytes?:string}={}) {
  if(key==='DONARIUM_UPLOADS'&&(path.startsWith('.staging/')||path.startsWith('.restore-stage-')))throw new StorageError('Незавершённые загрузки нельзя включать в реестр',403);
  const opened=await service.open(key,path); const size=String(opened.stat.size), fingerprint=`${size}:${opened.stat.mtimeMs}:${opened.stat.ctimeMs}`; await opened.handle.close();
  if(options.sizeBytes && size!==options.sizeBytes) throw new StorageError('Размер файла изменился',409);
  const storage=await location(client,service,key), name=options.name??basename(path), meta=fileMetadata(name);
  const row=(await client.query<FileRow>(`INSERT INTO storage_files(storage_id,relative_path,name,format,kind,media_type,size_bytes,sha256,status,checked_at,verified_at,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),CASE WHEN $8::text IS NOT NULL THEN now() END,$10)
    ON CONFLICT(storage_id,relative_path) DO UPDATE SET checked_at=now(),
      status=CASE WHEN storage_files.size_bytes IS DISTINCT FROM EXCLUDED.size_bytes OR (storage_files.sha256 IS NOT NULL AND EXCLUDED.sha256 IS NOT NULL AND storage_files.sha256<>EXCLUDED.sha256) THEN 'corrupt'
        WHEN EXCLUDED.sha256 IS NOT NULL THEN 'available' ELSE storage_files.status END,
      sha256=coalesce(storage_files.sha256,EXCLUDED.sha256),
      size_bytes=coalesce(storage_files.size_bytes,EXCLUDED.size_bytes),
      verified_at=CASE WHEN EXCLUDED.sha256 IS NOT NULL AND (storage_files.sha256 IS NULL OR storage_files.sha256=EXCLUDED.sha256) AND (storage_files.size_bytes IS NULL OR storage_files.size_bytes=EXCLUDED.size_bytes) THEN now() ELSE storage_files.verified_at END,
      metadata=storage_files.metadata || EXCLUDED.metadata
    RETURNING *,size_bytes::text`,[storage,path,name,extname(name).slice(1).toLowerCase(),meta.kind,meta.mediaType,size,options.sha256??null,options.sha256?'available':'unverified',JSON.stringify({fingerprint})])).rows[0]!;
  return {...row,storage_key:key};
}
export async function attachFile(client:Query,service:StorageService,productId:string,fileId:string,options:{replaceAssetId?:string;name?:string}={}) {
  if(!(await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[productId])).rowCount) throw new StorageError('Карточка не найдена',404);
  const file=await getFile(client,fileId);
  if(['missing','corrupt','unavailable'].includes(file.status)) throw new StorageError('Файл недоступен или повреждён; сначала проверьте его',409);
  const check=await service.open(file.storage_key,file.relative_path); const size=String(check.stat.size); await check.handle.close();
  if(file.size_bytes!==size) throw new StorageError('Размер файла изменился; требуется проверка',409);
  if(options.replaceAssetId) {
    const previous=(await client.query('SELECT * FROM assets WHERE id=$1 AND product_id=$2 FOR UPDATE',[options.replaceAssetId,productId])).rows[0];
    if(!previous) throw new StorageError('Заменяемое вложение не найдено',404);
    if(previous.file_id===fileId && (!options.name || options.name===previous.name))return {id:previous.id,inserted:false};
    const duplicate=(await client.query('SELECT id FROM assets WHERE product_id=$1 AND file_id=$2 AND id<>$3',[productId,fileId,previous.id])).rows[0];
    if(duplicate) throw new StorageError('Этот файл уже прикреплён к карточке',409);
    if(previous.kind==='image'&&file.kind!=='image') await client.query('UPDATE products SET cover_asset_id=NULL WHERE id=$1 AND cover_asset_id=$2',[productId,previous.id]);
    await client.query(`UPDATE assets SET file_id=$2,name=$3,kind=$4,media_type=$5,origin=$6,metadata=metadata || jsonb_build_object('previous_link',$7::jsonb) WHERE id=$1`,[previous.id,fileId,options.name??file.name,file.kind,file.media_type,file.storage_key==='DONARIUM_UPLOADS'?'uploaded':'external',JSON.stringify(previous)]);
    await client.query(`INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'replace',$3)`,[fileId,productId,JSON.stringify({assetId:previous.id,previousFileId:previous.file_id})]);
    await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[productId]);
    return {id:previous.id,inserted:false};
  }
  const result=await client.query<{id:string}>(`INSERT INTO assets(product_id,file_id,kind,name,media_type,origin)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[productId,fileId,file.kind,options.name??file.name,file.media_type,file.storage_key==='DONARIUM_UPLOADS'?'uploaded':'external']);
  const id=result.rows[0]?.id??(await client.query<{id:string}>('SELECT id FROM assets WHERE product_id=$1 AND file_id=$2',[productId,fileId])).rows[0]!.id;
  if(result.rowCount) {
    await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[productId]);
    await client.query(`INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'attach',$3)`,[fileId,productId,JSON.stringify({assetId:id})]);
  }
  return {id,inserted:!!result.rowCount};
}
export class FileRegistry {
  constructor(readonly pool:Pool,readonly service:StorageService){}
  async transaction<T>(work:(client:PoolClient)=>Promise<T>) {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; } finally { client.release(); }
  }
  private uploads=0;
  async upload(source:Readable,name:string,productId?:string) {
    if(this.uploads>=2)throw new StorageError('Две загрузки уже выполняются; повторите позже',429);
    this.uploads++;
    const uploadId=randomUUID();let lease:PoolClient|undefined;
    let stage:Awaited<ReturnType<StorageService['stageUpload']>>|undefined;
    try {
      lease=await this.pool.connect();
      await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`donarium-upload:${uploadId}`]);
      await lease.query(`INSERT INTO storage_uploads(id,name,status) VALUES($1,$2,'receiving')`,[uploadId,name]);
      stage=await this.service.stageUpload(source,name,uploadId);
      await lease.query(`UPDATE storage_uploads SET status='staged',size_bytes=$2,sha256=$3,updated_at=now() WHERE id=$1`,[uploadId,stage.sizeBytes,stage.sha256]);
    }catch(error){if(lease){await lease.query(`UPDATE storage_uploads SET status='failed',updated_at=now() WHERE id=$1`,[uploadId]).catch(()=>undefined);await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`donarium-upload:${uploadId}`]).catch(()=>undefined);lease.release();}this.uploads--;throw error;}
    const staged=stage;
    try {
      const result=await this.transaction(async client=> {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`donarium-content:${staged.sha256}:${staged.sizeBytes}`]);
        const duplicates=await client.query<FileRow>(`SELECT f.*,f.size_bytes::text,s.key AS storage_key FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE f.sha256=$1 AND f.size_bytes=$2 AND f.status='available' ORDER BY f.created_at,f.id`,[staged.sha256,staged.sizeBytes]);
        let file:FileRow|undefined;
        for(const candidate of duplicates.rows) {
          try { if(await this.service.hash(candidate.storage_key,candidate.relative_path)===staged.sha256) { file=candidate; break; }
            await client.query("UPDATE storage_files SET status='corrupt',checked_at=now() WHERE id=$1",[candidate.id]); }
          catch(error) { await client.query('UPDATE storage_files SET status=$2,checked_at=now() WHERE id=$1',[candidate.id,error instanceof StorageError&&error.statusCode===404?'missing':'unavailable']); }
        }
        const deduplicated=!!file;
        if(!file) {
          const uploaded=await this.service.promoteStage(staged);
          file=await registerFile(client,this.service,uploaded.root,uploaded.relativePath,{name,sha256:uploaded.sha256,sizeBytes:uploaded.sizeBytes});
          if(file.status!=='available') throw new StorageError('Контрольная сумма объекта конфликтует с реестром',409);
        }
        const linked=productId?await attachFile(client,this.service,productId,file.id,{name}):undefined;
        await client.query(`INSERT INTO storage_events(file_id,product_id,action,details) VALUES($1,$2,'upload',$3)`,[file.id,productId??null,JSON.stringify({uploadId,deduplicated,name,assetId:linked?.id})]);
        return {file,asset:linked?{...staged,relativePath:file.relative_path,root:file.storage_key,id:linked.id,fileId:file.id}:undefined,deduplicated};
      });
      await lease!.query(`UPDATE storage_uploads SET status='completed',file_id=$2,updated_at=now() WHERE id=$1`,[uploadId,result.file.id]);
      return result;
    } catch(error) { await lease!.query(`UPDATE storage_uploads SET status='failed',updated_at=now() WHERE id=$1`,[uploadId]).catch(()=>undefined);throw error; }
    finally { await this.service.discardStage(staged.relativePath).catch(()=>undefined);await lease!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`donarium-upload:${uploadId}`]).catch(()=>undefined);lease!.release();this.uploads--; }
  }
  async attach(product:string,file:string,replaceAssetId?:string) { return this.transaction(c=>attachFile(c,this.service,product,file,{replaceAssetId})); }
  async list(query:{q?:string;root?:string;status?:string;unlinked?:boolean;duplicates?:boolean;format?:string;page:number;pageSize:number}) {
    const conditions:string[]=[], values:unknown[]=[];
    const add=(sql:string,value:unknown)=>{values.push(value);conditions.push(sql.replace('?',`$${values.length}`));};
    if(query.q) add(`(lower(f.name) LIKE ? ESCAPE '\\' OR f.sha256=$${values.length+2})`,`%${query.q.toLowerCase().replace(/[\\%_]/g,'\\$&')}%`),values.push(query.q);
    if(query.root) add('s.key=?',query.root);
    if(query.status) add('f.status=?',query.status);
    if(query.format) add('f.format=?',query.format.toLowerCase());
    if(query.unlinked) conditions.push('NOT EXISTS(SELECT 1 FROM assets a WHERE a.file_id=f.id)');
    if(query.duplicates) conditions.push('f.sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM storage_files d WHERE d.sha256=f.sha256 AND d.size_bytes=f.size_bytes AND d.id<>f.id)');
    const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
    const total=Number((await this.pool.query(`SELECT count(*) FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id ${where}`,values)).rows[0].count);
    values.push(query.pageSize,(query.page-1)*query.pageSize);
    const items=(await this.pool.query(`SELECT f.*,f.size_bytes::text,s.key AS storage_key,(SELECT count(*)::int FROM assets a WHERE a.file_id=f.id) AS links FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id ${where} ORDER BY lower(f.name),f.relative_path COLLATE "C",f.id LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows;
    return {items,total,page:query.page,pageSize:query.pageSize};
  }
  async verify(id:string,hash=true,check:()=>void=()=>undefined) {
    const file=await getFile(this.pool,id);
    let status=!hash&&file.status==='corrupt'?'corrupt':!hash&&!file.sha256?'unverified':'available', checksum=file.sha256, size=file.size_bytes;
    try {
      const opened=await this.service.open(file.storage_key,file.relative_path); const actualSize=String(opened.stat.size); await opened.handle.close();
      if(hash) checksum=await this.service.hash(file.storage_key,file.relative_path,check);
      if((size!==null&&size!==actualSize)||(file.sha256&&hash&&file.sha256!==checksum)) status='corrupt';
      else size=actualSize;
    } catch(error) { status=error instanceof StorageError&&error.statusCode===404?'missing':'unavailable'; }
    await this.pool.query(`UPDATE storage_files SET status=$2,checked_at=now(),size_bytes=coalesce(size_bytes,$3),sha256=CASE WHEN $2='available' THEN coalesce(sha256,$4) ELSE sha256 END,verified_at=CASE WHEN $2='available' AND $5 THEN now() ELSE verified_at END WHERE id=$1`,[id,status,size,checksum,hash]);
    return {id,status};
  }
}
