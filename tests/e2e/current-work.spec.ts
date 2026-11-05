import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeCommand } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import { testModelConfig } from './model-fixtures';

test('shows a Bot’s group execution once in its private chat and stops it from there', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-current-work-'));
  const token = randomUUID();
  const commands: BridgeCommand[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
    modelConfig: testModelConfig,
    coordinator: async (messages) => {
      const d = JSON.parse(messages[1].content!);
      return d.event.kind === 'message' && messages.at(-1)?.role !== 'tool'
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'start',
                type: 'function',
                function: {
                  name: 'start_worker',
                  arguments: JSON.stringify({ goal: '整理发布清单' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: '' };
    },
  });
  instance.runtime.attach(
    {
      id: 'device',
      name: '验证设备',
      providers: [{ provider: 'codex', available: true, version: 'test' }],
    },
    (command) => commands.push(command),
    () => instance.runtime.detach('device'),
  );
  const api = async (url: string, payload: unknown) => {
    const response = await instance.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBeLessThan(300);
    return response.json();
  };
  try {
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
    const bot = await api('/api/bots', { name: 'BB', provider: 'codex' });
    const group = await api('/api/groups', { name: '发布群', botIds: [bot.id] });
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group.id,
      content: '@BB 整理发布清单',
    });
    await expect.poll(() => commands.some((c) => c.type === 'run')).toBe(true);
    const chat = await api(`/api/bots/${bot.id}/chat`, {});
    await page.addInitScript(
      ({ url, token, chat }) => {
        localStorage.setItem('openbot.server', url);
        localStorage.setItem('openbot.group', chat);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token, chat: chat.id },
    );
    await page.goto('/');
    const overview = page.locator('.overview');
    await expect(overview.getByRole('heading', { name: '当前工作 1' })).toBeVisible();
    const card = overview.locator('.current-work-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('BB');
    await expect(card.getByRole('button', { name: /群组 · 发布群/ })).toBeVisible();
    await expect(card.getByRole('button', { name: '停止本轮工作' })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('private-current-work.png') });

    await card.getByRole('button', { name: /群组 · 发布群/ }).click();
    await expect(
      page.locator('.main-header').getByRole('heading', { name: '发布群', exact: true }),
    ).toBeVisible();
    await expect(overview.locator('.current-work-card')).toHaveCount(1);
    await expect(overview.locator('.work-source')).toHaveText('群组 · 发布群');

    await overview.getByRole('button', { name: '停止本轮工作' }).click();
    await expect
      .poll(() => instance.store.snapshot().tasks[0].status)
      .toMatch(/^(cancelling|cancelled)$/);
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ends a goal that is waiting between executions after inline confirmation', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-end-goal-'));
  const token = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
    modelConfig: testModelConfig,
    coordinator: async (messages) => {
      const d = JSON.parse(messages[1].content!);
      return d.event.kind === 'message' && messages.at(-1)?.role !== 'tool'
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'own',
                type: 'function',
                function: {
                  name: 'create_goal',
                  arguments: JSON.stringify({ title: '跟进发布反馈', criteria: ['反馈已处理'] }),
                },
              },
            ],
          }
        : { role: 'assistant', content: '' };
    },
  });
  const api = async (url: string, payload: unknown) => {
    const response = await instance.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBeLessThan(300);
    return response.json();
  };
  try {
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
    const bot = await api('/api/bots', { name: 'BB', provider: 'codex' });
    const group = await api('/api/groups', { name: '反馈群', botIds: [bot.id] });
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group.id,
      content: '@BB 跟进发布反馈',
    });
    await expect.poll(() => instance.store.snapshot().goals?.length).toBe(1);
    expect(instance.store.snapshot().tasks).toHaveLength(0);
    await page.addInitScript(
      ({ url, token, group }) => {
        localStorage.setItem('openbot.server', url);
        localStorage.setItem('openbot.group', group);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token, group: group.id },
    );
    await page.goto('/');
    const card = page.locator('.overview .current-work-card');
    await expect(card).toContainText('跟进发布反馈');
    await expect(card.getByRole('button', { name: '停止本轮工作' })).toHaveCount(0);
    await card.getByRole('button', { name: '结束目标' }).click();
    await expect(card).toContainText('结束后 BB 不再推进这个目标。');
    await page.screenshot({ path: testInfo.outputPath('end-goal-confirm.png') });
    await card.getByRole('button', { name: '返回' }).click();
    expect(instance.store.snapshot().goals![0].state).not.toBe('cancelled');
    await card.getByRole('button', { name: '结束目标' }).click();
    await card.getByRole('button', { name: '确认结束' }).click();
    await expect.poll(() => instance.store.snapshot().goals![0].state).toBe('cancelled');
    await expect(page.locator('.overview .current-work-card')).toHaveCount(0);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
