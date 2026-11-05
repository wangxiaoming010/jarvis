import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../apps/server/src/app';

const directories: string[] = [];
const instances: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it('persists owner permission settings, validates inputs and reports old CLI fallback without weakening running jobs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-execution-settings-'));
  directories.push(directory);
  const databasePath = join(directory, 'db.sqlite'),
    token = 'execution-settings-owner';
  const instance = await createApp({ databasePath, token });
  instances.push(instance);
  const headers = { authorization: `Bearer ${token}` };
  const get = () => instance.app.inject({ method: 'GET', url: '/api/settings/execution', headers });
  expect((await get()).json()).toEqual({ mode: 'auto', providers: [] });
  expect(
    (
      await instance.app.inject({
        method: 'POST',
        url: '/api/settings/execution',
        payload: { mode: 'manual' },
      })
    ).statusCode,
  ).toBe(401);
  for (const payload of [{ mode: 'bypassPermissions' }, { mode: 'auto', command: 'anything' }]) {
    expect(
      (
        await instance.app.inject({
          method: 'POST',
          url: '/api/settings/execution',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  }
  instance.runtime.attach(
    {
      id: 'device',
      name: 'test device',
      providers: [
        { provider: 'codex', available: true, version: 'old' },
        { provider: 'claude-code', available: true, version: 'new', autoMode: true },
      ],
    },
    () => {},
    () => {},
  );
  expect((await get()).json().providers).toEqual([
    expect.objectContaining({
      provider: 'codex',
      autoMode: false,
      reason: expect.stringContaining('逐次确认'),
    }),
    expect.objectContaining({ provider: 'claude-code', autoMode: true }),
  ]);
  const saved = await instance.app.inject({
    method: 'POST',
    url: '/api/settings/execution',
    headers,
    payload: { mode: 'manual' },
  });
  expect(saved.statusCode).toBe(200);
  expect(instance.runtime.executionPermissionMode).toBe('manual');
  await instance.app.close();
  instances.splice(instances.indexOf(instance), 1);
  const reopened = await createApp({ databasePath, token });
  instances.push(reopened);
  expect(reopened.runtime.executionPermissionMode).toBe('manual');
  expect(
    (await reopened.app.inject({ method: 'GET', url: '/api/settings/execution', headers })).json()
      .mode,
  ).toBe('manual');
});
