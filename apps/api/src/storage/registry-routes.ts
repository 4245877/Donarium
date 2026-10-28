import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Readable } from 'node:stream';
import { FileRegistry, getFile } from './registry.js';
import { StorageJobs } from './jobs.js';
import { LibraryMatching } from './matching.js';
import { StorageError, StorageService } from './service.js';
import { sendPhysical } from './download.js';
const uuid={type:'string',format:'uuid'};
const params={type:'object',required:['id'],additionalProperties:false,properties:{id:uuid}};
const root={type:'string',maxLength:64,pattern:'^[A-Z][A-Z0-9_]*$'};
export async function registerRegistryRoutes(app:FastifyInstance,pool:Pool,service:StorageService) {
  const registry=new FileRegistry(pool,service),jobs=new StorageJobs(registry,pool),matching=new LibraryMatching(pool,jobs);
  await jobs.recover().catch((error:unknown)=>{
    if((error as {code?:string}).code==='42P01')throw new StorageError('Требуется миграция 006 файлового реестра',503);
    app.log.warn('Storage operation recovery deferred until PostgreSQL is available');
  });
  app.addHook('onClose',()=>jobs.close());
  app.get<{Querystring:{q?:string;root?:string;status?:string;unlinked?:boolean;duplicates?:boolean;format?:string;page:number;pageSize:number}}>('/api/v1/files',{
    schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:300},root,status:{type:'string',enum:['unverified','available','missing','corrupt','unavailable']},unlinked:{type:'boolean'},duplicates:{type:'boolean'},format:{type:'string',maxLength:30},page:{type:'integer',minimum:1,maximum:100000,default:1},pageSize:{type:'integer',minimum:1,maximum:200,default:50}}}}
  },request=>registry.list(request.query));
  app.get<{Params:{id:string}}>('/api/v1/files/:id',{schema:{params}},async request=> {
    const file=await getFile(pool,request.params.id);
    const products=(await pool.query(`SELECT p.id,p.title,a.id AS asset_id,a.retired_at FROM assets a JOIN products p ON p.id=a.product_id WHERE a.file_id=$1 ORDER BY p.title,p.id`,[file.id])).rows;
    const duplicates=file.sha256?(await pool.query(`SELECT id,name,relative_path FROM storage_files WHERE sha256=$1 AND size_bytes=$2 AND id<>$3 ORDER BY id`,[file.sha256,file.size_bytes,file.id])).rows:[];
    return {file,products,duplicates};
  });
  app.get<{Params:{id:string}}>('/api/v1/files/:id/download',{schema:{params}},async(request,reply)=> {
    const file=await getFile(pool,request.params.id);
    if(['corrupt','missing','unavailable'].includes(file.status))throw new StorageError('Файл недоступен или требует проверки',409);
    return sendPhysical(service,file.storage_key,file.relative_path,file.name,request,reply,{size:file.size_bytes,sha256:file.sha256});
  });
  app.post<{Body:{root:string}}>('/api/v1/files/inventory',{schema:{body:{type:'object',required:['root'],additionalProperties:false,properties:{root}}}},async(request,reply)=>reply.code(202).send(await jobs.inventory(request.body.root)));
  app.post<{Body:{root?:string}}>('/api/v1/files/verify',{schema:{body:{type:'object',additionalProperties:false,properties:{root}}}},async(request,reply)=>reply.code(202).send(await jobs.verify(request.body.root)));
  app.post<{Params:{id:string}}>('/api/v1/files/:id/verify',{schema:{params}},async(request,reply)=>reply.code(202).send(await jobs.start('verify-file',{fileId:request.params.id},async()=>registry.verify(request.params.id,true))));
  app.get('/api/v1/storage/inventory-status',async()=> {
    const file=await service.readStream('INVENTORY','library-hash-status.json');
    if(file.stat.size>16384){file.stream.destroy();throw new StorageError('Некорректный статус описи');}
    file.stream.setEncoding('utf8');let text='';for await(const part of file.stream)text+=part;
    const status=JSON.parse(text);
    if(!Number.isSafeInteger(status.checked)||!Number.isSafeInteger(status.total)||status.checked<0||status.total<status.checked)throw new StorageError('Некорректный статус описи');
    return {checked:status.checked,total:status.total,bytes:String(status.bytes),totalBytes:String(status.total_bytes),complete:status.complete===true,updatedAt:status.updated_at};
  });
  app.post('/api/v1/files/sync-checksums',async(_request,reply)=>reply.code(202).send(await jobs.syncChecksums()));
  app.get('/api/v1/storage/uploads',async()=>({items:(await pool.query('SELECT * FROM storage_uploads ORDER BY created_at DESC LIMIT 100')).rows}));
  app.post('/api/v1/storage/uploads/recover',async()=> {
    const client=await pool.connect();let interrupted=0;
    try {
      const uploads=(await client.query(`SELECT id FROM storage_uploads WHERE status IN ('receiving','staged','failed')`)).rows;
      for(const row of uploads) {
        const key=`donarium-upload:${row.id}`;
        if(!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked)continue;
        try {await client.query(`UPDATE storage_uploads SET status='interrupted',updated_at=now() WHERE id=$1`,[row.id]);interrupted++;}
        finally {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
      }
      return {interrupted};
    }finally{client.release();}
  });
  app.delete<{Params:{id:string}}>('/api/v1/storage/uploads/:id',{schema:{params}},async request=> {
    const client=await pool.connect(),key=`donarium-upload:${request.params.id}`;
    try {
      if(!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked)throw new StorageError('Загрузка ещё выполняется',409);
      try {
        const row=(await client.query('SELECT * FROM storage_uploads WHERE id=$1',[request.params.id])).rows[0];
        if(!row||!['failed','interrupted'].includes(row.status))throw new StorageError('Удалять можно только прерванную временную загрузку',409);
        await service.discardStage(`.staging/${row.id}`);
        await client.query(`UPDATE storage_uploads SET status='discarded',updated_at=now() WHERE id=$1`,[row.id]);return {discarded:true};
      }finally{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
    }finally{client.release();}
  });
  app.get('/api/v1/storage/operations',async()=>({items:(await pool.query('SELECT * FROM storage_operations ORDER BY created_at DESC LIMIT 30')).rows}));
  app.get<{Params:{id:string}}>('/api/v1/storage/operations/:id',{schema:{params}},async request=> {
    const row=(await pool.query('SELECT * FROM storage_operations WHERE id=$1',[request.params.id])).rows[0];if(!row)throw new StorageError('Операция не найдена',404);return row;
  });
  app.post<{Params:{id:string};Body:{fileId:string}}>('/api/v1/products/:id/files',{schema:{params,body:{type:'object',required:['fileId'],additionalProperties:false,properties:{fileId:uuid}}}},async request=>registry.attach(request.params.id,request.body.fileId));
  app.put<{Params:{id:string;assetId:string};Body:{fileId:string}}>('/api/v1/products/:id/assets/:assetId/file',{
    schema:{params:{type:'object',required:['id','assetId'],additionalProperties:false,properties:{id:uuid,assetId:uuid}},body:{type:'object',required:['fileId'],additionalProperties:false,properties:{fileId:uuid}}}
  },request=>registry.attach(request.params.id,request.body.fileId,request.params.assetId));
  await app.register(async uploads=> {
    uploads.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
    uploads.put<{Querystring:{name:string};Body:Readable}>('/api/v1/files/upload',{bodyLimit:service.maxUploadBytes,schema:{querystring:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:250}}}}},async(request,reply)=>reply.code(201).send(await registry.upload(request.body,request.query.name)));
  });
  app.get<{Querystring:{page:number;status?:string;method?:string;q?:string}}>('/api/v1/storage/matches',{
    schema:{querystring:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,default:1},status:{type:'string',enum:['pending','confirmed','applied','rejected','rolled_back']},method:{type:'string',enum:['exact','stem','normalized','ambiguous','missing','manual']},q:{type:'string',maxLength:300}}}}
  },async request=> {
    const q=request.query;
    const args=[q.status??null,q.method??null,q.q?`%${q.q.toLowerCase().replace(/[\\%_]/g,'\\$&')}%`:null];
    const where=`WHERE ($1::text IS NULL OR m.status=$1) AND ($2::text IS NULL OR m.method=$2) AND ($3::text IS NULL OR lower(p.title||' '||m.source_name) LIKE $3 ESCAPE '\\')`;
    const total=Number((await pool.query(`SELECT count(*) FROM storage_matches m JOIN products p ON p.id=m.product_id ${where}`,args)).rows[0].count);
    const items=(await pool.query(`SELECT m.*,p.title,f.name AS file_name,f.size_bytes::text,f.sha256,f.status AS file_status,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sha256',c.sha256,'size_bytes',c.size_bytes::text,'status',c.status) ORDER BY c.name,c.id)
        FROM jsonb_array_elements_text(m.candidates) AS candidate(id) JOIN storage_files c ON c.id=candidate.id::uuid),'[]') AS candidate_files
      FROM storage_matches m JOIN products p ON p.id=m.product_id LEFT JOIN storage_files f ON f.id=m.file_id ${where} ORDER BY p.title,m.id LIMIT 50 OFFSET $4`,[...args,(q.page-1)*50])).rows;
    return {items,total,page:q.page,pageSize:50};
  });
  app.post<{Body:{root:string}}>('/api/v1/storage/matches/preview',{schema:{body:{type:'object',required:['root'],additionalProperties:false,properties:{root}}}},async(request,reply)=>reply.code(202).send(await matching.preview(request.body.root)));
  app.post<{Params:{id:string};Body:{fileId:string;reject?:boolean}}>('/api/v1/storage/matches/:id/confirm',{schema:{params,body:{type:'object',required:['fileId'],additionalProperties:false,properties:{fileId:uuid,reject:{type:'boolean',default:false}}}}},request=>matching.confirm(request.params.id,request.body.fileId,request.body.reject));
  app.post<{Body:{ids:string[]}}>('/api/v1/storage/matches/apply',{schema:{body:{type:'object',required:['ids'],additionalProperties:false,properties:{ids:{type:'array',minItems:1,maxItems:1000,uniqueItems:true,items:uuid}}}}},async(request,reply)=>reply.code(202).send(await matching.apply(request.body.ids)));
  app.post<{Params:{id:string}}>('/api/v1/storage/matches/:id/rollback',{schema:{params}},request=>matching.rollback(request.params.id));
  return registry;
}
