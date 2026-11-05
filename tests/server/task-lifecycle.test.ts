import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentJob, BridgeCommand, Message } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import { buildTurnInput } from '../../apps/bridge/src/prompt';
import type {
  CoordinatorMessage,
  CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';

const token = 'isolated-lifecycle-tests-token';
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
const directories: string[] = [];
let commands: BridgeCommand[] = [];
let requests = new Map<string, object>();
let model: ReturnType<typeof vi.fn<CoordinatorModel>>;
const empty = (): CoordinatorMessage => ({ role: 'assistant', content: '' });
const call = (name: string, args: object): CoordinatorMessage => {
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
    tool_calls: [
      { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  };
};
const data = (messages: CoordinatorMessage[]) => JSON.parse(messages[1].content!);
const jobs = () =>
  commands.filter((c): c is { type: 'run'; job: AgentJob } => c.type === 'run').map((c) => c.job);
const api = (url: string, payload: unknown) =>
  instance!.app.inject({
    method: 'POST',
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
const task = (id = jobs()[0].task.id) => instance!.store.snapshot().tasks.find((t) => t.id === id)!;
const event = (job: AgentJob, fields: Record<string, unknown>) =>
  instance!.runtime.event('device', {
    taskId: job.task.id,
    leaseId: job.leaseId,
    ...fields,
    type: fields.type as string,
  });
async function idle() {
  await expect
    .poll(() =>
      instance!.store.db
        .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
        .get(),
    )
    .toEqual({ n: 0 });
}
const bridge = () =>
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'test-device',
      providers: [
        { provider: 'codex', available: true, version: 'test' },
        { provider: 'claude-code', available: true, version: 'test' },
      ],
    },
    (command) => commands.push(command),
    () => instance?.runtime.detach('device'),
  );
async function setup(custom?: CoordinatorModel, path?: string) {
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), 'openbot-lifecycle-'));
    directories.push(dir);
    path = join(dir, 'db.sqlite');
  }
  requests = new Map();
  commands = [];
  model = vi.fn<CoordinatorModel>(
    custom ??
      (async (messages) => {
        if (messages.at(-1)?.role === 'tool') return empty();
        const d = data(messages);
        if (d.event.kind === 'completion')
          return d.event.facts.status === 'reviewing'
            ? call('finish_task', {
                taskId: d.event.taskId,
                verification: '已依据真实执行结果检查',
              })
            : empty();
        if (d.event.kind !== 'message') return empty();
        return call(
          'start_worker',
          requests.get(d.event.message.content) ?? { goal: d.event.message.content },
        );
      }),
  );
  instance = await createApp({
    databasePath: path,
    token,
    coordinator: model,
    attention: async () => ({ wake: false }),
  });
  bridge();
  return path;
}
async function bot(name = 'BB') {
  return (await api('/api/bots', { name, provider: 'codex' })).json().id as string;
}
async function group(ids: string[]) {
  return (await api('/api/groups', { name: '生命周期验证', botIds: ids })).json().id as string;
}
async function send(g: string, content: string) {
  const r = await api('/api/messages', { id: randomUUID(), groupId: g, content });
  expect(r.statusCode).toBe(201);
  return r.json() as Message;
}
async function launch(g: string, label = '开始', options: object = {}) {
  const text = `@BB ${label}`;
  requests.set(text, { goal: label, ...options });
  await send(g, text);
  await idle();
}
async function finish(job: AgentJob, thread = randomUUID()) {
  event(job, { type: 'session', threadId: thread });
  event(job, { type: 'started' });
  event(job, { type: 'result', status: 'completed', text: '真实产物与验证证据' });
  await idle();
}
afterEach(async () => {
  await instance?.app.close();
  instance = undefined;
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('creates a fresh pipeline for unrelated assignments even in the same directory', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g, '第一件事', { resourceKey: '/tmp/same-project' });
  const first = task();
  await finish(jobs()[0], 'pipeline-first');
  await launch(g, '另一件独立工作', { resourceKey: '/tmp/same-project' });
  expect(jobs()).toHaveLength(2);
  expect(jobs()[1].session).toBeNull();
  expect(jobs()[1].task.execution!.pipeline!.id).not.toBe(first.execution!.pipeline!.id);
});

it('assigns a related new task to an existing pipeline and delivers its full new assignment to the resumed session', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g, '调研');
  const pipeline = task().execution!.pipeline!.id;
  await finish(jobs()[0], 'shared-native-context');
  await launch(g, '基于调研制作原型', { pipelineId: pipeline });
  const next = jobs()[1];
  expect(next.task.id).not.toBe(jobs()[0].task.id);
  expect(next.task.execution!.pipeline!.id).toBe(pipeline);
  expect(next.session?.threadId).toBe('shared-native-context');
  expect(next.acceptedVersion).toBe(0);
  expect(buildTurnInput(next)).toContain('基于调研制作原型');
  event(next, { type: 'session', threadId: 'shared-native-context' });
  event(next, { type: 'started' });
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM pipeline_sessions').get()).toEqual({
    n: 1,
  });
});

it('serializes work in the same pipeline even when resource paths and device capacity permit parallel work', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g, '第一步', { resourceKey: '/tmp/resource-a' });
  const pipeline = task().execution!.pipeline!.id;
  await launch(g, '第二步', { pipelineId: pipeline, resourceKey: '/tmp/resource-b' });
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().tasks[1].status).toBe('queued');
  await finish(jobs()[0], 'serial-pipeline');
  await expect.poll(() => jobs().length).toBe(2);
  expect(jobs()[1].session?.threadId).toBe('serial-pipeline');
});

it('rejects foreign, cross-conversation, archived and nonexistent pipelines without orphan tasks', async () => {
  await setup();
  const bb = await bot(),
    dev = await bot('DEV');
  const g = await group([bb, dev]);
  await launch(g);
  const pipeline = task().execution!.pipeline!.id;
  await finish(jobs()[0]);
  for (const [id, chat] of [
    [pipeline, await group([bb])],
    ['does-not-exist', g],
  ] as const) {
    await launch(chat, randomUUID(), { pipelineId: id });
    expect(instance!.store.snapshot().tasks).toHaveLength(1);
  }
  requests.set('@DEV 接管', { goal: '接管', pipelineId: pipeline });
  await send(g, '@DEV 接管');
  await idle();
  expect(instance!.store.snapshot().tasks).toHaveLength(1);
  instance!.store.db
    .prepare('UPDATE task_pipelines SET archived_at=? WHERE id=?')
    .run(new Date().toISOString(), pipeline);
  const before = instance!.store.snapshot().tasks.length;
  await launch(g, '归档后不能复用', { pipelineId: pipeline });
  expect(instance!.store.snapshot().tasks).toHaveLength(before);
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('retains pipeline bindings and sessions across a service restart', async () => {
  const path = await setup();
  const g = await group([await bot()]);
  await launch(g);
  const pipeline = task().execution!.pipeline!.id;
  await finish(jobs()[0], 'durable-pipeline-session');
  await instance!.app.close();
  instance = undefined;
  await setup(undefined, path);
  await launch(g, '重启后下一步', { pipelineId: pipeline });
  expect(jobs()[0].session?.threadId).toBe('durable-pipeline-session');
  expect(jobs()[0].acceptedVersion).toBe(0);
  expect(instance!.store.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('migrates existing tasks and native sessions without replaying or discarding their history', async () => {
  const path = await setup();
  const bb = await bot();
  const g = await group([bb]);
  await launch(g, '升级前工作');
  await finish(jobs()[0], 'pre-migration-session');
  const previous = task();
  const messageCount = instance!.store.snapshot().messages.length;
  await instance!.app.close();
  instance = undefined;
  const db = new Database(path);
  // Reconstruct the schema immediately before migration 013, retaining actual legacy rows.
  db.exec(`
    DROP TRIGGER task_health_created;
    DROP TRIGGER task_health_status;
    DROP TABLE worker_reports;
    DROP TABLE task_health;
    DROP TABLE pipeline_sessions;
    DROP TABLE task_pipeline_bindings;
    DROP TABLE task_pipelines;
    DELETE FROM schema_migrations WHERE version=13;
  `);
  db.close();
  await setup(undefined, path);
  await idle();
  expect(jobs()).toHaveLength(0);
  expect(task(previous.id)).toMatchObject({
    id: previous.id,
    botId: bb,
    groupId: g,
    status: 'completed',
    result: previous.result,
    execution: { pipeline: { id: previous.id } },
  });
  expect(instance!.store.snapshot().messages).toHaveLength(messageCount);
  await launch(g, '升级后相关工作', { pipelineId: previous.id });
  expect(jobs()[0].session?.threadId).toBe('pre-migration-session');
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('retains separate native sessions when the same pipeline switches execution providers and switches back', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const original = task();
  await finish(jobs()[0], 'codex-context');
  let source = await send(g, '换执行能力继续核验');
  await idle();
  instance!.runtime.continueTask(original.id, source, task().execution!.version, 'claude-code');
  await expect.poll(() => jobs().length).toBe(2);
  expect(jobs()[1].session).toBeNull();
  await finish(jobs()[1], 'claude-context');
  source = await send(g, '回原执行能力继续');
  await idle();
  instance!.runtime.continueTask(original.id, source, task().execution!.version, 'codex');
  await expect.poll(() => jobs().length).toBe(3);
  expect(jobs()[2].session?.threadId).toBe('codex-context');
  expect(jobs()[2].task.execution!.pipeline!.id).toBe(original.execution!.pipeline!.id);
  expect(buildTurnInput(jobs()[2])).toContain('上一执行结果');
  expect(
    instance!.store.db
      .prepare('SELECT provider,thread_id FROM pipeline_sessions ORDER BY provider')
      .all(),
  ).toEqual([
    { provider: 'claude-code', thread_id: 'claude-context' },
    { provider: 'codex', thread_id: 'codex-context' },
  ]);
});

it('does not let another task bypass an unknown execution in its pipeline', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const id = task().id,
    pipeline = task().execution!.pipeline!.id;
  event(jobs()[0], { type: 'session', threadId: 'unknown-context' });
  instance!.runtime.detach('device');
  await idle();
  bridge();
  await launch(g, '不能另起任务绕过', { pipelineId: pipeline });
  expect(instance!.store.snapshot().tasks).toHaveLength(1);
  const response = await api(`/api/tasks/${id}/resume`, {
    instruction: '先检查已有产物再继续',
    expectedVersion: task().execution!.version,
  });
  expect(response.statusCode).toBe(200);
  await expect.poll(() => jobs().length).toBe(2);
  await finish(jobs()[1], 'unknown-context');
  await launch(g, '核实后允许下一步', { pipelineId: pipeline });
  await expect.poll(() => jobs().length).toBe(3);
});

it('uses heartbeats to distinguish a live connection without progress from a completed or failed task', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const id = task().id;
  const initial = Date.parse(task().execution!.updatedAt);
  const now = initial + 360000;
  instance!.store.db
    .prepare('UPDATE task_health SET last_heartbeat_at=? WHERE task_id=?')
    .run(new Date(now - 1000).toISOString(), id);
  instance!.runtime.checkProgress(now);
  await idle();
  expect(task().execution!.health!.state).toBe('stalled');
  expect(task().status).toBe('running');
  expect(jobs()).toHaveLength(1);
  instance!.runtime.checkProgress(now + 1000);
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'watchdog:%'")
      .get(),
  ).toEqual({ n: 1 });
});

it('records an unresponsive execution as an observation without automatically failing or replaying it', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const now = Date.parse(task().execution!.updatedAt) + 360000;
  instance!.runtime.checkProgress(now);
  await idle();
  expect(task().execution!.health!.state).toBe('unresponsive');
  expect(task().status).toBe('running');
  expect(jobs()).toHaveLength(1);
  event(jobs()[0], { type: 'heartbeat' });
  expect(task().execution!.health!.lastHeartbeatAt).not.toBeNull();
});

it('treats pending permissions as expected waiting and maintains offline queued tasks without waking the Bot', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  event(jobs()[0], {
    type: 'interaction',
    requestId: 'permission',
    request: { kind: 'permission', title: '确认操作' },
  });
  instance!.runtime.checkProgress(Date.parse(task().execution!.updatedAt) + 360000);
  await idle();
  expect(task().execution!.health!.state).toBe('waiting_permission');
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'watchdog:%'")
      .get(),
  ).toEqual({ n: 0 });
  await launch(g, '排队的独立任务');
  const queued = instance!.store.snapshot().tasks[1];
  instance!.runtime.detach('device');
  await idle();
  instance!.runtime.checkProgress(Date.now());
  await idle();
  expect(task(queued.id).execution!.health!.state).toBe('waiting_device');
  expect(task(queued.id).status).toBe('queued');
  expect(task().execution!.health!.state).toBe('unknown');
});

it('deduplicates and coalesces worker reports, bypasses attention, and keeps routine reports out of chat', async () => {
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool')
      return { role: 'assistant', content: '我在持续处理，请耐心等待。' };
    if (data(messages).event.kind === 'progress')
      return call('remember', { key: 'should-not-write', content: '普通进展' });
    return call('start_worker', { goal: '执行测试' });
  });
  const g = await group([await bot()]);
  await launch(g);
  const beforeChat = instance!.store.snapshot().messages.length;
  const job = jobs()[0];
  event(job, { type: 'activity', text: '正在读取文件', report: '已确认入口，开始检查' });
  await idle();
  expect(instance!.store.snapshot().messages).toHaveLength(beforeChat);
  event(job, { type: 'activity', text: '正在处理', report: '已确认入口，开始检查' });
  event(job, { type: 'activity', text: '正在处理', report: '已定位问题' });
  event(job, { type: 'activity', text: '正在处理', report: '修改已完成，开始验证' });
  await idle();
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM worker_reports').get()).toEqual({
    n: 3,
  });
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'progress:%'")
      .get(),
  ).toEqual({ n: 1 });
  instance!.runtime.checkProgress(Date.now() + 61000);
  await idle();
  const progressCalls = model.mock.calls.filter(
    ([m]) => data(m).event.kind === 'progress' && m.at(-1)?.role !== 'tool',
  );
  expect(progressCalls).toHaveLength(2);
  expect(data(progressCalls[1][0]).event.facts.summary).toBe('修改已完成，开始验证');
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM bot_memory').get()).toEqual({
    n: 0,
  });
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().messages).toHaveLength(beforeChat);
});

it('does not turn raw streaming chunks or heartbeats into model calls or worker reports', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const count = model.mock.calls.length;
  for (const text of ['一', '一段', '一段真实输出']) event(jobs()[0], { type: 'progress', text });
  event(jobs()[0], { type: 'heartbeat' });
  await idle();
  expect(model).toHaveBeenCalledTimes(count);
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM worker_reports').get()).toEqual({
    n: 0,
  });
});

it('keeps milestone reports internal and read-only even if the model tries to change a task', async () => {
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return { role: 'assistant', content: '阶段完成。' };
    const d = data(messages);
    if (d.event.kind === 'progress') return call('stop_task', { taskId: d.event.taskId });
    return call('start_worker', { goal: '执行测试' });
  });
  const g = await group([await bot()]);
  await launch(g);
  const before = instance!.store.snapshot().messages.length;
  event(jobs()[0], { type: 'report', reportKind: 'milestone', report: '入口检查已完成' });
  await idle();
  expect(task().status).toBe('running');
  expect(commands.filter((c) => c.type === 'cancel')).toHaveLength(0);
  expect(instance!.store.snapshot().messages).toHaveLength(before);
});

it('discards a blocker response if the task finishes while its model call is in flight', async () => {
  let release!: (response: CoordinatorMessage) => void;
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return empty();
    const d = data(messages);
    if (d.event.kind === 'progress')
      return new Promise<CoordinatorMessage>((resolve) => {
        release = resolve;
      });
    if (d.event.kind === 'completion')
      return call('finish_task', { taskId: d.event.taskId, verification: '依据实际结果验收' });
    return call('start_worker', { goal: '验证竞态' });
  });
  const g = await group([await bot()]);
  await launch(g);
  event(jobs()[0], { type: 'report', reportKind: 'blocked', report: '正在核实潜在阻塞' });
  await expect.poll(() => Boolean(release)).toBe(true);
  event(jobs()[0], { type: 'result', status: 'completed', text: '阻塞已解除，结果已返回' });
  release(call('start_worker', { goal: '不应执行的迟到处置' }));
  await idle();
  expect(task().status).toBe('completed');
  expect(jobs()).toHaveLength(1);
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toHaveLength(0);
  expect(
    instance!.store.db
      .prepare("SELECT status FROM dialogue_inbox WHERE kind LIKE 'progress:%'")
      .get(),
  ).toEqual({ status: 'discarded' });
});

it('discards stale progress when completion wins the race and keeps final acceptance separate', async () => {
  await setup();
  const g = await group([await bot()]);
  await launch(g);
  const job = jobs()[0];
  event(job, { type: 'activity', text: '正在检查', report: '即将结束' });
  event(job, { type: 'result', status: 'completed', text: '已完成并验证的实际结果' });
  await idle();
  expect(task().status).toBe('completed');
  expect(model.mock.calls.some(([m]) => data(m).event.kind === 'progress')).toBe(false);
  expect(
    instance!.store.db
      .prepare("SELECT status FROM dialogue_inbox WHERE kind LIKE 'progress:%'")
      .get(),
  ).toEqual({ status: 'discarded' });
});

it('delivers an explicit blocker to the owning Bot once and keeps worker claims distinct from accepted results', async () => {
  await setup(async (messages) => {
    if (messages.at(-1)?.role === 'tool') return empty();
    return data(messages).event.kind === 'progress'
      ? { role: 'assistant', content: '需要你确认使用哪一个数据源。' }
      : call('start_worker', { goal: '核实数据' });
  });
  const g = await group([await bot()]);
  await launch(g);
  const job = jobs()[0];
  const report = { type: 'report', reportKind: 'blocked', report: '存在两个数据源，需要确认范围' };
  event(job, report);
  await idle();
  event(job, report);
  await idle();
  expect(instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot')).toEqual([
    expect.objectContaining({ content: '需要你确认使用哪一个数据源。' }),
  ]);
  expect(task().execution!.health!.state).toBe('blocked');
  expect(task().status).toBe('running');
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM worker_reports').get()).toEqual({
    n: 1,
  });
});
