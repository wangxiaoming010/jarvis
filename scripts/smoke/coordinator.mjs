// Opt-in: real DeepSeek coordination and a native read-only worker, entirely in temporary data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../apps/server/src/app.ts';
import { readBrainConfig } from '../../apps/server/src/config.ts';
import { createCoordinatorModel } from '../../apps/server/src/models/coordinator-model.ts';
import { createAttentionModel } from '../../apps/server/src/models/attention-model.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const config = readBrainConfig();
const model = createCoordinatorModel(config);
if (!model) throw new Error('请先配置 DeepSeek 对话模型');
const directory = await mkdtemp(join(tmpdir(), 'openbot-coordinator-smoke-'));
const token = randomBytes(32).toString('hex'),
  bridgeToken = randomBytes(32).toString('hex');
const marker = `verified-${randomUUID()}`;
const fixture = join(directory, 'read-only-verification.txt');
await writeFile(
  fixture,
  `Verification token: ${marker}\nThis is a read-only integration fixture.\n`,
);
let child;
const instance = await createApp({
  databasePath: join(directory, 'db.sqlite'),
  token,
  bridgeToken,
  coordinator: model,
  attention: createAttentionModel({ ...config, model: config.attentionModel || config.model }),
});
async function until(predicate, label, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待超时：${label}`);
}
async function api(url, body) {
  const response = await instance.app.inject({
    method: body ? 'POST' : 'GET',
    url,
    payload: body,
    headers: { authorization: `Bearer ${token}` },
  });
  assert(response.statusCode < 300, `API ${url} failed (${response.statusCode})`);
  return response.json();
}
try {
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const port = instance.app.server.address().port;
  const env = {
    ...process.env,
    OPENBOT_SERVER_URL: `http://127.0.0.1:${port}`,
    OPENBOT_BRIDGE_TOKEN: bridgeToken,
    OPENBOT_DATA_DIR: directory,
  };
  for (const key of Object.keys(env))
    if (/^(DEEPSEEK_|BRAIN_|VITE_|OPENBOT_TOKEN$)/.test(key)) delete env[key];
  if (!env.OPENBOT_CODEX_PATH)
    env.OPENBOT_CODEX_PATH =
      [
        '/Applications/Codex.app/Contents/Resources/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      ].find((path) => existsSync(path)) ?? 'codex';
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/bridge/src/index.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const bridge = await until(
    () => instance.runtime.bridges.find((b) => b.providers.some((p) => p.available)),
    '本地执行工具连接',
    30000,
  );
  const provider =
    process.env.OPENBOT_SMOKE_PROVIDER &&
    bridge.providers.some((p) => p.provider === process.env.OPENBOT_SMOKE_PROVIDER && p.available)
      ? process.env.OPENBOT_SMOKE_PROVIDER
      : (bridge.providers.find((p) => p.provider === 'claude-code' && p.available)?.provider ??
        bridge.providers.find((p) => p.available).provider);
  const bot = await api('/api/bots', {
    name: 'PersistentSmoke',
    provider,
    description: '负责只读验证，准确复述真实文件中的内容，检查执行结果后交付。',
  });
  const chat = await api(`/api/bots/${bot.id}/chat`, {});
  const send = (content) => api('/api/messages', { id: randomUUID(), groupId: chat.id, content });
  const greeting = await send(
    '我们先聊聊，这轮验证只读取文件，不做修改。简短确认即可，不启动执行。',
  );
  await until(
    () =>
      instance.store
        .snapshot()
        .messages.some((m) => m.senderType === 'bot' && m.replyTo === greeting.id),
    '独立对话',
  );
  assert.equal(instance.store.snapshot().tasks.length, 0, '普通对话不能派发执行');
  console.log('PASS: independent conversation without execution.');
  const request = await send(
    `请实际读取 ${fixture}，准确告诉我文件里的 Verification token。只读取，不运行命令，不修改文件；使用本机 ${provider} 执行并检查结果后直接文字回复，不需要卡片。`,
  );
  const task = await until(
    () => instance.store.snapshot().tasks.find((t) => t.correlationId === request.correlationId),
    '真实任务创建',
  );
  await until(
    () => instance.store.snapshot().tasks.find((t) => t.id === task.id)?.status === 'completed',
    '原生读取与主会话验收',
  );
  await until(
    () =>
      instance.store
        .snapshot()
        .messages.some(
          (m) => m.senderType === 'bot' && m.replyTo === request.id && m.content.includes(marker),
        ),
    '经过验收的真实结果回复',
  );
  const run = instance.store.db
    .prepare(
      'SELECT provider,status,result FROM worker_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',
    )
    .get(task.id);
  assert.equal(run.status, 'completed');
  assert(run.result.includes(marker), '原生执行必须实际读到随机验证内容');
  assert.equal(
    instance.store.db.prepare('SELECT review FROM task_workers WHERE task_id=?').get(task.id)
      .review,
    'accepted',
  );
  assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM routing_decisions').get().n, 0);
  console.log(
    `PASS: DeepSeek → ${run.provider} → actual file read → evidence review → human reply.`,
  );
} catch (error) {
  console.log(
    JSON.stringify({
      diagnostic: instance.store.snapshot().tasks.map((t) => ({
        status: t.status,
        error: t.error,
        activity: t.execution?.activity,
        report: t.execution?.report,
        output: t.result?.slice(-1500),
      })),
      pendingInteractions: instance.store.db
        .prepare("SELECT status,spec FROM native_requests WHERE status='pending'")
        .all(),
      turns: instance.store.db
        .prepare('SELECT status,rounds,error FROM coordinator_turns ORDER BY rowid')
        .all(),
      calls: instance.store.db
        .prepare('SELECT name,result FROM coordinator_calls ORDER BY rowid')
        .all(),
      modelErrors: instance.store.db
        .prepare(
          "SELECT error FROM coordinator_turns WHERE status='failed' ORDER BY rowid DESC LIMIT 3",
        )
        .all(),
    }),
  );
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await instance.app.close();
  await rm(directory, { recursive: true, force: true });
}
