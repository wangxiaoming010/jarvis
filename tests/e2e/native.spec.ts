import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import type { AgentJob, BridgeCommand } from '@openbot/shared';
import { executionModel, testModelConfig } from './model-fixtures';

test('native questions and permissions round-trip inside the group without spawning a new execution', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-native-browser-')),
    token = randomUUID(),
    bridgeId = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
    modelConfig: testModelConfig,
    coordinator: executionModel,
    attention: async () => ({ wake: false }),
  });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const commands: BridgeCommand[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  instance.runtime.attach(
    {
      id: bridgeId,
      name: '交互验证设备',
      providers: [{ provider: 'codex', version: 'test', available: true }],
    },
    (command) => commands.push(command),
    () => instance.runtime.detach(bridgeId),
  );
  async function api(path: string, body: unknown) {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }
  try {
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    await page.goto('/');
    await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
    const creation = page.getByRole('dialog');
    await creation.getByLabel('Bot 名称').fill('NativeBob');
    await expect(creation.getByText(/创建后自动连接/)).toBeVisible();
    await expect(creation.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath('device-binding.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await creation.getByRole('button', { name: '创建 Bot', exact: true }).click();
    await expect(creation).not.toBeVisible();
    const created = instance.store.snapshot().bots.find((bot) => bot.name === 'NativeBob')!;
    expect(created).toMatchObject({ bridgeId, status: 'idle' });
    const bot = created.id;
    const group = (await api('/api/groups', { name: '原生交互验证', botIds: [bot] })).id;
    await page.getByRole('button', { name: '管理 Bot', exact: true }).first().click();
    const profile = page.locator('.bot-profile').filter({
      has: page.getByRole('heading', { name: 'NativeBob', exact: true }),
    });
    await expect(profile.locator('.status-label')).toHaveClass(/idle/);
    await profile.getByRole('button', { name: '查看执行状态' }).click();
    const binding = page.getByRole('dialog');
    await expect(binding.getByRole('textbox')).toHaveCount(0);
    await expect(binding.getByLabel('执行工具')).toHaveValue('codex');
    await expect(binding.getByRole('button', { name: /绑定|切换运行设备/ })).toHaveCount(0);
    await binding.getByRole('button', { name: '取消', exact: true }).click();
    await expect(binding).not.toBeVisible();
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group,
      content: '@NativeBob 看一下这个项目',
    });
    await expect.poll(() => commands.some((c) => c.type === 'run')).toBe(true);
    const job = (commands.find((c) => c.type === 'run') as { job: AgentJob }).job;
    const event = (requestId: string, request: unknown) =>
      instance.runtime.event(bridgeId, {
        type: 'interaction',
        taskId: job.task.id,
        leaseId: job.leaseId,
        requestId,
        request: request as any,
      });
    event('question', {
      kind: 'question',
      title: '确认检查范围',
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '这次先看哪部分？',
          options: [
            { label: '架构', description: '整体设计' },
            { label: '安全', description: '访问边界' },
          ],
          allowOther: false,
        },
        { id: 'note', header: '补充', question: '有什么需要特别留意？', allowOther: true },
      ],
    });
    await page.getByRole('button', { name: '原生交互验证', exact: true }).click();
    const card = page.getByRole('region', { name: '执行提问' });
    await expect(card.getByText('这次先看哪部分？')).toBeVisible();
    await page.reload();
    await card.getByRole('radio', { name: /安全/ }).check();
    await card.getByRole('textbox', { name: '有什么需要特别留意？' }).fill('检查缓存清理');
    await card.getByRole('button', { name: '提交回答', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('已回答');
    await expect(card.getByRole('textbox', { name: '有什么需要特别留意？' })).toHaveValue(
      '检查缓存清理',
    );
    await page.reload();
    await expect(card.getByRole('radio', { name: /安全/ })).toBeChecked();
    await expect(card.getByRole('textbox', { name: '有什么需要特别留意？' })).toBeDisabled();
    const response = commands.find((c) => c.type === 'native_reply');
    expect(response).toMatchObject({
      requestId: 'question',
      leaseId: job.leaseId,
      response: { decision: 'accept', answers: { scope: ['安全'], note: ['检查缓存清理'] } },
    });
    expect(commands.filter((c) => c.type === 'run')).toHaveLength(1);
    event('command', {
      kind: 'command',
      title: '需要你允许运行命令',
      command: 'printf native-check',
      cwd: directory,
    });
    const permission = page.getByRole('region', { name: '操作授权' });
    await expect(permission.getByText('printf native-check', { exact: true })).toBeVisible();
    await permission.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(permission.getByRole('status')).toContainText('拒绝');
    expect(commands.filter((c) => c.type === 'native_reply').at(-1)).toMatchObject({
      requestId: 'command',
      response: { decision: 'decline' },
    });
    event('multiple', {
      kind: 'question',
      title: '补充检查范围',
      questions: [
        {
          id: 'areas',
          header: '范围',
          question: '选择需要检查的部分',
          options: [
            { label: '架构', description: '整体设计' },
            { label: '安全', description: '访问边界' },
          ],
          multiSelect: true,
          allowOther: true,
        },
        {
          id: 'secret',
          header: '口令',
          question: '临时验证口令',
          isSecret: true,
          allowOther: true,
        },
      ],
    });
    const multiple = page.getByRole('region', { name: '执行提问' }).last();
    await multiple.getByRole('textbox', { name: '选择需要检查的部分（其他回答）' }).fill('缓存');
    await multiple.getByRole('checkbox', { name: /安全/ }).check();
    await multiple.getByLabel('临时验证口令', { exact: true }).fill('temporary-native-check');
    await page.screenshot({
      path: testInfo.outputPath('native-interaction.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await multiple.getByRole('button', { name: '提交回答', exact: true }).click();
    await expect(multiple.getByRole('status')).toContainText('已回答');
    expect(commands.filter((c) => c.type === 'native_reply').at(-1)).toMatchObject({
      requestId: 'multiple',
      response: {
        decision: 'accept',
        answers: { areas: ['安全', '缓存'], secret: ['temporary-native-check'] },
      },
    });
    await page.reload();
    await expect(multiple.getByRole('checkbox', { name: /安全/ })).toBeChecked();
    await expect(
      multiple.getByRole('textbox', { name: '选择需要检查的部分（其他回答）' }),
    ).toHaveValue('缓存');
    await expect(multiple.getByLabel('临时验证口令', { exact: true })).toHaveValue('••••••');
    expect(JSON.stringify(instance.store.snapshot())).not.toContain('temporary-native-check');
    event('permission', {
      kind: 'permission',
      title: '读取项目文件',
      details: { permissions: { fileSystem: { read: ['/example/project'] } } },
      allowSession: true,
    });
    const grant = page.getByRole('region', { name: '操作授权' }).last();
    await grant.getByRole('button', { name: '本次会话允许', exact: true }).click();
    await expect(grant.getByRole('status')).toContainText('已允许本次会话');
    expect(commands.filter((c) => c.type === 'native_reply').at(-1)).toMatchObject({
      requestId: 'permission',
      response: { decision: 'accept', scope: 'session' },
    });
    event('expired', {
      kind: 'permission',
      title: '访问另一个位置',
      details: { permissions: { fileSystem: { read: ['/example/project'] } } },
      allowSession: true,
    });
    const last = page.getByRole('region', { name: '操作授权' }).last();
    await expect(last.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
    await api(`/api/chains/${job.task.correlationId}/stop`, {});
    await expect(last.getByRole('status')).toContainText('失效');
    await expect(last.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({
      path: testInfo.outputPath('native-interaction-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(commands.filter((c) => c.type === 'run')).toHaveLength(1);
    expect(instance.store.snapshot().messages.filter((m) => m.senderType === 'human')).toHaveLength(
      1,
    );
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
