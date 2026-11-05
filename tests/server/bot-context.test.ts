import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore, type Store } from '../../apps/server/src/store';
import { BotContext, estimateContextTokens } from '../../apps/server/src/bot/bot-context';
import {
  createCoordinatorModel,
  type CoordinatorMessage,
  type ContextSummarizer,
} from '../../apps/server/src/models/coordinator-model';
import { removeGroup } from '../../apps/server/src/bot/group-removal';

let store: Store;
const directories: string[] = [];
const signal = () => new AbortController().signal;
const options = { windowTokens: 18000, reserveTokens: 3000, toolTokens: 500 };
function fixture(count = 1, content = (i: number) => `记录 ${i}`) {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-context-'));
  directories.push(dir);
  const path = join(dir, 'db.sqlite');
  store = createStore(path);
  for (const id of ['bob', 'star'])
    store.db
      .prepare(
        'INSERT INTO bots(id,owner_id,name,description,provider,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, 'user_local', id, '', 'codex', 'offline', new Date().toISOString());
  store.db
    .prepare('INSERT INTO groups VALUES(?,?,?,?)')
    .run('g', '项目群', '', new Date().toISOString());
  for (const id of ['bob', 'star'])
    store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run('g', id);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    store.insertMessage({
      id,
      groupId: 'g',
      senderId: 'user_local',
      senderType: 'human',
      content: content(i),
      mentions: [],
      replyTo: null,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: null,
    });
  }
  const source = ids.at(-1)!;
  const scope = { botId: 'bob', groupId: 'g', sourceMessageId: source, messageEvent: true };
  const base = {
    bot: { id: 'bob', name: 'Bob' },
    human: { id: 'user_local' },
    group: { id: 'g', name: '项目群' },
    event: { kind: 'message', message: { id: source, content: '保留当前请求，停止旧任务。' } },
    recentMessages: ids.slice(-12).map((id) => ({ id })),
  };
  const messages: CoordinatorMessage[] = [
    { role: 'system', content: 'Unified Bot identity and behavior. Keep policy unchanged.' },
    { role: 'user', content: JSON.stringify(base) },
  ];
  const inbox = randomUUID(),
    turn = randomUUID(),
    now = new Date().toISOString();
  store.db
    .prepare(
      'INSERT INTO dialogue_inbox(id,bot_id,group_id,source_message_id,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(inbox, 'bob', 'g', source, 'message', '{}', now);
  store.db
    .prepare(
      'INSERT INTO coordinator_turns(id,inbox_id,bot_id,messages,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(turn, inbox, 'bob', JSON.stringify(messages), now, now);
  return { path, ids, scope, base, messages, turn };
}
function toolBlock(id: string, result: string): CoordinatorMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'read_message', arguments: '{"messageId":"original"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}
function persist(turn: string, messages: CoordinatorMessage[]) {
  store.db
    .prepare('UPDATE coordinator_turns SET messages=? WHERE id=?')
    .run(JSON.stringify(messages), turn);
  for (const message of messages.filter((m) => m.tool_calls?.length)) {
    for (const call of message.tool_calls!) {
      const result = messages.find((m) => m.tool_call_id === call.id)!.content!;
      store.db
        .prepare('INSERT OR IGNORE INTO coordinator_calls VALUES(?,?,?,?,?,?)')
        .run(
          turn,
          call.id,
          call.function.name,
          call.function.arguments,
          result,
          new Date().toISOString(),
        );
    }
  }
}
function readAll(manager: BotContext, turn: string, callId?: string, contextDigest?: string) {
  let result = '',
    offset = 0;
  while (true) {
    const page = manager.read('bob', turn, callId, offset, contextDigest);
    result += page.content;
    if (page.nextOffset === null) return result;
    offset = page.nextOffset;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  store?.db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('keeps small contexts intact without making summarization calls or creating long-term memories', async () => {
  const f = fixture();
  const summarize = vi.fn<ContextSummarizer>();
  const manager = new BotContext(store, summarize, options);
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(prepared).toEqual(f.messages);
  expect(summarize).not.toHaveBeenCalled();
  expect(store.db.prepare('SELECT count(*) AS n FROM bot_memory').get()).toEqual({ n: 0 });
});

it('incrementally summarizes old history, preserves recent messages and reuses durable summaries after restart', async () => {
  const f = fixture(80, (i) => `人类记录 ${i}：${'目标、约束和未完成事项。'.repeat(20)}`);
  const summarize = vi.fn<ContextSummarizer>(async (input) => {
    expect(estimateContextTokens(input)).toBeLessThan(12000);
    return '人类提出项目目标，旧任务已停止。尚需验证结果。应按来源查阅约束。';
  });
  let manager = new BotContext(store, summarize, options);
  const first = JSON.parse(
    (await manager.prepare(f.turn, f.scope, f.messages, signal()))[1].content!,
  );
  expect(summarize.mock.calls.length).toBeLessThanOrEqual(2);
  expect(first.conversationSummary).toMatchObject({
    provisional: true,
    isLongTermMemory: false,
    fromMessageId: f.ids[0],
  });
  expect(first.historyArchive.incomplete).toBe(true);
  let next = first;
  for (let i = 0; i < 5 && next.historyArchive; i++)
    next = JSON.parse((await manager.prepare(f.turn, f.scope, f.messages, signal()))[1].content!);
  expect(next.historyArchive).toBeUndefined();
  expect(next.conversationSummary.throughMessageId).toBe(f.ids[67]);
  expect(next.recentMessages).toEqual(f.base.recentMessages);
  const calls = summarize.mock.calls.length;
  store.db.close();
  store = createStore(f.path);
  manager = new BotContext(store, summarize, options);
  const recovered = await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(JSON.parse(recovered[1].content!).conversationSummary).toEqual(next.conversationSummary);
  expect(summarize).toHaveBeenCalledTimes(calls);
  expect(store.snapshot().messages).toHaveLength(80);
  expect(store.db.prepare('SELECT count(*) AS n FROM bot_memory').get()).toEqual({ n: 0 });
});

it('invalidates a cached summary when original history changes and does not apply future summaries to an older event', async () => {
  const f = fixture(30, (i) => `人类记录 ${i} ${'背景信息'.repeat(70)}`);
  const summarize = vi.fn<ContextSummarizer>(async () => '有来源的旧摘要');
  const manager = new BotContext(store, summarize, options);
  await manager.prepare(f.turn, f.scope, f.messages, signal());
  const initial = summarize.mock.calls.length;
  store.db
    .prepare('UPDATE messages SET content=? WHERE id=?')
    .run('用户明确纠正：停止项目，不再继续。', f.ids[0]);
  await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(summarize.mock.calls.length).toBeGreaterThan(initial);
  expect(JSON.parse(summarize.mock.calls[initial][0]).previousSummary).toBe('');
  const early = await manager.prepare(
    f.turn,
    { ...f.scope, sourceMessageId: f.ids[8] },
    f.messages,
    signal(),
  );
  expect(JSON.parse(early[1].content!)).not.toHaveProperty('conversationSummary');
});

it('compacts completed tool exchanges in pairs while retaining the newest result and exact original receipts', async () => {
  const f = fixture();
  f.messages.push(
    ...toolBlock('first', 'Old requirements '.repeat(4000)),
    ...toolBlock('second', 'Tool result '.repeat(4000)),
    ...toolBlock('latest', 'Exact latest verification failed: missing tests.'),
  );
  persist(f.turn, f.messages);
  const original = store.db
    .prepare('SELECT messages FROM coordinator_turns WHERE id=?')
    .get(f.turn);
  const summarize = vi.fn<ContextSummarizer>(
    async () => '先前读取过要求与结果；尚未通过验收，需要读取原始证据。',
  );
  const manager = new BotContext(store, summarize, options);
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(estimateContextTokens(prepared) + manager.toolTokens).toBeLessThanOrEqual(
    manager.inputBudget,
  );
  expect(prepared[0]).toEqual(f.messages[0]);
  expect(JSON.parse(prepared[1].content!).event).toEqual(f.base.event);
  const summary = JSON.parse(prepared[2].content!).contextCompaction;
  expect(summary).toMatchObject({
    provisional: true,
    evidenceMustBeReadFromSource: true,
    archive: { turnId: f.turn, callIds: ['first', 'second'] },
  });
  expect(prepared.slice(-2)).toEqual(
    toolBlock('latest', 'Exact latest verification failed: missing tests.'),
  );
  expect(JSON.parse(readAll(manager, f.turn, 'first')).result).toBe(f.messages[3].content);
  expect(store.db.prepare('SELECT messages FROM coordinator_turns WHERE id=?').get(f.turn)).toEqual(
    original,
  );
  await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(summarize).toHaveBeenCalledTimes(1);
  store.db.close();
  store = createStore(f.path);
  const recovered = await new BotContext(store, summarize, options).prepare(
    f.turn,
    f.scope,
    f.messages,
    signal(),
  );
  expect(recovered).toEqual(prepared);
  expect(summarize).toHaveBeenCalledTimes(1);
});

it('can compact a single oversized latest result without orphaning a tool call or deleting its original content', async () => {
  const f = fixture();
  const result = '重要原始证据。'.repeat(18000);
  f.messages.push(...toolBlock('huge', result));
  persist(f.turn, f.messages);
  const manager = new BotContext(
    store,
    async () => '原始结果很长，引用证据前需查阅 huge。',
    options,
  );
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(prepared).toHaveLength(3);
  expect(JSON.parse(prepared[2].content!).contextCompaction.archive.callIds).toEqual(['huge']);
  expect(JSON.parse(readAll(manager, f.turn, 'huge')).result).toBe(result);
});

it('archives oversized context fields with immutable references while preserving the request and active task constraints', async () => {
  const f = fixture();
  const currentTask = {
    id: 'active',
    goal: '保留这个目标',
    status: 'reviewing',
    contract: { criteria: ['必须实测'], stopped: true },
  };
  const data = {
    ...f.base,
    liveState: {
      source: 'database',
      observedAt: new Date().toISOString(),
      refreshWith: ['get_self', 'list_conversations', 'get_conversation'],
      memoriesAreHistorical: true,
    },
    event: { ...f.base.event, taskId: 'active' },
    tasks: [currentTask],
    messagesSinceSource: [
      {
        id: 'new-peer-reply',
        actor: { id: 'star', type: 'bot' },
        content: 'Star 刚回复了重要结论。'.repeat(160),
      },
    ],
    memberships: Array.from({ length: 80 }, (_, i) => ({
      groupId: `group-${i}`,
      name: `group ${i}`,
      description: 'large background '.repeat(200),
    })),
  };
  f.messages[1].content = JSON.stringify(data);
  persist(f.turn, f.messages);
  const manager = new BotContext(store, undefined, options);
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal());
  const compacted = JSON.parse(prepared[1].content!);
  expect(compacted.currentTask).toEqual(currentTask);
  expect(compacted.liveState).toEqual(data.liveState);
  expect(compacted.event).toEqual(data.event);
  expect(compacted.messagesSinceSource).toEqual([
    expect.objectContaining({
      id: 'new-peer-reply',
      sourceExcerptOnly: true,
      retrieve: 'read_message',
    }),
  ]);
  expect(compacted.memberships).toMatchObject({
    archived: true,
    current: false,
    refreshWith: 'list_conversations',
    turnId: f.turn,
    tool: 'read_context',
  });
  expect(
    JSON.parse(readAll(manager, f.turn, undefined, compacted.memberships.contextDigest)),
  ).toEqual(data);
  expect(estimateContextTokens(prepared) + manager.toolTokens).toBeLessThanOrEqual(
    manager.inputBudget,
  );
});

it('falls back to explicitly incomplete excerpts if summarization fails without corrupting evidence', async () => {
  const f = fixture();
  f.messages.push(...toolBlock('failed-summary', 'Real result '.repeat(20000)));
  persist(f.turn, f.messages);
  const manager = new BotContext(
    store,
    async () => {
      throw new Error('upstream unavailable');
    },
    options,
  );
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(JSON.parse(prepared[2].content!).contextCompaction).toMatchObject({
    method: 'extractive',
    evidenceMustBeReadFromSource: true,
  });
  expect(JSON.parse(readAll(manager, f.turn, 'failed-summary')).result).toBe(f.messages[3].content);
  expect(store.db.prepare('SELECT count(*) AS n FROM bot_memory').get()).toEqual({ n: 0 });
});

it('discards an aborted summary and refreshes peer replies received while a successful summary was being made', async () => {
  const f = fixture();
  f.messages.push(...toolBlock('large', 'Output '.repeat(20000)));
  persist(f.turn, f.messages);
  const controller = new AbortController();
  const aborted = new BotContext(
    store,
    async () => {
      controller.abort();
      return 'must not persist';
    },
    options,
  );
  await expect(aborted.prepare(f.turn, f.scope, f.messages, controller.signal)).rejects.toThrow();
  expect(store.db.prepare('SELECT count(*) AS n FROM bot_context_compactions').get()).toEqual({
    n: 0,
  });
  let newReply: object | undefined;
  const manager = new BotContext(
    store,
    async () => {
      newReply = { id: 'peer', content: 'Star 已经回复了。' };
      return '工作摘要';
    },
    options,
  );
  const prepared = await manager.prepare(f.turn, f.scope, f.messages, signal(), () => [
    f.messages[0],
    { role: 'user', content: JSON.stringify({ ...f.base, messagesSinceSource: [newReply] }) },
  ]);
  expect(JSON.parse(prepared[1].content!).messagesSinceSource).toEqual([newReply]);
});

it('restricts archive retrieval to its Bot and current memberships and cleans summaries up with the conversation', async () => {
  const f = fixture(28, () => '历史记录'.repeat(100));
  f.messages[1].content = JSON.stringify({
    ...f.base,
    extraLargeBackground: 'background '.repeat(16000),
  });
  f.messages.push(...toolBlock('archived', 'Output '.repeat(20000)));
  persist(f.turn, f.messages);
  const manager = new BotContext(store, async () => '工作摘要', options);
  await manager.prepare(f.turn, f.scope, f.messages, signal());
  expect(store.db.prepare('SELECT count(*) AS n FROM bot_context_inputs').get()).toEqual({
    n: expect.any(Number),
  });
  expect(() => manager.read('star', f.turn)).toThrow('不属于自己');
  store.db.prepare('DELETE FROM group_bots WHERE group_id=? AND bot_id=?').run('g', 'bob');
  expect(() => manager.read('bob', f.turn)).toThrow('自己所在对话');
  store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run('g', 'bob');
  removeGroup(store, 'g');
  for (const table of ['bot_context_history', 'bot_context_compactions', 'bot_context_inputs'])
    expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

it.each(['deepseek', 'anthropic'] as const)(
  'uses the configured %s model for a separate tool-free summary request',
  async (provider) => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            provider === 'anthropic'
              ? {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: '人类叫 Winston，当前结果仍待验证。' }],
                }
              : {
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { role: 'assistant', content: '人类叫 Winston，当前结果仍待验证。' },
                    },
                  ],
                },
          ),
        ),
    );
    vi.stubGlobal('fetch', transport);
    const model = createCoordinatorModel({
      provider,
      baseUrl: 'https://model.test',
      model: 'configured-model',
      apiKey: 'test-key',
      enabled: true,
    })!;
    expect(await model.summarize!('input sources', signal())).toContain('Winston');
    const body = JSON.parse((transport.mock.calls[0] as any)[1].body);
    expect(body.model).toBe('configured-model');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(JSON.stringify(body)).not.toContain('test-key');
  },
);
