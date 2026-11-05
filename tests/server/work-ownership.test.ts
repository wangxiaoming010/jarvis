import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentJob, BridgeCommand, WorkGoal } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import type { CoordinatorMessage } from '../../apps/server/src/models/coordinator-model';
import { ProjectFacts } from '../../apps/server/src/work/project-facts';
import { buildTurnInput } from '../../apps/bridge/src/prompt';
import { botInstructions } from '../../apps/bridge/src/instructions';

let instance: Awaited<ReturnType<typeof createApp>> | undefined;
const dirs: string[] = [];
const token = 'work-ownership-test-local-owner-token';
let commands: BridgeCommand[] = [];
let actions = new Map<string, CoordinatorMessage>();
let bots = new Map<string, string>();
let backgroundAction: CoordinatorMessage | undefined;
let completionWorkflow:
  ((messages: CoordinatorMessage[], event: Record<string, any>) => CoordinatorMessage) | undefined;
const empty = (): CoordinatorMessage => ({ role: 'assistant', content: '' });
const call = (name: string, args: object): CoordinatorMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});
const api = (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: unknown) =>
  instance!.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const jobs = () =>
  commands.filter((c): c is { type: 'run'; job: AgentJob } => c.type === 'run').map((c) => c.job);
const goal = (id: string) => instance!.store.snapshot().goals!.find((g) => g.id === id)!;
async function idle() {
  await expect
    .poll(
      () =>
        instance!.store.db
          .prepare(
            "SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')",
          )
          .get(),
      { timeout: 5000 },
    )
    .toEqual({ n: 0 });
}
function attach() {
  instance!.runtime.attach(
    {
      id: 'device',
      name: 'fixture',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (c) => commands.push(c),
    () => instance?.runtime.detach('device'),
  );
}
async function setup(online = true, path?: string) {
  if (!path) {
    const d = mkdtempSync(join(tmpdir(), 'openbot-ownership-'));
    dirs.push(d);
    path = join(d, 'db.sqlite');
  }
  commands = [];
  actions = new Map();
  bots = new Map();
  backgroundAction = undefined;
  completionWorkflow = undefined;
  instance = await createApp({
    databasePath: path,
    token,
    attention: async () => ({ wake: false }),
    coordinator: async (messages) => {
      const d = JSON.parse(messages[1].content!);
      if (
        messages.at(-1)?.role === 'tool' &&
        !(
          completionWorkflow &&
          d.event.kind === 'completion' &&
          d.event.facts.status === 'reviewing'
        )
      )
        return empty();
      if (d.event.kind === 'message') {
        const a = actions.get(d.bot.id);
        actions.delete(d.bot.id);
        return a ?? empty();
      }
      if (d.event.kind === 'objective' && backgroundAction) {
        const action = backgroundAction;
        backgroundAction = undefined;
        return action;
      }
      if (d.event.eventType?.startsWith('delegation:offer:'))
        return call('respond_delegation', {
          delegationId: d.event.facts.id,
          decision: 'accept',
          reason: '接下目标，按需安排执行',
        });
      if (d.event.kind === 'completion' && d.event.facts.status === 'reviewing') {
        if (completionWorkflow) return completionWorkflow(messages, d);
        const t = instance!.store.snapshot().tasks.find((t) => t.id === d.event.taskId)!;
        return call('finish_task', {
          taskId: t.id,
          verification: '检查真实执行结果',
          evidence: t.execution!.contract!.criteria.map((criterion) => ({
            criterion,
            source: 'result',
            quote: t.result!,
          })),
        });
      }
      return empty();
    },
  });
  if (online) attach();
  return path;
}
async function bot(name = 'BB') {
  const id = (await api('POST', '/api/bots', { name, provider: 'codex' })).json().id as string;
  bots.set(id, name);
  return id;
}
async function group(ids: string[]) {
  return (await api('POST', '/api/groups', { name: '持续工作验证', botIds: ids })).json()
    .id as string;
}
async function send(g: string, content: string) {
  const r = await api('POST', '/api/messages', { id: randomUUID(), groupId: g, content });
  expect(r.statusCode).toBe(201);
  return r.json();
}
async function act(b: string, g: string, name: string, args: object) {
  actions.set(b, call(name, args));
  const source = await send(g, `@${bots.get(b) ?? 'BB'} 明确处理 ${name} ${randomUUID()}`);
  await idle();
  const result = instance!.store.db
    .prepare(
      'SELECT c.result FROM coordinator_calls c JOIN coordinator_turns t ON t.id=c.turn_id JOIN dialogue_inbox i ON i.id=t.inbox_id WHERE i.source_message_id=? AND c.name=? ORDER BY c.rowid DESC LIMIT 1',
    )
    .get(source.id, name) as { result: string } | undefined;
  expect(result, `${name} should have executed`).toBeDefined();
  return JSON.parse(result!.result);
}
async function finish(job: AgentJob, text = '已保存产物并完成实际检查') {
  for (const fields of [
    { type: 'session', threadId: `native-${job.task.id}` },
    { type: 'started' },
    { type: 'result', status: 'completed', text },
  ])
    instance!.runtime.event('device', { taskId: job.task.id, leaseId: job.leaseId, ...fields });
  await idle();
}
async function createGoal(b: string, g: string, extra: object = {}) {
  const result = await act(b, g, 'create_goal', {
    title: '持续推进交付',
    verification: 'content',
    criteria: ['交付可用'],
    ...extra,
  });
  expect(result.error).toBeUndefined();
  return result as WorkGoal;
}
async function fileArtifact(
  b: string,
  g: string,
  id: string,
  kind: 'json' | 'independent_run' = 'json',
) {
  const path = join(dirs[0], `${randomUUID()}.json`);
  writeFileSync(path, '{"value":1}\n');
  await act(b, g, 'start_worker', { goalId: id, goal: '生成并核实文件' });
  const job = jobs().at(-1)!;
  await finish(job);
  const a = await act(b, g, 'register_artifact', {
    goalId: id,
    taskId: job.task.id,
    title: '方案文件',
    kind: 'file',
    locator: path,
    applicationPath: join(dirs[0], `${randomUUID()}-applied.json`),
  });
  expect(a.error).toBeUndefined();
  if (kind === 'json') {
    expect(
      (await act(b, g, 'verify_artifact', { artifactId: a.id, version: 1, method: 'json' })).state,
    ).toBe('verified');
    expect((await act(b, g, 'accept_artifact', { artifactId: a.id, version: 1 })).state).toBe(
      'accepted',
    );
  }
  return { a, path, job };
}
afterEach(async () => {
  await instance?.app.close();
  instance = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('accepts ownership offline, persists a queued execution across restart, and keeps execution acceptance separate from goal completion', async () => {
  const path = await setup(false),
    b = await bot(),
    g = await group([b]);
  const owned = await createGoal(b, g);
  expect(instance!.store.snapshot().tasks).toHaveLength(0);
  const r = await act(b, g, 'start_worker', { goalId: owned.id, goal: '设备恢复后读取文件' });
  expect(r.status).toBe('queued');
  expect(jobs()).toHaveLength(0);
  await instance!.app.close();
  instance = undefined;
  await setup(false, path);
  bots.set(b, 'BB');
  expect(goal(owned.id).state).toBe('active');
  attach();
  await expect.poll(() => jobs().length).toBe(1);
  expect(jobs()[0].task.goalId).toBe(owned.id);
  await finish(jobs()[0]);
  expect(instance!.store.snapshot().tasks[0].status).toBe('completed');
  expect(goal(owned.id).state).toBe('active');
  const noProof = await act(b, g, 'finish_goal', {
    goalId: owned.id,
    expectedVersion: 1,
    evidence: [{ criterion: '交付可用', source: 'artifact', id: 'invented', version: 1 }],
  });
  expect(noProof.error).toBeDefined();
  expect((await api('GET', `/api/goals/${owned.id}/status`)).json().goal.id).toBe(owned.id);
});

it('completes a manager goal entirely through explicit peer ownership and accepted artifacts without any manager execution', async () => {
  await setup();
  const bb = await bot(),
    dev = await bot('DEV'),
    g = await group([bb, dev]);
  const root = await createGoal(bb, g);
  const d = await act(bb, g, 'delegate_goal', {
    goalId: root.id,
    botId: dev,
    goal: '交付可用文件',
    criteria: ['文件可用'],
  });
  await idle();
  expect(jobs()).toHaveLength(0);
  const ledger = instance!.store.db
    .prepare('SELECT * FROM bot_delegations WHERE id=?')
    .get(d.id) as { child_goal_id: string; state: string };
  expect(ledger.state).toBe('accepted');
  const child = goal(ledger.child_goal_id);
  const { a } = await fileArtifact(dev, g, child.id);
  expect(
    (
      await act(dev, g, 'finish_goal', {
        goalId: child.id,
        expectedVersion: 1,
        evidence: [{ criterion: '文件可用', source: 'artifact', id: a.id, version: 1 }],
      })
    ).state,
  ).toBe('completed');
  expect(
    (
      instance!.store.db.prepare('SELECT state FROM bot_delegations WHERE id=?').get(d.id) as {
        state: string;
      }
    ).state,
  ).toBe('submitted');
  expect(
    (
      await act(bb, g, 'review_delegation', {
        delegationId: d.id,
        accept: true,
        feedback: '已核对具体文件版本及语法校验记录',
      })
    ).state,
  ).toBe('completed');
  expect(
    (
      await act(bb, g, 'finish_goal', {
        goalId: root.id,
        expectedVersion: 1,
        evidence: [{ criterion: '交付可用', source: 'delegation', id: d.id, version: 1 }],
      })
    ).state,
  ).toBe('completed');
  expect(instance!.store.snapshot().tasks.filter((t) => t.goalId === root.id)).toHaveLength(0);
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('retains bounded follow-up across restart and escalates three unattended checks instead of silently forgetting or looping forever', async () => {
  const path = await setup(),
    b = await bot(),
    g = await group([b]),
    owned = await createGoal(b, g);
  let at = Date.parse(goal(owned.id).nextCheckAt!);
  instance!.runtime.checkProgress(at + 1);
  await idle();
  expect(goal(owned.id).nextCheckAt).not.toBeNull();
  await instance!.app.close();
  instance = undefined;
  await setup(true, path);
  for (let i = 0; i < 2; i++) {
    at = Date.parse(goal(owned.id).nextCheckAt!);
    instance!.runtime.checkProgress(at + 1);
    await idle();
  }
  expect(goal(owned.id)).toMatchObject({ state: 'needs_attention', nextCheckAt: null });
  const before = instance!.store.db
    .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'objective:%'")
    .get();
  instance!.runtime.checkProgress(at + 3600000);
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'objective:%'")
      .get(),
  ).toEqual(before);
  expect(jobs()).toHaveLength(0);
});

it('wakes from structured human and already-satisfied task conditions exactly once and rejects foreign subscriptions', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    other = await group([b]);
  const owned = await createGoal(b, g);
  expect(
    (
      await act(b, g, 'plan_goal', {
        goalId: owned.id,
        waitFor: [{ kind: 'human', id: other, state: 'received' }],
      })
    ).error,
  ).toMatch(/授权范围/);
  await act(b, g, 'plan_goal', {
    goalId: owned.id,
    nextCheckAt: new Date(Date.now() + 3600000).toISOString(),
    waitFor: [{ kind: 'human', id: g, state: 'received' }],
  });
  await send(g, '@BB 所需资料已到');
  await idle();
  instance!.runtime.checkProgress();
  await idle();
  instance!.runtime.checkProgress();
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'objective:condition:%'")
      .get(),
  ).toEqual({ n: 1 });
  await act(b, g, 'start_worker', { goalId: owned.id, goal: '读取资料' });
  await finish(jobs()[0]);
  await act(b, g, 'plan_goal', {
    goalId: owned.id,
    waitFor: [{ kind: 'task', id: jobs()[0].task.id, state: 'completed' }],
  });
  instance!.runtime.checkProgress();
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE kind LIKE 'objective:condition:%'")
      .get(),
  ).toEqual({ n: 2 });
});

it('shares confirmed facts explicitly, protects concurrent revisions, passes exact versions to workers and invalidates stale evidence', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    other = await group([b]);
  const project = await act(b, g, 'create_project', { name: '共享接口' });
  const proposed = await act(b, g, 'propose_project_fact', {
    projectId: project.id,
    key: 'response',
    content: '返回 JSON',
    kind: 'interface',
    expectedVersion: 0,
  });
  expect((await act(b, g, 'read_project', { projectId: project.id })).facts).toEqual([]);
  expect((await act(b, other, 'read_project', { projectId: project.id })).error).toMatch(/无权/);
  await act(b, g, 'confirm_project_fact', { factId: proposed.factId, version: 1 });
  await act(b, g, 'share_project', { projectId: project.id, groupId: other });
  expect((await act(b, other, 'read_project', { projectId: project.id })).facts[0]).toMatchObject({
    version: 1,
    content: '返回 JSON',
  });
  const owned = await createGoal(b, g, { projectId: project.id });
  await act(b, g, 'start_worker', { goalId: owned.id, goal: '实现接口' });
  expect(jobs()[0].projectFacts).toContainEqual(
    expect.objectContaining({ version: 1, content: '返回 JSON' }),
  );
  expect(botInstructions(jobs()[0])).toContain('Confirmed project facts');
  expect(buildTurnInput(jobs()[0])).toContain('实现接口');
  expect(
    (
      await act(b, g, 'propose_project_fact', {
        projectId: project.id,
        key: 'response',
        content: '返回 XML',
        kind: 'interface',
        expectedVersion: 0,
      })
    ).error,
  ).toMatch(/已变更/);
  const update = await act(b, g, 'propose_project_fact', {
    projectId: project.id,
    key: 'response',
    content: '返回 XML',
    kind: 'interface',
    expectedVersion: 1,
  });
  expect(
    (await act(b, g, 'confirm_project_fact', { factId: proposed.factId, version: 1 })).error,
  ).toMatch(/过期/);
  await act(b, g, 'confirm_project_fact', { factId: update.factId, version: 2 });
  instance!.runtime.checkProgress();
  await idle();
  expect(goal(owned.id)).toMatchObject({
    state: 'active',
    ownerWait: 0,
    attentionReason: expect.stringContaining('项目约定'),
  });
  await finish(jobs()[0], '按旧约定返回 JSON');
  expect(instance!.store.snapshot().tasks[0].status).toBe('reviewing');
  expect(() => new ProjectFacts(instance!.store).assertCurrent(jobs()[0].leaseId)).toThrow(
    '已更新',
  );
  await act(b, g, 'continue_task', {
    taskId: jobs()[0].task.id,
    instruction: '按已确认的 XML 约定重新核实',
  });
  expect(jobs()[1].projectFacts).toContainEqual(
    expect.objectContaining({ version: 2, content: '返回 XML' }),
  );
  expect(() => new ProjectFacts(instance!.store).assertCurrent(jobs()[1].leaseId)).not.toThrow();
  const added = await act(b, g, 'propose_project_fact', {
    projectId: project.id,
    key: 'encoding',
    content: '必须使用 UTF-8',
    kind: 'requirement',
    expectedVersion: 0,
  });
  await act(b, g, 'confirm_project_fact', { factId: added.factId, version: 1 });
  expect(() => new ProjectFacts(instance!.store).assertCurrent(jobs()[1].leaseId)).toThrow('新增');
});

it('binds verification to exact artifact content and distinguishes accepted delivery from actual target application', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    owned = await createGoal(b, g, { delivery: 'applied' });
  const { a, path } = await fileArtifact(b, g, owned.id, 'independent_run');
  expect((await act(b, g, 'accept_artifact', { artifactId: a.id, version: 1 })).error).toMatch(
    /尚未验证/,
  );
  expect(
    (
      await act(b, g, 'verify_artifact', {
        artifactId: a.id,
        version: 1,
        method: 'independent_run',
        verifierRunId: a.producerRunId,
        quote: '已保存',
      })
    ).error,
  ).toMatch(/另一执行/);
  await act(b, g, 'start_worker', {
    goalId: owned.id,
    goal: '独立读取并验证交付文件',
    resourceMode: 'read',
    verifyArtifactIds: [a.id],
  });
  const verifier = jobs().at(-1)!;
  expect(verifier.artifactsToVerify![0]).toMatchObject({ id: a.id, version: 1, digest: a.digest });
  expect(botInstructions(verifier)).toContain(a.digest);
  await finish(verifier, '独立检查通过，文件语法正确且 value 为 1');
  expect(
    (
      await act(b, g, 'verify_artifact', {
        artifactId: a.id,
        version: 1,
        method: 'independent_run',
        verifierRunId: verifier.leaseId,
        quote: '虚构测试通过',
      })
    ).error,
  ).toMatch(/真实结果/);
  expect(
    (
      await act(b, g, 'verify_artifact', {
        artifactId: a.id,
        version: 1,
        method: 'independent_run',
        verifierRunId: verifier.leaseId,
        quote: '独立检查通过，文件语法正确且 value 为 1',
      })
    ).state,
  ).toBe('verified');
  await act(b, g, 'accept_artifact', { artifactId: a.id, version: 1 });
  const evidence = [{ criterion: '交付可用', source: 'artifact', id: a.id, version: 1 }];
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).error,
  ).toMatch(/应用要求/);
  expect((await act(b, g, 'record_application', { artifactId: a.id, version: 1 })).error).toMatch(
    /尚未匹配/,
  );
  writeFileSync(a.applicationPath, readFileSync(path));
  expect((await act(b, g, 'record_application', { artifactId: a.id, version: 1 })).state).toBe(
    'applied',
  );
  writeFileSync(a.applicationPath, '{"value":99}');
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).error,
  ).toMatch(/尚未匹配/);
  writeFileSync(a.applicationPath, readFileSync(path));
  writeFileSync(path, '{"value":2}');
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).error,
  ).toMatch(/内容已变化/);
  writeFileSync(path, '{"value":1}\n');
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).state,
  ).toBe('completed');
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('requires independent or explicit human review by default and does not reuse an old human source as a new confirmation', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]);
  const owned = await act(b, g, 'create_goal', { title: '完成方案', criteria: ['交付可用'] });
  expect(owned.verification).toBe('reviewed');
  const { a } = await fileArtifact(b, g, owned.id);
  const evidence = [{ criterion: '交付可用', source: 'artifact', id: a.id, version: 1 }];
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).error,
  ).toMatch(/独立执行或人工复核/);
  backgroundAction = call('verify_artifact', { artifactId: a.id, version: 1, method: 'human' });
  instance!.runtime.checkProgress(Date.parse(goal(owned.id).nextCheckAt!) + 1);
  await idle();
  const last = instance!.store.db
    .prepare(
      "SELECT result FROM coordinator_calls WHERE name='verify_artifact' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as { result: string };
  expect(JSON.parse(last.result).error).toMatch(/所有者.*明确要求/);
  expect(
    (await act(b, g, 'verify_artifact', { artifactId: a.id, version: 1, method: 'human' })).error,
  ).toBeUndefined();
  expect(
    (await act(b, g, 'finish_goal', { goalId: owned.id, expectedVersion: 1, evidence })).state,
  ).toBe('completed');
});

it('keeps owner decisions closed to background execution and supports a versioned human reopening without restoring stale evidence', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    owned = await createGoal(b, g);
  const { a } = await fileArtifact(b, g, owned.id);
  await act(b, g, 'plan_goal', { goalId: owned.id, needsHuman: '请决定是否发布' });
  expect(goal(owned.id)).toMatchObject({
    state: 'needs_attention',
    ownerWait: 1,
    nextCheckAt: null,
  });
  expect((await act(b, g, 'stop_goal', { goalId: owned.id })).state).toBe('cancelled');
  expect(
    (
      await act(b, g, 'reopen_goal', {
        goalId: owned.id,
        expectedVersion: 1,
        instruction: '重新核对后再交付',
      })
    ).version,
  ).toBe(2);
  expect(
    (
      await act(b, g, 'finish_goal', {
        goalId: owned.id,
        expectedVersion: 2,
        evidence: [{ criterion: '交付可用', source: 'artifact', id: a.id, version: 1 }],
      })
    ).error,
  ).toMatch(/目标要求已更新/);
  await act(b, g, 'plan_goal', { goalId: owned.id });
  for (let i = 0; i < 3; i++) {
    if (i === 2)
      backgroundAction = call('start_worker', { goalId: owned.id, goal: '不能自动越过待决策状态' });
    instance!.runtime.checkProgress(Date.parse(goal(owned.id).nextCheckAt!) + 1);
    await idle();
  }
  expect(jobs()).toHaveLength(1);
  expect(goal(owned.id).ownerWait).toBe(1);
  const last = instance!.store.db
    .prepare(
      "SELECT result FROM coordinator_calls WHERE name='start_worker' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as { result: string };
  expect(JSON.parse(last.result).error).toMatch(/等待所有者决定/);
});

it('observes file arrival without executing a worker and keeps project sharing separate from conversation handoff', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    privateChat = (await api('POST', `/api/bots/${b}/chat`, {})).json().id;
  const project = await act(b, g, 'create_project', { name: '有边界的项目' });
  const owned = await createGoal(b, g, { projectId: project.id });
  const path = join(dirs[0], 'waiting-for-material.json');
  await act(b, g, 'plan_goal', {
    goalId: owned.id,
    nextCheckAt: new Date(Date.now() + 3600000).toISOString(),
    waitFor: [{ kind: 'file', id: path, state: 'exists' }],
  });
  instance!.runtime.checkProgress();
  await idle();
  expect(goal(owned.id).state).toBe('waiting');
  writeFileSync(path, '{}');
  instance!.runtime.checkProgress();
  await idle();
  expect(goal(owned.id).state).toBe('active');
  expect(jobs()).toHaveLength(0);
  expect((await act(b, privateChat, 'link_goal', { goalId: owned.id })).error).toMatch(
    /明确关联项目/,
  );
  await act(b, g, 'share_project', { projectId: project.id, groupId: privateChat });
  expect((await act(b, privateChat, 'link_goal', { goalId: owned.id })).groupId).toBe(privateChat);
  await act(b, privateChat, 'start_worker', { goalId: owned.id, goal: '从私聊继续执行' });
  expect(jobs()[0].task.groupId).toBe(privateChat);
});

it('propagates delegated execution failure promptly while retaining goal ownership and cancels the entire tree on owner stop', async () => {
  await setup();
  const bb = await bot(),
    dev = await bot('DEV'),
    g = await group([bb, dev]),
    root = await createGoal(bb, g);
  const d = await act(bb, g, 'delegate_goal', {
    goalId: root.id,
    botId: dev,
    goal: '处理支持工作',
    criteria: ['有交付'],
  });
  const ledger = instance!.store.db
    .prepare('SELECT child_goal_id FROM bot_delegations WHERE id=?')
    .get(d.id) as { child_goal_id: string };
  await act(dev, g, 'start_worker', { goalId: ledger.child_goal_id, goal: '尝试处理支持工作' });
  const job = jobs()[0];
  instance!.runtime.event('device', {
    taskId: job.task.id,
    leaseId: job.leaseId,
    type: 'result',
    status: 'failed',
    error: '依赖不可用',
  });
  await idle();
  expect(
    instance!.store.db
      .prepare("SELECT goal_id FROM dialogue_inbox WHERE kind LIKE 'delegation:blocked:%'")
      .get(),
  ).toEqual({ goal_id: root.id });
  expect(goal(ledger.child_goal_id).state).toBe('active');
  await act(bb, g, 'stop_goal', { goalId: root.id });
  expect(goal(root.id).state).toBe('cancelled');
  expect(goal(ledger.child_goal_id).state).toBe('cancelled');
  expect(instance!.store.db.pragma('foreign_key_check')).toEqual([]);
});

it('retains immutable artifact revisions, rejects old verification and stops waiting goals recursively', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    owned = await createGoal(b, g);
  const { a, path, job } = await fileArtifact(b, g, owned.id);
  writeFileSync(path, '{"value":2}');
  const newer = await act(b, g, 'register_artifact', {
    goalId: owned.id,
    taskId: job.task.id,
    title: '更新方案',
    kind: 'file',
    locator: path,
    artifactId: a.id,
    expectedVersion: 1,
  });
  expect(newer).toMatchObject({ version: 2, state: 'produced' });
  expect(
    (await act(b, g, 'verify_artifact', { artifactId: a.id, version: 1, method: 'json' })).error,
  ).toMatch(/版本已过期/);
  expect((await act(b, g, 'read_artifact', { artifactId: a.id })).history).toHaveLength(2);
  expect((await api('DELETE', `/api/groups/${g}`)).statusCode).toBe(409);
  expect((await api('POST', `/api/goals/${owned.id}/stop`, {})).json().state).toBe('cancelled');
  instance!.runtime.checkProgress(Date.now() + 3600000);
  await idle();
  expect(goal(owned.id).state).toBe('cancelled');
  expect(
    (await act(b, g, 'start_worker', { goalId: owned.id, goal: '不能自动恢复' })).error,
  ).toMatch(/已结束/);
});

it('finishes a multi-step delivery within one completion turn without falsely reporting that acceptance failed', async () => {
  await setup();
  const b = await bot(),
    g = await group([b]),
    owned = await createGoal(b, g),
    path = join(dirs[0], 'one-turn.json');
  writeFileSync(path, '{"delivered":true}');
  await act(b, g, 'start_worker', { goalId: owned.id, goal: '生成格式正确的 JSON 文件' });
  const job = jobs()[0];
  let step = 0,
    artifactId = '';
  completionWorkflow = (messages, d) => {
    const result = messages.at(-1)?.role === 'tool' ? JSON.parse(messages.at(-1)!.content!) : null;
    if (result?.kind === 'file') artifactId = result.id;
    const task = instance!.store.snapshot().tasks.find((t) => t.id === d.event.taskId)!;
    const actions = [
      () => call('read_task', { taskId: task.id }),
      () =>
        call('finish_task', {
          taskId: task.id,
          verification: '执行结果已检查',
          evidence: task.execution!.contract!.criteria.map((criterion) => ({
            criterion,
            source: 'result',
            quote: task.result!,
          })),
        }),
      () =>
        call('register_artifact', {
          goalId: owned.id,
          taskId: task.id,
          title: 'JSON 文件',
          kind: 'file',
          locator: path,
        }),
      () => call('verify_artifact', { artifactId, version: 1, method: 'json' }),
      () => call('accept_artifact', { artifactId, version: 1 }),
      () =>
        call('finish_goal', {
          goalId: owned.id,
          expectedVersion: 1,
          evidence: [{ criterion: '交付可用', source: 'artifact', id: artifactId, version: 1 }],
        }),
    ];
    return step < actions.length
      ? actions[step++]()
      : { role: 'assistant', content: 'JSON 文件已检查并交付。' };
  };
  await finish(job, 'JSON 文件已保存');
  expect(goal(owned.id).state).toBe('completed');
  expect(instance!.store.snapshot().messages).toContainEqual(
    expect.objectContaining({ senderType: 'bot', content: 'JSON 文件已检查并交付。' }),
  );
  expect(instance!.store.snapshot().dialogueFailures).toEqual([]);
});
