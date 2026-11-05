import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '@openbot/shared';
import { resolveMentions } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
const token = 'test-token-is-only-for-isolated-tests';
let instance: Awaited<ReturnType<typeof createApp>>;
let directory: string;
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return instance.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
async function snapshot() {
  return (await api('GET', '/api/snapshot')).json<Snapshot>();
}
async function bot(name = 'Alice') {
  return (await api('POST', '/api/bots', { name, provider: 'claude-code' })).json<{ id: string }>()
    .id;
}
async function group(botIds: string[] = [], name = 'Private') {
  return (await api('POST', '/api/groups', { name, botIds })).json<{ id: string }>().id;
}
async function message(groupId: string, content: string, extras: Record<string, unknown> = {}) {
  return api('POST', '/api/messages', { id: randomUUID(), groupId, content, ...extras });
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-test-'));
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  await instance.app.ready();
});
afterEach(async () => {
  await instance.app.close();
  rmSync(directory, { recursive: true, force: true });
});
describe('durable identities and message boundaries', () => {
  it('rejects unauthenticated clients and invalid inputs', async () => {
    expect((await instance.app.inject('/api/snapshot')).statusCode).toBe(401);
    expect(
      (await api('POST', '/api/bots', { name: 'invalid name', provider: 'codex' })).statusCode,
    ).toBe(400);
    expect((await api('POST', '/api/groups', { name: '' })).statusCode).toBe(400);
    expect((await message('missing', 'hello')).statusCode).toBe(404);
  });
  it('persists identities, memberships and human messages across a service restart', async () => {
    const b = await bot();
    const g = await group([b]);
    await message(g, 'A durable message');
    await instance.app.close();
    instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
    const data = await snapshot();
    expect(data).not.toHaveProperty('workspace');
    expect(data.bots[0]).not.toHaveProperty('workspaceId');
    expect(data.groups.find((x) => x.id === g)).not.toHaveProperty('workspaceId');
    expect((await api('PATCH', '/api/workspace', { name: 'Legacy' })).statusCode).toBe(404);
    expect(data.bots[0]).toMatchObject({ id: b, status: 'offline', bridgeId: null });
    expect(data.groups.find((x) => x.id === g)?.botIds).toEqual([b]);
    expect(data.messages[0].content).toBe('A durable message');
  });
  it('deduplicates a retried message without duplicating its offline event', async () => {
    const b = await bot();
    const g = await group([b]);
    const id = randomUUID();
    const input = { id, groupId: g, content: '@Alice 请审查', mentions: [b] };
    expect((await api('POST', '/api/messages', input)).statusCode).toBe(201);
    expect((await api('POST', '/api/messages', input)).statusCode).toBe(200);
    const data = await snapshot();
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1].senderType).toBe('system');
    expect(data.tasks).toHaveLength(0);
    expect(data.messages[1].content).toContain('暂时连不上本地');
    expect(
      (await api('POST', '/api/messages', { ...input, content: 'different' })).statusCode,
    ).toBe(409);
  });
  it('isolates replies and bot mentions by group', async () => {
    const b = await bot();
    const a = await group([b], 'A');
    const c = await group([], 'B');
    const sent = (await message(a, 'private A')).json();
    expect((await message(c, 'cross group reply', { replyTo: sent.id })).statusCode).toBe(400);
    expect((await message(c, '@Alice read A', { mentions: [b] })).statusCode).toBe(400);
    expect((await message(a, 'hello', { mentions: [b] })).statusCode).toBe(400);
    expect((await snapshot()).messages).toHaveLength(1);
  });
  it('validates membership changes and enforces unique bot names', async () => {
    const b = await bot();
    expect((await api('POST', '/api/bots', { name: 'alice', provider: 'codex' })).statusCode).toBe(
      409,
    );
    const g = await group();
    expect(
      (await api('PATCH', `/api/groups/${g}`, { name: 'New', botIds: ['missing'] })).statusCode,
    ).toBe(400);
    await api('PATCH', `/api/groups/${g}`, { name: 'New', botIds: [b, b] });
    expect((await snapshot()).groups.find((x) => x.id === g)?.botIds).toEqual([b]);
  });
  it('does not resolve name prefixes or bypass explicit membership with forged mentions', () => {
    const bots = [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: '小王' },
    ];
    expect(resolveMentions('@ALICE @Alice @小王 请看', bots)).toEqual(['a', 'b']);
    expect(resolveMentions('@AliceExtra', bots)).toEqual([]);
  });
});
describe('authenticated live synchronization', () => {
  it('broadcasts invalidation after a committed mutation', async () => {
    const ws = await instance.app.injectWS('/events');
    const frames: string[] = [];
    ws.on('message', (data) => frames.push(data.toString()));
    ws.send(JSON.stringify({ type: 'auth', token }));
    await expect.poll(() => frames.some((x) => JSON.parse(x).type === 'ready')).toBe(true);
    await group();
    await expect.poll(() => frames.some((x) => JSON.parse(x).type === 'invalidate')).toBe(true);
    ws.close();
  });
  it('rejects wrong WebSocket credentials and untrusted HTTP origins', async () => {
    const ws = await instance.app.injectWS('/events');
    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await closed).toBe(1008);
    const denied = await instance.app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { origin: 'https://untrusted.example', authorization: `Bearer ${token}` },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
