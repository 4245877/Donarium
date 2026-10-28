import type { FastifyReply, FastifyRequest } from 'fastify';
import { extname } from 'node:path';
import { StorageError, StorageService, fileMetadata } from './service.js';
export function disposition(name:string,inline=false) {
  return `${inline?'inline':'attachment'}; filename="download${extname(name).replace(/[^a-zA-Z0-9.]/g,'')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16)}`)}`;
}
export async function sendPhysical(service:StorageService,key:string,path:string,name:string,request:FastifyRequest,reply:FastifyReply,options:{inline?:boolean;size?:string|null;sha256?:string|null}={}) {
  const file=await service.open(key,path),size=file.stat.size;
  if(options.size!=null&&String(size)!==options.size){await file.handle.close();throw new StorageError('Размер файла изменился; выполните проверку целостности',409);}
  const etag=options.sha256?`"${options.sha256}"`:undefined;
  if(etag)reply.header('ETag',etag);
  reply.header('Accept-Ranges','bytes').header('Cache-Control','private, no-cache').header('Content-Disposition',disposition(name,options.inline));
  const range=request.headers.range;
  let start=0,end=size-1;
  if(range&&(!request.headers['if-range']||request.headers['if-range']===etag)) {
    const parts=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!parts||(!parts[1]&&!parts[2])||size===0){await file.handle.close();return reply.code(416).header('Content-Range',`bytes */${size}`).send();}
    if(!parts[1]) start=Math.max(0,size-Number(parts[2]));else start=Number(parts[1]);
    if(parts[1]&&parts[2])end=Math.min(end,Number(parts[2]));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){await file.handle.close();return reply.code(416).header('Content-Range',`bytes */${size}`).send();}
    reply.code(206).header('Content-Range',`bytes ${start}-${end}/${size}`);
  }
  reply.type(options.inline?fileMetadata(name).mediaType:'application/octet-stream').header('Content-Length',size===0?0:end-start+1);
  if(request.method==='HEAD'||size===0){await file.handle.close();return reply.send(size===0?Buffer.alloc(0):undefined);}
  return reply.send(file.handle.createReadStream({start,end}));
}
