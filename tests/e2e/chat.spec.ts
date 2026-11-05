import { test, expect } from './model-fixtures';
test('create a bot and group, synchronize real messages, reply, search and preserve drafts', async ({
  page,
  context,
}) => {
  const suffix = Date.now().toString().slice(-7);
  const botName = `Alice_${suffix}`;
  const groupName = `客户端验收_${suffix}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.statusbar > button')).toContainText('协作服务已连接');
  await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
  const botDialog = page.getByRole('dialog');
  await botDialog.getByLabel('Bot 名称').fill(botName);
  await botDialog.getByLabel('职责描述').fill('真实持久身份，等待本地 Bridge 接入');
  await botDialog.getByRole('button', { name: '创建 Bot', exact: true }).click();
  await expect(botDialog).not.toBeVisible();
  await page.getByRole('button', { name: '创建群组', exact: true }).first().click();
  const groupDialog = page.getByRole('dialog');
  await groupDialog.getByLabel('群组名称').fill(groupName);
  await groupDialog.getByRole('button', { name: new RegExp(botName) }).click();
  await groupDialog.getByRole('button', { name: '创建群组', exact: true }).click();
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: groupName, exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('这是一条真实保存的协作消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.locator('.markdown').getByText('这是一条真实保存的协作消息', { exact: true }),
  ).toBeVisible();
  await expect(
    second.locator('.markdown').getByText('这是一条真实保存的协作消息', { exact: true }),
  ).toBeVisible();
  await input.fill(`@${botName} 请介绍你的能力。`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText(/暂时连不上本地，等连接恢复后再试/)).toBeVisible();
  await page.getByRole('button', { name: '回复消息', exact: true }).first().click();
  await input.fill('已收到，我们先准备上下文。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '这是一条真实保存的协作消息', exact: true }),
  ).toBeVisible();
  await input.fill('尚未发送的群组草稿');
  await page.getByRole('button', { name: '活动记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '活动记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: groupName, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toHaveValue('尚未发送的群组草稿');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toHaveValue('尚未发送的群组草稿');
  await expect(
    page.locator('.markdown').getByText('这是一条真实保存的协作消息', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: '搜索群组、Bot 和消息' })
    .fill('真实保存');
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: `这是一条真实保存的协作消息 #${groupName}`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await second.close();
});
test('responsive chat connects automatically without connection settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.statusbar > button')).toContainText('协作服务已连接');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.getByRole('button', { name: '管理 Bot', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '创建群组', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('群组名称').fill(`手机测试_${Date.now()}`);
  await page.getByRole('dialog').getByRole('button', { name: '创建群组', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole('button', { name: '服务连接设置' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接与偏好设置' })).toHaveCount(0);
  await expect(page.getByLabel('访问令牌')).toHaveCount(0);
});
