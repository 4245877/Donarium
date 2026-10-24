import { useEffect, useState } from 'react';
import type { ApiError } from '@donarium/shared';

export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    let message = `Сервер ответил с кодом ${response.status}`;
    try {
      const body = await response.json() as ApiError;
      if (body.error?.message) message = body.error.message;
    } catch { /* Preserve the HTTP error when the body is not JSON. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function useApi<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    api<T>(path, controller.signal).then(data => {
      setState({ data, loading: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : 'Не удалось получить данные', loading: false });
    });
    return () => controller.abort();
  }, [path, attempt]);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}

export function externalUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
