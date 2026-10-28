import type { Pool, PoolClient } from 'pg';
import { FileRegistry, registerFile } from './registry.js';
import { StorageError } from './service.js';

/** PostgreSQL session lock coordinates workers across containers. Each file commits on
 * its own; retrying an interrupted 400 GiB scan does not duplicate registry entries. */
export class StorageJobs {
  private tasks=new Set<Promise<void>>();
  private closing=false;
  constructor(readonly registry:FileRegistry,readonly pool:Pool){}
  async recover() {
    const client=await this.pool.connect();
    try {
      if((await client.query("SELECT pg_try_advisory_lock(hashtext('donarium_storage_worker')) AS locked")).rows[0].locked) {
        try {await client.query(`UPDATE storage_operations SET status='interrupted',error='Процесс прерван; повторите операцию',updated_at=now() WHERE status='running'`);}
        finally {await client.query("SELECT pg_advisory_unlock(hashtext('donarium_storage_worker'))");}
      }
    }finally{client.release();}
  }
  async start(kind:string,parameters:Record<string,unknown>,work:(id:string,client:PoolClient)=>Promise<unknown>) {
    if(this.closing) throw new StorageError('Приложение завершает работу',503);
    const client=await this.pool.connect();
    if(!(await client.query("SELECT pg_try_advisory_lock(hashtext('donarium_storage_worker')) AS locked")).rows[0].locked) { client.release();throw new StorageError('Операция с библиотекой уже выполняется',409); }
    let id:string;
    try {
      await client.query(`UPDATE storage_operations SET status='interrupted',error='Процесс прерван; повторите операцию',updated_at=now() WHERE status='running'`);
      id=(await client.query(`INSERT INTO storage_operations(kind,parameters) VALUES($1,$2) RETURNING id`,[kind,parameters])).rows[0].id;
    } catch(error) { await client.query("SELECT pg_advisory_unlock(hashtext('donarium_storage_worker'))");client.release();throw error; }
    const task=(async()=> {
      try { const result=await work(id,client); await client.query(`UPDATE storage_operations SET status='completed',result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result??{})]); }
      catch(error) { await client.query(`UPDATE storage_operations SET status=$2,error=$3,updated_at=now() WHERE id=$1`,[id,this.closing?'interrupted':'failed',error instanceof StorageError?error.message:'Операция прервана; данные сохранены, повторите проверку']).catch(()=>undefined); }
      finally { await client.query("SELECT pg_advisory_unlock(hashtext('donarium_storage_worker'))").catch(()=>undefined);client.release(); }
    })();this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));return {jobId:id};
  }
  check() { if(this.closing) throw new StorageError('Операция прервана перезапуском',503); }
  async close() {this.closing=true;await Promise.allSettled(this.tasks);}
  async inventory(root:string) {
    this.registry.service.root(root);
    return this.start('inventory',{root},async(id,client)=> {
      const paths:string[]=[];
      const walk=async(path:string,depth=0):Promise<void>=> {
        this.check();if(depth>40||paths.length>200000)throw new StorageError('Превышен лимит сканирования');
        for(let page=1;;page++) {
          const list=await this.registry.service.browse(root,path,page,200);
          for(const entry of list.entries) { if(entry.type==='directory') await walk(entry.path,depth+1);else paths.push(entry.path); }
          if(page*200>=list.total)break;
        }
      };
      await walk(''); await client.query('UPDATE storage_operations SET total=$2 WHERE id=$1',[id,paths.length]);
      let registered=0,corrupt=0;const errors:{path:string;message:string}[]=[];
      for(const path of paths) {
        this.check();
        try {
          const recovered=root==='DONARIUM_UPLOADS'&&/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path)?(await client.query('SELECT id,name FROM storage_uploads WHERE sha256=$1 ORDER BY created_at LIMIT 1',[path.split('/').at(-1)])).rows[0]:undefined;
          const file=await registerFile(client,this.registry.service,root,path,recovered?{name:recovered.name}:{});
          if(recovered)await client.query('UPDATE storage_uploads SET file_id=$2 WHERE id=$1 AND file_id IS NULL',[recovered.id,file.id]);
          // Inventory preserves the checksum baseline; content verification is a separate job.
          const checked={status:file.status};
          if(checked.status==='corrupt')corrupt++;registered++;
        } catch(error) { errors.push({path,message:error instanceof StorageError?error.message:'Ошибка регистрации'}); }
        await client.query('UPDATE storage_operations SET progress=progress+1,result=$2,updated_at=now() WHERE id=$1',[id,{registered,corrupt,errors:errors.slice(-100),current:path}]);
      }
      // Include registered resources which disappeared since a previous inventory.
      const missing=await client.query(`SELECT f.id FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE s.key=$1 AND NOT(f.relative_path=ANY($2::text[]))`,[root,paths]);
      for(const file of missing.rows) await this.registry.verify(file.id,false);
      return {registered,corrupt,errors:errors.slice(0,100),errorCount:errors.length,missing:missing.rowCount};
    });
  }
  syncChecksums() {
    return this.start('sync-checksums',{},async(id,client)=> {
      const opened=await this.registry.service.readStream('INVENTORY','library-sha256.ndjson');
      if(opened.stat.size>100*1024*1024){opened.stream.destroy();throw new StorageError('Слишком большая опись');}
      opened.stream.setEncoding('utf8');let data='';for await(const part of opened.stream)data+=part;
      const latest=new Map<string,any>();
      for(const line of data.split('\n').slice(0,-1)) {const row=JSON.parse(line);if(typeof row.name!=='string'||row.name.includes('/')||!Number.isSafeInteger(row.size)||row.size<0||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.mtime_ns!=='string'||!/^\d{1,20}$/.test(row.mtime_ns)||typeof row.ctime_ns!=='string'||!/^\d{1,20}$/.test(row.ctime_ns))throw new StorageError('Некорректная опись сервера');latest.set(row.name,row);}
      await client.query('UPDATE storage_operations SET total=$2 WHERE id=$1',[id,latest.size]);
      let available=0,conflicts=0;
      for(const row of latest.values()) {
        this.check();const file=await this.registry.service.open('LIBRARY',row.name);const stat=await file.handle.stat({bigint:true});await file.handle.close();
        if(stat.size!==BigInt(row.size)||stat.mtimeNs!==BigInt(row.mtime_ns)||stat.ctimeNs!==BigInt(row.ctime_ns)){conflicts++;continue;}
        const registered=await registerFile(client,this.registry.service,'LIBRARY',row.name,{sha256:row.sha256,sizeBytes:String(row.size)});
        if(registered.status==='available')available++;else conflicts++;
        await client.query('UPDATE storage_operations SET progress=progress+1,result=$2,updated_at=now() WHERE id=$1',[id,{available,conflicts}]);
      }
      return {available,conflicts,source:'SHA-256 computed on the original disk; size, mtime and ctime checked through NFS'};
    });
  }
  verify(root?:string) {
    return this.start('verify',{root},async(id,client)=> {
      const files=(await client.query<{id:string}>(`SELECT f.id FROM storage_files f JOIN storage_locations s ON s.id=f.storage_id WHERE ($1::text IS NULL OR s.key=$1) ORDER BY f.id`,[root??null])).rows;
      await client.query('UPDATE storage_operations SET total=$2 WHERE id=$1',[id,files.length]);
      const counts:Record<string,number>={};
      for(const file of files) { this.check();const checked=await this.registry.verify(file.id,true,()=>this.check());counts[checked.status]=(counts[checked.status]??0)+1;await client.query('UPDATE storage_operations SET progress=progress+1,result=$2,updated_at=now() WHERE id=$1',[id,counts]); }
      return counts;
    });
  }
}
