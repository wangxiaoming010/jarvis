// Opt-in real-model greeting check in an isolated database; no real chat or worker is touched.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../apps/server/src/app.ts';
import { readBrainConfig } from '../../apps/server/src/config.ts';
import { ModelSettings } from '../../apps/server/src/models/model-settings.ts';
import { createCoordinatorModel } from '../../apps/server/src/models/coordinator-model.ts';
import { createAttentionModel } from '../../apps/server/src/models/attention-model.ts';

if (!process.argv.includes('--live')) throw new Error('请传入 --live 使用当前模型进行隔离问候验证');
if (existsSync('.env')) process.loadEnvFile('.env');
const config = new ModelSettings(
  resolve(process.env.DATABASE_PATH ?? '.data/openbot.sqlite'),
  readBrainConfig(),
).current();
const coordinator = createCoordinatorModel(config);
const attention = createAttentionModel({ ...config, model: config.attentionModel || config.model });
if (!coordinator || !attention) throw new Error('请先配置模型');
const directory = mkdtempSync(join(tmpdir(), 'openbot-social-live-'));
const token = randomBytes(32).toString('hex');
let instance;
try {
  instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    coordinator,
    attention,
  });
  const api = async (url, payload) => {
    const r = await instance.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.statusCode >= 300) throw new Error(`隔离测试请求失败（HTTP ${r.statusCode}）`);
    return r.json();
  };
  const bots = [];
  for (const [name, description] of [
    ['BB', '一个互联网产品经理'],
    ['DEV', '万能资深开发'],
  ])
    bots.push(await api('/api/bots', { name, description, provider: 'codex' }));
  const group = await api('/api/groups', { name: '隔离问候验证', botIds: bots.map((b) => b.id) });
  const source = await api('/api/messages', {
    id: randomUUID(),
    groupId: group.id,
    content: '大家好',
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const pending = instance.store.db
      .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
      .get().n;
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const state = instance.store.snapshot();
  const replies = state.messages.filter((m) => m.senderType === 'bot');
  const pending = instance.store.db
    .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')")
    .get().n;
  const failed = instance.store.db
    .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status='failed'")
    .get().n;
  const passed =
    !pending &&
    !failed &&
    replies.length === bots.length &&
    replies.every(
      (m) =>
        m.replyTo === source.id &&
        m.content.trim() &&
        !/我不插话|保持沉默|任务编号|Codex|Claude|worker/i.test(m.content),
    ) &&
    !state.tasks.length;
  console.log(
    JSON.stringify({
      model: config.model,
      attentionModel: config.attentionModel || config.model,
      passed,
      pending,
      failed,
      taskCount: state.tasks.length,
      replies: replies.map((m) => ({
        bot: state.bots.find((b) => b.id === m.senderId)?.name,
        content: m.content,
      })),
      realDataWritten: false,
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await instance?.app.close();
  rmSync(directory, { recursive: true, force: true });
}
