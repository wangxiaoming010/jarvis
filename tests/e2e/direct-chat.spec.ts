import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import type { AgentJob, BridgeCommand } from '@openbot/shared';
import { executionModel, testModelConfig } from './model-fixtures';

test('opens a persistent one-to-one chat from a bot and replies without @ or group routing', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-direct-chat-'));
  const token = randomUUID();
  const bridgeId = randomUUID();
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
  instance.runtime.attach(
    {
      id: bridgeId,
      name: '单聊验证设备',
      providers: [{ provider: 'codex', version: 'test', available: true }],
    },
    (command) => commands.push(command),
    () => instance.runtime.detach(bridgeId),
  );

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
    await creation.getByLabel('Bot 名称').fill('DirectBob');
    await expect(creation.getByText(/创建后自动连接/)).toBeVisible();
    await creation.getByRole('button', { name: '创建 Bot', exact: true }).click();
    await expect(creation).not.toBeVisible();

    const bot = instance.store.snapshot().bots[0];
    expect(bot).toMatchObject({ name: 'DirectBob', bridgeId, status: 'idle' });
    await page.getByRole('button', { name: '管理 Bot', exact: true }).first().click();
    await page.getByRole('button', { name: '单独聊天', exact: true }).click();

    await expect(
      page.locator('.main-header').getByRole('heading', { name: 'DirectBob', exact: true }),
    ).toBeVisible();
    const composer = page.getByRole('textbox', { name: '消息内容' });
    await expect(composer).toHaveAttribute('placeholder', '发送消息给 DirectBob…');
    await expect(page.getByRole('button', { name: '提及 Bot' })).toHaveCount(0);
    await expect(page.locator('.overview').getByText('协作方式')).toHaveCount(0);

    await composer.fill('What changed in the latest release?');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => commands.filter((command) => command.type === 'run').length).toBe(1);
    const job = (commands.find((command) => command.type === 'run') as { job: AgentJob }).job;
    expect(job.bot.id).toBe(bot.id);
    expect(job.group.directBotId).toBe(bot.id);
    expect(job.members.map((member) => member.id)).toEqual([bot.id]);
    expect(job.task.input).toBe('What changed in the latest release?');

    instance.runtime.event(bridgeId, {
      type: 'result',
      taskId: job.task.id,
      leaseId: job.leaseId,
      status: 'completed',
      text: 'I can help with that. Which release do you mean?',
    });
    await expect(
      page.locator('.markdown').getByText('I can help with that. Which release do you mean?', {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '与 DirectBob 单独聊天' }).click();
    await expect(
      page.locator('.markdown').getByText('What changed in the latest release?', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.markdown').getByText('I can help with that. Which release do you mean?', {
        exact: true,
      }),
    ).toBeVisible();
    expect(instance.store.snapshot().groups.filter((group) => group.directBotId)).toHaveLength(1);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
