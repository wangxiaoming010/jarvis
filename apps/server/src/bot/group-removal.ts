import type { Store } from '../store.js';

/** Remove an idle group atomically, preserving Bot identities and Bot-scoped memory. */
export function removeGroup(store: Store, id: string) {
  const db = store.db;
  return db.transaction(() => {
    const group = db.prepare('SELECT id FROM groups WHERE id=?').get(id);
    const fail = (statusCode: number, message: string): never => {
      throw Object.assign(new Error(message), { statusCode });
    };
    if (!group) fail(404, '群组不存在');
    if (db.prepare('SELECT 1 FROM direct_chats WHERE group_id=?').get(id))
      fail(409, '单独聊天不能通过删除群组移除');
    if (
      db
        .prepare(
          "SELECT 1 FROM work_goals WHERE group_id=? AND legacy=0 AND state NOT IN ('completed','cancelled') LIMIT 1",
        )
        .get(id)
    )
      fail(409, '群内还有持续负责的目标，请先接续到其他对话或停止目标后再删除');
    if (
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE (group_id=? OR id IN (SELECT task_id FROM task_conversations WHERE group_id=?)) AND status IN ('queued','running','cancelling','reviewing') LIMIT 1",
        )
        .get(id, id)
    )
      fail(409, '群内还有正在处理的任务，请先停止任务后再删除群组');
    if (
      db
        .prepare("SELECT 1 FROM dialogue_inbox WHERE group_id=? AND status='processing' LIMIT 1")
        .get(id) ||
      db
        .prepare(
          "SELECT 1 FROM routing_decisions WHERE message_id IN (SELECT id FROM messages WHERE group_id=?) AND status='pending' LIMIT 1",
        )
        .get(id)
    )
      fail(409, 'Bot 正在处理群内消息，请稍后再删除群组');

    // A conversation may be deleted without destroying work explicitly linked elsewhere.
    const retained = db
      .prepare(
        'SELECT DISTINCT t.id FROM tasks t JOIN task_conversations c ON c.task_id=t.id WHERE t.group_id=? AND c.group_id!=?',
      )
      .all(id, id) as { id: string }[];
    for (const task of retained) {
      const link = db
        .prepare(
          'SELECT group_id,source_message_id FROM task_conversations WHERE task_id=? AND group_id!=? AND source_message_id IS NOT NULL ORDER BY linked_at DESC LIMIT 1',
        )
        .get(task.id, id) as { group_id: string; source_message_id: string } | undefined;
      if (!link) fail(409, '关联的工作仍需保留来源，请先在其他对话接续后再删除');
      db.prepare('UPDATE tasks SET group_id=? WHERE id=?').run(link!.group_id, task.id);
      db.prepare(
        'UPDATE task_routes SET group_id=?,source_message_id=? WHERE task_id=? AND group_id=?',
      ).run(link!.group_id, link!.source_message_id, task.id, id);
      db.prepare(
        'UPDATE task_runtime SET source_message_id=? WHERE task_id=? AND source_message_id IN (SELECT id FROM messages WHERE group_id=?)',
      ).run(link!.source_message_id, task.id, id);
      db.prepare(
        'UPDATE task_specs SET context_message_id=? WHERE task_id=? AND context_message_id IN (SELECT id FROM messages WHERE group_id=?)',
      ).run(link!.source_message_id, task.id, id);
    }
    const routes = db
      .prepare(
        'SELECT task_id FROM task_routes WHERE group_id=? AND task_id IN (SELECT id FROM tasks WHERE group_id!=?)',
      )
      .all(id, id) as { task_id: string }[];
    for (const route of routes) {
      const link = db
        .prepare(
          'SELECT group_id,source_message_id FROM task_conversations WHERE task_id=? AND group_id!=? AND source_message_id IS NOT NULL ORDER BY linked_at DESC LIMIT 1',
        )
        .get(route.task_id, id) as { group_id: string; source_message_id: string } | undefined;
      if (!link) fail(409, '关联的工作没有其他可用对话，请先接续后再删除');
      db.prepare('UPDATE task_routes SET group_id=?,source_message_id=? WHERE task_id=?').run(
        link!.group_id,
        link!.source_message_id,
        route.task_id,
      );
      db.prepare('UPDATE task_runtime SET source_message_id=? WHERE task_id=?').run(
        link!.source_message_id,
        route.task_id,
      );
    }
    db.prepare(
      'UPDATE task_changes SET source_message_id=NULL WHERE source_message_id IN (SELECT id FROM messages WHERE group_id=?)',
    ).run(id);
    db.prepare('DELETE FROM bot_delegations WHERE group_id=?').run(id);
    db.prepare(
      'DELETE FROM native_requests WHERE message_id IN (SELECT id FROM messages WHERE group_id=?)',
    ).run(id);
    const keptPipelines = db
      .prepare(
        'SELECT DISTINCT p.id,t.group_id FROM task_pipelines p JOIN task_pipeline_bindings b ON b.pipeline_id=p.id JOIN tasks t ON t.id=b.task_id WHERE p.group_id=? AND t.group_id!=?',
      )
      .all(id, id) as { id: string; group_id: string }[];
    for (const p of keptPipelines)
      db.prepare('UPDATE task_pipelines SET group_id=? WHERE id=?').run(p.group_id, p.id);

    // Delete children before parents, with foreign keys enabled throughout.
    db.prepare(
      'DELETE FROM coordinator_calls WHERE turn_id IN (SELECT c.id FROM coordinator_turns c JOIN dialogue_inbox i ON i.id=c.inbox_id WHERE i.group_id=?)',
    ).run(id);
    db.prepare(
      'DELETE FROM coordinator_turns WHERE inbox_id IN (SELECT id FROM dialogue_inbox WHERE group_id=?)',
    ).run(id);
    db.prepare('DELETE FROM dialogue_inbox WHERE group_id=?').run(id); // attention rows cascade
    db.prepare(
      'DELETE FROM ui_actions WHERE message_id IN (SELECT message_id FROM ui_documents WHERE group_id=?)',
    ).run(id);
    db.prepare('DELETE FROM ui_documents WHERE group_id=?').run(id);
    db.prepare(
      'DELETE FROM native_requests WHERE task_id IN (SELECT id FROM tasks WHERE group_id=?)',
    ).run(id);
    for (const table of [
      'worker_reports',
      'task_health',
      'worker_runs',
      'task_approvals',
      'task_changes',
      'task_session_delivery',
      'task_specs',
      'task_runtime',
      'task_workers',
      'task_pipeline_bindings',
    ])
      db.prepare(
        `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE group_id=?)`,
      ).run(id);
    db.prepare(
      'DELETE FROM pipeline_sessions WHERE pipeline_id IN (SELECT id FROM task_pipelines WHERE group_id=?)',
    ).run(id);
    db.prepare(
      'DELETE FROM pipeline_workspaces WHERE pipeline_id IN (SELECT id FROM task_pipelines WHERE group_id=?)',
    ).run(id);
    db.prepare('DELETE FROM task_pipelines WHERE group_id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE group_id=?').run(id);
    db.prepare('DELETE FROM work_goals WHERE group_id=?').run(id);
    db.prepare('DELETE FROM conversation_memory WHERE group_id=?').run(id);
    db.prepare('DELETE FROM agent_sessions WHERE group_id=?').run(id);
    db.prepare('DELETE FROM bot_memory WHERE group_id=?').run(id);
    // A Bot keeps its own durable facts after leaving a group; remove only the deleted source reference.
    db.prepare(
      'UPDATE bot_memory SET source_message_id=NULL WHERE source_message_id IN (SELECT id FROM messages WHERE group_id=?)',
    ).run(id);
    db.prepare(
      'DELETE FROM routing_decisions WHERE message_id IN (SELECT id FROM messages WHERE group_id=?)',
    ).run(id);
    db.prepare('DELETE FROM messages WHERE group_id=?').run(id);
    db.prepare('DELETE FROM groups WHERE id=?').run(id); // membership rows cascade
    return { ok: true, id };
  })();
}
