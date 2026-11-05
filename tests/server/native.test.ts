import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob, BridgeCommand, NativeRequestSpec } from '@openbot/shared';
import { createApp } from '../../apps/server/src/app';
const token = 'native-interaction-client-test-token';
let directory: string,
  instance: Awaited<ReturnType<typeof createApp>>,
  commands: BridgeCommand[],
  job: AgentJob,
  bridgeId: string;
async function api(path: string, payload?: unknown, method = payload ? 'POST' : 'GET') {
  return instance.app.inject({
    method: method as 'GET' | 'POST' | 'PATCH',
    url: path,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbot-native-'));
  commands = [];
  bridgeId = randomUUID();
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  await instance.app.ready();
  instance.runtime.attach(
    {
      id: bridgeId,
      name: 'fixture',
      providers: [{ provider: 'codex', version: 'test', available: true }],
    },
    (c) => commands.push(c),
    () => instance.runtime.detach(bridgeId),
  );
  const b = (await api('/api/bots', { name: 'Bob', provider: 'codex' })).json().id;
  await api(`/api/bots/${b}/bind`, { bridgeId });
  const g = (await api('/api/groups', { name: 'native', botIds: [b] })).json().id;
  await api('/api/messages', { id: randomUUID(), groupId: g, content: '@Bob 看一下项目' });
  await expect.poll(() => commands.some((c) => c.type === 'run')).toBe(true);
  job = (commands.find((c) => c.type === 'run') as { job: AgentJob }).job;
});
afterEach(async () => {
  await instance?.app.close();
  rmSync(directory, { recursive: true, force: true });
});
const question: NativeRequestSpec = {
  kind: 'question',
  title: '请选范围',
  questions: [
    {
      id: 'scope',
      header: '范围',
      question: '选择检查范围',
      options: [
        { label: '架构', description: '整体设计' },
        { label: '安全', description: '边界检查' },
      ],
      allowOther: false,
    },
  ],
};
function event(type: string, extra: Record<string, unknown> = {}) {
  instance.runtime.event(bridgeId, { type, taskId: job.task.id, leaseId: job.leaseId, ...extra });
}
function publish(spec = question, requestId = 'native-request') {
  event('interaction', { requestId, request: spec });
  return instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest!;
}
it('creates one host-owned group card and returns the answer to the exact waiting lease once', async () => {
  const request = publish();
  publish();
  expect(instance.store.snapshot().messages.filter((m) => m.nativeRequest)).toHaveLength(1);
  const response = { decision: 'accept', answers: { scope: ['架构'] } };
  expect((await api(`/api/native-requests/${request.id}/reply`, response)).statusCode).toBe(200);
  expect((await api(`/api/native-requests/${request.id}/reply`, response)).statusCode).toBe(200);
  expect(commands.filter((c) => c.type === 'native_reply')).toEqual([
    {
      type: 'native_reply',
      taskId: job.task.id,
      leaseId: job.leaseId,
      requestId: 'native-request',
      response,
    },
  ]);
  expect(commands.filter((c) => c.type === 'run')).toHaveLength(1);
  expect(instance.store.snapshot().messages.filter((m) => m.senderType === 'human')).toHaveLength(
    1,
  );
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest?.status,
  ).toBe('answered');
  expect(
    (await api(`/api/native-requests/${request.id}/reply`, { decision: 'decline' })).statusCode,
  ).toBe(409);
});
it('rejects invented answers, extra questions, malformed grants and session widening', async () => {
  const request = publish();
  for (const response of [
    { decision: 'accept', answers: { scope: ['invented'] } },
    { decision: 'accept', answers: { scope: ['架构'], other: ['x'] } },
    { decision: 'accept', answers: { scope: ['架构', '安全'] } },
    { decision: 'accept', scope: 'session', answers: { scope: ['架构'] } },
    { decision: 'accept', permissions: { network: true } },
  ])
    expect(
      (await api(`/api/native-requests/${request.id}/reply`, response)).statusCode,
    ).toBeGreaterThanOrEqual(400);
  expect(commands.filter((c) => c.type === 'native_reply')).toHaveLength(0);
});
it('expires a request after native resolution and after stop without forwarding late answers', async () => {
  const request = publish();
  event('interaction_resolved', { requestId: 'native-request' });
  expect(
    (await api(`/api/native-requests/${request.id}/reply`, { decision: 'decline' })).statusCode,
  ).toBe(409);
  event('interaction', { requestId: 'second', request: question });
  const second = instance.store
    .snapshot()
    .messages.filter((m) => m.nativeRequest)
    .at(-1)!.nativeRequest!;
  await api(`/api/chains/${job.task.correlationId}/stop`, {});
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest?.id === second.id)?.nativeRequest
      ?.status,
  ).toBe('cancelled');
  expect(
    (await api(`/api/native-requests/${second.id}/reply`, { decision: 'decline' })).statusCode,
  ).toBe(409);
});
it('ignores wrong leases and refuses interaction replies after bridge disconnection', async () => {
  event('interaction', { leaseId: randomUUID(), requestId: 'wrong', request: question });
  expect(instance.store.snapshot().messages.some((m) => m.nativeRequest)).toBe(false);
  const request = publish();
  instance.runtime.detach(bridgeId);
  expect(
    (await api(`/api/native-requests/${request.id}/reply`, { decision: 'decline' })).statusCode,
  ).toBe(409);
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest?.status,
  ).toBe('cancelled');
});
it('masks secret answers in persisted history while returning the actual value to the waiting native request', async () => {
  const request = publish({
    kind: 'question',
    title: '密钥',
    questions: [
      { id: 'secret', header: '密钥', question: '填写临时口令', isSecret: true, allowOther: true },
    ],
  });
  await api(`/api/native-requests/${request.id}/reply`, {
    decision: 'accept',
    answers: { secret: ['private-test-secret'] },
  });
  const saved = instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest;
  expect(JSON.stringify(saved)).not.toContain('private-test-secret');
  expect(commands.find((c) => c.type === 'native_reply')).toMatchObject({
    response: { answers: { secret: ['private-test-secret'] } },
  });
});
it('grants only the requested native permissions and preserves a once-or-session decision', async () => {
  const request = publish({
    kind: 'permission',
    title: '访问项目',
    details: { permissions: { fileSystem: { read: [directory] } } },
    allowSession: true,
  });
  expect(
    (
      await api(`/api/native-requests/${request.id}/reply`, {
        decision: 'accept',
        scope: 'session',
      })
    ).statusCode,
  ).toBe(200);
  expect(commands.find((c) => c.type === 'native_reply')).toMatchObject({
    response: { decision: 'accept', scope: 'session' },
  });
});
it('cannot reanimate a pending request after server restart', async () => {
  const request = publish();
  await instance.app.close();
  instance = await createApp({ databasePath: join(directory, 'db.sqlite'), token });
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest?.status,
  ).toBe('cancelled');
  expect(
    (await api(`/api/native-requests/${request.id}/reply`, { decision: 'decline' })).statusCode,
  ).toBe(409);
});

it('expires unanswered cards when the original execution completes', async () => {
  const request = publish();
  event('result', { status: 'completed', text: 'The execution already ended.' });
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest?.status,
  ).toBe('cancelled');
  expect(
    (
      await api(`/api/native-requests/${request.id}/reply`, {
        decision: 'accept',
        answers: { scope: ['架构'] },
      })
    ).statusCode,
  ).toBe(409);
  expect(commands.filter((c) => c.type === 'native_reply')).toHaveLength(0);
});

it('marks a submitted card as expired when the native process refuses delivery', async () => {
  const request = publish();
  const response = { decision: 'accept', answers: { scope: ['架构'] } };
  expect((await api(`/api/native-requests/${request.id}/reply`, response)).statusCode).toBe(200);
  event('interaction_rejected', { requestId: 'native-request' });
  expect(
    instance.store.snapshot().messages.find((m) => m.nativeRequest)?.nativeRequest?.status,
  ).toBe('cancelled');
  expect((await api(`/api/native-requests/${request.id}/reply`, response)).statusCode).toBe(409);
  expect(commands.filter((c) => c.type === 'native_reply')).toHaveLength(1);
});
