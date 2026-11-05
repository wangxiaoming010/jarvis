import { createHash } from 'node:crypto';
import {
  coordinatorTools,
  type ContextSummarizer,
  type CoordinatorMessage,
} from '../models/coordinator-model.js';
import type { Store } from '../store.js';
import { isSilenceNarration } from './conversation-output.js';

// A conservative estimate for mixed Chinese, English, JSON and code, not a model tokenizer.
export const estimateContextTokens = (value: unknown) =>
  Math.ceil(
    Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2.5,
  );
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function preview(value: string, length: number) {
  if (value.length <= length) return value;
  const half = Math.max(0, Math.floor((length - 60) / 2));
  return `${value.slice(0, half)}\n[excerpt only; read original source for omitted details]\n${value.slice(-half || value.length)}`;
}
type Summary = { summary: string; method: 'model' | 'extractive' };
type Scope = { botId: string; groupId: string; sourceMessageId: string; messageEvent: boolean };
export interface ContextOptions {
  windowTokens?: number;
  reserveTokens?: number;
  toolTokens?: number;
  historyTriggerTokens?: number;
}

/** Builds bounded model views. Never replaces original history or committed tool receipts. */
export class BotContext {
  readonly inputBudget: number;
  readonly toolTokens: number;
  private historyTrigger: number;
  constructor(
    private store: Store,
    private summarize?: ContextSummarizer,
    options: ContextOptions = {},
  ) {
    const window = options.windowTokens ?? Number(process.env.OPENBOT_CONTEXT_TOKENS ?? 65536);
    this.inputBudget = window - (options.reserveTokens ?? 10240);
    this.toolTokens = options.toolTokens ?? estimateContextTokens(coordinatorTools);
    if (!Number.isSafeInteger(window) || this.inputBudget <= this.toolTokens + 1024)
      throw new Error('上下文容量不足以容纳工具和回答预留空间');
    this.historyTrigger = options.historyTriggerTokens ?? 2000;
  }

  private check(scope: Pick<Scope, 'botId' | 'groupId'>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      !this.store.db
        .prepare('SELECT 1 FROM group_bots WHERE bot_id=? AND group_id=?')
        .get(scope.botId, scope.groupId)
    )
      throw new Error('只能处理自己所在对话的上下文');
  }

  private async note(previous: string, records: unknown[], signal: AbortSignal): Promise<Summary> {
    signal.throwIfAborted();
    let allowance = Math.max(80, Math.floor(14000 / Math.max(1, records.length)));
    const describe = () =>
      records.map((record) => {
        const raw = JSON.stringify(record);
        const source = record as Record<string, unknown>;
        return {
          ref: {
            id: source.id,
            groupId: source.groupId,
            senderId: source.senderId,
            senderType: source.senderType,
            role: source.role,
            callId: source.tool_call_id,
          },
          excerpt: preview(raw, allowance),
          originalLength: raw.length,
        };
      });
    let excerpts = describe();
    let input = JSON.stringify({ previousSummary: previous, sources: excerpts });
    while (estimateContextTokens(input) >= 12000 && allowance > 80) {
      allowance = Math.max(80, Math.floor(allowance * 0.7));
      excerpts = describe();
      input = JSON.stringify({ previousSummary: previous, sources: excerpts });
    }
    if (this.summarize && estimateContextTokens(input) < 12000) {
      try {
        const summary = await this.summarize(input, signal);
        signal.throwIfAborted();
        if (summary.trim() && summary.length <= 6000 && estimateContextTokens(summary) <= 2400)
          return { summary: summary.trim(), method: 'model' };
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    // An unavailable model must not block useful work or silently invent a semantic summary.
    const summary = `[Extractive fallback, incomplete; retrieve original sources before relying on details.]\n${preview(previous, 1200)}\n${preview(JSON.stringify(excerpts), 2600)}`;
    return { summary, method: 'extractive' };
  }

  private historySources(scope: Scope) {
    const all = this.store.snapshot().messages.filter((m) => m.groupId === scope.groupId);
    const end = scope.messageEvent
      ? all.findIndex((m) => m.id === scope.sourceMessageId) + 1
      : all.length;
    return all
      .slice(0, Math.max(0, end - 12))
      .filter((m) => m.senderType !== 'bot' || !isSilenceNarration(m.content))
      .map((m) => ({
        id: m.id,
        groupId: m.groupId,
        senderId: m.senderId,
        senderType: m.senderType,
        timestamp: m.timestamp,
        content: m.content,
        replyTo: m.replyTo,
        mentions: m.mentions,
      }));
  }

  private async history(scope: Scope, signal: AbortSignal) {
    this.check(scope, signal);
    const old = this.historySources(scope);
    if (!old.length) return {};
    const saved = this.store.db
      .prepare('SELECT * FROM bot_context_history WHERE bot_id=? AND group_id=?')
      .get(scope.botId, scope.groupId) as
      (Summary & { through_message_id: string; source_digest: string }) | undefined;
    let covered = saved ? old.findIndex((m) => m.id === saved.through_message_id) + 1 : 0;
    if (covered && digest(old.slice(0, covered)) !== saved!.source_digest) covered = 0;
    let note: Summary | undefined = covered
      ? { summary: saved!.summary, method: saved!.method }
      : undefined;
    if (!note && estimateContextTokens(old) <= this.historyTrigger) return { earlierMessages: old };

    // Bound maintenance per model invocation. Older archives stay discoverable by source IDs.
    for (let attempt = 0; covered < old.length && attempt < 2; attempt++) {
      let end = covered;
      let size = 0;
      while (end < old.length && end - covered < 32) {
        const nextSize = Math.min(6000, JSON.stringify(old[end]).length);
        if (end > covered && size + nextSize > 14000) break;
        size += nextSize;
        end++;
      }
      const next = await this.note(note?.summary ?? '', old.slice(covered, end), signal);
      this.check(scope, signal);
      // New messages can arrive while summarizing. Persist only the exact captured prefix.
      if (digest(this.historySources(scope).slice(0, end)) !== digest(old.slice(0, end)))
        return {
          historyArchive: {
            incomplete: true,
            groupId: scope.groupId,
            use: 'search_messages or read_conversation',
          },
        };
      this.store.db
        .prepare(
          `INSERT INTO bot_context_history VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(bot_id,group_id) DO UPDATE SET through_message_id=excluded.through_message_id,
        source_digest=excluded.source_digest,summary=excluded.summary,method=excluded.method,updated_at=excluded.updated_at`,
        )
        .run(
          scope.botId,
          scope.groupId,
          old[end - 1].id,
          digest(old.slice(0, end)),
          next.summary,
          next.method,
          new Date().toISOString(),
        );
      covered = end;
      note = next;
    }
    return {
      conversationSummary: {
        ...note,
        provisional: true,
        isLongTermMemory: false,
        groupId: scope.groupId,
        fromMessageId: old[0].id,
        throughMessageId: old[covered - 1]?.id,
        coveredMessages: covered,
        retrieve: 'search_messages, read_conversation, read_message',
      },
      ...(covered < old.length
        ? {
            historyArchive: {
              incomplete: true,
              groupId: scope.groupId,
              pendingMessages: old.length - covered,
              fromMessageId: old[covered].id,
              throughMessageId: old.at(-1)!.id,
              recentExcerpts: old
                .slice(Math.max(covered, old.length - 2))
                .map((m) => ({ ...m, content: preview(m.content, 500) })),
              use: 'search_messages or read_conversation for details not yet summarized',
            },
          }
        : {}),
    };
  }

  private blocks(messages: CoordinatorMessage[]) {
    const blocks: CoordinatorMessage[][] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === 'tool') throw new Error('上下文工具结果缺少对应调用');
      const block = [message];
      if (message.tool_calls?.length) {
        const ids = new Set(message.tool_calls.map((c) => c.id));
        for (let n = 0; n < message.tool_calls.length; n++) {
          const result = messages[++i];
          if (result?.role !== 'tool' || !ids.delete(result.tool_call_id!))
            throw new Error('上下文工具调用尚未完整结束');
          block.push(result);
        }
      }
      blocks.push(block);
    }
    return blocks;
  }

  private reduceBase(message: CoordinatorMessage, turnId: string, budget: number) {
    const data = JSON.parse(message.content!);
    const contextDigest = digest(data);
    this.store.db
      .prepare('INSERT OR IGNORE INTO bot_context_inputs VALUES(?,?,?,?)')
      .run(turnId, contextDigest, message.content, new Date().toISOString());
    const archive = { turnId, contextDigest, tool: 'read_context' };
    const pinned = new Set([
      'bot',
      'human',
      'group',
      'event',
      'clock',
      'liveState',
      'standingPreferences',
      'responseOrder',
      'messagesSinceSource',
    ]);
    if (Array.isArray(data.messagesSinceSource))
      data.messagesSinceSource = data.messagesSinceSource.map((m: Record<string, unknown>) => {
        const content = typeof m.content === 'string' ? m.content : '';
        return content.length > 600
          ? {
              ...m,
              content: preview(content, 600),
              sourceExcerptOnly: true,
              retrieve: 'read_message',
              messageId: m.id,
            }
          : m;
      });
    const currentTask = data.tasks?.find((t: { id: string }) => t.id === data.event?.taskId);
    const currentGoal = data.goals?.find((g: { id: string }) => g.id === data.event?.goalId);
    if (currentTask) data.currentTask = currentTask;
    if (currentGoal) data.currentGoal = currentGoal;
    pinned.add('currentTask');
    pinned.add('currentGoal');
    for (const key of Object.keys(data)
      .filter((key) => !pinned.has(key))
      .sort((a, b) => estimateContextTokens(data[b]) - estimateContextTokens(data[a]))) {
      if (estimateContextTokens(data) <= budget) break;
      data[key] = {
        archived: true,
        count: Array.isArray(data[key]) ? data[key].length : undefined,
        ...archive,
        field: key,
        ...(key === 'memberships' ? { current: false, refreshWith: 'list_conversations' } : {}),
      };
    }
    return { ...message, content: JSON.stringify(data) };
  }

  async prepare(
    turnId: string,
    scope: Scope,
    original: CoordinatorMessage[],
    signal: AbortSignal,
    refresh?: () => CoordinatorMessage[],
  ) {
    this.check(scope, signal);
    const view = structuredClone(original);
    const data = JSON.parse(view[1].content!);
    const history = await this.history(scope, signal);
    Object.assign(data, history);
    view[1].content = JSON.stringify(data);
    const cost = (messages: CoordinatorMessage[]) =>
      estimateContextTokens(messages) + this.toolTokens;
    const finish = (result: CoordinatorMessage[]) => {
      this.check(scope, signal);
      // Summarization may take time. Refresh live replies, membership and task states last.
      if (refresh) {
        const fresh = refresh();
        result[0] = fresh[0];
        result[1] = {
          ...fresh[1],
          content: JSON.stringify({ ...JSON.parse(fresh[1].content!), ...history }),
        };
      }
      if (cost(result) > this.inputBudget) {
        const available =
          this.inputBudget -
          this.toolTokens -
          estimateContextTokens([result[0], ...result.slice(2)]) -
          200;
        result[1] = this.reduceBase(result[1], turnId, available);
      }
      if (cost(result) > this.inputBudget) throw new Error('必要上下文仍超出容量，原始记录已保留');
      return result;
    };
    if (cost(view) <= this.inputBudget) return finish(view);

    const target = Math.floor(this.inputBudget * 0.8);
    const baseBudget = target - this.toolTokens - estimateContextTokens(view[0]) - 3000;
    if (baseBudget > 0 && estimateContextTokens(view[1]) > baseBudget)
      view[1] = this.reduceBase(view[1], turnId, baseBudget);
    const base = view.slice(0, 2);
    if (cost(base) > this.inputBudget - 1000)
      throw new Error('当前请求与必要身份、任务约束超出上下文容量，无法安全压缩');
    if (cost(view) <= target) return finish(view);

    const blocks = this.blocks(view.slice(2));
    if (!blocks.length) return finish(view);
    let cut = 1;
    while (cut < blocks.length && cost([...base, ...blocks.slice(cut).flat()]) > target - 3000)
      cut++;
    const archived = blocks.slice(0, cut).flat();
    const hash = digest(archived);
    let saved = this.store.db
      .prepare(
        'SELECT summary,method FROM bot_context_compactions WHERE turn_id=? AND source_digest=?',
      )
      .get(turnId, hash) as Summary | undefined;
    if (!saved) {
      saved = await this.note('', archived, signal);
      this.check(scope, signal);
      this.store.db
        .prepare('INSERT OR IGNORE INTO bot_context_compactions VALUES(?,?,?,?,?)')
        .run(turnId, hash, saved.summary, saved.method, new Date().toISOString());
    }
    const summary: CoordinatorMessage = {
      role: 'user',
      content: JSON.stringify({
        contextCompaction: {
          ...saved,
          provisional: true,
          isLongTermMemory: false,
          evidenceMustBeReadFromSource: true,
          archive: {
            turnId,
            tool: 'read_context',
            callIds: archived.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []),
          },
        },
      }),
    };
    const result = [...base, summary, ...blocks.slice(cut).flat()];
    return finish(result);
  }

  read(botId: string, turnId: string, callId?: string, offset = 0, contextDigest?: string) {
    const turn = this.store.db
      .prepare(
        `SELECT c.bot_id,c.messages,i.group_id FROM coordinator_turns c
      JOIN dialogue_inbox i ON i.id=c.inbox_id WHERE c.id=?`,
      )
      .get(turnId) as { bot_id: string; messages: string; group_id: string } | undefined;
    if (!turn || turn.bot_id !== botId) throw new Error('上下文记录不属于自己');
    this.check({ botId, groupId: turn.group_id });
    if (callId && contextDigest) throw new Error('一次只读取一种上下文来源');
    let content: string;
    if (callId) {
      const call = this.store.db
        .prepare(
          'SELECT name,arguments,result FROM coordinator_calls WHERE turn_id=? AND call_id=?',
        )
        .get(turnId, callId) as { name: string; arguments: string; result: string } | undefined;
      if (!call) throw new Error('原始工具记录不存在');
      content = JSON.stringify(call);
    } else if (contextDigest) {
      const snapshot = this.store.db
        .prepare('SELECT context FROM bot_context_inputs WHERE turn_id=? AND source_digest=?')
        .get(turnId, contextDigest) as { context: string } | undefined;
      if (!snapshot) throw new Error('上下文快照不存在');
      content = snapshot.context;
    } else content = (JSON.parse(turn.messages) as CoordinatorMessage[])[1].content ?? '';
    return {
      turnId,
      callId,
      contextDigest,
      content: content.slice(offset, offset + 12000),
      length: content.length,
      nextOffset: offset + 12000 < content.length ? offset + 12000 : null,
    };
  }
}
