import { expect, test } from './model-fixtures';

test('keeps IME confirmation Enter out of message sending and Bot selection', async ({ page }) => {
  const errors: string[] = [];
  const sent: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/messages')
      sent.push(request.postDataJSON().content);
  });
  const suffix = Date.now().toString().slice(-7);
  const botName = `IME_${suffix}`;
  await page.goto('/');
  await expect(page.locator('.statusbar > button')).toContainText('协作服务已连接');
  await page.getByRole('button', { name: '创建 Bot', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Bot 名称').fill(botName);
  await page.getByRole('dialog').getByRole('button', { name: '创建 Bot', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '创建群组', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('群组名称').fill(`输入法验证_${suffix}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(botName) })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '创建群组', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const input = page.getByRole('textbox', { name: '消息内容' });
  const enter = (options: { isComposing?: boolean; keyCode?: number } = {}) =>
    input.evaluate((el, options) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        keyCode: 13,
        ...options,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, options);

  // Native composition flag, and the explicit composition lifecycle fallback.
  await input.fill('中文还没输入完');
  expect(await enter({ isComposing: true })).toBe(false);
  await input.dispatchEvent('compositionstart');
  expect(await enter({ isComposing: false })).toBe(false);
  await expect(input).toHaveValue('中文还没输入完');
  await input.dispatchEvent('compositionend', { data: '中文还没输入完' });
  // WebKit can end composition before the confirmation keydown and report keyCode 229.
  expect(await enter({ isComposing: false, keyCode: 229 })).toBe(false);
  await expect(input).toHaveValue('中文还没输入完');
  expect(sent).toEqual([]);
  // The next ordinary Enter sends immediately, without a time-based cooldown.
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(
    page.locator('.markdown').getByText('中文还没输入完', { exact: true }),
  ).toBeVisible();
  expect(sent).toEqual(['中文还没输入完']);

  await input.fill('@IME');
  await input.dispatchEvent('compositionstart');
  expect(await enter({ isComposing: false })).toBe(false);
  await expect(input).toHaveValue('@IME');
  await input.dispatchEvent('compositionend');
  expect(await enter({ keyCode: 229 })).toBe(false);
  await expect(input).toHaveValue('@IME');
  await input.press('Enter');
  await expect(input).toHaveValue(`@${botName} `);
  expect(sent).toHaveLength(1);

  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('第一行\n第二行');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(sent).toEqual(['中文还没输入完', '第一行\n第二行']);
  expect(errors).toEqual([]);
});
