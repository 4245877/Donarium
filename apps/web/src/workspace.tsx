import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';

export interface WorkspaceCollection {
  id: string;
  name: string;
  description: string;
  productIds: string[];
  createdAt: string;
}

export interface WorkspaceSettings {
  name: string;
  animations: boolean;
  compact: boolean;
  theme: 'light' | 'dark';
}

export interface WorkspaceActivity { id: string; label: string; date: string }

interface WorkspaceData {
  version: 1;
  favorites: string[];
  collections: WorkspaceCollection[];
  settings: WorkspaceSettings;
  activity: WorkspaceActivity[];
}

interface WorkspaceContextValue extends WorkspaceData {
  toggleFavorite: (id: string) => void;
  addCollection: (name: string, description: string) => string | undefined;
  updateCollection: (id: string, name: string, description: string) => boolean;
  deleteCollection: (id: string) => void;
  toggleCollectionProduct: (collectionId: string, productId: string) => void;
  updateSettings: (settings: Partial<WorkspaceSettings>) => void;
  notify: (message: string) => void;
  exportWorkspace: () => void;
  importWorkspace: (file: File) => Promise<boolean>;
}

const STORAGE_KEY = 'echidna.workspace.v1';
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_COLLECTION_REFERENCES = 12000;
const PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);
const defaults = (): WorkspaceData => ({
  version: 1,
  favorites: [],
  collections: [],
  settings: { name: 'Путешественник', animations: true, compact: false, theme: 'light' },
  activity: [],
});

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректная структура файла.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('Файл содержит неизвестные поля.');
  return record;
}

function textValue(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error('Некорректный текст или превышена допустимая длина.');
  }
  return value.trim();
}

function idValue(value: unknown, product = false): string {
  if (typeof value !== 'string' || !(product ? PRODUCT_ID : LOCAL_ID).test(value)) throw new Error('Некорректный идентификатор.');
  return value;
}

function dateValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('Некорректная дата.');
  return new Date(value).toISOString();
}

function productIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('В списке может быть не более 1000 моделей.');
  return [...new Set(value.map(id => idValue(id, true)))];
}

function parseWorkspace(value: unknown): WorkspaceData {
  const input = object(value, ['version', 'favorites', 'collections', 'settings', 'activity', 'exportedAt']);
  if (input.version !== 1) throw new Error('Эта версия файла не поддерживается.');
  if (input.exportedAt !== undefined) dateValue(input.exportedAt);
  if (!Array.isArray(input.collections) || input.collections.length > 200) throw new Error('В файле может быть не более 200 коллекций.');
  const settings = object(input.settings, ['name', 'animations', 'compact', 'theme']);
  if (typeof settings.animations !== 'boolean' || typeof settings.compact !== 'boolean' || !['light', 'dark'].includes(String(settings.theme))) {
    throw new Error('Некорректные настройки пространства.');
  }
  const collections = input.collections.map(value => {
    const item = object(value, ['id', 'name', 'description', 'productIds', 'createdAt']);
    return {
      id: idValue(item.id), name: textValue(item.name, 80), description: textValue(item.description, 500, true),
      productIds: productIds(item.productIds), createdAt: dateValue(item.createdAt),
    };
  });
  if (new Set(collections.map(item => item.id)).size !== collections.length) throw new Error('Идентификаторы коллекций должны быть уникальными.');
  if (collections.reduce((total, item) => total + item.productIds.length, 0) > MAX_COLLECTION_REFERENCES) throw new Error('В коллекциях слишком много ссылок на модели. Допустимо до 12000.');
  if (!Array.isArray(input.activity) || input.activity.length > 100) throw new Error('Некорректный журнал действий.');
  const activity = input.activity.map(value => {
    const item = object(value, ['id', 'label', 'date']);
    return { id: idValue(item.id), label: textValue(item.label, 200), date: dateValue(item.date) };
  });
  if (new Set(activity.map(item => item.id)).size !== activity.length) throw new Error('Идентификаторы действий должны быть уникальными.');
  return {
    version: 1,
    favorites: productIds(input.favorites), collections, activity,
    settings: { name: textValue(settings.name, 80), animations: settings.animations, compact: settings.compact, theme: settings.theme as 'light' | 'dark' },
  };
}

function initialWorkspace(): { data: WorkspaceData; storageValue?: string | null; warning?: string } {
  let storageValue: string | null | undefined;
  try {
    storageValue = localStorage.getItem(STORAGE_KEY);
    return { data: storageValue ? parseWorkspace(JSON.parse(storageValue)) : defaults(), storageValue };
  } catch {
    return { data: defaults(), storageValue, warning: 'Не удалось прочитать сохранённое пространство. Используются начальные настройки.' };
  }
}

function newId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialWorkspace);
  const [state, setState] = useState(initial.data);
  const stateRef = useRef(state);
  const storageValueRef = useRef(initial.storageValue);
  const [toast, setToast] = useState<{ id: number; message: string } | undefined>(initial.warning ? { id: Date.now(), message: initial.warning } : undefined);
  const notify = useCallback((message: string) => setToast({ id: Date.now() + Math.random(), message }), []);

  const readLatest = useCallback(() => {
    let saved: string | null | undefined;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
      // Preserve unsaved in-memory changes if the last write was denied.
      if (saved === storageValueRef.current) return stateRef.current;
      const latest = saved === null ? defaults() : parseWorkspace(JSON.parse(saved));
      storageValueRef.current = saved;
      stateRef.current = latest;
      setState(latest);
      return latest;
    } catch {
      // An invalid external update must not replace the current valid workspace.
      if (saved !== undefined) storageValueRef.current = saved;
      notify('Не удалось прочитать изменения из другой вкладки. Текущее пространство сохранено в памяти.');
      return stateRef.current;
    }
  }, [notify]);

  useEffect(() => {
    function syncStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY || event.key === null) readLatest();
    }
    window.addEventListener('storage', syncStorage);
    // Close the gap between the initial render and registering the listener.
    // Reading never writes defaults over a saved or malformed workspace.
    readLatest();
    return () => window.removeEventListener('storage', syncStorage);
  }, [readLatest]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.animations = state.settings.animations ? 'on' : 'off';
    document.documentElement.dataset.compact = String(state.settings.compact);
  }, [state.settings]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function commit(next: WorkspaceData, label: string) {
    const data: WorkspaceData = {
      ...next,
      activity: [{ id: newId(), label, date: new Date().toISOString() }, ...next.activity].slice(0, 100),
    };
    stateRef.current = data;
    setState(data);
    try {
      const serialized = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, serialized);
      storageValueRef.current = serialized;
      return true;
    } catch {
      notify('Браузер не разрешил сохранение. Изменения доступны только до закрытия страницы.');
      return false;
    }
  }

  function toggleFavorite(id: string) {
    if (!PRODUCT_ID.test(id)) { notify('Не удалось сохранить модель: некорректный идентификатор.'); return; }
    const current = readLatest();
    const exists = current.favorites.includes(id);
    if (!exists && current.favorites.length >= 1000) { notify('В избранном может быть не более 1000 моделей.'); return; }
    const label = exists ? 'Модель удалена из избранного' : 'Модель добавлена в избранное';
    if (commit({ ...current, favorites: exists ? current.favorites.filter(item => item !== id) : [...current.favorites, id] }, label)) notify(label);
  }

  function addCollection(name: string, description: string) {
    try {
      const current = readLatest();
      const title = textValue(name, 80);
      const detail = textValue(description, 500, true);
      if (current.collections.length >= 200) throw new Error('Можно создать не более 200 коллекций.');
      if (current.collections.some(item => item.name.toLocaleLowerCase('ru') === title.toLocaleLowerCase('ru'))) throw new Error('Коллекция с таким названием уже существует.');
      const item = { id: newId(), name: title, description: detail, productIds: [], createdAt: new Date().toISOString() };
      if (commit({ ...current, collections: [...current.collections, item] }, `Создана коллекция «${title}»`)) notify('Коллекция создана. Теперь добавьте в неё модели.');
      return item.id;
    } catch (error) { notify(error instanceof Error ? error.message : 'Не удалось создать коллекцию.'); return undefined; }
  }

  function deleteCollection(id: string) {
    const current = readLatest();
    const item = current.collections.find(item => item.id === id);
    if (!item) return;
    if (commit({ ...current, collections: current.collections.filter(item => item.id !== id) }, `Удалена коллекция «${item.name}»`)) notify('Коллекция удалена. Модели остались в каталоге.');
  }

  function updateCollection(id: string, name: string, description: string) {
    try {
      const current = readLatest();
      const title = textValue(name, 80);
      const detail = textValue(description, 500, true);
      if (!current.collections.some(item => item.id === id)) throw new Error('Коллекция больше не существует.');
      if (current.collections.some(item => item.id !== id && item.name.toLocaleLowerCase('ru') === title.toLocaleLowerCase('ru'))) throw new Error('Коллекция с таким названием уже существует.');
      if (commit({ ...current, collections: current.collections.map(item => item.id === id ? { ...item, name: title, description: detail } : item) }, `Обновлена коллекция «${title}»`)) notify('Название и описание коллекции сохранены.');
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : 'Не удалось изменить коллекцию.'); return false; }
  }

  function toggleCollectionProduct(collectionId: string, productId: string) {
    const current = readLatest();
    const collection = current.collections.find(item => item.id === collectionId);
    if (!collection || !PRODUCT_ID.test(productId)) { notify('Коллекция или модель недоступна.'); return; }
    const exists = collection.productIds.includes(productId);
    if (!exists && collection.productIds.length >= 1000) { notify('В коллекции может быть не более 1000 моделей.'); return; }
    if (!exists && current.collections.reduce((total, item) => total + item.productIds.length, 0) >= MAX_COLLECTION_REFERENCES) { notify('Достигнут предел: 12000 ссылок на модели во всех коллекциях.'); return; }
    const ids = exists ? collection.productIds.filter(id => id !== productId) : [...collection.productIds, productId];
    if (commit({ ...current, collections: current.collections.map(item => item.id === collectionId ? { ...item, productIds: ids } : item) }, `${exists ? 'Модель удалена из коллекции' : 'Модель добавлена в коллекцию'} «${collection.name}»`)) notify(exists ? 'Модель убрана из коллекции.' : 'Модель добавлена в коллекцию.');
  }

  function updateSettings(changes: Partial<WorkspaceSettings>) {
    const current = readLatest();
    try {
      const candidate = { ...current, settings: { ...current.settings, ...changes } };
      const checked = parseWorkspace(candidate);
      if (commit(checked, 'Обновлены настройки пространства')) notify('Настройки сохранены. Устраивайтесь поудобнее.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Не удалось сохранить настройки.'); }
  }

  function exportWorkspace() {
    try {
      const blob = new Blob([JSON.stringify({ ...readLatest(), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      link.download = `echidna-workspace-${today}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Резервная копия пространства подготовлена.');
    } catch { notify('Не удалось подготовить файл. Попробуйте ещё раз.'); }
  }

  async function importWorkspace(file: File) {
    try {
      if (file.size > MAX_FILE_SIZE) throw new Error('Размер файла должен быть не больше 2 МБ.');
      const raw: unknown = JSON.parse(await file.text());
      const data = parseWorkspace(raw);
      if (commit(data, 'Пространство восстановлено из резервной копии')) notify('Пространство восстановлено. Добро пожаловать обратно.');
      return true;
    } catch (error) {
      notify(error instanceof SyntaxError ? 'Файл не содержит корректный JSON.' : error instanceof Error ? error.message : 'Не удалось прочитать файл.');
      return false;
    }
  }

  return <WorkspaceContext.Provider value={{ ...state, toggleFavorite, addCollection, updateCollection, deleteCollection, toggleCollectionProduct, updateSettings, notify, exportWorkspace, importWorkspace }}>
    {children}
    <div className="w-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && <div className="w-toast" key={toast.id}><Check size={18} aria-hidden="true" /><span>{toast.message}</span><button type="button" onClick={() => setToast(undefined)} aria-label="Закрыть уведомление"><X size={16} /></button></div>}
    </div>
  </WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace должен использоваться внутри WorkspaceProvider.');
  return context;
}
