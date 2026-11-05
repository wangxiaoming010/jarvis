import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Snapshot } from '@openbot/shared';
import {
  initialConnection,
  LiveClient,
  request,
  type Connection,
  type ConnectionStatus,
} from './client';

export function useOpenBot() {
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const [data, setData] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const live = useRef<LiveClient | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    let client: LiveClient | undefined;
    let recovery: ReturnType<typeof setTimeout> | undefined;
    setStatus('connecting');
    async function connect() {
      try {
        const next = isTauri() ? await invoke<Connection>('local_service') : initialConnection();
        if (cancelled) return;
        setConnection(next);
        client = new LiveClient(next, setData, (state) => {
          if (cancelled) return;
          setStatus(state);
          clearTimeout(recovery);
          if (state === 'connected') setError('');
          else if (isTauri() && (state === 'offline' || state === 'unauthorized'))
            recovery = setTimeout(retry, 3000);
        });
        live.current = client;
      } catch (e) {
        if (cancelled) return;
        setStatus('offline');
        setError(
          typeof e === 'string'
            ? e
            : e instanceof Error
              ? e.message
              : '本地服务暂时无法启动，请重试。',
        );
        recovery = setTimeout(retry, 5000);
      }
    }
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(recovery);
      client?.close();
      live.current = null;
    };
  }, [attempt, retry]);
  async function mutate<T>(path: string, body?: unknown, method?: string) {
    const result = await request<T>(connection, path, body, method);
    try {
      await live.current?.refreshNow();
    } catch {
      setError('已保存，正在等待界面重新同步。');
    }
    return result;
  }
  return { data, status, error, setError, connection, retry, mutate };
}
