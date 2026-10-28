import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, readdir, unlink, readFile, link } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config, StorageGuard } from '../config.js';

export interface StorageRoot { key: string; name: string; path: string; writable?: boolean; internal?: boolean }
export interface StorageSettings {
  storageRoots?: StorageRoot[]; managedRoot?: string; workRoot?: string;
  storageRoot?: string; maxUploadBytes?: number;
  storageGuards?: StorageGuard[]; requireStorageGuards?: boolean;
}
export class StorageError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export function safeRelativePath(value: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > 4096 || (!value && !allowEmpty) || isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.includes('\0') || /[\x00-\x1f\x7f]/.test(value)
    || (value && value.split('/').some(part => !part || part === '.' || part === '..')))
    throw new StorageError('Недопустимый относительный путь');
  return value;
}
export function safeFileName(value: string): string {
  if (!value || value !== basename(value) || value.length > 250) throw new StorageError('Недопустимое имя файла');
  safeRelativePath(value);
  return value;
}
export function fileMetadata(name: string) {
  const extension = extname(name).toLowerCase();
  const imageTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
  const kind = extension in imageTypes ? 'image' : ['.stl', '.3mf', '.obj', '.step', '.stp', '.ply', '.amf', '.glb', '.gltf', '.fbx'].includes(extension) ? 'model'
    : ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(extension) ? 'archive'
      : ['.blend', '.f3d', '.scad', '.max', '.psd'].includes(extension) ? 'source' : 'other';
  return { kind, mediaType: imageTypes[extension] ?? (extension === '.pdf' ? 'application/pdf' : 'application/octet-stream') };
}
export function normalizeFsError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (['ENOENT', 'ENOTDIR'].includes(code ?? '')) return new StorageError('Файл или папка отсутствует', 404);
  if (['EACCES', 'EPERM'].includes(code ?? '')) return new StorageError('Нет доступа к файлу или папке', 403);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new StorageError('Недостаточно свободного места в хранилище', 507);
  if (code === 'EROFS') return new StorageError('Хранилище доступно только для чтения',403);
  if (code === 'ELOOP') return new StorageError('Символические ссылки запрещены', 403);
  return new StorageError('Не удалось выполнить операцию с файловым хранилищем', 500);
}

/** Originals are read only. Managed uploads always receive a new opaque directory. */
export class StorageService {
  readonly roots: StorageRoot[];
  readonly managedRoot: string;
  readonly workRoot: string;
  readonly maxUploadBytes: number;
  readonly guards: StorageGuard[];
  readonly requireGuards: boolean;
  constructor(config: StorageSettings | Config) {
    const settings = config as StorageSettings;
    this.managedRoot = resolve(settings.managedRoot ?? 'data/uploads');
    this.workRoot = resolve(settings.workRoot ?? 'data/work');
    this.maxUploadBytes = settings.maxUploadBytes ?? 20 * 1024 ** 3;
    this.guards = settings.storageGuards ?? [];
    this.requireGuards = !!settings.requireStorageGuards;
    this.roots = [...(settings.storageRoots ?? (settings.storageRoot ? [{ key: 'LIBRARY', name: 'Библиотека', path: settings.storageRoot }] : [])),
      { key: 'DONARIUM_UPLOADS', name: 'Загрузки DONARIUM', path: this.managedRoot, writable: true }];
    const keys = new Set<string>();
    for (const root of this.roots) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(root.key) || keys.has(root.key)) throw new StorageError('Неверный или повторный ключ хранилища');
      root.path = resolve(root.path); keys.add(root.key);
    }
  }
  async init() {
    await this.assertPath(this.managedRoot);
    await this.assertPath(this.workRoot);
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    await this.checkAbsolute(this.managedRoot);
    await this.checkAbsolute(this.workRoot);
  }
  /** Check the kernel mount and an identity marker before any mkdir/open. A directory on
   * the system disk can never substitute for an absent NFS mount in guarded mode. */
  async assertPath(path: string) {
    const guard = this.guards.filter(g => path === g.path || path.startsWith(g.path + '/')).sort((a,b) => b.path.length-a.path.length)[0];
    if (!guard) { if (this.requireGuards) throw new StorageError('Защита диска не настроена; файловые операции заблокированы', 503); return; }
    try {
      const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n,8)));
      const mounts = (await readFile('/proc/self/mountinfo','utf8')).trim().split('\n').map(line => {
        const [before,after] = line.split(' - '); const a=before!.split(' '), b=after!.split(' ');
        return { path:decode(a[4]!), type:b[0], source:decode(b[1]!) };
      }).filter(m => guard.path === m.path || guard.path.startsWith(m.path + '/') || m.path === '/').sort((a,b)=>b.path.length-a.path.length);
      const mount=mounts[0];
      if (!mount || !['nfs','nfs4'].includes(mount.type!) || mount.source !== guard.source) throw new Error('mount');
      await this.checkAbsolute(guard.path);
      const handle=await open(join(guard.path,guard.marker),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try { if (!(await handle.stat()).isFile() || (await handle.stat()).size>512 || (await handle.readFile('utf8')).trim() !== guard.value) throw new Error('identity'); }
      finally { await handle.close(); }
    } catch { throw new StorageError('Нужный сетевой диск недоступен; файловые операции заблокированы',503); }
  }
  listRoots() { return this.roots.filter(root=>!root.internal).map(({ key, name, writable }) => ({ key, name, writable: !!writable })); }
  root(key: string) {
    const root = this.roots.find(item => item.key === key);
    if (!root) throw new StorageError('Хранилище не разрешено', 403);
    return root;
  }
  private async checkAbsolute(path: string) {
    const parts = resolve(path).split(sep).filter(Boolean);
    let current: string = sep;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new StorageError('Символические ссылки запрещены', 403);
    }
  }
  async resolve(key: string, path: string, options: { directory?: boolean } = {}) {
    safeRelativePath(path, !!options.directory);
    const root = this.root(key);
    try {
      await this.assertPath(root.path);
      await this.checkAbsolute(root.path);
      let current = root.path;
      for (const part of path.split('/').filter(Boolean)) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new StorageError('Символические ссылки запрещены', 403);
      }
      const actual = await realpath(current);
      const within = relative(await realpath(root.path), actual);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new StorageError('Путь вне хранилища', 403);
      return actual;
    } catch (error) { throw normalizeFsError(error); }
  }
  /** On Ubuntu each component is opened relative to an already opened directory FD.
   * A directory rename or symlink replacement cannot redirect the next open outside it. */
  async open(key: string, path: string, directory = false): Promise<{ handle: FileHandle; stat: Stats; path: string }> {
    safeRelativePath(path, directory);
    const root = this.root(key);
    let handle: FileHandle | undefined;
    try {
      await this.assertPath(root.path);
      const absoluteParts = root.path.split(sep).filter(Boolean);
      const childParts = path.split('/').filter(Boolean);
      const parts = [...absoluteParts, ...childParts];
      handle = await open(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      for (let i = 0; i < parts.length; i++) {
        const isDirectory = i < parts.length - 1 || directory;
        const nextPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}/${parts[i]}` : join(sep, ...parts.slice(0, i + 1));
        if (process.platform !== 'linux' && (await lstat(nextPath)).isSymbolicLink()) throw new StorageError('Символические ссылки запрещены', 403);
        const next = await open(nextPath, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
        await handle.close(); handle = next;
      }
      const stat = await handle.stat();
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new StorageError('Поддерживаются только обычные файлы и папки', 403);
      return { handle, stat, path: join(root.path, path) };
    } catch (error) { await handle?.close().catch(() => undefined); throw normalizeFsError(error); }
  }
  async readStream(key: string, path: string) {
    const file = await this.open(key, path);
    return { ...file, stream: file.handle.createReadStream() };
  }
  async hash(key: string, path: string, check: () => void = () => undefined) {
    const file = await this.open(key, path);
    const stream = file.handle.createReadStream({autoClose:false});
    const hash = createHash('sha256');
    try {
      for await (const chunk of stream) { check(); hash.update(chunk); }
      const after=await file.handle.stat();
      const current=await this.open(key,path);
      try {
        if(after.size!==file.stat.size || after.mtimeMs!==file.stat.mtimeMs || after.ctimeMs!==file.stat.ctimeMs || current.stat.ino!==file.stat.ino || current.stat.dev!==file.stat.dev || current.stat.mtimeMs!==after.mtimeMs || current.stat.size!==after.size)throw new StorageError('Файл изменился во время проверки',409);
      } finally {await current.handle.close();}
      return hash.digest('hex');
    } finally {stream.destroy();await file.handle.close().catch(()=>undefined);}
  }

  async browse(key: string, path = '', page = 1, pageSize = 100) {
    const directory = await this.open(key, path, true);
    try {
      const entries = await readdir(process.platform === 'linux' ? `/proc/self/fd/${directory.handle.fd}` : directory.path, { withFileTypes: true });
      if (entries.length > 100_000) throw new StorageError('В папке более 100000 элементов; выберите вложенную папку');
      const supported = entries.filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()));
      supported.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const selected = supported.slice((page - 1) * pageSize, page * pageSize);
      const result = [];
      for (const entry of selected) {
        const child = path ? `${path}/${entry.name}` : entry.name;
        let sizeBytes: string | null = null;
        if (entry.isFile()) {
          try { const file = await this.open(key, child); sizeBytes = String(file.stat.size); await file.handle.close(); }
          catch { continue; }
        }
        result.push({ name: entry.name, path: child, type: entry.isDirectory() ? 'directory' : 'file', sizeBytes });
      }
      return { root: key, path, entries: result, page, pageSize, total: supported.length };
    } finally { await directory.handle.close(); }
  }
  async stageUpload(source: Readable, name: string, uploadId = randomUUID()) {
    safeFileName(name);
    await this.init();
    if(!/^[0-9a-f-]{36}$/.test(uploadId))throw new StorageError('Недопустимый идентификатор загрузки');
    const folder = uploadId;
    const parent = await this.open('DONARIUM_UPLOADS', '', true);
    let destination: FileHandle | undefined;
    let staging: string | undefined;
    let stagingDirectory: FileHandle | undefined;
    try {
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}` : this.managedRoot;
      await mkdir(join(anchored, '.staging'), { recursive: true, mode: 0o700 });
      const stageDirectory = await this.open('DONARIUM_UPLOADS', '.staging', true); stagingDirectory=stageDirectory.handle;
      staging = join(process.platform==='linux'?`/proc/self/fd/${stageDirectory.handle.fd}`:stageDirectory.path, folder);
      destination = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      let size = 0;
      const limiter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxUploadBytes) return callback(new StorageError('Файл превышает допустимый размер', 413));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(source, limiter, destination.createWriteStream({ flush: true }));
      destination = undefined;
      return { root: 'DONARIUM_UPLOADS', relativePath: `.staging/${folder}`, name, sizeBytes: String(size), sha256: hash.digest('hex'), ...fileMetadata(name) };
    } catch (error) {
      await destination?.close().catch(() => undefined);
      if (staging) await unlink(staging).catch(() => undefined);
      throw normalizeFsError(error);
    } finally { await stagingDirectory?.close(); await parent.handle.close(); }
  }
  async discardStage(path: string) {
    if (!/^\.staging\/[0-9a-f-]{36}$/.test(path)) throw new StorageError('Недопустимая временная загрузка');
    let folder:Awaited<ReturnType<StorageService['open']>>;
    try {folder=await this.open('DONARIUM_UPLOADS','.staging',true);}
    catch(error) {if(error instanceof StorageError&&error.statusCode===404)return;throw error;}
    try { await unlink(join(process.platform==='linux'?`/proc/self/fd/${folder.handle.fd}`:folder.path,basename(path))).catch(error => { if(error.code!=='ENOENT') throw error; }); }
    finally { await folder.handle.close(); }
  }
  async promoteStage(upload: Awaited<ReturnType<StorageService['stageUpload']>>) {
    const prefix=upload.sha256.slice(0,2), relativePath=`objects/${prefix}/${upload.sha256}`;
    const parent=await this.open('DONARIUM_UPLOADS','',true);
    try {
      const anchored=process.platform==='linux'?`/proc/self/fd/${parent.handle.fd}`:parent.path;
      await mkdir(join(anchored,'objects'),{recursive:true,mode:0o700});
      const objects=await this.open('DONARIUM_UPLOADS','objects',true);
      try { await mkdir(join(process.platform==='linux'?`/proc/self/fd/${objects.handle.fd}`:objects.path,prefix),{recursive:true,mode:0o700}); }
      finally { await objects.handle.close(); }
      const destination=await this.open('DONARIUM_UPLOADS',`objects/${prefix}`,true);
      const stage=await this.open('DONARIUM_UPLOADS','.staging',true);
      try {
        const from=join(process.platform==='linux'?`/proc/self/fd/${stage.handle.fd}`:stage.path,basename(upload.relativePath));
        const to=join(process.platform==='linux'?`/proc/self/fd/${destination.handle.fd}`:destination.path,upload.sha256);
        try { await link(from,to); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
          const existing=await this.open('DONARIUM_UPLOADS',relativePath); const size=String(existing.stat.size); await existing.handle.close();
          if(size!==upload.sizeBytes || await this.hash('DONARIUM_UPLOADS',relativePath)!==upload.sha256) throw new StorageError('Конфликт объекта: существующий файл сохранён для проверки',409);
        }
        await destination.handle.sync();
      } finally { await stage.handle.close(); await destination.handle.close(); }
      await this.discardStage(upload.relativePath);
      return {...upload,relativePath};
    } finally { await parent.handle.close(); }
  }
  async writeUpload(source: Readable,name: string) { return this.promoteStage(await this.stageUpload(source,name)); }
}
