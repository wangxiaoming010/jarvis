import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { testModelConfig } from './model-fixtures';

test('shows offline goal ownership and an actionable owner decision without requiring a worker', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-goal-browser-')),
    token = randomUUID();
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
                  arguments: JSON.stringify({
                    title: '持续推进项目交付',
                    criteria: ['改动已应用到项目'],
                    delivery: 'applied',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: '' };
    },
  });
  const api = async (url: string, payload: unknown) => {
    const r = await instance.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBeLessThan(300);
    return r.json();
  };
  try {
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
    const b = await api('/api/bots', { name: 'BB', provider: 'codex' }),
      g = await api('/api/groups', { name: '项目目标', botIds: [b.id] });
    await api('/api/messages', {
      id: randomUUID(),
      groupId: g.id,
      content: '@BB 接下项目交付，设备恢复后再执行',
    });
    const idle = async () =>
      expect
        .poll(() =>
          instance.store.db
            .prepare(
              "SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')",
            )
            .get(),
        )
        .toEqual({ n: 0 });
    await idle();
    expect(instance.store.snapshot().tasks).toHaveLength(0);
    const id = instance.store.snapshot().goals![0].id;
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
    const card = page.locator('.goal-card').filter({ hasText: '持续推进项目交付' });
    await expect(card).toContainText('进行中');
    await expect(card).toContainText('下次检查：');
    await expect(card).toContainText('完成条件：应用到目标项目');
    for (let i = 0; i < 3; i++) {
      instance.runtime.checkProgress(
        Date.parse(instance.store.snapshot().goals![0].nextCheckAt!) + 1,
      );
      await idle();
    }
    await expect(card).toContainText('需要你决定');
    await expect(card.getByRole('status')).toContainText('目标尚未安排后续行动');
    expect(instance.store.snapshot().goals![0]).toMatchObject({ id, ownerWait: 1 });
    await page.reload();
    await page.getByRole('button', { name: '活动记录', exact: true }).click();
    await page.getByRole('button', { name: /^目标与任务/ }).click();
    await expect(page.locator('.goal-card')).toContainText('需要你决定');
    await page.screenshot({ path: testInfo.outputPath('persistent-goal.png'), fullPage: true });
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
