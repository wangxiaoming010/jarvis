import { randomUUID } from 'node:crypto';
import type { Provider, Task } from '@openbot/shared';
import type { Store } from '../store.js';

/** A pipeline is a durable work context; native sessions remain provider/device-specific. */
export class TaskPipelines {
  constructor(private store: Store) {}

  assign(task: Task, title: string, pipelineId?: string) {
    return this.store.db.transaction(() => {
      const existing = this.store.db
        .prepare('SELECT pipeline_id FROM task_pipeline_bindings WHERE task_id=?')
        .get(task.id) as { pipeline_id: string } | undefined;
      if (existing) return existing.pipeline_id;
      const id = pipelineId ?? randomUUID();
      if (pipelineId) {
        const pipeline = this.store.db
          .prepare('SELECT bot_id,group_id,archived_at FROM task_pipelines WHERE id=?')
          .get(id) as { bot_id: string; group_id: string; archived_at: string | null } | undefined;
        if (
          !pipeline ||
          pipeline.bot_id !== task.botId ||
          (pipeline.group_id !== task.groupId &&
            !this.store.db
              .prepare(
                'SELECT 1 FROM task_conversations c JOIN task_pipeline_bindings b ON b.task_id=c.task_id WHERE b.pipeline_id=? AND c.group_id=?',
              )
              .get(id, task.groupId)) ||
          pipeline.archived_at
        )
          throw new Error('工作管道不存在、已归档或不属于当前 Bot 与对话');
        const unknown = this.store.db
          .prepare(
            "SELECT r.id FROM worker_runs r JOIN task_pipeline_bindings b ON b.task_id=r.task_id WHERE b.pipeline_id=? AND r.status='unknown' AND r.id=(SELECT last.id FROM worker_runs last WHERE last.task_id=r.task_id ORDER BY last.started_at DESC,last.rowid DESC LIMIT 1) LIMIT 1",
          )
          .get(id);
        if (unknown)
          throw new Error('这段工作有尚未核实的执行，请先检查原任务，不能另建任务绕过未知结果');
      } else {
        this.store.db
          .prepare(
            'INSERT INTO task_pipelines(id,bot_id,group_id,title,created_at) VALUES(?,?,?,?,?)',
          )
          .run(id, task.botId, task.groupId, title.slice(0, 500), task.createdAt);
      }
      this.store.db
        .prepare('INSERT INTO task_pipeline_bindings(task_id,pipeline_id) VALUES(?,?)')
        .run(task.id, id);
      return id;
    })();
  }
  session(taskId: string, provider: Provider, bridgeId: string) {
    return this.store.db
      .prepare(
        'SELECT s.thread_id AS threadId FROM task_pipeline_bindings b JOIN pipeline_sessions s ON s.pipeline_id=b.pipeline_id WHERE b.task_id=? AND s.provider=? AND s.bridge_id=?',
      )
      .get(taskId, provider, bridgeId) as { threadId: string } | undefined;
  }
  remember(taskId: string, provider: Provider, bridgeId: string, threadId: string) {
    const binding = this.store.db
      .prepare('SELECT pipeline_id FROM task_pipeline_bindings WHERE task_id=?')
      .get(taskId) as { pipeline_id: string } | undefined;
    if (!binding) return;
    this.store.db
      .prepare(
        'INSERT INTO pipeline_sessions(pipeline_id,provider,bridge_id,thread_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(pipeline_id,provider,bridge_id) DO UPDATE SET thread_id=excluded.thread_id,updated_at=excluded.updated_at',
      )
      .run(binding.pipeline_id, provider, bridgeId, threadId, new Date().toISOString());
  }
  busy(taskId: string) {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT other.task_id FROM task_pipeline_bindings mine JOIN task_pipeline_bindings other ON other.pipeline_id=mine.pipeline_id JOIN tasks t ON t.id=other.task_id WHERE mine.task_id=? AND t.id!=? AND (t.status IN ('running','cancelling','reviewing') OR (SELECT r.status FROM worker_runs r WHERE r.task_id=t.id ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1)='unknown') LIMIT 1",
        )
        .get(taskId, taskId),
    );
  }
}
