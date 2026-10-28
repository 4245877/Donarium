import { useEffect, useState } from 'react';
import type { ApiError } from '@donarium/shared';

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok) {
    let message = `Сервер ответил с кодом ${response.status}`;
    try { const body = await response.json() as ApiError; if (body.error?.message) message = body.error.message; } catch { /* Keep HTTP error. */ }
    if (response.status === 401 && path !== '/api/v1/auth/login') window.dispatchEvent(new Event('donarium:unauthorized'));
    throw new Error(message);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export const api = <T,>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const mutate = <T,>(path: string, method: string, body?: unknown) => request<T>(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) { setState({ loading: false }); return; }
    const controller = new AbortController(); setState({ loading: true });
    api<T>(path, controller.signal).then(data => setState({ data, loading: false })).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : 'Не удалось получить данные', loading: false });
    });
    return () => controller.abort();
  }, [path, attempt]);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}
export function externalUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export const message = (error: unknown) => error instanceof Error ? error.message : 'Операция не выполнена';

export function isGoogleDrive(value: string | null): boolean {
  try { return !!value && ['drive.google.com','docs.google.com'].includes(new URL(value).hostname); } catch { return false; }
}
