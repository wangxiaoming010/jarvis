import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AgentJob, BridgeCommand, Message } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import type {
  CoordinatorModel,
  CoordinatorMessage,
} from '../../apps/server/src/models/coordinator-model';
import { TaskContracts } from '../../apps/server/src/work/task-contracts';
import { BotMemory } from '../../apps/server/src/memory/bot-memory';
import { buildTurnInput } from '../../apps/bridge/src/prompt';

const token = 'durable-work-test-owner-only';
const directories: string[] = [];
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
let commands: BridgeCommand[] = [];
const reply = (content = ''): CoordinatorMessage => ({ role: 'assistant', content });
const call = (name: string, args: object): CoordinatorMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});
const data = (messages: CoordinatorMessage[]) => JSON.parse(messages[1].content!);
const api = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
  instance!.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const jobs = () =>
  commands.filter((c): c is { type: 'run'; job: AgentJob } => c.type === 'run').map((c) => c.job);
const task = (id = jobs()[0].task.id) => instance!.store.snapshot().tasks.find((t) => t.id === id)!;
function accept(id: string) {
  const t = task(id);
  return call('finish_task', {
    taskId: id,
    verification: '核对真实结果',
    evidence: t.execution!.contract!.criteria.map((criterion) => ({
      criterion,
      source: 'result',
      quote: t.result!,
    })),
  });
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
function attach() {
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'test',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (c) => commands.push(c),
    () => instance?.runtime.detach('device'),
  );
}
async function setup(model?: CoordinatorModel, path?: string) {
  if (!path) {
    const d = mkdtempSync(join(tmpdir(), 'openbot-durable-'));
    directories.push(d);
    path = join(d, 'db.sqlite');
  }
  commands = [];
  instance = await createApp({
    databasePath: path,
    token,
    attention: async () => ({ wake: false }),
    coordinator:
      model ??
      (async (messages) => {
        if (messages.at(-1)?.role === 'tool') return reply();
        const d = data(messages);
        return d.event.kind === 'message'
          ? call('start_worker', { goal: d.event.message.content })
          : d.event.kind === 'completion' && d.event.facts.status === 'reviewing'
            ? accept(d.event.taskId)
            : reply();
      }),
  });
  attach();
  return path;
}
async function bot(name = 'BB') {
  return (await api('POST', '/api/bots', { name, provider: 'codex' })).json().id as string;
}
async function group(ids: string[]) {
  return (await api('POST', '/api/groups', { name: '架构验证', botIds: ids })).json().id as string;
}
async function send(g: string, content: string) {
  const r = await api('POST', '/api/messages', { id: randomUUID(), groupId: g, content });
  expect(r.statusCode).toBe(201);
  return r.json() as Message;
}
function event(job: AgentJob, fields: Record<string, unknown>) {
  instance!.runtime.event('device', {
    taskId: job.task.id,
    leaseId: job.leaseId,
    ...fields,
    type: fields.type as string,
  });
}
async function finish(job: AgentJob, text = '产物已保存，实际测试通过') {
  event(job, { type: 'session', threadId: `native-${job.task.id}` });
  event(job, { type: 'started' });
  event(job, { type: 'result', status: 'completed', text });
  await idle();
}
afterEach(async () => {
  await instance?.app.close();
  instance = undefined;
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('requires evidence for new tasks and rejects missing or invented quotations before accepting the actual result', async () => {
  let proof: 'missing' | 'invented' | 'valid' = 'missing';
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const d = data(messages);
    if (d.event.kind === 'message' && !jobs().length)
      return call('start_worker', { goal: '修复错误', criteria: ['实际测试通过'] });
    const t = task();
    if (t.status !== 'reviewing') return reply();
    return call('finish_task', {
      taskId: t.id,
      verification: '检查',
      evidence:
        proof === 'missing'
          ? []
          : [
              {
                criterion: '实际测试通过',
                source: 'result',
                quote: proof === 'invented' ? '不存在的测试记录' : t.result!,
              },
            ],
    });
  });
  const g = await group([await bot()]);
  await send(g, '@BB 修复');
  await idle();
  await finish(jobs()[0]);
  expect(task().status).toBe('reviewing');
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM task_acceptance').get()).toEqual({
    n: 0,
  });
  proof = 'invented';
  await send(g, '@BB 验收');
  await idle();
  expect(task().status).toBe('reviewing');
  proof = 'valid';
  await send(g, '@BB 根据真实结果验收');
  await idle();
  expect(task().status).toBe('completed');
  expect(
    instance!.store.db.prepare('SELECT criterion,evidence FROM task_acceptance').get(),
  ).toEqual({ criterion: '实际测试通过', evidence: '产物已保存，实际测试通过' });
});

it('persists scheduled checks across restart, emits each wake once and never replays an unknown execution', async () => {
  const seen: string[] = [];
  const model: CoordinatorModel = async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const d = data(messages);
    seen.push(d.event.kind);
    return d.event.kind === 'message' ? call('start_worker', { goal: '持续跟进' }) : reply();
  };
  const path = await setup(model);
  const g = await group([await bot()]);
  await send(g, '@BB 跟进');
  await idle();
  const id = task().id,
    now = Date.now();
  new TaskContracts(instance!.store).plan(
    task(),
    {
      nextAction: '检查已有进展',
      waitCondition: '等待外部结果',
      nextWakeAt: new Date(now + 120000).toISOString(),
      deadline: new Date(now + 240000).toISOString(),
    },
    false,
  );
  await instance!.app.close();
  instance = undefined;
  await setup(model, path);
  await idle();
  instance!.runtime.checkProgress(now + 130000);
  await idle();
  instance!.runtime.checkProgress(now + 140000);
  await idle();
  expect(seen.filter((k) => k === 'goal')).toHaveLength(1);
  instance!.runtime.checkProgress(now + 250000);
  await idle();
  instance!.runtime.checkProgress(now + 260000);
  await idle();
  expect(seen.filter((k) => k === 'goal')).toHaveLength(2);
  expect(jobs()).toHaveLength(0);
  expect(task(id).execution!.health!.state).toBe('unknown');
});

it('routes a running task into the owner’s private chat without duplicating work or broadcasting its result', async () => {
  let id = '';
  await setup(async (messages) => {
    const d = data(messages);
    if (messages.at(-1)?.role === 'tool')
      return reply(d.event.kind === 'completion' ? '已完成。' : '');
    if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing')
      return accept(d.event.taskId);
    if (d.event.kind !== 'message') return reply();
    return id ? call('link_task', { taskId: id }) : call('start_worker', { goal: '修复项目' });
  });
  const b = await bot(),
    g = await group([b]);
  await send(g, '@BB 修复项目');
  await idle();
  id = task().id;
  const privateChat = (await api('POST', `/api/bots/${b}/chat`, {})).json().id;
  const source = await send(privateChat, '这件事在这里继续');
  await idle();
  expect(jobs()).toHaveLength(1);
  expect(task().originGroupId).toBe(g);
  expect(task().groupId).toBe(privateChat);
  await finish(jobs()[0]);
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([
    expect.objectContaining({ groupId: privateChat, replyTo: source.id, content: '已完成。' }),
  ]);
  expect(
    instance!.store.db
      .prepare('SELECT count(*) AS n FROM task_conversations WHERE task_id=?')
      .get(id),
  ).toEqual({ n: 2 });
  expect((await api('DELETE', `/api/groups/${g}`)).statusCode).toBe(200);
  expect(task(id).status).toBe('completed');
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('requires an explicit link before cross-chat modification and permits the same native session after linking', async () => {
  let id = '',
    link = false;
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') {
      const last = JSON.parse(messages.at(-1)!.content!);
      if (last.linked) return call('continue_task', { taskId: id, instruction: '在这里继续改进' });
      return reply();
    }
    const d = data(messages);
    if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing')
      return accept(d.event.taskId);
    return d.event.kind !== 'message'
      ? reply()
      : !id
        ? call('start_worker', { goal: '第一阶段' })
        : call(
            link ? 'link_task' : 'continue_task',
            link ? { taskId: id } : { taskId: id, instruction: '继续' },
          );
  });
  const b = await bot(),
    a = await group([b]),
    other = await group([b]);
  await send(a, '@BB 第一阶段');
  await idle();
  id = task().id;
  await finish(jobs()[0]);
  await send(other, '@BB 继续');
  await idle();
  expect(jobs()).toHaveLength(1);
  link = true;
  await send(other, '@BB 把这件事接到这里继续');
  await idle();
  expect(jobs()).toHaveLength(2);
  expect(jobs()[1].task.id).toBe(id);
  expect(jobs()[1].session?.threadId).toBe(`native-${id}`);
  expect(buildTurnInput(jobs()[1])).toContain('在这里继续改进');
});

it.each(['group', 'handoff', 'rework'])(
  'tracks peer acceptance and separate result acceptance with %s',
  async (mode) => {
    const handoff = mode === 'handoff';
    let reviews = 0;
    let bb = '',
      dev = '',
      parent = '',
      delegation = '';
    await setup(async (messages) => {
      const d = data(messages),
        last = messages.at(-1);
      if (last?.role === 'tool') {
        const result = JSON.parse(last.content!);
        if (d.bot.id === bb && result.state === 'completed') return accept(parent);
        return reply();
      }
      if (d.event.kind === 'message' && parent) return call('link_task', { taskId: parent });
      if (d.event.kind === 'message')
        return d.bot.id === bb
          ? call('start_worker', { goal: '完成方案', criteria: ['方案可用'] })
          : reply();
      if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing') {
        if (d.bot.id === dev) return accept(d.event.taskId);
        parent = d.event.taskId;
        return call('delegate_task', {
          taskId: parent,
          botId: dev,
          goal: '核查技术可行性',
          criteria: ['列出真实约束'],
        });
      }
      if (d.event.kind === 'delegation') {
        delegation = d.event.facts.id;
        if (d.event.eventType.startsWith('delegation:rework:'))
          return call('continue_task', {
            taskId: d.event.taskId,
            instruction: d.event.facts.feedback,
          });
        if (d.event.eventType.startsWith('delegation:offer:'))
          return call('respond_delegation', {
            delegationId: delegation,
            decision: 'accept',
            reason: '可以负责核查',
          });
        if (d.event.eventType.startsWith('delegation:result:'))
          return call('review_delegation', {
            delegationId: delegation,
            accept: mode !== 'rework' || reviews++ > 0,
            feedback: '已核对约束',
          });
      }
      return reply();
    });
    bb = await bot();
    dev = await bot('DEV');
    const g = await group([bb, dev]);
    await send(g, '@BB 完成方案');
    await idle();
    await finish(jobs()[0], '方案草稿与初步证据');
    expect(jobs()).toHaveLength(2);
    expect(task(parent).status).toBe('reviewing');
    expect(instance!.store.db.prepare('SELECT state FROM bot_delegations').get()).toEqual({
      state: 'accepted',
    });
    let destination = g;
    if (handoff) {
      destination = (await api('POST', `/api/bots/${bb}/chat`, {})).json().id;
      await send(destination, '把这项工作接到这里');
      await idle();
    }
    await finish(jobs()[1], '列出真实约束：接口只支持读取');
    if (mode === 'rework') {
      expect(jobs()).toHaveLength(3);
      expect(jobs()[2].task.id).toBe(jobs()[1].task.id);
      expect(task(parent).status).toBe('reviewing');
      await finish(jobs()[2], '列出真实约束并补充验证：接口只支持读取');
    }
    expect(instance!.store.db.prepare('SELECT state FROM bot_delegations').get()).toEqual({
      state: 'completed',
    });
    expect(task(parent).status).toBe('completed');
    expect(task(jobs()[1].task.id).botId).toBe(dev);
    expect(task(parent).groupId).toBe(destination);
    expect(
      instance!.store.db
        .prepare("SELECT group_id FROM dialogue_inbox WHERE kind LIKE 'delegation:result:%'")
        .get(),
    ).toEqual({ group_id: destination });
    expect(instance!.store.db.prepare('SELECT count(*) AS n FROM routing_decisions').get()).toEqual(
      {
        n: 0,
      },
    );
  },
);

it('cancels accepted delegated work when its parent is stopped', async () => {
  let bb = '',
    dev = '';
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const d = data(messages);
    if (d.event.kind === 'message')
      return d.bot.id === bb ? call('start_worker', { goal: '父目标' }) : reply();
    if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing')
      return call('delegate_task', {
        taskId: d.event.taskId,
        botId: dev,
        goal: '支持工作',
        criteria: ['有结果'],
      });
    if (d.event.eventType?.startsWith('delegation:offer:'))
      return call('respond_delegation', {
        delegationId: d.event.facts.id,
        decision: 'accept',
        reason: '负责',
      });
    return reply();
  });
  bb = await bot();
  dev = await bot('DEV');
  const g = await group([bb, dev]);
  await send(g, '@BB 父目标');
  await idle();
  await finish(jobs()[0]);
  instance!.runtime.stopTask(jobs()[0].task.id);
  await idle();
  expect(instance!.store.db.prepare('SELECT state FROM bot_delegations').get()).toEqual({
    state: 'cancelled',
  });
  expect(task(jobs()[1].task.id).status).toBe('cancelling');
  expect(commands).toContainEqual(
    expect.objectContaining({ type: 'cancel', taskId: jobs()[1].task.id }),
  );
});

it('retrieves older relevant memory, deduplicates facts and preserves correction and forgetting history', async () => {
  await setup(async () => reply());
  const b = await bot(),
    g = await group([b]),
    h = await group([b]);
  const source = await send(g, '@BB 我的名字叫小王');
  await idle();
  const memory = new BotMemory(instance!.store);
  const first = memory.save(b, g, source.id, {
    key: 'name',
    content: '用户叫小王',
    provenance: 'user',
  });
  for (let i = 0; i < 45; i++)
    memory.save(b, g, source.id, { key: `recent-${i}`, content: `项目记录 ${i}` });
  expect(memory.recall(b, h, '用户名字小王')).toContainEqual(
    expect.objectContaining({ id: first.memoryId, provenance: 'user' }),
  );
  expect(memory.save(b, g, source.id, { key: 'other-name', content: '用户叫小王' }).memoryId).toBe(
    first.memoryId,
  );
  expect(memory.recall(b, g, '小王')[0].provenance).toBe('user');
  expect(() => memory.save(b, g, source.id, { key: 'name', content: '用户可能叫小赵' })).toThrow(
    '冲突',
  );
  memory.save(b, g, source.id, {
    key: 'correct-name',
    content: '用户叫小李',
    replacesId: first.memoryId,
    provenance: 'user',
  });
  expect(memory.recall(b, h, '小王')).not.toContainEqual(
    expect.objectContaining({ content: '用户叫小王' }),
  );
  expect(memory.recall(b, h, '小李')).toContainEqual(
    expect.objectContaining({ id: first.memoryId }),
  );
  memory.forget(b, h, first.memoryId);
  expect(memory.recall(b, h, '小李')).toEqual([]);
  expect(
    instance!.store.db
      .prepare('SELECT count(*) AS n FROM bot_memory_revisions WHERE memory_id=?')
      .get(first.memoryId),
  ).toEqual({ n: 3 });
  const privateFact = memory.save(b, g, source.id, {
    key: 'private',
    content: '仅本群保密事实',
    scope: 'group',
  });
  expect(memory.recall(b, h, '保密')).toEqual([]);
  expect(() => memory.forget(b, h, privateFact.memoryId)).toThrow();
  memory.save(b, g, source.id, {
    key: 'expired',
    content: '已到期事实',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
  expect(memory.recall(b, g, '到期')).toEqual([]);
});

it('preempts an in-flight background model call for a direct human instruction and resumes safely', async () => {
  let blocked = false,
    aborted = false;
  await setup(async (messages, signal) => {
    const d = data(messages);
    if (messages.at(-1)?.role === 'tool') return reply();
    if (d.event.kind === 'message')
      return jobs().length
        ? reply('我在，先处理你的要求。')
        : call('start_worker', { goal: '后台工作' });
    if (d.event.kind === 'progress' && !blocked) {
      blocked = true;
      return new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('interrupted'));
          },
          { once: true },
        ),
      );
    }
    return reply();
  });
  const b = await bot(),
    g = await group([b]);
  await send(g, '@BB 开始');
  await idle();
  event(jobs()[0], { type: 'report', reportKind: 'blocked', report: '需要检查依赖' });
  await expect.poll(() => blocked).toBe(true);
  const privateChat = (await api('POST', `/api/bots/${b}/chat`, {})).json().id;
  await send(privateChat, '先回答我');
  await idle();
  expect(aborted).toBe(true);
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().messages).toContainEqual(
    expect.objectContaining({ groupId: privateChat, content: '我在，先处理你的要求。' }),
  );
  expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
});

it('serializes writers across different declared paths and permits independent read-only work', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool'
      ? reply()
      : data(messages).event.kind === 'message'
        ? call('start_worker', {
            goal: data(messages).event.message.content,
            resourceKey: data(messages).event.message.content.includes('读取')
              ? '/tmp/read-only'
              : data(messages).event.message.content.includes('第二')
                ? '/tmp/project-b'
                : '/tmp/project-a',
            resourceMode: data(messages).event.message.content.includes('读取')
              ? 'read'
              : 'exclusive',
          })
        : reply(),
  );
  const b = await bot(),
    g = await group([b]);
  await send(g, '@BB 第一项写入');
  await idle();
  await send(g, '@BB 第二项写入');
  await idle();
  expect(jobs()).toHaveLength(1);
  await send(g, '@BB 读取第三个目录');
  await idle();
  expect(jobs()).toHaveLength(2);
  expect(jobs()[1].resourceMode).toBe('read');
  event(jobs()[0], { type: 'result', status: 'completed', text: '写入已结束' });
  await idle();
  await expect.poll(() => jobs().length).toBe(3);
});

it('creates and retains a real Git worktree, checks its diff and never overwrites the original project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbot-worktree-source-'));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init');
  writeFileSync(join(root, 'file.txt'), 'original\n');
  git('add', 'file.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const d = data(messages);
    return d.event.kind === 'message'
      ? call('start_worker', {
          goal: '在独立副本修改',
          resourceKey: root,
          resourceMode: 'worktree',
        })
      : d.event.kind === 'completion' && d.event.facts.status === 'reviewing'
        ? accept(d.event.taskId)
        : reply();
  });
  const g = await group([await bot()]);
  await send(g, '@BB 在副本修改');
  await idle();
  const job = jobs()[0],
    workspace = job.task.execution!.workspace!;
  expect(existsSync(join(workspace.path, 'file.txt'))).toBe(true);
  writeFileSync(join(workspace.path, 'file.txt'), 'changed\n');
  await finish(job);
  expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original\n');
  expect(JSON.parse(task().execution!.workspace!.review!)).toMatchObject({
    integrated: false,
    changedFiles: 'M\tfile.txt',
  });
  expect(git('status', '--porcelain').trim()).toBe('');
});

it('keeps a device writer lease for unknown work until the owner explicitly reconciles that task', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]);
  await send(g, '@BB 第一项');
  await idle();
  const original = task().id;
  instance!.runtime.detach('device');
  await idle();
  attach();
  await send(g, '@BB 第二项');
  await idle();
  expect(jobs()).toHaveLength(1);
  instance!.runtime.resumeTask(
    original,
    '先核实，只补未完成部分',
    task(original).execution!.version,
  );
  await expect.poll(() => jobs().length).toBe(2);
  expect(jobs()[1].task.id).toBe(original);
  await finish(jobs()[1]);
  await expect.poll(() => jobs().length).toBe(3);
});

it('checks an earlier deadline independently of a later wake, preserves waits and forbids clearing acceptance criteria', async () => {
  const seen: string[] = [];
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return reply();
    const d = data(messages);
    if (d.event.kind === 'goal') seen.push(d.event.facts.reason);
    return d.event.kind === 'message' ? call('start_worker', { goal: '持续目标' }) : reply();
  });
  const g = await group([await bot()]);
  await send(g, '@BB 跟进');
  await idle();
  const contracts = new TaskContracts(instance!.store),
    now = Date.now();
  contracts.plan(
    task(),
    {
      waitCondition: '等待资料',
      deadline: new Date(now + 1000).toISOString(),
      nextWakeAt: new Date(now + 10000).toISOString(),
    },
    false,
  );
  contracts.plan(task(), { nextAction: '核实资料' }, false);
  expect(task().execution!.contract!.state).toBe('waiting');
  expect(() => contracts.plan(task(), { criteria: [] }, false)).toThrow('验收条件不能为空');
  instance!.runtime.checkProgress(now + 2000);
  await idle();
  instance!.runtime.checkProgress(now + 3000);
  await idle();
  expect(seen).toEqual(['deadline']);
  expect(task().execution!.contract!.nextWakeAt).toBe(new Date(now + 10000).toISOString());
  instance!.runtime.checkProgress(now + 11000);
  await idle();
  expect(seen).toEqual(['deadline', 'scheduled_check']);
  expect(jobs()).toHaveLength(1);
});

it.each(['stop', 'failed', 'cancelled'])(
  'notifies the requester immediately when delegated work becomes %s',
  async (outcome) => {
    let bb = '',
      dev = '';
    await setup(async (messages) => {
      if (messages.at(-1)?.role === 'tool') return reply();
      const d = data(messages);
      if (d.event.kind === 'message')
        return d.bot.id === bb ? call('start_worker', { goal: '父目标' }) : reply();
      if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing')
        return call('delegate_task', {
          taskId: d.event.taskId,
          botId: dev,
          goal: '支持工作',
          criteria: ['有结果'],
        });
      if (d.event.eventType?.startsWith('delegation:offer:'))
        return call('respond_delegation', {
          delegationId: d.event.facts.id,
          decision: 'accept',
          reason: '负责',
        });
      return reply();
    });
    bb = await bot();
    dev = await bot('DEV');
    await send(await group([bb, dev]), '@BB 父目标');
    await idle();
    await finish(jobs()[0]);
    if (outcome === 'stop') instance!.runtime.stopTask(jobs()[1].task.id);
    else event(jobs()[1], { type: 'result', status: outcome, text: '', error: '依赖不可用' });
    await idle();
    expect(instance!.store.db.prepare('SELECT state FROM bot_delegations').get()).toEqual({
      state: outcome === 'failed' ? 'accepted' : 'cancelled',
    });
    expect(
      instance!.store.db
        .prepare(
          `SELECT bot_id,task_id FROM dialogue_inbox WHERE kind LIKE 'delegation:${outcome === 'failed' ? 'blocked' : 'cancelled'}:%'`,
        )
        .get(),
    ).toEqual({ bot_id: bb, task_id: jobs()[0].task.id });
    expect(task(jobs()[0].task.id).status).toBe('reviewing');
  },
);

it('allows concurrent read-only work on the same resource without granting a writer lease', async () => {
  await setup(async (messages) =>
    messages.at(-1)?.role === 'tool'
      ? reply()
      : data(messages).event.kind === 'message'
        ? call('start_worker', {
            goal: '读取同一项目',
            resourceMode: 'read',
            resourceKey: '/tmp/shared-project',
          })
        : reply(),
  );
  const g = await group([await bot()]);
  await send(g, '@BB 第一项');
  await idle();
  await send(g, '@BB 第二项');
  await idle();
  expect(jobs()).toHaveLength(2);
  expect(jobs().every((job) => job.resourceMode === 'read')).toBe(true);
});

it('does not let planning revive a stopped contract even when cancellation ends as an unknown failure', async () => {
  await setup();
  await send(await group([await bot()]), '@BB 开始');
  await idle();
  const contracts = new TaskContracts(instance!.store),
    id = task().id;
  instance!.runtime.stopTask(id);
  await idle();
  const plan = { nextWakeAt: new Date(Date.now() + 3600000).toISOString() };
  expect(() => contracts.plan(task(id), plan, true)).toThrow('已停止');
  instance!.runtime.detach('device');
  await idle();
  expect(task(id).status).toBe('failed');
  expect(() => contracts.plan(task(id), plan, false)).toThrow('已停止');
  expect(task(id).execution!.contract!.state).toBe('cancelled');
});
