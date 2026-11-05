import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Task } from '@openbot/shared';
import type { Store } from '../store.js';
export type ResourceMode = 'read' | 'exclusive' | 'worktree';
const git = (root: string, args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A device-wide writer lease is real scheduling exclusion, not a claimed path boundary. */
export class TaskResources {
  constructor(private store: Store) {}
  directory(taskId: string): string | undefined {
    const workspace = this.store.db
      .prepare(
        'SELECT p.path FROM pipeline_workspaces p JOIN task_pipeline_bindings b ON b.pipeline_id=p.pipeline_id WHERE b.task_id=?',
      )
      .get(taskId) as { path: string } | undefined;
    if (workspace) return workspace.path;
    const worker = this.store.db
      .prepare('SELECT resource_key FROM task_workers WHERE task_id=?')
      .get(taskId) as { resource_key: string } | undefined;
    return worker?.resource_key && worker.resource_key !== '*' ? worker.resource_key : undefined;
  }
  mode(taskId: string): ResourceMode {
    return (
      (
        this.store.db
          .prepare('SELECT resource_mode FROM task_workers WHERE task_id=?')
          .get(taskId) as { resource_mode: ResourceMode } | undefined
      )?.resource_mode ?? 'exclusive'
    );
  }
  writerBusy(task: Task, active: Task[]) {
    if (this.mode(task.id) === 'read') return false;
    const device = this.store.snapshot().bots.find((b) => b.id === task.botId)?.bridgeId;
    // Unknown executions keep the writer lease until an explicit reconciliation of that task.
    const unknown = this.store.db
      .prepare(
        "SELECT r.task_id,r.bridge_id FROM worker_runs r WHERE r.status='unknown' AND r.id=(SELECT id FROM worker_runs WHERE task_id=r.task_id ORDER BY started_at DESC,rowid DESC LIMIT 1)",
      )
      .all() as { task_id: string; bridge_id: string }[];
    return (
      active.some(
        (t) =>
          t.id !== task.id &&
          this.store.snapshot().bots.find((b) => b.id === t.botId)?.bridgeId === device &&
          this.mode(t.id) !== 'read',
      ) ||
      unknown.some(
        (r) => r.task_id !== task.id && r.bridge_id === device && this.mode(r.task_id) !== 'read',
      )
    );
  }
  prepare(task: Task) {
    if (this.mode(task.id) !== 'worktree') return;
    const row = this.store.db
      .prepare(
        'SELECT b.pipeline_id,w.resource_key FROM task_pipeline_bindings b JOIN task_workers w ON w.task_id=b.task_id WHERE b.task_id=?',
      )
      .get(task.id) as { pipeline_id: string; resource_key: string };
    const old = this.store.db
      .prepare('SELECT path,root FROM pipeline_workspaces WHERE pipeline_id=?')
      .get(row.pipeline_id) as { path: string; root: string } | undefined;
    if (old) {
      if (
        row.resource_key !== '*' &&
        git(row.resource_key, ['rev-parse', '--show-toplevel']) !== old.root
      )
        throw new Error('这段工作已关联其他项目的独立副本，请为新项目创建新的工作管道');
      if (git(old.path, ['rev-parse', '--show-toplevel']) !== realpathSync(old.path))
        throw new Error('工作副本不再可用，需要先核实已有改动');
      return;
    }
    if (row.resource_key === '*') throw new Error('独立工作副本需要明确的 Git 项目路径');
    const root = git(row.resource_key, ['rev-parse', '--show-toplevel']);
    if (git(root, ['status', '--porcelain']).length)
      throw new Error('项目有尚未保存为提交的改动，请先处理或使用独占执行，避免遗漏当前工作');
    const base = git(root, ['rev-parse', 'HEAD']);
    const dbFile = this.store.db.name;
    const parent = join(dirname(dbFile), 'worktrees');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const path = join(parent, row.pipeline_id);
    // No shell interpolation. The generated path and detached base never change the user's branch.
    git(root, ['worktree', 'add', '--detach', path, base]);
    this.store.db
      .prepare(
        'INSERT INTO pipeline_workspaces(pipeline_id,root,path,base_commit,created_at) VALUES(?,?,?,?,?)',
      )
      .run(row.pipeline_id, root, path, base, new Date().toISOString());
  }
  inspect(taskId: string) {
    const row = this.store.db
      .prepare(
        'SELECT w.* FROM pipeline_workspaces w JOIN task_pipeline_bindings b ON b.pipeline_id=w.pipeline_id WHERE b.task_id=?',
      )
      .get(taskId) as
      { pipeline_id: string; root: string; path: string; base_commit: string } | undefined;
    if (!row) return;
    let review: object;
    try {
      review = {
        baseCommit: row.base_commit,
        originalHead: git(row.root, ['rev-parse', 'HEAD']),
        originalChanged: git(row.root, ['status', '--porcelain']).length > 0,
        changedFiles: git(row.path, ['diff', '--name-status', row.base_commit]).slice(0, 12000),
        untracked: git(row.path, ['ls-files', '--others', '--exclude-standard']).slice(0, 8000),
        integrated: false,
        path: row.path,
      };
    } catch {
      review = {
        error: '工作副本检查失败，产物保留，未自动合入',
        path: row.path,
        integrated: false,
      };
    }
    this.store.db
      .prepare('UPDATE pipeline_workspaces SET review=? WHERE pipeline_id=?')
      .run(JSON.stringify(review), row.pipeline_id);
  }
}
