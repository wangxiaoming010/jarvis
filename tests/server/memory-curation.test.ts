import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob } from '@openbot/shared';
import { botInstructions } from '../../apps/bridge/src/instructions';
import { createApp } from '../../apps/server/src/app';
import { BotMemory } from '../../apps/server/src/memory/bot-memory';
import { coordinatorInstructions } from '../../apps/server/src/bot/bot-prompt';
import { createStore, type Store } from '../../apps/server/src/store';
import type {
  CoordinatorMessage,
  CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';
import type {
  CurationInput,
  MemoryCuratorModel,
} from '../../apps/server/src/memory/memory-curator';

const token = 'memory-curation-test-client-token';
const directories: string[] = [];
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
let store: Store | undefined;
afterEach(async () => {
  await instance?.app.close();
  instance = undefined;
  store?.db.close();
  store = undefined;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-curation-'));
  directories.push(dir);
  return join(dir, 'db.sqlite');
}
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return instance!.app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
}
async function bot(name: string) {
  return (await api('POST', '/api/bots', { name, provider: 'codex' })).json().id as string;
}
async function message(groupId: string, content: string) {
  const id = randomUUID();
  expect((await api('POST', '/api/messages', { id, groupId, content })).statusCode).toBe(201);
  return id;
}
function human(s: Store, id: string, content: string, timestamp: string) {
  s.insertMessage({
    id,
    groupId: 'g',
    senderId: 'user_local',
    senderType: 'human',
    content,
    mentions: [],
    replyTo: null,
    timestamp,
    messageType: 'text',
    correlationId: null,
  });
}
const rows = () =>
  instance!.store.db
    .prepare('SELECT bot_id,message_id,status,saved FROM memory_curation ORDER BY created_at')
    .all() as { bot_id: string; message_id: string; status: string; saved: number }[];

it('keeps preferences human-sourced and never lets curation undo a later correction or deletion', () => {
  store = createStore(path());
  store.db
    .prepare(
      'INSERT INTO bots(id,owner_id,name,description,provider,status,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run('bob', 'user_local', 'Bob', '', 'codex', 'offline', new Date().toISOString());
  store.db.prepare('INSERT INTO groups VALUES(?,?,?,?)').run('g', '项目群', '', '2026-01-01');
  store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run('g', 'bob');
  const memory = new BotMemory(store);
  human(store, 'old', '以后回答简洁一点', '2026-01-01T00:00:00.000Z');
  store.insertMessage({
    id: 'peer',
    groupId: 'g',
    senderId: 'bob',
    senderType: 'bot',
    content: '用户喜欢长回答',
    mentions: [],
    replyTo: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    messageType: 'text',
    correlationId: null,
  });
  expect(() =>
    memory.save('bob', 'g', 'peer', {
      key: '回答长度',
      content: '用户喜欢长回答',
      kind: 'preference',
    }),
  ).toThrow('长期偏好只能来自用户亲口表达');

  const saved = memory.save('bob', 'g', 'old', {
    key: '回答长度',
    content: '用户希望回答简洁',
    kind: 'preference',
    provenance: 'user',
  });
  expect(memory.preferences('bob')).toEqual([
    expect.objectContaining({ id: saved.memoryId, kind: 'preference', provenance: 'user' }),
  ]);
  // An inference cannot quietly keep a preference alive under non-human provenance.
  expect(() =>
    memory.save('bob', 'g', 'peer', {
      key: '回答长度',
      content: '用户其实喜欢长回答',
      provenance: 'inference',
      replacesId: saved.memoryId,
    }),
  ).toThrow('长期偏好只能来自用户亲口表达');

  // The memory was written after the old message, so a delayed review of it must not overwrite it.
  expect(() =>
    memory.save(
      'bob',
      'g',
      'old',
      { key: '回答长度', content: '用户希望回答详细', kind: 'preference', provenance: 'user' },
      { curated: true },
    ),
  ).toThrow('不再自动改写');
  memory.forget('bob', 'g', saved.memoryId);
  expect(() =>
    memory.save(
      'bob',
      'g',
      'old',
      { key: '回答长度', content: '用户希望回答简洁', kind: 'preference', provenance: 'user' },
      { curated: true },
    ),
  ).toThrow('不再自动改写');
  expect(memory.preferences('bob')).toEqual([]);

  // Saying it again after the deletion is a new human statement and may restore it.
  human(store, 'again', '还是简洁一点吧', new Date(Date.now() + 1000).toISOString());
  memory.save(
    'bob',
    'g',
    'again',
    { key: '回答长度', content: '用户希望回答简洁', kind: 'preference', provenance: 'user' },
    { curated: true },
  );
  expect(memory.preferences('bob')).toEqual([
    expect.objectContaining({ id: saved.memoryId, content: '用户希望回答简洁' }),
  ]);
});

it('curates unanswered human messages after the Bot settles, and injects preferences separately from facts', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const contexts: CoordinatorMessage[][] = [];
  const coordinator = vi.fn<CoordinatorModel>(async (messages) => {
    contexts.push(messages);
    await held;
    return { role: 'assistant', content: '你好！' };
  });
  const reviews: CurationInput[] = [];
  const curator = vi.fn<MemoryCuratorModel>(async (input) => {
    reviews.push(input);
    const source = input.conversations
      .flatMap((c) => c.messages)
      .find((m) => m.review && m.content.includes('以后'));
    if (input.bot.name !== 'Bob' || !source) return { memories: [] };
    return {
      memories: [
        {
          sourceMessageId: source.id,
          kind: 'preference',
          key: '回答方式',
          content: '用户希望回答先给结论，尽量简洁',
          importance: 3,
        },
        {
          sourceMessageId: source.id,
          kind: 'fact',
          key: '密钥',
          content: 'sk-' + 'x'.repeat(24),
        },
        { sourceMessageId: 'not-in-batch', kind: 'fact', key: '伪造', content: '来源不在本批' },
      ],
    };
  });
  instance = await createApp({
    databasePath: path(),
    token,
    coordinator,
    // Unaddressed group chatter does not wake anyone; memory curation must not depend on it.
    attention: async () => ({ wake: false }),
    memoryCuration: { model: curator, delayMs: 5 },
  });
  const bob = await bot('Bob'),
    alice = await bot('Alice');
  const g = (await api('POST', '/api/groups', { name: 'team', botIds: [bob, alice] })).json()
    .id as string;

  const preference = await message(g, '以后回答都先给结论，简洁一点');
  await message(g, '好');
  await expect.poll(() => rows().filter((r) => r.status === 'completed').length).toBe(2);
  expect(coordinator).not.toHaveBeenCalled();
  // One-character acknowledgements are not reviewed at all.
  expect(rows().map((r) => r.message_id)).toEqual([preference, preference]);
  expect(rows().find((r) => r.bot_id === bob)?.saved).toBe(1);
  const bobReview = reviews.find((r) => r.bot.id === bob)!;
  expect(bobReview.conversations[0].messages).toEqual([
    expect.objectContaining({
      id: preference,
      review: true,
      actor: { type: 'human', name: expect.any(String) },
    }),
  ]);
  const stored = instance.store.db
    .prepare('SELECT bot_id,kind,provenance,source_message_id,content FROM bot_memory')
    .all();
  expect(stored).toEqual([
    {
      bot_id: bob,
      kind: 'preference',
      provenance: 'user',
      source_message_id: preference,
      content: '用户希望回答先给结论，尽量简洁',
    },
  ]);

  // While Bob is still handling an addressed message, curation of it waits for that turn.
  const greeting = await message(g, '@Bob 早上好呀');
  await expect.poll(() => contexts.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reviews.some((r) => r.bot.id === bob && JSON.stringify(r).includes(greeting))).toBe(false);
  const context = JSON.parse(contexts[0][1].content!);
  expect(context.standingPreferences).toEqual([
    expect.objectContaining({ content: '用户希望回答先给结论，尽量简洁' }),
  ]);
  expect(context.memory).toEqual([]);
  release();
  await expect
    .poll(() => rows().find((r) => r.bot_id === bob && r.message_id === greeting)?.status)
    .toBe('completed');
  // Bot replies are never curated as if the human had said them.
  expect(
    rows().every((r) =>
      instance!.store
        .snapshot()
        .messages.some((m) => m.id === r.message_id && m.senderType === 'human'),
    ),
  ).toBe(true);

  // Leaving a conversation ends learning from it.
  await api('PATCH', `/api/groups/${g}`, { name: 'team', description: '', botIds: [bob] });
  const later = await message(g, '以后周报发在周五');
  await expect
    .poll(() => rows().find((r) => r.bot_id === bob && r.message_id === later)?.status)
    .toBe('completed');
  expect(rows().some((r) => r.bot_id === alice && r.message_id === later)).toBe(false);
});

it('layers one shared character with event-specific responsibilities', () => {
  const base = { name: 'Bob', role: '设计师', humanLabel: 'Me' };
  const greeting = coordinatorInstructions({ ...base, event: 'message', activeWork: false });
  const review = coordinatorInstructions({ ...base, event: 'completion', activeWork: false });
  const followUp = coordinatorInstructions({ ...base, event: 'message', activeWork: true });
  expect(greeting).toContain('## Character');
  expect(greeting).toContain('设计师');
  expect(greeting).not.toContain('## Managing ongoing work');
  expect(review).toContain('## Managing ongoing work');
  expect(review).toContain('A worker run finished');
  expect(followUp).toContain('## Managing ongoing work');
  const executor = botInstructions({
    bot: { id: 'b', name: 'Bob', description: '设计师' },
    members: [],
    task: {},
  } as unknown as AgentJob);
  // The executor shares the same character, then adds its own part.
  expect(executor).toContain('## Character');
  expect(executor).toContain('## Your part as executor');
});
