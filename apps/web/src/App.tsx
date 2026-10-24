import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronRight, CircleHelp, Coffee, Download, House, LogOut, Menu, Plus, Search, Settings2, ShieldCheck, Upload, X } from 'lucide-react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { HealthResponse } from '@donarium/shared';
import { message, mutate, useApi } from './api';
import { CatalogPage, ProductPage, ProductEditor, SystemPage, NotFoundPage } from './pages';
import { ImportPage, TransferPage } from './transfers';
import { ErrorState, Loading, ThemeSwitch } from './components';
import { Dashboard } from './Dashboard';

const ReadOnlyContext = createContext(true);
export const useReadOnly = () => useContext(ReadOnlyContext);
const wing = <><path d="M23.3 21.6C20.6 15.4 14.6 9.2 6.4 6.6c-1.8-.5-2.7.8-2.1 2.6 1.3 4.2 3.1 9 6.5 11.4 3.4 2.4 8 3.1 12.2 3Z" /><path d="M23.1 25.2c-4.9.1-10.7 1.4-12.9 4.6-1.8 2.6-.6 7.8 2.4 9.8 2.1 1.4 4.3 0 5.7-2.6 1.9-3.5 4.1-7.4 5.2-10.2Z" /><path className="butterfly-vein" d="M21.4 21.9C18 17.3 13 12.6 7.7 9.9M21.6 26.5c-3 2.3-6 6-7.9 10.5" fill="none" strokeWidth=".9" strokeLinecap="round" /></>;
/** Echidna's hair ornament: porcelain wings with ink veins; the wing groups can flutter. */
export function Butterfly({ className = '' }: { className?: string }) { return <svg className={`butterfly ${className}`} width="36" height="36" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><g className="butterfly-wing butterfly-wing-left">{wing}</g><g className="butterfly-wing butterfly-wing-right"><g transform="matrix(-1 0 0 1 48 0)">{wing}</g></g><path d="M24 20.4v15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><circle cx="24" cy="19.2" r="1.5" /><path d="M23.4 18.6c-1-3.5-3-6.3-5.6-7.9M24.6 18.6c1-3.5 3-6.3 5.6-7.9" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>; }
/** The four-pointed star from the Donarium banner. */
export function Sparkle({ className = '' }: { className?: string }) { return <svg className={`sparkle ${className}`} width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5c.7 5.4 3.6 8.8 10.5 10.5-6.9 1.7-9.8 5.1-10.5 10.5-.7-5.4-3.6-8.8-10.5-10.5C8.4 10.3 11.3 6.9 12 1.5Z" /></svg>; }
interface Session { authenticated: boolean; configured: boolean; readOnly: boolean }
export default function App() {
  const session = useApi<Session>('/api/v1/auth/session');
  useEffect(() => { const refresh = () => session.retry(); window.addEventListener('donarium:unauthorized', refresh); return () => window.removeEventListener('donarium:unauthorized', refresh); }, [session.retry]);
  if (session.loading) return <Loading label="Проверяем доступ…" />;
  if (session.error) return <ErrorState message={session.error} retry={session.retry} />;
  if (!session.data?.authenticated) return <Login configured={session.data?.configured ?? false} onLogin={session.retry} />;
  return <ReadOnlyContext.Provider value={session.data.readOnly}><Shell logout={async () => { await mutate('/api/v1/auth/logout', 'POST'); session.retry(); }} /></ReadOnlyContext.Provider>;
}
function Login({ configured, onLogin }: { configured: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <div className="login-screen"><ThemeSwitch /><form className="editor-panel login-panel" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await mutate('/api/v1/auth/login', 'POST', { password }); onLogin(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}><img className="login-banner" src="/images/echidna-banner-800.webp" srcSet="/images/echidna-banner-800.webp 800w, /images/echidna-banner-1280.webp 1280w" sizes="(max-width: 480px) 100vw, 440px" width={1983} height={793} alt="" fetchPriority="high" /><Butterfly /><h1>DONARIUM</h1><p className="page-subtitle">Персональная цифровая библиотека</p>{configured ? <><label className="field">Пароль владельца<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? 'Входим…' : 'Открыть библиотеку'}</button></> : <p role="alert">Защита приложения ещё не настроена. Задайте ADMIN_PASSWORD в окружении сервера и перезапустите DONARIUM.</p>}</form></div>;
}
function Shell({ logout }: { logout: () => Promise<void> }) {
  const readOnly = useReadOnly();
  const health = useApi<HealthResponse>('/health'); const location = useLocation(); const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false); const [search, setSearch] = useState(''); const [logoutError, setLogoutError] = useState('');
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 660px)').matches);
  const searchRef = useRef<HTMLInputElement>(null); const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => { window.scrollTo(0, 0); setMobileOpen(false); }, [location.pathname]);
  useEffect(() => { const query = window.matchMedia('(max-width: 660px)'); const change = () => { setIsMobile(query.matches); if (!query.matches) setMobileOpen(false); }; query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); searchRef.current?.focus(); } if (event.key === 'Escape') setMobileOpen(false); }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, []);
  useEffect(() => {
    if (!mobileOpen || !isMobile) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') || []);
    sidebarRef.current?.querySelector<HTMLElement>('.sidebar-close')?.focus();
    const trap = (event: KeyboardEvent) => { if (event.key !== 'Tab') return; const elements = focusable(); if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); } };
    document.addEventListener('keydown', trap); return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [mobileOpen, isMobile]);
  const page = location.pathname === '/' ? 'Обзор библиотеки' : location.pathname.startsWith('/import') ? 'Импорт папок' : location.pathname.startsWith('/transfer') ? 'Экспорт и восстановление' : location.pathname === '/settings' ? 'Настройки и состояние' : location.pathname === '/catalog/new' ? 'Новая карточка' : location.pathname.includes('/edit') ? 'Редактирование' : location.pathname === '/catalog' ? 'Каталог' : 'Карточка модели';
  const online = health.data?.status === 'ok';
  return <div className="app-layout">
    <a className="skip-link" href="#main">К содержимому</a>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Закрыть меню" onClick={() => setMobileOpen(false)} />}
    <aside ref={sidebarRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`} inert={isMobile && !mobileOpen} role={isMobile && mobileOpen ? 'dialog' : undefined} aria-modal={isMobile && mobileOpen ? true : undefined} aria-label="Навигация DONARIUM">
      <button className="icon-button sidebar-close" aria-label="Закрыть навигацию" onClick={() => setMobileOpen(false)}><X size={19} /></button>
      <Link to="/" className="brand" aria-label="Echidna — главная"><Butterfly /><span>echidna<small>DIGITAL SANCTUARY</small></span><span className="brand-spark"><Sparkle /></span></Link>
      <div className="workspace-picker"><span className="workspace-icon"><BookOpen size={17} /></span><span>Моё Святилище<small>Персональная библиотека</small></span></div>
      <div className="sidebar-section-label">ПРОСТРАНСТВО</div>
      <nav className="main-nav" aria-label="Основная навигация">
        <NavLink to="/" end><House size={18} /><span>Обзор</span><span className="nav-active-dot" /></NavLink>
        <NavLink to="/catalog"><BookOpen size={18} /><span>Каталог моделей</span></NavLink>
        <NavLink to="/import"><Upload size={18} /><span>Импорт папок</span></NavLink>
        <NavLink to="/transfer"><Download size={18} /><span>Экспорт и восстановление</span></NavLink>
      </nav>
      <div className="sidebar-section-label second-label">УПРАВЛЕНИЕ</div>
      <nav className="main-nav secondary-nav" aria-label="Управление библиотекой"><NavLink to="/settings"><Settings2 size={18} /><span>Настройки и состояние</span></NavLink></nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-tea"><Coffee size={25} strokeWidth={1.2} /><span className="tiny-spark"><Sparkle /></span><h3>Не спеши. Выпей чаю.</h3><p>У каждого открытия<br />есть своё время.</p><Link to="/catalog" className="sidebar-tea-link">Исследовать библиотеку <ChevronRight size={14} /></Link></div>
      <div className="sidebar-bottom"><div className="server-indicator"><i className={online ? 'status-dot online' : 'status-dot'} /><span>{health.loading ? 'Проверяем архив…' : online ? 'API подключён' : 'API недоступен'}</span><ShieldCheck size={12} /></div><button className="sidebar-profile owner-session" onClick={() => { setLogoutError(''); logout().catch(e => setLogoutError(message(e))); }} aria-label="Завершить сеанс"><span className="profile-avatar"><Butterfly /></span><span>Хранитель архива<small>Завершить сеанс</small></span><LogOut size={15} /></button>{logoutError && <p className="inline-error" role="alert">{logoutError}</p>}</div>
    </aside>
    <div className="main-shell" inert={isMobile && mobileOpen}>
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Открыть меню" aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}><Menu size={21} /></button><div className="breadcrumbs"><Butterfly /><span>Святилище</span><ChevronRight size={12} /><span>{page}</span></div><form className="global-search" role="search" onSubmit={event => { event.preventDefault(); navigate(`/catalog${search ? `?q=${encodeURIComponent(search)}` : ''}`); searchRef.current?.blur(); }}><Search size={16} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} aria-label="Найти в библиотеке" placeholder="Найти что-нибудь интересное…" maxLength={200} /><kbd>Ctrl K</kbd></form><div className="topbar-right"><Link className="icon-button topbar-export" to="/transfer" aria-label="Экспорт библиотеки"><Download size={17} /></Link><Link className="icon-button" to="/settings" aria-label="Состояние приложения"><CircleHelp size={18} /></Link><ThemeSwitch /></div></header>
      <main id="main"><Routes><Route path="/" element={<Dashboard />} /><Route path="/catalog" element={<CatalogPage />} /><Route path="/catalog/new" element={<ProductEditor />} /><Route path="/catalog/:id/edit" element={<ProductEditor />} /><Route path="/catalog/:id" element={<ProductPage />} /><Route path="/import" element={<ImportPage />} /><Route path="/transfer" element={<TransferPage />} /><Route path="/settings" element={<SystemPage />} /><Route path="/system" element={<Navigate replace to="/settings" />} /><Route path="*" element={<NotFoundPage />} /></Routes></main>
      <footer className="page-footer"><span><Butterfly />ECHIDNA <span className="footer-divider">/</span>Цифровое Святилище</span><span>Пусть твоё любопытство никогда не угасает. <span className="footer-star"><Sparkle /></span></span></footer>
    </div>
    {!readOnly && <Link className="floating-create" to="/catalog/new" aria-label="Создать карточку" inert={isMobile && mobileOpen}><Plus size={20} /></Link>}
  </div>;
}
