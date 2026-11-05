import { createHash } from 'node:crypto';
import { resolveMentions, type Group, type Message, type Snapshot } from '@openbot/shared';
import type { Store } from '../store.js';
import { memoryTerms } from '../memory/bot-memory.js';
import { isSilenceNarration } from './conversation-output.js';

/** One Bot's conversation knowledge, independent of the window it is speaking in. */
export class BotConversations {
  constructor(private store: Store) {}

  group(botId: string, groupId: string) {
    const group = this.store.snapshot().groups.find((g) => g.id === groupId);
    if (!group?.botIds.includes(botId)) throw new Error('只能访问自己所在的对话');
    return group;
  }

  private describe(message: Message, s = this.store.snapshot()) {
    return {
      ...message,
      actor: {
        id: message.senderId,
        type: message.senderType,
        name:
          message.senderType === 'human'
            ? s.user.name
            : (s.bots.find((b) => b.id === message.senderId)?.name ?? '系统'),
      },
    };
  }

  list(botId: string) {
    const s = this.store.snapshot();
    const observedAt = new Date().toISOString();
    return s.groups
      .filter((g) => g.botIds.includes(botId))
      .map((g) => this.describeGroup(botId, g, s, observedAt));
  }

  self(botId: string) {
    const s = this.store.snapshot();
    const bot = s.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Bot 不存在');
    const observedAt = new Date().toISOString();
    return {
      observedAt,
      id: bot.id,
      name: bot.name,
      description: bot.description,
      executionTool: bot.provider,
      executionStatus: bot.status,
      createdAt: bot.createdAt,
      conversations: s.groups
        .filter((g) => g.botIds.includes(botId))
        .map((g) => this.describeGroup(botId, g, s, observedAt)),
    };
  }

  info(botId: string, groupId: string) {
    const group = this.group(botId, groupId);
    return this.describeGroup(botId, group, this.store.snapshot(), new Date().toISOString());
  }

  private describeGroup(botId: string, g: Group, s: Snapshot, observedAt: string) {
    return {
      observedAt,
      groupId: g.id,
      name: g.name,
      description: g.description,
      direct: Boolean(g.directBotId),
      createdAt: g.createdAt,
      participants: [
        { id: s.user.id, type: 'human', name: s.user.name, role: 'owner' },
        ...s.bots
          .filter((b) => g.botIds.includes(b.id))
          .map((b) => ({
            id: b.id,
            type: 'bot',
            name: b.name,
            role: b.description,
            executionTool: b.provider,
            executionStatus: b.status,
          })),
      ],
      messageCount: s.messages.filter((m) => m.groupId === g.id).length,
      myTasks: s.tasks
        .filter((t) => t.botId === botId && t.groupId === g.id)
        .slice(-6)
        .map((t) => ({ id: t.id, goal: t.execution?.goal ?? t.input, status: t.status })),
    };
  }

  read(botId: string, groupId: string, beforeMessageId?: string, limit = 20) {
    const group = this.group(botId, groupId);
    const s = this.store.snapshot();
    const all = s.messages.filter((m) => m.groupId === groupId);
    const end = beforeMessageId ? all.findIndex((m) => m.id === beforeMessageId) : all.length;
    if (end < 0) throw new Error('翻页引用不在目标对话');
    const start = Math.max(0, end - limit);
    return {
      groupId,
      name: group.name,
      messages: all.slice(start, end).map((m) => ({
        ...this.describe(m, s),
        content: m.content.slice(0, 1800),
        length: m.content.length,
      })),
      nextBeforeMessageId: start > 0 ? all[start].id : null,
    };
  }

  message(botId: string, messageId: string) {
    const message = this.store.snapshot().messages.find((m) => m.id === messageId);
    if (!message) throw new Error('消息不存在');
    this.group(botId, message.groupId);
    return this.describe(message);
  }

  search(
    botId: string,
    query: string,
    groupId?: string,
    offset = 0,
    limit = 20,
    excludeGroupId?: string,
  ) {
    if (groupId) this.group(botId, groupId);
    const s = this.store.snapshot();
    const groups = s.groups.filter(
      (g) => g.botIds.includes(botId) && (!groupId || g.id === groupId) && g.id !== excludeGroupId,
    );
    const ids = new Set(groups.map((g) => g.id));
    const terms = memoryTerms(query);
    const matches = s.messages
      .filter((m) => ids.has(m.groupId))
      .map((m, index) => ({
        m,
        index,
        score: terms.reduce((n, term) => n + (m.content.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((r) => !terms.length || r.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index);
    return {
      messages: matches.slice(offset, offset + limit).map(({ m }) => ({
        ...this.describe(m, s),
        groupName: groups.find((g) => g.id === m.groupId)!.name,
        content: m.content.slice(0, 1800),
        length: m.content.length,
      })),
      nextOffset: offset + limit < matches.length ? offset + limit : null,
    };
  }

  send(
    botId: string,
    source: Message,
    groupId: string,
    content: string,
    mentionBotIds: string[],
    replyTo: string | null = null,
    notifyMentions = true,
  ) {
    if (isSilenceNarration(content))
      throw new Error('不发言的判断无需发布，请调用 stay_silent 结束本轮');
    const group = this.group(botId, groupId);
    const s = this.store.snapshot();
    const members = s.bots.filter((b) => group.botIds.includes(b.id));
    if (replyTo && !s.messages.some((m) => m.id === replyTo && m.groupId === groupId))
      throw new Error('引用消息不在目标对话中');
    const mentions = notifyMentions
      ? [...new Set([...mentionBotIds, ...resolveMentions(content, s.bots)])]
      : [];
    if (mentions.some((id) => id === botId || !group.botIds.includes(id)))
      throw new Error('提及对象必须是目标对话中的其他成员');
    const resolved = new Set(resolveMentions(content, members));
    const missing = mentions
      .filter((id) => !resolved.has(id))
      .map((id) => `@${members.find((b) => b.id === id)!.name}`);
    const body = [...missing, content].join(' ');
    // Stable across model retries and recovery, even if a new tool-call id is used.
    const id = `relay_${createHash('sha256')
      .update(
        JSON.stringify([
          botId,
          source.id,
          groupId,
          body,
          [...mentions].sort(),
          ...(replyTo ? [replyTo] : []),
        ]),
      )
      .digest('hex')}`;
    const existing = s.messages.find((m) => m.id === id);
    if (existing) return { message: existing, created: false };
    const message: Message = {
      id,
      groupId,
      senderId: botId,
      senderType: 'bot',
      content: body,
      mentions,
      replyTo,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: source.correlationId,
    };
    this.store.insertMessage(message);
    return { message, created: true };
  }
}
