import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob, BridgeCommand } from '@openbot/shared';
import { buildTurnInput } from '../../apps/bridge/src/prompt';
import { createApp } from '../../apps/server/src/app';
import {
  createCoordinatorModel,
  type CoordinatorMessage,
  type CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';

const token = 'coordinator-test-client-token-only';
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
const directories: string[] = [];
let commands: BridgeCommand[] = [];
function reply(content = ''): CoordinatorMessage {
  return { role: 'assistant', content };
}
function call(name: string, args: object, id = randomUUID()): CoordinatorMessage {
  if (name === 'finish_task' && !('evidence' in args)) {
    const task = instance?.store
      .snapshot()
      .tasks.find((t) => t.id === (args as { taskId: string }).taskId);
    args = {
      ...args,
      evidence:
        task?.execution?.contract?.criteria.map((criterion) => ({
          criterion,
          source: 'result',
          quote: task.result?.slice(0, 1000) ?? '',
        })) ?? [],
    };
  }
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
function input(messages: CoordinatorMessage[]) {
  return JSON.parse(messages[1].content!);
}
const jobs = () =>
  commands.filter((c): c is { type: 'run'; job: AgentJob } => c.type === 'run').map((c) => c.job);
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return instance!.app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
}
async function setup(model: CoordinatorModel, path?: string) {
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), 'openbot-coordinator-'));
    directories.push(dir);
    path = join(dir, 'db.sqlite');
  }
  commands = [];
  instance = await createApp({
    databasePath: path,
    token,
    coordinator: model,
    attention: async (input) => ({ wake: input.message.actor.type === 'human' }),
  });
  instance.runtime.attach(
    {
      id: 'device',
      name: 'test-device',
      providers: [
        { provider: 'codex', available: true, version: 'test' },
        { provider: 'claude-code', available: true, version: 'test' },
      ],
    },
    (c) => commands.push(c),
    () => instance?.runtime.detach('device'),
  );
  return path;
}
async function bot(name = 'Bob') {
  const response = await api('POST', '/api/bots', { name, provider: 'codex' });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}
async function group(botIds: string[], name = 'team') {
  return (await api('POST', '/api/groups', { name, botIds })).json().id as string;
}
async function message(groupId: string, content: string, id = randomUUID()) {
  expect((await api('POST', '/api/messages', { id, groupId, content })).statusCode).toBe(201);
  return id;
}
async function idle() {
  await expect
    .poll(() =>
      instance!.store.db
        .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
        .get(),
    )
    .toEqual({ n: 0 });
}
function event(job: AgentJob, fields: Record<string, unknown>) {
  instance!.runtime.event('device', {
    taskId: job.task.id,
    leaseId: job.leaseId,
    ...fields,
    type: fields.type as string,
  });
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await instance?.app.close();
  instance = undefined;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('delivers each human message to every member without calling a group router, and allows independent silence', async () => {
  const model = vi.fn<CoordinatorModel>(async (messages) =>
    input(messages).bot.name === 'Bob' ? reply('由我负责。') : reply(),
  );
  await setup(model);
  const bob = await bot(),
    alice = await bot('Alice'),
    g = await group([bob, alice]);
  const id = await message(g, '@Bob 看一下方案');
  await idle();
  expect(model).toHaveBeenCalledTimes(2);
  const systemPrompt = model.mock.calls[0][0][0].content!;
  expect(systemPrompt).toContain('Otherwise end the event: call stay_silent by itself');
  expect(systemPrompt).toContain('never a note that you are staying quiet');
  expect(systemPrompt).toContain('Never show internal IDs');
  expect(systemPrompt).toContain('stop once the point is clear');
  // A first greeting with no ongoing work does not carry the acceptance and artifact rules.
  expect(systemPrompt).not.toContain('## Managing ongoing work');
  expect(input(model.mock.calls[0][0]).human).toMatchObject({ type: 'human', id: 'user_local' });
  expect(input(model.mock.calls[0][0]).group.participants).toHaveLength(3);
  expect(JSON.stringify(input(model.mock.calls[0][0]).event)).toContain('actor');
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([
    expect.objectContaining({ senderId: bob, content: '由我负责。', replyTo: id }),
  ]);
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM routing_decisions').get()).toEqual({
    n: 0,
  });
  expect(jobs()).toHaveLength(0);
});

it.each([
  ['（这条是回给 BB 的选择，我不接。）', false],
  ['（这条是找 BB 的，我不插话。）', false],
  ['这句是问 BB 的产品判断，我不插话；等产品方向定了、要评估技术可行性或做原型时我再接。', false],
  [' (这条是回给 BB 的选择，我不接。) ', false],
  ['我先不参与。', false],
  ['（保持沉默）', false],
  [
    '无需回复——这是 Bob 在催促用户做选择，并没有新的信息需要我处理；卡片已经在群里，等用户选定。',
    false,
  ],
  ['无须我再回复：没有需要我处理的变更，等用户确认。', false],
  ['不需要回应：我暂时不参与，等用户决定。', false],
  ['我不接这个任务，因为目前缺少项目目录。', true],
  ['无需回复——这封是垃圾邮件，直接删除。', true],
  ['无需回复——没有新的信息需要我处理。不过发现接口返回了 500，需要修复。', true],
  ['这条接口返回错误，需要检查鉴权配置。', true],
])(
  'publishes substantive answers but suppresses silence narration: %s',
  async (content, visible) => {
    await setup(async () => reply(content));
    const b = await bot();
    const g = await group([b]);
    await message(g, '这条消息怎么处理？');
    await idle();
    const replies = instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot');
    expect(replies).toHaveLength(visible ? 1 : 0);
    if (visible) expect(replies[0].content).toBe(content);
    expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
  },
);

it('excludes earlier Bot silence narration from context while preserving chat history', async () => {
  const model = vi.fn<CoordinatorModel>(async () => reply());
  await setup(model);
  const b = await bot();
  const g = await group([b]);
  await message(g, '先聊聊产品');
  await idle();
  const previous = instance!.store.snapshot().messages[0];
  const narration = '（这条是回给 BB 的选择，我不接。）';
  instance!.store.insertMessage({
    ...previous,
    id: randomUUID(),
    senderId: b,
    senderType: 'bot',
    content: narration,
    replyTo: previous.id,
    timestamp: new Date().toISOString(),
  });
  for (let i = 0; i < 14; i++)
    instance!.store.insertMessage({
      ...previous,
      id: randomUUID(),
      content: `后续正常讨论 ${i}`,
      timestamp: new Date().toISOString(),
    });
  await message(g, '继续');
  await idle();
  expect(input(model.mock.calls.at(-1)![0]).recentMessages).not.toContainEqual(
    expect.objectContaining({ content: narration }),
  );
  expect(JSON.stringify(input(model.mock.calls.at(-1)![0]))).not.toContain(narration);
  expect(instance!.store.snapshot().messages).toContainEqual(
    expect.objectContaining({ content: narration }),
  );
});

it('keeps Bot and human identities separate and lets a failed recipient retry without repeating successful replies', async () => {
  let failBob = true;
  const model = vi.fn<CoordinatorModel>(async (messages) => {
    const data = input(messages);
    if (data.bot.name === 'Bob' && failBob) throw new Error('回复模型暂不可用');
    return reply(data.bot.name === 'Alice' ? '我来回复你。' : '我来补上刚才的回复。');
  });
  await setup(model);
  const bob = await bot('Bob'),
    alice = await bot('Alice'),
    g = await group([bob, alice]);
  const source = await message(g, '你们好');
  await idle();
  const firstTurn = input(
    model.mock.calls.find(([messages]) => input(messages).bot.name === 'Alice')![0],
  );
  expect(firstTurn.human).toMatchObject({ id: 'user_local', type: 'human', displayName: '我' });
  expect(firstTurn.group.participants.map((p: { type: string }) => p.type)).toEqual([
    'human',
    'bot',
    'bot',
  ]);
  expect(firstTurn.event.actor).toMatchObject({ id: 'user_local', type: 'human' });
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([
    expect.objectContaining({ senderId: alice, content: '我来回复你。' }),
  ]);
  expect(instance!.store.snapshot().dialogueFailures).toEqual([
    expect.objectContaining({ botId: bob, messageId: source, error: '回复模型暂不可用' }),
  ]);
  failBob = false;
  expect(instance!.runtime.retryMessage(source, bob)).toEqual({ ok: true, retried: true });
  await idle();
  expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toHaveLength(2);
  expect(
    instance!.store.snapshot().messages.some((m) => m.content === '我来补上刚才的回复。'),
  ).toBe(true);
});

it('serializes one Bot across groups while another Bot can answer independently', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  await setup(async (messages) => {
    const data = input(messages);
    seen.push(`${data.bot.name}:${data.group.name}`);
    if (data.bot.name === 'Bob' && data.group.name === 'first') await gate;
    return reply();
  });
  const bob = await bot(),
    alice = await bot('Alice');
  const first = await group([bob], 'first'),
    second = await group([bob, alice], 'second');
  await message(first, '第一条');
  await message(second, '第二条');
  await expect.poll(() => seen.includes('Alice:second')).toBe(true);
  expect(seen).not.toContain('Bob:second');
  release();
  await idle();
  expect(seen).toContain('Bob:second');
});

it('starts work without exposing execution provider choices and accepts only reviewed results', async () => {
  await setup(async (messages) => {
    const data = input(messages);
    if (data.event.kind === 'completion') {
      if (messages.at(-1)?.role === 'tool') return reply('已核对实际验证结果，这部分完成了。');
      return call('finish_task', {
        taskId: data.event.taskId,
        verification: '原生执行报告给出了实际检查证据，与目标一致。',
      });
    }
    if (messages.at(-1)?.role === 'tool') return reply('我在处理。');
    if (data.event.message.content === '聊一下') return reply('可以，执行中的工作会继续。');
    return call('start_worker', {
      goal: data.event.message.content,
      resourceMode: 'read',
      resourceKey:
        data.event.message.content === 'A' ? '/tmp/openbot-project-a' : '/tmp/openbot-project-b',
    });
  });
  const g = await group([await bot()]);
  await message(g, 'A');
  await idle();
  await message(g, 'B');
  await idle();
  await expect.poll(() => jobs().length).toBe(2);
  expect(jobs().map((j) => j.bot.provider)).toEqual(['codex', 'codex']);
  expect(jobs().every((j) => j.session === null)).toBe(true);
  expect(jobs().every((j) => j.permissionMode === 'auto')).toBe(true);
  expect(jobs().map((j) => j.executionDirectory)).toEqual([
    '/tmp/openbot-project-a',
    '/tmp/openbot-project-b',
  ]);
  await message(g, '聊一下');
  await idle();
  expect(
    instance!.store.snapshot().messages.some((m) => m.content === '可以，执行中的工作会继续。'),
  ).toBe(true);
  event(jobs()[0], { type: 'result', status: 'completed', text: '内部执行报告：实际检查通过。' });
  expect(instance!.store.snapshot().tasks[0].status).toBe('reviewing');
  await idle();
  expect(instance!.store.snapshot().tasks[0].status).toBe('completed');
  expect(
    instance!.store.snapshot().messages.some((m) => m.content === '内部执行报告：实际检查通过。'),
  ).toBe(false);
  expect(
    instance!.store.db
      .prepare('SELECT review FROM task_workers WHERE task_id=?')
      .get(jobs()[0].task.id),
  ).toEqual({ review: 'accepted' });
});

it('serializes shared and ancestor resources across Bots and applies device capacity', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool'
      ? reply()
      : input(messages).event.kind === 'message'
        ? call('start_worker', {
            goal: '处理明确的项目',
            resourceKey: input(messages).event.message.content,
          })
        : reply(),
  );
  const a = await bot(),
    b = await bot('Alice');
  const g = await group([a]),
    h = await group([b]);
  await message(g, '/tmp/same-project');
  await idle();
  await message(h, '/tmp/same-project/subdir');
  await idle();
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().tasks.map((t) => t.status)).toEqual(['running', 'queued']);
  event(jobs()[0], { type: 'result', status: 'completed', text: '返回实际结果' });
  await expect.poll(() => jobs().length).toBe(2);
});

it('does not expose provider switching when continuing the same task', async () => {
  await setup(async (messages) => {
    const data = input(messages);
    if (messages.at(-1)?.role === 'tool') return reply();
    if (data.event.kind === 'completion')
      return call('continue_task', {
        taskId: data.event.taskId,
        instruction: '审查已有改动，补齐缺少的测试。',
      });
    return call('start_worker', { goal: '完成实现并验证' });
  });
  await message(await group([await bot()]), '完成这件事');
  await idle();
  const first = jobs()[0];
  event(first, { type: 'session', threadId: 'codex-native-thread' });
  event(first, { type: 'result', status: 'completed', text: '修改了 main.ts，尚未补齐测试。' });
  await expect.poll(() => jobs().length).toBe(2);
  const second = jobs()[1];
  expect(second.task.id).toBe(first.task.id);
  expect(second.bot.provider).toBe('codex');
  expect(buildTurnInput(second)).toContain('审查已有改动');
  expect(
    instance!.store.db.prepare('SELECT provider,status FROM worker_runs ORDER BY rowid').all(),
  ).toEqual([
    { provider: 'codex', status: 'completed' },
    { provider: expect.any(String), status: 'running' },
  ]);
});

it('resumes an interrupted task only on an authenticated owner request, preserving its thread and task', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool' || input(messages).event.kind !== 'message'
      ? reply()
      : call('start_worker', { goal: '整理现有调研文件' }),
  );
  const b = await bot();
  const g = await group([b]);
  await message(g, '整理调研');
  await idle();
  const first = jobs()[0];
  event(first, { type: 'session', threadId: 'interrupted-research-thread' });
  event(first, { type: 'started' });
  instance!.runtime.detach('device');
  await idle();
  expect(instance!.store.snapshot().tasks[0].status).toBe('failed');
  const url = `/api/tasks/${first.task.id}/resume`;
  const payload = { instruction: '检查已有报告，仅补齐缺失来源。', expectedVersion: 1 };
  const chainCount = () =>
    instance!.store.db.prepare('SELECT count(*) AS n FROM collaboration_chains').get();
  const before = chainCount();
  expect((await instance!.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect((await api('POST', url, payload)).statusCode).toBe(409);
  expect(chainCount()).toEqual(before);
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'test-device',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (c) => commands.push(c),
    () => instance?.runtime.detach('device'),
  );
  expect((await api('POST', url, { ...payload, expectedVersion: 99 })).statusCode).toBe(409);
  expect(chainCount()).toEqual(before);
  instance!.store.db
    .prepare('UPDATE collaboration_chains SET calls=max_calls WHERE id=?')
    .run(first.task.correlationId);
  const messageCount = instance!.store.snapshot().messages.length;
  expect((await api('POST', url, payload)).statusCode).toBe(200);
  await expect.poll(() => jobs().length).toBe(2);
  const resumed = jobs()[1];
  expect(resumed.task.id).toBe(first.task.id);
  expect(resumed.leaseId).not.toBe(first.leaseId);
  expect(resumed.session?.threadId).toBe('interrupted-research-thread');
  expect(buildTurnInput(resumed)).toContain('先检查原会话、已有文件和实际完成情况');
  expect(buildTurnInput(resumed)).toContain(payload.instruction);
  expect(instance!.store.snapshot().tasks).toHaveLength(1);
  expect(instance!.store.snapshot().messages).toHaveLength(messageCount);
  expect((await api('POST', url, payload)).statusCode).toBe(409);
  expect(jobs()).toHaveLength(2);
});

it('never automatically resumes stopped work when completion wins a cancellation race', async () => {
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const data = input(messages);
    return data.event.kind === 'completion'
      ? call('continue_task', { taskId: data.event.taskId, instruction: '继续处理' })
      : call('start_worker', { goal: '开始处理' });
  });
  await message(await group([await bot()]), '开始');
  await idle();
  const job = jobs()[0];
  event(job, { type: 'session', threadId: 'native' });
  instance!.runtime.stopTask(job.task.id);
  event(job, { type: 'result', status: 'completed', text: '停止前实际完成的部分' });
  await idle();
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().tasks[0].status).toBe('cancelled');
  expect(instance!.store.snapshot().tasks[0].result).toBe('停止前实际完成的部分');
  const results = instance!.store.db
    .prepare("SELECT result FROM coordinator_calls WHERE name='continue_task'")
    .all() as { result: string }[];
  expect(results[0].result).toContain('停止');
});

it('rejects task access across Bot ownership and keeps exact source retrieval within the group', async () => {
  let foreign = '';
  await setup(async (messages) => {
    const data = input(messages);
    if (messages.at(-1)?.role === 'tool') return reply();
    return data.bot.name === 'Bob'
      ? call('start_worker', { goal: '原始工作' })
      : call('stop_task', { taskId: foreign });
  });
  const bob = await bot(),
    alice = await bot('Alice');
  const g = await group([bob]);
  await message(g, '开始');
  await idle();
  foreign = jobs()[0].task.id;
  await message(await group([alice]), '停止其他人的工作');
  await idle();
  expect(instance!.store.snapshot().tasks[0].status).toBe('running');
  expect(
    instance!.store.db.prepare("SELECT result FROM coordinator_calls WHERE name='stop_task'").get(),
  ).toEqual(expect.objectContaining({ result: expect.stringContaining('不属于') }));
});

it('recovers an interrupted model turn without duplicating already committed tool effects', async () => {
  let inFollowup = false;
  const path = await setup(async (messages, signal) => {
    if (messages.at(-1)?.role !== 'tool') return call('start_worker', { goal: '只执行一次' });
    inFollowup = true;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }),
    );
  });
  await message(await group([await bot()]), '执行一次');
  await expect.poll(() => inFollowup).toBe(true);
  expect(jobs()).toHaveLength(1);
  await instance!.app.close();
  instance = undefined;
  await setup(async () => reply(), path);
  await idle();
  expect(instance!.store.snapshot().tasks).toHaveLength(1);
  expect(instance!.store.snapshot().tasks[0].status).toBe('failed');
  expect(jobs()).toHaveLength(0);
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM coordinator_calls WHERE name='start_worker'")
      .get(),
  ).toEqual({ n: 1 });
  expect(instance!.store.db.prepare('SELECT status FROM worker_runs').get()).toEqual({
    status: 'unknown',
  });
});

it('retains the origin of group memories while allowing the same Bot to recall them across its conversations', async () => {
  let remember = true;
  const contexts: ReturnType<typeof input>[] = [];
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const data = input(messages);
    contexts.push(data);
    if (data.event.kind !== 'message') return reply();
    return remember
      ? call('remember', { key: 'constraint', content: '保留现有接口', scope: 'group' })
      : reply();
  });
  const b = await bot(),
    g = await group([b]);
  const id = await message(g, '保留现有接口');
  await idle();
  expect(
    instance!.store.db.prepare('SELECT content,source_message_id,scope FROM bot_memory').get(),
  ).toEqual({ content: '保留现有接口', source_message_id: id, scope: 'group' });
  remember = false;
  await message(g, '继续遵守这里的约束');
  await idle();
  expect(contexts.at(-1)?.memory).toContainEqual(
    expect.objectContaining({ key: 'constraint', scope: 'group', sourceMessageId: id }),
  );
  await message(await group([b], 'other'), '这里有什么约束？');
  await idle();
  expect(contexts.at(-1)?.memory).toContainEqual(
    expect.objectContaining({ key: 'constraint', groupId: g, scope: 'group', sourceMessageId: id }),
  );
});

it('shares only explicitly Bot-scoped durable preferences across groups', async () => {
  let remember = true;
  const contexts: ReturnType<typeof input>[] = [];
  await setup(async (messages) => {
    const data = input(messages);
    contexts.push(data);
    if (messages.at(-1)?.role === 'tool') return reply();
    if (remember)
      return call('remember', {
        key: 'response-style',
        content: '所有群都用简洁中文答复。',
        scope: 'bot',
      });
    return reply();
  });
  const b = await bot(),
    a = await group([b], 'A'),
    other = await group([b], 'B');
  await message(a, '用户偏好是简洁中文答复');
  await idle();
  remember = false;
  await message(other, '请介绍你的回复方式');
  await idle();
  expect(contexts.at(-1)?.memory).toContainEqual(
    expect.objectContaining({ key: 'response-style', scope: 'bot' }),
  );
  expect(contexts.at(-1)?.recentMessages).not.toContainEqual(
    expect.objectContaining({ content: '用户偏好是简洁中文答复' }),
  );
});

it('deduplicates stale progress checks, excludes pending permissions, and rechecks after new activity', async () => {
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    return input(messages).event.kind === 'message'
      ? call('start_worker', { goal: '后台检查' })
      : reply();
  });
  await message(await group([await bot()]), '检查');
  await idle();
  const job = jobs()[0];
  const updated = Date.parse(instance!.store.snapshot().tasks[0].execution!.updatedAt);
  event(job, {
    type: 'interaction',
    requestId: 'permission',
    request: { kind: 'tool', title: '确认读取范围' },
  });
  instance!.runtime.checkProgress(updated + 360000);
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'watchdog:%'")
      .get(),
  ).toEqual({ n: 0 });
  event(job, { type: 'interaction_resolved', requestId: 'permission' });
  instance!.runtime.checkProgress(updated + 360000);
  await idle();
  instance!.runtime.checkProgress(updated + 420000);
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'watchdog:%'")
      .get(),
  ).toEqual({ n: 1 });
  instance!.store.db
    .prepare('UPDATE task_specs SET updated_at=? WHERE task_id=?')
    .run(new Date(updated + 480000).toISOString(), job.task.id);
  instance!.runtime.checkProgress(updated + 900000);
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'watchdog:%'")
      .get(),
  ).toEqual({ n: 2 });
  expect(jobs()).toHaveLength(1);
});

it('keeps bounded Bot-to-Bot discussion separate from native execution', async () => {
  await setup(async (messages) =>
    reply(input(messages).bot.name === 'Bob' ? '@Alice 请看这个问题' : '@Bob 有一个补充'),
  );
  const g = await group([await bot(), await bot('Alice')]);
  await message(g, '@Bob 先讨论，不执行');
  await idle();
  const botReplies = instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot');
  expect(botReplies.length).toBeGreaterThan(2);
  expect(botReplies.length).toBeLessThanOrEqual(15);
  expect(jobs()).toHaveLength(0);
});

it('limits repeated autonomous execution even when the model keeps reworking the same goal', async () => {
  await setup(async (messages) => {
    const data = input(messages);
    if (messages.at(-1)?.role === 'tool') return reply();
    return data.event.kind === 'message'
      ? call('start_worker', { goal: '有限预算内验证' })
      : call('continue_task', { taskId: data.event.taskId, instruction: '再检查一次' });
  });
  await message(await group([await bot()]), '验证');
  await idle();
  instance!.store.db.prepare('UPDATE collaboration_chains SET max_calls=2').run();
  event(jobs()[0], { type: 'session', threadId: 'native' });
  event(jobs()[0], { type: 'result', status: 'completed', text: '实际结果' });
  await idle();
  await expect.poll(() => jobs().length).toBe(2);
  event(jobs()[1], { type: 'result', status: 'completed', text: '复核结果' });
  await idle();
  expect(jobs()).toHaveLength(2);
  const calls = instance!.store.db
    .prepare("SELECT result FROM coordinator_calls WHERE name='continue_task' ORDER BY rowid")
    .all() as { result: string }[];
  expect(calls.at(-1)!.result).toContain('执行预算');
});

it('queues for the selected tool instead of substituting another available provider', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool' ? reply() : call('start_worker', { goal: '读取验证' }),
  );
  instance!.runtime.detach('device');
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'Claude only',
      providers: [{ provider: 'claude-code', available: true, version: 'test' }],
    },
    (command) => commands.push(command),
    () => instance?.runtime.detach('device'),
  );
  const b = await bot();
  expect(instance!.store.snapshot().bots.find((x) => x.id === b)).toMatchObject({
    status: 'offline',
    provider: 'codex',
    bridgeId: null,
  });
  await message(await group([b]), '处理');
  await idle();
  expect(jobs()).toHaveLength(0);
  expect(instance!.store.snapshot().tasks[0]).toMatchObject({
    status: 'queued',
    execution: { provider: 'codex' },
  });
  instance!.runtime.detach('device');
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'Codex online',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (command) => commands.push(command),
    () => instance?.runtime.detach('device'),
  );
  await expect.poll(() => jobs().length).toBe(1);
  expect(jobs()[0].bot.provider).toBe('codex');
});

it('uses a saved Claude selection on a dual-provider device and supplies web research context', async () => {
  await setup(async (messages) => {
    const data = input(messages);
    expect(data.bot.executionTool).toBe('claude-code');
    expect(data.capabilities.join(' ')).toContain('联网搜索');
    expect(Number.isNaN(Date.parse(data.clock.now))).toBe(false);
    expect(data.clock.timeZone).toBeTruthy();
    expect(messages[0].content).toContain('do not ask the human to download news first');
    if (messages.at(-1)?.role === 'tool') return reply();
    return call('start_worker', {
      goal: '检索昨天的新闻，核实发布日期并附原文链接',
      resourceMode: 'read',
    });
  });
  const b = await bot();
  expect(
    (
      await api('PATCH', `/api/bots/${b}/execution`, {
        provider: 'claude-code',
        bridgeId: 'device',
      })
    ).statusCode,
  ).toBe(200);
  await message(await group([b]), '昨天有哪些新闻？');
  await idle();
  await expect.poll(() => jobs().length).toBe(1);
  expect(jobs()[0].bot.provider).toBe('claude-code');
  expect(jobs()[0].task.execution?.provider).toBe('claude-code');
  expect((await api('PATCH', `/api/bots/${b}/execution`, { provider: 'codex' })).statusCode).toBe(
    409,
  );
  expect(instance!.store.snapshot().bots[0].provider).toBe('claude-code');
});

it('gives each Bot shared sourced memory and a cross-conversation membership/task overview', async () => {
  const contexts: ReturnType<typeof input>[] = [];
  let shouldRemember = true;
  await setup(async (messages) => {
    const data = input(messages);
    contexts.push(data);
    if (messages.at(-1)?.role === 'tool') return reply();
    if (shouldRemember) return call('remember', { key: 'identity', content: '我负责代码审查。' });
    return reply();
  });
  const b = await bot();
  const firstGroup = await group([b], '项目群');
  await message(firstGroup, '记住我的职责');
  await idle();
  expect(instance!.store.db.prepare('SELECT scope,group_id FROM bot_memory').get()).toEqual({
    scope: 'bot',
    group_id: null,
  });
  shouldRemember = false;
  await message(await group([b], '另一个群'), '你加入了哪些群？');
  await idle();
  const context = contexts.at(-1)!;
  expect(context.memory).toContainEqual(expect.objectContaining({ key: 'identity', scope: 'bot' }));
  expect(context.memberships.map((membership: { name: string }) => membership.name)).toContain(
    '项目群',
  );
  expect(context.bot.executionTool).toBe('codex');
  expect(context).not.toHaveProperty('credentials');
});

it('uses official function calling with bounded output, no hidden provider credentials and no JSON-mode conflict', async () => {
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: call('list_tasks', {}) }],
        }),
      ),
  );
  vi.stubGlobal('fetch', transport);
  const model = createCoordinatorModel({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    enabled: true,
    apiKey: 'test-only-secret',
  })!;
  const result = await model([{ role: 'user', content: '查看进度' }], new AbortController().signal);
  expect(result.tool_calls?.[0].function.name).toBe('list_tasks');
  const request = JSON.parse(transport.mock.calls[0][1].body as string);
  expect(request.thinking).toEqual({ type: 'disabled' });
  expect(request.response_format).toBeUndefined();
  expect(
    request.tools.some((t: { function: { name: string } }) => t.function.name === 'start_worker'),
  ).toBe(true);
  expect(request.messages[0].content).not.toContain('test-only-secret');
});

it('uses one Bot identity to retrieve another conversation, extract sourced memory and contact a shared colleague', async () => {
  let bob = '',
    star = '',
    shared = '',
    privateChat = '',
    factId = '';
  let stage = 0;
  const results: any[] = [];
  const contexts: any[] = [];
  await setup(async (messages) => {
    const data = input(messages);
    contexts.push(data);
    if (data.bot.id !== bob || data.group.id !== privateChat) return reply();
    if (messages.at(-1)?.role === 'tool') results.push(JSON.parse(messages.at(-1)!.content!));
    switch (stage++) {
      case 0:
        return call('list_conversations', {});
      case 1:
        return call('search_messages', { query: 'Winston' });
      case 2:
        return call('read_message', { messageId: factId });
      case 3:
        return call('remember', {
          key: 'human-name',
          content: '用户叫 Winston',
          provenance: 'user',
          sourceMessageId: factId,
        });
      case 4:
        return call('recall_memory', { query: 'Winston' });
      case 5:
        return call('read_conversation', { groupId: shared, limit: 2 });
      case 6:
        return call('send_message', {
          groupId: shared,
          content: '用户让我告诉你，他叫 Winston。',
          mentionBotIds: [star],
        });
      default:
        return reply('已在学习英语的app群里告诉 Star。');
    }
  });
  bob = await bot();
  star = await bot('Star');
  shared = await group([bob, star], '学习英语的app');
  const history = await group([bob], '之前的聊天');
  factId = await message(history, '我叫 Winston。这个聊天里还讨论了无关的私人安排。');
  await idle();
  await api('POST', `/api/bots/${star}/chat`);
  privateChat = (await api('POST', `/api/bots/${bob}/chat`)).json().id;
  await message(privateChat, '去群里艾特 Star，告诉他我叫什么');
  await idle();
  expect(results[0].map((g: any) => g.groupId)).toEqual(
    expect.arrayContaining([shared, history, privateChat]),
  );
  expect(results[0]).not.toContainEqual(expect.objectContaining({ name: 'Star', direct: true }));
  expect(results[0].find((g: any) => g.groupId === shared).participants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'user_local', type: 'human' }),
      expect.objectContaining({ id: bob, name: 'Bob', type: 'bot' }),
      expect.objectContaining({ id: star, name: 'Star', type: 'bot' }),
    ]),
  );
  expect(results[1].messages).toContainEqual(
    expect.objectContaining({ id: factId, groupId: history }),
  );
  expect(results[2]).toMatchObject({ id: factId, actor: { type: 'human' } });
  expect(results[3]).toMatchObject({ saved: true });
  expect(results[4]).toContainEqual(
    expect.objectContaining({
      sourceMessageId: factId,
      provenance: 'user',
      content: '用户叫 Winston',
    }),
  );
  expect(results[6]).toMatchObject({ sent: true, groupId: shared, mentions: [star] });
  const posted = instance!.store.snapshot().messages.find((m) => m.id === results[6].messageId)!;
  expect(posted).toMatchObject({
    senderId: bob,
    senderType: 'bot',
    groupId: shared,
    mentions: [star],
    replyTo: null,
  });
  expect(posted.content).toBe('@Star 用户让我告诉你，他叫 Winston。');
  expect(posted.content).not.toContain('私人安排');
  expect(contexts).toContainEqual(
    expect.objectContaining({
      bot: expect.objectContaining({ id: star }),
      group: expect.objectContaining({ id: shared }),
      event: expect.objectContaining({ message: expect.objectContaining({ id: posted.id }) }),
    }),
  );
  expect(jobs()).toHaveLength(0);
});

it('searches and paginates full joined history, including messages the Bot never responded to', async () => {
  let target = '',
    current = '',
    old = '';
  let stage = 0;
  const results: any[] = [];
  await setup(async (messages) => {
    if (input(messages).group.id !== current) return reply();
    if (messages.at(-1)?.role === 'tool') results.push(JSON.parse(messages.at(-1)!.content!));
    switch (stage++) {
      case 0:
        return call('search_messages', { query: '早期约定', groupId: target, limit: 1 });
      case 1:
        return call('read_conversation', { groupId: target, limit: 20 });
      case 2:
        return call('read_conversation', {
          groupId: target,
          limit: 20,
          beforeMessageId: results[1].nextBeforeMessageId,
        });
      case 3:
        return call('read_message', { messageId: old, offset: 12000 });
      default:
        return reply();
    }
  });
  const b = await bot();
  target = await group([b], '历史记录');
  for (let i = 0; i < 26; i++) {
    const id = randomUUID();
    if (!i) old = id;
    instance!.store.insertMessage({
      id,
      groupId: target,
      senderId: 'user_local',
      senderType: 'human',
      content: i ? `后续记录 ${i}` : `早期约定 ${'x'.repeat(13000)} END`,
      mentions: [],
      replyTo: null,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: null,
    });
  }
  current = (await api('POST', `/api/bots/${b}/chat`)).json().id;
  await message(current, '查一下早期约定');
  await idle();
  expect(results[0].messages[0]).toMatchObject({ id: old, groupId: target, length: 13009 });
  expect(results[1].messages).toHaveLength(20);
  expect(results[2].messages).toHaveLength(6);
  expect(results[2].messages[0].id).toBe(old);
  expect(results[2].nextBeforeMessageId).toBeNull();
  expect(results[3].content).toContain('END');
  expect(
    instance!.store.db
      .prepare('SELECT count(*) AS n FROM dialogue_inbox WHERE group_id=?')
      .get(target),
  ).toEqual({ n: 0 });
});

it('checks membership for history, memory sources, destinations and mentioned colleagues', async () => {
  let current = '',
    foreign = '',
    foreignMessage = '',
    outsider = '';
  let stage = 0;
  const results: any[] = [];
  await setup(async (messages) => {
    if (input(messages).group.id !== current) return reply();
    if (messages.at(-1)?.role === 'tool') results.push(JSON.parse(messages.at(-1)!.content!));
    switch (stage++) {
      case 0:
        return call('read_conversation', { groupId: foreign });
      case 1:
        return call('read_message', { messageId: foreignMessage });
      case 2:
        return call('search_messages', { query: '秘密', groupId: foreign });
      case 3:
        return call('search_messages', { query: '秘密' });
      case 4:
        return call('remember', {
          key: 'foreign',
          content: '秘密',
          sourceMessageId: foreignMessage,
        });
      case 5:
        return call('send_message', { groupId: foreign, content: '越界发送' });
      case 6:
        return call('send_message', {
          groupId: current,
          content: '找你',
          mentionBotIds: [outsider],
        });
      case 7:
        return call('send_message', { groupId: current, content: '@Star 找你' });
      default:
        return reply();
    }
  });
  const bob = await bot();
  outsider = await bot('Star');
  foreign = (await api('POST', `/api/bots/${outsider}/chat`)).json().id;
  foreignMessage = await message(foreign, 'Star 的私聊秘密');
  await idle();
  current = await group([bob]);
  await message(current, '检查边界');
  await idle();
  for (const i of [0, 1, 2, 4, 5]) expect(results[i].error).toContain('自己所在的对话');
  expect(results[3].messages).toEqual([]);
  for (const i of [6, 7]) expect(results[i].error).toContain('目标对话');
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([]);
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM bot_memory').get()).toEqual({
    n: 0,
  });
});

it('can learn from another joined group without treating a colleague claim as a human fact', async () => {
  let current = '',
    claim = '';
  await setup(async (messages) => {
    if (input(messages).group.id !== current || messages.at(-1)?.role === 'tool') return reply();
    return call('remember', {
      key: 'identity',
      content: '用户叫 Alice',
      sourceMessageId: claim,
      provenance: 'user',
    });
  });
  const b = await bot(),
    other = await bot('Alice');
  const shared = await group([b, other]);
  claim = randomUUID();
  instance!.store.insertMessage({
    id: claim,
    groupId: shared,
    senderId: other,
    senderType: 'bot',
    content: '用户叫 Alice',
    mentions: [],
    replyTo: null,
    timestamp: new Date().toISOString(),
    messageType: 'text',
    correlationId: null,
  });
  current = (await api('POST', `/api/bots/${b}/chat`)).json().id;
  await message(current, '记住刚才的事');
  await idle();
  expect(
    instance!.store.db.prepare("SELECT result FROM coordinator_calls WHERE name='remember'").get(),
  ).toEqual({ result: expect.stringContaining('不能把同事') });
});

it('posts once across duplicate model tool requests and a coordinator restart', async () => {
  let current = '',
    destination = '',
    recipient = '';
  let sent = 0,
    waiting = false;
  const path = await setup(async (messages, signal) => {
    if (input(messages).group.id !== current) return reply();
    if (sent++ < 2)
      return call('send_message', {
        groupId: destination,
        content: '我来同步约定。',
        mentionBotIds: [recipient],
      });
    waiting = true;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }),
    );
  });
  const b = await bot();
  recipient = await bot('Star');
  destination = await group([b, recipient]);
  current = (await api('POST', `/api/bots/${b}/chat`)).json().id;
  await message(current, '去跟 Star 同步约定');
  await expect.poll(() => waiting).toBe(true);
  const messages = () =>
    instance!.store
      .snapshot()
      .messages.filter((m) => m.groupId === destination && m.senderId === b);
  expect(messages()).toHaveLength(1);
  await instance!.app.close();
  instance = undefined;
  await setup(async () => reply(), path);
  await idle();
  expect(messages()).toHaveLength(1);
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM coordinator_calls WHERE name='send_message'")
      .get(),
  ).toEqual({ n: 2 });
});

it('automatically compacts a growing real tool turn and retrieves archived evidence without replaying tools', async () => {
  let oldMessage = '',
    round = 0;
  const seen: CoordinatorMessage[][] = [];
  const summarize = vi.fn(async () => '已按页读取原始要求，尚未验证执行结果；引用时需回查原文。');
  const model: CoordinatorModel = Object.assign(
    async (messages: CoordinatorMessage[]) => {
      seen.push(structuredClone(messages));
      if (round < 3)
        return call('read_message', { messageId: oldMessage, offset: round++ * 12000 });
      if (round++ === 3) {
        const compacted = messages.find(
          (m, i) => i >= 2 && m.role === 'user' && m.content?.includes('contextCompaction'),
        )!;
        const archive = JSON.parse(compacted.content!).contextCompaction.archive;
        return call('read_context', { turnId: archive.turnId, callId: archive.callIds[0] });
      }
      return reply('已读取记录，接下来按原始要求处理。');
    },
    { summarize },
  );
  await setup(model);
  const b = await bot(),
    g = await group([b]);
  oldMessage = randomUUID();
  instance!.store.insertMessage({
    id: oldMessage,
    groupId: g,
    senderId: 'user_local',
    senderType: 'human',
    content: '完整的原始需求和证据。'.repeat(9000),
    mentions: [],
    replyTo: null,
    timestamp: new Date().toISOString(),
    messageType: 'text',
    correlationId: null,
  });
  const source = await message(g, '先分三页读原文，再回查已归档的证据。');
  await idle();
  expect(summarize).toHaveBeenCalled();
  expect(seen).toHaveLength(5);
  expect(seen.every((messages) => input(messages).event.message.id === source)).toBe(true);
  expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM coordinator_calls WHERE name='read_message'")
      .get(),
  ).toEqual({ n: 3 });
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM coordinator_calls WHERE name='read_context'")
      .get(),
  ).toEqual({ n: 1 });
  const archivedRead = instance!.store.db
    .prepare("SELECT result FROM coordinator_calls WHERE name='read_context'")
    .get() as { result: string };
  expect(JSON.parse(archivedRead.result).content).toContain('完整的原始需求和证据');
  expect(
    instance!.store.db.prepare('SELECT count(*) AS n FROM bot_context_compactions').get(),
  ).toEqual({ n: expect.any(Number) });
});

it('keeps ongoing work alive when staying silent and cannot skip a required result acceptance', async () => {
  let rejectedSilence = false;
  await setup(async (messages) => {
    const data = input(messages);
    const result =
      messages.at(-1)?.role === 'tool' ? JSON.parse(messages.at(-1)!.content!) : undefined;
    if (data.event.kind === 'completion') {
      if (result?.error?.includes('待验收')) {
        rejectedSilence = true;
        return call('finish_task', { taskId: data.event.taskId, verification: '已核对真实结果。' });
      }
      return call('stay_silent', {});
    }
    return result
      ? call('stay_silent', {})
      : call('start_worker', { goal: '核实原始结果', resourceMode: 'read' });
  });
  const b = await bot();
  await message(await group([b]), '核实原始结果');
  await idle();
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().tasks[0].status).toBe('running');
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([]);
  event(jobs()[0], {
    type: 'result',
    status: 'completed',
    text: '已读取并实测，原始结果符合要求。',
  });
  await idle();
  expect(rejectedSilence).toBe(true);
  expect(instance!.store.snapshot().tasks[0].status).toBe('completed');
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([]);
  expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
});

it('rejects publishing internal silence reasoning through an explicit message tool as well', async () => {
  let g = '';
  let rejection = '';
  await setup(async (messages) => {
    const result =
      messages.at(-1)?.role === 'tool' ? JSON.parse(messages.at(-1)!.content!) : undefined;
    if (result) {
      rejection = result.error;
      return call('stay_silent', {});
    }
    return call('send_message', {
      groupId: g,
      content:
        '无需回复——这是 Bob 在催促用户做选择，并没有新的信息需要我处理；卡片已经在群里，等用户选定。',
    });
  });
  g = await group([await bot()]);
  await message(g, '看看当前讨论');
  await idle();
  expect(rejection).toContain('stay_silent');
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([]);
});

it('captures owner permission mode per dispatch and leaves an already running assignment unchanged', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool'
      ? reply()
      : call('start_worker', {
          goal: input(messages).event.message.content,
          resourceMode: 'read',
          resourceKey: '/tmp',
        }),
  );
  const g = await group([await bot()]);
  await message(g, '第一项检查');
  await idle();
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0].permissionMode).toBe('auto');
  expect((await api('POST', '/api/settings/execution', { mode: 'manual' })).statusCode).toBe(200);
  await message(g, '第二项检查');
  await idle();
  expect(jobs()).toHaveLength(2);
  expect(jobs().map((job) => job.permissionMode)).toEqual(['auto', 'manual']);
});
