import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';

test('desktop obtains credentials through native IPC, ignores stale browser settings and retries without a form', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-auto-connect-'));
  const token = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
  });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.app.server.address() as { port: number };
  try {
    await page.addInitScript(
      ({ token, url }) => {
        localStorage.setItem('openbot.server', 'http://127.0.0.1:1');
        sessionStorage.setItem('openbot.token', 'old-invalid-token');
        Object.assign(window, {
          isTauri: true,
          __TAURI_INTERNALS__: {
            invoke: async (command: string) => {
              if (command !== 'local_service') throw new Error('Unexpected native command');
              if (!(window as unknown as { localReady: boolean }).localReady)
                throw '本地服务暂时无法启动，请重试。';
              return { url, token };
            },
          },
        });
      },
      { url: `http://127.0.0.1:${address.port}`, token },
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: '重试连接', exact: true }).last()).toBeVisible();
    await page.evaluate(() => Object.assign(window, { localReady: true }));
    await page.getByRole('button', { name: '重试连接', exact: true }).last().click();
    await expect(page.locator('.statusbar > button')).toContainText('协作服务已连接');
    await expect(page.getByRole('heading', { name: '先配置对话模型' })).toBeVisible();
    await expect(page.getByRole('button', { name: '服务连接设置' })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('openbot.token'))).toBe(
      'old-invalid-token',
    );
    await page.reload();
    await page.evaluate(() => Object.assign(window, { localReady: true }));
    await page.getByRole('button', { name: '重试连接', exact: true }).last().click();
    await expect(page.locator('.statusbar > button')).toContainText('协作服务已连接');
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
