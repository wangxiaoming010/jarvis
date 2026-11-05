import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Bot, Group, Message, Snapshot, Task, TaskExecution } from '@openbot/shared';
import { goalSelect, artifactSelect } from './work/work-records.js';
import type { WorkGoal, WorkArtifact } from '@openbot/shared';
export function createStore(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const file of [
    '001_initial.sql',
    '002_runtime.sql',
    '003_dialogue.sql',
    '004_session_delivery.sql',
    '005_ui_documents.sql',
    '006_native_requests.sql',
    '007_device_bindings.sql',
    '008_direct_chats.sql',
    '009_remove_workspace.sql',
    '010_bot_coordinators.sql',
    '011_empty_start.sql',
    '012_bot_attention.sql',
    '013_task_pipelines.sql',
    '014_durable_work.sql',
    '015_work_ownership.sql',
    '016_bot_avatars.sql',
    '017_message_attention_order.sql',
    '018_bot_context.sql',
    '019_memory_curation.sql',
  ]) {
    const hasHistory = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    const version = Number(file.slice(0, 3));
    if (hasHistory && db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version))
      continue;
    db.transaction(() =>
      db.exec(
        readFileSync(
          process.env.OPENBOT_MIGRATIONS_DIR
            ? resolve(process.env.OPENBOT_MIGRATIONS_DIR, file)
            : new URL('../migrations/' + file, import.meta.url),
          'utf8',
        ),
      ),
    )();
  }
  // Presence is ephemeral. Restarting a server must never leave a bot falsely online.
  db.prepare("UPDATE bots SET status='offline'").run();
  db.prepare(
    "UPDATE tasks SET status='failed', error='服务重启，执行连接已中断', finished_at=? WHERE status IN ('running','cancelling')",
  ).run(new Date().toISOString());
  db.prepare("UPDATE task_approvals SET status='cancelled' WHERE status='pending'").run();
  db.prepare("UPDATE native_requests SET status='cancelled' WHERE status='pending'").run();
  db.prepare("UPDATE dialogue_inbox SET status='queued' WHERE status='processing'").run();
  db.prepare(
    "UPDATE worker_runs SET status='unknown',error='服务重启，执行结果尚未核实',finished_at=? WHERE status IN ('running','cancelling')",
  ).run(new Date().toISOString());
  db.prepare("UPDATE task_changes SET status='interrupted' WHERE status='pending'").run();
  db.prepare(
    "UPDATE task_changes SET status='interrupted' WHERE status='ready' AND task_id IN (SELECT id FROM tasks WHERE status='failed')",
  ).run();
  db.prepare(
    "UPDATE routing_decisions SET status='failed',reason='服务重启，未重放历史路由请求' WHERE status='pending'",
  ).run();
  let revision = 0;
  const all = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
  function execution(taskId: string): TaskExecution | undefined {
    const spec = db
      .prepare(
        'SELECT version,executed_version AS executedVersion,goal,context_message_id AS contextMessageId,activity,report,updated_at AS updatedAt FROM task_specs WHERE task_id=?',
      )
      .get(taskId) as Omit<TaskExecution, 'changes' | 'pendingChange'> | undefined;
    if (!spec) return;
    const pending = db
      .prepare(
        "SELECT instruction,status FROM task_changes WHERE task_id=? AND status IN ('pending','interrupted') ORDER BY version DESC LIMIT 1",
      )
      .get(taskId) as TaskExecution['pendingChange'] | undefined;
    const worker = db
      .prepare(
        'SELECT provider,parent_task_id AS parentTaskId,review FROM task_workers WHERE task_id=?',
      )
      .get(taskId) as Pick<TaskExecution, 'provider' | 'parentTaskId' | 'review'> | undefined;
    const pipeline = db
      .prepare(
        'SELECT p.id,p.title FROM task_pipeline_bindings b JOIN task_pipelines p ON p.id=b.pipeline_id WHERE b.task_id=?',
      )
      .get(taskId) as TaskExecution['pipeline'];
    const health = db
      .prepare(
        'SELECT state,detail,last_activity_at AS lastActivityAt,last_heartbeat_at AS lastHeartbeatAt,observed_at AS observedAt FROM task_health WHERE task_id=?',
      )
      .get(taskId) as TaskExecution['health'];
    const contract = db.prepare('SELECT * FROM task_contracts WHERE task_id=?').get(taskId) as
      | {
          criteria: string;
          next_action: string;
          wait_condition: string | null;
          next_wake_at: string | null;
          deadline: string | null;
          max_runs: number;
          state: string;
        }
      | undefined;
    const workspace = db
      .prepare(
        'SELECT w.root,w.path,w.base_commit AS baseCommit,w.review FROM pipeline_workspaces w JOIN task_pipeline_bindings b ON b.pipeline_id=w.pipeline_id WHERE b.task_id=?',
      )
      .get(taskId) as TaskExecution['workspace'];
    return {
      ...spec,
      ...worker,
      pipeline,
      health,
      ...(workspace ? { workspace } : {}),
      ...(contract
        ? {
            contract: {
              criteria: JSON.parse(contract.criteria),
              nextAction: contract.next_action,
              waitCondition: contract.wait_condition,
              nextWakeAt: contract.next_wake_at,
              deadline: contract.deadline,
              maxRuns: contract.max_runs,
              state: contract.state,
            },
          }
        : {}),
      pendingChange: pending ?? null,
      changes: all<TaskExecution['changes'][number]>(
        "SELECT version,instruction,created_at AS createdAt FROM task_changes WHERE task_id=? AND status IN ('ready','accepted') ORDER BY version",
        taskId,
      ),
    };
  }
  function snapshot(): Snapshot {
    return {
      groups: all<Omit<Group, 'botIds' | 'directBotId'> & { directBotId: string | null }>(
        'SELECT g.id, g.name, g.description, g.created_at AS createdAt, d.bot_id AS directBotId FROM groups g LEFT JOIN direct_chats d ON d.group_id=g.id ORDER BY g.created_at',
      ).map(({ directBotId, ...g }) => ({
        ...g,
        ...(directBotId ? { directBotId } : {}),
        botIds: all<{ botId: string }>(
          'SELECT bot_id AS botId FROM group_bots WHERE group_id=?',
          g.id,
        ).map((x) => x.botId),
      })),
      bots: all<Bot & { avatarType: 'emoji' | 'image' | null; avatarValue: string | null }>(
        'SELECT b.id, b.owner_id AS ownerId, b.name, b.description, b.provider, b.status, b.bridge_id AS bridgeId, b.created_at AS createdAt, a.type AS avatarType, a.value AS avatarValue FROM bots b LEFT JOIN bot_avatars a ON a.bot_id=b.id ORDER BY b.created_at',
      ).map(({ avatarType, avatarValue, ...bot }) => ({
        ...bot,
        avatar: avatarType && avatarValue ? { type: avatarType, value: avatarValue } : null,
      })),
      messages: all<Omit<Message, 'mentions'> & { mentions: string }>(
        'SELECT id, group_id AS groupId, sender_id AS senderId, sender_type AS senderType, content, mentions, reply_to AS replyTo, timestamp, message_type AS messageType, correlation_id AS correlationId FROM messages ORDER BY timestamp, rowid',
      ).map((m) => {
        const native = db
          .prepare('SELECT id,task_id,spec,status,response FROM native_requests WHERE message_id=?')
          .get(m.id) as
          | {
              id: string;
              task_id: string;
              spec: string;
              status: 'pending' | 'answered' | 'cancelled';
              response: string | null;
            }
          | undefined;
        const card = db
          .prepare('SELECT document,status,response FROM ui_documents WHERE message_id=?')
          .get(m.id) as
          | {
              document: string;
              status: NonNullable<Message['ui']>['status'];
              response: string | null;
            }
          | undefined;
        return {
          ...m,
          ...(native
            ? {
                nativeRequest: {
                  ...JSON.parse(native.spec),
                  id: native.id,
                  taskId: native.task_id,
                  status: native.status,
                  response: native.response ? JSON.parse(native.response) : null,
                },
              }
            : {}),
          mentions: JSON.parse(m.mentions),
          ...(card
            ? {
                ui: {
                  document: JSON.parse(card.document),
                  status: card.status,
                  response: card.response,
                },
              }
            : {}),
        };
      }),
      tasks: all<Task>(
        'SELECT t.id,t.goal_id AS goalId, COALESCE(r.group_id,t.group_id) AS groupId, t.group_id AS originGroupId, bot_id AS botId, input, status, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, result, error, correlation_id AS correlationId, round FROM tasks t LEFT JOIN task_routes r ON r.task_id=t.id ORDER BY created_at',
      ).map((t) => ({ ...t, execution: execution(t.id) })),
      goals: all<Omit<WorkGoal, 'criteria'> & { criteria: string }>(
        `${goalSelect} ORDER BY created_at`,
      ).map((g) => ({ ...g, criteria: JSON.parse(g.criteria) })),
      artifacts: all<WorkArtifact>(`${artifactSelect} ORDER BY created_at`),
      projects: all<{ id: string; name: string }>('SELECT id,name FROM work_projects').map((p) => ({
        ...p,
        groupIds: all<{ group_id: string }>(
          'SELECT group_id FROM project_groups WHERE project_id=?',
          p.id,
        ).map((g) => g.group_id),
      })),
      conversations: all(
        "SELECT DISTINCT bot_id AS botId,group_id AS groupId,status FROM dialogue_inbox WHERE status IN ('queued','processing')",
      ),
      dialogueFailures: all(
        "SELECT i.bot_id AS botId,i.group_id AS groupId,i.source_message_id AS messageId,COALESCE(t.error,a.error,'回复模型暂不可用，请检查模型设置') AS error,CASE WHEN t.id IS NULL AND a.status='failed' THEN 'attention' ELSE 'dialogue' END AS stage FROM dialogue_inbox i JOIN group_bots g ON g.group_id=i.group_id AND g.bot_id=i.bot_id JOIN messages m ON m.id=i.source_message_id LEFT JOIN coordinator_turns t ON t.inbox_id=i.id LEFT JOIN attention_decisions a ON a.inbox_id=i.id WHERE i.status='failed' AND i.kind='message' AND m.sender_type IN ('human','bot')",
      ),
      approvals: all<Omit<import('@openbot/shared').Approval, 'detail'> & { detail: string }>(
        'SELECT id,task_id AS taskId,kind,detail,status,created_at AS createdAt FROM task_approvals ORDER BY created_at',
      ).map((a) => ({ ...a, detail: JSON.parse(a.detail) })),
      user: { id: 'user_local', name: '我' },
      revision,
    };
  }
  function insertMessage(m: Message) {
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      m.id,
      m.groupId,
      m.senderId,
      m.senderType,
      m.content,
      JSON.stringify(m.mentions),
      m.replyTo,
      m.timestamp,
      m.messageType,
      m.correlationId,
    );
  }
  return { db, snapshot, insertMessage, changed: () => ++revision, id: randomUUID };
}
export type Store = ReturnType<typeof createStore>;
