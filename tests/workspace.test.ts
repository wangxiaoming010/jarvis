import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Workspace, WorkspaceError } from "../server/workspace.ts";
import { Store } from "../server/store.ts";
import type { Gateways, ModelInput } from "../server/ports.ts";
import {
  CreateEmployee,
  CreateTask,
  CreateConversation,
  SendMessage,
  SaveModel,
  CreateRule,
  type Snapshot,
} from "../shared/domain.ts";

const delay = (ms = 10) => new Promise<void>((done) => setTimeout(done, ms));
function gateways(): Gateways {
  return {
    models: {
      respond: async () => ({ text: "模型回复", proposals: [] }),
      attention: async () => true,
    },
    executors: {
      status: async () => [
        { executor: "codex", available: true, detail: "fixture" },
        { executor: "claude-code", available: false, detail: "fixture" },
      ],
      run: async () => ({ text: "fixture执行结果" }),
    },
  };
}
async function fixture(t: test.TestContext, custom = gateways()) {
  const dataDir = realpathSync(
    mkdtempSync(join(tmpdir(), "jarvis-workspace-test-")),
  );
  const workspace = new Workspace({ dataDir, gateways: custom });
  t.after(async () => {
    await workspace.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const employee = workspace.createEmployee(
    CreateEmployee.parse({
      name: "阿青",
      role: "测试工程师",
      executor: "codex",
    }),
  );
  return { workspace, dataDir, employee, gateways: custom };
}
async function waitFor(
  workspace: Workspace,
  predicate: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  for (let i = 0; i < 250; i++) {
    const snapshot = await workspace.snapshot();
    if (predicate(snapshot)) return snapshot;
    await delay();
  }
  assert.fail("等待状态超时");
}
function createTask(workspace: Workspace, employeeId: string, extra = {}) {
  return workspace.createTask(
    CreateTask.parse({
      title: "检查实现",
      instruction: "在专用目录产出检查结果",
      employeeId,
      ...extra,
    }),
  );
}
function configure(
  workspace: Workspace,
  purpose: "main" | "attention" = "main",
  model = "fixture-model",
) {
  return workspace.saveModel(
    SaveModel.parse({
      purpose,
      provider: "openai",
      endpoint: "https://fixture.example/v1",
      model,
      apiKey: `${purpose}-secret`,
    }),
  );
}
function rejectsCode(code: string) {
  return (error: unknown) =>
    error instanceof WorkspaceError && error.code === code;
}

test("员工、私聊、记忆持久化且目录和凭据权限受限", async (t) => {
  const { workspace, dataDir, employee } = await fixture(t);
  const conversation = workspace.createConversation(
    CreateConversation.parse({
      title: "私聊",
      kind: "direct",
      memberIds: [employee.id],
    }),
  );
  assert.equal(
    workspace.createConversation(
      CreateConversation.parse({
        title: "复用",
        kind: "direct",
        memberIds: [employee.id],
      }),
    ).id,
    conversation.id,
  );
  workspace.createMemory({ employeeId: employee.id, content: "使用中文" });
  configure(workspace);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, "workspace.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, "secrets.json")).mode & 0o777, 0o600);
  assert.ok(
    !JSON.stringify(await workspace.snapshot()).includes("main-secret"),
  );
  assert.ok(
    !readFileSync(join(dataDir, "workspace.sqlite")).includes(
      Buffer.from("main-secret"),
    ),
  );
  await workspace.close();
  const reopened = new Workspace({ dataDir, gateways: gateways() });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.employees.length, 1);
  assert.equal(snapshot.memories[0]?.content, "使用中文");
  await reopened.close();
});

test("消息UUID幂等，冲突被拒绝；错误提及不入库", async (t) => {
  const { workspace, employee } = await fixture(t);
  const conversation = workspace.createConversation(
    CreateConversation.parse({
      title: "群",
      kind: "group",
      memberIds: [employee.id],
    }),
  );
  const input = SendMessage.parse({
    id: randomUUID(),
    content: "@阿青 检查一下",
    mentions: [employee.id],
  });
  assert.deepEqual(
    workspace.sendMessage(conversation.id, input),
    workspace.sendMessage(conversation.id, input),
  );
  assert.throws(
    () =>
      workspace.sendMessage(conversation.id, { ...input, content: "不同内容" }),
    rejectsCode("MESSAGE_CONFLICT"),
  );
  assert.throws(
    () =>
      workspace.sendMessage(conversation.id, {
        ...input,
        id: randomUUID(),
        content: "没有提及",
      }),
    rejectsCode("INVALID_MENTION"),
  );
  assert.equal((await workspace.snapshot()).messages.length, 1);
});

test("普通群消息用独立attention；明确@和私聊绕过注意力，不触发执行", async (t) => {
  const custom = gateways();
  const attentionModels: string[] = [];
  let replies = 0;
  let executions = 0;
  custom.models.attention = async (profile) => {
    attentionModels.push(profile.model);
    return false;
  };
  custom.models.respond = async () => {
    replies++;
    return { text: "答复", proposals: [] };
  };
  custom.executors.run = async () => {
    executions++;
    return { text: "不能自动发生" };
  };
  const { workspace, employee } = await fixture(t, custom);
  configure(workspace);
  configure(workspace, "attention", "attention-model");
  workspace.saveExecution({
    maxWorkers: 1,
    codexModel: "",
    attentionUseMain: false,
  });
  const group = workspace.createConversation(
    CreateConversation.parse({
      title: "群",
      kind: "group",
      memberIds: [employee.id],
    }),
  );
  const direct = workspace.createConversation(
    CreateConversation.parse({
      title: "私聊",
      kind: "direct",
      memberIds: [employee.id],
    }),
  );
  workspace.sendMessage(
    group.id,
    SendMessage.parse({ id: randomUUID(), content: "普通消息" }),
  );
  await delay(200);
  workspace.sendMessage(
    group.id,
    SendMessage.parse({
      id: randomUUID(),
      content: "@阿青 来看看",
      mentions: [employee.id],
    }),
  );
  workspace.sendMessage(
    direct.id,
    SendMessage.parse({ id: randomUUID(), content: "请执行任务" }),
  );
  await waitFor(
    workspace,
    (snapshot) =>
      snapshot.messages.filter((message) => message.authorId === employee.id)
        .length === 2,
  );
  assert.deepEqual(attentionModels, ["attention-model"]);
  assert.equal(replies, 2);
  assert.equal(executions, 0);
});

test("收件箱按员工串行，记忆仅注入所属员工，模型提案只待批准", async (t) => {
  const custom = gateways();
  const inputs: ModelInput[] = [];
  let inflight = 0;
  let maxInflight = 0;
  custom.models.respond = async (_profile, input) => {
    inputs.push(input);
    maxInflight = Math.max(maxInflight, ++inflight);
    await delay(80);
    inflight--;
    return {
      text: "已提出建议",
      proposals: [{ title: "模型建议", instruction: "先等审批", criteria: [] }],
    };
  };
  const { workspace, employee } = await fixture(t, custom);
  configure(workspace);
  workspace.createMemory({ employeeId: employee.id, content: "我的独有偏好" });
  const other = workspace.createEmployee(
    CreateEmployee.parse({ name: "阿白", role: "其他员工", executor: "codex" }),
  );
  workspace.createMemory({ employeeId: other.id, content: "绝不能串入的记忆" });
  const conversation = workspace.createConversation(
    CreateConversation.parse({
      title: "私聊",
      kind: "direct",
      memberIds: [employee.id],
    }),
  );
  workspace.sendMessage(
    conversation.id,
    SendMessage.parse({ id: randomUUID(), content: "消息一" }),
  );
  workspace.sendMessage(
    conversation.id,
    SendMessage.parse({ id: randomUUID(), content: "消息二" }),
  );
  const snapshot = await waitFor(
    workspace,
    (state) => state.tasks.length === 2,
  );
  assert.equal(maxInflight, 1);
  assert.match(inputs[0]!.system, /我的独有偏好/);
  assert.doesNotMatch(inputs[0]!.system, /绝不能串入/);
  assert.equal(inputs[0]!.messages.length, 1);
  assert.ok(
    snapshot.tasks.every((task) => task.state.kind === "needs_approval"),
  );
});

test("缺少真实密钥时保存失败通知，不伪造模型回复", async (t) => {
  const { workspace, employee } = await fixture(t);
  const conversation = workspace.createConversation(
    CreateConversation.parse({
      title: "私聊",
      kind: "direct",
      memberIds: [employee.id],
    }),
  );
  workspace.sendMessage(
    conversation.id,
    SendMessage.parse({ id: randomUUID(), content: "你好" }),
  );
  const snapshot = await waitFor(workspace, (state) =>
    state.notices.some((notice) => notice.kind === "error"),
  );
  assert.equal(
    snapshot.messages.filter((message) => message.authorId === employee.id)
      .length,
    0,
  );
  assert.match(
    snapshot.messages.find((message) => message.authorId === "system")!.content,
    /未配置有效密钥/,
  );
});

test("执行需要批准，结果hash并待验收，accept才完成，过期版本拒绝", async (t) => {
  const { workspace, employee, dataDir } = await fixture(t);
  const task = createTask(workspace, employee.id);
  assert.equal(task.state.kind, "needs_approval");
  assert.equal(task.workspace, join(dataDir, "tasks", task.id));
  const queued = await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  assert.equal(queued.approval!.scope, "workspace-write");
  assert.equal(queued.approval!.version, queued.version);
  assert.equal(
    Date.parse(queued.approval!.expiresAt) -
      Date.parse(queued.approval!.approvedAt),
    30 * 60_000,
  );
  await assert.rejects(
    workspace.taskAction(task.id, { action: "cancel", version: task.version }),
    rejectsCode("VERSION_CONFLICT"),
  );
  const snapshot = await waitFor(
    workspace,
    (state) => state.tasks[0]?.state.kind === "review",
  );
  assert.equal(
    snapshot.artifacts[0]!.digest,
    createHash("sha256").update("fixture执行结果").digest("hex"),
  );
  assert.equal(snapshot.artifacts[0]!.accepted, false);
  await workspace.taskAction(task.id, {
    action: "accept",
    version: snapshot.tasks[0]!.version,
  });
  const accepted = await workspace.snapshot();
  assert.equal(accepted.tasks[0]!.state.kind, "completed");
  assert.equal(accepted.artifacts[0]!.accepted, true);
});

test("工具不可用不能批准，不静默换工具", async (t) => {
  const { workspace, employee } = await fixture(t);
  workspace.updateEmployee(employee.id, { executor: "claude-code" });
  const task = createTask(workspace, employee.id);
  await assert.rejects(
    workspace.taskAction(task.id, { action: "approve", version: task.version }),
    rejectsCode("EXECUTOR_UNAVAILABLE"),
  );
  assert.equal(
    (await workspace.snapshot()).tasks[0]?.state.kind,
    "needs_approval",
  );
});

test("全局worker上限及每员工最多一个执行", async (t) => {
  const custom = gateways();
  const releases: (() => void)[] = [];
  let inflight = 0;
  let maxInflight = 0;
  custom.executors.run = async () => {
    maxInflight = Math.max(maxInflight, ++inflight);
    await new Promise<void>((done) => releases.push(done));
    inflight--;
    return { text: "完成" };
  };
  const { workspace, employee } = await fixture(t, custom);
  workspace.saveExecution({
    maxWorkers: 2,
    codexModel: "",
    attentionUseMain: true,
  });
  const other = workspace.createEmployee(
    CreateEmployee.parse({ name: "其他", role: "测试", executor: "codex" }),
  );
  const tasks = [
    createTask(workspace, employee.id),
    createTask(workspace, employee.id),
    createTask(workspace, other.id),
  ];
  for (const task of tasks)
    await workspace.taskAction(task.id, {
      action: "approve",
      version: task.version,
    });
  const snapshot = await waitFor(
    workspace,
    (state) =>
      state.tasks.filter((task) => task.state.kind === "running").length === 2,
  );
  assert.equal(
    snapshot.tasks.filter(
      (task) =>
        task.state.kind === "running" && task.employeeId === employee.id,
    ).length,
    1,
  );
  assert.equal(maxInflight, 2);
  releases.splice(0).forEach((done) => done());
  await waitFor(
    workspace,
    (state) =>
      state.tasks.filter((task) => task.state.kind === "review").length === 2,
  );
  await waitFor(
    workspace,
    (state) =>
      state.tasks.filter((task) => task.state.kind === "running").length === 1,
  );
  releases.splice(0).forEach((done) => done());
  await waitFor(workspace, (state) =>
    state.tasks.every((task) => task.state.kind === "review"),
  );
});

test("取消先cancelling，等待已确认AbortError后才cancelled", async (t) => {
  const custom = gateways();
  let confirmExit: (() => void) | undefined;
  custom.executors.run = async (request) =>
    await new Promise((_, reject) =>
      request.signal.addEventListener(
        "abort",
        () => {
          confirmExit = () =>
            reject(new DOMException("进程已退出", "AbortError"));
        },
        { once: true },
      ),
    );
  const { workspace, employee } = await fixture(t, custom);
  const task = createTask(workspace, employee.id);
  await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  const running = (
    await waitFor(
      workspace,
      (state) => state.tasks[0]?.state.kind === "running",
    )
  ).tasks[0]!;
  const cancelling = await workspace.taskAction(task.id, {
    action: "cancel",
    version: running.version,
  });
  assert.equal(cancelling.state.kind, "cancelling");
  assert.equal((await workspace.snapshot()).tasks[0]?.state.kind, "cancelling");
  confirmExit!();
  await waitFor(
    workspace,
    (state) => state.tasks[0]?.state.kind === "cancelled",
  );
});

test("无法确认退出进入interrupted，恢复必须人工核实并重新批准", async (t) => {
  const custom = gateways();
  custom.executors.run = async (request) =>
    await new Promise((_, reject) =>
      request.signal.addEventListener(
        "abort",
        () => reject(new Error("无法确认退出")),
        { once: true },
      ),
    );
  const { workspace, employee } = await fixture(t, custom);
  const task = createTask(workspace, employee.id);
  await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  const running = (
    await waitFor(
      workspace,
      (state) => state.tasks[0]?.state.kind === "running",
    )
  ).tasks[0]!;
  await workspace.taskAction(task.id, {
    action: "cancel",
    version: running.version,
  });
  const interrupted = (
    await waitFor(
      workspace,
      (state) => state.tasks[0]?.state.kind === "interrupted",
    )
  ).tasks[0]!;
  await assert.rejects(
    workspace.taskAction(task.id, {
      action: "resume",
      version: interrupted.version,
    }),
    rejectsCode("VERIFICATION_REQUIRED"),
  );
  const resumed = await workspace.taskAction(task.id, {
    action: "resume",
    version: interrupted.version,
    input: "已核实旧进程停止，目录无冲突",
  });
  assert.equal(resumed.state.kind, "needs_approval");
  assert.equal(resumed.approval, null);
});

test("重启不重放running/queued任务，授权失效", async (t) => {
  const { workspace, dataDir, employee } = await fixture(t);
  const first = createTask(workspace, employee.id);
  const second = createTask(workspace, employee.id);
  await workspace.close();
  const store = new Store(dataDir);
  store.transaction((state) => {
    state.tasks[0]!.state = { kind: "running", runId: randomUUID() };
    state.tasks[1]!.state = { kind: "queued" };
  });
  store.close();
  let runs = 0;
  const custom = gateways();
  custom.executors.run = async () => {
    runs++;
    return { text: "" };
  };
  const reopened = new Workspace({ dataDir, gateways: custom });
  const snapshot = await reopened.snapshot();
  assert.equal(
    snapshot.tasks.find((task) => task.id === first.id)?.state.kind,
    "interrupted",
  );
  assert.equal(
    snapshot.tasks.find((task) => task.id === second.id)?.state.kind,
    "needs_approval",
  );
  await delay(180);
  assert.equal(runs, 0);
  await reopened.close();
});

test("修改执行模型撤销排队授权，禁止任意目录和符号链接", async (t) => {
  const { workspace, dataDir, employee } = await fixture(t);
  const task = createTask(workspace, employee.id);
  await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  workspace.saveExecution({
    maxWorkers: 1,
    codexModel: "new-model",
    attentionUseMain: true,
  });
  assert.equal(
    (await workspace.snapshot()).tasks[0]?.state.kind,
    "needs_approval",
  );
  const bad = createTask(workspace, employee.id);
  symlinkSync(tmpdir(), join(dataDir, "tasks", bad.id));
  await assert.rejects(
    workspace.taskAction(bad.id, { action: "approve", version: bad.version }),
    rejectsCode("UNSAFE_WORKSPACE"),
  );
});

test("供应商地址变化不得沿用旧key，禁止HTTP或URL凭据", async (t) => {
  const { workspace } = await fixture(t);
  configure(workspace);
  const input = SaveModel.parse({
    purpose: "main",
    provider: "openai",
    endpoint: "https://other.example/v1",
    model: "other",
  });
  assert.throws(() => workspace.saveModel(input), rejectsCode("KEY_REQUIRED"));
  assert.throws(
    () =>
      workspace.saveModel({
        ...input,
        endpoint: "http://127.0.0.1:9999",
        apiKey: "secret",
      }),
    rejectsCode("UNSAFE_ENDPOINT"),
  );
  assert.throws(
    () =>
      workspace.saveModel({
        ...input,
        endpoint: "https://secret@localhost",
        apiKey: "secret",
      }),
    rejectsCode("UNSAFE_ENDPOINT"),
  );
  const same = workspace.saveModel({
    ...input,
    endpoint: "https://fixture.example/v1",
  });
  assert.equal(same.main?.hasKey, true);
});

test("观察规则仅记录事实，propose仅生成待批准任务并推进下次时间", async (t) => {
  const { workspace, dataDir, employee } = await fixture(t);
  workspace.createRule(
    CreateRule.parse({
      name: "观察",
      instruction: "查看",
      employeeId: employee.id,
      intervalMinutes: 5,
      mode: "observe",
    }),
  );
  workspace.createRule(
    CreateRule.parse({
      name: "提案",
      instruction: "提出检查任务",
      employeeId: employee.id,
      intervalMinutes: 5,
      mode: "propose",
    }),
  );
  const store = new Store(dataDir);
  store.transaction((state) => {
    for (const rule of state.rules) rule.nextRunAt = new Date(0).toISOString();
  });
  store.close();
  const snapshot = await waitFor(
    workspace,
    (state) => state.tasks.length === 1,
  );
  assert.equal(snapshot.tasks[0]?.state.kind, "needs_approval");
  assert.equal(
    snapshot.notices.filter((notice) => notice.kind === "observation").length,
    1,
  );
  assert.ok(
    snapshot.rules.every((rule) => Date.parse(rule.nextRunAt) > Date.now()),
  );
});

test("过期审批重新进入待批准，不启动执行", async (t) => {
  let runs = 0;
  const custom = gateways();
  custom.executors.run = async () => {
    runs++;
    return { text: "" };
  };
  const { workspace, dataDir, employee } = await fixture(t, custom);
  const task = createTask(workspace, employee.id);
  await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  const store = new Store(dataDir);
  store.transaction((state) => {
    state.tasks[0]!.approval!.expiresAt = new Date(0).toISOString();
  });
  store.close();
  const snapshot = await waitFor(
    workspace,
    (state) => state.tasks[0]?.state.kind === "needs_approval",
  );
  assert.equal(snapshot.tasks[0]?.approval, null);
  assert.equal(runs, 0);
});

test("旧runId结果不能覆盖新的状态或创建交付物", async (t) => {
  let finish: (() => void) | undefined;
  const custom = gateways();
  custom.executors.run = async () => {
    await new Promise<void>((done) => {
      finish = done;
    });
    return { text: "旧执行迟到结果" };
  };
  const { workspace, dataDir, employee } = await fixture(t, custom);
  const task = createTask(workspace, employee.id);
  await workspace.taskAction(task.id, {
    action: "approve",
    version: task.version,
  });
  await waitFor(workspace, (state) => state.tasks[0]?.state.kind === "running");
  const store = new Store(dataDir);
  store.transaction((state) => {
    state.tasks[0]!.state = { kind: "running", runId: randomUUID() };
  });
  store.close();
  finish!();
  await delay(40);
  const snapshot = await workspace.snapshot();
  assert.equal(snapshot.artifacts.length, 0);
  assert.equal(snapshot.tasks[0]?.state.kind, "running");
});

test("委派独立审批，并回传父任务原会话；不能跨无关会话委派", async (t) => {
  const { workspace, employee } = await fixture(t);
  const other = workspace.createEmployee(
    CreateEmployee.parse({ name: "阿白", role: "协作员工", executor: "codex" }),
  );
  const group = workspace.createConversation(
    CreateConversation.parse({
      title: "项目群",
      kind: "group",
      memberIds: [employee.id, other.id],
    }),
  );
  const direct = workspace.createConversation(
    CreateConversation.parse({
      title: "私聊",
      kind: "direct",
      memberIds: [other.id],
    }),
  );
  const parent = createTask(workspace, employee.id, {
    conversationId: group.id,
  });
  assert.throws(
    () =>
      createTask(workspace, other.id, {
        parentTaskId: parent.id,
        conversationId: direct.id,
      }),
    rejectsCode("DELEGATION_CONVERSATION"),
  );
  const child = createTask(workspace, other.id, { parentTaskId: parent.id });
  assert.equal(child.conversationId, group.id);
  assert.equal(child.state.kind, "needs_approval");
  await workspace.taskAction(child.id, {
    action: "approve",
    version: child.version,
  });
  const snapshot = await waitFor(
    workspace,
    (state) =>
      state.tasks.find((task) => task.id === child.id)?.state.kind === "review",
  );
  assert.equal(
    snapshot.tasks.find((task) => task.id === parent.id)?.state.kind,
    "needs_approval",
  );
  assert.ok(
    snapshot.messages.some(
      (message) =>
        message.authorId === "system" && message.conversationId === group.id,
    ),
  );
});

test("数据库schema边界拒绝损坏数据并回滚事务", async (t) => {
  const { dataDir } = await fixture(t);
  const store = new Store(dataDir);
  assert.throws(() =>
    store.transaction((state) => {
      state.settings.maxWorkers = 999;
    }),
  );
  assert.equal(store.read().settings.maxWorkers, 2);
  store.close();
});

test("密钥文件和数据库不一致时阻止出站，重新保存不能继承未确认密钥", async (t) => {
  let requests = 0;
  const custom = gateways();
  custom.models.respond = async () => {
    requests++;
    return { text: "回复", proposals: [] };
  };
  const { workspace, dataDir, employee } = await fixture(t, custom);
  configure(workspace);
  configure(workspace, "attention");
  const path = join(dataDir, "secrets.json");
  const edited = JSON.parse(readFileSync(path, "utf8"));
  edited.main.endpoint = "https://unexpected.example/v1";
  writeFileSync(path, JSON.stringify(edited));
  const direct = workspace.createConversation(
    CreateConversation.parse({
      title: "检查一致性",
      kind: "direct",
      memberIds: [employee.id],
    }),
  );
  workspace.sendMessage(
    direct.id,
    SendMessage.parse({ id: randomUUID(), content: "不能发往错误端点" }),
  );
  const snapshot = await waitFor(workspace, (state) =>
    state.notices.some((notice) => notice.kind === "error"),
  );
  assert.equal(requests, 0);
  assert.match(
    snapshot.messages.find((message) => message.authorId === "system")!.content,
    /凭据文件与设置不一致/,
  );
  assert.equal(snapshot.settings.main?.endpoint, "https://fixture.example/v1");
  assert.throws(
    () =>
      workspace.saveModel(
        SaveModel.parse({
          purpose: "main",
          provider: "openai",
          endpoint: "https://unexpected.example/v1",
          model: "fixture-model",
        }),
      ),
    rejectsCode("KEY_REQUIRED"),
  );
  configure(workspace);
  const restored = await workspace.snapshot();
  assert.equal(restored.settings.attention, null);
  workspace.sendMessage(
    direct.id,
    SendMessage.parse({ id: randomUUID(), content: "现在可发往确认的端点" }),
  );
  await waitFor(workspace, (state) =>
    state.messages.some((message) => message.authorId === employee.id),
  );
  assert.equal(requests, 1);
});

test("同名规则分别产生自己的提案，再次到期不重复同一规则未完成任务", async (t) => {
  const { workspace, dataDir, employee } = await fixture(t);
  for (const instruction of ["检查甲", "检查乙"])
    workspace.createRule(
      CreateRule.parse({
        name: "同名规则",
        instruction,
        employeeId: employee.id,
        intervalMinutes: 5,
        mode: "propose",
      }),
    );
  const due = () => {
    const store = new Store(dataDir);
    store.transaction((state) => {
      for (const rule of state.rules)
        rule.nextRunAt = new Date(0).toISOString();
    });
    store.close();
  };
  due();
  const first = await waitFor(workspace, (state) => state.tasks.length === 2);
  assert.deepEqual(
    first.tasks.map((task) => task.instruction).sort(),
    ["检查乙", "检查甲"].sort(),
  );
  due();
  await waitFor(workspace, (state) =>
    state.rules.every((rule) => Date.parse(rule.nextRunAt) > Date.now()),
  );
  assert.equal((await workspace.snapshot()).tasks.length, 2);
});
