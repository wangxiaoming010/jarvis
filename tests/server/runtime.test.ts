import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob, BridgeCommand, Snapshot } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import type {
  CoordinatorMessage,
  CoordinatorModel,
} from '../../apps/server/src/models/coordinator-model';
const token = 'client-token-for-tests-only-00000',
  bridgeToken = 'bridge-token-for-tests-only-00000';
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>>;
let commands: BridgeCommand[];
let bridgeId: string;
const jobs = () =>
  commands.filter((c): c is { type: 'run'; job: AgentJob } => c.type === 'run').map((c) => c.job);
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return instance.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
async function state() {
  return (await api('GET', '/api/snapshot')).json<Snapshot>();
}
async function setup(maxRounds = 6, coordinator?: CoordinatorModel) {
  instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    bridgeToken,
    coordinator,
    maxRounds,
  });
  await instance.app.ready();
  instance.runtime.attach(
    {
      id: bridgeId,
      name: 'Test bridge',
      providers: [{ provider: 'codex', version: 'test-adapter', available: true }],
    },
    (c) => commands.push(c),
    () => instance.runtime.detach(bridgeId),
  );
}
async function bot(name = 'Bob') {
  const r = await api('POST', '/api/bots', { name, provider: 'codex' });
  expect(r.statusCode).toBe(201);
  const id = r.json().id;
  expect((await api('POST', `/api/bots/${id}/bind`, { bridgeId })).statusCode).toBe(200);
  return id as string;
}
async function group(botIds: string[], name = 'team') {
  return (await api('POST', '/api/groups', { name, botIds })).json().id as string;
}
async function message(groupId: string, content: string, id = randomUUID()) {
  const r = await api('POST', '/api/messages', { id, groupId, content });
  expect([200, 201]).toContain(r.statusCode);
  return r.json();
}
function event(job: AgentJob, fields: Record<string, unknown>) {
  instance.runtime.event(bridgeId, {
    taskId: job.task.id,
    leaseId: job.leaseId,
    ...fields,
    type: fields.type as string,
  });
}
function finish(job: AgentJob, text = '实际测试适配器输出') {
  event(job, { type: 'result', status: 'completed', text });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-runtime-'));
  commands = [];
  bridgeId = randomUUID();
});
afterEach(async () => {
  await instance?.app.close();
  rmSync(directory, { recursive: true, force: true });
});
describe('execution queue and scoped sessions', () => {
  it('serializes one bot across groups and restores only the matching native session', async () => {
    await setup();
    const b = await bot();
    const a = await group([b], 'A'),
      c = await group([b], 'B');
    await message(a, '@Bob private A');
    await message(c, '@Bob private B');
    await expect.poll(() => jobs().length).toBe(1);
    const first = jobs()[0];
    expect(first.messages.every((m) => m.groupId === a)).toBe(true);
    event(first, { type: 'session', threadId: 'native-A' });
    finish(first);
    await expect.poll(() => jobs().length).toBe(2);
    const second = jobs()[1];
    expect(second.session).toBeNull();
    expect(second.messages.every((m) => m.groupId === c)).toBe(true);
    event(second, { type: 'session', threadId: 'native-B' });
    finish(second);
    await message(a, '@Bob followup A');
    await expect.poll(() => jobs().length).toBe(3);
    expect(jobs()[2].session?.threadId).toBe('native-A');
    expect(jobs()[2].messages.some((m) => m.content.includes('private B'))).toBe(false);
  });
  it('does not let a stale lease publish a reply or consume the active task', async () => {
    await setup();
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob test');
    await expect.poll(() => jobs().length).toBe(1);
    const j = jobs()[0];
    instance.runtime.event(bridgeId, {
      type: 'result',
      taskId: j.task.id,
      leaseId: randomUUID(),
      status: 'completed',
      text: 'forged',
    });
    expect((await state()).messages.some((m) => m.content === 'forged')).toBe(false);
    expect((await state()).tasks[0].status).toBe('running');
  });
  it('keeps a queued task over disconnect and never blindly reruns an uncertain execution', async () => {
    await setup();
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob first');
    await message(g, '@Bob second');
    await expect.poll(() => jobs().length).toBe(1);
    instance.runtime.detach(bridgeId);
    let s = await state();
    expect(s.tasks.map((t) => t.status)).toEqual(['failed', 'queued']);
    expect(s.bots[0].status).toBe('offline');
    instance.runtime.attach(
      {
        id: bridgeId,
        name: 'reconnected',
        providers: [{ provider: 'codex', version: 'test', available: true }],
      },
      (c) => commands.push(c),
      () => {},
    );
    await expect.poll(() => jobs().length).toBe(2);
    expect(jobs()[1].task.input).toBe('@Bob second');
    s = await state();
    expect(s.messages.some((m) => m.content.includes('执行结果未知'))).toBe(true);
  });
  it('rechecks membership when a queued task becomes eligible', async () => {
    await setup();
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob first');
    await message(g, '@Bob second');
    await expect.poll(() => jobs().length).toBe(1);
    await api('PATCH', `/api/groups/${g}`, { name: 'removed', botIds: [] });
    finish(jobs()[0]);
    await expect.poll(async () => (await state()).tasks[1].status).toBe('cancelled');
    expect(jobs()).toHaveLength(1);
  });
});
describe('group brain and collaboration bounds', () => {
  it('halts an agent-to-agent chain at its round limit', async () => {
    await setup(2);
    const a = await bot('Alice'),
      b = await bot('Bob'),
      g = await group([a, b]);
    await message(g, '@Alice 方案');
    await expect.poll(() => jobs().length).toBe(1);
    finish(jobs()[0], '@Bob 请审查');
    await expect.poll(() => jobs().length).toBe(2);
    expect(jobs()[1].task.round).toBe(2);
    expect(jobs()[1].task.correlationId).toBe(jobs()[0].task.correlationId);
    finish(jobs()[1], '@Alice 请继续');
    await expect
      .poll(async () =>
        (await state()).messages.some((m) => m.content.includes('这轮讨论先停在这里')),
      )
      .toBe(true);
    expect(jobs()).toHaveLength(2);
  });
  it('enforces the independent call budget even before reaching the round limit', async () => {
    await setup();
    const a = await bot('Alice'),
      b = await bot('Bob'),
      g = await group([a, b]);
    await message(g, '@Alice 方案');
    await expect.poll(() => jobs().length).toBe(1);
    instance.store.db.prepare('UPDATE collaboration_chains SET max_calls=1').run();
    finish(jobs()[0], '@Bob 请审查');
    await expect
      .poll(async () =>
        (await state()).messages.some((m) => m.content.includes('这轮讨论先停在这里')),
      )
      .toBe(true);
    expect(jobs()).toHaveLength(1);
  });
  it('stops queued work, waits for native cancellation, and blocks completion-race handoffs', async () => {
    await setup();
    const a = await bot('Alice'),
      b = await bot('Bob'),
      g = await group([a, b]);
    await message(g, '@Alice first');
    await expect.poll(() => jobs().length).toBe(1);
    const j = jobs()[0];
    expect((await api('POST', `/api/chains/${j.task.correlationId}/stop`, {})).statusCode).toBe(
      200,
    );
    expect((await state()).tasks[0].status).toBe('cancelling');
    expect(commands.some((c) => c.type === 'cancel')).toBe(true);
    finish(j, '@Bob late completed output');
    expect((await state()).tasks[0].status).toBe('completed');
    expect(jobs()).toHaveLength(1);
  });
});
describe('bridge and approval authorization', () => {
  it('rejects client credentials on the bridge socket', async () => {
    await setup();
    const ws = await instance.app.injectWS('/bridge');
    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    ws.send(
      JSON.stringify({ type: 'hello', token, id: randomUUID(), name: 'forged', providers: [] }),
    );
    expect(await closed).toBe(1008);
  });
  it('allows one owner decision and rejects a stale approval after stop', async () => {
    await setup();
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob run');
    await expect.poll(() => jobs().length).toBe(1);
    const j = jobs()[0];
    event(j, {
      type: 'approval',
      requestId: '1',
      kind: 'command',
      detail: { command: 'echo hello', cwd: directory },
    });
    let approvals = (await state()).approvals!;
    expect(approvals).toHaveLength(1);
    expect(
      (await api('POST', `/api/approvals/${approvals[0].id}`, { decision: 'decline' })).statusCode,
    ).toBe(200);
    expect(
      (await api('POST', `/api/approvals/${approvals[0].id}`, { decision: 'accept' })).statusCode,
    ).toBe(409);
    event(j, { type: 'approval', requestId: '2', kind: 'file', detail: { reason: 'example' } });
    approvals = (await state()).approvals!;
    await api('POST', `/api/chains/${j.task.correlationId}/stop`, {});
    expect(
      (await api('POST', `/api/approvals/${approvals[1].id}`, { decision: 'accept' })).statusCode,
    ).toBe(409);
    event(j, { type: 'result', status: 'cancelled', text: '' });
  });
});
it('persists bindings and queued tasks through a service restart without replaying the running task', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]);
  await message(g, '@Bob first');
  await message(g, '@Bob second');
  await expect.poll(() => jobs().length).toBe(1);
  event(jobs()[0], { type: 'session', threadId: 'durable-native-session' });
  await instance.app.close();
  commands = [];
  await setup();
  await expect.poll(() => jobs().length).toBe(1);
  const s = await state();
  expect(s.bots[0].bridgeId).toBe(bridgeId);
  expect(s.bots[0]).not.toHaveProperty('workingDirectory');
  expect(s.tasks.map((t) => t.status)).toEqual(['failed', 'running']);
  expect(jobs()[0].task.input).toBe('@Bob second');
  expect(jobs()[0].session?.threadId).toBe('durable-native-session');
});

/** Starts work for “开发” requests and accepts each reviewed result; everything else stays silent. */
function workCoordinator(): CoordinatorModel {
  const respond = (name?: string, args: object = {}): CoordinatorMessage =>
    name
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: 'assistant', content: '' };
  return async (messages) => {
    if (messages.at(-1)?.role === 'tool') return respond();
    const event = JSON.parse(messages[1].content!).event;
    if (event.kind === 'completion' && event.facts.status === 'reviewing') {
      const task = instance.store.snapshot().tasks.find((t) => t.id === event.taskId)!;
      return respond('finish_task', {
        taskId: task.id,
        verification: '已核对执行结果',
        evidence: (task.execution?.contract?.criteria ?? []).map((criterion) => ({
          criterion,
          source: 'result',
          quote: task.result?.slice(0, 1000) ?? '',
        })),
      });
    }
    const content: string = event.message?.content ?? '';
    return content.includes('开发') ? respond('start_worker', { goal: content }) : respond();
  };
}
async function waitDialogue() {
  await expect
    .poll(() =>
      instance.store.db
        .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
        .get(),
    )
    .toEqual({ n: 0 });
}
describe('persistent conversation and asynchronous task branches', () => {
  it('waits for the old execution to exit before resuming with a new lease and confirmed requirements', async () => {
    await setup(6, workCoordinator());
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob 开发功能');
    await expect.poll(() => jobs().length).toBe(1);
    const old = jobs()[0];
    event(old, { type: 'session', threadId: 'same-task-session' });
    expect(
      (
        await api('POST', `/api/tasks/${old.task.id}/change`, {
          instruction: '调整要求，暂时不要做退出登录',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    let t = (await state()).tasks[0];
    expect(t.status).toBe('cancelling');
    expect(t.execution?.version).toBe(1);
    expect(t.execution?.pendingChange?.instruction).toContain('不要做退出登录');
    expect(jobs()).toHaveLength(1);
    expect(commands.some((c) => c.type === 'cancel')).toBe(true);
    event(old, { type: 'result', status: 'cancelled', text: '' });
    await expect.poll(() => jobs().length).toBe(2);
    const resumed = jobs()[1];
    expect(resumed.task.id).toBe(old.task.id);
    expect(resumed.leaseId).not.toBe(old.leaseId);
    expect(resumed.session?.threadId).toBe('same-task-session');
    expect(resumed.task.execution?.version).toBe(2);
    expect(resumed.task.execution?.changes[0].instruction).toContain('不要做退出登录');
    expect(instance.store.db.prepare('SELECT status FROM task_changes').get()).toEqual({
      status: 'ready',
    });
    event(resumed, { type: 'started' });
    expect(instance.store.db.prepare('SELECT status FROM task_changes').get()).toEqual({
      status: 'accepted',
    });
    finish(old, '迟到的旧结果');
    expect((await state()).tasks[0].status).toBe('running');
    finish(resumed, '按 v2 完成');
    await waitDialogue();
    t = (await state()).tasks[0];
    expect(t.execution?.executedVersion).toBe(2);
    expect((await state()).messages.some((m) => m.content.includes('迟到的旧结果'))).toBe(false);
  });
  it('cancels a pending change when stopped and never resurrects the task after a racing completion', async () => {
    await setup(6, workCoordinator());
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob 开发功能');
    await expect.poll(() => jobs().length).toBe(1);
    const job = jobs()[0];
    expect(
      (
        await api('POST', `/api/tasks/${job.task.id}/change`, {
          instruction: '不要改配置',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    await api('POST', `/api/tasks/${job.task.id}/stop`, {});
    finish(job, '旧要求下的实际结果');
    await waitDialogue();
    expect(jobs()).toHaveLength(1);
    expect(instance.store.db.prepare('SELECT status FROM task_changes').get()).toEqual({
      status: 'cancelled',
    });
    expect((await state()).tasks[0].execution?.executedVersion).toBe(1);
  });
  it('rejects changes with a stale requirement version and applies queued changes before the first run', async () => {
    await setup(6, workCoordinator());
    const b = await bot(),
      g = await group([b]);
    await message(g, '@Bob 开发第一个功能');
    await message(g, '@Bob 开发第二个功能');
    await waitDialogue();
    const second = (await state()).tasks[1];
    expect(
      (
        await api('POST', `/api/tasks/${second.id}/change`, {
          instruction: '保留数据库结构',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api('POST', `/api/tasks/${second.id}/change`, {
          instruction: '旧版本请求',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    finish(jobs()[0]);
    await expect.poll(() => jobs().length).toBe(2);
    expect(jobs()[1].task.execution?.version).toBe(2);
    expect(jobs()[1].task.execution?.changes[0].instruction).toBe('保留数据库结构');
  });
});

it('does not hand off from a stopped single task even if native completion wins the cancellation race', async () => {
  await setup();
  const a = await bot('Alice'),
    b = await bot('Bob'),
    g = await group([a, b]);
  await message(g, '@Bob 开发功能');
  await expect.poll(() => jobs().length).toBe(1);
  await api('POST', `/api/tasks/${jobs()[0].task.id}/stop`, {});
  finish(jobs()[0], '@Alice 迟到的协作请求');
  await waitDialogue();
  expect((await state()).tasks[0].status).toBe('completed');
  expect(jobs()).toHaveLength(1);
});

it('renders native bot cards while keeping invalid output inert', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]);
  await message(g, '@Bob 开发交互卡片');
  await expect.poll(() => jobs().length).toBe(1);
  const document = {
    protocolVersion: 'opsique-ui/0.1',
    context: { threadId: '', viewId: 'new', revision: 1 },
    spec: {
      root: 'root',
      elements: { root: { type: 'Card', props: { title: '已检查的项目' }, children: [] } },
    },
    state: { data: {}, form: {}, ui: {} },
  };
  finish(jobs()[0], '这里可以继续选择。\n```opsique-ui\n' + JSON.stringify(document) + '\n```');
  await expect.poll(async () => (await state()).messages.filter((m) => m.ui).length).toBe(1);
  expect((await state()).messages.find((m) => m.ui)?.content).toBe('这里可以继续选择。');
  await message(g, '@Bob 开发下一张卡片');
  await expect.poll(() => jobs().length).toBe(2);
  const invalid = JSON.stringify({
    ...document,
    spec: { root: 'root', elements: { root: { type: 'script', props: {}, children: [] } } },
  });
  finish(jobs()[1], invalid);
  await waitDialogue();
  expect((await state()).messages.filter((m) => m.ui)).toHaveLength(1);
  expect(
    (await state()).messages.some((m) => m.senderType === 'bot' && m.content === invalid),
  ).toBe(true);
});
