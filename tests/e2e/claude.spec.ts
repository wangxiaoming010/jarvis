import { test, expect } from './model-fixtures';

test('selects the execution tool when creating a bot and saves changes while offline', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const name = `Local_${Date.now().toString().slice(-7)}`;
  await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Bot 名称').fill(name);
  await dialog.getByRole('radio', { name: 'Claude Code', exact: true }).check();
  await expect(dialog.getByText(/Claude Code 暂不可用/)).toBeVisible();
  await dialog.getByRole('button', { name: '创建 Bot', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '管理 Bot', exact: true }).first().click();
  const profile = page
    .locator('.bot-profile')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(profile.locator('.provider-tag')).toHaveCount(0);
  await profile.getByRole('button', { name: '查看执行状态' }).click();
  await expect(
    dialog.getByRole('heading', { name: `${name} 的执行状态`, exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/读取和搜索文件/)).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByLabel('执行工具')).toHaveValue('claude-code');
  await dialog.getByLabel('执行工具').selectOption('codex');
  await dialog.getByRole('button', { name: '保存执行设置' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '管理 Bot', exact: true }).first().click();
  await profile.getByRole('button', { name: '查看执行状态' }).click();
  await expect(dialog.getByLabel('执行工具')).toHaveValue('codex');
  await page.screenshot({
    path: testInfo.outputPath('execution-settings.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
