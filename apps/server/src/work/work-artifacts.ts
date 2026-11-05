import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Message, WorkArtifact, WorkGoal } from '@openbot/shared';
import type { Store } from '../store.js';
import { ProjectFacts } from './project-facts.js';
import { goalSelect, artifactSelect } from './work-records.js';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (path: string, args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
type FileReceipt = { path: string; type: 'file' | 'link' | 'deleted'; digest: string };
function receipt(path: string, label = path): FileReceipt {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      return { path: label, type: 'link', digest: hash(readlinkSync(path)) };
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new Error('交付文件类型不支持或超过 32MB');
    return { path: label, type: 'file', digest: hash(readFileSync(path)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: label, type: 'deleted', digest: '' };
    throw error;
  }
}
export class WorkArtifacts {
  constructor(private store: Store) {}
  get(id: string) {
    const a = this.store.db.prepare(`${artifactSelect} WHERE id=?`).get(id) as
      WorkArtifact | undefined;
    if (!a) throw new Error('交付物不存在');
    return a;
  }
  private goal(id: string, botId?: string, groupId?: string) {
    const g = this.store.db.prepare(`${goalSelect} WHERE id=?`).get(id) as WorkGoal | undefined;
    if (!g || (botId && g.botId !== botId) || (groupId && g.groupId !== groupId))
      throw new Error('交付物目标不属于当前授权范围');
    return g;
  }
  canRead(a: WorkArtifact, botId: string, groupId: string) {
    const goal = this.goal(a.goalId);
    if (goal.botId === botId && goal.groupId === groupId) return;
    if (
      goal.groupId === groupId &&
      this.store.db
        .prepare(
          "SELECT 1 FROM bot_delegations WHERE goal_id=? AND target_bot_id=? AND state IN ('accepted','submitted')",
        )
        .get(goal.id, botId)
    )
      return;
    if (
      goal.projectId &&
      this.store.db
        .prepare(
          'SELECT 1 FROM project_groups p JOIN group_bots b ON b.group_id=p.group_id WHERE p.project_id=? AND p.group_id=? AND b.bot_id=?',
        )
        .get(goal.projectId, groupId, botId)
    )
      return;
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM bot_delegations d JOIN work_goals g ON g.id=d.goal_id WHERE d.child_goal_id=? AND d.source_bot_id=? AND g.group_id=? AND d.state IN ('submitted','completed')",
        )
        .get(goal.id, botId, groupId)
    )
      throw new Error('交付物不属于当前授权范围');
  }
  private owned(a: WorkArtifact, botId: string, groupId: string, version: number) {
    this.goal(a.goalId, botId, groupId);
    if (a.version !== version) throw new Error('交付物版本已过期');
    this.assertUnchanged(a);
  }
  private manifest(kind: WorkArtifact['kind'], locator: string, taskId: string) {
    if (kind === 'report') {
      const r = this.store.db
        .prepare("SELECT result FROM worker_runs WHERE id=? AND task_id=? AND status='completed'")
        .get(locator, taskId) as { result: string } | undefined;
      if (!r?.result) throw new Error('报告必须引用已完成的真实执行');
      return { text: r.result };
    }
    if (!isAbsolute(locator)) throw new Error('交付文件必须使用绝对路径');
    if (kind === 'file') {
      const file = receipt(locator);
      if (file.type === 'deleted') throw new Error('交付文件不存在');
      if (file.type !== 'file')
        throw new Error('文件交付需要普通文件，符号链接请作为 Git 交付记录');
      return { files: [file] };
    }
    const workspace = this.store.db
      .prepare(
        'SELECT w.path,w.root,w.base_commit FROM pipeline_workspaces w JOIN task_pipeline_bindings b ON b.pipeline_id=w.pipeline_id WHERE b.task_id=?',
      )
      .get(taskId) as { path: string; root: string; base_commit: string } | undefined;
    if (!workspace || resolve(locator) !== resolve(workspace.path))
      throw new Error('Git 交付必须是此执行的真实工作副本');
    const paths = [
      ...new Set(
        [
          ...git(locator, ['diff', '--name-only', '-z', workspace.base_commit, '--']).split('\0'),
          ...git(locator, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
        ].filter(Boolean),
      ),
    ].sort();
    if (!paths.length || paths.length > 500)
      throw new Error('Git 交付需要 1 至 500 个实际变更文件');
    const files = paths.map((p) => {
      const rel = relative(locator, join(locator, p));
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('无效的交付路径');
      return receipt(join(locator, p), p);
    });
    return { root: workspace.root, baseCommit: workspace.base_commit, files };
  }
  register(
    botId: string,
    groupId: string,
    input: {
      goalId: string;
      taskId: string;
      title: string;
      kind: WorkArtifact['kind'];
      locator: string;
      applicationPath?: string;
      artifactId?: string;
      expectedVersion?: number;
    },
  ) {
    const goal = this.goal(input.goalId, botId, groupId);
    if (['completed', 'cancelled'].includes(goal.state))
      throw new Error('目标已结束，请先明确重新接下目标');
    if (goal.ownerWait) throw new Error('目标等待所有者决定');
    const run = this.store.db
      .prepare(
        "SELECT r.id FROM worker_runs r JOIN tasks t ON t.id=r.task_id WHERE t.id=? AND t.goal_id=? AND r.status='completed' ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1",
      )
      .get(input.taskId, goal.id) as { id: string } | undefined;
    if (!run) throw new Error('交付物必须关联本目标已完成的真实执行');
    new ProjectFacts(this.store).assertCurrent(run.id);
    if (input.kind === 'report' && input.locator !== run.id)
      throw new Error('报告必须使用当前生产执行');
    const manifest = this.manifest(input.kind, input.locator, input.taskId),
      digest = hash(JSON.stringify(manifest));
    if (input.applicationPath && !isAbsolute(input.applicationPath))
      throw new Error('应用位置必须使用绝对路径');
    const old = input.artifactId ? this.get(input.artifactId) : undefined;
    if (old && (old.goalId !== goal.id || input.expectedVersion !== old.version))
      throw new Error('交付物归属或版本不符');
    const id = old?.id ?? randomUUID(),
      version = (old?.version ?? 0) + 1,
      now = new Date().toISOString();
    this.store.db.transaction(() => {
      if (old)
        this.store.db
          .prepare(
            "UPDATE work_artifacts SET task_id=?,producer_run_id=?,title=?,kind=?,locator=?,application_path=?,version=?,digest=?,manifest=?,state='produced',updated_at=? WHERE id=?",
          )
          .run(
            input.taskId,
            run.id,
            input.title,
            input.kind,
            input.locator,
            input.applicationPath ?? null,
            version,
            digest,
            JSON.stringify(manifest),
            now,
            id,
          );
      else
        this.store.db
          .prepare(
            'INSERT INTO work_artifacts(id,goal_id,task_id,producer_run_id,title,kind,locator,application_path,version,digest,manifest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            goal.id,
            input.taskId,
            run.id,
            input.title,
            input.kind,
            input.locator,
            input.applicationPath ?? null,
            version,
            digest,
            JSON.stringify(manifest),
            now,
            now,
          );
      this.store.db
        .prepare('INSERT INTO artifact_history VALUES(?,?,?,?,?)')
        .run(id, version, digest, JSON.stringify(manifest), now);
    })();
    return this.get(id);
  }
  assertUnchanged(a: WorkArtifact) {
    if (a.producerRunId) new ProjectFacts(this.store).assertCurrent(a.producerRunId);
    if (!a.taskId || hash(JSON.stringify(this.manifest(a.kind, a.locator, a.taskId))) !== a.digest)
      throw new Error('交付内容已变化，请登记新版本并重新验证');
    if (a.state === 'applied') this.checkApplication(a);
  }
  capture(ids: string[], runId: string, botId: string, groupId: string) {
    return ids.map((id) => {
      const a = this.get(id);
      this.canRead(a, botId, groupId);
      this.assertUnchanged(a);
      this.store.db
        .prepare('INSERT INTO task_artifact_refs VALUES(?,?,?,?)')
        .run(runId, id, a.version, a.digest);
      return a;
    });
  }
  verify(
    botId: string,
    groupId: string,
    source: Message,
    input: {
      artifactId: string;
      version: number;
      method: 'json' | 'independent_run' | 'human';
      verifierRunId?: string;
      quote?: string;
    },
  ) {
    const a = this.get(input.artifactId);
    this.owned(a, botId, groupId, input.version);
    let evidence: string,
      verifier: string | null = null;
    if (input.method === 'json') {
      if (a.kind !== 'file') throw new Error('JSON 校验仅适用于文件');
      JSON.parse(readFileSync(a.locator, 'utf8'));
      evidence = '已读取当前摘要对应的文件，JSON 语法解析成功；此项不证明业务或测试正确性';
    } else if (input.method === 'human') {
      if (source.senderType !== 'human') throw new Error('人工验证需要所有者明确确认');
      evidence = source.content;
    } else {
      verifier = input.verifierRunId ?? null;
      const r = this.store.db
        .prepare(
          "SELECT r.result FROM worker_runs r JOIN task_artifact_refs b ON b.run_id=r.id JOIN tasks t ON t.id=r.task_id JOIN worker_runs producer ON producer.id=? WHERE r.id=? AND r.status='completed' AND t.status='completed' AND b.artifact_id=? AND b.version=? AND b.digest=? AND r.task_id!=producer.task_id AND r.thread_id IS NOT NULL AND producer.thread_id IS NOT NULL AND (r.thread_id!=producer.thread_id OR r.provider!=producer.provider)",
        )
        .get(a.producerRunId, verifier, a.id, a.version, a.digest) as
        { result: string } | undefined;
      if (
        !r ||
        verifier === a.producerRunId ||
        !input.quote?.trim() ||
        !r.result?.includes(input.quote.trim())
      )
        throw new Error('独立验证必须来自已验收、读取过此版本交付物的另一执行，并引用真实结果');
      new ProjectFacts(this.store).assertCurrent(verifier!);
      evidence = input.quote;
    }
    this.store.db
      .prepare('INSERT INTO artifact_checks VALUES(?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        a.id,
        a.version,
        input.method,
        verifier,
        source.id,
        evidence,
        new Date().toISOString(),
      );
    if (a.state === 'produced')
      this.store.db
        .prepare("UPDATE work_artifacts SET state='verified',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), a.id);
    return this.get(a.id);
  }
  accept(botId: string, groupId: string, id: string, version: number) {
    const a = this.get(id);
    this.owned(a, botId, groupId, version);
    if (!['verified', 'accepted', 'applied'].includes(a.state)) throw new Error('交付物尚未验证');
    if (a.state === 'verified')
      this.store.db
        .prepare("UPDATE work_artifacts SET state='accepted',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    return this.get(id);
  }
  application(botId: string, groupId: string, id: string, version: number, source: Message) {
    const a = this.get(id);
    this.owned(a, botId, groupId, version);
    if (!['accepted', 'applied'].includes(a.state)) throw new Error('交付物必须先由负责人接受');
    const { m, actual } = this.checkApplication(a);
    this.store.db
      .prepare('INSERT INTO artifact_checks VALUES(?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        id,
        version,
        'application',
        null,
        source.id,
        JSON.stringify({ target: m.root ?? a.applicationPath, digest: a.digest, files: actual }),
        new Date().toISOString(),
      );
    this.store.db
      .prepare("UPDATE work_artifacts SET state='applied',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    return this.get(id);
  }
  private checkApplication(a: WorkArtifact) {
    const m = JSON.parse(a.manifest) as {
      root?: string;
      baseCommit?: string;
      files?: FileReceipt[];
    };
    let actual: FileReceipt[];
    if (a.kind === 'git' && m.root) {
      git(m.root, ['merge-base', '--is-ancestor', m.baseCommit!, 'HEAD']);
      actual = m.files!.map((f) => receipt(join(m.root!, f.path), f.path));
    } else if (a.kind === 'file' && a.applicationPath)
      actual = [receipt(a.applicationPath, a.locator)];
    else throw new Error('交付物没有明确可核实的应用位置');
    if (JSON.stringify(actual) !== JSON.stringify(m.files))
      throw new Error('目标项目内容尚未匹配交付版本，不能标记为已应用');
    return { m, actual };
  }
}
