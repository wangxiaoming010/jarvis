import type { Bot, Message, Provider, WorkArtifact } from '@openbot/shared';
import type { Store } from '../store.js';
import { BotConversations } from './bot-conversations.js';
import { removeGroup } from './group-removal.js';
import { WorkArtifacts } from '../work/work-artifacts.js';
import { artifactSelect } from '../work/work-records.js';

type Args = Record<string, unknown>;
const observedAt = () => new Date().toISOString();
const matches = (query: unknown, ...values: string[]) =>
  !query || values.join(' ').toLocaleLowerCase().includes(String(query).toLocaleLowerCase());
export function toolPage<T>(items: T[], args: Args) {
  const offset = (args.offset as number | undefined) ?? 0;
  const limit = (args.limit as number | undefined) ?? 20;
  return {
    observedAt: observedAt(),
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

/** Host-bound social operations. Caller validates schemas and fresh owner authorization. */
export class BotWorkspace {
  private conversations: BotConversations;
  constructor(private store: Store) {
    this.conversations = new BotConversations(store);
  }

  private ordinary(groupId: string) {
    const group = this.store.snapshot().groups.find((g) => g.id === groupId);
    if (!group || group.directBotId) throw new Error('只能操作普通群组，群组不存在或不可用');
    return group;
  }
  private profile(actorId: string, bot: Bot) {
    return {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      avatar: bot.avatar?.type === 'emoji' ? bot.avatar : null,
      hasImageAvatar: bot.avatar?.type === 'image',
      executionTool: bot.provider,
      executionStatus: bot.status,
      createdAt: bot.createdAt,
      sharedGroupIds: this.store
        .snapshot()
        .groups.filter((g) => g.botIds.includes(actorId) && g.botIds.includes(bot.id))
        .map((g) => g.id),
    };
  }
  private assertIdleMember(botId: string, groupId: string) {
    const db = this.store.db;
    if (
      db
        .prepare(
          "SELECT 1 FROM work_goals WHERE bot_id=? AND group_id=? AND state NOT IN ('completed','cancelled') LIMIT 1",
        )
        .get(botId, groupId)
    )
      throw new Error('该 Bot 在群内仍有负责的目标，请先停止或接续到其他对话');
    if (
      db
        .prepare(
          "SELECT 1 FROM tasks t LEFT JOIN task_routes r ON r.task_id=t.id WHERE t.bot_id=? AND (t.group_id=? OR r.group_id=? OR EXISTS(SELECT 1 FROM task_conversations c WHERE c.task_id=t.id AND c.group_id=?)) AND t.status IN ('queued','running','cancelling','reviewing') LIMIT 1",
        )
        .get(botId, groupId, groupId, groupId)
    )
      throw new Error('该 Bot 在群内仍有正在处理的任务，请先停止或接续');
    if (
      db
        .prepare(
          "SELECT 1 FROM bot_delegations WHERE group_id=? AND (source_bot_id=? OR target_bot_id=?) AND state IN ('offered','accepted','submitted') LIMIT 1",
        )
        .get(groupId, botId, botId)
    )
      throw new Error('该 Bot 在群内仍有未结束的委托，请先处理');
  }
  private memory(botId: string, memoryId: string) {
    const memory = this.store.db
      .prepare(
        `SELECT id,key,content,scope,group_id AS groupId,
      source_message_id AS sourceMessageId,updated_at AS updatedAt,provenance,importance,
      expires_at AS expiresAt,state FROM bot_memory WHERE id=? AND bot_id=? AND
      (scope='bot' OR group_id IN (SELECT group_id FROM group_bots WHERE bot_id=?))`,
      )
      .get(memoryId, botId, botId);
    if (!memory) throw new Error('记忆不存在或不属于当前范围');
    return memory;
  }

  execute(name: string, args: Args, botId: string, source: Message, providers: Provider[]) {
    return this.store.db.transaction(() => this.perform(name, args, botId, source, providers))();
  }

  private perform(name: string, args: Args, botId: string, source: Message, providers: Provider[]) {
    const s = this.store.snapshot();
    const actor = s.bots.find((b) => b.id === botId);
    if (!actor) throw new Error('Bot 不存在');
    const groupId = args.groupId as string;
    if (name === 'discover_groups')
      return toolPage(
        s.groups
          .filter((g) => !g.directBotId && matches(args.query, g.id, g.name, g.description))
          .map((g) => ({
            groupId: g.id,
            name: g.name,
            description: g.description,
            joined: g.botIds.includes(botId),
            memberCount: g.botIds.length + 1,
            createdAt: g.createdAt,
          })),
        args,
      );
    if (name === 'list_bots')
      return toolPage(
        s.bots
          .filter((b) => matches(args.query, b.id, b.name, b.description))
          .map((b) => this.profile(botId, b)),
        args,
      );
    if (name === 'get_bot') {
      const bot = s.bots.find((b) => b.id === args.botId);
      if (!bot) throw new Error('Bot 不存在');
      return { observedAt: observedAt(), ...this.profile(botId, bot) };
    }
    if (name === 'list_members')
      return toolPage(
        this.conversations
          .info(botId, groupId)
          .participants.filter((p) => matches(args.query, p.id, p.name, p.role)),
        args,
      );
    if (name === 'get_conversation_activity') {
      this.conversations.group(botId, groupId);
      const messages = s.messages.filter((m) => m.groupId === groupId);
      return {
        observedAt: observedAt(),
        groupId,
        messageCount: messages.length,
        latestMessage: messages.at(-1)
          ? { id: messages.at(-1)!.id, timestamp: messages.at(-1)!.timestamp }
          : null,
        speakers: [...new Set(messages.map((m) => m.senderId))].map((id) => ({
          id,
          count: messages.filter((m) => m.senderId === id).length,
        })),
        myTasks: s.tasks
          .filter((t) => t.botId === botId && t.groupId === groupId)
          .map((t) => ({ id: t.id, status: t.status })),
        myGoals: this.store.db
          .prepare('SELECT id,title,state FROM work_goals WHERE bot_id=? AND group_id=?')
          .all(botId, groupId),
      };
    }
    if (name === 'read_thread' || name === 'get_message_context') {
      const message = this.conversations.message(botId, args.messageId as string);
      const all = s.messages.filter((m) => m.groupId === message.groupId);
      let messages: Message[];
      if (name === 'read_thread') {
        const ids = new Set([message.id]);
        // Iterate to a fixed point so imported messages need not be ordered parent-first.
        for (let previous = -1; previous !== ids.size;) {
          previous = ids.size;
          for (const m of all) if (m.replyTo && ids.has(m.replyTo)) ids.add(m.id);
        }
        messages = all.filter((m) => ids.has(m.id));
      } else {
        const index = all.findIndex((m) => m.id === message.id),
          radius = (args.radius as number | undefined) ?? 3;
        messages = all.slice(Math.max(0, index - radius), index + radius + 1);
      }
      return {
        groupId: message.groupId,
        ...toolPage(
          messages.map((m) => ({
            id: m.id,
            senderId: m.senderId,
            senderType: m.senderType,
            timestamp: m.timestamp,
            replyTo: m.replyTo,
            content: m.content.slice(0, 1800),
            length: m.content.length,
          })),
          args,
        ),
      };
    }
    if (name === 'get_execution_status')
      return {
        observedAt: observedAt(),
        botId,
        executionTool: actor.provider,
        executionStatus: actor.status,
        availableTools: providers,
        activeTasks: s.tasks
          .filter(
            (t) =>
              t.botId === botId &&
              ['queued', 'running', 'cancelling', 'reviewing'].includes(t.status),
          )
          .filter((t) => s.groups.some((g) => g.id === t.groupId && g.botIds.includes(botId)))
          .map((t) => ({ id: t.id, groupId: t.groupId, status: t.status })),
      };
    if (name === 'get_current_time') {
      const now = new Date(),
        timeZone = (args.timeZone as string | undefined) ?? 'UTC';
      try {
        return {
          observedAt: now.toISOString(),
          timeZone,
          localTime: new Intl.DateTimeFormat('sv-SE', {
            timeZone,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(now),
          epochMilliseconds: now.getTime(),
        };
      } catch {
        throw new Error('时区无效，请使用 IANA 时区，如 Asia/Shanghai');
      }
    }
    if (name === 'create_group') {
      const ids = [...new Set([botId, ...(args.botIds as string[])])];
      if (ids.some((id) => !s.bots.some((b) => b.id === id))) throw new Error('Bot 不存在');
      const id = this.store.id();
      this.store.db
        .prepare('INSERT INTO groups VALUES(?,?,?,?)')
        .run(id, args.name as string, args.description as string, observedAt());
      for (const member of ids)
        this.store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run(id, member);
      return { created: true, ...this.conversations.info(botId, id) };
    }
    if (
      [
        'update_group',
        'join_group',
        'leave_group',
        'invite_bot',
        'remove_bot',
        'delete_group',
      ].includes(name)
    ) {
      const group = this.ordinary(groupId);
      if (name !== 'join_group') this.conversations.group(botId, groupId);
      if (name === 'join_group' || name === 'invite_bot') {
        const target = name === 'join_group' ? botId : (args.botId as string);
        if (!s.bots.some((b) => b.id === target)) throw new Error('Bot 不存在');
        const alreadyJoined = group.botIds.includes(target);
        if (!alreadyJoined && group.botIds.length >= 32) throw new Error('群组最多加入 32 个 Bot');
        this.store.db.prepare('INSERT OR IGNORE INTO group_bots VALUES(?,?)').run(groupId, target);
        return {
          joined: true,
          alreadyJoined,
          botId: target,
          ...this.conversations.info(botId, groupId),
        };
      }
      if (name === 'update_group') {
        this.store.db
          .prepare('UPDATE groups SET name=?,description=? WHERE id=?')
          .run(
            (args.name as string | undefined) ?? group.name,
            (args.description as string | undefined) ?? group.description,
            groupId,
          );
        return this.conversations.info(botId, groupId);
      }
      if (name === 'delete_group') {
        if (groupId === source.groupId)
          throw new Error('不能在当前正在处理的群组中删群，请在其他已加入对话中提出');
        return removeGroup(this.store, groupId);
      }
      const target = name === 'leave_group' ? botId : (args.botId as string);
      if (name === 'remove_bot' && target === botId) throw new Error('移除自己请使用 leave_group');
      if (!s.bots.some((b) => b.id === target)) throw new Error('Bot 不存在');
      this.assertIdleMember(target, groupId);
      const removed =
        this.store.db
          .prepare('DELETE FROM group_bots WHERE group_id=? AND bot_id=?')
          .run(groupId, target).changes > 0;
      return {
        observedAt: observedAt(),
        groupId,
        botId: target,
        left: true,
        changed: removed,
        endTurn: target === botId && groupId === source.groupId,
      };
    }
    if (name === 'update_self') {
      const name = (args.name as string | undefined) ?? actor.name;
      if (s.bots.some((b) => b.id !== botId && b.name.toLowerCase() === name.toLowerCase()))
        throw new Error('Bot 名称已被使用');
      this.store.db
        .prepare('UPDATE bots SET name=?,description=? WHERE id=?')
        .run(name, (args.description as string | undefined) ?? actor.description, botId);
      return this.conversations.self(botId);
    }
    if (name === 'set_avatar') {
      const avatar = args.avatar as Bot['avatar'];
      if (avatar)
        this.store.db
          .prepare(
            'INSERT INTO bot_avatars VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET type=excluded.type,value=excluded.value',
          )
          .run(botId, avatar.type, avatar.value);
      else this.store.db.prepare('DELETE FROM bot_avatars WHERE bot_id=?').run(botId);
      return { observedAt: observedAt(), botId, avatarType: avatar?.type ?? 'default' };
    }
    if (name === 'list_memories') {
      if (groupId) this.conversations.group(botId, groupId);
      const rows = this.store.db
        .prepare(
          `SELECT id,key,content,scope,group_id AS groupId,
        source_message_id AS sourceMessageId,updated_at AS updatedAt,provenance,importance,expires_at AS expiresAt
        FROM bot_memory WHERE bot_id=? AND state='active' AND (expires_at IS NULL OR expires_at>?)
        AND (scope='bot' OR group_id IN (SELECT group_id FROM group_bots WHERE bot_id=? AND (? IS NULL OR group_id=?))) ORDER BY updated_at DESC,id`,
        )
        .all(botId, observedAt(), botId, groupId ?? null, groupId ?? null) as {
        key: string;
        content: string;
      }[];
      return toolPage(
        rows.filter((m) => matches(args.query, m.key, m.content)),
        args,
      );
    }
    if (name === 'read_memory') {
      const memory = this.memory(botId, args.memoryId as string);
      const revisions = this.store.db
        .prepare(
          'SELECT content,source_message_id AS sourceMessageId,provenance,reason,created_at AS createdAt FROM bot_memory_revisions WHERE memory_id=? ORDER BY created_at DESC,id',
        )
        .all(args.memoryId as string);
      return { memory, revisions: toolPage(revisions, args) };
    }
    if (name === 'list_projects') {
      if (groupId) this.conversations.group(botId, groupId);
      const rows = this.store.db
        .prepare(
          `SELECT p.id,p.name,p.created_at AS createdAt,pg.group_id AS groupId
        FROM work_projects p JOIN project_groups pg ON pg.project_id=p.id
        JOIN group_bots b ON b.group_id=pg.group_id WHERE b.bot_id=? AND (? IS NULL OR pg.group_id=?) ORDER BY p.created_at DESC,p.id,pg.group_id`,
        )
        .all(botId, groupId ?? null, groupId ?? null) as {
        id: string;
        name: string;
        groupId: string;
        createdAt: string;
      }[];
      const projects = new Map<
        string,
        { id: string; name: string; createdAt: string; groupIds: string[] }
      >();
      for (const row of rows) {
        const item = projects.get(row.id) ?? {
          id: row.id,
          name: row.name,
          createdAt: row.createdAt,
          groupIds: [],
        };
        item.groupIds.push(row.groupId);
        projects.set(row.id, item);
      }
      return toolPage(
        [...projects.values()].filter((p) => matches(args.query, p.id, p.name)),
        args,
      );
    }
    if (name === 'list_artifacts') {
      const target = groupId ?? source.groupId;
      // The existing read_artifact tool is scoped to the current conversation too.
      if (target !== source.groupId) throw new Error('请在目标对话查询交付物');
      this.conversations.group(botId, target);
      const artifacts = new WorkArtifacts(this.store);
      const rows = this.store.db
        .prepare(`${artifactSelect} ORDER BY updated_at DESC,id`)
        .all() as WorkArtifact[];
      return toolPage(
        rows
          .filter((a) => {
            try {
              artifacts.canRead(a, botId, target);
              return matches(args.query, a.id, a.title);
            } catch {
              return false;
            }
          })
          .map((a) => ({
            id: a.id,
            goalId: a.goalId,
            title: a.title,
            kind: a.kind,
            version: a.version,
            state: a.state,
          })),
        args,
      );
    }
    if (name === 'list_delegations') {
      if (groupId) this.conversations.group(botId, groupId);
      return toolPage(
        this.store.db
          .prepare(
            `SELECT d.id,d.group_id AS groupId,d.source_bot_id AS sourceBotId,
        d.target_bot_id AS targetBotId,d.goal_id AS goalId,d.child_goal_id AS childGoalId,d.goal,d.state,d.expires_at AS expiresAt
        FROM bot_delegations d JOIN group_bots b ON b.group_id=d.group_id
        WHERE b.bot_id=? AND (d.source_bot_id=? OR d.target_bot_id=?) AND (? IS NULL OR d.group_id=?) ORDER BY d.created_at DESC,d.id`,
          )
          .all(botId, botId, botId, groupId ?? null, groupId ?? null),
        args,
      );
    }
    throw new Error('未知工作区工具');
  }
}
