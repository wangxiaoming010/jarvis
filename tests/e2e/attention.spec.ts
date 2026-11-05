import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { testModelConfig } from './model-fixtures';

test('keeps irrelevant Bots silent and retries attention failures beneath the source Bot message', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-attention-browser-'));
  const token = randomUUID();
  let fail = true;
  let devCalls = 0;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
    modelConfig: testModelConfig,
    attention: async (i) => {
      if (i.message.content === '先不讨论') return { wake: false };
      if (i.message.actor.type === 'human') return { wake: i.bot.name === 'BB' };
      if (i.bot.name !== 'DEV') return { wake: false };
      if (fail) throw new Error('模拟模型连接失败');
      return { wake: true };
    },
    coordinator: async (messages) => {
      const data = JSON.parse(messages[1].content!);
      if (data.bot.name === 'DEV') {
        devCalls++;
        return { role: 'assistant', content: '已核实实现限制。' };
      }
      return {
        role: 'assistant',
        content: data.event.actor.type === 'human' ? '接口有变更，需要核实实现。' : '',
      };
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
    const bb = await api('/api/bots', { name: 'BB', provider: 'codex' });
    const dev = await api('/api/bots', { name: 'DEV', provider: 'codex' });
    await api('/api/groups', { name: '注意力验证', botIds: [bb.id, dev.id] });
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    await page.goto('/');
    await page.getByRole('button', { name: '注意力验证', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '消息内容' });
    await composer.fill('先不讨论');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect
      .poll(() =>
        instance.store.db
          .prepare("SELECT count(*) AS n FROM dialogue_inbox WHERE status='ignored'")
          .get(),
      )
      .toEqual({ n: 2 });
    expect(instance.store.snapshot().messages).toHaveLength(1);
    expect(devCalls).toBe(0);
    await composer.fill('BB继续吧');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试 DEV', exact: true })).toBeVisible();
    await expect(page.locator('.dialogue-retry-row')).toContainText('群消息判断失败');
    expect(devCalls).toBe(0);
    expect(instance.store.snapshot().tasks).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('attention-retry.png') });
    fail = false;
    await page.getByRole('button', { name: '重试 DEV', exact: true }).click();
    await expect(
      page.locator('.markdown').getByText('已核实实现限制。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '重试 DEV', exact: true })).toHaveCount(0);
    expect(devCalls).toBe(1);
    expect(instance.store.snapshot().tasks).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
