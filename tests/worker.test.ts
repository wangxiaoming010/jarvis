import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Workspace } from "../server/workspace.ts";
import { ExecutionLease } from "../server/lease.ts";
import { WorkerJournal } from "../server/worker-journal.ts";
import { applyDeliveredCommand, dispatchCommand, publishableSnapshot, startWorker } from "../server/worker.ts";
import { pairWorker, loadWorkerConfig } from "../server/worker-pair.ts";
import { Store } from "../server/store.ts";
import type { Gateways, ExecutionRequest } from "../server/ports.ts";
import { CreateEmployee, CreateConversation, CreateTask, SendMessage, SaveModel, CreateRule, type Snapshot } from "../shared/domain.ts";
import { canonicalJson, CommandSchema, type AddressedCommand, type Command, type DeviceCredential } from "../shared/relay.ts";

const delay = (ms = 10) => new Promise<void>((done) => setTimeout(done, ms));
function gateways(): Gateways {
  return {
    models: { respond: async () => ({ text: "回复", proposals: [] }), attention: async () => true },
    executors: { status: async () => [{ executor: "codex", available: true, detail: "fixture" }], run: async () => ({ text: "已完成" }) },
  };
}
function temporary(t: test.TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-worker-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t: test.TestContext, custom = gateways(), lease = new ExecutionLease()) {
  const dataDir = temporary(t);
  const workspace = new Workspace({ dataDir, gateways: custom, lease });
  t.after(async () => { lease.invalidate("TEST_FINISHED"); await workspace.close(); });
  return { workspace, dataDir, lease, custom };
}
const credential = (): DeviceCredential => ({ deviceId: randomUUID(), generation: 1, token: "b".repeat(64) });
function addressed(command: Command, identity = credential(), id: string = randomUUID()): AddressedCommand {
  command = CommandSchema.parse(command);
  return { commandId: id, deviceId: identity.deviceId, generation: identity.generation,
    digest: createHash("sha256").update(canonicalJson(command)).digest("hex"),
    expiresAt: new Date(Date.now() + 60000).toISOString(), command };
}
function employee(workspace: Workspace) {
  return workspace.createEmployee(CreateEmployee.parse({ name: "小测", role: "测试", executor: "codex" }));
}
function configure(workspace: Workspace) {
  workspace.saveModel(SaveModel.parse({ purpose: "main", provider: "openai", endpoint: "https://model.invalid/v1", model: "fixture", apiKey: "secret-model-canary" }));
}
async function waitFor(workspace: Workspace, predicate: (snapshot: Snapshot) => boolean) {
  for (let n = 0; n < 200; n++) {
    const snapshot = await workspace.snapshot();
    if (predicate(snapshot)) return snapshot;
    await delay();
  }
  assert.fail("等待状态超时");
}

for (const crashAfterBusiness of [false, true]) {
  test(`journal ${crashAfterBusiness ? "业务提交后" : "业务调用前"}崩溃恢复unknown，同ID不再次调用`, async (t) => {
    const { workspace, dataDir } = fixture(t);
    const input = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "幂等", role: "测试", executor: "codex" }) });
    let journal = new WorkerJournal(dataDir);
    assert.equal(journal.begin(input), undefined);
    if (crashAfterBusiness) await dispatchCommand(workspace, input.command);
    journal.close();
    journal = new WorkerJournal(dataDir);
    const result = await applyDeliveredCommand(workspace, journal, input);
    assert.equal(result.status, "unknown");
    assert.equal((await workspace.snapshot()).employees.length, Number(crashAfterBusiness));
    journal.close();
  });
}

test("已提交回执在重启和ACK丢失后重传，同ID只进入一次业务", async (t) => {
  const { workspace, dataDir } = fixture(t);
  const identity = credential();
  const command = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "幂等", role: "测试", executor: "codex" }) }, identity);
  let calls = 0;
  const original = workspace.createEmployee.bind(workspace);
  workspace.createEmployee = (input) => { calls++; return original(input); };
  let journal = new WorkerJournal(dataDir);
  const first = await applyDeliveredCommand(workspace, journal, command);
  assert.equal(first.status, "applied");
  journal.close(); journal = new WorkerJournal(dataDir);
  assert.deepEqual(await applyDeliveredCommand(workspace, journal, command), first);
  assert.equal(calls, 1);
  assert.equal(journal.receipts(identity).length, 1);
  journal.acknowledge([command.commandId], journal.receipts(identity));
  assert.equal(journal.receipts(identity).length, 0);
  await applyDeliveredCommand(workspace, journal, command);
  assert.equal(journal.receipts(identity).length, 1);
  assert.equal(calls, 1);
  journal.close();
});

test("同ID异摘要或设备代际拒绝，伪造digest不落started", async (t) => {
  const { workspace, dataDir } = fixture(t);
  const identity = credential();
  const command = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "原文", role: "测试", executor: "codex" }) }, identity);
  const journal = new WorkerJournal(dataDir); t.after(() => journal.close());
  await applyDeliveredCommand(workspace, journal, command);
  const changed = addressed({ ...command.command, input: CreateEmployee.parse({ name: "篡改", role: "测试", executor: "codex" }) } as Command, identity, command.commandId);
  assert.throws(() => journal.begin(changed), { code: "COMMAND_ID_CONFLICT" });
  assert.throws(() => journal.begin({ ...command, generation: 2 }), { code: "COMMAND_ID_CONFLICT" });
  assert.throws(() => journal.begin({ ...command, commandId: randomUUID(), digest: "0".repeat(64) }), { code: "COMMAND_DIGEST_MISMATCH" });
  assert.equal((await workspace.snapshot()).employees.length, 1);
});

test("unknown不阻塞后续取消，已过期命令不进入业务", async (t) => {
  const { workspace, dataDir } = fixture(t);
  const owner = employee(workspace);
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "取消目标", instruction: "不得运行" }));
  const unknown = addressed({ kind: "employee.update", id: owner.id, input: { role: "未知变更" } });
  let journal = new WorkerJournal(dataDir); journal.begin(unknown); journal.close();
  journal = new WorkerJournal(dataDir); t.after(() => journal.close());
  assert.equal((await applyDeliveredCommand(workspace, journal, unknown)).status, "unknown");
  const cancel = addressed({ kind: "task.action", id: task.id, input: { action: "cancel", version: task.version } });
  assert.equal((await applyDeliveredCommand(workspace, journal, cancel)).status, "applied");
  assert.equal((await workspace.snapshot()).tasks[0].state.kind, "cancelled");
  const expired = addressed({ kind: "employee.update", id: owner.id, input: { role: "过期" } });
  expired.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await applyDeliveredCommand(workspace, journal, expired)).status, "expired");
  assert.equal((await workspace.snapshot()).employees[0].role, "测试");
});

test("12类远程命令均分发到现有Workspace且不返回原始结果", async (t) => {
  const { workspace, dataDir } = fixture(t);
  const journal = new WorkerJournal(dataDir); t.after(() => journal.close());
  const seen = new Set<string>();
  async function apply(command: Command) {
    seen.add(command.kind);
    const result = await applyDeliveredCommand(workspace, journal, addressed(command));
    assert.equal(result.status, "applied");
    assert.deepEqual(Object.keys(result).sort(), ["commandId", "status", "updatedAt"]);
  }
  await apply({ kind: "employee.create", input: CreateEmployee.parse({ name: "分发", role: "测试", executor: "codex" }) });
  const owner = (await workspace.snapshot()).employees[0];
  await apply({ kind: "employee.update", id: owner.id, input: { role: "新职责" } });
  await apply({ kind: "conversation.create", input: CreateConversation.parse({ title: "会话", kind: "direct", memberIds: [owner.id] }) });
  const conversation = (await workspace.snapshot()).conversations[0];
  await apply({ kind: "message.send", id: conversation.id, input: SendMessage.parse({ id: randomUUID(), content: "消息" }) });
  await apply({ kind: "task.create", input: CreateTask.parse({ employeeId: owner.id, title: "任务", instruction: "指令" }) });
  const task = (await workspace.snapshot()).tasks[0];
  await apply({ kind: "task.action", id: task.id, input: { action: "cancel", version: task.version } });
  await apply({ kind: "execution.update", input: { maxWorkers: 3, codexModel: "local-exec", attentionUseMain: false } });
  await apply({ kind: "memory.create", input: { employeeId: owner.id, content: "记忆" } });
  const memory = (await workspace.snapshot()).memories[0];
  await apply({ kind: "memory.delete", id: memory.id });
  await apply({ kind: "rule.create", input: CreateRule.parse({ name: "规则", instruction: "只观察", employeeId: owner.id, intervalMinutes: 5 }) });
  const rule = (await workspace.snapshot()).rules[0];
  await apply({ kind: "rule.update", id: rule.id, enabled: false });
  const notice = (await workspace.snapshot()).notices[0];
  await apply({ kind: "notice.read", id: notice.id });
  const snapshot = await workspace.snapshot();
  assert.equal(seen.size, 12);
  assert.equal(snapshot.employees[0].role, "新职责");
  assert.equal(snapshot.tasks[0].state.kind, "cancelled");
  assert.equal(snapshot.settings.maxWorkers, 3);
  assert.equal(snapshot.memories.length, 0);
  assert.equal(snapshot.rules[0].enabled, false);
  assert.equal(snapshot.notices[0].read, true);
});

test("publication白名单剥离隐含字段、目录别名及endpoint；canary阻止上行", async (t) => {
  const { workspace, dataDir } = fixture(t);
  const owner = employee(workspace); configure(workspace);
  workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "目录", instruction: `结果位于 ${dataDir}/tasks 和 ${homedir()}/private` }));
  const snapshot = await workspace.snapshot();
  snapshot.tasks[0].approval = { version: 1, executor: "codex", model: "", workspace: dataDir, scope: "workspace-write", approvedAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
  snapshot.executors[0].detail = `available at ${homedir()}/bin/codex`;
  const safe = publishableSnapshot({ ...snapshot, secrets: "not-a-public-field" }, { sensitiveValues: ["secret-model-canary"], localPaths: [dataDir, homedir()] });
  const text = JSON.stringify(safe);
  assert.equal(safe.tasks[0].workspace, `mac-task:${snapshot.tasks[0].id}`);
  assert.equal(safe.tasks[0].approval?.workspace, safe.tasks[0].workspace);
  assert.equal(safe.settings.main?.endpoint, "https://local.invalid");
  assert.ok(!text.includes(dataDir)); assert.ok(!text.includes(homedir()));
  assert.ok(!text.includes("not-a-public-field"));
  for (const secret of ["secret-model-canary", "device-token-canary", "bootstrap-canary"]) {
    snapshot.tasks[0].instruction = secret;
    assert.throws(() => publishableSnapshot(snapshot, { sensitiveValues: [secret], localPaths: [] }), { code: "PUBLICATION_SECRET_DETECTED" });
  }
  snapshot.tasks[0].instruction = "x".repeat(4 * 1024 * 1024);
  assert.throws(() => publishableSnapshot(snapshot, { sensitiveValues: [], localPaths: [] }), { code: "PUBLICATION_TOO_LARGE" });
});

test("publication revision跨重启递增，同内容不变", async (t) => {
  const { workspace, dataDir } = fixture(t);
  let journal = new WorkerJournal(dataDir);
  const snapshot = await workspace.snapshot();
  const first = journal.publication(snapshot);
  assert.equal(first.revision, 1);
  assert.equal(journal.publication(snapshot).revision, 1);
  journal.close(); journal = new WorkerJournal(dataDir);
  assert.equal(journal.publication(snapshot).revision, 1);
  snapshot.settings.maxWorkers = 4;
  assert.equal(journal.publication(snapshot).revision, 2);
  journal.close();
});

test("出站同步传安全投影、认证与ACK；请求失联立即关闸", async (t) => {
  const { workspace, dataDir, lease } = fixture(t);
  const identity = credential();
  let calls = 0;
  const command = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "同步", role: "测试", executor: "codex" }) }, identity);
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${identity.token}`);
    const body = JSON.parse(String(init?.body));
    assert.ok(!String(init?.body).includes(identity.token));
    calls++;
    if (calls === 1) return Response.json({ leaseMs: 15000, acknowledgedIds: [], command });
    assert.equal(body.receipts[0].status, "applied");
    if (calls === 2) throw new Error("sensitive-raw-network-error");
    return Response.json({ leaseMs: 15000, acknowledgedIds: [command.commandId], command: null });
  };
  const worker = startWorker({ workspace, dataDir, lease, credential: identity, origin: "http://127.0.0.1:4321", fetch: fetcher, autoStart: false });
  t.after(() => worker.stop());
  await worker.syncOnce(); assert.equal(lease.valid, true);
  await assert.rejects(worker.syncOnce(), { code: "SYNC_FAILED" }); assert.equal(lease.valid, false);
  await worker.syncOnce(); assert.equal(lease.valid, true);
  assert.equal((await workspace.snapshot()).employees.length, 1);
  await worker.stop();
});

for (const status of [401, 403]) {
  test(`设备认证${status}立即撤销租约且不跟随重定向`, async (t) => {
    const { workspace, dataDir, lease } = fixture(t);
    let calls = 0;
    lease.renew(15000, lease.requestStarted());
    const worker = startWorker({ workspace, dataDir, lease, credential: credential(), origin: "http://127.0.0.1:4321", autoStart: false,
      fetch: async (_url, init) => { calls++; assert.equal(init?.redirect, "error"); return new Response("private", { status }); } });
    await assert.rejects(worker.syncOnce(), { code: "WORKER_REVOKED" });
    assert.equal(lease.valid, false);
    await assert.rejects(worker.syncOnce(), { code: "WORKER_REVOKED" });
    assert.equal(calls, 1); await worker.stop();
  });
}

test("模型key、bootstrap和token canary不产生任何同步请求", async (t) => {
  const { workspace, dataDir, lease } = fixture(t);
  const owner = employee(workspace); configure(workspace);
  const identity = credential();
  const memory = workspace.createMemory({ employeeId: owner.id, content: "secret-model-canary" });
  let calls = 0;
  const worker = startWorker({ workspace, dataDir, lease, credential: identity, origin: "http://127.0.0.1:4321", autoStart: false,
    fetch: async () => { calls++; throw new Error("must not send"); } });
  await assert.rejects(worker.syncOnce(), { code: "PUBLICATION_SECRET_DETECTED" });
  workspace.deleteMemory(memory.id);
  const tokenMemory = workspace.createMemory({ employeeId: owner.id, content: identity.token });
  await assert.rejects(worker.syncOnce(), { code: "PUBLICATION_SECRET_DETECTED" });
  workspace.deleteMemory(tokenMemory.id);
  writeFileSync(join(dataDir, "bootstrap-token"), "bootstrap-canary-value", { mode: 0o600 });
  workspace.createMemory({ employeeId: owner.id, content: "bootstrap-canary-value" });
  await assert.rejects(worker.syncOnce(), { code: "PUBLICATION_SECRET_DETECTED" });
  assert.equal(calls, 0); await worker.stop();
});

test("配对配置0600且持久，拒绝非loopback与重定向模式", async (t) => {
  const dataDir = temporary(t); const identity = credential();
  await pairWorker({ dataDir, origin: "http://127.0.0.1:4321", code: "a".repeat(64), fetch: async (url, init) => {
    assert.equal(url, "http://127.0.0.1:4321/worker/pair"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return Response.json(identity);
  } });
  assert.equal(statSync(join(dataDir, "worker-credential.json")).mode & 0o777, 0o600);
  assert.deepEqual(loadWorkerConfig(dataDir), { origin: "http://127.0.0.1:4321", credential: identity });
  await assert.rejects(pairWorker({ dataDir, origin: "http://example.invalid:4321", code: "a".repeat(64) }));
});

test("无租约不启动模型/CLI且不接受审批，租约恢复才处理pending", async (t) => {
  const custom = gateways(); let models = 0, runs = 0;
  custom.models.respond = async () => { models++; return { text: "收到", proposals: [] }; };
  custom.executors.run = async () => { runs++; return { text: "结果" }; };
  const { workspace, lease } = fixture(t, custom); const owner = employee(workspace); configure(workspace);
  const conversation = workspace.createConversation(CreateConversation.parse({ title: "对话", kind: "direct", memberIds: [owner.id] }));
  workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "开始" }));
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "任务", instruction: "测试" }));
  await assert.rejects(workspace.taskAction(task.id, { action: "approve", version: task.version }), { code: "LEASE_REQUIRED" });
  await delay(200); assert.equal(models, 0); assert.equal(runs, 0);
  lease.renew(15000, lease.requestStarted());
  await waitFor(workspace, (state) => state.messages.some((message) => message.authorId === owner.id));
  assert.equal(models, 1);
});

test("attention之后租约失效阻止respond，失效中的模型signal被中断", async (t) => {
  const custom = gateways(); let attentionSignal: AbortSignal | undefined; let respond = 0;
  let finishAttention!: (result: boolean) => void;
  custom.models.attention = async (_profile, _input, signal) => {
    attentionSignal = signal;
    return new Promise<boolean>((done) => { finishAttention = done; });
  };
  custom.models.respond = async () => { respond++; return { text: "不应调用", proposals: [] }; };
  const { workspace, lease } = fixture(t, custom); const owner = employee(workspace); configure(workspace);
  const conversation = workspace.createConversation(CreateConversation.parse({ title: "群", kind: "group", memberIds: [owner.id] }));
  lease.renew(15000, lease.requestStarted());
  workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "需要关注" }));
  while (!attentionSignal) await delay();
  lease.invalidate("REVOKED");
  assert.equal(attentionSignal.aborted, true);
  finishAttention(true); await delay(20);
  assert.equal(respond, 0);
  lease.renew(15000, lease.requestStarted()); await delay(200);
  assert.equal(respond, 0);
});

test("CLI长期运行不阻塞取消，确认退出才cancelled", async (t) => {
  const custom = gateways(); let request: ExecutionRequest | undefined; let exit!: () => void;
  custom.executors.run = (input) => {
    request = input;
    return new Promise((_done, reject) => { exit = () => reject(new DOMException("confirmed", "AbortError")); });
  };
  const { workspace, dataDir, lease } = fixture(t, custom); const owner = employee(workspace);
  lease.renew(15000, lease.requestStarted());
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "运行", instruction: "测试" }));
  const journal = new WorkerJournal(dataDir); t.after(() => journal.close());
  await applyDeliveredCommand(workspace, journal, addressed({ kind: "task.action", id: task.id, input: { action: "approve", version: task.version } }));
  const running = await waitFor(workspace, (state) => state.tasks[0].state.kind === "running");
  assert.ok(request);
  const receipt = await applyDeliveredCommand(workspace, journal, addressed({ kind: "task.action", id: task.id, input: { action: "cancel", version: running.tasks[0].version } }));
  assert.equal(receipt.status, "applied"); assert.equal(request.signal.aborted, true);
  assert.equal((await workspace.snapshot()).tasks[0].state.kind, "cancelling");
  exit();
  await waitFor(workspace, (state) => state.tasks[0].state.kind === "cancelled");
});

test("租约定时到期中止CLI并保留interrupted，续租不能自动恢复", async (t) => {
  const custom = gateways(); let request: ExecutionRequest | undefined;
  custom.executors.run = async (input) => {
    request = input;
    return new Promise((_done, reject) => input.signal.addEventListener("abort", () => reject(new DOMException("confirmed", "AbortError")), { once: true }));
  };
  const { workspace, lease } = fixture(t, custom); const owner = employee(workspace);
  lease.renew(400, lease.requestStarted());
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "到期", instruction: "测试" }));
  const approved = await workspace.taskAction(task.id, { action: "approve", version: task.version });
  assert.ok(Date.parse(approved.approval!.expiresAt) - Date.parse(approved.approval!.approvedAt) <= 120001);
  await waitFor(workspace, (state) => state.tasks[0].state.kind === "running");
  await waitFor(workspace, (state) => state.tasks[0].state.kind === "interrupted");
  assert.equal(request?.signal.aborted, true);
  lease.renew(15000, lease.requestStarted()); await delay(200);
  assert.equal((await workspace.snapshot()).tasks[0].state.kind, "interrupted");
  await assert.rejects(workspace.taskAction(task.id, { action: "resume", version: (await workspace.snapshot()).tasks[0].version }), { code: "VERIFICATION_REQUIRED" });
});

test("重启processing消息标记失败，不自动重复付费", async (t) => {
  const dataDir = temporary(t); const custom = gateways(); let calls = 0;
  custom.models.respond = async () => { calls++; return { text: "不得重试", proposals: [] }; };
  const workspace = new Workspace({ dataDir, gateways: custom, lease: new ExecutionLease() });
  const owner = employee(workspace); configure(workspace);
  const conversation = workspace.createConversation(CreateConversation.parse({ title: "对话", kind: "direct", memberIds: [owner.id] }));
  workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "重启" }));
  await workspace.close();
  const store = new Store(dataDir); store.transaction((state) => { state.inbox[0].state = "processing"; }); store.close();
  const lease = new ExecutionLease();
  const reopened = new Workspace({ dataDir, gateways: custom, lease });
  lease.renew(15000, lease.requestStarted());
  await delay(250);
  assert.equal(calls, 0);
  assert.ok((await reopened.snapshot()).notices.some((notice) => notice.title.includes("未自动重试")));
  await reopened.close(); lease.invalidate("TEST_FINISHED");
});

test("started日志容量不能默默删除去重记录", async (t) => {
  const dataDir = temporary(t);
  const journal = new WorkerJournal(dataDir);
  const database = new DatabaseSync(join(dataDir, "worker-journal.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  const insert = database.prepare("INSERT INTO commands VALUES (?,?,?,1,'terminal',?,1)");
  for (let i = 0; i < 10000; i++) insert.run(randomUUID(), "0".repeat(64), randomUUID(), "{}");
  database.exec("COMMIT"); database.close();
  assert.throws(() => journal.begin(addressed({ kind: "memory.delete", id: randomUUID() })), { code: "JOURNAL_CAPACITY" });
  journal.close();
});

test("业务提交后抛未知异常回执为unknown，重投不再次进入业务", async (t) => {
  const { workspace, dataDir } = fixture(t);
  let calls = 0;
  const original = workspace.createEmployee.bind(workspace);
  workspace.createEmployee = (input) => {
    calls++; original(input); throw new Error("private external content");
  };
  const journal = new WorkerJournal(dataDir); t.after(() => journal.close());
  const command = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "未知", role: "测试", executor: "codex" }) });
  const first = await applyDeliveredCommand(workspace, journal, command);
  assert.equal(first.status, "unknown");
  assert.deepEqual(await applyDeliveredCommand(workspace, journal, command), first);
  assert.equal(calls, 1); assert.equal((await workspace.snapshot()).employees.length, 1);
});

test("真实SIGKILL覆盖调用前和业务提交后两个持久化崩溃窗口", async (t) => {
  for (const afterBusiness of [false, true]) {
    const dataDir = temporary(t);
    const command = addressed({ kind: "employee.create", input: CreateEmployee.parse({ name: "崩溃窗口", role: "测试", executor: "codex" }) });
    const script = `
      import { WorkerJournal } from './server/worker-journal.ts';
      import { Workspace } from './server/workspace.ts';
      import { dispatchCommand } from './server/worker.ts';
      import { ExecutionLease } from './server/lease.ts';
      const workspace = new Workspace({ dataDir: ${JSON.stringify(dataDir)}, lease: new ExecutionLease(),
        gateways: { models: {}, executors: {status: async () => []} } });
      const command = ${JSON.stringify(command)};
      const journal = new WorkerJournal(${JSON.stringify(dataDir)});
      journal.begin(command);
      if (${afterBusiness}) await dispatchCommand(workspace, command.command);
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const workspace = new Workspace({ dataDir, lease: new ExecutionLease(), gateways: gateways() });
    const journal = new WorkerJournal(dataDir);
    assert.equal((await applyDeliveredCommand(workspace, journal, command)).status, "unknown");
    assert.equal((await workspace.snapshot()).employees.length, Number(afterBusiness));
    journal.close(); await workspace.close();
  }
});

test("执行器探测等待期间失联不能启动CLI，已批准队列回到待批准", async (t) => {
  const custom = gateways(); let calls = 0, probes = 0;
  let releaseProbe!: () => void;
  custom.executors.status = async () => {
    probes++;
    if (probes === 2) {
      await new Promise<void>((done) => { releaseProbe = done; });
    }
    return [{ executor: "codex", available: true, detail: "fixture" }];
  };
  custom.executors.run = async () => { calls++; return { text: "不应启动" }; };
  const { workspace, lease } = fixture(t, custom); const owner = employee(workspace);
  lease.renew(15000, lease.requestStarted());
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "探测", instruction: "测试" }));
  await workspace.taskAction(task.id, { action: "approve", version: task.version });
  for (let i = 0; i < 200 && probes < 2; i++) await delay();
  assert.equal(probes, 2);
  lease.invalidate("DISCONNECTED"); releaseProbe();
  await delay(30);
  assert.equal(calls, 0);
  assert.equal((await workspace.snapshot()).tasks[0].state.kind, "needs_approval");
});

test("CLI最终同步闸门覆盖probe后事件循环未运行到期timer的竞态", async (t) => {
  let mono = 100, wall = 1000, spawned = 0;
  const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
  const custom = gateways();
  custom.executors.run = async (request) => {
    assert.equal(typeof request.beforeStart, "function");
    // 模拟probe返回时系统已经休眠，但到期timer尚未获调度。
    wall += 2000; mono += 2000;
    request.beforeStart!();
    spawned++;
    return { text: "不应启动" };
  };
  const { workspace } = fixture(t, custom, lease); const owner = employee(workspace);
  lease.renew(1000, lease.requestStarted());
  const task = workspace.createTask(CreateTask.parse({ employeeId: owner.id, title: "最终闸门", instruction: "测试" }));
  await workspace.taskAction(task.id, { action: "approve", version: task.version });
  await waitFor(workspace, (state) => state.tasks[0].state.kind === "interrupted");
  assert.equal(spawned, 0);
});

test("respond在途租约到期主动中断，关闭及重连不自动重试", async (t) => {
  const custom = gateways(); let calls = 0, signal: AbortSignal | undefined;
  custom.models.respond = async (_profile, _input, incoming) => {
    calls++; signal = incoming;
    return new Promise((_done, reject) => incoming.addEventListener("abort", () => reject(new DOMException("interrupted", "AbortError")), { once: true }));
  };
  const { workspace, lease } = fixture(t, custom); const owner = employee(workspace); configure(workspace);
  const conversation = workspace.createConversation(CreateConversation.parse({ title: "对话", kind: "direct", memberIds: [owner.id] }));
  lease.renew(350, lease.requestStarted());
  workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "调用模型" }));
  while (!signal) await delay();
  await delay(250);
  assert.equal(signal.aborted, true);
  lease.renew(15000, lease.requestStarted());
  await delay(200); assert.equal(calls, 1);
});

test("同步拒绝旧代际command及未发送ACK，敏感response不进日志", async (t) => {
  for (const badAck of [false, true]) {
    const { workspace, dataDir, lease } = fixture(t);
    const identity = credential();
    const command = addressed({ kind: "memory.delete", id: randomUUID() }, identity);
    command.generation++;
    const worker = startWorker({ workspace, dataDir, lease, credential: identity, origin: "http://127.0.0.1:4321", autoStart: false,
      fetch: async () => Response.json({ leaseMs: 15000, acknowledgedIds: badAck ? [randomUUID()] : [], command: badAck ? null : command }) });
    await assert.rejects(worker.syncOnce(), { code: badAck ? "INVALID_ACK" : "COMMAND_GENERATION_MISMATCH" });
    assert.equal(lease.valid, false); await worker.stop();
  }
});

for (const attention of [false, true]) {
  test(`${attention ? "attention" : "respond"}模型最后同步闸门阻止休眠后的HTTP启动`, async (t) => {
    let mono = 100, wall = 1000, sent = 0;
    const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
    const custom = gateways();
    const beforeCall = (callback?: () => void) => {
      assert.equal(typeof callback, "function");
      mono += 2000; wall += 2000;
      callback!();
      sent++;
    };
    if (attention) custom.models.attention = async (_profile, _input, _signal, callback) => { beforeCall(callback); return true; };
    else custom.models.respond = async (_profile, _input, _signal, callback) => { beforeCall(callback); return { text: "不应发送", proposals: [] }; };
    const { workspace } = fixture(t, custom, lease); const owner = employee(workspace); configure(workspace);
    const conversation = workspace.createConversation(CreateConversation.parse({ title: "模型闸门", kind: attention ? "group" : "direct", memberIds: [owner.id] }));
    lease.renew(1000, lease.requestStarted());
    workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "测试" }));
    await waitFor(workspace, (state) => state.notices.some((notice) => notice.title.includes("连接中断")));
    assert.equal(sent, 0);
  });
}

for (const mode of ["cli", "cli-error", "model", "attention"] as const) {
  test(`${mode}返回落盘前复核休眠期间失效的租约，不等到期timer`, async (t) => {
    let mono = 100, wall = 1000, returned = false;
    const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
    const custom = gateways();
    const expireBeforeTimer = () => { mono += 2000; wall += 2000; returned = true; };
    if (mode.startsWith("cli")) custom.executors.run = async (request) => {
      request.beforeStart?.(); expireBeforeTimer();
      if (mode === "cli-error") throw new Error("late external error");
      return { text: "不应发布的过期结果" };
    };
    if (mode === "model") custom.models.respond = async (_profile, _input, _signal, beforeStart) => {
      beforeStart?.(); expireBeforeTimer(); return { text: "不应发布的过期回复", proposals: [] };
    };
    if (mode === "attention") custom.models.attention = async (_profile, _input, _signal, beforeStart) => {
      beforeStart?.(); expireBeforeTimer(); return false;
    };
    const { workspace } = fixture(t, custom, lease); const owner = employee(workspace);
    lease.renew(1000, lease.requestStarted());
    if (mode.startsWith("cli")) {
      const task = workspace.createTask(CreateTask.parse({ title: "过期返回", instruction: "测试", employeeId: owner.id }));
      await workspace.taskAction(task.id, { action: "approve", version: task.version });
      const state = await waitFor(workspace, (snapshot) => snapshot.tasks[0].state.kind === "interrupted");
      assert.equal(state.artifacts.length, 0);
    } else {
      configure(workspace);
      const conversation = workspace.createConversation(CreateConversation.parse({ title: "过期回复", kind: mode === "attention" ? "group" : "direct", memberIds: [owner.id] }));
      workspace.sendMessage(conversation.id, SendMessage.parse({ id: randomUUID(), content: "测试" }));
      const state = await waitFor(workspace, (snapshot) => snapshot.notices.some((notice) => notice.title.includes("连接中断")));
      assert.equal(state.messages.filter((message) => message.authorId === owner.id).length, 0);
    }
    assert.equal(returned, true);
    assert.equal(lease.valid, false);
  });
}
