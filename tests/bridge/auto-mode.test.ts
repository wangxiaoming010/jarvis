import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { AgentJob } from '@openbot/shared';
import { codexAutoMode, executionPolicy } from '../../apps/bridge/src/auto-mode';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const directory = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'openbot-auto-')));
  directories.push(path);
  return path;
};
it('requires an explicit narrow directory, supported CLI and mutating assignment for auto mode', () => {
  const path = directory();
  const job = { permissionMode: 'auto', task: {}, executionDirectory: path } as AgentJob;
  expect(executionPolicy(job, true)).toMatchObject({ automatic: true, directory: path });
  for (const changed of [
    { permissionMode: 'manual' },
    { resourceMode: 'read' },
    { executionDirectory: undefined },
    { executionDirectory: homedir() },
    { executionDirectory: parse(path).root },
  ])
    expect(executionPolicy({ ...job, ...changed } as AgentJob, true).automatic).toBe(false);
  expect(executionPolicy(job, false).automatic).toBe(false);
  expect(() =>
    executionPolicy({ ...job, executionDirectory: join(path, 'missing') }, true),
  ).toThrow('目录已不可用');
  expect(() => executionPolicy({ ...job, executionDirectory: 'relative' }, true)).toThrow(
    '完整路径',
  );
});
it('detects native Codex review capability from its own schema and fails closed', async () => {
  const path = directory();
  for (const supported of [true, false]) {
    const executable = join(path, 'codex');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
const dir=args[args.indexOf('--out')+1];fs.mkdirSync(path.join(dir,'v2'),{recursive:true});
fs.writeFileSync(path.join(dir,'v2','ThreadStartParams.json'),JSON.stringify({properties:{approvalsReviewer:{}},definitions:{ApprovalsReviewer:{enum:${JSON.stringify(supported ? ['user', 'auto_review'] : ['user'])}}}}));
`,
      { mode: 0o700 },
    );
    expect(await codexAutoMode(executable, process.env)).toBe(supported);
  }
  expect(await codexAutoMode(join(path, 'missing'), process.env)).toBe(false);
});
