import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startLocalService } from '../../apps/server/src/local-service';

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'openbot-local-service-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const env = { BRAIN_ENABLED: 'false' };
it('starts with private persistent credentials, requires authentication and preserves Bot chats across reopen', async () => {
  const path = directory();
  let service = await startLocalService(path, env);
  const connection = service.connection;
  const api = (route: string, body?: unknown) =>
    fetch(service.connection.url + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${service.connection.token}`,
        Connection: 'close',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    expect(
      (await fetch(connection.url + '/api/snapshot', { headers: { connection: 'close' } })).status,
    ).toBe(401);
    const bot = await (await api('/api/bots', { name: 'PersistentBot', provider: 'codex' })).json();
    const chat = await (await api(`/api/bots/${bot.id}/chat`, {})).json();
    expect(service.bridgeToken).not.toBe(connection.token);
    if (process.platform !== 'win32')
      for (const file of ['client-token', 'bridge-token', 'local-connection.json'])
        expect(statSync(join(path, file)).mode & 0o777).toBe(0o600);
    await expect(startLocalService(path, env)).rejects.toThrow('已在运行');
    await service.close();
    service = await startLocalService(path, env);
    expect(service.connection).toEqual(connection);
    const snapshot = await (await api('/api/snapshot')).json();
    expect(snapshot.bots[0].id).toBe(bot.id);
    expect(snapshot.groups.find((g: { id: string }) => g.id === chat.id).directBotId).toBe(bot.id);
    expect(readFileSync(join(path, 'bridge-token'), 'utf8')).toBe(service.bridgeToken);
  } finally {
    await service.close();
  }
});
it('chooses another loopback port when the previous port belongs to another process', async () => {
  const path = directory();
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const address = other.address() as { port: number };
  writeFileSync(
    join(path, 'local-connection.json'),
    JSON.stringify({ url: `http://127.0.0.1:${address.port}` }),
  );
  let service: Awaited<ReturnType<typeof startLocalService>> | undefined;
  try {
    service = await startLocalService(path, env);
    expect(service.connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.connection.url).not.toBe(`http://127.0.0.1:${address.port}`);
    expect((await fetch(service.connection.url + '/health')).ok).toBe(true);
  } finally {
    await service?.close();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});
