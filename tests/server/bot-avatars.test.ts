import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { botAvatarSchema } from '../../packages/shared/src/schemas';

const token = 'isolated-bot-avatar-test-token';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/1cAAAAASUVORK5CYII=';
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>>;
const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  instance.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const snapshot = async () => (await api('GET', '/api/snapshot')).json();

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-avatar-'));
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
});
afterEach(async () => {
  await instance.app.close();
  rmSync(directory, { recursive: true, force: true });
});

it('preserves emoji and photos across restarts and restores defaults without changing bot identity', async () => {
  const emoji = { type: 'emoji', value: '🧑🏽‍💻' };
  const photo = { type: 'image', value: png };
  const first = await api('POST', '/api/bots', {
    name: 'EmojiBot',
    provider: 'codex',
    avatar: emoji,
  });
  expect(first.statusCode).toBe(201);
  const id = first.json().id;
  const second = await api('POST', '/api/bots', {
    name: 'PhotoBot',
    provider: 'claude-code',
    avatar: photo,
  });
  expect(second.statusCode).toBe(201);
  await instance.app.close();
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  expect((await snapshot()).bots).toMatchObject([
    { id, name: 'EmojiBot', provider: 'codex', avatar: emoji },
    { name: 'PhotoBot', provider: 'claude-code', avatar: photo },
  ]);
  expect((await api('PATCH', `/api/bots/${id}/avatar`, { avatar: photo })).statusCode).toBe(200);
  expect((await snapshot()).bots[0]).toMatchObject({ id, name: 'EmojiBot', avatar: photo });
  expect((await api('PATCH', `/api/bots/${id}/avatar`, { avatar: null })).statusCode).toBe(200);
  expect((await snapshot()).bots[0]).toMatchObject({ id, name: 'EmojiBot', avatar: null });
  expect(
    instance.store.db.prepare('SELECT * FROM bot_avatars WHERE bot_id=?').get(id),
  ).toBeUndefined();
});

it.each(['🤖', '🧑‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '❤️', '👍🏽'])('accepts the single emoji %s', (value) => {
  expect(botAvatarSchema.safeParse({ type: 'emoji', value }).success).toBe(true);
});

it.each([
  { type: 'emoji', value: 'not-an-emoji' },
  { type: 'emoji', value: '🤖🚀' },
  { type: 'image', value: 'https://example.com/avatar.png' },
  { type: 'image', value: 'data:image/svg+xml;base64,PHN2Zz4=' },
  { type: 'image', value: 'data:image/png;base64,PGh0bWw+' },
  { type: 'image', value: 'data:image/jpeg;base64,' + 'A'.repeat(90000) },
])('rejects unsupported avatar case %# and keeps the saved avatar intact', async (avatar) => {
  const original = { type: 'emoji', value: '🦊' };
  const id = (
    await api('POST', '/api/bots', { name: 'SafeBot', provider: 'codex', avatar: original })
  ).json().id;
  expect((await api('PATCH', `/api/bots/${id}/avatar`, { avatar })).statusCode).toBe(400);
  expect((await snapshot()).bots[0].avatar).toEqual(original);
  expect(
    (await api('POST', '/api/bots', { name: 'RejectedBot', provider: 'codex', avatar })).statusCode,
  ).toBe(400);
  expect((await snapshot()).bots).toHaveLength(1);
});

it('requires authentication and a real bot for updates, and supports bots without a custom avatar', async () => {
  const id = (await api('POST', '/api/bots', { name: 'DefaultBot', provider: 'codex' })).json().id;
  expect((await snapshot()).bots[0].avatar).toBeNull();
  expect(
    (
      await instance.app.inject({
        method: 'PATCH',
        url: `/api/bots/${id}/avatar`,
        payload: { avatar: null },
      })
    ).statusCode,
  ).toBe(401);
  expect((await api('PATCH', '/api/bots/missing/avatar', { avatar: null })).statusCode).toBe(404);
  expect(
    (await api('PATCH', `/api/bots/${id}/avatar`, { avatar: null, provider: 'claude-code' }))
      .statusCode,
  ).toBe(400);
});
