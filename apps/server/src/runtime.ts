import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import type {
  AgentJob,
  Approval,
  Bot,
  BridgeCommand,
  BridgeInfo,
  ExecutionPermissionMode,
  Message,
  NativeRequestSpec,
  Provider,
  Task,
} from '@openbot/shared';
import { resolveMentions } from '@openbot/shared';
import type { Store } from './store.js';
import { UiService, uiFromText } from './host/ui.js';
import { NativeRequests } from './host/native.js';
import { BotCoordinator, type WorkerOptions } from './bot/bot-coordinator.js';
import type { CoordinatorModel } from './models/coordinator-model.js';
import type { AttentionModel } from './models/attention-model.js';
import type { MemoryCuratorModel } from './memory/memory-curator.js';
import { TaskPipelines } from './work/task-pipelines.js';
import { TaskContracts } from './work/task-contracts.js';
import { TaskResources } from './work/task-resources.js';
import { WorkGoals } from './work/work-goals.js';
import { ProjectFacts, type ProjectFact } from './work/project-facts.js';
import { WorkArtifacts } from './work/work-artifacts.js';
import type { WorkArtifact } from '@openbot/shared';
import { BotDelegations } from './bot/bot-delegations.js';
type Link = { info: BridgeInfo; send: (command: BridgeCommand) => void; close: () => void };
export class Runtime {
  executionPermissionMode: ExecutionPermissionMode = 'auto';
  private links = new Map<string, Link>();
  private closed = false;
  private controller = new AbortController();
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<unknown>>();
  private cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly maxRounds: number;
  private conversations?: BotCoordinator;
  readonly ui: UiService;
  readonly native: NativeRequests;
  private pipelines: TaskPipelines;
  private contracts: TaskContracts;
  private resources: TaskResources;
  private goals: WorkGoals;
  private facts: ProjectFacts;
  private artifacts: WorkArtifacts;
  constructor(
    private store: Store,
    private changed: () => void,
    maxRounds = 6,
    private coordinator?: CoordinatorModel,
    private workerLimits = { perBot: 2, perBridge: 4 },
    private attention?: AttentionModel,
    private curation?: { model: MemoryCuratorModel; delayMs?: number },
  ) {
    this.maxRounds = maxRounds;
    this.pipelines = new TaskPipelines(store);
    this.contracts = new TaskContracts(store);
    this.resources = new TaskResources(store);
    this.goals = new WorkGoals(store);
    this.facts = new ProjectFacts(store);
    this.artifacts = new WorkArtifacts(store);
    this.ui = new UiService(store, changed, (message) => this.accept(message));
    this.native = new NativeRequests(store, changed, (taskId, leaseId, requestId, response) => {
      const botId = this.store.snapshot().tasks.find((t) => t.id === taskId)?.botId;
      const bot = this.store.snapshot().bots.find((b) => b.id === botId);
      const link = bot?.bridgeId ? this.links.get(bot.bridgeId) : undefined;
      if (!link || !this.running(link.info.id, taskId, leaseId))
        throw Object.assign(new Error('本地执行连接已断开，当前请求无法继续。'), {
          statusCode: 409,
        });
      link.send({ type: 'native_reply', taskId, leaseId, requestId, response });
    });
    if (coordinator) this.conversations = this.createCoordinator(coordinator);
  }
  private createCoordinator(model: CoordinatorModel) {
    return new BotCoordinator(
      this.store,
      () => {
        this.changed();
        this.schedule();
      },
      model,
      {
        create: (message, botId, goal, contextIds, options) => {
          const ids = this.enqueue(
            message,
            [botId],
            message.correlationId!,
            1,
            goal,
            contextIds,
            options,
          );
          return this.store.snapshot().tasks.find((t) => t.id === ids[0]);
        },
        change: (id, instruction, version, sourceId) =>
          this.changeTask(id, instruction, version, sourceId),
        stop: (id) => this.stopTask(id),
        continue: (id, message, version, provider) =>
          this.continueTask(id, message, version, provider),
        render: (message, botId, document) =>
          this.ui.publish(message.groupId, botId, document, message.id),
        published: (message) => this.accept(message),
        providers: (botId) => {
          const bot = this.store.snapshot().bots.find((b) => b.id === botId);
          return (
            (bot?.bridgeId ? this.links.get(bot.bridgeId)?.info.providers : [])
              ?.filter((p) => p.available && p.provider === bot?.provider)
              .map((p) => p.provider) ?? []
          );
        },
      },
      this.attention,
      this.curation,
    );
  }
  get hasCoordinator() {
    return Boolean(this.coordinator);
  }
  enableCoordinator(model: CoordinatorModel) {
    if (this.coordinator) return;
    this.coordinator = model;
    this.conversations = this.createCoordinator(model);
    this.conversations.start();
    this.watchdogTimer = setInterval(() => this.checkProgress(), 60000);
    this.watchdogTimer.unref();
  }
  start() {
    this.conversations?.start();
    if (this.coordinator) {
      this.watchdogTimer = setInterval(() => this.checkProgress(), 60000);
      this.watchdogTimer.unref();
    }
  }
  checkProgress(now = Date.now()) {
    if (!this.closed) this.conversations?.watchdog(now);
  }
  get bridges() {
    return [...this.links.values()].map((l) => l.info);
  }
  get brainState() {
    return {
      enabled: Boolean(this.coordinator),
      healthy: true,
    };
  }
  private note(
    groupId: string,
    content: string,
    correlationId: string | null,
    replyTo: string | null = null,
  ) {
    this.store.insertMessage({
      id: randomUUID(),
      groupId,
      senderId: 'system',
      senderType: 'system',
      content,
      mentions: [],
      replyTo,
      timestamp: new Date().toISOString(),
      messageType: 'status',
      correlationId,
    });
  }
  private ready(bot: Bot, provider?: Provider) {
    return Boolean(
      bot.bridgeId &&
      this.links
        .get(bot.bridgeId)
        ?.info.providers.some((p) => p.available && p.provider === (provider ?? bot.provider)),
    );
  }
  private availableBridges(provider: Provider) {
    return this.bridges.filter((bridge) =>
      bridge.providers.some((p) => p.provider === provider && p.available),
    );
  }
  creationBridge(provider: Provider, selected?: string): string | null {
    const available = this.availableBridges(provider);
    if (selected) {
      if (!available.some((bridge) => bridge.id === selected))
        throw Object.assign(new Error('所选设备的执行工具暂不可用，请重新选择'), {
          statusCode: 409,
        });
      return selected;
    }
    if (available.length > 1)
      throw Object.assign(new Error('有多台可用设备，请在创建时选择运行设备'), { statusCode: 409 });
    return available[0]?.id ?? null;
  }
  attach(info: BridgeInfo, send: Link['send'], close: Link['close']) {
    if (this.links.has(info.id)) throw new Error('Bridge 已连接，拒绝重复连接');
    this.links.set(info.id, { info, send, close });
    this.store.db.transaction(() => {
      for (const bot of this.store.snapshot().bots) {
        const available = bot.bridgeId ? [] : this.availableBridges(bot.provider);
        const bridgeId = bot.bridgeId ?? (available.length === 1 ? available[0].id : null);
        if (bridgeId && (!bot.bridgeId || bridgeId === info.id))
          this.store.db
            .prepare('UPDATE bots SET bridge_id=?,status=? WHERE id=?')
            .run(bridgeId, this.ready({ ...bot, bridgeId }) ? 'idle' : 'offline', bot.id);
      }
    })();
    this.changed();
    this.schedule();
  }
  detach(id: string) {
    if (this.closed) return;
    this.links.delete(id);
    const s = this.store.snapshot();
    this.store.db.transaction(() => {
      for (const b of s.bots.filter((b) => b.bridgeId === id)) {
        this.store.db.prepare("UPDATE bots SET status='offline' WHERE id=?").run(b.id);
        for (const t of s.tasks.filter(
          (t) => t.botId === b.id && ['running', 'cancelling'].includes(t.status),
        )) {
          this.clearCancel(t.id);
          this.store.db
            .prepare("UPDATE tasks SET status='failed',finished_at=?,error=? WHERE id=?")
            .run(
              new Date().toISOString(),
              'Bridge 连接中断，执行结果未知；未自动重跑，请确认后手动重试。',
              t.id,
            );
          this.store.db
            .prepare(
              "UPDATE task_approvals SET status='cancelled' WHERE task_id=? AND status='pending'",
            )
            .run(t.id);
          this.store.db
            .prepare(
              "UPDATE task_changes SET status='interrupted' WHERE task_id=? AND status IN ('pending','ready')",
            )
            .run(t.id);
          this.store.db
            .prepare(
              "UPDATE task_specs SET activity='连接中断，执行结果未知',updated_at=? WHERE task_id=?",
            )
            .run(new Date().toISOString(), t.id);
          if (this.coordinator) {
            this.store.db
              .prepare(
                "UPDATE worker_runs SET status='unknown',error='Bridge 连接中断，执行结果未知',finished_at=? WHERE task_id=? AND status IN ('running','cancelling')",
              )
              .run(new Date().toISOString(), t.id);
            const run = this.store.db
              .prepare(
                'SELECT id FROM worker_runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
              )
              .get(t.id) as { id: string } | undefined;
            if (run)
              this.conversations?.complete(
                this.store.snapshot().tasks.find((task) => task.id === t.id)!,
                run.id,
              );
          }
          this.note(
            t.groupId,
            '本地 Agent 连接中断，当前执行结果未知，未自动重跑。',
            t.correlationId,
          );
        }
      }
    })();
    this.changed();
  }
  bind(botId: string, bridgeId: string) {
    const bot = this.store.snapshot().bots.find((b) => b.id === botId);
    if (!bot) throw Object.assign(new Error('Bot 不存在'), { statusCode: 404 });
    this.configureExecution(botId, bot.provider, bridgeId);
  }
  configureExecution(botId: string, provider: Provider, selectedBridge?: string) {
    const bot = this.store.snapshot().bots.find((b) => b.id === botId);
    if (!bot) throw Object.assign(new Error('Bot 不存在'), { statusCode: 404 });
    if (
      this.store
        .snapshot()
        .tasks.some(
          (t) =>
            t.botId === botId &&
            ['queued', 'running', 'cancelling', 'reviewing'].includes(t.status),
        )
    )
      throw Object.assign(new Error('请先完成或停止当前任务，再修改执行设置'), { statusCode: 409 });
    const bridgeId = this.creationBridge(provider, selectedBridge);
    this.store.db.transaction(() => {
      if (bot.bridgeId !== bridgeId || bot.provider !== provider)
        this.store.db.prepare('DELETE FROM agent_sessions WHERE bot_id=?').run(botId);
      this.store.db
        .prepare('UPDATE bots SET bridge_id=?,provider=?,status=? WHERE id=?')
        .run(bridgeId, provider, bridgeId ? 'idle' : 'offline', botId);
    })();
    this.changed();
    this.schedule();
  }
  accept(message: Message) {
    const chain = message.correlationId ?? randomUUID();
    this.store.db
      .prepare('INSERT OR IGNORE INTO collaboration_chains(id,max_rounds) VALUES(?,?)')
      .run(chain, this.maxRounds);
    const directBotId = this.store
      .snapshot()
      .groups.find((g) => g.id === message.groupId)?.directBotId;
    if (this.coordinator) {
      const state = this.store.snapshot();
      const group = state.groups.find((g) => g.id === message.groupId);
      if (!group || message.senderType === 'system') return;
      if (message.senderType === 'human') {
        this.deliver(message, directBotId ? [directBotId] : group.botIds, chain);
      } else {
        const budget = this.store.db
          .prepare('SELECT stopped,max_calls,bot_wakes FROM collaboration_chains WHERE id=?')
          .get(chain) as { stopped: number; max_calls: number; bot_wakes: number };
        if (!budget.stopped && budget.bot_wakes < budget.max_calls)
          this.deliver(
            message,
            group.botIds.filter((id) => id !== message.senderId),
            chain,
          );
      }
      return;
    }
    if (directBotId && message.senderType === 'human') {
      this.deliver(message, [directBotId], chain);
      return;
    }
    if (message.mentions.length) this.deliver(message, message.mentions, chain);
  }
  private deliver(message: Message, ids: string[], chain: string) {
    if (!this.conversations) {
      this.enqueue(message, ids, chain, 1);
      return;
    }
    const group = this.store.snapshot().groups.find((g) => g.id === message.groupId);
    for (const id of new Set(ids))
      if (group?.botIds.includes(id)) this.conversations.receive(message, id);
    this.changed();
  }
  retryMessage(id: string, botId?: string) {
    const message = this.store
      .snapshot()
      .messages.find(
        (m) =>
          m.id === id && (m.senderType === 'human' || (this.coordinator && m.senderType === 'bot')),
      );
    if (!message) throw Object.assign(new Error('可重试的消息不存在'), { statusCode: 404 });
    if (!this.conversations) throw Object.assign(new Error('持续对话未启用'), { statusCode: 409 });
    const retried = this.conversations.retry(message, botId);
    if (retried) this.changed();
    return { ok: true, retried };
  }
  private enqueue(
    message: Message,
    ids: string[],
    chainId: string,
    round: number,
    goal?: string,
    contextIds: string[] = [],
    options?: WorkerOptions,
  ): string[] {
    const chain = this.store.db
      .prepare('SELECT * FROM collaboration_chains WHERE id=?')
      .get(chainId) as { stopped: number; calls: number; max_rounds: number; max_calls: number };
    if (!chain || chain.stopped) return [];
    const s = this.store.snapshot(),
      group = s.groups.find((g) => g.id === message.groupId);
    if (!group) return [];
    const targets = [...new Set(ids)]
      .map((id) => s.bots.find((b) => b.id === id))
      .filter((b): b is Bot =>
        Boolean(b && group.botIds.includes(b.id) && b.id !== message.senderId),
      );
    const executionProvider = new Map<Bot, Provider>();
    const online = targets.filter((b) => {
      const selected = options?.provider ?? b.provider;
      if (this.coordinator) {
        executionProvider.set(b, selected);
        return true;
      }
      if (selected && this.ready(b, selected)) {
        executionProvider.set(b, selected);
        return true;
      }
      return false;
    });
    const offline = targets.filter((b) => !online.includes(b));
    if (offline.length)
      this.note(
        group.id,
        `${offline.map((b) => b.name).join('、')} 暂时连不上本地，等连接恢复后再试。`,
        chainId,
        message.id,
      );
    if (!online.length) return [];
    if (round > chain.max_rounds || chain.calls + online.length > chain.max_calls) {
      this.store.db.prepare('UPDATE collaboration_chains SET stopped=1 WHERE id=?').run(chainId);
      this.note(group.id, `这轮讨论先停在这里，需要继续的话再告诉我。`, chainId);
      return [];
    }
    const created: string[] = [];
    for (const b of online) {
      const id = randomUUID();
      const ownedGoal = this.coordinator
        ? options?.goalId
          ? this.goals.get(options.goalId, b.id, group.id)
          : this.goals.create(
              message,
              b.id,
              goal ?? message.content,
              options?.criteria?.length ? options.criteria : [goal ?? message.content],
              { legacy: true },
            )
        : undefined;
      if (ownedGoal) this.goals.usable(ownedGoal);
      this.store.db
        .prepare(
          'INSERT INTO tasks(id,group_id,bot_id,input,status,created_at,correlation_id,round,goal_id) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          group.id,
          b.id,
          message.content,
          'queued',
          new Date().toISOString(),
          chainId,
          round,
          ownedGoal?.id ?? null,
        );
      this.store.db
        .prepare('INSERT INTO task_runtime(task_id,source_message_id) VALUES(?,?)')
        .run(id, message.id);
      this.store.db.prepare('INSERT INTO task_routes VALUES(?,?,?)').run(id, group.id, message.id);
      this.store.db
        .prepare('INSERT INTO task_conversations VALUES(?,?,?,?)')
        .run(id, group.id, message.id, new Date().toISOString());
      if (this.coordinator) {
        let resource = '*';
        if (options?.resourceKey && isAbsolute(options.resourceKey)) {
          resource = normalize(options.resourceKey);
          try {
            resource = realpathSync(resource);
            if (statSync(resource).isFile()) resource = dirname(resource);
          } catch {
            /* A nonexistent path remains an explicit resource claim. */
          }
        }
        this.store.db
          .prepare(
            'INSERT INTO task_workers(task_id,provider,resource_key,parent_task_id,silent,resource_mode,verify_artifact_ids) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            id,
            executionProvider.get(b) ?? options?.provider ?? b.provider,
            resource,
            options?.parentTaskId ?? null,
            options?.silent ? 1 : 0,
            options?.resourceMode ?? 'exclusive',
            JSON.stringify(options?.verifyArtifactIds ?? []),
          );
      }
      if (this.conversations) {
        const all = s.messages.filter((m) => m.groupId === group.id);
        const boundary = all.findIndex((m) => m.id === message.id);
        const before = all.slice(0, boundary + 1);
        const selected = new Set(contextIds.filter((id) => before.some((m) => m.id === id)));
        let replyTo = message.replyTo;
        for (let depth = 0; depth < 3 && replyTo; depth++) {
          const referenced = before.find((m) => m.id === replyTo);
          if (!referenced) break;
          selected.add(referenced.id);
          replyTo = referenced.replyTo;
        }
        selected.add(message.id);
        const context = before
          .filter((m) => selected.has(m.id) && m.senderType !== 'system')
          .map((m) => ({ ...m }));
        this.store.db
          .prepare(
            'INSERT INTO task_specs(task_id,goal,context_message_id,context,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(
            id,
            goal ?? message.content,
            message.id,
            JSON.stringify(context),
            new Date().toISOString(),
          );
      }
      created.push(id);
      if (this.coordinator) {
        const task = this.store.snapshot().tasks.find((t) => t.id === id)!;
        this.pipelines.assign(task, goal ?? message.content, options?.pipelineId);
        this.contracts.plan(
          task,
          { criteria: options?.criteria?.length ? options.criteria : [goal ?? message.content] },
          false,
        );
      }
    }
    this.store.db
      .prepare('UPDATE collaboration_chains SET calls=calls+? WHERE id=?')
      .run(online.length, chainId);
    this.schedule();
    return created;
  }
  private schedule() {
    queueMicrotask(() => {
      if (!this.closed) this.pump();
    });
  }
  private pump() {
    for (const bot of this.store.snapshot().bots) {
      for (const task of this.store
        .snapshot()
        .tasks.filter((t) => t.botId === bot.id && t.status === 'queued')) {
        const s = this.store.snapshot();
        const worker = this.store.db
          .prepare('SELECT provider,resource_key FROM task_workers WHERE task_id=?')
          .get(task.id) as { provider: Provider; resource_key: string } | undefined;
        const provider = worker?.provider ?? bot.provider;
        if (task.goalId && this.goals.get(task.goalId).ownerWait) continue;
        if (!this.ready(bot, provider)) continue;
        if (worker && this.pipelines.busy(task.id)) continue;
        if (this.coordinator && !this.contracts.canRun(task.id)) {
          this.store.db
            .prepare(
              "UPDATE tasks SET status='failed',error='任务已达到执行预算，需要用户明确调整计划',finished_at=? WHERE id=?",
            )
            .run(new Date().toISOString(), task.id);
          this.conversations?.complete(
            this.store.snapshot().tasks.find((t) => t.id === task.id)!,
            `budget:${randomUUID()}`,
          );
          this.changed();
          continue;
        }
        const active = s.tasks.filter((t) => ['running', 'cancelling'].includes(t.status));
        if (this.coordinator && this.resources.writerBusy(task, active)) continue;
        if (
          active.filter((t) => t.botId === bot.id).length >=
          (this.coordinator ? this.workerLimits.perBot : 1)
        )
          continue;
        if (this.coordinator) {
          const onDevice = active.filter(
            (t) => s.bots.find((b) => b.id === t.botId)?.bridgeId === bot.bridgeId,
          );
          if (onDevice.length >= this.workerLimits.perBridge) continue;
          const resource = worker?.resource_key ?? '*';
          const conflict = onDevice.some((t) => {
            if (this.resources.mode(task.id) === 'read' && this.resources.mode(t.id) === 'read')
              return false;
            const other = this.store.db
              .prepare('SELECT resource_key FROM task_workers WHERE task_id=?')
              .get(t.id) as { resource_key: string } | undefined;
            const path = other?.resource_key ?? '*';
            return (
              path === '*' ||
              resource === '*' ||
              path === resource ||
              path.startsWith(resource.endsWith(sep) ? resource : resource + sep) ||
              resource.startsWith(path.endsWith(sep) ? path : path + sep)
            );
          });
          if (conflict) continue;
        }
        const group = s.groups.find((g) => g.id === task.groupId);
        const chain = this.store.db
          .prepare('SELECT stopped FROM collaboration_chains WHERE id=?')
          .get(task.correlationId) as { stopped: number } | undefined;
        if (!group?.botIds.includes(bot.id) || chain?.stopped) {
          this.store.db
            .prepare("UPDATE tasks SET status='cancelled',finished_at=?,error=? WHERE id=?")
            .run(new Date().toISOString(), '群组成员已变更或协作已停止', task.id);
          this.changed();
          this.schedule();
          continue;
        }
        const meta = this.store.db
          .prepare('SELECT source_message_id AS sourceMessageId FROM task_runtime WHERE task_id=?')
          .get(task.id) as { sourceMessageId: string };
        if (this.coordinator) {
          try {
            this.resources.prepare(task);
          } catch (error) {
            this.store.db
              .prepare("UPDATE tasks SET status='failed',error=?,finished_at=? WHERE id=?")
              .run(
                error instanceof Error && error.message.includes('工作')
                  ? error.message.slice(0, 300)
                  : '无法建立独立工作副本，请核实 Git 项目与本地权限',
                new Date().toISOString(),
                task.id,
              );
            this.conversations?.complete(
              this.store.snapshot().tasks.find((t) => t.id === task.id)!,
              `workspace:${randomUUID()}`,
            );
            this.changed();
            continue;
          }
        }
        const spec = this.store.db
          .prepare('SELECT * FROM task_specs WHERE task_id=?')
          .get(task.id) as
          | {
              thread_id: string | null;
              context: string;
              goal: string;
              version: number;
            }
          | undefined;
        if (spec && this.coordinator) {
          const threadId =
            this.pipelines.session(task.id, provider, bot.bridgeId!)?.threadId ?? null;
          if (spec.thread_id !== threadId) {
            this.store.db
              .prepare('UPDATE task_specs SET thread_id=? WHERE task_id=?')
              .run(threadId, task.id);
            this.store.db.prepare('DELETE FROM task_session_delivery WHERE task_id=?').run(task.id);
            spec.thread_id = threadId;
          }
        }
        const session = spec
          ? spec.thread_id
            ? { threadId: spec.thread_id, lastMessageId: null }
            : undefined
          : (this.store.db
              .prepare(
                'SELECT thread_id AS threadId,last_message_id AS lastMessageId FROM agent_sessions WHERE bot_id=? AND group_id=?',
              )
              .get(bot.id, group.id) as AgentJob['session'] | undefined);
        const delivery = spec
          ? (this.store.db
              .prepare(
                'SELECT accepted_version FROM task_session_delivery WHERE task_id=? AND thread_id=?',
              )
              .get(task.id, spec.thread_id) as { accepted_version: number } | undefined)
          : undefined;
        const all = s.messages.filter((m) => m.groupId === group.id);
        const end = all.findIndex((m) => m.id === meta.sourceMessageId);
        const cursor = session?.lastMessageId
          ? all.findIndex((m) => m.id === session.lastMessageId)
          : -1;
        const messages = spec
          ? session && (delivery?.accepted_version ?? 0) > 0
            ? []
            : (JSON.parse(spec.context) as Message[])
          : all
              .slice(cursor + 1, end + 1)
              .filter((m) => m.senderType !== 'system')
              .slice(-24)
              .map((m) => ({ ...m, content: m.content.slice(0, 4000) }));
        const leaseId = randomUUID();
        let projectFacts: ProjectFact[] = [];
        let artifactsToVerify: WorkArtifact[] = [];
        try {
          this.store.db.transaction(() => {
            this.store.db
              .prepare(
                "UPDATE tasks SET status='running',started_at=? WHERE id=? AND status='queued'",
              )
              .run(new Date().toISOString(), task.id);
            this.store.db
              .prepare('UPDATE task_runtime SET lease_id=? WHERE task_id=?')
              .run(leaseId, task.id);
            this.store.db
              .prepare(
                'UPDATE task_health SET last_activity_at=?,last_heartbeat_at=NULL WHERE task_id=?',
              )
              .run(new Date().toISOString(), task.id);
            this.store.db.prepare("UPDATE bots SET status='thinking' WHERE id=?").run(bot.id);
            if (this.coordinator)
              this.store.db
                .prepare(
                  'INSERT INTO worker_runs(id,task_id,bot_id,bridge_id,provider,requirement_version,status,started_at,goal_version) VALUES(?,?,?,?,?,?,?,?,?)',
                )
                .run(
                  leaseId,
                  task.id,
                  bot.id,
                  bot.bridgeId,
                  provider,
                  spec?.version ?? 1,
                  'running',
                  new Date().toISOString(),
                  task.goalId ? this.goals.get(task.goalId).version : 1,
                );
            if (this.coordinator && task.goalId) {
              projectFacts = this.facts.capture(task.goalId, leaseId);
              const refs = this.store.db
                .prepare('SELECT verify_artifact_ids FROM task_workers WHERE task_id=?')
                .get(task.id) as { verify_artifact_ids: string };
              artifactsToVerify = this.artifacts.capture(
                JSON.parse(refs.verify_artifact_ids),
                leaseId,
                bot.id,
                task.groupId,
              );
            }
            if (spec) {
              this.store.db
                .prepare(
                  "UPDATE task_specs SET executed_version=version,activity='正在启动本地执行会话',report=NULL,updated_at=? WHERE task_id=?",
                )
                .run(new Date().toISOString(), task.id);
            }
          })();
        } catch (error) {
          this.store.db
            .prepare("UPDATE tasks SET status='failed',error=?,finished_at=? WHERE id=?")
            .run(
              error instanceof Error ? error.message.slice(0, 500) : '工作资料发生变化，请重新核实',
              new Date().toISOString(),
              task.id,
            );
          if (task.goalId)
            this.goals.attention(task.goalId, '执行资料或交付版本已变化，需要重新安排');
          this.conversations?.complete(
            this.store.snapshot().tasks.find((t) => t.id === task.id)!,
            `context:${randomUUID()}`,
          );
          this.changed();
          continue;
        }
        const currentTask = this.store.snapshot().tasks.find((t) => t.id === task.id)!;
        const job: AgentJob = {
          permissionMode: this.executionPermissionMode,
          executionDirectory: this.resources.directory(task.id),
          task: currentTask,
          projectFacts,
          artifactsToVerify,
          leaseId,
          bot: { ...bot, provider },
          group,
          members: s.bots
            .filter((b) => group.botIds.includes(b.id))
            .map((b) => ({ id: b.id, name: b.name, description: b.description })),
          messages,
          session: session ?? null,
          sourceMessageId: meta.sourceMessageId,
          acceptedVersion: delivery?.accepted_version ?? (spec ? 0 : session ? 1 : 0),
          ...(this.coordinator ? { resourceMode: this.resources.mode(task.id) } : {}),
        };
        try {
          this.links.get(bot.bridgeId!)!.send({ type: 'run', job });
        } catch {
          this.links.get(bot.bridgeId!)?.close();
        }
        this.changed();
      }
    }
  }
  private running(bridgeId: string, taskId: string, leaseId: string) {
    const s = this.store.snapshot(),
      task = s.tasks.find((t) => t.id === taskId);
    const bot = s.bots.find((b) => b.id === task?.botId);
    const meta = this.store.db
      .prepare('SELECT lease_id,source_message_id FROM task_runtime WHERE task_id=?')
      .get(taskId) as { lease_id: string; source_message_id: string } | undefined;
    return task &&
      bot?.bridgeId === bridgeId &&
      meta?.lease_id === leaseId &&
      ['running', 'cancelling'].includes(task.status)
      ? { task, bot, meta }
      : null;
  }
  event(
    bridgeId: string,
    event: {
      type: string;
      taskId: string;
      leaseId: string;
      threadId?: string;
      text?: string;
      report?: string;
      reportKind?: 'progress' | 'milestone' | 'blocked';
      status?: string;
      error?: string;
      requestId?: string;
      kind?: 'command' | 'file';
      detail?: Approval['detail'];
      request?: NativeRequestSpec;
    },
  ): void {
    this.store.db.transaction(() => this.applyEvent(bridgeId, event))();
  }
  private applyEvent(bridgeId: string, event: Parameters<Runtime['event']>[1]) {
    if (this.closed) return;
    const current = this.running(bridgeId, event.taskId, event.leaseId);
    if (!current) return;
    const { task, bot, meta } = current;
    if (event.type === 'heartbeat') {
      if (this.conversations) this.conversations.heartbeat(task.id);
      return;
    }
    if (event.type === 'report' && task.status === 'running') {
      const summary = (event.report ?? event.text ?? '').slice(0, 4000);
      this.store.db
        .prepare('UPDATE task_specs SET report=?,updated_at=? WHERE task_id=?')
        .run(summary, new Date().toISOString(), task.id);
      if (this.conversations)
        this.conversations.progress(task, event.leaseId, summary, event.reportKind);
      this.changed();
      return;
    }
    if (event.type === 'interaction' && event.requestId && event.request) {
      if (task.status === 'running')
        this.native.publish(task, event.leaseId, event.requestId, event.request);
      return;
    }
    if (['interaction_resolved', 'interaction_rejected'].includes(event.type) && event.requestId) {
      this.native.resolved(
        task.id,
        event.leaseId,
        event.requestId,
        event.type === 'interaction_rejected',
      );
      return;
    }
    if (event.type === 'started' && task.status === 'running') {
      this.store.db
        .prepare('UPDATE task_session_delivery SET accepted_version=? WHERE task_id=?')
        .run(task.execution?.executedVersion ?? 1, task.id);
      this.store.db
        .prepare("UPDATE task_changes SET status='accepted' WHERE task_id=? AND status='ready'")
        .run(task.id);
      this.store.db
        .prepare(
          "UPDATE task_specs SET activity='执行者已接收当前任务要求',updated_at=? WHERE task_id=?",
        )
        .run(new Date().toISOString(), task.id);
      this.changed();
      return;
    }
    if (event.type === 'session' && event.threadId) {
      if (this.coordinator)
        this.pipelines.remember(
          task.id,
          task.execution?.provider ?? bot.provider,
          bridgeId,
          event.threadId,
        );
      if (this.coordinator)
        this.store.db
          .prepare('UPDATE worker_runs SET thread_id=? WHERE id=?')
          .run(event.threadId, event.leaseId);
      if (task.execution) {
        this.store.db
          .prepare(
            'INSERT INTO task_session_delivery(task_id,thread_id,accepted_version) VALUES(?,?,0) ON CONFLICT(task_id) DO UPDATE SET accepted_version=CASE WHEN thread_id=excluded.thread_id THEN accepted_version ELSE 0 END,thread_id=excluded.thread_id',
          )
          .run(task.id, event.threadId);
        this.store.db
          .prepare('UPDATE task_specs SET thread_id=?,updated_at=? WHERE task_id=?')
          .run(event.threadId, new Date().toISOString(), task.id);
        return;
      }
      this.store.db
        .prepare(
          'INSERT INTO agent_sessions(bot_id,group_id,thread_id) VALUES(?,?,?) ON CONFLICT(bot_id,group_id) DO UPDATE SET thread_id=excluded.thread_id',
        )
        .run(bot.id, task.groupId, event.threadId);
      return;
    }
    if (event.type === 'progress' && task.status === 'running') {
      this.store.db
        .prepare('UPDATE tasks SET result=? WHERE id=?')
        .run((event.text ?? '').slice(0, 64000), task.id);
      this.store.db.prepare("UPDATE bots SET status='working' WHERE id=?").run(bot.id);
      if (event.text && event.text !== task.result && this.conversations) {
        this.store.db
          .prepare('UPDATE task_specs SET updated_at=? WHERE task_id=?')
          .run(new Date().toISOString(), task.id);
        this.conversations.progress(task, event.leaseId);
      }
      this.changed();
      return;
    }
    if (event.type === 'activity' && task.status === 'running') {
      this.store.db
        .prepare(
          'UPDATE task_specs SET activity=?,report=COALESCE(?,report),updated_at=? WHERE task_id=?',
        )
        .run(
          (event.text ?? '').slice(0, 2000),
          event.report?.slice(0, 4000) ?? null,
          new Date().toISOString(),
          task.id,
        );
      if (this.conversations) this.conversations.progress(task, event.leaseId, event.report);
      this.changed();
      return;
    }
    if (event.type === 'approval' && event.requestId && event.kind) {
      if (task.status === 'cancelling') return;
      const exists = this.store.db
        .prepare('SELECT id FROM task_approvals WHERE task_id=? AND request_id=?')
        .get(task.id, event.requestId);
      if (!exists)
        this.store.db
          .prepare(
            'INSERT INTO task_approvals(id,task_id,request_id,kind,detail,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            task.id,
            event.requestId,
            event.kind,
            JSON.stringify(event.detail ?? {}),
            new Date().toISOString(),
          );
      this.store.db
        .prepare('UPDATE task_specs SET activity=?,updated_at=? WHERE task_id=?')
        .run(
          event.kind === 'command' ? '等待所有者批准命令' : '等待所有者批准文件操作',
          new Date().toISOString(),
          task.id,
        );
      this.changed();
      return;
    }
    if (event.type !== 'result') return;
    if (this.coordinator) this.resources.inspect(task.id);
    if (this.coordinator)
      this.store.db
        .prepare('UPDATE worker_runs SET status=?,result=?,error=?,finished_at=? WHERE id=?')
        .run(
          ['completed', 'cancelled'].includes(event.status ?? '') ? event.status : 'failed',
          (event.text ?? '').slice(0, 64000),
          event.error ?? null,
          new Date().toISOString(),
          event.leaseId,
        );
    this.clearCancel(task.id);
    if (event.status === 'completed' && task.execution)
      this.store.db
        .prepare('UPDATE task_session_delivery SET accepted_version=? WHERE task_id=?')
        .run(task.execution.executedVersion ?? task.execution.version, task.id);
    const change = this.store.db
      .prepare(
        "SELECT * FROM task_changes WHERE task_id=? AND status='pending' ORDER BY version LIMIT 1",
      )
      .get(task.id) as { id: string; version: number; instruction: string } | undefined;
    if (change && event.status !== 'failed') {
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE task_changes SET status='ready' WHERE id=?").run(change.id);
        this.store.db
          .prepare(
            "UPDATE task_specs SET version=?,activity='旧执行已结束，等待按新要求续接',updated_at=? WHERE task_id=?",
          )
          .run(change.version, new Date().toISOString(), task.id);
        this.store.db
          .prepare(
            "UPDATE tasks SET status='queued',finished_at=NULL,result=NULL,error=NULL WHERE id=?",
          )
          .run(task.id);
        this.store.db
          .prepare(
            "UPDATE task_approvals SET status='cancelled' WHERE task_id=? AND status='pending'",
          )
          .run(task.id);
        this.store.db.prepare("UPDATE bots SET status='idle' WHERE id=?").run(bot.id);
        this.note(
          task.groupId,
          `${bot.name} 已停下刚才的操作，接下来按你补充的要求继续。`,
          task.correlationId,
        );
      })();
      this.changed();
      this.schedule();
      return;
    }
    if (event.status === 'failed')
      this.store.db
        .prepare(
          "UPDATE task_changes SET status='interrupted' WHERE task_id=? AND status IN ('pending','ready')",
        )
        .run(task.id);
    // A completion racing with stop is saved, but can never spawn a new turn in a stopped chain.
    const status =
      event.status === 'completed'
        ? this.coordinator
          ? task.status === 'cancelling'
            ? 'cancelled'
            : 'reviewing'
          : 'completed'
        : event.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    const text = (event.text ?? '').slice(0, 64000);
    const error = status === 'failed' ? (event.error ?? '执行失败').slice(0, 1000) : null;
    this.store.db.transaction(() => {
      this.store.db
        .prepare('UPDATE tasks SET status=?,finished_at=?,result=?,error=? WHERE id=?')
        .run(status, new Date().toISOString(), text || null, error, task.id);
      this.store.db
        .prepare('UPDATE bots SET status=? WHERE id=?')
        .run(
          this.coordinator &&
            this.store
              .snapshot()
              .tasks.some((t) => t.botId === bot.id && ['running', 'cancelling'].includes(t.status))
            ? 'working'
            : status === 'failed'
              ? 'error'
              : 'idle',
          bot.id,
        );
      this.store.db
        .prepare(
          "UPDATE task_approvals SET status='cancelled' WHERE task_id=? AND status='pending'",
        )
        .run(task.id);
      if (task.execution)
        this.store.db
          .prepare('UPDATE task_specs SET activity=?,updated_at=? WHERE task_id=?')
          .run(
            status === 'reviewing'
              ? '执行结果已返回，等待验收'
              : status === 'completed'
                ? '执行已完成'
                : status === 'cancelled'
                  ? '执行已停止'
                  : '执行失败',
            new Date().toISOString(),
            task.id,
          );
      let published = false;
      if (this.coordinator && this.conversations) {
        if (status === 'reviewing')
          this.store.db
            .prepare("UPDATE task_workers SET review='pending' WHERE task_id=?")
            .run(task.id);
        this.conversations.complete(
          this.store.snapshot().tasks.find((t) => t.id === task.id)!,
          event.leaseId,
        );
        return;
      }
      if (status === 'completed' && task.status !== 'cancelling') {
        try {
          const card = uiFromText(text);
          if (card) {
            const result = this.ui.publish(
              task.groupId,
              bot.id,
              card.document,
              meta.source_message_id,
            );
            if (card.content)
              this.store.db
                .prepare('UPDATE messages SET content=? WHERE id=?')
                .run(card.content, result.messageId);
            published = true;
          }
        } catch {
          /* Keep invalid card output available as text; never execute it. */
        }
      }
      if (task.execution && this.conversations) {
        const finished = this.store.snapshot().tasks.find((t) => t.id === task.id)!;
        if (!published && status === 'completed' && text.trim() && task.status !== 'cancelling') {
          const members =
            this.store.snapshot().groups.find((g) => g.id === task.groupId)?.botIds ?? [];
          const mentions = resolveMentions(text, this.store.snapshot().bots).filter(
            (id) => id !== bot.id && members.includes(id),
          );
          if (mentions.length) {
            // Preserve the original native output as the source of a deliberate bot handoff.
            const handoff: Message = {
              id: randomUUID(),
              groupId: task.groupId,
              senderId: bot.id,
              senderType: 'bot',
              content: text,
              mentions,
              replyTo: meta.source_message_id,
              timestamp: new Date().toISOString(),
              messageType: 'text',
              correlationId: task.correlationId,
            };
            this.store.insertMessage(handoff);
            published = true;
            this.enqueue(handoff, mentions, task.correlationId, task.round + 1);
          }
        }
        if (!published) this.conversations.complete(finished, event.leaseId);
        return;
      }
      if (status === 'completed') {
        this.store.db
          .prepare('UPDATE agent_sessions SET last_message_id=? WHERE bot_id=? AND group_id=?')
          .run(meta.source_message_id, bot.id, task.groupId);
        if (published) return;
        if (text.trim()) {
          const reply: Message = {
            id: randomUUID(),
            groupId: task.groupId,
            senderId: bot.id,
            senderType: 'bot',
            content: text,
            mentions: resolveMentions(text, this.store.snapshot().bots),
            replyTo: meta.source_message_id,
            timestamp: new Date().toISOString(),
            messageType: 'text',
            correlationId: task.correlationId,
          };
          this.store.insertMessage(reply);
          if (task.status !== 'cancelling')
            this.enqueue(reply, reply.mentions, task.correlationId, task.round + 1);
        } else this.note(task.groupId, '执行已结束，没有返回结果内容。', task.correlationId);
      } else
        this.note(
          task.groupId,
          status === 'cancelled'
            ? `${bot.name} 已经停下来了。`
            : `${bot.name} 这边遇到了问题：${error}`,
          task.correlationId,
        );
    })();
    this.changed();
    this.schedule();
  }
  taskStatus(id: string) {
    const task = this.store.snapshot().tasks.find((t) => t.id === id);
    if (!task) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    return { task, summary: formatTaskStatus(task) };
  }
  stopGoal(id: string) {
    const result = this.conversations
      ? this.conversations.stopGoal(id)
      : new BotDelegations(
          this.store,
          () => {},
          (taskId) => this.stopTask(taskId),
        ).cancelGoal(id);
    this.changed();
    this.schedule();
    return result;
  }
  resumeTask(id: string, instruction: string, expectedVersion: number) {
    const state = this.store.snapshot();
    const task = this.taskStatus(id).task;
    const latest = this.store.db
      .prepare(
        'SELECT status FROM worker_runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
      )
      .get(id) as { status: string } | undefined;
    if (task.status !== 'failed' || latest?.status !== 'unknown')
      throw Object.assign(new Error('只有执行结果未知的中断任务可以恢复'), { statusCode: 409 });
    if (!state.groups.some((g) => g.id === task.groupId && g.botIds.includes(task.botId)))
      throw Object.assign(new Error('Bot 已离开这项工作所属的群组'), { statusCode: 409 });
    const origin = this.store.db
      .prepare('SELECT source_message_id FROM task_runtime WHERE task_id=?')
      .get(id) as { source_message_id: string };
    const source = state.messages.find(
      (m) => m.id === origin.source_message_id && m.groupId === task.groupId,
    );
    if (!source)
      throw Object.assign(new Error('原始工作消息不可用，无法恢复'), { statusCode: 409 });
    this.store.db.transaction(() => {
      const chain = randomUUID();
      this.store.db
        .prepare('INSERT INTO collaboration_chains(id,max_rounds) VALUES(?,?)')
        .run(chain, this.maxRounds);
      this.continueTask(
        id,
        {
          ...source,
          correlationId: chain,
          content: `此前本地连接中断，执行结果尚未核实。先检查原会话、已有文件和实际完成情况，只继续未完成的部分，不要盲目重复已执行的操作。\n${instruction}`,
        },
        expectedVersion,
      );
    })();
    return this.taskStatus(id);
  }
  continueTask(id: string, message: Message, expectedVersion: number, provider?: Provider) {
    const task = this.taskStatus(id).task;
    if (task.goalId) {
      const goal = this.goals.get(task.goalId);
      if (!goal.legacy) this.goals.usable(goal);
    }
    if (this.coordinator) {
      const chain = this.store.db
        .prepare('SELECT stopped,calls,max_calls FROM collaboration_chains WHERE id=?')
        .get(message.correlationId) as
        { stopped: number; calls: number; max_calls: number } | undefined;
      if (!chain || chain.stopped || chain.calls >= chain.max_calls)
        throw Object.assign(new Error('本轮工作已停止或达到执行预算，需要新的明确要求再继续'), {
          statusCode: 409,
        });
    }
    if (
      !task.execution ||
      task.execution.version !== expectedVersion ||
      !['completed', 'failed', 'cancelled', ...(this.coordinator ? ['reviewing'] : [])].includes(
        task.status,
      ) ||
      (!this.coordinator && message.senderType !== 'human') ||
      message.groupId !== task.groupId
    )
      throw Object.assign(new Error('当前无法继续这段工作，请确认最新状态'), { statusCode: 409 });
    if (this.coordinator) {
      const contract = this.store.db
        .prepare(
          'SELECT max_runs,(SELECT count(*) FROM worker_runs WHERE task_id=?) AS runs FROM task_contracts WHERE task_id=?',
        )
        .get(id, id) as { max_runs: number; runs: number };
      if (contract.runs >= contract.max_runs)
        throw Object.assign(new Error('任务已达到执行预算，需要用户明确调整计划'), {
          statusCode: 409,
        });
    }
    const bot = this.store.snapshot().bots.find((b) => b.id === task.botId)!;
    const spec = this.store.db
      .prepare('SELECT thread_id FROM task_specs WHERE task_id=?')
      .get(id) as { thread_id: string | null };
    const worker = this.store.db
      .prepare('SELECT provider FROM task_workers WHERE task_id=?')
      .get(id) as { provider: Provider } | undefined;
    const selectedProvider = provider ?? worker?.provider ?? bot.provider;
    if ((!spec.thread_id && !this.coordinator) || !this.ready(bot, selectedProvider))
      throw Object.assign(new Error('原会话或本地连接暂不可用，请检查设备连接'), {
        statusCode: 409,
      });
    const last = this.store.db
      .prepare('SELECT MAX(version) AS version FROM task_changes WHERE task_id=?')
      .get(id) as { version: number | null };
    const version = Math.max(expectedVersion, last.version ?? 0) + 1;
    this.store.db.transaction(() => {
      if (this.coordinator) {
        // Provider-native histories cannot be resumed by a different provider.
        const targetSession = this.pipelines.session(id, selectedProvider, bot.bridgeId!);
        if (
          !spec.thread_id ||
          (worker?.provider ?? bot.provider) !== selectedProvider ||
          spec.thread_id !== targetSession?.threadId
        ) {
          const context = JSON.stringify([
            {
              ...message,
              content: `最新目标：${task.execution!.goal}\n上一执行结果（需要核实的交接材料）：\n${task.result ?? task.error ?? '无完整结果'}\n本轮要求：\n${message.content}`,
            },
          ]);
          this.store.db
            .prepare('UPDATE task_specs SET thread_id=?,context=? WHERE task_id=?')
            .run(targetSession?.threadId ?? null, context, id);
          this.store.db.prepare('DELETE FROM task_session_delivery WHERE task_id=?').run(id);
        }
        this.store.db
          .prepare(
            "UPDATE task_workers SET provider=?,review='pending',verification=NULL,stopped=0 WHERE task_id=?",
          )
          .run(selectedProvider, id);
      }
      this.store.db
        .prepare("UPDATE task_changes SET status='ready' WHERE task_id=? AND status='interrupted'")
        .run(id);
      this.store.db
        .prepare(
          "INSERT INTO task_changes(id,task_id,source_message_id,instruction,version,status,created_at) VALUES(?,?,?,?,?,'ready',?)",
        )
        .run(randomUUID(), id, message.id, message.content, version, new Date().toISOString());
      this.store.db
        .prepare('UPDATE task_specs SET version=?,updated_at=? WHERE task_id=?')
        .run(version, new Date().toISOString(), id);
      this.store.db
        .prepare(
          "UPDATE tasks SET status='queued',result=NULL,error=NULL,finished_at=NULL,correlation_id=?,round=1 WHERE id=?",
        )
        .run(message.correlationId, id);
      this.store.db
        .prepare('UPDATE task_runtime SET source_message_id=?,lease_id=NULL WHERE task_id=?')
        .run(message.id, id);
      this.store.db
        .prepare(
          'INSERT INTO task_routes VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET group_id=excluded.group_id,source_message_id=excluded.source_message_id',
        )
        .run(id, message.groupId, message.id);
      this.store.db
        .prepare(
          "UPDATE task_contracts SET state='active',next_wake_at=NULL,generation=generation+1,updated_at=? WHERE task_id=?",
        )
        .run(new Date().toISOString(), id);
      this.store.db
        .prepare('UPDATE collaboration_chains SET calls=calls+1 WHERE id=?')
        .run(message.correlationId);
      if (task.goalId)
        this.store.db
          .prepare(
            "UPDATE work_goals SET state='active',next_check_at=?,result=NULL WHERE id=? AND legacy=1",
          )
          .run(new Date(Date.now() + 300000).toISOString(), task.goalId);
    })();
    this.changed();
    this.schedule();
  }
  changeTask(id: string, instruction: string, expectedVersion: number, sourceId?: string) {
    const task = this.taskStatus(id).task;
    if (!task.execution || !['queued', 'running'].includes(task.status))
      throw Object.assign(new Error('任务当前无法调整，请先确认执行状态'), { statusCode: 409 });
    if (task.execution.version !== expectedVersion || task.execution.pendingChange)
      throw Object.assign(new Error('任务要求已变化或有未确认变更，请刷新后重试'), {
        statusCode: 409,
      });
    const version = expectedVersion + 1;
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO task_changes(id,task_id,source_message_id,instruction,version,status,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          id,
          sourceId ?? null,
          instruction,
          version,
          task.status === 'queued' ? 'ready' : 'pending',
          new Date().toISOString(),
        );
      if (task.status === 'queued')
        this.store.db
          .prepare('UPDATE task_specs SET version=?,updated_at=? WHERE task_id=?')
          .run(version, new Date().toISOString(), id);
      else this.cancelExecution(task);
    })();
    this.changed();
    this.schedule();
    return this.taskStatus(id);
  }
  stopTask(id: string) {
    const task = this.taskStatus(id).task;
    if (task.goalId) {
      const g = this.goals.get(task.goalId);
      if (!g.legacy) this.goals.attention(g.id, '本次执行已停止，请确认目标的下一步安排。');
      else
        this.store.db
          .prepare("UPDATE work_goals SET state='cancelled',next_check_at=NULL WHERE id=?")
          .run(g.id);
    }
    if (this.conversations) this.conversations.cancelDelegations(id);
    this.store.db
      .prepare('UPDATE task_workers SET stopped=1 WHERE task_id=? OR parent_task_id=?')
      .run(id, id);
    this.store.db
      .prepare(
        "UPDATE task_changes SET status='cancelled' WHERE task_id=? AND status IN ('pending','ready','interrupted')",
      )
      .run(id);
    if (['queued', 'reviewing'].includes(task.status))
      this.store.db
        .prepare("UPDATE tasks SET status='cancelled',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    else if (['running', 'cancelling'].includes(task.status)) this.cancelExecution(task);
    this.changed();
    this.schedule();
    for (const child of this.store.db
      .prepare('SELECT task_id FROM task_workers WHERE parent_task_id=?')
      .all(id) as { task_id: string }[])
      this.stopTask(child.task_id);
  }
  private cancelExecution(task: import('@openbot/shared').Task) {
    this.store.db.prepare("UPDATE tasks SET status='cancelling' WHERE id=?").run(task.id);
    this.store.db
      .prepare("UPDATE worker_runs SET status='cancelling' WHERE task_id=? AND status='running'")
      .run(task.id);
    this.store.db
      .prepare("UPDATE task_approvals SET status='cancelled' WHERE task_id=? AND status='pending'")
      .run(task.id);
    const bot = this.store.snapshot().bots.find((b) => b.id === task.botId)!;
    const meta = this.store.db
      .prepare('SELECT lease_id FROM task_runtime WHERE task_id=?')
      .get(task.id) as { lease_id: string };
    const link = this.links.get(bot.bridgeId!);
    try {
      link?.send({ type: 'cancel', taskId: task.id, leaseId: meta.lease_id });
    } catch {
      link?.close();
    }
    if (!this.cancelTimers.has(task.id))
      this.cancelTimers.set(
        task.id,
        setTimeout(() => {
          this.cancelTimers.delete(task.id);
          link?.close();
        }, 15000),
      );
  }
  approve(id: string, decision: 'accept' | 'decline') {
    const a = this.store.db.prepare('SELECT * FROM task_approvals WHERE id=?').get(id) as
      { task_id: string; request_id: string; status: string } | undefined;
    const task = this.store.snapshot().tasks.find((t) => t.id === a?.task_id);
    const bot = this.store.snapshot().bots.find((b) => b.id === task?.botId);
    if (!a || a.status !== 'pending' || task?.status !== 'running' || !bot?.bridgeId)
      throw Object.assign(new Error('审批已过期或任务已停止'), { statusCode: 409 });
    const meta = this.store.db
      .prepare('SELECT lease_id FROM task_runtime WHERE task_id=?')
      .get(task.id) as { lease_id: string };
    const link = this.links.get(bot.bridgeId);
    if (!link) throw Object.assign(new Error('本地执行未连接'), { statusCode: 409 });
    link.send({
      type: 'approval',
      taskId: task.id,
      leaseId: meta.lease_id,
      requestId: a.request_id,
      decision,
    });
    this.store.db
      .prepare('UPDATE task_approvals SET status=? WHERE id=?')
      .run(decision === 'accept' ? 'accepted' : 'declined', id);
    this.store.db
      .prepare('UPDATE task_specs SET activity=?,updated_at=? WHERE task_id=?')
      .run(
        decision === 'accept' ? '审批已通过，等待执行者继续' : '审批已拒绝，等待执行者处理',
        new Date().toISOString(),
        task.id,
      );
    this.changed();
  }
  stop(id: string) {
    const chain = this.store.db.prepare('SELECT id FROM collaboration_chains WHERE id=?').get(id);
    if (!chain) throw Object.assign(new Error('协作链不存在'), { statusCode: 404 });
    this.store.db.prepare('UPDATE collaboration_chains SET stopped=1 WHERE id=?').run(id);
    if (this.conversations)
      for (const task of this.store.snapshot().tasks.filter((t) => t.correlationId === id))
        this.conversations.cancelDelegations(task.id);
    this.store.db
      .prepare(
        'UPDATE task_workers SET stopped=1 WHERE task_id IN (SELECT id FROM tasks WHERE correlation_id=?)',
      )
      .run(id);
    this.store.db
      .prepare(
        "UPDATE task_changes SET status='cancelled' WHERE task_id IN (SELECT id FROM tasks WHERE correlation_id=?) AND status IN ('pending','ready','interrupted')",
      )
      .run(id);
    for (const t of this.store
      .snapshot()
      .tasks.filter(
        (t) =>
          t.correlationId === id &&
          ['queued', 'running', 'cancelling', 'reviewing'].includes(t.status),
      )) {
      if (['queued', 'reviewing'].includes(t.status)) {
        this.store.db
          .prepare("UPDATE tasks SET status='cancelled',finished_at=? WHERE id=?")
          .run(new Date().toISOString(), t.id);
        continue;
      }
      this.store.db.prepare("UPDATE tasks SET status='cancelling' WHERE id=?").run(t.id);
      this.store.db
        .prepare(
          "UPDATE task_approvals SET status='cancelled' WHERE task_id=? AND status='pending'",
        )
        .run(t.id);
      const bot = this.store.snapshot().bots.find((b) => b.id === t.botId)!;
      const meta = this.store.db
        .prepare('SELECT lease_id FROM task_runtime WHERE task_id=?')
        .get(t.id) as { lease_id: string };
      const link = this.links.get(bot.bridgeId!);
      link?.send({ type: 'cancel', taskId: t.id, leaseId: meta.lease_id });
      if (!this.cancelTimers.has(t.id))
        this.cancelTimers.set(
          t.id,
          setTimeout(() => {
            this.cancelTimers.delete(t.id);
            link?.close();
          }, 15000),
        );
    }
    this.changed();
  }
  private clearCancel(id: string) {
    clearTimeout(this.cancelTimers.get(id));
    this.cancelTimers.delete(id);
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    clearInterval(this.watchdogTimer);
    for (const t of this.cancelTimers.values()) clearTimeout(t);
    for (const l of this.links.values()) l.close();
    await this.conversations?.close();
    await Promise.allSettled([...this.pending]);
  }
}

function formatTaskStatus(task: Task) {
  const labels: Record<Task['status'], string> = {
    queued: '等待执行',
    running: '执行中',
    cancelling: '正在停止旧执行',
    reviewing: '正在检查结果',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
  };
  const e = task.execution;
  return [
    `任务 ${task.id.slice(0, 8)}：${task.input.slice(0, 180)}`,
    `状态：${labels[task.status]}`,
    e
      ? `要求版本：v${e.version}；本次执行：${e.executedVersion ? `v${e.executedVersion}` : '尚未开始'}`
      : '',
    e?.activity ? `当前活动：${e.activity}` : '',
    e?.report ? `最近汇报（执行者）：${e.report}` : '',
    e?.pendingChange ? '变更：已收到，等待旧执行停止确认后续接；尚未采纳。' : '',
    task.error ? `说明：${task.error}` : '',
    ['completed', 'failed', 'cancelled'].includes(task.status) && task.result
      ? `最近结果：${task.result.slice(-3000)}`
      : '',
    `记录更新时间：${e?.updatedAt ?? task.finishedAt ?? task.startedAt ?? task.createdAt}`,
  ]
    .filter(Boolean)
    .join('\n');
}
