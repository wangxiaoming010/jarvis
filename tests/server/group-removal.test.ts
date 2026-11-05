import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentJob, BridgeCommand } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import type {
  CoordinatorMessage,
  CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';

const token = 'group-removal-isolated-owner-token';
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>>;
let jobs: AgentJob[];
const empty = (): CoordinatorMessage => ({ role: 'assistant', content: '' });
const call = (name: string, args: object): CoordinatorMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});
const api = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
  instance.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
async function idle() {
  await expect
    .poll(() =>
      instance.store.db
        .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
        .get(),
    )
    .toEqual({ n: 0 });
}
async function setup(model?: CoordinatorModel) {
  instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    coordinator:
      model ??
      (async (messages) => {
        if (messages.at(-1)?.role === 'tool') return empty();
        const d = JSON.parse(messages[1].content!);
        return d.event.kind === 'message'
          ? call('start_worker', { goal: '删除验收' })
          : d.event.kind === 'completion'
            ? call('finish_task', {
                taskId: d.event.taskId,
                verification: '实际结果已检查',
                evidence: [{ criterion: '删除验收', source: 'result', quote: '实际处理已完成' }],
              })
            : empty();
      }),
  });
  instance.runtime.attach(
    {
      id: 'device',
      name: 'test',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (c: BridgeCommand) => {
      if (c.type === 'run') jobs.push(c.job);
    },
    () => instance.runtime.detach('device'),
  );
  const botId = (await api('POST', '/api/bots', { name: 'BB', provider: 'codex' })).json()
    .id as string;
  const groupId = (await api('POST', '/api/groups', { name: '待删除群组', botIds: [botId] })).json()
    .id as string;
  return { botId, groupId };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-delete-'));
  jobs = [];
});
afterEach(async () => {
  await instance?.app.close();
  rmSync(directory, { recursive: true, force: true });
});

it('atomically deletes group history and execution records while preserving Bots, private chats and Bot memory', async () => {
  const { botId, groupId } = await setup();
  const other = (await api('POST', '/api/groups', { name: '保留群组', botIds: [botId] })).json().id;
  const privateChat = (await api('POST', `/api/bots/${botId}/chat`, {})).json().id;
  const message = (
    await api('POST', '/api/messages', { id: randomUUID(), groupId, content: '@BB 开始' })
  ).json();
  await idle();
  const job = jobs[0];
  const event = (type: string, fields: object = {}) =>
    instance.runtime.event('device', {
      type,
      taskId: job.task.id,
      leaseId: job.leaseId,
      ...fields,
    });
  event('session', { threadId: 'delete-fixture-session' });
  event('started');
  event('activity', { text: '正在检查', report: '已确认入口' });
  event('interaction', {
    requestId: 'question',
    request: {
      kind: 'question',
      title: '确认范围',
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '要检查哪部分？',
          options: [
            { label: '全部', description: '检查所有部分' },
            { label: '接口', description: '只检查接口' },
          ],
          allowOther: false,
        },
      ],
    },
  });
  await idle();
  event('result', { status: 'completed', text: '实际处理已完成' });
  await idle();
  expect(instance.store.snapshot().tasks[0].status).toBe('completed');
  const db = instance.store.db;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO bot_memory(id,bot_id,group_id,scope,key,content,source_message_id,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run('global', botId, null, 'bot', 'preference', '长期偏好', message.id, now);
  db.prepare(
    'INSERT INTO bot_memory(id,bot_id,group_id,scope,key,content,source_message_id,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run('local', botId, groupId, 'group', 'context', '群内事实', message.id, now);
  db.prepare('INSERT INTO conversation_memory VALUES(?,?,?,?)').run(
    botId,
    groupId,
    '旧对话摘要',
    now,
  );
  db.prepare('INSERT INTO agent_sessions(bot_id,group_id,thread_id) VALUES(?,?,?)').run(
    botId,
    groupId,
    'legacy-session',
  );
  db.prepare(
    "INSERT INTO ui_documents(message_id,group_id,bot_id,view_id,revision,document,policy) VALUES(?,?,?,?,1,'{}','{}')",
  ).run(message.id, groupId, botId, 'fixture');
  db.prepare("INSERT INTO ui_actions VALUES(?,?,?,'{}',?)").run('action', message.id, 'hash', now);
  db.prepare('INSERT INTO routing_decisions(message_id,status,created_at) VALUES(?,?,?)').run(
    message.id,
    'completed',
    now,
  );
  const response = await api('DELETE', `/api/groups/${groupId}`);
  expect(response.statusCode).toBe(200);
  const state = instance.store.snapshot();
  expect(state.groups.map((g) => g.id)).toEqual(expect.arrayContaining([other, privateChat]));
  expect(state.groups.some((g) => g.id === groupId)).toBe(false);
  expect(state.bots.map((b) => b.id)).toEqual([botId]);
  expect(state.messages).toHaveLength(0);
  expect(state.tasks).toHaveLength(0);
  for (const table of [
    'worker_reports',
    'task_health',
    'worker_runs',
    'task_workers',
    'task_pipelines',
    'task_pipeline_bindings',
    'pipeline_sessions',
    'native_requests',
    'task_session_delivery',
    'task_specs',
    'task_runtime',
    'task_changes',
    'coordinator_calls',
    'coordinator_turns',
    'dialogue_inbox',
    'attention_decisions',
    'ui_actions',
    'ui_documents',
    'routing_decisions',
    'conversation_memory',
    'agent_sessions',
  ])
    expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  expect(db.prepare('SELECT id,content,source_message_id FROM bot_memory').all()).toEqual([
    { id: 'global', content: '长期偏好', source_message_id: null },
  ]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(
    (await api('POST', '/api/messages', { id: randomUUID(), groupId, content: '已删除' }))
      .statusCode,
  ).toBe(404);
  await instance.app.close();
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  expect(instance.store.snapshot().groups.some((g) => g.id === groupId)).toBe(false);
  expect(instance.store.snapshot().bots).toHaveLength(1);
});

it('rejects deletion while execution or result acceptance is active without changing group data', async () => {
  const { groupId } = await setup();
  await api('POST', '/api/messages', { id: randomUUID(), groupId, content: '@BB 执行' });
  await idle();
  const before = instance.store.snapshot();
  expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(409);
  expect(instance.store.snapshot()).toEqual(before);
  instance.runtime.stopTask(jobs[0].task.id);
  expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(409);
  instance.runtime.event('device', {
    type: 'result',
    taskId: jobs[0].task.id,
    leaseId: jobs[0].leaseId,
    status: 'cancelled',
    text: '',
  });
  await idle();
  expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(200);
});

it('rejects deleting a group during a model call and allows it after the call settles', async () => {
  let release!: (value: CoordinatorMessage) => void;
  const { groupId } = await setup(
    async () =>
      new Promise<CoordinatorMessage>((resolve) => {
        release = resolve;
      }),
  );
  await api('POST', '/api/messages', { id: randomUUID(), groupId, content: '@BB 问题' });
  await expect.poll(() => Boolean(release)).toBe(true);
  expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(409);
  release(empty());
  await idle();
  expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(200);
});

it('requires authentication and keeps one-to-one chats out of the group deletion API', async () => {
  const { botId, groupId } = await setup();
  expect(
    (await instance.app.inject({ method: 'DELETE', url: `/api/groups/${groupId}` })).statusCode,
  ).toBe(401);
  const chat = (await api('POST', `/api/bots/${botId}/chat`, {})).json().id;
  expect((await api('DELETE', `/api/groups/${chat}`)).statusCode).toBe(409);
  expect((await api('DELETE', '/api/groups/missing')).statusCode).toBe(404);
});
