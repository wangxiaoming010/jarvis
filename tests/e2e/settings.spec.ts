import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';

test('requires model setup at creation and execution entry points, including existing workspaces', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-setup-gate-'));
  const token = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
  });
  try {
    // Existing records must not let an unconfigured workspace skip setup.
    const bot = (
      await instance.app.inject({
        method: 'POST',
        url: '/api/bots',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'ExistingBot', provider: 'codex' },
      })
    ).json();
    await instance.app.inject({
      method: 'POST',
      url: '/api/bots/' + bot.id + '/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    const mutations: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '先配置对话模型' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息内容' })).toHaveCount(0);
    await expect(page.locator('.overview')).toHaveCount(0);
    const entryPoints = [
      page.getByRole('button', { name: '创建 Bot', exact: true }).first(),
      page.getByRole('button', { name: '创建群组', exact: true }).first(),
      page.getByRole('button', { name: '与 ExistingBot 单独聊天', exact: true }),
      page.locator('.bridge-widget'),
    ];
    for (const entry of entryPoints) {
      await entry.click();
      await expect(page.getByRole('heading', { name: '对话模型', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    }
    expect(mutations).toEqual([]);
    expect(instance.store.snapshot().bots).toHaveLength(1);
    expect(instance.store.snapshot().groups).toHaveLength(1);
    expect(instance.store.snapshot().messages).toHaveLength(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: '先配置对话模型' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '配置对话模型', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -235, 0)');
    await expect(page.locator('.view-container')).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: testInfo.outputPath('model-setup-mobile.png') });
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '创建群组', exact: true }).first().click();
    await expect(page.getByLabel('模型服务', { exact: true })).toBeVisible();
    await expect(page.locator('.sidebar-scrim')).toHaveCount(0);
    expect(mutations).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('starts empty and saves the selected Bot model after automatically loading the account list', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-settings-browser-'));
  const token = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
  });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const listRequests: Record<string, unknown>[] = [];
  try {
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    await page.route('**/api/settings/models', async (route) => {
      listRequests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          models: [
            { id: 'ui-test-model', name: 'UI test conversation model' },
            { id: 'second-test-model', name: 'Second model' },
          ],
        },
      });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '先配置对话模型', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始协作', exact: true })).toHaveCount(0);
    await expect(page.locator('header.titlebar')).toHaveText('');
    await expect(page.getByRole('button', { name: '聊天', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bot', exact: true })).toHaveCount(0);
    await expect(page.locator('.sidebar-bot-section + .activity-nav')).toContainText('活动记录');
    await expect(page.locator('.view-container')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('empty-workspace.png') });

    await expect(page.getByRole('textbox', { name: '消息内容' })).toHaveCount(0);
    await page.getByRole('button', { name: '配置对话模型', exact: true }).click();
    await expect(
      page.getByText('请先填写 API Key、选择对话模型并保存', { exact: false }),
    ).toBeVisible();
    await page.getByLabel('模型服务', { exact: true }).selectOption('openai');
    await expect(page.locator('#model-base-url')).toHaveValue('https://api.openai.com/v1');
    const key = 'isolated-browser-only-key';
    await page.locator('#model-api-key').fill(key);
    await expect(page.locator('#model-api-key')).toHaveAttribute('type', 'password');
    await expect(page.getByText('已获取 2 个模型')).toBeVisible();
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]).toMatchObject({ provider: 'openai', apiKey: key });
    await page.getByLabel('选择模型', { exact: true }).selectOption('ui-test-model');
    await page.getByLabel('注意力模型', { exact: true }).selectOption('second-test-model');
    await page.route('**/api/settings/model', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 503, json: { error: '设置保存失败，请重试' } });
    });
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('设置保存失败，请重试');
    await expect(page.locator('.model-setup-next')).toHaveCount(0);
    await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(instance.store.snapshot().bots).toHaveLength(0);
    await page.unroute('**/api/settings/model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await expect(page.locator('.model-current')).toContainText('OpenAI / ui-test-model');
    await expect(page.locator('#model-api-key')).toHaveValue('');
    await expect(page.getByText('对话模型已就绪，接下来创建你的第一位 Bot。')).toBeVisible();
    const settings = await page.request.get(url + '/api/settings/model', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await settings.json()).toMatchObject({
      provider: 'openai',
      model: 'ui-test-model',
      attentionModel: 'second-test-model',
      hasKey: true,
    });
    expect(await settings.text()).not.toContain(key);
    await page.screenshot({ path: testInfo.outputPath('model-settings.png') });

    await page
      .locator('.model-setup-next')
      .getByRole('button', { name: '创建 Bot', exact: true })
      .click();
    const botDialog = page.getByRole('dialog');
    await botDialog.getByLabel('Bot 名称').fill('ConfiguredBot');
    await botDialog.getByRole('button', { name: '创建 Bot', exact: true }).click();
    await expect(botDialog).not.toBeVisible();
    expect(instance.store.snapshot().bots).toMatchObject([{ name: 'ConfiguredBot' }]);

    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('选择模型', { exact: true })).toHaveValue('ui-test-model');
    await expect(page.getByLabel('注意力模型', { exact: true })).toHaveValue('second-test-model');
    await expect(page.locator('#model-api-key')).toHaveValue('');
    await expect(page.getByText('已保存在本机', { exact: true })).toBeVisible();
    await expect.poll(() => listRequests.length).toBeGreaterThan(1);
    expect(listRequests.at(-1)).not.toHaveProperty('apiKey');
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(key);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.locator('#model-provider')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('saves and restores execution permission mode independently of model credentials', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-permissions-browser-'));
  const token = randomUUID();
  const instance = await createApp({
    databasePath: join(directory, 'db.sqlite'),
    token,
    clientOrigin: 'http://127.0.0.1:1421',
  });
  try {
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
    await page.addInitScript(
      ({ url, token }) => {
        localStorage.setItem('openbot.server', url);
        sessionStorage.setItem('openbot.token', token);
      },
      { url, token },
    );
    await page.goto('/');
    await page.getByRole('button', { name: '配置对话模型', exact: true }).click();
    const mode = page.getByLabel('权限模式', { exact: true });
    await expect(mode).toHaveValue('auto');
    await mode.selectOption('manual');
    await page.getByRole('button', { name: '保存执行权限', exact: true }).click();
    await expect(page.getByText('执行权限已保存', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '配置对话模型', exact: true }).click();
    await expect(mode).toHaveValue('manual');
    await mode.selectOption('auto');
    await page.getByRole('button', { name: '保存执行权限', exact: true }).click();
    await expect(page.getByText('执行权限已保存', { exact: true })).toBeVisible();
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
