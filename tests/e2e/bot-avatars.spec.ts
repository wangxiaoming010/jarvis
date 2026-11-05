import { test, expect } from './model-fixtures';

test('creates a bot with emoji, switches logo cards, uploads a photo and restores the default avatar', async ({
  page,
  workspace,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
  const dialog = page.locator('.app-dialog');
  const picker = page.getByRole('dialog', { name: '选择头像', exact: true });
  const avatarTrigger = dialog.getByRole('button', { name: '选择头像', exact: true });
  await expect(picker).not.toBeVisible();
  const avatarBounds = await avatarTrigger.boundingBox();
  const nameBounds = await dialog.getByLabel('Bot 名称').boundingBox();
  expect(avatarBounds!.y + avatarBounds!.height).toBeLessThan(nameBounds!.y);
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  for (const logo of ['codex', 'claude']) {
    const image = dialog.locator(`img[src="/logos/${logo}.svg"]`);
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    ).toBe(true);
  }
  await dialog.getByRole('radio', { name: 'Claude Code', exact: true }).check();
  await expect(dialog.getByText(/Claude Code 暂不可用/)).toBeVisible();
  await dialog.getByLabel('Bot 名称').fill('AvatarBot');
  await avatarTrigger.click();
  await expect(picker.getByRole('tab', { name: '默认', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await picker.getByRole('tab', { name: '默认', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(picker.getByRole('tab', { name: 'Emoji', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await picker.getByLabel('自定义 emoji', { exact: true }).fill('bad');
  await expect(dialog.getByRole('button', { name: '创建 Bot', exact: true })).toBeDisabled();
  await expect(picker.getByRole('button', { name: '完成', exact: true })).toBeDisabled();
  await picker.getByLabel('自定义 emoji', { exact: true }).fill('🧑🏽‍💻');
  await picker.getByRole('tab', { name: '照片', exact: true }).click();
  await expect(picker.getByLabel('上传头像照片')).toBeAttached();
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await expect(picker.getByLabel('自定义 emoji', { exact: true })).toHaveValue('🧑🏽‍💻');
  await page.screenshot({
    path: testInfo.outputPath('bot-avatar-popover.png'),
    animations: 'disabled',
  });
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(avatarTrigger).toBeFocused();
  await expect(dialog.getByRole('img', { name: 'AvatarBot 的头像' })).toHaveText('🧑🏽‍💻');
  await avatarTrigger.click();
  await expect(picker.getByRole('tab', { name: 'Emoji', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await avatarTrigger.click();
  await picker.getByRole('tab', { name: '默认', exact: true }).click();
  await picker.getByRole('button', { name: '使用默认头像', exact: true }).click();
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  await expect(avatarTrigger.locator('.bot-avatar-emoji')).toHaveCount(0);
  await avatarTrigger.click();
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await picker.getByLabel('自定义 emoji', { exact: true }).fill('🧑🏽‍💻');
  const headingBounds = await dialog.locator('.dialog-heading').boundingBox();
  // A modal popover intercepts outside clicks on its underlay before dismissing.
  await page.mouse.click(headingBounds!.x + 4, headingBounds!.y + 4);
  await expect(picker).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('bot-emoji-and-tool-cards.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '创建 Bot', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: '与 AvatarBot 单独聊天' }).getByRole('img'),
  ).toHaveText('🧑🏽‍💻');
  await page.getByRole('button', { name: '管理 Bot', exact: true }).click();
  const profile = page
    .locator('.bot-profile')
    .filter({ has: page.getByRole('heading', { name: 'AvatarBot', exact: true }) });
  await profile.getByRole('button', { name: '修改 AvatarBot 的头像' }).click();
  await dialog.getByRole('button', { name: '使用 🦊 作为头像' }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(profile.getByRole('img', { name: 'AvatarBot 的头像' })).toHaveText('🧑🏽‍💻');
  await profile.getByRole('button', { name: '修改 AvatarBot 的头像' }).click();
  await dialog.getByRole('tab', { name: '照片', exact: true }).click();
  await dialog.getByLabel('上传头像照片').setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  });
  await expect(dialog.getByRole('alert')).toContainText('请选择 JPG、PNG 或 WebP 图片');
  await dialog.getByLabel('上传头像照片').setInputFiles({
    name: 'corrupt.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not an image'),
  });
  await expect(dialog.getByRole('alert')).toContainText('无法读取这张图片');
  // A non-square source proves upload processing performs an actual center crop.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 320;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d97757';
    context.fillRect(0, 0, 640, 320);
    context.fillStyle = '#fff';
    context.fillRect(260, 100, 120, 120);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await dialog.getByLabel('上传头像照片').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await expect(dialog.locator('.avatar-editor-head').getByRole('img')).toHaveAttribute(
    'src',
    /^data:image\/jpeg;base64,/,
  );
  await dialog.getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '管理 Bot', exact: true }).click();
  const photo = profile.getByRole('img', { name: 'AvatarBot 的头像' });
  await expect(photo).toBeVisible();
  expect(
    await photo.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
  ).toEqual([256, 256]);
  const snapshot = await page.request.get(workspace.url + '/api/snapshot', {
    headers: { authorization: `Bearer ${workspace.token}` },
  });
  expect((await snapshot.json()).bots[0]).toMatchObject({
    name: 'AvatarBot',
    provider: 'claude-code',
    avatar: { type: 'image' },
  });
  await profile.getByRole('button', { name: '修改 AvatarBot 的头像' }).click();
  await dialog.getByRole('button', { name: '恢复默认头像', exact: true }).click();
  await dialog.getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(profile.locator('.bot-avatar-photo, .bot-avatar-emoji')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '创建 Bot', exact: true }).last().click();
  await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Claude Code', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({
    path: testInfo.outputPath('bot-creation-mobile.png'),
    animations: 'disabled',
  });
  await avatarTrigger.click();
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await expect(picker.getByRole('button', { name: '使用 🦊 作为头像' })).toBeVisible();
  const pickerBounds = await picker.boundingBox();
  expect(pickerBounds!.x).toBeGreaterThanOrEqual(0);
  expect(pickerBounds!.x + pickerBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('bot-avatar-popover-mobile.png'),
    animations: 'disabled',
  });
  await picker.getByRole('button', { name: '使用 🦊 作为头像' }).click();
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  await expect(avatarTrigger.getByRole('img')).toHaveText('🦊');
});
