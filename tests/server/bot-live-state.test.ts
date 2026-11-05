import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { BotConversations } from '../../apps/server/src/bot/bot-conversations';
import {
  liveStateInstructions,
  type CoordinatorMessage,
  type CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';

const token = 'bot-live-state-test-only';
let instance: Awaited<ReturnType<typeof createApp>>;
let directory: string;
const empty = (): CoordinatorMessage => ({ role: 'assistant', content: '' });
async function setup(coordinator: CoordinatorModel = async () => empty()) {
  directory = mkdtempSync(join(tmpdir(), 'openbot-live-state-'));
  instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    coordinator,
    attention: async () => ({ wake: false }),
  });
}
async function api(method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await instance.app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBeLessThan(300);
  return response.json();
}
const bot = async (name: string) =>
  (await api('POST', '/api/bots', { name, provider: 'codex' })).id;
const group = async (name: string, botIds: string[]) =>
  (await api('POST', '/api/groups', { name, botIds })).id;
async function idle() {
  await expect
    .poll(() =>
      instance.store.db
        .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
        .get(),
    )
    .toEqual({ n: 0 });
}
afterEach(async () => {
  await instance?.app.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('keeps stable IDs while queries reflect profile, group, membership and deletion changes across restart', async () => {
  await setup();
  const bob = await bot('Bob');
  const star = await bot('Star');
  const shared = await group('项目群', [bob, star]);
  const privateChat = (await api('POST', `/api/bots/${bob}/chat`)).id;
  const foreign = (await api('POST', `/api/bots/${star}/chat`)).id;
  let conversations = new BotConversations(instance.store);
  const initial = conversations.self(bob);
  expect(initial).toMatchObject({ id: bob, name: 'Bob', executionTool: 'codex' });
  expect(initial.conversations.map((g) => g.groupId)).toEqual([shared, privateChat]);
  expect(initial.conversations.map((g) => g.groupId)).not.toContain(foreign);

  await api('PATCH', `/api/groups/${shared}`, {
    name: '产品项目',
    description: '更新后的职责',
    botIds: [bob, star],
  });
  await api('PATCH', `/api/bots/${bob}/execution`, { provider: 'claude-code' });
  expect(conversations.self(bob)).toMatchObject({ id: bob, executionTool: 'claude-code' });
  expect(conversations.info(bob, shared)).toMatchObject({
    groupId: shared,
    name: '产品项目',
    description: '更新后的职责',
    createdAt: initial.conversations[0].createdAt,
  });
  expect(conversations.info(bob, shared).participants.map((p) => p.id)).toEqual([
    'user_local',
    bob,
    star,
  ]);

  await api('PATCH', `/api/groups/${shared}`, { name: '产品项目', botIds: [star] });
  expect(conversations.list(bob).map((g) => g.groupId)).toEqual([privateChat]);
  expect(() => conversations.info(bob, shared)).toThrow('自己所在的对话');
  await api('PATCH', `/api/groups/${shared}`, { name: '产品项目', botIds: [bob] });
  expect(conversations.info(bob, shared).participants.map((p) => p.id)).toEqual([
    'user_local',
    bob,
  ]);
  await api('DELETE', `/api/groups/${shared}`);
  expect(conversations.list(bob).map((g) => g.groupId)).toEqual([privateChat]);
  expect(() => conversations.info(bob, shared)).toThrow('自己所在的对话');
  const recreated = await group('产品项目', [bob]);
  expect(recreated).not.toBe(shared);
  expect(conversations.info(bob, recreated)).toMatchObject({
    groupId: recreated,
    name: '产品项目',
  });
  // Earlier query receipts remain historical snapshots, not mutable live objects.
  expect(initial.conversations[0]).toMatchObject({ groupId: shared, name: '项目群' });

  await instance.app.close();
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  conversations = new BotConversations(instance.store);
  expect(conversations.self(bob)).toMatchObject({ id: bob, executionTool: 'claude-code' });
  expect(conversations.list(bob).map((g) => g.groupId)).toEqual([privateChat, recreated]);
  expect(conversations.self(bob).observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(() => conversations.info(bob, shared)).toThrow('自己所在的对话');
  expect(() => conversations.info(bob, foreign)).toThrow('自己所在的对话');
});

it('binds live-state tools to the calling Bot and refreshes memberships despite stale durable memory', async () => {
  let bob = '',
    star = '',
    shared = '',
    privateChat = '',
    foreign = '',
    recreated = '';
  let stage = 0;
  const contexts: any[] = [];
  const results: any[] = [];
  const call = (name: string, args: object = {}): CoordinatorMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  });
  await setup(async (messages) => {
    const data = JSON.parse(messages[1].content!);
    if (data.group.id !== privateChat) return empty();
    contexts.push(data);
    expect(messages[0].content).toContain(liveStateInstructions);
    if (messages.at(-1)?.role === 'tool') results.push(JSON.parse(messages.at(-1)!.content!));
    switch (stage++) {
      case 0:
        return call('get_self');
      case 1:
        return call('get_conversation', { groupId: shared });
      case 2:
        await api('DELETE', `/api/groups/${shared}`);
        recreated = await group('旧项目群', [bob]);
        return call('list_conversations');
      case 3:
        return call('get_conversation', { groupId: shared });
      case 4:
        return call('get_conversation', { groupId: foreign });
      case 5:
        return call('get_self', { botId: star });
      case 6:
        return call('get_self');
      default:
        return empty();
    }
  });
  bob = await bot('Bob');
  star = await bot('Star');
  shared = await group('旧项目群', [bob]);
  foreign = (await api('POST', `/api/bots/${star}/chat`)).id;
  privateChat = (await api('POST', `/api/bots/${bob}/chat`)).id;
  instance.store.db
    .prepare(
      'INSERT INTO bot_memory(id,bot_id,scope,key,content,updated_at,importance) VALUES(?,?,?,?,?,?,?)',
    )
    .run('stale-membership', bob, 'bot', '群组', '我仍在旧项目群中', new Date().toISOString(), 3);
  await api('POST', '/api/messages', {
    id: randomUUID(),
    groupId: privateChat,
    content: '查询我目前加入的群组和自己的资料。',
  });
  await idle();
  expect(results).toHaveLength(7);
  expect(results[0]).toMatchObject({ id: bob, name: 'Bob' });
  expect(results[0].conversations.map((g: any) => g.groupId)).toContain(shared);
  expect(results[1]).toMatchObject({ groupId: shared, name: '旧项目群' });
  expect(results[2].map((g: any) => g.groupId)).toEqual([privateChat, recreated]);
  for (const index of [3, 4]) expect(results[index].error).toContain('自己所在的对话');
  expect(results[5].error).toBe('工具参数不符合约定');
  expect(results[6]).toMatchObject({ id: bob, name: 'Bob' });
  expect(results[6].conversations.map((g: any) => g.groupId)).toEqual([privateChat, recreated]);
  const latest = contexts.at(-1);
  expect(latest.memberships.map((g: any) => g.groupId)).toEqual([privateChat, recreated]);
  expect(latest.liveState).toMatchObject({
    source: 'database',
    botId: bob,
    currentGroupId: privateChat,
    memoriesAreHistorical: true,
  });
  expect(latest.memory).toContainEqual(expect.objectContaining({ id: 'stale-membership' }));
});
