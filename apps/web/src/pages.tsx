import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Box, Check, ChevronLeft, ChevronRight, Circle, Database, ExternalLink, File, FileArchive, Fingerprint, Folder, HardDrive, Layers3, Link2, Search, Server, ShieldCheck, SlidersHorizontal, Tag, X } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { CatalogResponse, HealthResponse, Product, SystemResponse } from '@donarium/shared';
import { externalUrl, useApi } from './api';
import { DemoNotice, ErrorState, formatSize, Loading, ProductCard } from './components';

const date = (value: string) => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const sort = params.get('sort') === 'title' ? 'title' : 'newest';
  const rawPage = Number(params.get('page') || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const [search, setSearch] = useState(q);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setParams(current => {
        if ((current.get('q') || '') === search) return current;
        const next = new URLSearchParams(current);
        if (search) next.set('q', search); else next.delete('q');
        next.delete('page');
        return next;
      }, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, setParams]);
  const query = new URLSearchParams({ q, category, sort, page: String(page), pageSize: '12' });
  const result = useApi<CatalogResponse>(`/api/v1/products?${query}`);
  function change(key: string, value: string) {
    setParams(current => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    });
  }
  const pages = Math.ceil((result.data?.total || 0) / 12);
  return <div className="page catalog-page">
    <div className="page-heading"><div><p className="eyebrow"><span />ЦИФРОВАЯ КОЛЛЕКЦИЯ</p><h1>Каталог моделей <span className="count-pill">{result.data?.total ?? '…'}</span></h1><p className="page-subtitle">Всё, что нужно для вашего следующего проекта.</p></div><div className="read-only-badge"><ShieldCheck size={14} /> Только просмотр</div></div>
    <div className="catalog-toolbar"><form className="search-field" role="search" onSubmit={event => { event.preventDefault(); change('q', search); }}><Search size={19} /><input type="search" aria-label="Поиск моделей" placeholder="Название, SKU или тег…" value={search} onChange={event => setSearch(event.target.value)} maxLength={200} /><span className="search-shortcut">ПОИСК</span></form><label className="sort-field"><SlidersHorizontal size={16} /><span className="sr-only">Сортировка</span><select aria-label="Сортировка" value={sort} onChange={event => change('sort', event.target.value)}><option value="newest">Сначала новые</option><option value="title">По названию</option></select></label></div>
    <div className="category-row"><div className="category-tabs" aria-label="Категории"><button className={!category ? 'category-tab active' : 'category-tab'} onClick={() => change('category', '')}><Layers3 size={14} />Все модели</button>{result.data?.categories.map(item => <button key={item.id} className={category === item.slug ? 'category-tab active' : 'category-tab'} onClick={() => change('category', item.slug)}>{item.name}</button>)}</div>{(q || category) && <button className="reset-button" onClick={() => { setSearch(''); setParams({}); }}><X size={13} />Сбросить</button>}</div>
    {result.loading ? <Loading /> : result.error ? <ErrorState message={result.error} retry={result.retry} /> : result.data && <>
      {result.data.mode === 'demo' && <DemoNotice />}
      {result.data.items.length ? <><div className="catalog-results"><span>{q ? `Результаты для «${q}»` : 'МОДЕЛИ В КОЛЛЕКЦИИ'}</span><span>{(page - 1) * 12 + 1}–{Math.min(page * 12, result.data.total)} из {result.data.total}</span></div><div className="product-grid">{result.data.items.map((item, index) => <ProductCard key={item.id} item={item} index={(page - 1) * 12 + index} demo={result.data?.mode === 'demo'} />)}</div></> : <div className="state-panel empty-state"><span className="empty-icon"><Search size={30} strokeWidth={1.3} /></span><h2>Модели не найдены</h2><p>{q || category ? 'Попробуйте другой запрос или выберите другую категорию.' : 'В библиотеке пока нет моделей.'}</p>{(q || category || page > 1) && <button className="button secondary" onClick={() => { setSearch(''); setParams({}); }}>Показать все модели <ArrowRight size={15} /></button>}</div>}
      {pages > 1 && <nav className="pagination" aria-label="Пагинация каталога"><button className="button secondary" disabled={page <= 1} onClick={() => change('page', String(page - 1))}><ChevronLeft size={15} />Назад</button><span>Страница {page} из {pages}</span><button className="button secondary" disabled={page >= pages} onClick={() => change('page', String(page + 1))}>Далее<ChevronRight size={15} /></button></nav>}
    </>}
    <div className="catalog-footnote"><Circle size={7} fill="currentColor" />Отмечайте интересные модели звездой и собирайте их в личные коллекции.</div>
  </div>;
}

export function ProductPage() {
  const { id } = useParams();
  const result = useApi<{ item: Product; mode: 'demo' | 'postgres' }>(`/api/v1/products/${encodeURIComponent(id || '')}`);
  if (result.loading) return <div className="page"><Loading label="Открываем карточку модели…" /></div>;
  if (result.error || !result.data) return <div className="page"><Link className="back-link" to="/catalog"><ArrowLeft size={15} />В каталог</Link><ErrorState message={result.error || 'Модель не найдена'} retry={result.retry} /></div>;
  const { item, mode } = result.data;
  const source = externalUrl(item.sourceUrl);
  return <div className="page product-page">
    <Link className="back-link" to="/catalog"><ArrowLeft size={15} />В каталог моделей</Link>
    {mode === 'demo' && <DemoNotice />}
    <section className="product-detail"><div className="detail-visual"><span className="art-coordinate">DONARIUM / DIGITAL OBJECT</span>{item.image ? <img src={item.image.url} alt={item.image.alt} /> : <Box size={140} strokeWidth={0.6} />}<span className="detail-art-label">{mode === 'demo' ? 'Демонстрационная иллюстрация' : 'Изображение модели'}</span><span className="detail-cross">+</span></div><div className="detail-copy"><div className="detail-categories">{item.categories.map(category => <Link key={category.id} to={`/catalog?category=${encodeURIComponent(category.slug)}`}>{category.name}</Link>)}</div><h1>{item.title}</h1><span className="sku-tag"><Fingerprint size={14} />{item.sku}</span><p className="detail-description">{item.description}</p><div className="detail-tags">{item.tags.map(tag => <Link key={tag} to={`/catalog?q=${encodeURIComponent(tag)}`}><Tag size={11} />{tag}</Link>)}</div><dl className="detail-facts"><div><dt>Добавлена в библиотеку</dt><dd>{date(item.createdAt)}</dd></div><div><dt>Последнее изменение</dt><dd>{date(item.updatedAt)}</dd></div><div><dt>Идентификатор</dt><dd className="mono uuid-value">{item.id}</dd></div></dl>{source && <a className="button secondary" href={source} target="_blank" rel="noopener noreferrer">Источник модели <ExternalLink size={15} /></a>}</div></section>
    <div className="section-heading file-section-heading"><div><span className="eyebrow">МАТЕРИАЛЫ МОДЕЛИ</span><h2>Связанные файлы <span className="count-pill">{item.assets.length}</span></h2></div><span className="section-description">Файлы хранятся независимо от каталога</span></div>
    {item.assets.length ? <div className="asset-list">{item.assets.map(asset => {
      const url = externalUrl(asset.externalUrl);
      return <article className="asset-row" key={asset.id}><span className="asset-icon">{asset.kind === 'archive' ? <FileArchive size={24} strokeWidth={1.4} /> : asset.kind === 'model' ? <Box size={24} strokeWidth={1.4} /> : <File size={24} strokeWidth={1.4} />}</span><div className="asset-content"><h3>{asset.name}{asset.version && <span className="asset-version">v{asset.version}</span>}</h3><div className="asset-meta"><span>{formatSize(asset.sizeBytes)}</span><span>{asset.mediaType}</span></div>{asset.relativePath && <code className="asset-path">{asset.storageId ? `${asset.storageId} / ` : ''}{asset.relativePath}</code>}{asset.sha256 && <details className="asset-checksum"><summary>Контрольная сумма SHA-256</summary><code>{asset.sha256}</code></details>}</div>{url ? <a className="button secondary asset-action" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Открыть файл</a> : <span className="reference-status"><Link2 size={13} />{mode === 'demo' ? 'Демо-пример' : 'Ссылка не подключена'}</span>}</article>;
    })}</div> : <div className="state-panel"><Folder size={30} /><h3>Связанных файлов пока нет</h3><p>Здесь появятся модели, архивы и исходные материалы.</p></div>}
    <div className="info-note"><Link2 size={18} /><p>{mode === 'demo' ? 'Это пример структуры библиотеки. Демо-файлы не размещены на сервере, скачивание не подключено.' : 'Внешние ссылки открываются на сервере хранения. Относительные пути показаны как ссылки на структуру хранилища; прямое скачивание по ним ещё не подключено.'} Загрузка файлов и предпросмотр 3D-моделей запланированы.</p></div>
  </div>;
}

export function SystemPage() {
  const system = useApi<SystemResponse>('/api/v1/system');
  const health = useApi<HealthResponse>('/health');
  return <div className="page system-page"><div className="page-heading"><div><p className="eyebrow"><span />О ВАШЕМ ПРОСТРАНСТВЕ</p><h1>О системе</h1><p className="page-subtitle">Независимая библиотека. Понятное устройство.</p></div><span className="version-badge">v{system.data?.version || '0.1.0'}</span></div>
    {system.loading ? <Loading label="Получаем информацию о системе…" /> : system.error ? <ErrorState message={system.error} retry={system.retry} /> : system.data && <>
      <section className="system-intro"><span className="system-logo"><Box size={37} strokeWidth={1.1} /></span><div><h2>ECHIDNA</h2><p>Персональная система управления цифровой библиотекой.<br />Модели для 3D-печати, исходные проекты и связанные материалы.</p></div><span className="mode-badge">{system.data.mode === 'demo' ? 'ДЕМО-РЕЖИМ' : 'POSTGRESQL'}</span></section>
      <div className="system-grid"><section className="system-panel"><div className="panel-title"><Server size={18} /><h2>Состояние приложения</h2></div><dl className="system-properties"><div><dt>Backend API</dt><dd className={health.data?.status === 'ok' ? 'healthy-text' : ''}><i className={health.data?.status === 'ok' ? 'status-dot online' : 'status-dot'} />{health.loading ? 'Проверка…' : health.data?.status === 'ok' ? 'Подключён' : 'Недоступен'}</dd></div><div><dt>Версия приложения</dt><dd className="mono">{system.data.version}</dd></div><div><dt>Источник данных</dt><dd>{system.data.mode === 'demo' ? 'Демонстрационный каталог' : 'PostgreSQL'}</dd></div><div><dt>База данных</dt><dd>{!health.data ? 'Нет данных' : health.data.database === 'connected' ? 'Подключена' : health.data.database === 'not-configured' ? 'Не настроена' : 'Недоступна'}</dd></div><div><dt>Доступные операции</dt><dd>Только чтение</dd></div><div><dt>Время работы API</dt><dd>{health.data ? `${Math.floor(health.data.uptime / 60)} мин` : '—'}</dd></div></dl>{health.error && <p className="inline-error" role="alert">{health.error}<button onClick={health.retry}>Повторить</button></p>}</section><section className="system-panel"><div className="panel-title"><HardDrive size={18} /><h2>Хранение и независимость</h2></div><p className="panel-description">{system.data.mode === 'demo' ? 'Демонстрационные метаданные: оригиналы не подключены. Для вашей библиотеки предусмотрены ссылки на отдельный файловый сервер.' : 'Каталог хранится в PostgreSQL. Оригиналы и структура хранилищ управляются отдельно от метаданных.'}</p><div className="storage-principle"><Database size={17} /><div><strong>Метаданные отдельно от файлов</strong><p>Стабильные UUID, категории, теги и файловые связи.</p></div></div><div className="storage-principle"><Link2 size={17} /><div><strong>Оригиналы на вашем сервере</strong><p>Внешние HTTP(S)-ссылки или относительные пути внутри хранилища.</p></div></div><div className="storage-principle"><ShieldCheck size={17} /><div><strong>Самостоятельное приложение</strong><p>Без подключения к производственной базе SKUFnya.</p></div></div></section></div>
      <section className="system-panel feature-panel"><div className="panel-title"><Layers3 size={18} /><h2>Возможности основы</h2></div><div className="feature-columns"><div><h3>Уже доступно</h3>{['Каталог, поиск и карточки моделей', 'Избранное и личные коллекции', 'Настройки темы, плотности и анимаций', 'Импорт и экспорт личного пространства'].map(text => <p className="feature-item" key={text}><Check size={15} />{text}</p>)}</div><div><h3>Следующие этапы</h3>{['Авторизация и управление серверным каталогом', 'Подключение оригиналов и сканирование', 'Синхронизация коллекций между устройствами', 'Предпросмотр 3D и интеграции'].map(text => <p className="feature-item future" key={text}><ArrowRight size={14} />{text}</p>)}</div></div></section>
      {system.data.mode === 'demo' && <DemoNotice />}
    </>}
  </div>;
}

export function NotFoundPage() {
  return <div className="page"><div className="state-panel not-found"><span className="not-found-code">404</span><h1>Эта страница не найдена</h1><p>Проверьте адрес или вернитесь в библиотеку.</p><Link className="button primary" to="/catalog">Открыть каталог <ArrowRight size={16} /></Link></div></div>;
}
