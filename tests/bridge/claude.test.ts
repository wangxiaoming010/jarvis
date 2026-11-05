import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { AgentJob } from '@openbot/shared';
import { ClaudeExecution } from '../../apps/bridge/src/claude';
import { discoverProviders } from '../../apps/bridge/src/providers';
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(mode = 'success') {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-claude-test-'));
  directories.push(directory);
  const executable = join(directory, 'fake-claude'),
    requests = join(directory, 'requests.json');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2),mode=${JSON.stringify(mode)};
if(args.includes('--version')){console.log('2.1.292');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='unauthenticated'}));process.exit(0);}
if(args.includes('--help')){console.log('--restricted --safe-mode --permission-prompts --system-prompt-snapshot --replay-user-messages');process.exit(0);}
if(args.includes('generate-json-schema'))process.exit(1);
if(args[0]==='app-server'){let pending='';process.stdin.on('data',c=>{pending+=c;let n;while((n=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');if(m.method==='account/read')process.stdout.write(JSON.stringify({id:m.id,result:{requiresOpenaiAuth:true,account:{type:'apiKey'}}})+'\\n');}});return;}
if(args[0]==='login')process.exit(0);
const session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
const send=m=>process.stdout.write(JSON.stringify({session_id:session,...m})+'\\n');
let input=''; process.stdin.on('data',c=>{input+=c;let i;while((i=input.indexOf('\\n'))>=0){const frame=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(frame.type==='user')handle(frame);else if(frame.type==='control_response'){const saved=JSON.parse(fs.readFileSync(${JSON.stringify(requests)},'utf8'));saved.response=frame.response;fs.writeFileSync(${JSON.stringify(requests)},JSON.stringify(saved));send({type:'result',subtype:'success',is_error:false,result:'native reply accepted'});}}});
function handle(frame){fs.writeFileSync(${JSON.stringify(requests)},JSON.stringify({args,frame}));
if(mode==='mismatch'){send({type:'system',subtype:'init',session_id:'another-session'});return;}
if(mode==='malformed'){process.stdout.write('{bad json\\n');return;}
send({type:'system',subtype:'init'});
send({type:'user',uuid:frame.uuid,message:frame.message});
send({type:'stream_event',user_message_uuid:frame.uuid,event:{type:'message_start',message:{id:'answer'}}});
send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE THINKING NEVER EXPOSE'}}});
send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'interim'}}});
send({type:'assistant',parent_tool_use_id:'child',message:{id:'child',content:[{type:'text',text:'child output'}]}});
send({type:'assistant',message:{id:'answer',content:[{type:'thinking',thinking:'PRIVATE THINKING NEVER EXPOSE'},{type:'text',text:'I am reading'},{type:'tool_use',id:'tool',name:'Read',input:{file_path:'README.md'}}]}});
if(mode==='web'){send({type:'control_request',request_id:'web-1',request:{subtype:'can_use_tool',tool_name:'WebFetch',input:{url:'https://example.com/news',prompt:'Read the publication date and summarize the news'}}});return;}
if(mode==='question'||mode==='permission'){send({type:'control_request',request_id:'control-1',request:{subtype:'can_use_tool',tool_name:mode==='question'?'AskUserQuestion':'Write',input:mode==='question'?{questions:[{header:'环境',question:'选择环境',options:[{label:'开发',description:'本地'},{label:'测试',description:'验证'}],multiSelect:false}]}:{file_path:'example.txt',content:'exact original content'}}});return;}
if(mode==='stalled')return;
if(mode==='early-exit'){process.exit(0);return;}
if(mode==='failed'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['failure sk-ant-secret123']});return;}
send({type:'result',subtype:'success',is_error:false,result:'verified final'});
}
process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  const job: AgentJob = {
    task: {
      id: 'task',
      groupId: 'g',
      botId: 'b',
      input: 'read the project',
      status: 'running',
      createdAt: '',
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      correlationId: 'c',
      round: 1,
    },
    leaseId: 'l',
    bot: {
      id: 'b',
      ownerId: 'u',
      name: 'Alice',
      description: 'reviewer',
      provider: 'claude-code',
      status: 'working',
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
it('denies Claude writes from a read-only assignment before requesting owner approval', async () => {
  const f = fixture('permission');
  f.job.resourceMode = 'read';
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {},
    approval: () => {},
    interaction: () => {
      throw new Error('read-only escalation');
    },
  });
  expect((await execution.run()).status).toBe('completed');
  expect(JSON.parse(readFileSync(f.requests, 'utf8')).response.response).toMatchObject({
    behavior: 'deny',
  });
});

it('permits web research in a read-only job and forwards fetch permission to the same process', async () => {
  const f = fixture('web');
  f.job.resourceMode = 'read';
  let captured: any;
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {},
    approval: () => {},
    interaction: (id, spec) => {
      captured = spec;
      setTimeout(() => execution.respond(id, { decision: 'accept' }), 0);
    },
  });
  expect(await execution.run()).toMatchObject({
    status: 'completed',
    text: 'native reply accepted',
  });
  expect(captured).toMatchObject({
    kind: 'tool',
    details: { tool: 'WebFetch', input: { url: 'https://example.com/news' } },
  });
  const saved = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(saved.response).toMatchObject({
    request_id: 'web-1',
    response: { behavior: 'allow', updatedInput: { url: 'https://example.com/news' } },
  });
  const tools = saved.args[saved.args.indexOf('--tools') + 1].split(',');
  expect(tools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
  expect(tools).not.toContain('Bash');
  expect(tools).not.toContain('Write');
});

it('requires host approval for writes, confirms the real input, keeps thinking private and returns the terminal result', async () => {
  const f = fixture();
  const sessions: string[] = [],
    activity: string[] = [],
    progress: string[] = [];
  let started = 0;
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: (id) => sessions.push(id),
    started: () => {
      started++;
    },
    activity: (text, report) => activity.push(text, report ?? ''),
    progress: (text) => progress.push(text),
    approval: () => {
      throw new Error('must not request approval');
    },
  });
  const result = await execution.run();
  expect(result).toEqual({ status: 'completed', text: 'verified final' });
  expect(sessions).toHaveLength(1);
  expect(started).toBe(1);
  expect(activity.join(' ')).toContain('读取文件');
  expect([...activity, ...progress].join(' ')).not.toMatch(/PRIVATE THINKING|child output/);
  const { args, frame } = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(frame.message.content).toBe('read the project');
  expect(args[args.indexOf('--tools') + 1]).toBe(
    'Read,Glob,Grep,WebSearch,WebFetch,Bash,Edit,Write,AskUserQuestion',
  );
  expect(args).toContain('--restricted');
  expect(args).toContain('--safe-mode');
  expect(args[args.indexOf('--add-dir') + 1]).toBe(parse(homedir()).root);
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
  expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,WebSearch');
  expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
    permissions: { ask: ['Bash', 'Edit', 'Write', 'WebFetch'] },
  });
  expect(args).toContain('--strict-mcp-config');
  expect(args).not.toContain('--dangerously-skip-permissions');
  expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('opsique-ui/0.1');
});
it('resumes only the pinned session and sends only unaccepted changes', async () => {
  const f = fixture();
  f.job.session = { threadId: 'pinned-session', lastMessageId: null };
  f.job.acceptedVersion = 1;
  f.job.task.input = 'OLD ASSIGNMENT';
  f.job.task.execution = {
    version: 2,
    executedVersion: 2,
    goal: 'OLD GOAL',
    contextMessageId: 'm',
    activity: null,
    report: null,
    updatedAt: '',
    pendingChange: null,
    changes: [
      { version: 1, instruction: 'OLD CHANGE', createdAt: '' },
      { version: 2, instruction: 'only inspect cache', createdAt: '' },
    ],
  };
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: (id) => expect(id).toBe('pinned-session'),
    progress: () => {},
    approval: () => {},
  });
  expect((await execution.run()).status).toBe('completed');
  const { args, frame } = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(args[args.indexOf('--resume') + 1]).toBe('pinned-session');
  expect(args).not.toContain('--continue');
  expect(frame.message.content).toBe('only inspect cache');
});
it.each(['mismatch', 'malformed', 'early-exit', 'failed'])(
  'fails closed on %s without promoting progress to a result',
  async (mode) => {
    const f = fixture(mode);
    const execution = new ClaudeExecution(f.executable, f.job, {
      session: () => {},
      progress: () => {},
      approval: () => {},
    });
    const result = await execution.run();
    expect(result.status).toBe('failed');
    expect(result.text).toBe('');
    expect(result.error).not.toContain('sk-ant-secret123');
  },
);
it('kills a stalled process before completing cancellation', async () => {
  const f = fixture('stalled');
  let started = false;
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: () => {},
    started: () => {
      started = true;
    },
    progress: () => {},
    approval: () => {},
  });
  const running = execution.run();
  try {
    await expect.poll(() => started, { timeout: 5000 }).toBe(true);
    await execution.cancel();
    expect((await running).status).toBe('cancelled');
  } finally {
    await execution.cancel();
    await execution.dispose();
  }
});
it('distinguishes a configured timeout from human cancellation', async () => {
  const f = fixture('stalled');
  const execution = new ClaudeExecution(
    f.executable,
    f.job,
    { session: () => {}, progress: () => {}, approval: () => {} },
    { timeoutMs: 100 },
  );
  expect(await execution.run()).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('时间限制'),
  });
});
it('does not start a subprocess if cancellation was already requested', async () => {
  const f = fixture();
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {},
    approval: () => {},
  });
  await execution.cancel();
  expect((await execution.run()).status).toBe('cancelled');
  expect(existsSync(f.requests)).toBe(false);
});
it('discovers both providers and never treats a logged-out Claude as available', async () => {
  const f = fixture();
  const env = {
    ...process.env,
    OPENBOT_CODEX_PATH: f.executable,
    OPENBOT_CLAUDE_PATH: f.executable,
  };
  expect((await discoverProviders(env)).providers.every((p) => p.available)).toBe(true);
  const loggedOut = fixture('unauthenticated');
  expect(
    (await discoverProviders({ ...env, OPENBOT_CLAUDE_PATH: loggedOut.executable })).providers.find(
      (p) => p.provider === 'claude-code',
    ),
  ).toMatchObject({ available: false, reason: expect.stringContaining('登录') });
});

it.each(['question', 'permission'])(
  'returns the original %s control request to the same Claude process',
  async (mode) => {
    const f = fixture(mode);
    let captured: any;
    const execution = new ClaudeExecution(f.executable, f.job, {
      session: () => {},
      progress: () => {},
      approval: () => {},
      interaction: (id, spec) => {
        captured = spec;
        setTimeout(
          () =>
            execution.respond(
              id,
              mode === 'question'
                ? { decision: 'accept', answers: { 'question-0': ['测试'] } }
                : { decision: 'decline' },
            ),
          0,
        );
      },
    });
    expect(await execution.run()).toMatchObject({
      status: 'completed',
      text: 'native reply accepted',
    });
    const saved = JSON.parse(readFileSync(f.requests, 'utf8'));
    expect(saved.response.request_id).toBe('control-1');
    if (mode === 'question')
      expect(saved.response.response).toMatchObject({
        behavior: 'allow',
        updatedInput: { answers: { 选择环境: '测试' } },
      });
    else {
      expect(captured.details.input.content).toBe('exact original content');
      expect(saved.response.response.behavior).toBe('deny');
    }
  },
);
it('approves the exact stored tool input and never accepts client-supplied tool changes', async () => {
  const f = fixture('permission');
  const execution = new ClaudeExecution(f.executable, f.job, {
    session: () => {},
    progress: () => {},
    approval: () => {},
    interaction: (id) => setTimeout(() => execution.respond(id, { decision: 'accept' }), 0),
  });
  await execution.run();
  const saved = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(saved.response.response).toEqual({
    behavior: 'allow',
    updatedInput: { file_path: 'example.txt', content: 'exact original content' },
  });
});

it('lets native auto mode review scoped actions without blanket ask rules or a filesystem-root grant', async () => {
  const f = fixture('permission');
  f.job.permissionMode = 'auto';
  f.job.executionDirectory = f.directory;
  let requests = 0;
  const execution = new ClaudeExecution(
    f.executable,
    f.job,
    {
      session: () => {},
      progress: () => {},
      approval: () => {},
      interaction: (id) => {
        requests++;
        setTimeout(() => execution.respond(id, { decision: 'decline' }), 0);
      },
    },
    { autoModeSupported: true },
  );
  expect((await execution.run()).status).toBe('completed');
  const { args, response } = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
  expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ permissions: { ask: [] } });
  expect(args).not.toContain('--add-dir');
  expect(args).not.toContain('--dangerously-skip-permissions');
  expect(requests).toBe(1);
  expect(response.response.behavior).toBe('deny');
});

it('keeps old CLIs in manual mode and reports the fallback', async () => {
  const f = fixture();
  f.job.permissionMode = 'auto';
  f.job.executionDirectory = f.directory;
  const activity: string[] = [];
  expect(
    (
      await new ClaudeExecution(
        f.executable,
        f.job,
        {
          session: () => {},
          progress: () => {},
          approval: () => {},
          activity: (text) => activity.push(text),
        },
        { autoModeSupported: false },
      ).run()
    ).status,
  ).toBe('completed');
  const { args } = JSON.parse(readFileSync(f.requests, 'utf8'));
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
  expect(activity.join(' ')).toContain('不支持自动模式');
});
