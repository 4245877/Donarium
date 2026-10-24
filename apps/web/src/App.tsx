import { useEffect, useRef, useState } from 'react';
import { Bell, BookOpen, ChevronDown, ChevronRight, CircleHelp, Coffee, Download, FolderHeart, House, Menu, Plus, Search, Settings2, ShieldCheck, Sparkles, Star, X } from 'lucide-react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { HealthResponse } from '@donarium/shared';
import { useApi } from './api';
import { CatalogPage, ProductPage, SystemPage, NotFoundPage } from './pages';
import { CollectionsPage, FavoritesPage, SettingsPage } from './WorkspacePages';
import { useWorkspace } from './workspace';
import { Dashboard, ActivityPage, TeaBreak } from './Dashboard';

export function Butterfly({ className = '' }: { className?: string }) {
  return <svg className={className} width="36" height="36" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23 23C17 6 3 3 5 16c1 8 10 11 16 10C7 22 5 32 11 36c6 4 10-3 13-9M25 23C31 6 45 3 43 16c-1 8-10 11-16 10 14-4 16 6 10 10-6 4-10-3-13-9" fill="currentColor"/><path d="m20 9 4 13 4-13M24 21v15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>;
}

export default function App() {
  const health = useApi<HealthResponse>('/health');
  const location = useLocation();
  const navigate = useNavigate();
  const { settings, favorites, collections, activity, exportWorkspace } = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [search, setSearch] = useState('');
  const [tea, setTea] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 660px)').matches);
  const searchRef = useRef<HTMLInputElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => { window.scrollTo(0, 0); setMobileOpen(false); setNotifications(false); }, [location.pathname]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key === 'k' && !document.querySelector('[aria-modal="true"], dialog[open]')) { event.preventDefault(); searchRef.current?.focus(); } if (event.key === 'Escape') { setMobileOpen(false); setNotifications(false); } }
    const close = (event: PointerEvent) => { if (!notificationRef.current?.contains(event.target as Node)) setNotifications(false); };
    window.addEventListener('keydown', shortcut); window.addEventListener('pointerdown', close);
    return () => { window.removeEventListener('keydown', shortcut); window.removeEventListener('pointerdown', close); };
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 660px)');
    const change = () => { setIsMobile(query.matches); if (!query.matches) setMobileOpen(false); };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!mobileOpen || !isMobile) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []);
    sidebarRef.current?.querySelector<HTMLElement>('.sidebar-close')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable(); const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, [mobileOpen, isMobile]);
  const activePage = location.pathname === '/' ? 'Обзор библиотеки' : location.pathname === '/catalog' ? 'Каталог моделей' : location.pathname.startsWith('/catalog/') ? 'Карточка модели' : location.pathname === '/system' ? 'О системе' : location.pathname === '/favorites' ? 'Избранное' : location.pathname === '/collections' ? 'Коллекции' : location.pathname === '/settings' ? 'Настройки' : 'История открытий';
  const online = health.data?.status === 'ok';
  return <div className="app-layout">
    <a className="skip-link" href="#main">К содержимому</a>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Закрыть меню" onClick={() => setMobileOpen(false)} />}
    <aside ref={sidebarRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`} inert={isMobile && !mobileOpen} role={isMobile && mobileOpen ? 'dialog' : undefined} aria-modal={isMobile && mobileOpen ? true : undefined} aria-label="Навигация Святилища">
      <button className="icon-button sidebar-close" aria-label="Закрыть навигацию" onClick={() => setMobileOpen(false)}><X size={19} /></button>
      <Link to="/" className="brand" aria-label="Echidna — главная"><Butterfly /><span>echidna<small>DIGITAL SANCTUARY</small></span><span className="brand-spark">✧</span></Link>
      <div className="workspace-picker"><span className="workspace-icon"><BookOpen size={17} /></span><span>Моё Святилище<small>Личное пространство</small></span><ChevronDown size={13} /></div>
      <div className="sidebar-section-label">ПРОСТРАНСТВО</div>
      <nav className="main-nav" aria-label="Основная навигация">
        <NavLink to="/" end><House size={18} /><span>Обзор</span><span className="nav-active-dot" /></NavLink>
        <NavLink to="/catalog"><BookOpen size={18} /><span>Каталог моделей</span></NavLink>
        <NavLink to="/collections"><FolderHeart size={18} /><span>Коллекции</span>{collections.length > 0 && <span className="nav-count">{collections.length}</span>}</NavLink>
        <NavLink to="/favorites"><Star size={18} /><span>Избранное</span>{favorites.length > 0 && <span className="nav-count">{favorites.length}</span>}</NavLink>
        <NavLink to="/activity"><Sparkles size={18} /><span>История открытий</span></NavLink>
      </nav>
      <div className="sidebar-section-label second-label">УПРАВЛЕНИЕ</div>
      <nav className="main-nav secondary-nav" aria-label="Управление пространством"><NavLink to="/settings"><Settings2 size={18} /><span>Настройки</span></NavLink><NavLink to="/system"><CircleHelp size={18} /><span>О системе</span></NavLink></nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-tea"><Coffee size={25} strokeWidth={1.2} /><span className="tiny-spark">✧</span><h3>Не спеши. Выпей чаю.</h3><p>У каждого открытия<br />есть своё время.</p><button onClick={() => { setMobileOpen(false); setTea(true); }}>Заглянуть на чаепитие <ChevronRight size={14} /></button></div>
      <div className="sidebar-bottom"><div className="server-indicator"><i className={online ? 'status-dot online' : 'status-dot'} /><span>{health.loading ? 'Проверяем архив…' : online ? 'API подключён' : 'API недоступен'}</span><ShieldCheck size={12} /></div><Link to="/settings" className="sidebar-profile"><span className="profile-avatar">{settings.name.charAt(0).toUpperCase()}</span><span>{settings.name}<small>Хранитель архива</small></span><ChevronDown size={13} /></Link></div>
    </aside>
    <div className="main-shell" inert={isMobile && mobileOpen}>
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Открыть меню" aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}><Menu size={21} /></button><div className="breadcrumbs"><Butterfly /><span>Святилище</span><ChevronRight size={12} /><span>{activePage}</span></div><form className="global-search" role="search" onSubmit={event => { event.preventDefault(); navigate(`/catalog${search ? `?q=${encodeURIComponent(search)}` : ''}`); searchRef.current?.blur(); }}><Search size={16} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} aria-label="Найти в архиве" placeholder="Найти что-нибудь интересное…" maxLength={200} /><kbd>Ctrl K</kbd></form><div className="topbar-right"><button className="icon-button topbar-export" aria-label="Экспорт личного пространства" onClick={exportWorkspace}><Download size={17} /></button><div className="notification-wrapper" ref={notificationRef}><button className={`icon-button bell-button ${activity.length ? 'has-notification' : ''}`} aria-label="Уведомления" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={18} /></button>{notifications && <div className="notification-panel"><h3>События Святилища <button className="icon-button" aria-label="Закрыть уведомления" onClick={() => setNotifications(false)}><X size={15} /></button></h3>{activity.slice(0, 4).map(item => <div className="notification-item" key={item.id}><Sparkles size={14} /><div><strong>{item.label}</strong><small>{new Date(item.date).toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div></div>)}{activity.length === 0 && <p>Здесь появятся ваши новые открытия: избранное, коллекции и изменения пространства.</p>}<Link to="/activity" className="text-link">Вся история <ChevronRight size={13} /></Link></div>}</div><Link to="/settings" className="topbar-avatar" aria-label="Настройки профиля">{settings.name.charAt(0).toUpperCase()}</Link></div></header>
      <main id="main"><Routes><Route path="/" element={<Dashboard openTea={() => setTea(true)} />} /><Route path="/catalog" element={<CatalogPage />} /><Route path="/catalog/:id" element={<ProductPage />} /><Route path="/favorites" element={<FavoritesPage />} /><Route path="/collections" element={<CollectionsPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="/activity" element={<ActivityPage />} /><Route path="/system" element={<SystemPage />} /><Route path="*" element={<NotFoundPage />} /></Routes></main>
      <footer className="page-footer"><span><Butterfly /> ECHIDNA <span className="footer-divider">/</span> Цифровое Святилище</span><span>Пусть твоё любопытство никогда не угасает. <span className="footer-star">✧</span></span></footer>
    </div>
    <Link className="floating-create" to="/collections?new=1" aria-label="Создать коллекцию" inert={isMobile && mobileOpen}><Plus size={20} /></Link>
    {tea && <TeaBreak onClose={() => setTea(false)} />}
  </div>;
}
