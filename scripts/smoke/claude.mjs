// Explicit real-provider integration check. Uses an isolated database,
// existing local Claude/Codex logins, and their native persisted session stores.
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../../apps/server/src/app.ts';
import { resolve as resolveValue } from '../../packages/shared/src/ui/engine.ts';
const directory = await realpath(await mkdtemp(join(tmpdir(), 'openbot-claude-smoke-')));
const token = randomBytes(32).toString('hex'),
  bridgeToken = randomBytes(32).toString('hex');
const marker = 'CLAUDE_' + randomBytes(6).toString('hex');
await writeFile(
  join(directory, 'README.md'),
  `# OpenBot Claude Verification\n\n验证暗号：${marker}\n`,
);
const instance = await createApp({
  databasePath: join(directory, 'db.sqlite'),
  token,
  bridgeToken,
  // Scripted coordinator: real native execution, deterministic conversational decisions.
  coordinator: async (messages) => {
    if (messages.at(-1)?.role === 'tool') return { role: 'assistant', content: '' };
    const data = JSON.parse(messages[1].content);
    const tool = (name, args) => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    });
    const tasks = instance.store.snapshot().tasks.filter((t) => t.botId === data.bot.id);
    if (data.event.kind === 'completion') {
      const task = tasks.find((t) => t.id === data.event.taskId);
      return task?.status === 'reviewing'
        ? tool('finish_task', {
            taskId: task.id,
            verification: '已核对原生执行的实际结果',
            evidence: (task.execution?.contract?.criteria ?? []).map((criterion) => ({
              criterion,
              source: 'result',
              quote: task.result?.slice(0, 1000) ?? '',
            })),
          })
        : { role: 'assistant', content: '' };
    }
    if (data.event.kind !== 'message') return { role: 'assistant', content: '' };
    const content = data.event.message.content;
    if (content.includes('进度')) return { role: 'assistant', content: '还在处理，完成后告诉你。' };
    const previous = tasks.find((t) => t.status === 'completed');
    return previous
      ? tool('continue_task', { taskId: previous.id, instruction: content })
      : tool('start_worker', { goal: content });
  },
});
await instance.app.listen({ host: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${instance.app.server.address().port}`;
const bridge = spawn(process.execPath, ['--import', 'tsx', 'apps/bridge/src/index.ts'], {
  cwd: resolve('.'),
  env: {
    ...process.env,
    OPENBOT_SERVER_URL: url,
    OPENBOT_BRIDGE_TOKEN: bridgeToken,
    DEEPSEEK_API_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});
async function api(path, body) {
  const r = await fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
}
async function until(fn, label, timeout = 150000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const message of instance.store.snapshot().messages) {
      const request = message.nativeRequest;
      if (request?.status !== 'pending') continue;
      const { tool, input } = request.details ?? {};
      if (tool !== 'Read' || resolve(input?.file_path ?? '') !== join(directory, 'README.md'))
        throw new Error('隔离验证遇到了预期文件读取以外的权限请求');
      await api(`/api/native-requests/${request.id}/reply`, { decision: 'accept' });
    }
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待超时：' + label);
}
function assert(value, label) {
  if (!value) throw new Error(label);
}
try {
  const link = await until(async () => (await api('/api/snapshot')).bridges?.[0], 'Bridge');
  assert(
    link.providers.some((p) => p.provider === 'claude-code' && p.available),
    'Claude 不可用',
  );
  const claude = (await api('/api/bots', { name: 'ClaudeVerification', provider: 'claude-code' }))
    .id;
  await api(`/api/bots/${claude}/bind`, { bridgeId: link.id });
  const group = (
    await api('/api/groups', { name: 'Claude isolated verification', botIds: [claude] })
  ).id;
  await api('/api/messages', {
    id: randomUUID(),
    groupId: group,
    content: `@ClaudeVerification 读取 ${join(directory, 'README.md')}，告诉我项目名称和验证暗号。然后在最终答复中用 opsique-ui 动态卡片给我两个可直接点选的选项：只看架构、同时看安全；不用 AskUserQuestion。先等我选好，不要修改文件。选择后不要再读文件，先原样复述刚才的验证暗号，再用一句话确认我选的范围。`,
  });
  const task = await until(
    async () => (await api('/api/snapshot')).tasks.find((t) => t.status === 'running'),
    'running Claude',
  );
  await api('/api/messages', {
    id: randomUUID(),
    groupId: group,
    content: '@ClaudeVerification 进度怎么样？',
  });
  await until(
    async () => (await api('/api/snapshot')).messages.some((m) => m.senderType === 'bot' && !m.ui),
    'concurrent conversation',
  );
  const first = await until(async () => {
    const s = await api('/api/snapshot');
    const t = s.tasks.find((t) => t.id === task.id);
    if (t?.status === 'failed') throw new Error(t.error);
    return t?.status === 'completed' ? { snapshot: s, task: t } : undefined;
  }, 'Claude final');
  assert(first.task.result.includes(marker), 'Claude 未实际读取验证文件');
  const card = first.snapshot.messages.find((m) => m.ui && m.senderId === claude);
  assert(card, 'Claude 未返回可渲染卡片');
  const row = instance.store.db
    .prepare('SELECT thread_id,accepted_version FROM task_session_delivery WHERE task_id=?')
    .get(task.id);
  assert(row?.accepted_version >= 1, '未确认原生输入');
  const doc = card.ui.document;
  let target;
  function visit(id, path) {
    const el = doc.spec.elements[id];
    if (el.type === 'Button' && el.on?.press && !target) target = { id, path, el };
    el.children.forEach((child) => visit(child, path + '/' + child));
  }
  visit(doc.spec.root, doc.spec.root);
  assert(target, '没有可点击选项');
  const binding = target.el.on.press;
  await api(`/api/cards/${card.id}/actions`, {
    requestId: randomUUID(),
    context: doc.context,
    componentId: target.id,
    instanceId: target.path,
    event: 'press',
    action: binding.action,
    params: resolveValue(binding.params, doc.state),
  });
  const second = await until(async () => {
    const s = await api('/api/snapshot');
    const t = s.tasks.find((t) => t.id === task.id);
    if (t?.status === 'failed') throw new Error(t.error);
    return t?.status === 'completed' && t.execution.version === 2 ? t : undefined;
  }, 'Claude resume');
  assert(second.result.includes(marker), '续接会话未保留记忆');
  const resumed = instance.store.db
    .prepare('SELECT thread_id,accepted_version FROM task_session_delivery WHERE task_id=?')
    .get(task.id);
  assert(
    resumed.thread_id === row.thread_id && resumed.accepted_version === 2,
    '没有续接同一个原生会话',
  );
  let mixed = false;
  if (link.providers.some((p) => p.provider === 'codex' && p.available)) {
    const codex = (await api('/api/bots', { name: 'CodexVerification', provider: 'codex' })).id;
    await api(`/api/bots/${codex}/bind`, { bridgeId: link.id });
    const update = await fetch(url + `/api/groups/${group}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mixed provider verification', botIds: [claude, codex] }),
    });
    assert(update.ok, '混合群组设置失败');
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group,
      content: `@CodexVerification 只读 ${join(directory, 'README.md')}，用一句话说出项目名称和验证暗号，不要修改文件。`,
    });
    const result = await until(async () => {
      const s = await api('/api/snapshot');
      const t = s.tasks.find((t) => t.botId === codex);
      if (t?.status === 'failed') throw new Error(t.error);
      return t?.status === 'completed' ? t : undefined;
    }, 'Codex in mixed group');
    assert(result.result.includes(marker), 'Codex 混合群组读取失败');
    mixed = true;
  }
  console.log(
    JSON.stringify({
      claude: true,
      realFileRead: true,
      concurrentChat: true,
      dynamicCard: true,
      cardSubmission: true,
      resumedNativeSession: true,
      retainedMemory: true,
      mixedClaudeCodexGroup: mixed,
      isolatedDatabase: true,
    }),
  );
} finally {
  bridge.kill('SIGTERM');
  await new Promise((r) => {
    const t = setTimeout(() => {
      bridge.kill('SIGKILL');
      r();
    }, 5000);
    bridge.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  await instance.app.close();
  await rm(directory, { recursive: true, force: true });
}
