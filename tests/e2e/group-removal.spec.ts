import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { testModelConfig } from './model-fixtures';

test('deletes a group from its top-right settings after confirmation and preserves its Bots', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-delete-browser-'));
  const token = randomUUID();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
    modelConfig: testModelConfig,
    coordinator: async () => ({ role: 'assistant', content: '' }),
    attention: async () => ({ wake: false }),
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
    const bot = await api('/api/bots', { name: 'BB', provider: 'codex' });
    const group = await api('/api/groups', { name: '待删除群组', botIds: [bot.id] });
    const keep = await api('/api/groups', { name: '保留群组', botIds: [bot.id] });
    await api('/api/messages', {
      id: randomUUID(),
      groupId: group.id,
      content: '这条消息随群组删除',
    });
    await page.addInitScript(
      ({ url, token, id }) => {
        localStorage.setItem('openbot.server', url);
        localStorage.setItem('openbot.group', id);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token, id: group.id },
    );
    await page.goto('/');
    await page.getByRole('textbox', { name: '消息内容' }).fill('未发送的草稿');
    await page.getByRole('button', { name: '群组设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '删除群组', exact: true }).click();
    await expect(dialog).toContainText('确定删除「待删除群组」？');
    await expect(dialog).toContainText('Bot 及各自的长期记忆会保留');
    await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png') });
    await dialog.getByRole('button', { name: '返回', exact: true }).click();
    await expect(dialog.getByLabel('群组名称')).toHaveValue('待删除群组');
    expect(instance.store.snapshot().groups.some((g) => g.id === group.id)).toBe(true);
    await dialog.getByRole('button', { name: '删除群组', exact: true }).click();
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '待删除群组', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '保留群组', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '与 BB 单独聊天', exact: true })).toBeVisible();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), `openbot.draft.${url}.${group.id}`),
    ).toBeNull();
    expect(instance.store.snapshot().groups.map((g) => g.id)).toEqual([keep.id]);
    expect(instance.store.snapshot().messages).toHaveLength(0);
    await page.reload();
    await expect(page.getByRole('button', { name: '待删除群组', exact: true })).toHaveCount(0);
    // Deleting the final group returns to the empty workspace.
    await page.getByRole('button', { name: '群组设置', exact: true }).click();
    await dialog.getByRole('button', { name: '删除群组', exact: true }).click();
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '开始使用 Personal OpenBot Group', exact: true }),
    ).toBeVisible();
    expect(instance.store.snapshot().bots).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
