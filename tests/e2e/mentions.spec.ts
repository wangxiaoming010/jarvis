import { test, expect } from './model-fixtures';

test('highlights Bot mentions in drafts and Markdown without changing typing or plain text', async ({
  page,
  workspace,
}, testInfo) => {
  const headers = { authorization: `Bearer ${workspace.token}` };
  const botIds: string[] = [];
  for (const name of ['Alice', '设计师']) {
    const response = await page.request.post(workspace.url + '/api/bots', {
      headers,
      data: { name, provider: 'codex' },
    });
    expect(response.ok()).toBe(true);
    botIds.push((await response.json()).id);
  }
  const response = await page.request.post(workspace.url + '/api/groups', {
    headers,
    data: { name: '提及样式验证', botIds },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: '提及样式验证', exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息内容' });
  const highlights = page.locator('.composer-highlights');
  const draft =
    '@Alice 请检查需求，@alice 和 @设计师 一起看看。\n@AliceExtra contact@Alice.dev https://example.com/@Alice';
  await input.fill(draft);
  await expect(highlights.locator('.chat-mention')).toHaveText(['@Alice', '@alice', '@设计师']);
  await expect(highlights.locator('.chat-mention').first()).toHaveCSS('color', 'rgb(37, 99, 235)');
  await expect(input).toHaveValue(draft);
  expect(
    await input.evaluate((element) => {
      const overlay = element.parentElement!.querySelector('.composer-highlights')!;
      const inputStyle = getComputedStyle(element);
      const overlayStyle = getComputedStyle(overlay);
      return ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'letterSpacing'].every(
        (property) =>
          inputStyle.getPropertyValue(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)) ===
          overlayStyle.getPropertyValue(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
      );
    }),
  ).toBe(true);
  const longDraft = Array(16)
    .fill('@Alice 这是一段用来验证长消息换行与滚动的文字。'.repeat(3))
    .join('\n');
  const expectAligned = async () => {
    const sizes = await input.evaluate((element) => {
      const overlay = element.parentElement!.querySelector('.composer-highlights')!;
      return {
        input: [element.clientWidth, element.scrollHeight],
        overlay: [overlay.clientWidth, overlay.scrollHeight],
      };
    });
    expect(sizes.overlay).toEqual(sizes.input);
  };
  await input.fill(longDraft);
  await expectAligned();
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.scrollTop = 80;
    element.dispatchEvent(new Event('scroll'));
  });
  expect(await input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await highlights.evaluate((element) => element.scrollTop)).toBe(
    await input.evaluate((element) => element.scrollTop),
  );
  const message =
    '@Alice，**@设计师** 请检查需求。代码 `@Alice`、链接 [@Alice](https://example.com/@Alice) 和邮箱 contact@Alice.dev 保持原样。';
  await input.fill(message);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const body = page.locator('.message-row--human').last().locator('.markdown');
  await expect(body.locator('.chat-mention')).toHaveText(['@Alice', '@设计师']);
  await expect(body.locator('.chat-mention').first()).toHaveCSS('color', 'rgb(37, 99, 235)');
  await expect(body.locator('code')).toHaveText('@Alice');
  await expect(body.locator('a')).toHaveText('@Alice');
  await expect(body.locator('code .chat-mention, a .chat-mention')).toHaveCount(0);
  const snapshot = await page.request.get(workspace.url + '/api/snapshot', { headers });
  expect(
    (await snapshot.json()).messages.find((item: { content: string }) => item.content === message),
  ).toBeTruthy();
  await input.fill('@Alice 帮我检查一下需求，@设计师 看看视觉效果。');
  await page.screenshot({ path: testInfo.outputPath('blue-mentions.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill(longDraft);
  await expectAligned();
  await input.fill('@Alice 帮我检查一下需求，@设计师 看看视觉效果。');
  await expect(highlights.locator('.chat-mention')).toHaveText(['@Alice', '@设计师']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({
    path: testInfo.outputPath('blue-mentions-mobile.png'),
    animations: 'disabled',
  });
});
