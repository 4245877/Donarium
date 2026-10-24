import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Download, FolderHeart, Heart, Library, Moon, Pencil, Plus, Search, Settings2, ShieldCheck, Sparkles, Sun, Trash2, Upload, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CatalogResponse, DataMode, ProductSummary } from '@donarium/shared';
import { useApi } from './api';
import { ErrorState, Loading, ProductCard } from './components';
import { useWorkspace } from './workspace';
import type { WorkspaceCollection, WorkspaceSettings } from './workspace';

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const heading = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
    (focusable().find(element => element.matches('input, textarea')) || focusable()[0] || dialog.current)?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = scroll;
      document.removeEventListener('keydown', handleKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="w-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="w-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1} ref={dialog}>
      <div className="w-dialog-heading"><h2 id={heading}>{title}</h2><button type="button" className="w-icon-button" onClick={onClose} aria-label="Закрыть окно"><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}

function SavedProduct({ id, index, remove, removeLabel }: { id: string; index: number; remove: () => void; removeLabel: string }) {
  const result = useApi<{ item: ProductSummary; mode: DataMode }>(`/api/v1/products/${encodeURIComponent(id)}`);
  return <article className="w-saved-product">
    {result.loading ? <Loading label="Открываем модель…" /> : result.error || !result.data ? <div className="w-card"><h3>Модель недоступна</h3><p className="w-muted">{result.error || 'Модель не найдена в каталоге.'}</p><button type="button" className="w-button secondary" onClick={result.retry}>Попробовать снова</button></div> : <ProductCard item={result.data.item} index={index} demo={result.data.mode === 'demo'} />}
    <button type="button" className="w-button secondary w-remove-saved" onClick={remove}><Heart size={15} aria-hidden="true" />{removeLabel}</button>
  </article>;
}

export function FavoritesPage() {
  const { favorites, toggleFavorite } = useWorkspace();
  return <div className="page w-page">
    <div className="w-heading"><div><p className="eyebrow"><Heart size={13} /> ТО, ЧТО ДОРОГО</p><h1>Избранное <span className="count-pill">{favorites.length}</span></h1><p className="page-subtitle">Некоторые открытия хочется оставить поближе.</p></div><Link className="w-button secondary" to="/catalog">В каталог <ArrowRight size={16} /></Link></div>
    {favorites.length ? <div className="product-grid w-grid">{favorites.map((id, index) => <SavedProduct key={id} id={id} index={index} remove={() => toggleFavorite(id)} removeLabel="Убрать из избранного" />)}</div> : <div className="w-empty"><span className="w-empty-icon"><Heart size={34} strokeWidth={1.2} /></span><h2>Здесь будут ваши находки</h2><p>Отмечайте модели звездой в каталоге. Я сохраню их для следующего чаепития.</p><Link to="/catalog" className="w-button">Найти вдохновение <ArrowRight size={16} /></Link></div>}
    <p className="w-local-note"><ShieldCheck size={14} /> Избранное хранится в этом браузере. Резервную копию можно скачать в настройках.</p>
  </div>;
}

function CollectionPicker({ collection }: { collection: WorkspaceCollection }) {
  const { toggleCollectionProduct } = useWorkspace();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ q: query, page: String(page), pageSize: '12', sort: 'title' });
  const result = useApi<CatalogResponse>(`/api/v1/products?${params}`);
  const pages = Math.ceil((result.data?.total || 0) / 12);
  return <>
    <p className="w-muted">Выберите модели для коллекции. Каждое изменение сохраняется сразу.</p>
    <label className="w-field"><span>Поиск в каталоге</span><span className="w-search"><Search size={17} /><input type="search" placeholder="Название, SKU или тег…" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></span></label>
    {result.loading ? <Loading label="Читаем каталог…" /> : result.error ? <ErrorState message={result.error} retry={result.retry} /> : result.data && <>
      <div className="w-list w-collection-products">{result.data.items.length ? result.data.items.map(item => {
        const selected = collection.productIds.includes(item.id);
        return <button type="button" className={`w-product-option${selected ? ' selected' : ''}`} key={item.id} aria-pressed={selected} onClick={() => toggleCollectionProduct(collection.id, item.id)}>
          {item.image ? <img src={item.image.url} alt="" loading="lazy" /> : <Library size={24} />}
          <span><strong>{item.title}</strong><small>{item.sku} · {item.categories[0]?.name || 'Без категории'}</small></span><span className="w-option-check">{selected ? <Check size={18} /> : <Plus size={18} />}</span>
        </button>;
      }) : <p className="w-muted">По этому запросу ничего не найдено.</p>}</div>
      {pages > 1 && <nav className="w-actions w-pagination" aria-label="Страницы моделей"><button type="button" className="w-button secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />Назад</button><span>{page} / {pages}</span><button type="button" className="w-button secondary" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Далее<ChevronRight size={16} /></button></nav>}
    </>}
    <p className="w-muted">В коллекции: {collection.productIds.length}</p>
  </>;
}

export function CollectionsPage() {
  const { collections, addCollection, updateCollection, deleteCollection, toggleCollectionProduct } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1');
  const [selectedId, setSelectedId] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const [editId, setEditId] = useState<string>();
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [expandedId, setExpandedId] = useState<string>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const selected = collections.find(item => item.id === selectedId);
  const deleting = collections.find(item => item.id === deleteId);
  const editing = collections.find(item => item.id === editId);
  useEffect(() => { if (params.get('new') === '1') setCreateOpen(true); }, [params]);
  function closeCreate() {
    setCreateOpen(false);
    if (params.has('new')) setParams(current => { const next = new URLSearchParams(current); next.delete('new'); return next; }, { replace: true });
  }
  return <div className="page w-page">
    <div className="w-heading"><div><p className="eyebrow"><FolderHeart size={13} /> ПОРЯДОК В МАЛЕНЬКИХ МИРАХ</p><h1>Коллекции <span className="count-pill">{collections.length}</span></h1><p className="page-subtitle">Соединяйте находки общей идеей, настроением или замыслом.</p></div><button type="button" className="w-button" onClick={() => setCreateOpen(true)}><Plus size={16} />Создать коллекцию</button></div>
    {collections.length ? <div className="w-grid w-collections-grid">{collections.map(collection => <section key={collection.id} className="w-card w-collection-card"><div className="w-collection-top"><span className="w-collection-icon"><FolderHeart size={25} strokeWidth={1.3} /></span><span className="w-chip">{collection.productIds.length} моделей</span></div><h2>{collection.name}</h2><p className="w-muted">{collection.description || 'У каждой коллекции есть история. Эта только начинается.'}</p><small className="w-muted">Создана {new Date(collection.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' })}</small><div className="w-actions"><button type="button" className="w-button secondary" onClick={() => setSelectedId(collection.id)}><Plus size={15} />Модели</button><button type="button" className="w-button secondary" aria-expanded={expandedId === collection.id} onClick={() => setExpandedId(expandedId === collection.id ? undefined : collection.id)}>Открыть <ArrowRight size={15} /></button><button type="button" className="w-icon-button" onClick={() => { setEditId(collection.id); setEditName(collection.name); setEditDescription(collection.description); }} aria-label={`Изменить коллекцию «${collection.name}»`}><Pencil size={16} /></button><button type="button" className="w-icon-button w-danger" onClick={() => setDeleteId(collection.id)} aria-label={`Удалить коллекцию «${collection.name}»`}><Trash2 size={17} /></button></div>{expandedId === collection.id && <div className="w-collection-preview">{collection.productIds.length ? <div className="product-grid w-grid">{collection.productIds.map((id, index) => <SavedProduct key={id} id={id} index={index} remove={() => toggleCollectionProduct(collection.id, id)} removeLabel="Убрать из коллекции" />)}</div> : <p className="w-muted">Коллекция пока пуста. Нажмите «Модели», чтобы добавить первую находку.</p>}</div>}</section>)}</div> : <div className="w-empty"><span className="w-empty-icon"><FolderHeart size={36} strokeWidth={1.2} /></span><h2>Дайте идеям своё место</h2><p>Создайте первую коллекцию: для нового проекта, любимой эстетики или неожиданных открытий.</p><button type="button" className="w-button" onClick={() => setCreateOpen(true)}><Plus size={16} />Первая коллекция</button></div>}
    <p className="w-local-note"><ShieldCheck size={14} /> Коллекции хранятся в этом браузере и ссылаются на модели каталога.</p>
    {createOpen && <Modal title="Новая коллекция" onClose={closeCreate}><form onSubmit={event => { event.preventDefault(); const id = addCollection(name, description); if (id) { setName(''); setDescription(''); closeCreate(); setSelectedId(id); } }}><label className="w-field"><span>Название</span><input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Например, Лунная мастерская" /></label><label className="w-field"><span>Описание <small>необязательно</small></span><textarea maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="Какая идея объединяет эти модели?" /></label><div className="w-actions"><button type="button" className="w-button secondary" onClick={closeCreate}>Отмена</button><button type="submit" className="w-button" disabled={!name.trim()}><Plus size={15} />Создать коллекцию</button></div></form></Modal>}
    {selected && <Modal title={`Модели · ${selected.name}`} onClose={() => setSelectedId(undefined)}><CollectionPicker collection={selected} /><div className="w-actions"><button type="button" className="w-button" onClick={() => setSelectedId(undefined)}><Check size={16} />Готово</button></div></Modal>}
    {editing && <Modal title="Изменить коллекцию" onClose={() => setEditId(undefined)}><form onSubmit={event => { event.preventDefault(); if (updateCollection(editing.id, editName, editDescription)) setEditId(undefined); }}><label className="w-field"><span>Название</span><input required maxLength={80} value={editName} onChange={event => setEditName(event.target.value)} /></label><label className="w-field"><span>Описание <small>необязательно</small></span><textarea maxLength={500} rows={3} value={editDescription} onChange={event => setEditDescription(event.target.value)} /></label><div className="w-actions"><button type="button" className="w-button secondary" onClick={() => setEditId(undefined)}>Отмена</button><button type="submit" className="w-button" disabled={!editName.trim()}><Check size={16} />Сохранить</button></div></form></Modal>}
    {deleting && <Modal title="Удалить коллекцию?" onClose={() => setDeleteId(undefined)}><p>Коллекция «{deleting.name}» будет удалена из этого браузера. Модели в каталоге сохранятся.</p><div className="w-actions"><button type="button" className="w-button secondary" onClick={() => setDeleteId(undefined)}>Оставить</button><button type="button" className="w-button w-danger" onClick={() => { deleteCollection(deleting.id); setDeleteId(undefined); }}><Trash2 size={16} />Удалить</button></div></Modal>}
  </div>;
}

export function SettingsPage() {
  const { settings, updateSettings, exportWorkspace, importWorkspace } = useWorkspace();
  const [draft, setDraft] = useState<WorkspaceSettings>(settings);
  const [file, setFile] = useState<File>();
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(settings), [settings]);
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  return <div className="page w-page">
    <div className="w-heading"><div><p className="eyebrow"><Settings2 size={13} /> ВАШИ МАЛЕНЬКИЕ ПРИВЫЧКИ</p><h1>Настройки пространства</h1><p className="page-subtitle">Пусть здесь всё будет именно так, как вам нравится.</p></div><span className="w-chip"><ShieldCheck size={13} />Локальный профиль</span></div>
    <div className="w-settings-grid">
      <form className="w-card" onSubmit={event => { event.preventDefault(); updateSettings(draft); }}><h2 className="w-section-title"><Sparkles size={19} />Личный кабинет</h2><p className="w-muted">Как мне обращаться к вам за чашкой чая?</p><label className="w-field"><span>Ваше имя</span><input required maxLength={80} value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} autoComplete="nickname" /></label><fieldset className="w-theme-field"><legend>Оформление</legend><div className="w-actions"><label className={`w-theme-option${draft.theme === 'light' ? ' selected' : ''}`}><input type="radio" name="theme" value="light" checked={draft.theme === 'light'} onChange={() => setDraft(value => ({ ...value, theme: 'light' }))} /><Sun size={19} /><span>Белый чай</span></label><label className={`w-theme-option${draft.theme === 'dark' ? ' selected' : ''}`}><input type="radio" name="theme" value="dark" checked={draft.theme === 'dark'} onChange={() => setDraft(value => ({ ...value, theme: 'dark' }))} /><Moon size={19} /><span>Лунная ночь</span></label></div></fieldset><label className="w-toggle"><span><strong>Атмосферные анимации</strong><small>Плавные появления и тихое движение деталей</small></span><input type="checkbox" checked={draft.animations} onChange={event => setDraft(value => ({ ...value, animations: event.target.checked }))} /></label><label className="w-toggle"><span><strong>Компактный интерфейс</strong><small>Меньше отступов, больше места для коллекции</small></span><input type="checkbox" checked={draft.compact} onChange={event => setDraft(value => ({ ...value, compact: event.target.checked }))} /></label><div className="w-actions"><button type="submit" className="w-button" disabled={!changed || !draft.name.trim()}><Check size={16} />Сохранить настройки</button>{changed && <button type="button" className="w-button secondary" onClick={() => setDraft(settings)}>Отменить изменения</button>}</div></form>
      <section className="w-card"><h2 className="w-section-title"><ShieldCheck size={19} />Ваше пространство — с вами</h2><p className="w-muted">Имя, избранное, коллекции и настройки сохраняются только в этом браузере. Они не передаются на сервер и не синхронизируются между устройствами.</p><div className="w-backup-note"><p>Скачайте резервную копию перед очисткой данных браузера. JSON-файл позволит перенести пространство на другое устройство.</p></div><div className="w-actions"><button type="button" className="w-button secondary" onClick={exportWorkspace}><Download size={16} />Скачать копию</button><button type="button" className="w-button secondary" onClick={() => input.current?.click()}><Upload size={16} />Восстановить из файла</button></div><input ref={input} className="w-file-input sr-only" tabIndex={-1} type="file" accept=".json,application/json" aria-label="Файл резервной копии" onChange={event => { setFile(event.target.files?.[0]); event.target.value = ''; }} /><p className="w-muted"><small>Поддерживается JSON-копия Echidna, версия 1, до 2 МБ. Оригиналы моделей в резервную копию не входят.</small></p><Link to="/system" className="text-link">Об устройстве библиотеки <ArrowRight size={15} /></Link></section>
    </div>
    {file && <Modal title="Восстановить пространство?" onClose={() => { if (!importing) setFile(undefined); }}><p>Данные из файла «{file.name}» заменят текущее избранное, коллекции и настройки в этом браузере.</p><p className="w-muted">Перед восстановлением можно скачать копию текущего пространства.</p><div className="w-actions"><button type="button" className="w-button secondary" onClick={exportWorkspace}><Download size={15} />Скачать текущую копию</button><button type="button" className="w-button secondary" disabled={importing} onClick={() => setFile(undefined)}>Отмена</button><button type="button" className="w-button" disabled={importing} onClick={async () => { setImporting(true); const success = await importWorkspace(file); setImporting(false); if (success) setFile(undefined); }}><Upload size={15} />{importing ? 'Проверяем файл…' : 'Восстановить'}</button></div></Modal>}
  </div>;
}
