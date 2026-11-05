import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProviders } from '../../apps/bridge/src/providers';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-discovery-'));
  directories.push(directory);
  const executable = join(directory, 'cli');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const mode=${JSON.stringify(mode)},args=process.argv.slice(2);
if(args.includes('generate-json-schema')){
 if(mode!=='modern')process.exit(1);
 const fs=require('fs'),path=require('path'),directory=args[args.indexOf('--out')+1];
 fs.mkdirSync(path.join(directory,'v2'),{recursive:true});
 fs.writeFileSync(path.join(directory,'v2','ThreadStartParams.json'),JSON.stringify({properties:{approvalsReviewer:{}},definitions:{ApprovalsReviewer:{enum:['user','auto_review']}}}));
 process.exit(0);
}
if(args[0]==='--version'){
 if(mode==='failure'){console.error('private-account-data');process.exit(1);}
 if(mode==='timeout'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 setTimeout(()=>console.log('test-cli 1.0'),mode==='slow'?1200:0);return;
}
if(args[0]==='app-server'){
 let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='account/read')console.log(JSON.stringify({id:m.id,result:{requiresOpenaiAuth:false,account:null}}));}});return;
}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));return;}
console.log('--restricted --safe-mode --permission-prompts --system-prompt-snapshot --replay-user-messages'+(mode==='modern'?' --permission-mode (choices: "manual", "auto")':''));
`,
    { mode: mode === 'permission' ? 0o600 : 0o700 },
  );
  return executable;
}

it('keeps the event loop responsive during slow CLI discovery', async () => {
  const started = performance.now();
  const heartbeat = new Promise<number>((resolve) =>
    setTimeout(() => resolve(performance.now() - started), 75),
  );
  const discovery = discoverProviders({
    ...process.env,
    OPENBOT_CODEX_PATH: fixture('ok'),
    OPENBOT_CLAUDE_PATH: fixture('slow'),
  });
  const elapsed = await heartbeat;
  const { providers } = await discovery;
  expect(elapsed).toBeLessThan(800);
  expect(providers.every((provider) => provider.available)).toBe(true);
});

it.each([
  ['missing', '需安装'],
  ['permission', '执行权限'],
  ['timeout', '版本检查超时'],
  ['failure', '版本检查失败'],
])('distinguishes %s from other executable failures', async (mode, reason) => {
  const executable = fixture(mode);
  const { providers } = await discoverProviders(
    {
      ...process.env,
      OPENBOT_CODEX_PATH: mode === 'missing' ? executable + '-missing' : executable,
      OPENBOT_CLAUDE_PATH: executable + '-missing',
    },
    { commandTimeoutMs: 2500 },
  );
  expect(providers[0]).toMatchObject({ available: false, reason: expect.stringContaining(reason) });
  expect(providers[0].reason).not.toContain('private-account-data');
  expect(providers[0].version).toBe(mode === 'missing' ? 'not installed' : 'unknown');
});

it('advertises native automatic review only when each CLI exposes that capability', async () => {
  const executable = fixture('modern');
  const { providers } = await discoverProviders({
    ...process.env,
    OPENBOT_CODEX_PATH: executable,
    OPENBOT_CLAUDE_PATH: executable,
  });
  expect(providers).toEqual([
    expect.objectContaining({ provider: 'codex', available: true, autoMode: true }),
    expect.objectContaining({ provider: 'claude-code', available: true, autoMode: true }),
  ]);
});
