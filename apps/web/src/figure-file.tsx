import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Eye, File, Folder, RefreshCw, Search, Unlink, X } from 'lucide-react';
import type { Asset, FigureFileInfo, FileReference, StorageEntry } from '@donarium/shared';
import { message, request, useApi } from './api';
import { ErrorState, formatSize, Loading } from './components';
import type { Root } from './storage';
import { parseStl } from './stl';

export const figureQuery = (file: FileReference) => new URLSearchParams({ root: file.root, path: file.path }).toString();

function StlPreview({ file }: { file: FileReference }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [geometry, setGeometry] = useState<Float32Array>();
  const [error, setError] = useState('');
  const [angle, setAngle] = useState({ yaw: -0.5, pitch: 0.4, zoom: 1 });
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const query = figureQuery(file);
  useEffect(() => {
    const controller = new AbortController();
    setGeometry(undefined); setError('');
    void fetch(`/api/v1/storage/figure-file/preview?${query}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message || 'Не удалось открыть STL'); }
      const parsed = parseStl(await response.arrayBuffer());
      if (!controller.signal.aborted) setGeometry(parsed);
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [query]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !geometry) return;
    const draw = () => {
      const width = element.clientWidth, height = 320, dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = width * dpr; element.height = height * dpr;
      const ctx = element.getContext('2d'); if (!ctx) return;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
      const cy = Math.cos(angle.yaw), sy = Math.sin(angle.yaw), cx = Math.cos(angle.pitch), sx = Math.sin(angle.pitch);
      const scale = Math.min(width, height) * 0.72 * angle.zoom;
      const faces: { points: number[]; depth: number; light: number }[] = [];
      for (let i = 0; i < geometry.length; i += 9) {
        const points: number[] = [];
        for (let j = 0; j < 9; j += 3) {
          const x = geometry[i + j], y = geometry[i + j + 1], z = geometry[i + j + 2];
          const rx = x * cy + z * sy, rz = -x * sy + z * cy;
          points.push(rx, y * cx - rz * sx, y * sx + rz * cx);
        }
        const ax = points[3] - points[0], ay = points[4] - points[1], az = points[5] - points[2];
        const bx = points[6] - points[0], by = points[7] - points[1], bz = points[8] - points[2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const light = Math.abs((nx * 0.3 + ny * 0.6 + nz * 0.7) / (Math.hypot(nx, ny, nz) || 1));
        faces.push({ points, depth: points[2] + points[5] + points[8], light });
      }
      faces.sort((a, b) => a.depth - b.depth);
      for (const { points, light } of faces) {
        ctx.beginPath();
        for (let j = 0; j < 9; j += 3) {
          const x = width / 2 + points[j] * scale, y = height / 2 - points[j + 1] * scale;
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fillStyle = `hsl(271 28% ${35 + light * 45}%)`; ctx.fill();
      }
    };
    const observer = new ResizeObserver(draw); observer.observe(element); draw();
    return () => observer.disconnect();
  }, [geometry, angle]);
  if (error) return <p className="info-note" role="status">{error}. Можно скачать оригинал для просмотра в 3D-программе.</p>;
  if (!geometry) return <Loading label="Читаем геометрию STL…" />;
  return <div className="stl-preview"><canvas ref={canvas} role="img" aria-label="3D-предпросмотр STL" tabIndex={0}
    onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
    onPointerMove={event => { if (!drag.current) return; const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y; drag.current = { x: event.clientX, y: event.clientY }; setAngle(value => ({ ...value, yaw: value.yaw + dx * 0.01, pitch: value.pitch + dy * 0.01 })); }}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setAngle(value => ({ ...value, yaw: value.yaw + (event.key === 'ArrowLeft' ? -0.1 : event.key === 'ArrowRight' ? 0.1 : 0), pitch: value.pitch + (event.key === 'ArrowUp' ? -0.1 : event.key === 'ArrowDown' ? 0.1 : 0) })); } }} />
    <div className="action-row"><small>Вращайте мышью, касанием или стрелками. Крупные модели показаны с упрощением.</small><button type="button" className="button secondary" aria-label="Уменьшить модель" onClick={() => setAngle(value => ({ ...value, zoom: Math.max(0.3, value.zoom / 1.25) }))}>−</button><button type="button" className="button secondary" aria-label="Увеличить модель" onClick={() => setAngle(value => ({ ...value, zoom: Math.min(3, value.zoom * 1.25) }))}>+</button></div>
  </div>;
}

export function FigureFilePreview({ file, onClose }: { file: FileReference; onClose: () => void }) {
  const info = useApi<FigureFileInfo>(`/api/v1/storage/figure-file?${figureQuery(file)}`);
  return <section className="figure-preview" aria-label="Просмотр файла фигурки"><div className="section-heading"><h3>Просмотр файла фигурки</h3><button type="button" className="icon-button" aria-label="Закрыть просмотр файла" onClick={onClose}><X size={18} /></button></div>
    {info.loading ? <Loading /> : info.error ? <ErrorState message={info.error} retry={info.retry} /> : info.data && <><strong>{info.data.name}</strong><code className="asset-path">{file.root} / {file.path}</code><p>{info.data.format.toUpperCase()} · {formatSize(info.data.sizeBytes)}</p>
      {info.data.format === 'stl' && Number(info.data.sizeBytes) <= 32 * 1024 ** 2 ? <StlPreview file={file} /> : <p className="info-note">{['zip', 'rar', '7z', 'tar', 'gz'].includes(info.data.format) ? 'Это архив моделей. Для просмотра содержимого скачайте его и откройте в архиваторе.' : 'Для просмотра этой модели скачайте её и откройте в подходящей 3D-программе.'}</p>}
      <a className="button secondary" href={`/api/v1/storage/figure-file/download?${figureQuery(file)}`}><Download size={15} />Скачать оригинал</a></>}
  </section>;
}

interface Listing { entries: StorageEntry[]; total: number; pageSize: number; truncated?: boolean; skipped?: number }
export function FigureFilePicker({ initial, onChoose, onClose }: { initial?: FileReference | null; onChoose: (file: FigureFileInfo) => void; onClose: () => void }) {
  const roots = useApi<{ roots: Root[] }>('/api/v1/storage/roots');
  const [root, setRoot] = useState(initial?.root || '');
  const [path, setPath] = useState(initial?.path.split('/').slice(0, -1).join('/') || '');
  const [page, setPage] = useState(1), [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [preview, setPreview] = useState<FileReference>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!root && roots.data?.roots.length) setRoot((roots.data.roots.find(root => !root.writable) || roots.data.roots[0]).key); }, [root, roots.data]);
  useEffect(() => { const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 350); return () => window.clearTimeout(timer); }, [search]);
  const searching = query.length >= 2;
  const browse = useApi<Listing>(root ? `/api/v1/storage/${searching ? 'figure-search' : 'browse'}?${new URLSearchParams({ root, path, ...(searching ? { q: query } : { page: String(page), pageSize: '50', figuresOnly: 'true' }) })}` : null);
  function open(next: string) { setPath(next); setPage(1); setSearch(''); setQuery(''); setPreview(undefined); setError(''); }
  async function choose(entry: StorageEntry) { setBusy(true); setError(''); try { onChoose(await request<FigureFileInfo>(`/api/v1/storage/figure-file?${figureQuery({ root, path: entry.path })}`)); } catch (error) { setError(message(error)); } finally { setBusy(false); } }
  return <section className="file-browser figure-picker" aria-label="Выбор файла фигурки"><div className="section-heading"><h3>Выбор файла фигурки</h3><button type="button" className="icon-button" aria-label="Закрыть выбор файла" onClick={onClose}><X size={18} /></button></div>
    <div className="browser-toolbar"><label className="field">Хранилище моделей<select value={root} disabled={busy || roots.loading} onChange={event => { setRoot(event.target.value); open(''); }}><option value="" disabled>Выберите хранилище</option>{roots.data?.roots.map(root => <option key={root.key} value={root.key}>{root.name}</option>)}</select></label><button type="button" className="button secondary" disabled={!path || busy} onClick={() => open(path.split('/').slice(0, -1).join('/'))}><ArrowLeft size={14} />На уровень выше</button><button type="button" className="icon-button" aria-label="Обновить список моделей" onClick={browse.retry}><RefreshCw size={17} /></button></div>
    <nav className="figure-breadcrumbs" aria-label="Путь к моделям"><button type="button" onClick={() => open('')}>{root || 'Хранилище'}</button>{path.split('/').filter(Boolean).map((part, index, parts) => <button type="button" key={index} onClick={() => open(parts.slice(0, index + 1).join('/'))}>/ {part}</button>)}</nav>
    <label className="field">Поиск моделей в этой папке и вложенных папках<div className="search-field"><Search size={17} /><input type="search" value={search} maxLength={200} placeholder="Имя файла или часть пути…" onChange={event => setSearch(event.target.value)} /></div></label>
    {search.trim().length === 1 && <small className="muted">Для поиска введите хотя бы два символа.</small>}
    {roots.error && <ErrorState message={roots.error} retry={roots.retry} />}{roots.data?.roots.length === 0 && <p>Разрешённые хранилища не настроены.</p>}
    {root && (browse.loading ? <Loading label="Ищем модели…" /> : browse.error ? <ErrorState message={browse.error} retry={browse.retry} /> : <div className="browser-entries">{browse.data?.entries.map(entry => <div className="browser-entry" key={entry.path}>{entry.type === 'directory' ? <button type="button" className="browser-open" onClick={() => open(entry.path)}><Folder size={18} /><span>{entry.name}</span><ChevronRight size={14} /></button> : <><div className="browser-file"><File size={17} /><span>{entry.name}{searching && <code className="asset-path">{entry.path}</code>}</span><small>{formatSize(entry.sizeBytes)}</small></div><button type="button" className="icon-button" aria-label={`Просмотреть ${entry.name}`} onClick={() => setPreview({ root, path: entry.path })}><Eye size={17} /></button><button type="button" className="button secondary" disabled={busy || search.trim() !== query} onClick={() => void choose(entry)}>Выбрать</button></>}</div>)}{!browse.data?.entries.length && <p className="muted">{searching ? 'Модели не найдены.' : 'В этой папке нет моделей или вложенных папок.'}</p>}</div>)}
    {browse.data?.truncated && <p role="status" className="info-note">Показана часть результатов: достигнут лимит поиска. Уточните имя или выберите вложенную папку.</p>}{!!browse.data?.skipped && <p className="info-note">Часть папок или файлов недоступна и пропущена.</p>}
    {!searching && browse.data && browse.data.total > 50 && <div className="pagination"><button type="button" className="button secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} />Назад</button><span>{page} / {Math.ceil(browse.data.total / 50)}</span><button type="button" className="button secondary" disabled={page * 50 >= browse.data.total} onClick={() => setPage(value => value + 1)}>Далее<ChevronRight size={14} /></button></div>}
    {error && <p role="alert" className="inline-error">{error}</p>}{preview && <FigureFilePreview key={figureQuery(preview)} file={preview} onClose={() => setPreview(undefined)} />}
  </section>;
}

export function FigureFileField({ value, onChange, disabled = false }: { value: FileReference | null; onChange: (file: FileReference | null) => void; disabled?: boolean }) {
  const [picker, setPicker] = useState(false), [preview, setPreview] = useState(false);
  const status = useApi<FigureFileInfo>(value ? `/api/v1/storage/figure-file?${figureQuery(value)}` : null);
  return <fieldset className="figure-file-field" disabled={disabled}><legend>Файл фигурки</legend><p className="muted">Выберите существующую модель или архив на сервере. Ссылка сохранится вместе с карточкой.</p>
    {value ? <><strong>{value.path.split('/').pop()}</strong><code className="asset-path">{value.root} / {value.path}</code>{status.loading ? <p role="status">Проверяем доступность…</p> : status.error ? <p role="alert" className="inline-error">{status.error}<button type="button" className="button secondary" onClick={status.retry}>Проверить ещё раз</button></p> : <p role="status" className="success-note">Файл доступен · {formatSize(status.data?.sizeBytes || null)}</p>}</> : <p>Файл не выбран.</p>}
    <div className="action-row"><button type="button" className="button secondary" onClick={() => setPicker(value => !value)}><Folder size={15} />{value ? 'Заменить файл фигурки' : 'Выбрать файл фигурки'}</button>{value && <><button type="button" className="button secondary" onClick={() => setPreview(value => !value)}><Eye size={15} />Просмотреть файл фигурки</button><button type="button" className="button secondary" onClick={() => { onChange(null); setPreview(false); }}><Unlink size={15} />Удалить привязку</button></>}</div>
    {picker && <FigureFilePicker initial={value} onChoose={file => { onChange({ root: file.root, path: file.path }); setPicker(false); setPreview(false); }} onClose={() => setPicker(false)} />}
    {preview && value && <FigureFilePreview key={figureQuery(value)} file={value} onClose={() => setPreview(false)} />}
    <small className="muted">Замена и удаление привязки сохраняют оригиналы на сервере. Отмена редактирования сохранит прежнюю связь.</small>
  </fieldset>;
}

export function FigureFileSummary({ file }: { file?: Asset | null }) {
  const [preview, setPreview] = useState(false);
  if (!file?.storageKey || !file.relativePath) return null;
  const reference = { root: file.storageKey, path: file.relativePath };
  return <section className="figure-file-summary"><h2>Файл фигурки</h2><strong>{file.name}</strong><code className="asset-path">{file.storageKey} / {file.relativePath}</code><div className="action-row"><button type="button" className="button secondary" onClick={() => setPreview(value => !value)}><Eye size={15} />Просмотреть файл фигурки</button></div>{preview && <FigureFilePreview file={reference} onClose={() => setPreview(false)} />}</section>;
}
