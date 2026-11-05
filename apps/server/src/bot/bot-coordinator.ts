import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  conversationalText,
  resolveMentions,
  type Message,
  type Provider,
  type Task,
} from '@openbot/shared';
import type { Store } from '../store.js';
import {
  coordinatorTools,
  type CoordinatorCall,
  type CoordinatorMessage,
  type CoordinatorModel,
} from '../models/coordinator-model.js';
import {
  attentionDecision,
  type AttentionInput,
  type AttentionModel,
} from '../models/attention-model.js';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskWatchdog, type ReportKind } from '../work/task-watchdog.js';
import { TaskContracts, type WorkPlan, type AcceptanceEvidence } from '../work/task-contracts.js';
import { BotMemory, type MemoryInput } from '../memory/bot-memory.js';
import { BotDelegations } from './bot-delegations.js';
import { WorkGoals, type GoalPlan, type GoalEvidence } from '../work/work-goals.js';
import { ProjectFacts } from '../work/project-facts.js';
import { WorkArtifacts } from '../work/work-artifacts.js';
import { ownershipSchemas } from '../work/work-schemas.js';
import type { WorkGoal, WorkArtifact } from '@openbot/shared';
import { MessageAttention } from './message-attention.js';
import { BotConversations } from './bot-conversations.js';
import { BotWorkspace, toolPage } from './bot-workspace.js';
import {
  workspaceToolSchemas,
  workspaceMutationTools,
  workspaceReadTools,
} from './workspace-tool-schemas.js';
import { BotContext } from './bot-context.js';
import { isSilenceNarration } from './conversation-output.js';
import { MemoryCurator, type MemoryCuratorModel } from '../memory/memory-curator.js';
import { coordinatorEvent, coordinatorInstructions } from './bot-prompt.js';

type Inbox = {
  id: string;
  bot_id: string;
  group_id: string;
  source_message_id: string | null;
  task_id: string | null;
  goal_id: string | null;
  kind: string;
  payload: string;
};
export interface WorkerOptions {
  provider?: Provider;
  resourceKey?: string;
  parentTaskId?: string;
  silent?: boolean;
  pipelineId?: string;
  resourceMode?: 'read' | 'exclusive' | 'worktree';
  criteria?: string[];
  goalId?: string;
  verifyArtifactIds?: string[];
}
export interface CoordinatorHooks {
  create(
    message: Message,
    botId: string,
    goal: string,
    contextIds: string[],
    options: WorkerOptions,
  ): Task | undefined;
  change(id: string, instruction: string, version: number, sourceId: string): unknown;
  stop(id: string): void;
  continue(id: string, message: Message, version: number, provider?: Provider): void;
  render(message: Message, botId: string, document: unknown): unknown;
  published(message: Message): void;
  providers(botId: string): Provider[];
}
const text = z.string().trim().min(1).max(6000);
const taskId = z.string().min(1);
const criteria = z.array(z.string().trim().min(1).max(500)).min(1).max(12);
const date = z.string().datetime({ offset: true });
const schemas = {
  ...ownershipSchemas,
  ...workspaceToolSchemas,
  start_worker: z
    .object({
      goal: text,
      goalId: taskId.optional(),
      verifyArtifactIds: z.array(taskId).max(12).optional(),
      resourceKey: z.string().max(4096).optional(),
      contextMessageIds: z.array(z.string()).max(4).optional(),
      parentTaskId: taskId.optional(),
      silent: z.boolean().optional(),
      pipelineId: z.string().min(1).optional(),
      criteria: criteria.optional(),
      resourceMode: z.enum(['read', 'exclusive', 'worktree']).optional(),
    })
    .strict(),
  list_tasks: z.object({}).strict(),
  read_task: z.object({ taskId, offset: z.number().int().min(0).optional() }).strict(),
  read_message: z
    .object({ messageId: z.string(), offset: z.number().int().min(0).optional() })
    .strict(),
  read_context: z
    .object({
      turnId: taskId,
      callId: taskId.optional(),
      contextDigest: taskId.optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  list_conversations: z.object({}).strict(),
  get_self: z.object({}).strict(),
  get_conversation: z.object({ groupId: taskId }).strict(),
  stay_silent: z.object({}).strict(),
  read_conversation: z
    .object({
      groupId: taskId,
      beforeMessageId: taskId.optional(),
      limit: z.number().int().min(1).max(40).optional(),
    })
    .strict(),
  search_messages: z
    .object({
      query: z.string().max(2000),
      groupId: taskId.optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    })
    .strict(),
  send_message: z
    .object({
      groupId: taskId,
      content: text,
      mentionBotIds: z.array(taskId).optional(),
    })
    .strict(),
  update_task: z.object({ taskId, instruction: text }).strict(),
  continue_task: z.object({ taskId, instruction: text }).strict(),
  stop_task: z.object({ taskId }).strict(),
  finish_task: z
    .object({
      taskId,
      verification: text,
      evidence: z
        .array(
          z
            .object({
              criterion: z.string().min(1).max(500),
              source: z.enum(['result', 'report', 'delegation']),
              quote: z.string().trim().min(1).max(4000),
              reportId: z.string().optional(),
              delegationId: z.string().optional(),
            })
            .strict(),
        )
        .max(12)
        .optional(),
    })
    .strict(),
  plan_task: z
    .object({
      taskId,
      criteria: criteria.optional(),
      nextAction: text.optional(),
      waitCondition: text.nullable().optional(),
      nextWakeAt: date.nullable().optional(),
      deadline: date.nullable().optional(),
      maxRuns: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  link_task: z.object({ taskId }).strict(),
  delegate_task: z
    .object({ taskId, botId: z.string(), goal: text, criteria, expiresAt: date.optional() })
    .strict(),
  respond_delegation: z
    .object({ delegationId: z.string(), decision: z.enum(['accept', 'reject']), reason: text })
    .strict(),
  review_delegation: z
    .object({ delegationId: z.string(), accept: z.boolean(), feedback: text })
    .strict(),
  read_delegation: z
    .object({ delegationId: z.string(), offset: z.number().int().min(0).optional() })
    .strict(),
  recall_memory: z
    .object({
      query: z.string().max(2000),
      groupId: taskId.optional(),
      limit: z.number().int().min(1).max(40).optional(),
    })
    .strict(),
  forget_memory: z.object({ memoryId: z.string() }).strict(),
  remember: z
    .object({
      key: z.string().trim().min(1).max(100),
      sourceMessageId: taskId.optional(),
      content: z.string().trim().max(4000),
      kind: z.enum(['fact', 'preference']).optional(),
      scope: z.enum(['group', 'bot']).optional(),
      provenance: z.enum(['user', 'inference', 'worker']).optional(),
      importance: z.number().int().min(1).max(3).optional(),
      expiresAt: date.nullable().optional(),
      replacesId: z.string().optional(),
    })
    .strict(),
  render: z.object({ document: z.unknown() }).strict(),
};
type Turn = { id: string; messages: string; status: string; rounds: number };
type AttentionState = {
  input: string;
  status: 'pending' | 'completed' | 'failed' | 'bypassed' | 'budget_limited';
  wake: number | null;
  attempts: number;
  error: string | null;
};
const maxRounds = 12;

/** One ordered, durable event stream per Bot. Native work always runs asynchronously. */
export class BotCoordinator {
  private running = new Map<string, Promise<void>>();
  private controller = new AbortController();
  private closed = false;
  private maintenance: TaskWatchdog;
  private contracts: TaskContracts;
  private memory: BotMemory;
  private delegations: BotDelegations;
  private goals: WorkGoals;
  private facts: ProjectFacts;
  private artifacts: WorkArtifacts;
  private messageAttention: MessageAttention;
  private workingContext: BotContext;
  private curator?: MemoryCurator;
  private get conversations() {
    return new BotConversations(this.store);
  }
  private attentionTimer?: ReturnType<typeof setTimeout>;
  private processing = new Map<string, { row: Inbox; controller: AbortController }>();
  constructor(
    private store: Store,
    private changed: () => void,
    private model: CoordinatorModel,
    private hooks: CoordinatorHooks,
    private attention?: AttentionModel,
    curation?: { model: MemoryCuratorModel; delayMs?: number },
  ) {
    this.contracts = new TaskContracts(store);
    this.memory = new BotMemory(store);
    if (curation)
      this.curator = new MemoryCurator(store, this.memory, curation.model, curation.delayMs);
    this.goals = new WorkGoals(store);
    this.facts = new ProjectFacts(store);
    this.artifacts = new WorkArtifacts(store);
    this.messageAttention = new MessageAttention(store);
    this.workingContext = new BotContext(store, model.summarize);
    this.delegations = new BotDelegations(store, (...args) => this.notify(...args), hooks.stop);
    this.maintenance = new TaskWatchdog(store, {
      connected: (id) => hooks.providers(id).length > 0,
      notify: (task, kind, facts) => {
        this.store.db
          .prepare(
            'INSERT OR IGNORE INTO dialogue_inbox(id,bot_id,group_id,task_id,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            task.botId,
            task.groupId,
            task.id,
            kind,
            JSON.stringify(facts),
            new Date().toISOString(),
          );
        queueMicrotask(() => this.pump());
      },
    });
  }

  private notify(
    botId: string,
    groupId: string,
    sourceId: string,
    kind: string,
    facts: object,
    taskId?: string,
    goalId?: string,
  ) {
    // Coordination follows the owner's explicitly selected delivery route; colleagues keep theirs.
    const route = taskId
      ? (this.store.db
          .prepare(
            'SELECT r.group_id,r.source_message_id FROM task_routes r JOIN tasks t ON t.id=r.task_id WHERE r.task_id=? AND t.bot_id=?',
          )
          .get(taskId, botId) as { group_id: string; source_message_id: string } | undefined)
      : undefined;
    groupId = route?.group_id ?? groupId;
    sourceId = route?.source_message_id ?? sourceId;
    if (!taskId && goalId) {
      const goal = this.goals.get(goalId, botId);
      groupId = goal.groupId;
      sourceId = goal.sourceMessageId ?? sourceId;
    }
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO dialogue_inbox(id,bot_id,group_id,source_message_id,task_id,kind,payload,created_at,goal_id) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        botId,
        groupId,
        null,
        taskId ?? null,
        kind,
        JSON.stringify({ ...facts, sourceMessageId: sourceId }),
        new Date().toISOString(),
        goalId ?? null,
      );
    queueMicrotask(() => this.pump());
  }

  start() {
    // Unknown executions are reported, never replayed. The event and its source survive restart.
    for (const task of this.store.snapshot().tasks) {
      const unknown = this.store.db
        .prepare(
          "SELECT id FROM worker_runs WHERE task_id=? AND status='unknown' ORDER BY started_at DESC LIMIT 1",
        )
        .get(task.id) as { id: string } | undefined;
      if (task.status === 'failed' && unknown) this.complete(task, unknown.id);
    }
    this.pump();
    this.curator?.schedule();
  }
  receive(message: Message, botId: string) {
    this.messageAttention.prepare(message);
    this.curator?.enqueue(message, botId);
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO dialogue_inbox(id,bot_id,group_id,source_message_id,kind,created_at) VALUES(?,?,?,?,'message',?)",
      )
      .run(randomUUID(), botId, message.groupId, message.id, new Date().toISOString());
    const current = this.processing.get(botId);
    const direct =
      this.store.snapshot().groups.find((g) => g.id === message.groupId)?.directBotId === botId;
    if (
      message.senderType === 'human' &&
      current &&
      this.priority(current.row) > (direct || message.mentions.includes(botId) ? 0 : 2)
    )
      current.controller.abort('preempted');
    queueMicrotask(() => this.pump());
  }
  retry(message: Message, botId?: string) {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM dialogue_inbox WHERE source_message_id=? AND kind='message' AND status='failed'",
      )
      .all(message.id) as Inbox[];
    let retried = false;
    this.store.db.transaction(() => {
      for (const row of rows) {
        if ((botId && row.bot_id !== botId) || !this.active(row) || this.chainStopped(row))
          continue;
        const turn = this.store.db
          .prepare('SELECT id,messages FROM coordinator_turns WHERE inbox_id=?')
          .get(row.id) as Pick<Turn, 'id' | 'messages'> | undefined;
        if (turn) {
          // Refresh participant context while retaining every tool request and its committed result.
          const messages = [
            ...this.context(row),
            ...(JSON.parse(turn.messages) as CoordinatorMessage[]).slice(2),
          ];
          this.store.db
            .prepare(
              "UPDATE coordinator_turns SET status='running',error=NULL,rounds=0,messages=?,updated_at=? WHERE id=?",
            )
            .run(JSON.stringify(messages), new Date().toISOString(), turn.id);
        } else {
          this.store.db
            .prepare("DELETE FROM attention_decisions WHERE inbox_id=? AND status='failed'")
            .run(row.id);
        }
        this.store.db
          .prepare("UPDATE dialogue_inbox SET status='queued' WHERE id=? AND status='failed'")
          .run(row.id);
        retried = true;
      }
    })();
    if (retried) queueMicrotask(() => this.pump());
    return retried;
  }
  complete(task: Task, leaseId: string) {
    if (task.goalId)
      this.store.db
        .prepare(
          "UPDATE work_goals SET unattended_checks=0 WHERE id=? AND state IN ('active','waiting')",
        )
        .run(task.goalId);
    this.delegations.outcome(task, leaseId);
    const current = this.processing.get(task.botId);
    if (current && this.priority(current.row) > 1) current.controller.abort('preempted');
    this.maintenance.refresh(task);
    const source = this.store.db
      .prepare('SELECT source_message_id FROM task_runtime WHERE task_id=?')
      .get(task.id) as { source_message_id: string } | undefined;
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO dialogue_inbox(id,bot_id,group_id,source_message_id,task_id,kind,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        task.botId,
        task.groupId,
        null,
        task.id,
        `completion:${leaseId}`,
        JSON.stringify({ ...task, replyToMessageId: source?.source_message_id }),
        new Date().toISOString(),
      );
    queueMicrotask(() => this.pump());
  }
  watchdog(now = Date.now()) {
    if (this.closed) return;
    this.contracts.wake(now, (task, kind, facts) => {
      const source = this.store.db
        .prepare('SELECT source_message_id FROM task_runtime WHERE task_id=?')
        .get(task.id) as { source_message_id: string };
      this.notify(task.botId, task.groupId, source.source_message_id, kind, facts, task.id);
    });
    this.delegations.scan(now);
    this.goals.scan(now, (goal, key, facts) => this.noticeGoal(goal, key, facts));
    this.maintenance.scan(now);
    this.pump();
  }
  private noticeGoal(goal: WorkGoal, key: string, facts: object) {
    if (!goal.sourceMessageId) {
      this.goals.attention(goal.id, '目标来源已不可用，需要所有者重新接续');
      return;
    }
    this.notify(
      goal.botId,
      goal.groupId,
      goal.sourceMessageId,
      `objective:${key}`,
      { ...facts, goalId: goal.id, version: goal.version, generation: goal.generation },
      undefined,
      goal.id,
    );
  }
  heartbeat(taskId: string) {
    this.maintenance.heartbeat(taskId);
  }
  progress(task: Task, leaseId: string, summary?: string, kind: ReportKind = 'progress') {
    this.maintenance.activity(task.id);
    if (summary) this.maintenance.record(task, leaseId, summary, kind);
    this.maintenance.refresh(task);
  }
  private pump() {
    if (this.closed) return;
    clearTimeout(this.attentionTimer);
    let nextWake = Infinity;
    const rows = this.store.db
      .prepare("SELECT * FROM dialogue_inbox WHERE status='queued' ORDER BY rowid")
      .all() as Inbox[];
    const eligible = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== 'message' || !this.active(row)) continue;
      const source = this.source(row);
      this.messageAttention.prepare(source);
      eligible.set(row.id, this.messageAttention.eligibleAt(source.id, row.bot_id) ?? 0);
    }
    rows.sort(
      (a, b) =>
        this.priority(a) - this.priority(b) ||
        (eligible.get(a.id) ?? 0) - (eligible.get(b.id) ?? 0),
    );
    for (const row of rows) {
      if (this.running.has(row.bot_id)) continue;
      const eligibleAt = row.source_message_id
        ? (this.messageAttention.eligibleAt(row.source_message_id, row.bot_id) ?? 0)
        : 0;
      if (eligibleAt > Date.now()) {
        nextWake = Math.min(nextWake, eligibleAt);
        continue;
      }
      if (row.kind === 'message' && row.source_message_id)
        this.messageAttention.started(row.source_message_id, row.bot_id);
      this.store.db.prepare("UPDATE dialogue_inbox SET status='processing' WHERE id=?").run(row.id);
      const controller = new AbortController();
      this.processing.set(row.bot_id, { row, controller });
      const work = this.process(
        row,
        AbortSignal.any([this.controller.signal, controller.signal]),
      ).finally(() => {
        this.processing.delete(row.bot_id);
        this.running.delete(row.bot_id);
        this.changed();
        this.pump();
      });
      this.running.set(row.bot_id, work);
      this.changed();
    }
    if (Number.isFinite(nextWake)) {
      this.attentionTimer = setTimeout(() => this.pump(), Math.max(1, nextWake - Date.now()));
      this.attentionTimer.unref();
    }
  }
  private priority(row: Inbox) {
    if (row.kind === 'message') {
      const source = this.source(row);
      const direct =
        this.store.snapshot().groups.find((g) => g.id === row.group_id)?.directBotId === row.bot_id;
      return source.senderType === 'human'
        ? direct || source.mentions.includes(row.bot_id)
          ? 0
          : 2
        : 4;
    }
    if (row.kind.startsWith('completion:')) return 1;
    if (row.kind.startsWith('delegation:')) return 3;
    return row.kind.startsWith('progress:')
      ? (JSON.parse(row.payload) as { kind?: string }).kind === 'blocked'
        ? 2
        : 6
      : 5;
  }
  cancelDelegations(taskId: string) {
    this.delegations.cancel(taskId);
  }
  stopGoal(goalId: string) {
    return this.delegations.cancelGoal(goalId);
  }
  private task(row: Inbox, id: string) {
    const s = this.store.snapshot();
    const task = s.tasks.find(
      (t) =>
        t.id === id &&
        t.botId === row.bot_id &&
        s.groups.some((g) => g.id === t.groupId && g.botIds.includes(row.bot_id)),
    );
    if (!task) throw new Error('这项工作不属于当前 Bot 或已离开其可见范围');
    return task;
  }
  private source(row: Inbox): Message {
    const s = this.store.snapshot();
    const payload =
      row.kind !== 'message'
        ? (JSON.parse(row.payload) as { replyToMessageId?: string; sourceMessageId?: string })
        : undefined;
    const taskSource = row.task_id
      ? (this.store.db
          .prepare('SELECT source_message_id FROM task_runtime WHERE task_id=?')
          .get(row.task_id) as { source_message_id: string } | undefined)
      : undefined;
    const id =
      row.source_message_id ??
      payload?.sourceMessageId ??
      payload?.replyToMessageId ??
      taskSource?.source_message_id;
    const message = s.messages.find((m) => m.id === id && m.groupId === row.group_id);
    if (!message) throw new Error('原始工作消息不可用');
    return message;
  }
  private active(row: Inbox) {
    return this.store
      .snapshot()
      .groups.some((g) => g.id === row.group_id && g.botIds.includes(row.bot_id));
  }
  private chainStopped(row: Inbox) {
    if (row.goal_id && this.goals.get(row.goal_id).state === 'cancelled') return true;
    const source = this.source(row);
    const chain = this.store.db
      .prepare('SELECT stopped FROM collaboration_chains WHERE id=?')
      .get(source.correlationId) as { stopped: number } | undefined;
    const worker = row.task_id
      ? (this.store.db
          .prepare('SELECT stopped FROM task_workers WHERE task_id=?')
          .get(row.task_id) as { stopped: number } | undefined)
      : undefined;
    return Boolean(chain?.stopped || worker?.stopped);
  }
  private attentionInput(row: Inbox): AttentionInput {
    const s = this.store.snapshot();
    const bot = s.bots.find((b) => b.id === row.bot_id)!;
    const group = s.groups.find((g) => g.id === row.group_id)!;
    const source = this.source(row);
    const all = s.messages.filter((m) => m.groupId === group.id);
    const boundary = all.findIndex((m) => m.id === source.id) + 1;
    const actor = (m: Message) => ({
      id: m.senderId,
      type: m.senderType,
      name:
        m.senderType === 'human'
          ? s.user.name
          : m.senderType === 'system'
            ? '系统'
            : (s.bots.find((b) => b.id === m.senderId)?.name ?? 'Bot'),
    });
    const reply = all.slice(0, boundary).find((m) => m.id === source.replyTo);
    const summarize = (m: Message) => ({
      id: m.id,
      actor: actor(m),
      content: m.content.slice(0, 1800),
      replyTo: m.replyTo,
      mentions: m.mentions,
    });
    return {
      memberships: this.conversations
        .list(bot.id)
        .map(({ groupId, name, direct, participants }) => ({
          groupId,
          name,
          direct,
          participants,
        })),
      memory: this.memory
        .recall(bot.id, undefined, source.content, 6)
        .filter((m) => m.kind !== 'preference')
        .map((m) => ({
          content: m.content.slice(0, 700),
          provenance: m.provenance,
          groupId: m.groupId,
        })),
      preferences: this.memory.preferences(bot.id, 8).map((m) => ({
        content: m.content.slice(0, 300),
        groupId: m.groupId,
      })),
      responseOrder: this.messageAttention.view(source.id, bot.id),
      messagesSinceSource: this.sinceSource(all, boundary).map(summarize),
      bot: { id: bot.id, name: bot.name, role: bot.description.slice(0, 500) },
      group: {
        id: group.id,
        name: group.name,
        members: s.bots
          .filter((b) => group.botIds.includes(b.id))
          .map((b) => ({ id: b.id, name: b.name, role: b.description.slice(0, 500) })),
      },
      message: {
        id: source.id,
        actor: actor(source),
        content: source.content.slice(0, 6000),
        mentions: source.mentions,
        replyTo: source.replyTo,
      },
      replyTarget: reply
        ? { senderId: reply.senderId, content: reply.content.slice(0, 1800) }
        : null,
      recentMessages: all
        .slice(0, boundary)
        .filter((m) => m.senderType !== 'bot' || !isSilenceNarration(m.content))
        .slice(-16)
        .map(summarize),
      tasks: s.tasks
        .filter((t) => t.groupId === group.id && t.createdAt <= source.timestamp)
        .slice(-16)
        .map((t) => ({
          id: t.id,
          ownerBotId: t.botId,
          goal: (t.execution?.goal ?? t.input).slice(0, 500),
          status: t.status,
        })),
    };
  }
  private sinceSource(messages: Message[], boundary: number) {
    const now = new Date().toISOString();
    return messages
      .slice(boundary)
      .filter(
        (m) => m.timestamp <= now && (m.senderType !== 'bot' || !isSilenceNarration(m.content)),
      )
      .slice(-16);
  }
  private botBudgetAvailable(row: Inbox) {
    if (row.kind !== 'message') return true;
    const source = this.source(row);
    if (source.senderType !== 'bot') return true;
    const chain = this.store.db
      .prepare('SELECT stopped,max_calls,bot_wakes,max_rounds FROM collaboration_chains WHERE id=?')
      .get(source.correlationId) as
      { stopped: number; max_calls: number; bot_wakes: number; max_rounds: number } | undefined;
    if (!chain || chain.stopped || chain.bot_wakes >= chain.max_calls) return false;
    const messages = this.store.snapshot().messages;
    let cursor: Message | undefined = source;
    const seen = new Set<string>();
    while (cursor?.senderType === 'bot' && cursor.correlationId === source.correlationId) {
      if (seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      if (seen.size > chain.max_rounds) return false;
      const parentId: string | null = cursor.replyTo;
      cursor = messages.find((m) => m.id === parentId && m.groupId === row.group_id);
    }
    return true;
  }
  /** Decision and collaboration budget commit together, so recovery cannot charge twice. */
  private saveAttention(row: Inbox, wake: boolean, bypass = false) {
    return this.store.db.transaction(() => {
      let status = bypass ? 'bypassed' : 'completed';
      let accepted = wake;
      if (wake && row.kind === 'message' && this.source(row).senderType === 'bot') {
        if (!this.botBudgetAvailable(row)) {
          status = 'budget_limited';
          accepted = false;
        } else {
          this.store.db
            .prepare('UPDATE collaboration_chains SET bot_wakes=bot_wakes+1 WHERE id=?')
            .run(this.source(row).correlationId);
        }
      }
      this.store.db
        .prepare(
          'UPDATE attention_decisions SET status=?,wake=?,error=NULL,updated_at=? WHERE inbox_id=?',
        )
        .run(status, Number(wake), new Date().toISOString(), row.id);
      return accepted;
    })();
  }
  private async shouldWake(row: Inbox, signal: AbortSignal) {
    let saved = this.store.db
      .prepare('SELECT * FROM attention_decisions WHERE inbox_id=?')
      .get(row.id) as AttentionState | undefined;
    if (saved && ['completed', 'bypassed', 'budget_limited'].includes(saved.status))
      return saved.status !== 'budget_limited' && Boolean(saved.wake);
    if (saved?.status === 'failed') throw new Error(saved.error ?? '注意力判断失败，请重试');
    const source = row.kind === 'message' ? this.source(row) : undefined;
    const s = this.store.snapshot();
    const group = s.groups.find((g) => g.id === row.group_id)!;
    const reply = source?.replyTo
      ? s.messages.find((m) => m.id === source.replyTo && m.groupId === row.group_id)
      : undefined;
    const bypass =
      !source ||
      group.directBotId === row.bot_id ||
      source.mentions.includes(row.bot_id) ||
      (source.senderType === 'human' &&
        reply?.senderType === 'bot' &&
        reply.senderId === row.bot_id);
    if (!saved) {
      this.store.db
        .prepare(
          "INSERT INTO attention_decisions(inbox_id,input,status,updated_at) VALUES(?,?,'pending',?)",
        )
        .run(
          row.id,
          JSON.stringify(
            bypass
              ? { bypass: row.kind === 'message' ? 'addressed' : 'own_task_event' }
              : this.attentionInput(row),
          ),
          new Date().toISOString(),
        );
      saved = this.store.db
        .prepare('SELECT * FROM attention_decisions WHERE inbox_id=?')
        .get(row.id) as AttentionState;
    }
    if (bypass) return this.saveAttention(row, true, true);
    // Exhausted or stopped Bot chains never invoke either model again.
    if (!this.botBudgetAvailable(row)) return this.saveAttention(row, true);
    for (let attempt = saved.attempts; attempt < 3; attempt++) {
      if (this.closed) throw new Error('服务正在关闭');
      this.store.db
        .prepare('UPDATE attention_decisions SET attempts=attempts+1,updated_at=? WHERE inbox_id=?')
        .run(new Date().toISOString(), row.id);
      try {
        if (!this.attention) throw new Error('请先在设置中配置注意力模型');
        // Keep the random hint stable, but observe replies that arrived during the delay/retry.
        saved.input = JSON.stringify(this.attentionInput(row));
        this.store.db
          .prepare('UPDATE attention_decisions SET input=? WHERE inbox_id=?')
          .run(saved.input, row.id);
        const decision = attentionDecision.parse(
          await this.attention(JSON.parse(saved.input) as AttentionInput, signal),
        );
        signal.throwIfAborted();
        if (this.closed) throw new Error('服务正在关闭');
        return this.saveAttention(row, decision.wake);
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.closed) throw error;
        // Only fixed local errors may surface; provider response bodies can contain credentials.
        const message = error instanceof Error ? error.message : '';
        const detail =
          /^(?:请先在设置中配置注意力模型|请在设置中选择注意力模型|注意力模型返回(?:不完整|格式无效)|模型服务请求失败（HTTP \d+）)/.test(
            message,
          )
            ? message.slice(0, 200)
            : '注意力模型暂不可用，请检查模型设置或网络后重试';
        this.store.db
          .prepare('UPDATE attention_decisions SET error=?,updated_at=? WHERE inbox_id=?')
          .run(detail, new Date().toISOString(), row.id);
        if (attempt < 2) await delay(200 * (attempt + 1), undefined, { signal });
      }
    }
    this.store.db
      .prepare("UPDATE attention_decisions SET status='failed',updated_at=? WHERE inbox_id=?")
      .run(new Date().toISOString(), row.id);
    const failure = this.store.db
      .prepare('SELECT error FROM attention_decisions WHERE inbox_id=?')
      .get(row.id) as { error: string | null };
    throw new Error(failure.error ?? '注意力判断失败，请重试');
  }
  private context(row: Inbox): CoordinatorMessage[] {
    const s = this.store.snapshot();
    const bot = s.bots.find((b) => b.id === row.bot_id)!;
    const group = s.groups.find((g) => g.id === row.group_id)!;
    const source = this.source(row);
    const all = s.messages.filter((m) => m.groupId === group.id);
    const boundary =
      row.kind === 'message' ? all.findIndex((m) => m.id === source.id) + 1 : all.length;
    const preferences = this.memory.preferences(bot.id);
    const memories = [
      ...new Map(
        [
          ...this.memory.recall(bot.id, undefined, source.content, 16),
          ...this.memory.recall(bot.id, undefined, '', 4),
        ]
          .filter((m) => m.kind !== 'preference')
          .map((m) => [m.id, m]),
      ).values(),
    ];
    const goals = this.goals.list(bot.id, group.id);
    const delegations = this.delegations.list(bot.id, group.id);
    const projects = s.projects?.filter((p) => p.groupIds.includes(group.id));
    const registry = s.tasks
      .filter(
        (t) =>
          t.botId === bot.id &&
          s.groups.some((g) => g.id === t.groupId && g.botIds.includes(bot.id)),
      )
      .filter((t) => ['queued', 'running', 'cancelling', 'reviewing', 'failed'].includes(t.status));
    const oldMemory = this.store.db
      .prepare('SELECT summary FROM conversation_memory WHERE bot_id=? AND group_id=?')
      .get(bot.id, group.id);
    const tasks = s.tasks.filter((t) => t.botId === bot.id && t.groupId === group.id);
    const members = s.bots.filter((b) => group.botIds.includes(b.id));
    const human = {
      id: s.user.id,
      type: 'human',
      displayName: s.user.name,
      role: 'owner',
      personalName: null,
    };
    const actor = (message: Message) => ({
      id: message.senderId,
      type: message.senderType,
      displayName:
        message.senderType === 'human'
          ? s.user.name
          : message.senderType === 'system'
            ? '系统'
            : (s.bots.find((b) => b.id === message.senderId)?.name ?? 'Bot'),
    });
    return [
      {
        role: 'system',
        content: coordinatorInstructions({
          name: bot.name,
          role: bot.description,
          humanLabel: s.user.name,
          event: coordinatorEvent(row.kind),
          activeWork:
            registry.length > 0 ||
            goals.some((g) => !['completed', 'cancelled'].includes(g.state)) ||
            delegations.length > 0 ||
            Boolean(projects?.length),
        }),
      },
      {
        role: 'user',
        content: JSON.stringify({
          bot: { id: bot.id, name: bot.name, executionTool: bot.provider },
          responseOrder:
            row.kind === 'message' ? this.messageAttention.view(source.id, bot.id) : undefined,
          messagesSinceSource:
            row.kind === 'message'
              ? this.sinceSource(all, boundary).map((m) => ({
                  id: m.id,
                  actor: actor(m),
                  content: m.content.slice(0, 1800),
                  replyTo: m.replyTo,
                  mentions: m.mentions,
                }))
              : [],
          clock: {
            now: new Date().toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          human,
          group: {
            id: group.id,
            name: group.name,
            direct: Boolean(group.directBotId),
            members: members.map((b) => ({
              id: b.id,
              type: 'bot',
              name: b.name,
              role: b.description,
            })),
            participants: [
              human,
              ...members.map((b) => ({
                id: b.id,
                type: 'bot',
                displayName: b.name,
                role: b.description,
              })),
            ],
          },
          capabilities: this.hooks.providers(bot.id).length
            ? [
                '可读取和搜索本地文件',
                '可通过执行工具联网搜索和读取网页，受模型服务、网络及原生权限限制',
                '可在授权后修改文件或运行命令',
                '可继续已有工作会话',
              ]
            : [],
          liveState: {
            source: 'database',
            observedAt: new Date().toISOString(),
            botId: bot.id,
            currentGroupId: group.id,
            refreshWith: ['get_self', 'list_conversations', 'get_conversation'],
            memoriesAreHistorical: true,
          },
          memberships: this.conversations.list(bot.id),
          relatedConversationMessages: this.conversations
            .search(bot.id, source.content, undefined, 0, 8, group.id)
            .messages.filter((m) => m.senderType !== 'bot' || !isSilenceNarration(m.content)),
          standingPreferences: preferences.map((m) => ({
            id: m.id,
            content: m.content,
            scope: m.scope,
            groupId: m.groupId,
            updatedAt: m.updatedAt,
          })),
          memory: memories,
          goals: goals.slice(0, 12).map((g) => ({
            id: g.id,
            title: g.title.slice(0, 1000),
            criteriaPreview: g.criteria.slice(0, 3),
            version: g.version,
            state: g.state,
            nextAction: g.nextAction,
            nextCheckAt: g.nextCheckAt,
            deadline: g.deadline,
            attentionReason: g.attentionReason,
            ownerWait: g.ownerWait,
            delivery: g.delivery,
            verification: g.verification,
            projectId: g.projectId,
          })),
          goalRegistry: this.goals.list(bot.id).map((g) => ({
            id: g.id,
            title: g.title.slice(0, 800),
            state: g.state,
            groupId: g.groupId,
            version: g.version,
          })),
          projects: projects?.slice(-8).map((p) => ({
            ...p,
            facts: this.facts
              .current(p.id)
              .slice(0, 8)
              .map((f) => ({ ...f, content: f.content.slice(0, 1000) })),
          })),
          artifacts: s.artifacts
            ?.filter((a) =>
              s.goals?.some(
                (g) =>
                  g.id === a.goalId &&
                  ((g.botId === bot.id && g.groupId === group.id) ||
                    (g.projectId &&
                      s.projects?.some(
                        (p) => p.id === g.projectId && p.groupIds.includes(group.id),
                      ))),
              ),
            )
            .slice(-16)
            .map((a) => ({
              id: a.id,
              goalId: a.goalId,
              title: a.title,
              kind: a.kind,
              locator: a.locator,
              version: a.version,
              digest: a.digest,
              state: a.state,
            })),
          delegations,
          taskRegistry: registry.slice(-24).map((t) => ({
            id: t.id,
            groupId: t.groupId,
            goal: (t.execution?.goal ?? t.input).slice(0, 500),
            status: t.status,
            health: t.execution?.health,
            pipeline: t.execution?.pipeline,
            contract: t.execution?.contract,
          })),
          legacySummary: oldMemory ?? null,
          groupWork: s.tasks
            .filter((t) => t.groupId === group.id)
            .slice(-16)
            .map((t) => ({
              ownerBotId: t.botId,
              goal: (t.execution?.goal ?? t.input).slice(0, 500),
              status: t.status,
            })),
          recentMessages: all
            .slice(0, boundary)
            .filter((m) => m.senderType !== 'bot' || !isSilenceNarration(m.content))
            .slice(-12)
            .map((m) => ({
              id: m.id,
              senderId: m.senderId,
              senderType: m.senderType,
              actor: actor(m),
              replyTo: m.replyTo,
              mentions: m.mentions,
              content: m.content.slice(0, 1800),
              length: m.content.length,
            })),
          tasks: tasks.slice(-12).map((t) => ({
            id: t.id,
            goalId: t.goalId,
            pipeline: t.execution?.pipeline,
            health: t.execution?.health,
            goal: t.execution?.goal ?? t.input,
            status: t.status,
            activity: t.execution?.activity,
            updatedAt: t.execution?.updatedAt,
            resultPreview: t.result?.slice(-3000),
            resultLength: t.result?.length ?? 0,
            error: t.error,
            execution: this.store.db
              .prepare(
                'SELECT parent_task_id AS parentTaskId,review FROM task_workers WHERE task_id=?',
              )
              .get(t.id),
            contract: t.execution?.contract,
            workspace: t.execution?.workspace,
          })),
          event:
            row.kind === 'message'
              ? {
                  kind: 'message',
                  actor: actor(source),
                  message: {
                    ...source,
                    content: source.content.slice(0, 6000),
                    length: source.content.length,
                  },
                }
              : {
                  kind: coordinatorEvent(row.kind),
                  goalId: row.goal_id,
                  taskId: row.task_id,
                  eventType: row.kind,
                  facts: row.kind.startsWith('completion:')
                    ? {
                        status: (JSON.parse(row.payload) as Task).status,
                        resultPreview: (JSON.parse(row.payload) as Task).result?.slice(-6000),
                        error: (JSON.parse(row.payload) as Task).error,
                      }
                    : JSON.parse(row.payload),
                  stopped: this.chainStopped(row),
                },
        }),
      },
    ];
  }
  private publish(row: Inbox, content: string) {
    if (
      row.kind.startsWith('progress:') &&
      (JSON.parse(row.payload) as { kind?: string }).kind !== 'blocked'
    )
      return;
    if (!content.trim() || isSilenceNarration(content)) return;
    const s = this.store.snapshot();
    const source = this.source(row);
    if (
      (row.kind.startsWith('progress:') || row.kind.startsWith('watchdog:')) &&
      s.messages.some(
        (m) =>
          m.groupId === row.group_id &&
          m.senderId === row.bot_id &&
          m.replyTo === source.id &&
          m.content === conversationalText(content, s.tasks),
      )
    )
      return;
    const message: Message = {
      id: randomUUID(),
      groupId: row.group_id,
      senderId: row.bot_id,
      senderType: 'bot',
      content: conversationalText(content, s.tasks),
      mentions: resolveMentions(content, s.bots).filter((id) => id !== row.bot_id),
      replyTo: source.id,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: source.correlationId,
    };
    this.store.insertMessage(message);
    this.hooks.published(message);
  }
  private execute(row: Inbox, call: CoordinatorCall): unknown {
    const name = call.function.name as keyof typeof schemas;
    if (!Object.hasOwn(schemas, name)) throw new Error('未知调度工具');
    const args = schemas[name].parse(JSON.parse(call.function.arguments)) as Record<
      string,
      unknown
    >;
    if (
      row.kind.startsWith('progress:') &&
      (JSON.parse(row.payload) as { kind?: string }).kind !== 'blocked' &&
      ![
        ...workspaceReadTools,
        'list_tasks',
        'read_task',
        'read_message',
        'read_context',
        'list_conversations',
        'get_self',
        'get_conversation',
        'read_conversation',
        'search_messages',
        'recall_memory',
        'stay_silent',
      ].includes(name)
    )
      throw new Error('普通进度汇报只供状态维护，不触发新任务、任务变更或记忆写入');
    if (!this.active(row)) throw new Error('Bot 已离开群组');
    if (name === 'stay_silent') {
      if (this.requiresAcceptance(row))
        throw new Error('执行结果仍待验收；请先核实并验收、返工或处理实际阻塞，再结束本轮');
      return { silent: true };
    }
    const source = this.source(row);
    const humanRequest = row.kind === 'message' && source.senderType === 'human';
    if (workspaceMutationTools.has(name) && !humanRequest)
      throw new Error('此操作需要所有者在当前对话的明确要求');
    if (Object.hasOwn(workspaceToolSchemas, name)) {
      if (this.chainStopped(row) && !workspaceReadTools.includes(name))
        throw new Error('这轮协作已停止');
      if (name === 'list_tools')
        return toolPage(
          coordinatorTools
            .map((t) => ({
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
              requiresOwnerRequest:
                workspaceMutationTools.has(t.function.name) ||
                [
                  'confirm_project_fact',
                  'share_project',
                  'revise_goal',
                  'link_goal',
                  'reopen_goal',
                ].includes(t.function.name),
            }))
            .filter(
              (t) =>
                !args.query ||
                `${t.name} ${t.description}`
                  .toLowerCase()
                  .includes(String(args.query).toLowerCase()),
            ),
          args,
        );
      if (name === 'reply_message' || name === 'forward_message') {
        const original = this.conversations.message(row.bot_id, args.messageId as string);
        if (
          name === 'forward_message' &&
          (original.messageType !== 'text' || original.ui || original.nativeRequest)
        )
          throw new Error('只能转发普通文本消息，不能转发交互卡片或原生请求');
        const content =
          name === 'reply_message'
            ? (args.content as string)
            : [
                args.note,
                `转发自 ${original.actor.name}（消息 ${original.id}，${original.timestamp}）：\n${original.content}`,
              ]
                .filter(Boolean)
                .join('\n\n');
        if (content.length > 16000) throw new Error('转发内容超过 16000 字符，请先摘要并注明来源');
        const { message, created } = this.conversations.send(
          row.bot_id,
          source,
          name === 'reply_message' ? original.groupId : (args.groupId as string),
          content,
          (args.mentionBotIds as string[] | undefined) ?? [],
          name === 'reply_message' ? original.id : null,
          name !== 'forward_message',
        );
        if (created) this.hooks.published(message);
        return {
          sent: true,
          messageId: message.id,
          groupId: message.groupId,
          replyTo: message.replyTo,
          ...(name === 'forward_message' ? { sourceMessageId: original.id } : {}),
        };
      }
      return new BotWorkspace(this.store).execute(
        name,
        args,
        row.bot_id,
        source,
        this.hooks.providers(row.bot_id),
      );
    }
    if (
      ([
        'confirm_project_fact',
        'share_project',
        'revise_goal',
        'link_goal',
        'reopen_goal',
      ].includes(name) ||
        (name === 'verify_artifact' && args.method === 'human')) &&
      !humanRequest
    )
      throw new Error('此操作需要所有者在当前对话的明确要求');
    const originalTask = row.task_id ? this.task(row, row.task_id) : undefined;
    const stopped =
      this.chainStopped(row) || (row.kind !== 'message' && originalTask?.status === 'cancelled');
    if (stopped && ['start_worker', 'update_task', 'continue_task'].includes(name))
      throw new Error('这项工作已停止，不能自动重新启动');
    const task = typeof args.taskId === 'string' ? this.task(row, args.taskId) : undefined;
    let goal =
      typeof args.goalId === 'string'
        ? this.goals.get(
            args.goalId,
            row.bot_id,
            ['read_goal', 'link_goal'].includes(name) ? undefined : row.group_id,
          )
        : undefined;
    if (
      goal?.ownerWait &&
      humanRequest &&
      ['start_worker', 'delegate_goal', 'register_artifact', 'finish_goal'].includes(name)
    ) {
      this.goals.plan(
        goal,
        { nextAction: typeof args.goal === 'string' ? args.goal : goal.nextAction },
        true,
      );
      this.store.db
        .prepare('UPDATE work_goals SET source_message_id=? WHERE id=?')
        .run(source.id, goal.id);
      goal = this.goals.get(goal.id);
    }
    if (
      task &&
      task.groupId !== row.group_id &&
      !['read_task', 'list_tasks', 'link_task'].includes(name)
    )
      throw new Error('先由用户在当前对话中关联这项工作，再调整、续接或验收');
    if (name === 'create_goal')
      return this.goals.create(
        source,
        row.bot_id,
        args.title as string,
        args.criteria as string[],
        args as {
          projectId?: string;
          delivery?: 'accepted' | 'applied';
          verification?: 'reviewed' | 'content';
        },
      );
    if (name === 'list_goals') {
      const offset = (args.offset as number | undefined) ?? 0;
      const goals = this.goals.list(
        row.bot_id,
        undefined,
        offset,
        (args.query as string | undefined) ?? '',
      );
      return {
        nextOffset: goals.length === 40 ? offset + 40 : null,
        goals: goals.map((g) => ({
          id: g.id,
          title: g.title,
          state: g.state,
          groupId: g.groupId,
          version: g.version,
          nextAction: g.nextAction,
          nextCheckAt: g.nextCheckAt,
          attentionReason: g.attentionReason,
        })),
      };
    }
    if (name === 'read_goal')
      return {
        ...goal,
        waits: this.store.db.prepare('SELECT * FROM goal_waits WHERE goal_id=?').all(goal!.id),
        tasks: this.store.snapshot().tasks.filter((t) => t.goalId === goal!.id),
        artifacts: this.store
          .snapshot()
          .artifacts?.filter((a) => a.goalId === goal!.id)
          .map((a) => ({
            id: a.id,
            title: a.title,
            version: a.version,
            digest: a.digest,
            state: a.state,
            kind: a.kind,
            locator: a.locator,
          })),
        acceptance: this.store.db
          .prepare('SELECT * FROM goal_acceptance WHERE goal_id=?')
          .all(goal!.id),
      };
    if (name === 'link_goal') {
      this.goals.link(goal!, source);
      for (const t of this.store.snapshot().tasks.filter((t) => t.goalId === goal!.id))
        this.contracts.link(t, source);
      return this.goals.get(goal!.id);
    }
    if (name === 'plan_goal') {
      const { goalId: _id, ...plan } = args;
      this.goals.plan(goal!, plan as GoalPlan, humanRequest);
      if (humanRequest)
        this.store.db
          .prepare('UPDATE work_goals SET source_message_id=? WHERE id=?')
          .run(source.id, goal!.id);
      return this.goals.get(goal!.id);
    }
    if (name === 'revise_goal')
      return this.goals.revise(
        goal!,
        args.expectedVersion as number,
        args.criteria as string[],
        source,
      );
    if (name === 'stop_goal') return this.delegations.cancelGoal(goal!.id);
    if (name === 'reopen_goal')
      return this.goals.reopen(
        goal!,
        args.expectedVersion as number,
        args.instruction as string,
        source,
      );
    if (name === 'finish_goal') {
      const accepted = this.goals.complete(
        goal!,
        args.expectedVersion as number,
        args.evidence as GoalEvidence[],
      );
      this.delegations.submitGoal(accepted);
      return accepted;
    }
    if (name === 'delegate_goal')
      return this.delegations.offerGoal(
        goal!,
        args.botId as string,
        args.goal as string,
        args.criteria as string[],
        source,
        args.expiresAt as string | undefined,
      );
    if (name === 'create_project') return this.facts.create(args.name as string, source);
    if (name === 'share_project')
      return this.facts.share(args.projectId as string, args.groupId as string, source);
    if (name === 'read_project') return this.facts.read(args.projectId as string, row.group_id);
    if (name === 'propose_project_fact')
      return this.facts.propose(
        args.projectId as string,
        args.key as string,
        args.content as string,
        args.kind as string,
        args.expectedVersion as number,
        row.bot_id,
        source,
      );
    if (name === 'confirm_project_fact')
      return this.facts.confirm(args.factId as string, args.version as number, source);
    if (name === 'register_artifact')
      return this.artifacts.register(
        row.bot_id,
        row.group_id,
        args as {
          goalId: string;
          taskId: string;
          title: string;
          kind: WorkArtifact['kind'];
          locator: string;
          applicationPath?: string;
          artifactId?: string;
          expectedVersion?: number;
        },
      );
    if (name === 'read_artifact') {
      const a = this.artifacts.get(args.artifactId as string);
      this.artifacts.canRead(a, row.bot_id, row.group_id);
      return {
        ...a,
        manifest: a.manifest.slice(
          (args.offset as number | undefined) ?? 0,
          ((args.offset as number | undefined) ?? 0) + 12000,
        ),
        nextOffset:
          ((args.offset as number | undefined) ?? 0) + 12000 < a.manifest.length
            ? ((args.offset as number | undefined) ?? 0) + 12000
            : null,
        checks: this.store.db
          .prepare('SELECT * FROM artifact_checks WHERE artifact_id=? ORDER BY created_at')
          .all(a.id),
        history: this.store.db
          .prepare(
            'SELECT version,digest,created_at FROM artifact_history WHERE artifact_id=? ORDER BY version',
          )
          .all(a.id),
      };
    }
    if (name === 'verify_artifact')
      return this.artifacts.verify(
        row.bot_id,
        row.group_id,
        source,
        args as {
          artifactId: string;
          version: number;
          method: 'json' | 'independent_run' | 'human';
          verifierRunId?: string;
          quote?: string;
        },
      );
    if (name === 'accept_artifact')
      return this.artifacts.accept(
        row.bot_id,
        row.group_id,
        args.artifactId as string,
        args.version as number,
      );
    if (name === 'record_application')
      return this.artifacts.application(
        row.bot_id,
        row.group_id,
        args.artifactId as string,
        args.version as number,
        source,
      );
    if (name === 'link_task') {
      this.contracts.link(task!, source);
      return { linked: true, taskId: task!.id, deliveryGroupId: row.group_id };
    }
    if (name === 'plan_task') {
      const { taskId: _taskId, ...plan } = args;
      this.contracts.plan(
        task!,
        plan as WorkPlan,
        row.kind === 'message' && source.senderType === 'human',
      );
      return { planned: true };
    }
    if (name === 'delegate_task')
      return this.delegations.offer(
        task!,
        args.botId as string,
        args.goal as string,
        args.criteria as string[],
        source,
        args.expiresAt as string | undefined,
      );
    if (name === 'read_delegation') {
      const d = this.delegations.get(args.delegationId as string, row.bot_id);
      if (!this.delegations.visible(d, row.bot_id, row.group_id))
        throw new Error('请在协作所属的对话中读取结果');
      const offset = (args.offset as number | undefined) ?? 0;
      return {
        ...d,
        result: d.result?.slice(offset, offset + 12000),
        nextOffset: d.result && offset + 12000 < d.result.length ? offset + 12000 : null,
      };
    }
    if (name === 'respond_delegation') {
      const d = this.delegations.get(args.delegationId as string, row.bot_id);
      if (d.group_id !== row.group_id) throw new Error('委托不属于当前对话');
      return this.delegations.respond(
        d,
        row.bot_id,
        args.decision as 'accept' | 'reject',
        args.reason as string,
        () =>
          d.task_id
            ? this.hooks.create(
                this.store.snapshot().messages.find((m) => m.id === d.source_message_id)!,
                row.bot_id,
                d.goal,
                [],
                { criteria: JSON.parse(d.criteria), silent: true },
              )
            : (() => {
                const parent = this.goals.get(d.goal_id);
                const child = this.goals.create(
                  this.store.snapshot().messages.find((m) => m.id === d.source_message_id)!,
                  row.bot_id,
                  d.goal,
                  JSON.parse(d.criteria),
                  {
                    projectId: parent.projectId ?? undefined,
                    delivery: parent.delivery,
                    verification: parent.verification,
                  },
                );
                this.noticeGoal(child, `accepted:${d.id}`, {
                  reason: 'delegation_accepted',
                  delegationId: d.id,
                });
                return child;
              })(),
      );
    }
    if (name === 'review_delegation') {
      const d = this.delegations.get(args.delegationId as string, row.bot_id);
      if (!this.delegations.visible(d, row.bot_id, row.group_id))
        throw new Error('请在协作所属的对话中验收');
      return this.delegations.review(
        d,
        row.bot_id,
        args.accept as boolean,
        args.feedback as string,
      );
    }
    if (name === 'recall_memory') {
      if (args.groupId) this.conversations.group(row.bot_id, args.groupId as string);
      return this.memory.recall(
        row.bot_id,
        args.groupId as string | undefined,
        args.query as string,
        args.limit as number | undefined,
      );
    }
    if (name === 'forget_memory')
      return this.memory.forget(row.bot_id, undefined, args.memoryId as string);
    if (name === 'get_self') return this.conversations.self(row.bot_id);
    if (name === 'list_conversations') return this.conversations.list(row.bot_id);
    if (name === 'get_conversation')
      return this.conversations.info(row.bot_id, args.groupId as string);
    if (name === 'read_context')
      return this.workingContext.read(
        row.bot_id,
        args.turnId as string,
        args.callId as string | undefined,
        args.offset as number | undefined,
        args.contextDigest as string | undefined,
      );
    if (name === 'read_conversation')
      return this.conversations.read(
        row.bot_id,
        args.groupId as string,
        args.beforeMessageId as string | undefined,
        args.limit as number | undefined,
      );
    if (name === 'search_messages')
      return this.conversations.search(
        row.bot_id,
        args.query as string,
        args.groupId as string | undefined,
        args.offset as number | undefined,
        args.limit as number | undefined,
      );
    if (name === 'send_message') {
      if (this.chainStopped(row)) throw new Error('这轮协作已停止');
      const { message, created } = this.conversations.send(
        row.bot_id,
        source,
        args.groupId as string,
        args.content as string,
        (args.mentionBotIds as string[] | undefined) ?? [],
      );
      if (created) this.hooks.published(message);
      return {
        sent: true,
        messageId: message.id,
        groupId: message.groupId,
        content: message.content,
        mentions: message.mentions,
      };
    }
    if (name === 'list_tasks')
      return this.store
        .snapshot()
        .tasks.filter(
          (t) =>
            t.botId === row.bot_id &&
            this.store
              .snapshot()
              .groups.some((g) => g.id === t.groupId && g.botIds.includes(row.bot_id)),
        )
        .map((t) => ({
          id: t.id,
          goalId: t.goalId,
          pipeline: t.execution?.pipeline,
          health: t.execution?.health,
          groupId: t.groupId,
          goal: (t.execution?.goal ?? t.input).slice(0, 800),
          status: t.status,
          contract: t.execution?.contract,
        }));
    if (name === 'read_task') {
      const offset = (args.offset as number | undefined) ?? 0;
      const result = task!.result ?? '';
      return {
        id: task!.id,
        goalId: task!.goalId,
        groupId: task!.groupId,
        botId: task!.botId,
        input: task!.input,
        status: task!.status,
        createdAt: task!.createdAt,
        startedAt: task!.startedAt,
        finishedAt: task!.finishedAt,
        error: task!.error,
        execution: task!.execution
          ? {
              goal: task!.execution.goal,
              activity: task!.execution.activity,
              report: task!.execution.report,
              review: task!.execution.review,
              pipeline: task!.execution.pipeline,
              health: task!.execution.health,
              version: task!.execution.version,
              updatedAt: task!.execution.updatedAt,
            }
          : undefined,
        result: result.slice(offset, offset + 12000),
        workerReports: this.store.db
          .prepare(
            'SELECT id,lease_id AS runId,kind,summary,created_at AS reportedAt FROM worker_reports WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 12',
          )
          .all(task!.id),
        nextOffset: offset + 12000 < result.length ? offset + 12000 : null,
        runs: this.store.db
          .prepare(
            'SELECT id,status,goal_version AS goalVersion,requirement_version AS version,error,started_at AS startedAt,finished_at AS finishedAt,substr(result,1,2000) AS resultPreview FROM worker_runs WHERE task_id=? ORDER BY started_at',
          )
          .all(task!.id),
        children: this.store.db
          .prepare(
            'SELECT t.id,t.status FROM task_workers w JOIN tasks t ON t.id=w.task_id WHERE w.parent_task_id=?',
          )
          .all(task!.id),
        contract: task!.execution?.contract,
        workspace: task!.execution?.workspace,
        delegations: this.store.db
          .prepare(
            'SELECT id,target_bot_id AS targetBotId,state,child_task_id AS childTaskId FROM bot_delegations WHERE task_id=?',
          )
          .all(task!.id),
        acceptance: this.store.db
          .prepare(
            'SELECT criterion,evidence,source,requirement_version AS version FROM task_acceptance WHERE task_id=? ORDER BY verified_at DESC',
          )
          .all(task!.id),
      };
    }
    if (name === 'read_message') {
      const message = this.conversations.message(row.bot_id, args.messageId as string);
      const offset = (args.offset as number | undefined) ?? 0;
      return {
        ...message,
        content: message.content.slice(offset, offset + 12000),
        nextOffset: offset + 12000 < message.content.length ? offset + 12000 : null,
      };
    }
    if (name === 'start_worker') {
      if (
        row.kind !== 'message' &&
        originalTask &&
        originalTask.status === 'failed' &&
        /结果未知|连接.*中断/.test(originalTask.error ?? '')
      )
        throw new Error('先核实未知执行，不能自动派发替代执行');
      const parent = args.parentTaskId ? this.task(row, args.parentTaskId as string) : undefined;
      if (parent && (parent.groupId !== row.group_id || parent.status === 'cancelled'))
        throw new Error('父任务不在当前群组或已经停止');
      const ids = (args.contextMessageIds as string[] | undefined) ?? [];
      if (
        ids.some(
          (id) =>
            !this.store
              .snapshot()
              .messages.some(
                (m) => m.id === id && m.groupId === row.group_id && m.timestamp <= source.timestamp,
              ),
        )
      )
        throw new Error('相关引用不在当前来源消息范围');
      const created = this.hooks.create(source, row.bot_id, args.goal as string, ids, {
        provider: undefined,
        resourceKey: args.resourceKey as string | undefined,
        parentTaskId: parent?.id,
        silent: args.silent as boolean | undefined,
        pipelineId: args.pipelineId as string | undefined,
        criteria: args.criteria as string[] | undefined,
        goalId: args.goalId as string | undefined,
        verifyArtifactIds: args.verifyArtifactIds as string[] | undefined,
        resourceMode: args.resourceMode as WorkerOptions['resourceMode'],
      });
      if (!created) throw new Error('未能开始工作，请检查执行连接或协作预算');
      return {
        taskId: created.id,
        status: created.status,
        message: '已接收，后台运行；完成后将投递事件，请继续处理对话。',
      };
    }
    if (name === 'update_task') {
      this.hooks.change(task!.id, args.instruction as string, task!.execution!.version, source.id);
      return { status: 'change_requested' };
    }
    if (name === 'continue_task') {
      if (!this.contracts.canRun(task!.id, row.kind === 'message' && source.senderType === 'human'))
        throw new Error('这项工作的执行预算已用完，需要用户明确调整计划');
      if (task!.status === 'cancelled' && row.kind !== 'message')
        throw new Error('用户停止的工作不能自动续接');
      if (
        task!.status === 'failed' &&
        /结果未知|连接.*中断/.test(task!.error ?? '') &&
        row.kind !== 'message'
      )
        throw new Error('执行结果未知，需要先核实并由用户明确决定是否续接');
      this.hooks.continue(
        task!.id,
        { ...source, content: args.instruction as string },
        task!.execution!.version,
        undefined,
      );
      return { taskId: task!.id, status: 'continuing' };
    }
    if (name === 'stop_task') {
      this.hooks.stop(task!.id);
      return { status: this.task(row, task!.id).status };
    }
    if (name === 'finish_task') {
      if (!['reviewing', 'completed'].includes(task!.status))
        throw new Error('执行尚未返回可验收的结果');
      const children = this.store.db
        .prepare(
          "SELECT t.id FROM task_workers w JOIN tasks t ON t.id=w.task_id WHERE w.parent_task_id=? AND t.status!='completed'",
        )
        .all(task!.id);
      if (children.length) throw new Error('支持这项工作的子任务尚未全部完成验收');
      const run = this.store.db
        .prepare(
          'SELECT id,status,requirement_version,result FROM worker_runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
        )
        .get(task!.id) as
        | { id: string; status: string; requirement_version: number; result: string | null }
        | undefined;
      if (run?.status !== 'completed') throw new Error('没有已完成的真实执行结果');
      this.facts.assertCurrent(run.id);
      if (
        this.store.db
          .prepare(
            "SELECT id FROM bot_delegations WHERE task_id=? AND state IN ('offered','accepted','submitted') LIMIT 1",
          )
          .get(task!.id)
      )
        throw new Error('这项工作的协作委托尚未完成验收');
      this.contracts.accept(task!, run, (args.evidence ?? []) as AcceptanceEvidence[]);
      this.store.db
        .prepare("UPDATE task_workers SET review='accepted',verification=? WHERE task_id=?")
        .run(args.verification as string, task!.id);
      this.store.db
        .prepare("UPDATE tasks SET status='completed',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), task!.id);
      this.store.db
        .prepare("UPDATE task_specs SET activity='结果已检查',updated_at=? WHERE task_id=?")
        .run(new Date().toISOString(), task!.id);
      const parent = this.store.db
        .prepare('SELECT parent_task_id FROM task_workers WHERE task_id=?')
        .get(task!.id) as { parent_task_id: string | null };
      if (parent.parent_task_id)
        this.complete(this.task(row, parent.parent_task_id), `child:${task!.id}:${run.id}`);
      this.delegations.submit(this.task(row, task!.id));
      if (task!.goalId) {
        const g = this.goals.get(task!.goalId);
        if (g.legacy)
          this.store.db
            .prepare(
              "UPDATE work_goals SET state='completed',result=?,next_check_at=NULL,updated_at=? WHERE id=? AND state!='cancelled'",
            )
            .run(task!.result, new Date().toISOString(), g.id);
        else {
          this.goals.reconcile(g.id);
          this.noticeGoal(this.goals.get(g.id), `task:${run.id}`, {
            reason: 'execution_accepted',
            taskId: task!.id,
          });
        }
      }
      return { taskId: task!.id, status: 'completed' };
    }
    if (name === 'remember') {
      if (args.provenance === 'worker' && !row.task_id)
        throw new Error('执行者来源必须关联真实任务事件');
      if (args.provenance === 'user' && row.kind !== 'message' && !args.sourceMessageId)
        throw new Error('任务事件不能当作用户的新陈述');
      const memorySource = args.sourceMessageId
        ? this.conversations.message(row.bot_id, args.sourceMessageId as string)
        : source;
      return this.memory.save(
        row.bot_id,
        memorySource.groupId,
        memorySource.id,
        args as MemoryInput,
      );
    }
    if (name === 'render') return this.hooks.render(source, row.bot_id, args.document);
  }
  private currentProgress(row: Inbox) {
    if (row.kind.startsWith('objective:') && row.goal_id) {
      const goal = this.goals.get(row.goal_id);
      return (
        goal.state !== 'cancelled' &&
        goal.version === (JSON.parse(row.payload) as { version: number }).version
      );
    }
    if (row.kind.startsWith('goal:')) {
      const current = this.store.db
        .prepare('SELECT generation,state FROM task_contracts WHERE task_id=?')
        .get(row.task_id) as { generation: number; state: string } | undefined;
      return (
        current?.generation === (JSON.parse(row.payload) as { generation: number }).generation &&
        !['completed', 'cancelled'].includes(current.state)
      );
    }
    if (!row.kind.startsWith('progress:')) return true;
    const current = this.store.db
      .prepare(
        'SELECT t.status,r.lease_id FROM tasks t JOIN task_runtime r ON r.task_id=t.id WHERE t.id=?',
      )
      .get(row.task_id) as { status: string; lease_id: string | null } | undefined;
    return (
      current?.status === 'running' &&
      current.lease_id === (JSON.parse(row.payload) as { leaseId: string }).leaseId
    );
  }
  private requiresAcceptance(row: Inbox) {
    if (!row.kind.startsWith('completion:') || !row.task_id || this.chainStopped(row)) return false;
    if (this.task(row, row.task_id).status !== 'reviewing') return false;
    const pendingChild = this.store.db
      .prepare(
        "SELECT 1 FROM task_workers w JOIN tasks t ON t.id=w.task_id WHERE w.parent_task_id=? AND t.status IN ('queued','running','cancelling','reviewing') LIMIT 1",
      )
      .get(row.task_id);
    const pendingDelegation = this.store.db
      .prepare(
        "SELECT 1 FROM bot_delegations WHERE task_id=? AND state IN ('offered','accepted','submitted') LIMIT 1",
      )
      .get(row.task_id);
    return !pendingChild && !pendingDelegation;
  }
  private async process(row: Inbox, signal: AbortSignal) {
    let turn: Turn | undefined;
    try {
      if (!this.active(row)) {
        this.store.db
          .prepare("UPDATE dialogue_inbox SET status='discarded' WHERE id=?")
          .run(row.id);
        return;
      }
      if (!this.currentProgress(row)) {
        this.store.db
          .prepare("UPDATE dialogue_inbox SET status='discarded' WHERE id=?")
          .run(row.id);
        return;
      }
      turn = this.store.db
        .prepare('SELECT * FROM coordinator_turns WHERE inbox_id=?')
        .get(row.id) as Turn | undefined;
      if (turn && (JSON.parse(turn.messages) as CoordinatorMessage[])[1]?.content) {
        const previous = JSON.parse(
          (JSON.parse(turn.messages) as CoordinatorMessage[])[1].content!,
        ) as { group?: { id: string } };
        if (previous.group?.id !== row.group_id) {
          turn.messages = JSON.stringify([
            ...this.context(row),
            ...(JSON.parse(turn.messages) as CoordinatorMessage[]).slice(2),
          ]);
          this.store.db
            .prepare('UPDATE coordinator_turns SET messages=? WHERE id=?')
            .run(turn.messages, turn.id);
        }
      }
      if (turn?.status === 'completed') {
        this.store.db
          .prepare("UPDATE dialogue_inbox SET status='delivered' WHERE id=?")
          .run(row.id);
        return;
      }
      if (!turn) {
        if (!(await this.shouldWake(row, signal))) {
          this.store.db
            .prepare("UPDATE dialogue_inbox SET status='ignored' WHERE id=?")
            .run(row.id);
          return;
        }
        if (signal.aborted) throw new Error('事件已让出处理');
        if (!this.active(row)) {
          this.store.db
            .prepare("UPDATE dialogue_inbox SET status='discarded' WHERE id=?")
            .run(row.id);
          return;
        }
        turn = {
          id: randomUUID(),
          messages: JSON.stringify(this.context(row)),
          status: 'running',
          rounds: 0,
        };
        this.store.db
          .prepare(
            'INSERT INTO coordinator_turns(id,inbox_id,bot_id,messages,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            turn.id,
            row.id,
            row.bot_id,
            turn.messages,
            new Date().toISOString(),
            new Date().toISOString(),
          );
      }
      const messages = JSON.parse(turn.messages) as CoordinatorMessage[];
      while (!this.closed) {
        // A result/stop may arrive while the model handles an older report.
        if (!this.active(row) || !this.currentProgress(row)) {
          this.store.db.transaction(() => {
            this.store.db
              .prepare("UPDATE dialogue_inbox SET status='discarded' WHERE id=?")
              .run(row.id);
            this.store.db
              .prepare("UPDATE coordinator_turns SET status='completed',updated_at=? WHERE id=?")
              .run(new Date().toISOString(), turn!.id);
          })();
          return;
        }
        const lastAssistant = messages.at(-1);
        // Persisted assistant tool requests are resumed before asking the model again.
        const pending =
          lastAssistant?.role === 'assistant' && lastAssistant.tool_calls?.length
            ? lastAssistant.tool_calls
            : undefined;
        if (pending) {
          for (const call of pending) {
            if (this.closed) return;
            const saved = this.store.db
              .prepare(
                'SELECT name,arguments,result FROM coordinator_calls WHERE turn_id=? AND call_id=?',
              )
              .get(turn.id, call.id) as
              { name: string; arguments: string; result: string } | undefined;
            if (
              saved &&
              (saved.name !== call.function.name || saved.arguments !== call.function.arguments)
            )
              throw new Error('调度调用标识冲突');
            let result = saved?.result;
            if (!result) {
              this.store.db.transaction(() => {
                try {
                  if (call.function.name === 'leave_group' && pending.length !== 1)
                    throw new Error('leave_group 必须单独调用，请先完成其他操作');
                  if (call.function.name === 'stay_silent' && pending.length !== 1)
                    throw new Error('stay_silent 结束本轮，必须单独调用；其他操作请先完成');
                  result = JSON.stringify(
                    this.store.db.transaction(() => this.execute(row, call))() ?? { ok: true },
                  );
                } catch (error) {
                  result = JSON.stringify({
                    error:
                      error instanceof z.ZodError
                        ? '工具参数不符合约定'
                        : error instanceof Error
                          ? error.message.slice(0, 500)
                          : '调度失败',
                  });
                }
                this.store.db
                  .prepare('INSERT INTO coordinator_calls VALUES(?,?,?,?,?,?)')
                  .run(
                    turn!.id,
                    call.id,
                    call.function.name,
                    call.function.arguments,
                    result,
                    new Date().toISOString(),
                  );
              })();
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: result! });
            if (
              (call.function.name === 'stay_silent' && JSON.parse(result!).silent === true) ||
              (call.function.name === 'leave_group' && JSON.parse(result!).endTurn === true)
            ) {
              this.store.db.transaction(() => {
                this.store.db
                  .prepare(
                    "UPDATE coordinator_turns SET messages=?,status='completed',updated_at=? WHERE id=?",
                  )
                  .run(JSON.stringify(messages), new Date().toISOString(), turn!.id);
                this.store.db
                  .prepare("UPDATE dialogue_inbox SET status='delivered' WHERE id=?")
                  .run(row.id);
              })();
              this.changed();
              return;
            }
          }
          this.store.db
            .prepare('UPDATE coordinator_turns SET messages=?,updated_at=? WHERE id=?')
            .run(JSON.stringify(messages), new Date().toISOString(), turn.id);
          this.changed();
        } else if (lastAssistant?.role === 'assistant') {
          if (this.requiresAcceptance(row)) {
            messages.push({
              role: 'user',
              content:
                '系统状态校验：本次执行结果仍处于待验收状态，尚未调用 finish_task。请依据已提供的真实证据调用 finish_task；证据不足则 read_task 或 continue_task。完成这个状态变更后再向用户交付，不能只用文字宣称完成。',
            });
            this.store.db
              .prepare('UPDATE coordinator_turns SET messages=?,updated_at=? WHERE id=?')
              .run(JSON.stringify(messages), new Date().toISOString(), turn.id);
          } else {
            this.store.db.transaction(() => {
              if (this.active(row)) this.publish(row, lastAssistant.content ?? '');
              this.store.db
                .prepare("UPDATE coordinator_turns SET status='completed',updated_at=? WHERE id=?")
                .run(new Date().toISOString(), turn!.id);
              this.store.db
                .prepare("UPDATE dialogue_inbox SET status='delivered' WHERE id=?")
                .run(row.id);
            })();
            return;
          }
        }
        if (turn.rounds >= maxRounds)
          throw new Error('这一轮处理已达到调度上限，已发起的工作仍会继续');
        // Do not let a transport adapter mutate the durable transcript by reference.
        messages.splice(0, 2, ...this.context(row));
        this.store.db
          .prepare('UPDATE coordinator_turns SET messages=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(messages), new Date().toISOString(), turn.id);
        const modelMessages = await this.workingContext.prepare(
          turn.id,
          {
            botId: row.bot_id,
            groupId: row.group_id,
            sourceMessageId: this.source(row).id,
            messageEvent: row.kind === 'message',
          },
          messages,
          signal,
          () => this.context(row),
        );
        if (!this.currentProgress(row) || !this.active(row)) continue;
        const response = await this.model(modelMessages, signal);
        if (this.closed) return;
        if (signal.aborted) throw new Error('事件已让出处理');
        messages.push(response);
        turn.rounds++;
        this.store.db
          .prepare('UPDATE coordinator_turns SET messages=?,rounds=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(messages), turn.rounds, new Date().toISOString(), turn.id);
      }
    } catch (error) {
      if (this.closed) return;
      if (signal.aborted) {
        this.store.db
          .prepare(
            "UPDATE attention_decisions SET attempts=MAX(0,attempts-1) WHERE inbox_id=? AND status='pending'",
          )
          .run(row.id);
        this.store.db.prepare("UPDATE dialogue_inbox SET status='queued' WHERE id=?").run(row.id);
        return;
      }
      this.store.db.transaction(() => {
        const detail = error instanceof Error ? error.message.slice(0, 500) : '对话处理失败';
        if (turn)
          this.store.db
            .prepare("UPDATE coordinator_turns SET status='failed',error=?,updated_at=? WHERE id=?")
            .run(detail, new Date().toISOString(), turn.id);
        this.store.db.prepare("UPDATE dialogue_inbox SET status='failed' WHERE id=?").run(row.id);
        // Broadcast recipients stay quiet on upstream failure; explicitly addressed work remains visible.
        if (this.active(row)) {
          const source = this.source(row);
          const direct = this.store
            .snapshot()
            .groups.find((g) => g.id === row.group_id)?.directBotId;
          if (row.kind.startsWith('completion:'))
            this.publish(
              row,
              `这项工作的执行已返回，但结果还没检查完。${this.task(row, row.task_id!).error ?? ''}`,
            );
          else if (row.kind === 'message' && (direct || source.mentions.includes(row.bot_id)))
            this.publish(row, '刚才没能完成这轮处理，已开始的工作记录仍然保留。');
        }
      })();
    } finally {
      for (const goal of this.goals.list(row.bot_id, row.group_id)) this.goals.reconcile(goal.id);
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.attentionTimer);
    this.controller.abort();
    await Promise.allSettled([...this.running.values(), this.curator?.close()]);
  }
}
