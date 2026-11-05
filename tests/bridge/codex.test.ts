import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentJob } from '@openbot/shared';
import { CodexExecution } from '../../apps/bridge/src/codex';
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(stalled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-native-protocol-'));
  directories.push(directory);
  const executable = join(directory, 'fake-codex');
  const requests = join(directory, 'requests.jsonl');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('fs');let buffer='';function send(m){process.stdout.write(JSON.stringify(m)+'\\n');}
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['app-server']))process.exit(2);
process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(m)+'\\n');if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'native-test-thread'}}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'native-test-turn'}}});send({method:'item/started',params:{threadId:'native-test-thread',item:{type:'agentMessage',id:'commentary',phase:'commentary',text:'working'}}});${stalled ? '' : `setTimeout(()=>{send({method:'item/completed',params:{threadId:'native-test-thread',item:{type:'agentMessage',id:'final',phase:'final_answer',text:'final answer'}}});send({method:'turn/completed',params:{threadId:'native-test-thread',turn:{id:'native-test-turn',status:'completed'}}});},40);`}}}});
setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  const job: AgentJob = {
    task: {
      id: 'task',
      groupId: 'g',
      botId: 'b',
      input: 'hello',
      status: 'running',
      createdAt: '',
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      correlationId: 'c',
      round: 1,
    },
    leaseId: 'lease',
    bot: {
      id: 'b',
      ownerId: 'u',
      name: 'Bob',
      description: 'role',
      provider: 'codex',
      status: 'thinking',
      bridgeId: 'bridge',
      createdAt: '',
    },
    group: {
      id: 'g',
      name: 'group',
      description: '',
      botIds: ['b'],
      createdAt: '',
    },
    members: [],
    messages: [],
    session: null,
    sourceMessageId: 'm',
  };
  return { directory, executable, requests, job };
}
it('drives the native protocol with an explicit read-only policy and publishes final text only', async () => {
  const f = fixture();
  let session = '';
  const execution = new CodexExecution(f.executable, f.job, {
    session: (id) => {
      session = id;
    },
    progress: () => {},
    approval: () => {},
  });
  const result = await execution.run();
  expect(result).toMatchObject({ status: 'completed', text: 'final answer' });
  expect(session).toBe('native-test-thread');
  const frames = readFileSync(f.requests, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.find((m) => m.method === 'thread/start').params).toMatchObject({
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    config: { web_search: 'live' },
  });
  const instructions = frames.find((m) => m.method === 'thread/start').params.developerInstructions;
  expect(
    frames
      .filter((m) => ['thread/start', 'turn/start'].includes(m.method))
      .every((m) => !Object.hasOwn(m.params, 'cwd')),
  ).toBe(true);
  expect(instructions).toContain('opsique-ui/0.1');
  expect(instructions).toContain('Proactively choose a card');
  expect(instructions).toContain('actionId reply');
  expect(frames.find((m) => m.method === 'turn/start').params.input[0].text).toBe('hello');
});
it('terminates a stalled native interrupt instead of leaving cancellation blocked on RPC', async () => {
  const f = fixture(true);
  let progress = false;
  const execution = new CodexExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {
      progress = true;
    },
    approval: () => {},
  });
  const result = execution.run();
  try {
    await expect.poll(() => progress, { timeout: 5000 }).toBe(true);
    const started = Date.now();
    await execution.cancel();
    expect((await result).status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(6000);
    const frames = readFileSync(f.requests, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.some((m) => m.method === 'turn/interrupt')).toBe(true);
  } finally {
    await execution.dispose();
  }
});

it('reports an explicitly configured time limit as an incomplete failure rather than a user cancellation', async () => {
  const f = fixture(true);
  const execution = new CodexExecution(
    f.executable,
    f.job,
    {
      session: () => {},
      progress: () => {},
      approval: () => {},
    },
    { timeoutMs: 50 },
  );
  const result = await execution.run();
  expect(result.status).toBe('failed');
  expect(result.error).toContain('时间限制');
  expect(result.text).toBe('');
});

it('resumes a native conversation with only changes not yet accepted by that thread', async () => {
  const f = fixture();
  f.job.session = { threadId: 'native-test-thread', lastMessageId: null };
  f.job.acceptedVersion = 2;
  f.job.task.input = '原始用户要求，不应该重复发送';
  f.job.task.execution = {
    version: 3,
    executedVersion: 3,
    goal: '原始完整工作说明，也不应该重复发送',
    contextMessageId: 'original-message',
    activity: null,
    report: null,
    updatedAt: '',
    pendingChange: null,
    changes: [
      { version: 2, instruction: '已经确认过的补充要求', createdAt: '' },
      { version: 3, instruction: '这次只检查缓存清理的调用点。', createdAt: '' },
    ],
  };
  f.job.messages = [
    {
      id: 'old',
      groupId: 'g',
      senderId: 'u',
      senderType: 'human',
      content: '之前整段群聊',
      mentions: [],
      replyTo: null,
      timestamp: '',
      messageType: 'text',
      correlationId: null,
    },
  ];
  const execution = new CodexExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {},
    approval: () => {},
  });
  expect((await execution.run()).status).toBe('completed');
  const frames = readFileSync(f.requests, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.some((m) => m.method === 'thread/resume')).toBe(true);
  expect(frames.find((m) => m.method === 'thread/resume').params.config).toEqual({
    web_search: 'live',
  });
  expect(frames.find((m) => m.method === 'thread/resume').params.developerInstructions).toContain(
    'opsique-ui/0.1',
  );
  const text = frames.find((m) => m.method === 'turn/start').params.input[0].text;
  expect(text).toBe('这次只检查缓存清理的调用点。');
  expect(text).not.toMatch(/原始|已经确认过|群聊|taskAssignment|correlationId/);
});

it('uses scoped workspace writes and native automatic review on every resumed turn', async () => {
  const f = fixture();
  const directory = realpathSync(f.directory);
  f.job.permissionMode = 'auto';
  f.job.executionDirectory = f.directory;
  f.job.session = { threadId: 'native-test-thread', lastMessageId: null };
  const execution = new CodexExecution(
    f.executable,
    f.job,
    {
      session: () => {},
      progress: () => {},
      approval: () => {},
    },
    { autoModeSupported: true },
  );
  expect((await execution.run()).status).toBe('completed');
  const frames = readFileSync(f.requests, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.find((m) => m.method === 'thread/resume').params).toMatchObject({
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review',
    cwd: directory,
  });
  expect(frames.find((m) => m.method === 'turn/start').params).toMatchObject({
    approvalsReviewer: 'auto_review',
    cwd: directory,
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [directory], networkAccess: false },
  });
});

it('overrides a persisted automatic session when dispatch becomes read-only', async () => {
  const f = fixture();
  f.job.permissionMode = 'auto';
  f.job.resourceMode = 'read';
  f.job.executionDirectory = f.directory;
  f.job.session = { threadId: 'native-test-thread', lastMessageId: null };
  expect(
    (
      await new CodexExecution(
        f.executable,
        f.job,
        {
          session: () => {},
          progress: () => {},
          approval: () => {},
        },
        { autoModeSupported: true },
      ).run()
    ).status,
  ).toBe('completed');
  const frames = readFileSync(f.requests, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.find((m) => m.method === 'thread/resume').params.sandbox).toBe('read-only');
  expect(frames.find((m) => m.method === 'turn/start').params).toMatchObject({
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly' },
  });
});
