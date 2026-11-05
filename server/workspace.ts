import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  CreateEmployee,
  CreateConversation,
  SendMessage,
  CreateTask,
  TaskAction,
  SaveModel,
  SaveExecution,
  CreateMemory,
  CreateRule,
  ExecutorStatusSchema,
  SnapshotSchema,
  type Employee,
  type Conversation,
  type Message,
  type Task,
  type Notice,
  type Snapshot,
  type Settings,
} from "../shared/domain.ts";
import { UpdateEmployee } from "../shared/relay.ts";
import { ExecutionLease } from "./lease.ts";
import type { Gateways, ModelInput, SecretProfile } from "./ports.ts";
import { log } from "./log.ts";
import { Store, secretsDigest, type Secrets, type State } from "./store.ts";

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
const now = () => new Date().toISOString();
function fail(status: number, code: string, message: string): never {
  throw new WorkspaceError(status, code, message);
}
const ModelReplySchema = z.object({
  text: z.string().max(100000),
  proposals: z
    .array(
      CreateTask.pick({
        title: true,
        instruction: true,
        criteria: true,
      }).extend({ employeeId: z.string().uuid().optional() }),
    )
    .max(10),
});
const ExecutionReplySchema = z.object({ text: z.string().max(1000000) });
const terminal = new Set(["completed", "cancelled", "failed"]);
const active = new Set(["queued", "running", "cancelling"]);
const errorSummary = (error: unknown) =>
  error instanceof WorkspaceError
    ? error.message
    : "外部调用失败，请检查供应商配置或执行器状态后重试。";

function employeeIn(state: State, id: string): Employee {
  return (
    state.employees.find((item) => item.id === id) ??
    fail(404, "EMPLOYEE_NOT_FOUND", "员工不存在。")
  );
}
function taskIn(state: State, id: string): Task {
  return (
    state.tasks.find((item) => item.id === id) ??
    fail(404, "TASK_NOT_FOUND", "任务不存在。")
  );
}
function conversationIn(state: State, id: string): Conversation {
  return (
    state.conversations.find((item) => item.id === id) ??
    fail(404, "CONVERSATION_NOT_FOUND", "会话不存在。")
  );
}
function notice(
  state: State,
  kind: Notice["kind"],
  title: string,
  taskId: string | null = null,
) {
  state.notices.push({
    id: randomUUID(),
    taskId,
    kind,
    title,
    read: false,
    createdAt: now(),
  });
}
function systemMessage(
  state: State,
  conversationId: string | null,
  content: string,
) {
  if (conversationId)
    state.messages.push({
      id: randomUUID(),
      conversationId,
      authorId: "system",
      content,
      mentions: [],
      createdAt: now(),
    });
}
function transition(task: Task, state: Task["state"]) {
  task.state = state;
  task.version++;
  task.updatedAt = now();
}

/** 门面只接收领域命令。模型不能批准任务，执行器只能消费已绑定的单次授权。 */
export class Workspace {
  private readonly store: Store;
  private readonly gateways: Gateways;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly jobs = new Map<
    string,
    {
      employeeId: string;
      runId: string;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  private readonly inboxJobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private ticking = false;
  private closing = false;
  private closed = false;
  private readonly lease?: ExecutionLease;
  private readonly removeLeaseListener?: () => void;

  constructor({ dataDir, gateways, lease }: {
    dataDir: string;
    gateways: Gateways;
    lease?: ExecutionLease;
  }) {
    this.store = new Store(dataDir);
    this.gateways = gateways;
    this.lease = lease;
    mkdirSync(join(this.store.dataDir, "tasks"), {
      recursive: true,
      mode: 0o700,
    });
    this.store.transaction((state) => {
      // 远程重启不能重付费处理已开始的消息；本地模式保留原恢复行为。
      for (const task of state.tasks) {
        if (task.state.kind === "running" || task.state.kind === "cancelling") {
          transition(task, {
            kind: "interrupted",
            reason:
              "服务重启，旧进程结果未知。请先核实旧进程和目录，再填写核实说明并恢复。",
          });
          task.approval = null;
          notice(state, "decision", `需核实中断任务：${task.title}`, task.id);
        } else if (task.state.kind === "queued") {
          transition(task, {
            kind: "needs_approval",
            reason: "服务重启，历史授权失效，请重新批准。",
          });
          task.approval = null;
        }
      }
      for (const item of state.inbox)
        if (item.state === "processing") {
          item.state = lease ? "failed" : "pending";
          if (lease) notice(state, "error", "消息处理在重启前未确认完成，未自动重试。请核实后发送新消息。");
        }
    });
    this.removeLeaseListener = lease?.onLost(() => this.interruptForLease());
    this.timer = setInterval(() => {
      void this.tick();
    }, 150);
    this.timer.unref();
  }

  remoteLease(): ExecutionLease | undefined {
    return this.lease;
  }

  publicationSecrets(): string[] {
    const secrets = this.store.secrets();
    return [secrets.main?.apiKey, secrets.attention?.apiKey]
      .filter((value): value is string => Boolean(value));
  }

  private interruptForLease(): void {
    if (this.closed) return;
    try {
      this.store.transaction((state) => {
        for (const task of state.tasks) {
          if (task.state.kind === "running" || task.state.kind === "cancelling") {
            transition(task, {
              kind: "interrupted",
              reason: "云端连接租约失效，已请求中断。请核实进程和目录后重新批准。",
            });
            task.approval = null;
            notice(state, "decision", `需核实连接中断任务：${task.title}`, task.id);
          } else if (task.state.kind === "queued") {
            transition(task, {
              kind: "needs_approval",
              reason: "云端连接租约失效，旧授权作废，请重新批准。",
            });
            task.approval = null;
          }
        }
        for (const item of state.inbox) {
          if (item.state !== "processing") continue;
          item.state = "failed";
          notice(state, "error", "连接中断时消息调用结果未知，未自动重试。请核实后发送新消息。");
        }
      });
    } finally {
      // 即使本地落盘失败也必须发送中止信号，不能继续持有外部执行权限。
      for (const job of this.jobs.values()) job.controller.abort();
      for (const job of this.inboxJobs.values()) job.controller.abort();
    }
  }

  async snapshot(): Promise<Snapshot> {
    const state = this.store.read();
    let executors: Snapshot["executors"];
    try {
      executors = z
        .array(ExecutorStatusSchema)
        .parse(await this.gateways.executors.status());
    } catch {
      log("error", "executor.status_failed");
      executors = ["codex", "claude-code"].map((executor) => ({
        executor: executor as Employee["executor"],
        available: false,
        detail: "执行器状态检查失败，未确认可用。",
      }));
    }
    return SnapshotSchema.parse({ ...state, executors });
  }

  createEmployee(input: z.infer<typeof CreateEmployee>): Employee {
    const parsed = CreateEmployee.parse(input);
    return this.store.transaction((state) => {
      if (
        state.employees.some(
          (item) =>
            item.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase(),
        )
      )
        fail(409, "DUPLICATE_EMPLOYEE", "员工名称已存在。");
      const employee: Employee = {
        ...parsed,
        id: randomUUID(),
        enabled: true,
        createdAt: now(),
      };
      state.employees.push(employee);
      return employee;
    });
  }

  updateEmployee(id: string, input: z.infer<typeof UpdateEmployee>): Employee {
    const parsed = UpdateEmployee.parse(input);
    return this.store.transaction((state) => {
      const employee = employeeIn(state, id);
      if (
        parsed.name &&
        state.employees.some(
          (item) =>
            item.id !== id &&
            item.name.toLocaleLowerCase() === parsed.name!.toLocaleLowerCase(),
        )
      )
        fail(409, "DUPLICATE_EMPLOYEE", "员工名称已存在。");
      if (
        parsed.executor &&
        parsed.executor !== employee.executor &&
        state.tasks.some(
          (task) =>
            task.employeeId === id &&
            (active.has(task.state.kind) || task.state.kind === "interrupted"),
        )
      )
        fail(409, "EMPLOYEE_BUSY", "员工有执行中或待核实任务，不能更换工具。");
      if (parsed.executor && parsed.executor !== employee.executor) {
        for (const task of state.tasks)
          if (task.employeeId === id && task.state.kind === "needs_approval")
            transition(task, {
              kind: "needs_approval",
              reason: "执行工具已变化，请重新检查授权范围。",
            });
      }
      Object.assign(employee, parsed);
      return employee;
    });
  }

  createConversation(input: z.infer<typeof CreateConversation>): Conversation {
    const parsed = CreateConversation.parse(input);
    return this.store.transaction((state) => {
      if (new Set(parsed.memberIds).size !== parsed.memberIds.length)
        fail(400, "DUPLICATE_MEMBER", "会话成员不能重复。");
      for (const id of parsed.memberIds) employeeIn(state, id);
      if (parsed.kind === "direct") {
        if (parsed.memberIds.length !== 1)
          fail(400, "DIRECT_MEMBER_COUNT", "私聊必须只有一名员工。");
        const existing = state.conversations.find(
          (item) =>
            item.kind === "direct" && item.memberIds[0] === parsed.memberIds[0],
        );
        if (existing) return existing;
      }
      const conversation = { ...parsed, id: randomUUID(), createdAt: now() };
      state.conversations.push(conversation);
      return conversation;
    });
  }

  sendMessage(
    conversationId: string,
    input: z.infer<typeof SendMessage>,
  ): Message {
    const parsed = SendMessage.parse(input);
    return this.store.transaction((state) => {
      const existing = state.messages.find(
        (message) => message.id === parsed.id,
      );
      if (existing) {
        if (
          existing.authorId !== "user" ||
          existing.conversationId !== conversationId ||
          existing.content !== parsed.content ||
          JSON.stringify([...existing.mentions].sort()) !==
            JSON.stringify([...parsed.mentions].sort())
        )
          fail(409, "MESSAGE_CONFLICT", "消息 ID 已用于不同内容。");
        return existing;
      }
      const conversation = conversationIn(state, conversationId);
      if (new Set(parsed.mentions).size !== parsed.mentions.length)
        fail(400, "DUPLICATE_MENTION", "提及员工不能重复。");
      for (const id of parsed.mentions) {
        const employee = employeeIn(state, id);
        const escapedName = employee.name.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        if (
          !conversation.memberIds.includes(id) ||
          !new RegExp(`@${escapedName}(?=$|[\\s,，。.!！?？:：;；])`, "u").test(
            parsed.content,
          )
        )
          fail(
            400,
            "INVALID_MENTION",
            "@ 提及必须出现在正文中，且员工必须属于本会话。",
          );
      }
      const message = {
        ...parsed,
        conversationId,
        authorId: "user",
        createdAt: now(),
      };
      state.messages.push(message);
      for (const employeeId of conversation.memberIds) {
        if (employeeIn(state, employeeId).enabled)
          state.inbox.push({
            id: randomUUID(),
            employeeId,
            messageId: message.id,
            state: "pending",
            createdAt: now(),
          });
      }
      return message;
    });
  }

  private addTask(state: State, parsed: z.infer<typeof CreateTask>): Task {
    const employee = employeeIn(state, parsed.employeeId);
    if (!employee.enabled) fail(409, "EMPLOYEE_DISABLED", "员工已停用。");
    let conversationId = parsed.conversationId;
    if (parsed.parentTaskId) {
      const parent = taskIn(state, parsed.parentTaskId);
      if (terminal.has(parent.state.kind))
        fail(409, "PARENT_FINISHED", "已结束的父任务不能继续委派。");
      if (conversationId && conversationId !== parent.conversationId)
        fail(400, "DELEGATION_CONVERSATION", "委派必须回传父任务原会话。");
      conversationId = parent.conversationId;
    }
    if (
      conversationId &&
      !conversationIn(state, conversationId).memberIds.includes(employee.id)
    )
      fail(400, "TASK_MEMBER", "任务负责人必须属于关联会话。");
    const id = randomUUID();
    const task: Task = {
      ...parsed,
      conversationId,
      id,
      state: {
        kind: "needs_approval",
        reason: "执行前需要你批准固定工具、模型和专用目录。",
      },
      version: 1,
      plan: [
        "确认任务要求与验收标准",
        "在专用目录执行并形成结果",
        "提交结果，等待人工验收",
      ],
      workspace: join(this.store.dataDir, "tasks", id),
      approval: null,
      createdAt: now(),
      updatedAt: now(),
    };
    state.tasks.push(task);
    notice(state, "decision", `待批准：${task.title}`, task.id);
    return task;
  }

  createTask(input: z.infer<typeof CreateTask>): Task {
    const parsed = CreateTask.parse(input);
    return this.store.transaction((state) => this.addTask(state, parsed));
  }

  async taskAction(
    id: string,
    input: z.infer<typeof TaskAction>,
  ): Promise<Task> {
    const parsed = TaskAction.parse(input);
    let statuses: z.infer<typeof ExecutorStatusSchema>[] = [];
    if (parsed.action === "approve") {
      this.lease?.assertValid();
      const current = this.store.read();
      const task = taskIn(current, id);
      if (task.version !== parsed.version)
        fail(409, "VERSION_CONFLICT", "任务已变化，请刷新后操作。");
      const employee = employeeIn(current, task.employeeId);
      try {
        statuses = z
          .array(ExecutorStatusSchema)
          .parse(await this.gateways.executors.status());
      } catch {
        log("error", "executor.approval_probe_failed");
        return fail(
          503,
          "EXECUTOR_UNAVAILABLE",
          "执行器检查失败，未批准任务。",
        );
      }
      if (
        !statuses.some(
          (status) => status.executor === employee.executor && status.available,
        )
      )
        fail(
          503,
          "EXECUTOR_UNAVAILABLE",
          "指定执行工具不可用，未批准任务，也不会替换工具。",
        );
    }
    if (parsed.action === "approve") this.lease?.assertValid();
    const task = this.store.transaction((state) => {
      const task = taskIn(state, id);
      if (task.version !== parsed.version)
        fail(409, "VERSION_CONFLICT", "任务已变化，请刷新后操作。");
      const kind = task.state.kind;
      switch (parsed.action) {
        case "approve": {
          if (kind !== "needs_approval")
            fail(409, "INVALID_TRANSITION", "只有待批准任务可以批准。");
          const employee = employeeIn(state, task.employeeId);
          if (!employee.enabled) fail(409, "EMPLOYEE_DISABLED", "员工已停用。");
          if (
            !statuses.some(
              (status) =>
                status.executor === employee.executor && status.available,
            )
          )
            fail(503, "EXECUTOR_UNAVAILABLE", "指定执行工具不可用。");
          if (
            state.tasks.some(
              (other) =>
                other.employeeId === employee.id &&
                other.state.kind === "interrupted",
            )
          )
            fail(
              409,
              "UNKNOWN_PROCESS",
              "该员工有结果未知的旧进程，必须先核实并恢复中断任务。",
            );
          const workspace = this.safeWorkspace(task);
          transition(task, { kind: "queued" });
          task.approval = {
            version: task.version,
            executor: employee.executor,
            model: state.settings.codexModel,
            workspace,
            scope: "workspace-write",
            approvedAt: now(),
            expiresAt: new Date(Date.now() + (this.lease ? 2 : 30) * 60_000).toISOString(),
          };
          break;
        }
        case "cancel":
          if (task.state.kind === "cancelling") return task;
          if (task.state.kind === "running")
            transition(task, { kind: "cancelling", runId: task.state.runId });
          else if (
            ["needs_approval", "queued", "needs_input", "review"].includes(kind)
          ) {
            transition(task, { kind: "cancelled" });
            task.approval = null;
          } else
            fail(
              409,
              "INVALID_TRANSITION",
              "当前任务不能取消；结果未知的进程必须先人工核实。",
            );
          break;
        case "accept": {
          if (task.state.kind !== "review")
            fail(409, "INVALID_TRANSITION", "只有待验收任务可以接受。");
          const artifactId = task.state.artifactId;
          const delivered = state.artifacts.find(
            (item) => item.id === artifactId,
          );
          if (!delivered) fail(409, "ARTIFACT_MISSING", "交付物不存在。");
          delivered.accepted = true;
          transition(task, { kind: "completed", artifactId });
          systemMessage(
            state,
            task.conversationId,
            `任务「${task.title}」已由你接受。此状态不代表独立验证或应用到其他项目。`,
          );
          break;
        }
        case "rework":
          if (kind !== "review")
            fail(409, "INVALID_TRANSITION", "只有待验收任务可以要求返工。");
          if (parsed.input?.trim())
            task.instruction += `\n\n人工返工要求：${parsed.input.trim()}`;
          task.approval = null;
          transition(task, {
            kind: "needs_approval",
            reason: "返工必须重新批准。",
          });
          break;
        case "resume":
          if (
            !["interrupted", "failed", "cancelled", "needs_input"].includes(
              kind,
            )
          )
            fail(409, "INVALID_TRANSITION", "当前任务不能恢复。");
          if (kind === "interrupted" && !parsed.input?.trim())
            fail(
              400,
              "VERIFICATION_REQUIRED",
              "恢复前请填写旧进程已停止和目录已核实的说明。",
            );
          if (parsed.input?.trim())
            task.instruction += `\n\n人工恢复说明：${parsed.input.trim()}`;
          task.approval = null;
          transition(task, {
            kind: "needs_approval",
            reason: "恢复不重用旧授权，请重新批准。",
          });
          break;
      }
      return task;
    });
    if (task.state.kind === "cancelling") this.jobs.get(id)?.controller.abort();
    return task;
  }

  saveModel(input: z.infer<typeof SaveModel>): Settings {
    const parsed = SaveModel.parse(input);
    const endpoint = new URL(parsed.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      fail(
        400,
        "UNSAFE_ENDPOINT",
        "模型地址必须使用 HTTPS，不能含凭据、查询参数或片段。",
      );
    const current = this.store.read();
    let secrets: Secrets = { main: null, attention: null };
    let consistent = false;
    try {
      const saved = this.store.secrets();
      consistent =
        current.secretsDigest === secretsDigest(saved) ||
        (current.secretsDigest === null && !saved.main && !saved.attention);
      if (consistent) secrets = saved;
    } catch {
      log("error", "settings.secret_file_invalid");
    }
    // 不一致时禁止继承磁盘密钥，显式重存会清除未重新确认的另一份配置。
    const previous = secrets[parsed.purpose];
    const sameDestination =
      previous?.provider === parsed.provider &&
      previous.endpoint === parsed.endpoint;
    const apiKey =
      parsed.apiKey !== undefined
        ? parsed.apiKey
        : sameDestination
          ? previous!.apiKey
          : "";
    if (!apiKey)
      fail(
        400,
        "KEY_REQUIRED",
        "请填写 API Key；更换供应商或地址不能沿用旧密钥。",
      );
    const profile = {
      provider: parsed.provider,
      endpoint: parsed.endpoint,
      model: parsed.model,
      thinking: parsed.thinking,
      apiKey,
    };
    secrets[parsed.purpose] = profile;
    this.store.saveSecrets(secrets);
    return this.store.transaction((state) => {
      if (!consistent) {
        state.settings.main = null;
        state.settings.attention = null;
      }
      state.secretsDigest = secretsDigest(secrets);
      state.settings[parsed.purpose] = {
        provider: profile.provider,
        endpoint: profile.endpoint,
        model: profile.model,
        thinking: profile.thinking,
        hasKey: true,
      };
      return state.settings;
    });
  }

  saveExecution(input: z.infer<typeof SaveExecution>): Settings {
    const parsed = SaveExecution.parse(input);
    return this.store.transaction((state) => {
      if (state.settings.codexModel !== parsed.codexModel) {
        for (const task of state.tasks)
          if (
            task.state.kind === "queued" ||
            task.state.kind === "needs_approval"
          ) {
            task.approval = null;
            transition(task, {
              kind: "needs_approval",
              reason: "执行模型配置变化，需要重新批准。",
            });
          }
      }
      Object.assign(state.settings, parsed);
      return state.settings;
    });
  }

  createMemory(input: z.infer<typeof CreateMemory>) {
    const parsed = CreateMemory.parse(input);
    return this.store.transaction((state) => {
      employeeIn(state, parsed.employeeId);
      const memory = { ...parsed, id: randomUUID(), createdAt: now() };
      state.memories.push(memory);
      return memory;
    });
  }
  deleteMemory(id: string): { ok: true } {
    return this.store.transaction((state) => {
      if (!state.memories.some((item) => item.id === id))
        fail(404, "MEMORY_NOT_FOUND", "记忆不存在。");
      state.memories = state.memories.filter((item) => item.id !== id);
      return { ok: true };
    });
  }
  createRule(input: z.infer<typeof CreateRule>) {
    const parsed = CreateRule.parse(input);
    return this.store.transaction((state) => {
      employeeIn(state, parsed.employeeId);
      const rule = {
        ...parsed,
        id: randomUUID(),
        enabled: true,
        nextRunAt: new Date(
          Date.now() + parsed.intervalMinutes * 60_000,
        ).toISOString(),
        createdAt: now(),
      };
      state.rules.push(rule);
      return rule;
    });
  }
  updateRule(id: string, input: { enabled: boolean }) {
    const parsed = z.object({ enabled: z.boolean() }).strict().parse(input);
    return this.store.transaction((state) => {
      const rule =
        state.rules.find((item) => item.id === id) ??
        fail(404, "RULE_NOT_FOUND", "规则不存在。");
      rule.enabled = parsed.enabled;
      if (parsed.enabled)
        rule.nextRunAt = new Date(
          Date.now() + rule.intervalMinutes * 60_000,
        ).toISOString();
      return rule;
    });
  }
  readNotice(id: string): { ok: true } {
    return this.store.transaction((state) => {
      const item =
        state.notices.find((item) => item.id === id) ??
        fail(404, "NOTICE_NOT_FOUND", "通知不存在。");
      item.read = true;
      return { ok: true };
    });
  }

  private safeWorkspace(task: Task): string {
    const root = join(this.store.dataDir, "tasks");
    const expected = join(root, task.id);
    if (task.workspace !== expected || resolve(expected) !== expected)
      fail(409, "UNSAFE_WORKSPACE", "任务目录不符合专用目录约束。");
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root)
      fail(409, "UNSAFE_WORKSPACE", "任务根目录不能是符号链接。");
    mkdirSync(expected, { recursive: true, mode: 0o700 });
    if (
      lstatSync(expected).isSymbolicLink() ||
      realpathSync(expected) !== expected
    )
      fail(409, "UNSAFE_WORKSPACE", "任务目录不能是符号链接。");
    return expected;
  }

  private profile(purpose: "main" | "attention"): SecretProfile {
    const state = this.store.read();
    const target =
      purpose === "attention" && state.settings.attentionUseMain
        ? "main"
        : purpose;
    let secrets: Secrets;
    try {
      secrets = this.store.secrets();
    } catch {
      log("error", "settings.secret_file_decode_failed");
      return fail(
        503,
        "SECRET_CONFIG_MISMATCH",
        "模型凭据文件与设置不一致，已阻止发送；请重新填写密钥并保存模型设置。",
      );
    }
    const initialEmpty =
      state.secretsDigest === null && !secrets.main && !secrets.attention;
    if (!initialEmpty && state.secretsDigest !== secretsDigest(secrets))
      fail(
        503,
        "SECRET_CONFIG_MISMATCH",
        "模型凭据文件与设置不一致，已阻止发送；请重新填写密钥并保存模型设置。",
      );
    const profile = secrets[target];
    if (!profile?.apiKey)
      fail(
        503,
        "MODEL_NOT_CONFIGURED",
        `${target === "main" ? "主会话" : "注意力"}模型未配置有效密钥。`,
      );
    return profile;
  }

  private async tick(): Promise<void> {
    if (this.closing || this.ticking || (this.lease && !this.lease.valid)) return;
    this.ticking = true;
    try {
      this.observeRules();
      this.scheduleInbox();
      await this.scheduleTasks();
    } catch (error) {
      // 日志不包含外部错误原文，避免供应商把密钥或提示词写回异常。
      log("error", "scheduler.failed", {
        code: error instanceof WorkspaceError ? error.code : "INTERNAL_ERROR",
      });
    } finally {
      this.ticking = false;
    }
  }

  private observeRules(): void {
    const current = this.store.read();
    if (
      !current.rules.some(
        (rule) => rule.enabled && Date.parse(rule.nextRunAt) <= Date.now(),
      )
    )
      return;
    this.store.transaction((state) => {
      for (const rule of state.rules) {
        if (!rule.enabled || Date.parse(rule.nextRunAt) > Date.now()) continue;
        rule.nextRunAt = new Date(
          Date.now() + rule.intervalMinutes * 60_000,
        ).toISOString();
        if (!employeeIn(state, rule.employeeId).enabled) continue;
        if (rule.mode === "observe")
          notice(
            state,
            "observation",
            `规则「${rule.name}」到达观察时间。未执行外部检查或本机操作。`,
          );
        else {
          // 一个规则已有未结束提案时不重复堆积审批。
          const title = `规则提案：${rule.name}`;
          const linkedTaskIds = new Set(
            state.ruleTaskLinks
              .filter((link) => link.ruleId === rule.id)
              .map((link) => link.taskId),
          );
          if (
            !state.tasks.some(
              (task) =>
                linkedTaskIds.has(task.id) && !terminal.has(task.state.kind),
            )
          ) {
            const task = this.addTask(
              state,
              CreateTask.parse({
                title,
                instruction: rule.instruction,
                employeeId: rule.employeeId,
              }),
            );
            state.ruleTaskLinks.push({ ruleId: rule.id, taskId: task.id });
          }
        }
      }
    });
  }

  private scheduleInbox(): void {
    const state = this.store.read();
    for (const item of state.inbox) {
      if (this.lease && !this.lease.valid) return;
      if (item.state !== "pending" || this.inboxJobs.has(item.employeeId))
        continue;
      const controller = new AbortController();
      this.store.transaction((current) => {
        const next = current.inbox.find((row) => row.id === item.id)!;
        next.state = "processing";
      });
      const promise = this.processInbox(item.id, controller.signal).finally(
        () => this.inboxJobs.delete(item.employeeId),
      );
      this.inboxJobs.set(item.employeeId, { controller, promise });
    }
  }

  private async processInbox(id: string, signal: AbortSignal): Promise<void> {
    const state = this.store.read();
    const item = state.inbox.find((row) => row.id === id)!;
    const message = state.messages.find((row) => row.id === item.messageId)!;
    const employee = employeeIn(state, item.employeeId);
    const conversation = conversationIn(state, message.conversationId);
    try {
      if (!employee.enabled) {
        this.finishInbox(id);
        return;
      }
      const direct =
        conversation.kind === "direct" ||
        message.mentions.includes(employee.id);
      if (!direct && employee.attentionMode !== "auto") {
        this.finishInbox(id);
        return;
      }
      const memories = state.memories
        .filter((memory) => memory.employeeId === employee.id)
        .map((memory) => `- ${memory.content}`)
        .join("\n");
      const input: ModelInput = {
        system: `你是${employee.name}，职责：${employee.role}。你只负责对话和提出任务建议，不能执行工具，也不能批准任务。任务建议必须等待用户审批。群内其他员工为：${conversation.memberIds
          .map((memberId) => {
            const member = employeeIn(state, memberId);
            return `${member.name} (${member.id})`;
          })
          .join(
            "、",
          )}。\n用户手动保存的该员工长期记忆：\n${memories || "暂无。"}`,
        messages: state.messages
          .slice(
            0,
            state.messages.findIndex((row) => row.id === message.id) + 1,
          )
          .filter((row) => row.conversationId === conversation.id)
          .slice(-40)
          .map((row) => ({
            role: row.authorId === employee.id ? "assistant" : "user",
            content:
              row.authorId === "system"
                ? `[系统记录] ${row.content}`
                : row.content,
          })),
      };
      if (!direct) {
        const profile = this.profile("attention");
        this.lease?.assertValid(signal);
        const shouldRespond = z
          .boolean()
          .parse(
            await this.gateways.models.attention(
              profile,
              input,
              signal,
              () => this.lease?.assertValid(signal),
            ),
          );
        this.lease?.assertValid(signal);
        if (!shouldRespond) {
          this.finishInbox(id);
          return;
        }
      }
      const profile = this.profile("main");
      this.lease?.assertValid(signal);
      const reply = ModelReplySchema.parse(
        await this.gateways.models.respond(
          profile, input, signal, () => this.lease?.assertValid(signal),
        ),
      );
      this.lease?.assertValid(signal);
      if (signal.aborted || this.closed) return;
      this.store.transaction((current) => {
        const pending = current.inbox.find((row) => row.id === id)!;
        if (pending.state !== "processing") return;
        for (const proposal of reply.proposals) {
          const employeeId = proposal.employeeId ?? employee.id;
          if (!conversation.memberIds.includes(employeeId))
            fail(
              400,
              "PROPOSAL_MEMBER",
              "模型提出了群成员以外的负责人，提案未保存。",
            );
          this.addTask(
            current,
            CreateTask.parse({
              ...proposal,
              employeeId,
              conversationId: conversation.id,
            }),
          );
        }
        if (reply.text.trim())
          current.messages.push({
            id: randomUUID(),
            conversationId: conversation.id,
            authorId: employee.id,
            content: reply.text,
            mentions: [],
            createdAt: now(),
          });
        pending.state = "done";
      });
    } catch (error) {
      if (this.closed || (this.lease && !this.lease.valid) || signal.aborted) return;
      log("error", "message.failed", {
        code: error instanceof WorkspaceError ? error.code : "MODEL_ERROR",
      });
      this.store.transaction((current) => {
        const pending = current.inbox.find((row) => row.id === id)!;
        pending.state = "failed";
        const text = `${employee.name}未能处理消息：${errorSummary(error)}`;
        systemMessage(current, conversation.id, text);
        notice(current, "error", text);
      });
    }
  }

  private finishInbox(id: string): void {
    if (this.closed) return;
    this.store.transaction((state) => {
      const item = state.inbox.find((row) => row.id === id);
      if (item) item.state = "done";
    });
  }

  private async scheduleTasks(): Promise<void> {
    let state = this.store.read();
    const queued = state.tasks.filter((task) => task.state.kind === "queued");
    if (!queued.length) return;
    const statuses = z
      .array(ExecutorStatusSchema)
      .parse(await this.gateways.executors.status());
    if (this.closing || (this.lease && !this.lease.valid)) return;
    for (const original of queued) {
      if (this.lease && !this.lease.valid) return;
      state = this.store.read();
      if (this.jobs.size >= state.settings.maxWorkers) break;
      const task = taskIn(state, original.id);
      if (
        task.state.kind !== "queued" ||
        [...this.jobs.values()].some(
          (job) => job.employeeId === task.employeeId,
        )
      )
        continue;
      const employee = employeeIn(state, task.employeeId);
      const approval = task.approval;
      if (
        !approval ||
        approval.version !== task.version ||
        approval.expiresAt <= now() ||
        approval.executor !== employee.executor ||
        approval.model !== state.settings.codexModel ||
        !employee.enabled ||
        state.tasks.some(
          (other) =>
            other.employeeId === employee.id &&
            other.state.kind === "interrupted",
        )
      ) {
        this.store.transaction((current) => {
          const pending = taskIn(current, task.id);
          transition(pending, {
            kind: "needs_approval",
            reason:
              "授权过期、配置变化、员工停用或旧进程待核实，需要重新批准。",
          });
          pending.approval = null;
        });
        continue;
      }
      if (
        !statuses.some(
          (status) => status.executor === approval.executor && status.available,
        )
      ) {
        this.store.transaction((current) => {
          const pending = taskIn(current, task.id);
          transition(pending, {
            kind: "needs_approval",
            reason: "指定执行工具不可用，需要恢复工具后重新批准。",
          });
          pending.approval = null;
          notice(
            current,
            "error",
            `执行工具不可用：${pending.title}`,
            pending.id,
          );
        });
        continue;
      }
      try {
        this.safeWorkspace(task);
      } catch (error) {
        this.store.transaction((current) => {
          const pending = taskIn(current, task.id);
          transition(pending, { kind: "failed", error: errorSummary(error) });
          pending.approval = null;
          notice(
            current,
            "error",
            `任务目录校验失败：${pending.title}`,
            pending.id,
          );
        });
        continue;
      }
      const controller = new AbortController();
      const runId = randomUUID();
      this.store.transaction((current) =>
        transition(taskIn(current, task.id), { kind: "running", runId }),
      );
      const promise = this.executeTask(task, runId, controller.signal).finally(
        () => this.jobs.delete(task.id),
      );
      this.jobs.set(task.id, {
        employeeId: task.employeeId,
        runId,
        controller,
        promise,
      });
    }
  }

  private async executeTask(
    task: Task,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const approval = task.approval!;
      this.lease?.assertValid(signal);
      log("info", "task.started", { taskId: task.id });
      const request = {
        executor: approval.executor,
        workspace: approval.workspace,
        instruction: `${task.instruction}\n\n验收标准：\n${task.criteria.map((item) => `- ${item}`).join("\n") || "按任务要求提交可供人工检查的结果。"}\n\n只在本任务专用目录中工作。不得自行扩大权限。`,
        model: approval.model,
        signal,
        beforeStart: () => this.lease?.assertValid(signal),
      };
      const result = ExecutionReplySchema.parse(
        await this.gateways.executors.run(request),
      );
      if (this.closed) return;
      // 休眠恢复时结果可能早于到期定时器到达，落盘前仍需同步核对授权。
      this.lease?.assertValid();
      this.store.transaction((state) => {
        const current = taskIn(state, task.id);
        if (
          (current.state.kind !== "running" &&
            current.state.kind !== "cancelling") ||
          current.state.runId !== runId
        )
          return;
        if (current.state.kind === "cancelling") {
          transition(current, { kind: "cancelled" });
          current.approval = null;
          return;
        }
        const artifact = {
          id: randomUUID(),
          taskId: task.id,
          title: `${task.title} · 执行结果`,
          content: result.text,
          digest: createHash("sha256").update(result.text).digest("hex"),
          accepted: false,
          createdAt: now(),
        };
        state.artifacts.push(artifact);
        transition(current, { kind: "review", artifactId: artifact.id });
        notice(state, "result", `待验收：${task.title}`, task.id);
        systemMessage(
          state,
          current.conversationId,
          `任务「${task.title}」已提交执行结果，等待你验收。结果未被独立验证，也未自动应用到其他项目。`,
        );
      });
      log("info", "task.returned", { taskId: task.id });
    } catch (error) {
      if (this.closed || (this.lease && !this.lease.valid)) return;
      log("error", "task.execution_failed", {
        taskId: task.id,
        code: signal.aborted ? (this.lease && !this.lease.valid ? "LEASE_LOST" : "CANCEL_REQUESTED") : "EXECUTION_ERROR",
      });
      this.store.transaction((state) => {
        const current = taskIn(state, task.id);
        if (
          (current.state.kind !== "running" &&
            current.state.kind !== "cancelling") ||
          current.state.runId !== runId
        )
          return;
        const confirmedAbort =
          error instanceof Error && error.name === "AbortError";
        const unknownProcess =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "UNKNOWN_PROCESS";
        if (current.state.kind === "cancelling" && confirmedAbort)
          transition(current, { kind: "cancelled" });
        else if (current.state.kind === "cancelling" || unknownProcess) {
          transition(current, {
            kind: "interrupted",
            reason: "无法确认执行进程已经退出，请人工核实进程和任务目录。",
          });
          notice(state, "decision", `需核实执行进程：${task.title}`, task.id);
        } else {
          transition(current, { kind: "failed", error: errorSummary(error) });
          notice(state, "error", `任务失败：${task.title}`, task.id);
          systemMessage(
            state,
            current.conversationId,
            `任务「${task.title}」执行失败。${errorSummary(error)}`,
          );
        }
        current.approval = null;
      });
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    if (this.lease) this.interruptForLease();
    this.removeLeaseListener?.();
    this.store.transaction((state) => {
      for (const task of state.tasks)
        if (task.state.kind === "running")
          transition(task, { kind: "cancelling", runId: task.state.runId });
    });
    for (const job of this.jobs.values()) job.controller.abort();
    for (const job of this.inboxJobs.values()) job.controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(
        [...this.jobs.values(), ...this.inboxJobs.values()].map(
          (job) => job.promise,
        ),
      ),
      new Promise<void>((done) => {
        timeout = setTimeout(done, 2500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.store.transaction((state) => {
      for (const task of state.tasks)
        if (task.state.kind === "running" || task.state.kind === "cancelling") {
          transition(task, {
            kind: "interrupted",
            reason: "关闭时未确认进程退出，请人工核实。",
          });
          task.approval = null;
        }
      for (const item of state.inbox)
        if (item.state === "processing") item.state = this.lease ? "failed" : "pending";
    });
    this.closed = true;
    this.store.close();
  }
}
