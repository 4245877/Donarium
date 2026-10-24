import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Coffee, FolderHeart, Layers3, Plus, Sparkles, Star, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CatalogResponse } from '@donarium/shared';
import { useApi } from './api';
import { ErrorState, Loading } from './components';
import { Butterfly } from './App';
import { useWorkspace } from './workspace';

const formatDate = (value: string) => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Kyiv' });

export function Dashboard({ openTea }: { openTea: () => void }) {
  const catalog = useApi<CatalogResponse>('/api/v1/products?pageSize=100&sort=newest');
  const { favorites, collections, toggleFavorite, settings, exportWorkspace } = useWorkspace();
  const [view, setView] = useState<'models' | 'files'>('models');
  const items = catalog.data?.items || [];
  const groups = (catalog.data?.categories || []).map(c => ({ ...c, count: items.filter(p => p.categories.some(cat => cat.id === c.id)).length }));
  const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'Europe/Kyiv' });
  const knownFiles = items.reduce((sum, item) => sum + item.assetCount, 0);
  return <div className="page dashboard-page">
    <div className="page-heading"><div><p className="eyebrow"><span />ВАШЕ ЛИЧНОЕ СВЯТИЛИЩЕ</p><h1>Обзор библиотеки <span className="heading-spark">✧</span></h1><p className="page-subtitle">Любопытство — начало каждого открытия.</p></div><div className="heading-actions"><span className="date-label"><CalendarDays size={15} />{date}</span><Link to="/collections?new=1" className="button primary"><Plus size={16} />Создать коллекцию</Link></div></div>
    <div className="dashboard-columns"><div className="dashboard-primary">
      <section className="echidna-hero" aria-labelledby="hero-title">
        <img
          className="hero-portrait"
          src="/images/echidna-banner.webp"
          srcSet="/images/echidna-banner-800.webp 800w, /images/echidna-banner-1280.webp 1280w, /images/echidna-banner.webp 1983w"
          sizes="(max-width: 660px) calc(100vw - 38px), (max-width: 1050px) calc(100vw - 250px), calc(100vw - 560px)"
          width={1983}
          height={793}
          alt="Эхидна с белыми волосами и чёрной бабочкой-заколкой среди белых цветов на фоне надписи Donarium"
          fetchPriority="high"
        />
        <div className="hero-content">
          <div className="hero-intro">
            <span className="hero-kicker"><span /> ПРИГЛАШЕНИЕ К ОТКРЫТИЯМ</span>
            <h2 id="hero-title">Немного чая.<br /><em>Бесконечность знаний.</em></h2>
          </div>
          <div className="hero-welcome">
            <p>Рада видеть тебя, {settings.name}.<br />Какую тайну мы раскроем сегодня?</p>
            <Link className="button hero-button" to="/catalog">Открыть каталог <ArrowRight size={16} /></Link>
          </div>
          <div className="hero-footer">
            <span className="hero-signature">Echidna <span>— Ведьма Жадности</span></span>
            <span className="hero-caption">TEA, CURIOSITY & A LITTLE MAGIC</span>
          </div>
        </div>
      </section>
      <div className="dashboard-stats">
        <Link to="/catalog" className="metric-card"><div className="metric-top"><span>Моделей в архиве</span><BookOpen size={17} /></div><strong>{catalog.data?.total ?? '—'}<ArrowUpRight size={18} /></strong><span className="metric-bottom"><span className="mini-dot" />{catalog.data?.mode === 'demo' ? 'Демонстрационный каталог' : 'В вашей библиотеке'}</span></Link>
        <Link to="/collections" className="metric-card"><div className="metric-top"><span>Мои коллекции</span><FolderHeart size={17} /></div><strong>{collections.length}<span className="metric-mini">коллекций</span></strong><span className="metric-bottom">У каждого знания своё место</span></Link>
        <Link to="/favorites" className="metric-card"><div className="metric-top"><span>Избранное</span><Star size={17} /></div><strong>{favorites.length}<span className="metric-mini">сокровищ</span></strong><span className="metric-bottom">Особенно ценные открытия</span></Link>
        <Link to="/catalog" className="metric-card"><div className="metric-top"><span>Категории</span><Layers3 size={17} /></div><strong>{catalog.data?.categories.length ?? '—'}<span className="metric-mini">направления</span></strong><span className="metric-bottom">{knownFiles} связанных файлов</span></Link>
      </div>
      <div className="insight-grid"><section className="panel archive-chart"><div className="panel-heading"><div><h2>Портрет твоего архива</h2><p>Каждое знание — часть чего-то большего</p></div><button className="small-select" onClick={() => setView(view === 'models' ? 'files' : 'models')}>{view === 'models' ? 'Модели' : 'Файлы'}<ChevronDownIcon /></button></div>{catalog.loading ? <Loading label="Изучаем архив…" /> : catalog.error ? <ErrorState message={catalog.error} retry={catalog.retry} /> : <><div className="chart-summary"><strong>{view === 'models' ? items.length : knownFiles}</strong><span>{view === 'models' ? 'моделей в трёх измерениях' : 'связанных материалов'}</span><span className="chart-summary-icon"><Sparkles size={15} />Пространство идей</span></div><div className="bar-chart"><div className="chart-axis"><span>100%</span><span>50%</span><span>0</span></div><div className="chart-bars">{groups.map((group, index) => { const count = view === 'models' ? group.count : items.filter(p => p.categories.some(c => c.id === group.id)).reduce((a, p) => a + p.assetCount, 0); return <Link className="chart-bar-group" key={group.id} to={`/catalog?category=${group.slug}`} aria-label={`${group.name}: ${count}`}><div className="bar-track"><div className={`chart-bar bar-color-${index % 3} bar-height-${Math.max(0, Math.min(10, Math.round(count / Math.max(1, view === 'models' ? items.length : knownFiles) * 10)))}`}><span>{count}</span></div></div><span className="chart-bar-label">{group.name}</span></Link>; })}</div></div><div className="chart-footnote"><i />{catalog.data && catalog.data.total > items.length ? `По последним ${items.length} моделям` : 'По данным текущего каталога'}<Link to="/catalog">Все категории <ArrowUpRight size={12} /></Link></div></>}</section><section className="panel discovery-panel"><div className="panel-heading"><div><h2>Маленькие открытия</h2><p>Твоё пространство возможностей</p></div><span className="panel-spark">✧</span></div><Link to="/catalog?category=decor" className="discovery-item"><span className="discovery-icon sage"><Layers3 size={18} /></span><span><strong>Найти вдохновение</strong><small>Исследуй предметы и формы</small></span><ArrowUpRight size={15} /></Link><Link to="/collections?new=1" className="discovery-item"><span className="discovery-icon lilac"><FolderHeart size={18} /></span><span><strong>Собрать коллекцию</strong><small>Объедини близкие по духу идеи</small></span><ArrowUpRight size={15} /></Link><button className="discovery-item" onClick={exportWorkspace}><span className="discovery-icon sand"><ArrowDownToLine size={18} /></span><span><strong>Сохранить своё пространство</strong><small>Экспорт личных коллекций в JSON</small></span><ArrowUpRight size={15} /></button><div className="discovery-note"><Butterfly /><span>Знаний никогда не бывает слишком много.</span></div></section></div>
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>Последние поступления <span className="section-count">{catalog.data?.total ?? '…'}</span></h2><p>Новые поводы для твоего любопытства</p></div><Link className="text-link" to="/catalog">Весь каталог <ArrowRight size={14} /></Link></div>{catalog.loading ? <Loading /> : catalog.error ? <ErrorState message={catalog.error} retry={catalog.retry} /> : <div className="table-scroll"><table className="archive-table"><thead><tr><th>НАЗВАНИЕ МОДЕЛИ</th><th>КАТЕГОРИЯ</th><th>ДОБАВЛЕНО</th><th><Star size={13} /><span className="sr-only">Избранное</span></th><th><span className="sr-only">Открыть модель</span></th></tr></thead><tbody>{items.slice(0, 4).map((item, index) => <tr key={item.id}><td><Link className="table-model" to={`/catalog/${item.id}`}><span className={`table-thumbnail art-tone-${index % 3}`}>{item.image ? <img src={item.image.url} alt="" /> : <BookOpen size={20} />}</span><span><strong>{item.title}</strong><small>{item.sku} <span>·</span> {item.assetCount} файл</small></span></Link></td><td><span className={`table-category category-${index % 3}`}>{item.categories[0]?.name || 'Без категории'}</span></td><td className="table-date">{formatDate(item.createdAt)}</td><td><button className={`favorite-button ${favorites.includes(item.id) ? 'is-favorite' : ''}`} onClick={() => toggleFavorite(item.id)} aria-label={`${favorites.includes(item.id) ? 'Убрать из избранного' : 'В избранное'}: ${item.title}`} aria-pressed={favorites.includes(item.id)}><Star size={16} /></button></td><td><Link to={`/catalog/${item.id}`} className="table-open" aria-label={`Открыть: ${item.title}`}><ArrowUpRight size={16} /></Link></td></tr>)}</tbody></table>{items.length === 0 && <p className="w-empty">В архиве пока нет моделей. Новые поступления появятся здесь.</p>}</div>}<div className="table-footer"><span><span className="mini-dot" />{catalog.data?.mode === 'demo' ? 'Демонстрационные модели · оригиналы не подключены' : 'Ваш каталог · личные коллекции хранятся в браузере'}</span><span>Показано {Math.min(4, items.length)} из {catalog.data?.total ?? 0}</span></div></section>
    </div><aside className="dashboard-aside"><Calendar /><section className="tea-card"><div className="tea-card-top"><span>ПРИГЛАШЕНИЕ НА ЧАЙ</span><span>✧</span></div><div className="tea-illustration"><span className="tea-orbit" /><Coffee size={56} strokeWidth={0.8} /><span className="tea-star star-one">✧</span><span className="tea-star star-two">✧</span></div><blockquote>«Мне просто хочется знать.<br /><em>Всё, что есть в этом мире.»</em></blockquote><span className="quote-author">ЭХИДНА · ВЕДЬМА ЖАДНОСТИ</span><button onClick={openTea}>Минута спокойствия <ArrowRight size={14} /></button></section><section className="panel collection-preview"><div className="panel-heading"><h2>Мои коллекции</h2><Link className="icon-button" to="/collections?new=1" aria-label="Новая коллекция"><Plus size={17} /></Link></div>{collections.length ? collections.slice(0, 3).map(c => <Link to="/collections" key={c.id} className="collection-small"><span><FolderHeart size={17} /></span><div><strong>{c.name}</strong><small>{c.productIds.length} моделей</small></div><ChevronRight size={14} /></Link>) : <div className="collection-preview-empty"><FolderHeart size={26} strokeWidth={1.2} /><p>У прекрасных идей<br />должно быть своё место.</p><Link to="/collections?new=1" className="text-link">Создать первую <Plus size={13} /></Link></div>}</section><div className="aside-note"><Butterfly /><p>«Я искренне рада<br />твоему любопытству.»</p><span>С любовью к знаниям, Эхидна</span></div></aside></div>
  </div>;
}

function ChevronDownIcon() { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" /></svg>; }

function Calendar() {
  const { activity } = useWorkspace();
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(today.getDate());
  const [showDay, setShowDay] = useState(false);
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const selectedEvents = activity.filter(a => { const d = new Date(new Date(a.date).toLocaleString('en-US', { timeZone: 'Europe/Kyiv' })); return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth() && d.getDate() === selected; });
  const move = (delta: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); setSelected(1); setShowDay(false); };
  return <section className="panel calendar-panel"><div className="panel-heading"><h2>Тихий ритм открытий</h2><CalendarDays size={16} /></div><div className="calendar-month"><strong>{month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')}</strong><div><button className="icon-button" onClick={() => move(-1)} aria-label="Предыдущий месяц"><ChevronLeft size={14} /></button><button className="icon-button" onClick={() => move(1)} aria-label="Следующий месяц"><ChevronRight size={14} /></button></div></div><div className="calendar-grid" aria-label="Календарь открытий">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span className="calendar-day-label" key={day}>{day}</span>)}{Array.from({ length: first }, (_, i) => <span key={`empty${i}`} />)}{Array.from({ length: days }, (_, i) => { const n = i + 1; const isToday = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth() && n === today.getDate(); return <button className={`${selected === n ? 'selected' : ''} ${isToday ? 'today' : ''}`} key={n} onClick={() => { setSelected(n); setShowDay(true); }} aria-label={`${n} ${month.toLocaleDateString('ru-RU', { month: 'long' })}`} aria-pressed={selected === n}>{n}</button>; })}</div><div className="calendar-note"><span className="mini-dot" />{showDay ? `${selected} ${month.toLocaleDateString('ru-RU', { month: 'long' })}: ${selectedEvents.length ? `${selectedEvents.length} открытий` : 'день для новых идей'}` : 'Сегодня — хороший день для открытий'}</div>{showDay && selectedEvents.length > 0 && <div className="calendar-events">{selectedEvents.slice(0, 2).map(a => <p key={a.id}>{a.label}</p>)}</div>}</section>;
}

export function ActivityPage() {
  const { activity } = useWorkspace();
  return <div className="w-page"><div className="w-heading"><div><p className="eyebrow">СЛЕДЫ ЛЮБОПЫТСТВА</p><h1>История открытий</h1><p className="page-subtitle">Коллекции, избранное и маленькие изменения твоего пространства.</p></div><Sparkles size={26} /></div><section className="w-card activity-list">{activity.length ? activity.map(item => <div className="activity-row" key={item.id}><span className="activity-icon"><Check size={17} /></span><div><strong>{item.label}</strong><span>{new Date(item.date).toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' })}</span></div></div>) : <div className="w-empty"><Butterfly /><h2>Любое открытие оставляет след</h2><p>Добавь модель в избранное или создай свою первую коллекцию.</p><Link to="/catalog" className="button primary">Исследовать архив <ArrowRight size={15} /></Link></div>}</section></div>;
}

export function TeaBreak({ onClose }: { onClose: () => void }) {
  const [seconds, setSeconds] = useState(60);
  const { notify } = useWorkspace();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const before = document.activeElement as HTMLElement; dialog?.showModal(); return () => { dialog?.close(); before?.focus(); }; }, []);
  useEffect(() => { if (seconds <= 0) return; const timer = window.setTimeout(() => setSeconds(v => v - 1), 1000); return () => clearTimeout(timer); }, [seconds]);
  return <dialog ref={ref} className="tea-dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="tea-title"><div className="tea-dialog-content"><button className="icon-button tea-close" aria-label="Закрыть чаепитие" onClick={onClose}><X size={19} /></button><Butterfly /><p className="eyebrow">ЧАЕПИТИЕ В СВЯТИЛИЩЕ</p><h2 id="tea-title">Побудь здесь немного.</h2><p>Сделай глубокий вдох. Ни одна тайна<br />не исчезнет за чашкой хорошего чая.</p><div className="breathing-circle"><Coffee size={39} strokeWidth={1} /><span>{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '✧'}</span></div><span className="breathing-label">{seconds > 0 ? 'Вдохни. Выдохни. Почувствуй спокойствие.' : 'Теперь можно вернуться к открытиям.'}</span><button className="button primary" onClick={() => { onClose(); notify('Чай выпит. Любопытство восстановлено.'); }}>Вернуться в Святилище <ArrowRight size={15} /></button></div></dialog>;
}
