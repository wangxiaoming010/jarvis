import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { createCoordinatorModel } from '../../apps/server/src/models/coordinator-model';
import { ModelSettings } from '../../apps/server/src/models/model-settings';
import { readBrainConfig } from '../../apps/server/src/config';
import { listProviderModels, modelProviders } from '../../apps/server/src/models/model-providers';

const token = 'isolated-model-settings-test-token';
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
const saved = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'isolated-openai-test-secret',
  model: 'test-chat-model',
  attentionModel: 'test-attention-model',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const api = (path: string, payload?: unknown) =>
  instance!.app.inject({
    method: payload ? 'POST' : 'GET',
    url: path,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-model-settings-'));
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
});
afterEach(async () => {
  await instance?.app.close();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

it('offers every supported conversation provider in settings', async () => {
  expect(
    (await api('/api/settings/model')).json().providers.map((p: { id: string }) => p.id),
  ).toEqual([
    'deepseek',
    'openai',
    'anthropic',
    'gemini',
    'qwen',
    'moonshot',
    'zhipu',
    'compatible',
  ]);
});

it.each(modelProviders)(
  'supports the first-use configuration and conversation flow for $id',
  async ({ id, baseUrl }) => {
    const settings = {
      provider: id,
      baseUrl,
      apiKey: `isolated-${id}-onboarding-secret`,
      model: `${id}-test-chat`,
      attentionModel: `${id}-test-attention`,
    };
    const configured = await api('/api/settings/model', settings);
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      provider: id,
      model: settings.model,
      attentionModel: settings.attentionModel,
      hasKey: true,
      enabled: true,
    });
    expect(configured.body).not.toContain(settings.apiKey);

    const botIds: string[] = [];
    for (const provider of ['codex', 'claude-code']) {
      const created = await api('/api/bots', {
        name: `Employee-${provider}`,
        description: '只处理用户授权的任务，返回实际结果与验证证据。',
        provider,
      });
      expect(created.statusCode).toBe(201);
      const botId: string = created.json().id;
      botIds.push(botId);
      expect((await api(`/api/bots/${botId}/chat`, {})).statusCode).toBe(201);
    }
    expect((await api('/api/groups', { name: 'Onboarding-team', botIds })).statusCode).toBe(201);

    await instance!.app.close();
    instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
    expect((await api('/api/settings/model')).json()).toMatchObject({
      provider: id,
      model: settings.model,
      attentionModel: settings.attentionModel,
      enabled: true,
    });
    const snapshot = await api('/api/snapshot');
    expect(snapshot.body).not.toContain(settings.apiKey);
    expect(snapshot.json().bots).toHaveLength(2);
    expect(snapshot.json().groups).toHaveLength(3);
    expect(snapshot.json().model.configured).toBe(true);
    expect(instance.runtime.hasCoordinator).toBe(true);

    expect(
      (
        await api('/api/settings/model', { ...settings, apiKey: undefined, attentionModel: '' })
      ).json().attentionModel,
    ).toBe('');
  },
);

it.each([
  { enabled: false, apiKey: 'isolated-key', model: 'chat-model' },
  { enabled: true, apiKey: undefined, model: 'chat-model' },
  { enabled: true, apiKey: 'isolated-key', model: '' },
  { enabled: true, apiKey: 'isolated-key', model: '   ' },
])(
  'requires an enabled model, credentials and a model ID for setup readiness: %j',
  async (config) => {
    await instance!.app.close();
    instance = await createApp({
      databasePath: join(directory, 'db.sqlite'),
      token,
      modelConfig: { ...readBrainConfig({}), ...config },
    });
    expect((await api('/api/snapshot')).json().model.configured).toBe(false);
    expect((await api('/api/settings/model')).json().enabled).toBe(false);
    expect(instance.runtime.hasCoordinator).toBe(false);
    await api('/api/settings/model', saved);
    expect((await api('/api/snapshot')).json().model.configured).toBe(true);
    expect((await api('/api/settings/model')).json().enabled).toBe(true);
    expect(instance.runtime.hasCoordinator).toBe(true);
  },
);

it('starts without a seeded group and preserves settings privately across restart', async () => {
  expect((await api('/api/snapshot')).json().groups).toEqual([]);
  expect((await api('/api/settings/model', saved)).statusCode).toBe(200);
  const response = (await api('/api/settings/model')).json();
  expect(response).toMatchObject({
    provider: 'openai',
    model: saved.model,
    attentionModel: saved.attentionModel,
    hasKey: true,
    enabled: true,
  });
  expect(JSON.stringify(response)).not.toContain(saved.apiKey);
  expect((await api('/api/snapshot')).body).not.toContain(saved.apiKey);
  if (process.platform !== 'win32')
    expect(statSync(join(directory, 'model-settings.json')).mode & 0o777).toBe(0o600);
  await instance!.app.close();
  instance = undefined;
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  expect((await api('/api/settings/model')).json()).toMatchObject({
    provider: 'openai',
    model: saved.model,
    attentionModel: saved.attentionModel,
    hasKey: true,
  });
  expect((await api('/api/snapshot')).json().groups).toEqual([]);
  expect((await api('/api/snapshot')).json().dialogue.enabled).toBe(true);
  expect(readFileSync(join(directory, 'model-settings.json'), 'utf8')).toContain(saved.apiKey);
});

it('protects settings and listings with local authentication and binds stored keys to the saved endpoint', async () => {
  const transport = vi.fn(async () =>
    json({ data: [{ id: 'test-chat-model' }, { id: 'text-embedding-3-small' }] }),
  );
  vi.stubGlobal('fetch', transport);
  expect(
    (await instance!.app.inject({ method: 'POST', url: '/api/settings/models', payload: saved }))
      .statusCode,
  ).toBe(401);
  expect(transport).not.toHaveBeenCalled();
  await api('/api/settings/model', saved);
  const listing = await api('/api/settings/models', {
    provider: saved.provider,
    baseUrl: saved.baseUrl,
  });
  expect(listing.json().models).toEqual([{ id: saved.model, name: saved.model }]);
  expect(transport.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${saved.apiKey}`);
  expect(transport.mock.calls[0][1].redirect).toBe('error');
  const calls = transport.mock.calls.length;
  expect(
    (await api('/api/settings/models', { provider: 'openai', baseUrl: 'https://other.example/v1' }))
      .statusCode,
  ).toBe(400);
  expect(transport).toHaveBeenCalledTimes(calls);
  expect(
    (await api('/api/settings/model', { ...saved, baseUrl: 'http://example.com/v1' })).statusCode,
  ).toBe(400);
});

it('uses newly saved provider and model on the next Bot conversation without a service restart', async () => {
  const transport = vi.fn(async () =>
    json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '实际模型答复' } }],
    }),
  );
  vi.stubGlobal('fetch', transport);
  await api('/api/settings/model', saved);
  const bot = (await api('/api/bots', { name: 'ConfiguredBot', provider: 'codex' })).json();
  const chat = (await api(`/api/bots/${bot.id}/chat`, {})).json();
  const send = (content: string) =>
    api('/api/messages', { id: crypto.randomUUID(), groupId: chat.id, content });
  await send('你好');
  await expect
    .poll(() => instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot').length)
    .toBe(1);
  const first = JSON.parse(transport.mock.calls[0][1].body as string);
  expect(first.model).toBe(saved.model);
  expect(first.thinking).toBeUndefined();
  expect(first.max_completion_tokens).toBeGreaterThan(0);
  const replacement = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'isolated-deepseek-test-secret',
    model: 'replacement-chat-model',
  };
  await api('/api/settings/model', replacement);
  await send('继续');
  await expect
    .poll(() => instance!.store.snapshot().messages.filter((m) => m.senderType === 'bot').length)
    .toBe(2);
  expect(String(transport.mock.calls.at(-1)![0])).toBe(replacement.baseUrl + '/chat/completions');
  const second = JSON.parse(transport.mock.calls.at(-1)![1].body as string);
  expect(second.model).toBe(replacement.model);
  expect(second.thinking).toEqual({ type: 'disabled' });
  expect((await api('/api/settings/model', { ...saved, apiKey: undefined })).statusCode).toBe(200);
});

it('uses the selected independent attention model and follows later settings changes without restarting', async () => {
  let wake = false;
  const transport = vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body as string);
    return json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: body.response_format ? JSON.stringify({ wake }) : '',
          },
        },
      ],
    });
  });
  vi.stubGlobal('fetch', transport);
  await api('/api/settings/model', saved);
  const b = (await api('/api/bots', { name: 'ConfiguredBot', provider: 'codex' })).json();
  const g = (await api('/api/groups', { name: 'model-gate-test', botIds: [b.id] })).json();
  const send = async (content: string) => {
    await api('/api/messages', { id: crypto.randomUUID(), groupId: g.id, content });
    await expect
      .poll(() =>
        instance!.store.db
          .prepare(
            "SELECT count(*) AS n FROM dialogue_inbox WHERE status IN ('queued','processing')",
          )
          .get(),
      )
      .toEqual({ n: 0 });
  };
  await send('普通群消息');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(transport.mock.calls[0][1].body as string)).toMatchObject({
    model: saved.attentionModel,
  });
  expect(instance!.store.db.prepare('SELECT count(*) AS n FROM coordinator_turns').get()).toEqual({
    n: 0,
  });
  await api('/api/settings/model', { ...saved, apiKey: undefined, attentionModel: '' });
  await send('注意力模型跟随对话模型');
  expect(JSON.parse(transport.mock.calls.at(-1)![1].body as string).model).toBe(saved.model);
  wake = true;
  await api('/api/settings/model', {
    ...saved,
    apiKey: undefined,
    attentionModel: 'new-attention-model',
  });
  await send('需要主会话处理');
  const last = transport.mock.calls
    .slice(-2)
    .map(([, options]) => JSON.parse(options.body as string));
  expect(last.map((b) => b.model)).toEqual(['new-attention-model', saved.model]);
  expect(last[0]).not.toHaveProperty('tools');
  expect(last[1]).toHaveProperty('tools');
});

it('translates Anthropic tool calls and consecutive tool results into its native message protocol', async () => {
  const transport = vi.fn(async () =>
    json({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '检查任务' },
        { type: 'tool_use', id: 'next-tool', name: 'list_tasks', input: {} },
      ],
    }),
  );
  vi.stubGlobal('fetch', transport);
  const model = createCoordinatorModel({
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'test-claude',
    apiKey: 'isolated-anthropic-test-secret',
    enabled: true,
  })!;
  const result = await model(
    [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: '检查任务' },
      {
        role: 'assistant',
        content: null,
        tool_calls: ['one', 'two'].map((id) => ({
          id,
          type: 'function',
          function: { name: 'list_tasks', arguments: '{}' },
        })),
      },
      { role: 'tool', tool_call_id: 'one', content: 'first actual result' },
      { role: 'tool', tool_call_id: 'two', content: 'second actual result' },
    ],
    new AbortController().signal,
  );
  const [url, options] = transport.mock.calls[0];
  const body = JSON.parse(options.body as string);
  expect(url).toBe('https://api.anthropic.com/v1/messages');
  expect(options.headers).toMatchObject({
    'x-api-key': 'isolated-anthropic-test-secret',
    'anthropic-version': '2023-06-01',
  });
  expect(options.headers).not.toHaveProperty('Authorization');
  expect(body.system).toBe('system policy');
  expect(body.messages.at(-1).content).toEqual([
    { type: 'tool_result', tool_use_id: 'one', content: 'first actual result' },
    { type: 'tool_result', tool_use_id: 'two', content: 'second actual result' },
  ]);
  expect(body.tools[0]).toHaveProperty('input_schema');
  expect(result.tool_calls?.[0]).toMatchObject({
    id: 'next-tool',
    function: { name: 'list_tasks', arguments: '{}' },
  });
});

it('paginates native Anthropic model lists and never reflects upstream errors or credentials', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        data: [{ id: 'first', display_name: 'First Claude' }],
        has_more: true,
        last_id: 'first',
      }),
    )
    .mockResolvedValueOnce(json({ data: [{ id: 'second' }], has_more: false }));
  vi.stubGlobal('fetch', transport);
  const config = {
    provider: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'first',
    apiKey: 'isolated-test-key',
    enabled: true,
  };
  expect(await listProviderModels(config)).toEqual([
    { id: 'first', name: 'First Claude' },
    { id: 'second', name: 'second' },
  ]);
  expect(String(transport.mock.calls[1][0])).toContain('after_id=first');
  transport.mockResolvedValueOnce(json({ error: 'upstream-secret-body' }, 401));
  await expect(listProviderModels(config)).rejects.toThrow('HTTP 401');
  transport.mockResolvedValueOnce(json({ error: 'upstream-secret-body' }, 401));
  await expect(listProviderModels(config)).rejects.not.toThrow('upstream-secret-body');
});

it('imports legacy configuration without exposing it and requires a fresh key for a different endpoint', () => {
  const settings = new ModelSettings(
    join(directory, 'legacy.sqlite'),
    readBrainConfig({ DEEPSEEK_API_KEY: 'isolated-legacy-secret' }),
  );
  expect(settings.view()).toMatchObject({ provider: 'deepseek', hasKey: true });
  expect(JSON.stringify(settings.view())).not.toContain('isolated-legacy-secret');
  expect(() =>
    settings.resolve({ provider: 'deepseek', baseUrl: 'https://changed.example/v1' }),
  ).toThrow('填写 API Key');
});
