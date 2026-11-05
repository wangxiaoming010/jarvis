import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@openbot/shared';
import { createStore } from '../../apps/server/src/store';
import { createApp } from '../../apps/server/src/app';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-device-binding-'));
  directories.push(directory);
  return join(directory, 'db.sqlite');
}

function connect(
  instance: Awaited<ReturnType<typeof createApp>>,
  id: string,
  provider: Provider,
  available = true,
) {
  instance.runtime.attach(
    { id, name: id, providers: [{ provider, version: 'test', available }] },
    () => {},
    () => instance.runtime.detach(id),
  );
}

it.each(['codex', 'claude-code'] as const)(
  'creates an online %s bot in one request',
  async (provider) => {
    const instance = await createApp({
      databasePath: databasePath(),
      token: 'device-binding-client-test-token',
    });
    try {
      connect(instance, 'codex-device', 'codex');
      connect(instance, 'claude-code-device', 'claude-code');
      const response = await instance.app.inject({
        method: 'POST',
        url: '/api/bots',
        headers: { authorization: 'Bearer device-binding-client-test-token' },
        payload: { name: 'OneStepBot', provider },
      });
      expect(response.statusCode).toBe(201);
      expect(instance.store.snapshot().bots).toEqual([
        expect.objectContaining({
          id: response.json().id,
          bridgeId: `${provider}-device`,
          status: 'idle',
        }),
      ]);
    } finally {
      await instance.app.close();
    }
  },
);

it('automatically connects a waiting bot when its Provider becomes ready and preserves its chosen device', async () => {
  const instance = await createApp({
    databasePath: databasePath(),
    token: 'device-binding-client-test-token',
  });
  try {
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: 'Bearer device-binding-client-test-token' },
      payload: { name: 'WaitingBot', provider: 'codex' },
    });
    expect(response.statusCode).toBe(201);
    const bot = () => instance.store.snapshot().bots[0];
    expect(bot()).toMatchObject({ bridgeId: null, status: 'offline' });
    connect(instance, 'unrelated', 'claude-code');
    connect(instance, 'device', 'codex', false);
    expect(bot()).toMatchObject({ bridgeId: null, status: 'offline' });
    instance.runtime.detach('device');
    connect(instance, 'device', 'codex');
    expect(bot()).toMatchObject({ bridgeId: 'device', status: 'idle' });
    connect(instance, 'other-device', 'codex');
    instance.runtime.detach('device');
    expect(bot()).toMatchObject({ bridgeId: 'device', status: 'offline' });
    connect(instance, 'device', 'codex');
    expect(bot()).toMatchObject({ bridgeId: 'device', status: 'idle' });
  } finally {
    await instance.app.close();
  }
});

it('requires a valid same-request choice when multiple compatible devices are available, with no partial identity', async () => {
  const instance = await createApp({
    databasePath: databasePath(),
    token: 'device-binding-client-test-token',
  });
  const create = (extra: Record<string, unknown> = {}) =>
    instance.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: 'Bearer device-binding-client-test-token' },
      payload: { name: 'SelectedBot', provider: 'codex', ...extra },
    });
  try {
    connect(instance, 'first', 'codex');
    connect(instance, 'second', 'codex');
    connect(instance, 'wrong-provider', 'claude-code');
    expect((await create()).statusCode).toBe(409);
    expect((await create({ bridgeId: 'missing' })).statusCode).toBe(409);
    expect((await create({ bridgeId: 'wrong-provider' })).statusCode).toBe(409);
    expect(instance.store.snapshot().bots).toHaveLength(0);
    expect((await create({ bridgeId: 'second' })).statusCode).toBe(201);
    expect(instance.store.snapshot().bots[0]).toMatchObject({ bridgeId: 'second', status: 'idle' });
    instance.runtime.detach('second');
    connect(instance, 'another', 'claude-code');
    expect(instance.store.snapshot().bots[0]).toMatchObject({
      bridgeId: 'second',
      status: 'offline',
    });
  } finally {
    await instance.app.close();
  }
});

it('saves execution selection offline, validates compatible devices and restores the selection after restart', async () => {
  const path = databasePath();
  const token = 'device-binding-client-test-token';
  let instance = await createApp({ databasePath: path, token });
  const api = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    instance.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  try {
    const id = (await api('POST', '/api/bots', { name: 'Selectable', provider: 'codex' })).json()
      .id;
    connect(instance, 'codex-device', 'codex');
    expect(
      (
        await api('PATCH', `/api/bots/${id}/execution`, {
          provider: 'claude-code',
          bridgeId: 'codex-device',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api('PATCH', `/api/bots/${id}/execution`, { provider: 'unsupported' })).statusCode,
    ).toBe(400);
    expect(
      (await api('PATCH', '/api/bots/missing/execution', { provider: 'claude-code' })).statusCode,
    ).toBe(404);
    expect(
      (await api('PATCH', `/api/bots/${id}/execution`, { provider: 'claude-code' })).statusCode,
    ).toBe(200);
    expect(instance.store.snapshot().bots[0]).toMatchObject({
      provider: 'claude-code',
      bridgeId: null,
      status: 'offline',
    });
    await instance.app.close();
    instance = await createApp({ databasePath: path, token });
    connect(instance, 'codex-device', 'codex');
    expect(instance.store.snapshot().bots[0]).toMatchObject({
      provider: 'claude-code',
      bridgeId: null,
      status: 'offline',
    });
    connect(instance, 'claude-device', 'claude-code');
    expect(instance.store.snapshot().bots[0]).toMatchObject({
      provider: 'claude-code',
      bridgeId: 'claude-device',
      status: 'idle',
    });
  } finally {
    await instance.app.close();
  }
});

it('migrates legacy bindings without losing identities, history, or native sessions, and reopens safely', () => {
  const path = databasePath();
  const legacy = new Database(path);
  for (const migration of [
    '001_initial.sql',
    '002_runtime.sql',
    '003_dialogue.sql',
    '004_session_delivery.sql',
    '005_ui_documents.sql',
    '006_native_requests.sql',
  ])
    legacy.exec(
      readFileSync(new URL('../../apps/server/migrations/' + migration, import.meta.url), 'utf8'),
    );
  legacy.exec(`
    INSERT INTO workspace VALUES('w','Existing workspace','');
    INSERT INTO groups VALUES('g','w','Existing group','','2026-01-01');
    INSERT INTO bots VALUES('b','w','user_local','ExistingBot','','codex','idle','existing-device','2026-01-01');
    INSERT INTO group_bots VALUES('g','b');
    INSERT INTO bot_bindings VALUES('b','/legacy/project');
    INSERT INTO messages VALUES('m','g','user_local','human','Existing request','[]',NULL,'2026-01-01','text','chain');
    INSERT INTO tasks VALUES('t','g','b','Existing request','completed','2026-01-01','2026-01-01','2026-01-01','Existing result',NULL,'chain',1);
    INSERT INTO task_specs(task_id,goal,working_directory,context_message_id,context,thread_id,updated_at) VALUES('t','Existing goal','/legacy/project','m','[]','native-task','2026-01-01');
    INSERT INTO task_session_delivery VALUES('t','native-task',1);
    INSERT INTO agent_sessions VALUES('b','g','native-group','m');
  `);
  for (const migration of ['007_device_bindings.sql', '008_direct_chats.sql'])
    legacy.exec(
      readFileSync(new URL('../../apps/server/migrations/' + migration, import.meta.url), 'utf8'),
    );
  legacy.exec("INSERT INTO direct_chats VALUES('g','b')");
  legacy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = createStore(path);
    try {
      const snapshot = store.snapshot();
      expect(snapshot).not.toHaveProperty('workspace');
      expect(snapshot.groups.find((g) => g.id === 'g')).toMatchObject({
        botIds: ['b'],
        directBotId: 'b',
      });
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE name='workspace'").get(),
      ).toBeUndefined();
      for (const table of ['groups', 'bots'])
        expect(
          (store.db.pragma(`table_info(${table})`) as { name: string }[]).map(
            (column) => column.name,
          ),
        ).not.toContain('workspace_id');
      expect(store.db.pragma('foreign_key_check')).toEqual([]);
      expect(store.db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.bots.find((b) => b.id === 'b')?.bridgeId).toBe('existing-device');
      expect(snapshot.messages.find((m) => m.id === 'm')?.content).toBe('Existing request');
      expect(snapshot.tasks.find((t) => t.id === 't')).toMatchObject({
        result: 'Existing result',
        execution: { goal: 'Existing goal' },
      });
      expect(store.db.prepare('SELECT thread_id FROM task_specs WHERE task_id=?').get('t')).toEqual(
        { thread_id: 'native-task' },
      );
      expect(
        store.db
          .prepare('SELECT accepted_version FROM task_session_delivery WHERE task_id=?')
          .get('t'),
      ).toEqual({ accepted_version: 1 });
      expect(
        store.db.prepare('SELECT thread_id FROM agent_sessions WHERE bot_id=?').get('b'),
      ).toEqual({ thread_id: 'native-group' });
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE name='bot_bindings'").get(),
      ).toBeUndefined();
      expect(
        (store.db.pragma('table_info(task_specs)') as { name: string }[]).map(
          (column) => column.name,
        ),
      ).not.toContain('working_directory');
      expect(
        store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toHaveLength(19);
    } finally {
      store.db.close();
    }
  }
});

it('creates one isolated direct chat per bot, routes every message only to that bot, and keeps it read-only', async () => {
  const path = databasePath();
  const instance = await createApp({
    databasePath: path,
    token: 'device-binding-client-test-token',
  });
  const commands: unknown[] = [];
  try {
    instance.runtime.attach(
      {
        id: 'device',
        name: 'Test device',
        providers: [{ provider: 'codex', version: 'test', available: true }],
      },
      (command) => commands.push(command),
      () => instance.runtime.detach('device'),
    );
    const headers = { authorization: 'Bearer device-binding-client-test-token' };
    const createBot = (name: string) =>
      instance.app.inject({
        method: 'POST',
        url: '/api/bots',
        headers,
        payload: { name, provider: 'codex' },
      });
    const alice = (await createBot('Alice')).json().id as string;
    const bob = (await createBot('Bob')).json().id as string;
    const createChat = (botId: string) =>
      instance.app.inject({ method: 'POST', url: `/api/bots/${botId}/chat`, headers, payload: {} });
    const chat = (await createChat(alice)).json().id as string;
    expect((await createChat(alice)).json().id).toBe(chat);
    const bobChat = (await createChat(bob)).json().id as string;
    expect(bobChat).not.toBe(chat);
    expect(instance.store.snapshot().groups.find((g) => g.id === chat)).toMatchObject({
      name: 'Alice',
      directBotId: alice,
      botIds: [alice],
    });
    expect((await createChat('missing')).statusCode).toBe(404);
    expect(
      (
        await instance.app.inject({
          method: 'PATCH',
          url: `/api/groups/${chat}`,
          headers,
          payload: { name: 'Open chat', description: '', botIds: [alice, bob] },
        })
      ).statusCode,
    ).toBe(409);
    const input = {
      id: crypto.randomUUID(),
      groupId: chat,
      content: 'What changed?',
      mentions: [],
      replyTo: null,
    };
    expect(
      (await instance.app.inject({ method: 'POST', url: '/api/messages', headers, payload: input }))
        .statusCode,
    ).toBe(201);
    await expect.poll(() => commands.filter((c: any) => c.type === 'run').length).toBe(1);
    const job = (commands.find((c: any) => c.type === 'run') as any).job;
    expect(job.bot.id).toBe(alice);
    expect(job.members.map((member: any) => member.id)).toEqual([alice]);
    expect(job.messages).toMatchObject([
      { senderType: 'human', senderId: 'user_local', content: 'What changed?' },
    ]);
    instance.runtime.event('device', {
      type: 'result',
      taskId: job.task.id,
      leaseId: job.leaseId,
      status: 'completed',
      text: 'I only checked the requested change.',
    });
    const snapshot = instance.store.snapshot();
    expect(snapshot.messages.filter((m) => m.groupId === chat).map((m) => m.senderType)).toEqual([
      'human',
      'bot',
    ]);
    expect(snapshot.tasks.find((task) => task.id === job.task.id)?.groupId).toBe(chat);
  } finally {
    await instance.app.close();
  }
});

it('binds and dispatches using only a device, including a resumed persisted binding', async () => {
  const path = databasePath();
  let instance = await createApp({ databasePath: path, token: 'device-binding-client-test-token' });
  const commands: unknown[] = [];
  const attach = () =>
    instance.runtime.attach(
      {
        id: 'device',
        name: 'Test device',
        providers: [{ provider: 'codex', version: 'test', available: true }],
      },
      (command) => commands.push(command),
      () => instance.runtime.detach('device'),
    );
  const api = (url: string, payload?: unknown) =>
    instance.app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: { authorization: 'Bearer device-binding-client-test-token' },
      payload,
    });
  try {
    attach();
    const bot = (await api('/api/bots', { name: 'DeviceBot', provider: 'codex' })).json().id;
    expect((await api(`/api/bots/${bot}/bind`, { bridgeId: 'device' })).statusCode).toBe(200);
    const group = (await api('/api/groups', { name: 'Device-only group', botIds: [bot] })).json()
      .id;
    await instance.app.close();
    instance = await createApp({ databasePath: path, token: 'device-binding-client-test-token' });
    attach();
    const snapshot = (await api('/api/snapshot')).json();
    expect(snapshot.bots[0].status).toBe('idle');
    expect(Object.keys(snapshot.bots[0]).sort()).toEqual([
      'avatar',
      'bridgeId',
      'createdAt',
      'description',
      'id',
      'name',
      'ownerId',
      'provider',
      'status',
    ]);
    await api('/api/messages', {
      id: crypto.randomUUID(),
      groupId: group,
      content: '@DeviceBot Check the file I mention next.',
    });
    await expect.poll(() => commands.some((command: any) => command.type === 'run')).toBe(true);
  } finally {
    await instance.app.close();
  }
});
