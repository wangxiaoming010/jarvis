// Production renderer verification with deterministic local fixtures; no external model calls.
// Run after npm run build: node --import tsx scripts/smoke/ui.mjs
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createApp } from '../../apps/server/src/app.ts';
const directory = await mkdtemp(join(tmpdir(), 'openbot-ui-production-'));
const dist = resolve('apps/desktop/dist');
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self'";
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const web = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://local').pathname;
    const path = resolve(
      dist,
      '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)),
    );
    if (!path.startsWith(dist + sep)) throw new Error('outside');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Security-Policy': csp,
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const webUrl = `http://127.0.0.1:${web.address().port}`;
const token = randomBytes(32).toString('hex');
const instance = await createApp({
  databasePath: join(directory, 'db.sqlite'),
  token,
  clientOrigin: webUrl,
  modelConfig: {
    provider: 'openai',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'isolated-production-ui-fixture-key',
    model: 'production-ui-fixture',
    enabled: true,
  },
  coordinator: async () => ({ role: 'assistant', content: '' }),
  attention: async () => ({ wake: false }),
  memoryCuration: { model: async () => ({ memories: [] }) },
});
await instance.app.listen({ host: '127.0.0.1', port: 0 });
const apiUrl = `http://127.0.0.1:${instance.app.server.address().port}`;
async function api(path, body) {
  const response = await fetch(apiUrl + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
const browser = await chromium.launch();
try {
  const bots = [
    (await api('/api/bots', { name: 'Bob', provider: 'codex' })).id,
    (await api('/api/bots', { name: 'Alice', provider: 'codex' })).id,
  ];
  const group = (await api('/api/groups', { name: '动态交互验证', botIds: bots })).id;
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ url, token }) => {
      localStorage.setItem('openbot.server', url);
      sessionStorage.setItem('openbot.token', token);
    },
    { url: apiUrl, token },
  );
  await page.goto(webUrl);
  await page.getByRole('button', { name: '动态交互验证', exact: true }).click();
  const document = {
    protocolVersion: 'opsique-ui/0.1',
    context: { threadId: '', viewId: 'new', revision: 1 },
    spec: {
      root: 'root',
      elements: {
        root: {
          type: 'Card',
          props: { title: '你想先了解哪一部分？' },
          children: ['name', 'scope', 'submit'],
        },
        name: {
          type: 'TextField',
          props: { label: '项目名称', required: true, value: { $bindState: '/form/name' } },
          children: [],
        },
        scope: {
          type: 'Radio',
          props: {
            label: '查看范围',
            value: { $bindState: '/form/scope' },
            options: [
              { label: '整体架构', value: 'architecture' },
              { label: '安全检查', value: 'security' },
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
    state: { data: {}, form: { name: '', scope: 'architecture' }, ui: {} },
  };
  await api(`/api/groups/${group}/cards`, { botId: bots[0], document });
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('OpenBot Demo');
  await page.getByRole('radio', { name: '安全检查', exact: true }).check();
  await page.reload();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).waitFor();
  if (
    (await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue()) !==
    'OpenBot Demo'
  )
    throw new Error('draft lost');
  await page.getByRole('textbox', { name: '项目名称', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'dynamic-ui-form.png') });
  await page.getByRole('button', { name: '确认查看', exact: true }).click();
  await page
    .getByRole('button', { name: '确认查看', exact: true })
    .isDisabled()
    .then((value) => {
      if (!value) throw new Error('form not locked');
    });
  const chart = {
    protocolVersion: 'opsique-ui/0.1',
    context: { threadId: '', viewId: 'new', revision: 1 },
    spec: {
      root: 'chart',
      elements: {
        chart: {
          type: 'Chart',
          props: {
            title: '本周变化（示例数据）',
            kind: 'bar',
            points: [
              { x: '周一', y: 12 },
              { x: '周二', y: 19 },
              { x: '周三', y: 15 },
            ],
          },
          children: [],
        },
      },
    },
    state: { data: {}, form: {}, ui: {} },
  };
  await api(`/api/groups/${group}/cards`, { botId: bots[0], document: chart });
  await page.getByText('本周变化（示例数据）', { exact: true }).waitFor();
  await page.locator('.chart-frame svg').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const scrim = page.locator('.sidebar-scrim');
  if (await scrim.isVisible()) {
    await scrim.click({ position: { x: 380, y: 400 } });
    await page.waitForTimeout(350);
  }
  await page.getByText('本周变化（示例数据）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'dynamic-ui-mobile.png') });
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390)
    throw new Error('mobile overflow');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      productionCsp: true,
      noUnsafeEval: true,
      form: true,
      draftRecovery: true,
      chart: true,
      mobile: true,
      browserErrors: errors,
    }),
  );
} finally {
  await browser.close();
  await instance.app.close();
  await new Promise((r) => web.close(r));
  await rm(directory, { recursive: true, force: true });
}
