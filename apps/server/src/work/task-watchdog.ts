import { createHash, randomUUID } from 'node:crypto';
import type { Task, TaskExecution } from '@openbot/shared';
import type { Store } from '../store.js';

export type ReportKind = 'progress' | 'milestone' | 'blocked';
type Report = {
  id: string;
  task_id: string;
  lease_id: string;
  kind: ReportKind;
  summary: string;
  created_at: string;
};
type Hooks = {
  connected(botId: string): boolean;
  notify(task: Task, kind: string, facts: object): void;
};
const staleAfter = 300000;
const heartbeatAfter = 90000;
const reportInterval = 60000;

/** Maintains each Bot's task ledger from execution facts, without generating chat. */
export class TaskWatchdog {
  constructor(
    private store: Store,
    private hooks: Hooks,
  ) {}

  heartbeat(taskId: string, now = Date.now()) {
    this.store.db
      .prepare('UPDATE task_health SET last_heartbeat_at=? WHERE task_id=?')
      .run(new Date(now).toISOString(), taskId);
  }
  activity(taskId: string, now = Date.now()) {
    this.store.db
      .prepare('UPDATE task_health SET last_activity_at=? WHERE task_id=?')
      .run(new Date(now).toISOString(), taskId);
  }
  refresh(task: Task, now = Date.now()): NonNullable<TaskExecution['health']> {
    const old = this.store.db
      .prepare('SELECT last_activity_at,last_heartbeat_at FROM task_health WHERE task_id=?')
      .get(task.id) as { last_activity_at: string | null; last_heartbeat_at: string | null };
    const latest = [old.last_activity_at, task.execution?.updatedAt, task.startedAt, task.createdAt]
      .filter((s): s is string => Boolean(s))
      .sort()
      .at(-1)!;
    const pending = Boolean(
      this.store.db
        .prepare(
          "SELECT id FROM task_approvals WHERE task_id=? AND status='pending' UNION ALL SELECT id FROM native_requests WHERE task_id=? AND status='pending' LIMIT 1",
        )
        .get(task.id, task.id),
    );
    const run = this.store.db
      .prepare(
        'SELECT status FROM worker_runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
      )
      .get(task.id) as { status: string } | undefined;
    const report = this.store.db
      .prepare(
        'SELECT kind,summary,created_at FROM worker_reports WHERE task_id=? AND lease_id=(SELECT lease_id FROM task_runtime WHERE task_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(task.id, task.id) as Pick<Report, 'kind' | 'summary' | 'created_at'> | undefined;
    let state: string = task.status;
    let detail = task.error ?? '';
    if (task.status === 'queued') {
      state = this.hooks.connected(task.botId) ? 'queued' : 'waiting_device';
      detail = state === 'queued' ? '等待其他任务释放执行资源' : '等待本地执行连接';
      const owner = task.goalId
        ? (this.store.db
            .prepare('SELECT owner_wait,attention_reason FROM work_goals WHERE id=?')
            .get(task.goalId) as
            { owner_wait: number; attention_reason: string | null } | undefined)
        : undefined;
      if (owner?.owner_wait) {
        state = 'waiting_owner';
        detail = owner.attention_reason ?? '等待你决定下一步';
      }
    } else if (['running', 'cancelling'].includes(task.status)) {
      if (pending) {
        state = 'waiting_permission';
        detail = '等待你回答或授权';
      } else if (task.status === 'running' && report?.kind === 'blocked') {
        state = 'blocked';
        detail = `执行受阻：${report.summary.slice(0, 500)}`;
      } else if (task.status === 'running' && now - Date.parse(latest) >= staleAfter) {
        const heartbeat = old.last_heartbeat_at ?? task.startedAt ?? latest;
        state = now - Date.parse(heartbeat) >= heartbeatAfter ? 'unresponsive' : 'stalled';
        detail =
          state === 'unresponsive'
            ? '长时间未收到执行状态，请检查本地连接；未自动重试'
            : '执行仍在连接，但近期没有新进展';
      }
    } else if (task.status === 'failed' && run?.status === 'unknown') {
      state = 'unknown';
      detail = '连接已中断，执行结果尚未确认；未自动重试';
    } else if (task.status === 'reviewing') detail = '执行结果已返回，等待验收';
    const health = {
      state,
      detail,
      lastActivityAt: latest,
      lastHeartbeatAt: old.last_heartbeat_at,
      observedAt: new Date(now).toISOString(),
    };
    this.store.db
      .prepare(
        'UPDATE task_health SET state=?,detail=?,last_activity_at=?,observed_at=? WHERE task_id=?',
      )
      .run(state, detail, latest, health.observedAt, task.id);
    return health;
  }
  record(
    task: Task,
    leaseId: string,
    summary: string,
    kind: ReportKind = 'progress',
    now = Date.now(),
  ) {
    const text = summary.trim().slice(0, 4000);
    if (!text) return;
    const inserted = this.store.db
      .prepare(
        'INSERT OR IGNORE INTO worker_reports(id,task_id,lease_id,kind,summary,digest,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        task.id,
        leaseId,
        kind,
        text,
        createHash('sha256').update(text).digest('hex'),
        new Date(now).toISOString(),
      );
    if (inserted.changes) this.flush(task, now);
  }
  private flush(task: Task, now: number) {
    if (task.status !== 'running') return;
    const lease = this.store.db
      .prepare('SELECT lease_id FROM task_runtime WHERE task_id=?')
      .get(task.id) as { lease_id: string | null };
    const latest = this.store.db
      .prepare(
        "SELECT * FROM worker_reports WHERE task_id=? AND lease_id=? AND notified_at IS NULL ORDER BY CASE kind WHEN 'blocked' THEN 0 WHEN 'milestone' THEN 1 ELSE 2 END,created_at DESC,rowid DESC LIMIT 1",
      )
      .get(task.id, lease.lease_id) as Report | undefined;
    if (!latest) return;
    const notified = this.store.db
      .prepare('SELECT MAX(notified_at) AS at FROM worker_reports WHERE task_id=? AND lease_id=?')
      .get(task.id, lease.lease_id) as { at: string | null };
    // Coalesce ordinary reports; explicit blockers/milestones can be delivered immediately.
    if (latest.kind === 'progress' && notified.at && now - Date.parse(notified.at) < reportInterval)
      return;
    this.store.db.transaction(() => {
      this.hooks.notify(task, `progress:${latest.lease_id}:${latest.id}`, {
        reportId: latest.id,
        leaseId: latest.lease_id,
        kind: latest.kind,
        summary: latest.summary,
        reportedAt: latest.created_at,
        health: this.refresh(task, now),
      });
      this.store.db
        .prepare(
          'UPDATE worker_reports SET notified_at=? WHERE task_id=? AND lease_id=? AND notified_at IS NULL AND rowid<= (SELECT rowid FROM worker_reports WHERE id=?)',
        )
        .run(new Date(now).toISOString(), task.id, latest.lease_id, latest.id);
    })();
  }
  scan(now = Date.now()) {
    for (const task of this.store.snapshot().tasks) {
      if (!task.execution) continue;
      const health = this.refresh(task, now);
      this.flush(task, now);
      if (!['stalled', 'unresponsive', 'reviewing', 'blocked'].includes(health.state)) continue;
      const updated = health.lastActivityAt!;
      if (now - Date.parse(updated) < staleAfter) continue;
      const marker = this.store.db
        .prepare('SELECT watchdog_at FROM task_workers WHERE task_id=?')
        .get(task.id) as { watchdog_at: string | null } | undefined;
      if (!marker || (marker.watchdog_at && marker.watchdog_at >= updated)) continue;
      this.store.db.transaction(() => {
        this.store.db
          .prepare('UPDATE task_workers SET watchdog_at=? WHERE task_id=?')
          .run(new Date(now).toISOString(), task.id);
        this.hooks.notify(task, `watchdog:${updated}`, { taskId: task.id, ...health });
      })();
    }
  }
}
