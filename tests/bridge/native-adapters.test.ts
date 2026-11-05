import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob, NativeReply, NativeRequestSpec } from '@openbot/shared';
import { CodexExecution } from '../../apps/bridge/src/codex';
import { checkedReply } from '../../apps/bridge/src/native';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(kind: string) {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-codex-native-'));
  dirs.push(dir);
  const executable = join(dir, 'fake-codex'),
    log = join(dir, 'frames.jsonl');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('fs'),kind=${JSON.stringify(kind)};let buffer='';const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
process.stdin.on('data',c=>{buffer+=c;let n;while((n=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});if(m.method==='turn/start'){
 send({id:m.id,result:{turn:{id:'turn'}}});
 let method,params={threadId:'thread',turnId:'turn',itemId:'item'};
 if(kind==='question'){method='item/tool/requestUserInput';params.questions=[{id:'scope',header:'范围',question:'选择范围',options:[{label:'架构',description:'整体'}],isOther:true}];}
 if(kind==='permission'){method='item/permissions/requestApproval';params.cwd='/project';params.permissions={fileSystem:{read:['/project']},network:{enabled:true}};}
 if(kind==='command'){method='item/commandExecution/requestApproval';params.command='printf hello';params.cwd='/project';}
 if(kind==='file'){method='item/fileChange/requestApproval';send({method:'item/started',params:{threadId:'thread',item:{type:'fileChange',id:'item',changes:[{path:'/project/example.txt',kind:'update',diff:'exact change'}]}}});}
 send({id:'native-request',method,params});
 }if(m.id==='native-request'&&m.result){send({method:'serverRequest/resolved',params:{threadId:'thread',requestId:'native-request'}});send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',id:'final',phase:'final_answer',text:'resumed'}}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});}
}});setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  const job: AgentJob = {
    task: {
      id: 't',
      groupId: 'g',
      botId: 'b',
      input: 'inspect',
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
      name: 'Bob',
      description: 'reviewer',
      provider: 'codex',
      status: 'working',
      bridgeId: 'bridge',
      createdAt: '',
    },
    group: { id: 'g', name: 'g', description: '', botIds: ['b'], createdAt: '' },
    members: [],
    messages: [],
    session: null,
    sourceMessageId: 'm',
  };
  return { dir, executable, log, job };
}
it.each(['question', 'permission', 'command', 'file'])(
  'round-trips a native Codex %s on its original JSON-RPC request',
  async (kind) => {
    const f = fixture(kind);
    let spec: NativeRequestSpec | undefined;
    const resolved: string[] = [];
    const execution = new CodexExecution(f.executable, f.job, {
      session: () => {},
      progress: () => {},
      approval: () => {
        throw new Error('must use native channel');
      },
      interaction: (id, request) => {
        spec = request;
        const reply: NativeReply =
          kind === 'question'
            ? { decision: 'accept', answers: { scope: ['自定义范围'] } }
            : kind === 'permission'
              ? { decision: 'accept', scope: 'session' }
              : { decision: 'decline' };
        setTimeout(() => execution.respond(id, reply), 0);
      },
      interactionResolved: (id) => resolved.push(id),
    });
    expect(await execution.run()).toMatchObject({ status: 'completed', text: 'resumed' });
    expect(spec?.kind).toBe(kind);
    expect(resolved).toContain('native-request');
    const frames = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    const result = frames.find((m) => m.id === 'native-request' && m.result).result;
    if (kind === 'question')
      expect(result).toEqual({ answers: { scope: { answers: ['自定义范围'] } } });
    if (kind === 'permission')
      expect(result).toEqual({
        permissions: { fileSystem: { read: ['/project'] }, network: { enabled: true } },
        scope: 'session',
      });
    if (kind === 'command') expect(result).toEqual({ decision: 'decline' });
    if (kind === 'file')
      expect(spec?.details).toMatchObject({
        changes: [{ path: '/project/example.txt', diff: 'exact change' }],
      });
  },
);

it.each(['permission', 'command', 'file'])(
  'declines Codex %s escalation for a read-only worker without asking the owner',
  async (kind) => {
    const f = fixture(kind);
    f.job.resourceMode = 'read';
    const execution = new CodexExecution(f.executable, f.job, {
      session: () => {},
      progress: () => {},
      approval: () => {
        throw new Error('read-only escalation');
      },
      interaction: () => {
        throw new Error('read-only escalation');
      },
    });
    expect((await execution.run()).status).toBe('completed');
    const frames = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    const result = frames.find((m) => m.id === 'native-request' && m.result).result;
    expect(result).toEqual(
      kind === 'permission' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' },
    );
  },
);

it.each([
  {
    spec: { kind: 'permission', title: 'Read project' },
    response: { decision: 'accept', answers: { injected: ['extra'] } },
  },
  {
    spec: {
      kind: 'question',
      title: 'Choose',
      questions: [{ id: 'q', header: '', question: 'Choose', multiSelect: true }],
    },
    response: { decision: 'accept', answers: { q: ['same', 'same'] } },
  },
  {
    spec: {
      kind: 'question',
      title: 'Choose',
      allowSession: true,
      questions: [{ id: 'q', header: '', question: 'Choose' }],
    },
    response: { decision: 'accept', scope: 'session', answers: { q: ['answer'] } },
  },
  {
    spec: {
      kind: 'question',
      title: 'Choose',
      questions: [{ id: 'q', header: '', question: 'Choose' }],
    },
    response: { decision: 'decline', answers: { q: ['answer'] } },
  },
])('rejects invalid responses again at the native process boundary: %#', ({ spec, response }) => {
  expect(() => checkedReply(spec as NativeRequestSpec, response as NativeReply)).toThrow();
});
