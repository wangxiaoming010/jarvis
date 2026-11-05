import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob, BridgeCommand } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
import { TaskContracts } from '../../apps/server/src/work/task-contracts';
import { testModelConfig } from './model-fixtures';

test('shows task health in activity records while worker reports stay out of chat', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-health-browser-'));
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
                  arguments: JSON.stringify({ goal: '检查任务状态' }),
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
    const group = await api('/api/groups', { name: '状态验证', botIds: [bot.id] });
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group.id,
      content: '@BB 检查任务状态',
    });
    await expect.poll(() => commands.some((c) => c.type === 'run')).toBe(true);
    const job = (commands.find((c) => c.type === 'run') as { job: AgentJob }).job;
    instance.runtime.event('device', {
      type: 'report',
      taskId: job.task.id,
      leaseId: job.leaseId,
      reportKind: 'blocked',
      report: '需要确认数据范围',
    });
    await expect
      .poll(() =>
        instance.store.db
          .prepare(
            "SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')",
          )
          .get(),
      )
      .toEqual({ n: 0 });
    expect(instance.store.snapshot().tasks[0].execution!.health!.state).toBe('blocked');
    expect(instance.store.snapshot().messages).toHaveLength(1);
    new TaskContracts(instance.store).plan(
      instance.store.snapshot().tasks[0],
      {
        nextAction: '核实数据范围后继续检查',
        waitCondition: '等待所有者提供范围',
        nextWakeAt: new Date(Date.now() + 3600000).toISOString(),
      },
      false,
    );
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    await page.goto('/');
    await page.getByRole('button', { name: '活动记录', exact: true }).click();
    await page.getByRole('button', { name: /^目标与任务/ }).click();
    const card = page.locator('.task-card').filter({ hasText: '@BB 检查任务状态' });
    await expect(card.getByRole('status')).toHaveText('执行受阻：需要确认数据范围');
    await expect(card).toContainText('下一步：核实数据范围后继续检查');
    await expect(card).toContainText('等待：等待所有者提供范围');
    await expect(card).toContainText('下次检查：');
    await expect(card).not.toContainText('codex');
    await expect(card).not.toContainText('pipeline');
    await page.screenshot({ path: testInfo.outputPath('task-health.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
