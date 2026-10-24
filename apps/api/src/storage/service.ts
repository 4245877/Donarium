import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';

export interface StorageRoot { key: string; name: string; path: string; writable?: boolean }
export interface StorageSettings {
  storageRoots?: StorageRoot[]; managedRoot?: string; workRoot?: string;
  storageRoot?: string; maxUploadBytes?: number;
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
  if (code === 'ELOOP') return new StorageError('Символические ссылки запрещены', 403);
  return new StorageError('Не удалось прочитать файловое хранилище', 500);
}

/** Originals are read only. Managed uploads always receive a new opaque directory. */
export class StorageService {
  readonly roots: StorageRoot[];
  readonly managedRoot: string;
  readonly workRoot: string;
  readonly maxUploadBytes: number;
  constructor(config: StorageSettings | Config) {
    const settings = config as StorageSettings;
    this.managedRoot = resolve(settings.managedRoot ?? 'data/uploads');
    this.workRoot = resolve(settings.workRoot ?? 'data/work');
    this.maxUploadBytes = settings.maxUploadBytes ?? 20 * 1024 ** 3;
    this.roots = [...(settings.storageRoots ?? (settings.storageRoot ? [{ key: 'LIBRARY', name: 'Библиотека', path: settings.storageRoot }] : [])),
      { key: 'DONARIUM_UPLOADS', name: 'Загрузки DONARIUM', path: this.managedRoot, writable: true }];
    const keys = new Set<string>();
    for (const root of this.roots) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(root.key) || keys.has(root.key)) throw new StorageError('Неверный или повторный ключ хранилища');
      root.path = resolve(root.path); keys.add(root.key);
    }
  }
  async init() {
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    await this.checkAbsolute(this.managedRoot);
    await this.checkAbsolute(this.workRoot);
  }
  listRoots() { return this.roots.map(({ key, name, writable }) => ({ key, name, writable: !!writable })); }
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
    const { stream } = await this.readStream(key, path);
    const hash = createHash('sha256');
    for await (const chunk of stream) { check(); hash.update(chunk); }
    return hash.digest('hex');
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
  async writeUpload(source: Readable, name: string) {
    safeFileName(name);
    await this.init();
    const folder = randomUUID();
    const parent = await this.open('DONARIUM_UPLOADS', '', true);
    let destination: FileHandle | undefined;
    let staging: string | undefined;
    try {
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}` : this.managedRoot;
      await mkdir(join(anchored, folder), { mode: 0o700 });
      staging = join(anchored, folder, name);
      destination = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      let size = 0;
      const limiter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxUploadBytes) return callback(new StorageError('Файл превышает допустимый размер', 413));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(source, limiter, destination.createWriteStream());
      destination = undefined;
      return { root: 'DONARIUM_UPLOADS', relativePath: `${folder}/${name}`, name, sizeBytes: String(size), sha256: hash.digest('hex'), ...fileMetadata(name) };
    } catch (error) {
      await destination?.close().catch(() => undefined);
      if (staging) await unlink(staging).catch(() => undefined);
      throw error;
    } finally { await parent.handle.close(); }
  }
}
