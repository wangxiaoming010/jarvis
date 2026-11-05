import { test, expect } from './model-fixtures';

test('dynamic cards validate input, preserve drafts, submit once and render under the existing conversation layout', async ({
  page,
  workspace,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const auth = page.waitForRequest(
    (r) => r.url().endsWith('/api/snapshot') && r.method() === 'GET',
  );
  await page.goto('/');
  const headers = { authorization: (await auth).headers().authorization };
  const api = async (path: string, body: unknown) => {
    const response = await page.request.post(workspace.url + path, {
      headers,
      data: body,
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const suffix = Date.now().toString().slice(-7);
  const bot = await api('/api/bots', { name: `UI_${suffix}`, provider: 'codex' });
  const group = await api('/api/groups', { name: `交互验收_${suffix}`, botIds: [bot.id] });
  const document = {
    protocolVersion: 'opsique-ui/0.1',
    context: { threadId: '', viewId: 'new', revision: 1 },
    spec: {
      root: 'root',
      elements: {
        root: {
          type: 'Card',
          props: { title: '你想先看哪一部分？' },
          children: ['project', 'scope', 'submit'],
        },
        project: {
          type: 'TextField',
          props: { label: '项目名称', required: true, value: { $bindState: '/form/project' } },
          children: [],
        },
        scope: {
          type: 'Radio',
          props: {
            label: '查看范围',
            required: true,
            value: { $bindState: '/form/scope' },
            options: [
              { label: '仅看架构', value: 'architecture' },
              { label: '检查安全性', value: 'security' },
            ],
          },
          children: [],
        },
        submit: {
          type: 'Button',
          props: { label: '确认查看' },
          children: [],
          on: {
            press: {
              action: 'submitForm',
              params: { actionId: 'reply', input: { $state: '/form' } },
            },
          },
        },
      },
    },
    state: { data: {}, form: { project: '', scope: 'architecture' }, ui: {} },
  };
  const card = await api(`/api/groups/${group.id}/cards`, { botId: bot.id, document });
  await page.getByRole('button', { name: `交互验收_${suffix}`, exact: true }).click();
  const view = page.locator(`[data-view-id="${card.document.context.viewId}"]`);
  await view.getByRole('button', { name: '确认查看', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('请填写项目名称');
  await view.getByRole('textbox', { name: '项目名称', exact: true }).fill('NAAnaa-harness');
  await view.getByRole('radio', { name: '检查安全性', exact: true }).check();
  await page.reload();
  await expect(view.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
    'NAAnaa-harness',
  );
  await expect(view.getByRole('radio', { name: '检查安全性', exact: true })).toBeChecked();
  await view.getByRole('button', { name: '确认查看', exact: true }).click();
  await expect(view.getByRole('button', { name: '确认查看', exact: true })).toBeDisabled();
  await expect(
    page.locator('.message-row--human .markdown').filter({ hasText: '项目名称：NAAnaa-harness' }),
  ).toHaveCount(1);
  await expect(
    page.locator('.message-row--human .markdown').filter({ hasText: '查看范围：检查安全性' }),
  ).toHaveCount(1);
  await page.reload();
  await expect(view.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
    'NAAnaa-harness',
  );
  await expect(view.getByRole('radio', { name: '检查安全性', exact: true })).toBeChecked();
  await expect(view.getByRole('button', { name: '确认查看', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(errors).toEqual([]);
});
