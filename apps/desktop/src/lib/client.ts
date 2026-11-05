import { isTauri } from '@tauri-apps/api/core';
import type { Snapshot } from '@openbot/shared';
export interface Connection {
  url: string;
  token: string;
}
export type ConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unauthorized';
export function normalizeUrl(input: string) {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('请输入服务根地址，例如 http://127.0.0.1:4310');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程连接必须使用 HTTPS');
  return url.origin;
}
export function initialConnection(): Connection {
  if (isTauri()) return { url: 'http://127.0.0.1', token: '' };
  return {
    url:
      localStorage.getItem('openbot.server') ??
      import.meta.env.VITE_SERVER_URL ??
      'http://127.0.0.1:4310',
    token:
      sessionStorage.getItem('openbot.token') ??
      (import.meta.env.DEV ? (import.meta.env.VITE_OPENBOT_TOKEN ?? '') : ''),
  };
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  connection: Connection,
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  timeout = 10000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${normalizeUrl(connection.url)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.includes('HTTPS')
        ? error.message
        : '本地连接暂时中断，正在尝试恢复',
    );
  }
  const data = await response.json().catch(() => ({ error: '服务返回了无效响应' }));
  if (!response.ok) throw new ApiError(response.status, data.error ?? '请求失败');
  return data;
}
export class LiveClient {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private retries = 0;
  private refreshing = false;
  private dirty = false;
  private ping?: ReturnType<typeof setInterval>;
  constructor(
    private connection: Connection,
    private onSnapshot: (data: Snapshot) => void,
    private onStatus: (status: ConnectionStatus) => void,
  ) {
    void this.connect();
  }
  private async refresh() {
    if (this.refreshing) {
      this.dirty = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        const snapshot = await request<Snapshot>(this.connection, '/api/snapshot');
        if (!this.stopped) this.onSnapshot(snapshot);
      } while (this.dirty && !this.stopped);
    } finally {
      this.refreshing = false;
    }
  }
  private async connect() {
    if (this.stopped) return;
    this.onStatus(this.retries ? 'reconnecting' : 'connecting');
    try {
      await this.refresh();
      if (this.stopped) return;
      const url = new URL('/events', normalizeUrl(this.connection.url));
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      this.socket = socket;
      const handshake = setTimeout(() => socket.close(), 7000);
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: 'auth', token: this.connection.token }));
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === 'ready') {
            clearTimeout(handshake);
            this.retries = 0;
            this.onStatus('connected');
            void this.refresh().catch(() => socket.close());
            this.ping = setInterval(() => {
              void this.refresh().catch(() => socket.close());
            }, 30000);
          } else if (frame.type === 'invalidate') void this.refresh().catch(() => socket.close());
        } catch {
          socket.close();
        }
      };
      socket.onclose = (event) => {
        clearTimeout(handshake);
        clearInterval(this.ping);
        if (this.stopped) return;
        if (event.code === 1008) {
          this.onStatus('unauthorized');
          return;
        }
        this.retry();
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ApiError && error.status === 401) {
        this.onStatus('unauthorized');
        return;
      }
      this.retry();
    }
  }
  private retry() {
    this.retries++;
    this.onStatus(this.retries > 3 ? 'offline' : 'reconnecting');
    this.timer = setTimeout(
      () => void this.connect(),
      Math.min(1000 * 2 ** (this.retries - 1), 15000),
    );
  }
  async refreshNow() {
    try {
      return await this.refresh();
    } catch (error) {
      this.socket?.close();
      throw error;
    }
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.socket?.close();
  }
}
