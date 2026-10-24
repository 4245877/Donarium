/** Temporary browser QA instance: own PostgreSQL schema and files, never the working catalogue. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { buildApp } from '../apps/api/src/app.js';

const envFile = process.env.DONARIUM_TEST_ENV_FILE;
const settings = envFile ? JSON.parse(await readFile(envFile, 'utf8')) as Record<string,string> : {};
const databaseUrl = process.env.TEST_DATABASE_URL || settings.TEST_DATABASE_URL;
if (!databaseUrl || !/^donarium_test(?:_[a-z0-9]+)*$/.test(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)))) throw new Error('TEST_DATABASE_URL must name an isolated donarium_test database');
const password = process.env.E2E_PASSWORD;
if (!password || password.length < 12) throw new Error('Set a test-only E2E_PASSWORD of at least 12 characters');
const port = Number(process.env.BROWSER_TEST_PORT || 4196);
const schema = `browser_${randomUUID().replaceAll('-','')}`;
const directory = await mkdtemp(join(tmpdir(),'donarium-browser-'));
const admin = new pg.Pool({connectionString:databaseUrl,max:1});
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({connectionString:databaseUrl,max:5,options:`-c search_path=${schema},public`});
let closing=false;
try {
 for(const filename of (await readdir('db/migrations')).filter(name=>name.endsWith('.sql')).sort()) await pool.query(await readFile(join('db/migrations',filename),'utf8'));
 const external=join(directory,'external'); await mkdir(join(external,'Example Model'),{recursive:true});
 await writeFile(join(external,'Example Model','part.stl'),'solid browser_fixture\nendsolid browser_fixture\n');
 await writeFile(join(external,'Example Model','cover.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
 const app=await buildApp({pool,logger:false,config:{host:'127.0.0.1',port,dataMode:'postgres',databaseUrl,adminPassword:password,logLevel:'silent',staticDir:resolve('apps/web/dist'),managedRoot:join(directory,'uploads'),workRoot:join(directory,'work'),storageRoots:[{key:'FIXTURES',name:'Browser fixtures',path:external}],maxUploadBytes:32*1024*1024,maxArchiveBytes:128*1024*1024}});
 const close=async()=>{if(closing)return;closing=true;await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});process.exit(0);};
 process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
 await app.listen({host:'127.0.0.1',port});console.log(`Isolated browser QA ready at http://127.0.0.1:${port}`);
}catch(error){await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});throw error;}
