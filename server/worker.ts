import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  DeviceCredentialSchema, SyncReplySchema, SyncInputSchema, PublishedSnapshotSchema,
  MAX_PUBLICATION_BYTES, loopbackOrigin, type DeviceCredential,
  type AddressedCommand, type TerminalReceipt, type Command,
} from "../shared/relay.ts";
import { SnapshotSchema, type Snapshot } from "../shared/domain.ts";
import { ExecutionLease, LeaseExpiredError } from "./lease.ts";
import { Workspace, WorkspaceError } from "./workspace.ts";
import { WorkerJournal, WorkerError } from "./worker-journal.ts";
import { log } from "./log.ts";
import { readWorkerResponse } from "./worker-pair.ts";

export async function dispatchCommand(workspace: Workspace, command: Command): Promise<void> {
  switch (command.kind) {
    case "employee.create": workspace.createEmployee(command.input); break;
    case "employee.update": workspace.updateEmployee(command.id, command.input); break;
    case "conversation.create": workspace.createConversation(command.input); break;
    case "message.send": workspace.sendMessage(command.id, command.input); break;
    case "task.create": workspace.createTask(command.input); break;
    case "task.action": await workspace.taskAction(command.id, command.input); break;
    case "execution.update": workspace.saveExecution(command.input); break;
    case "memory.create": workspace.createMemory(command.input); break;
    case "memory.delete": workspace.deleteMemory(command.id); break;
    case "rule.create": workspace.createRule(command.input); break;
    case "rule.update": workspace.updateRule(command.id, { enabled: command.enabled }); break;
    case "notice.read": workspace.readNotice(command.id); break;
  }
}

export function publishableSnapshot(input: unknown, options: {
  sensitiveValues: string[]; localPaths: string[];
}): Snapshot {
  const snapshot = SnapshotSchema.parse(input);
  for (const task of snapshot.tasks) {
    if (task.workspace !== null) task.workspace = `mac-task:${task.id}`;
    if (task.approval) task.approval.workspace = `mac-task:${task.id}`;
  }
  for (const executor of snapshot.executors)
    executor.detail = executor.available ? "本机执行器可用。" : "本机执行器不可用，请在 Mac 本地检查。";
  for (const profile of [snapshot.settings.main, snapshot.settings.attention])
    if (profile) profile.endpoint = "https://local.invalid";
  const paths = options.localPaths.filter(Boolean).sort((a, b) => b.length - a.length);
  function clean(value: unknown): unknown {
    if (typeof value === "string") {
      let text = value;
      if (options.sensitiveValues.some((secret) => secret && text.includes(secret)))
        throw new WorkerError("PUBLICATION_SECRET_DETECTED");
      for (const path of paths) text = text.split(path).join("[本机路径]");
      return text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  }
  const publication = PublishedSnapshotSchema.parse(clean(snapshot));
  if (Buffer.byteLength(JSON.stringify(publication)) > MAX_PUBLICATION_BYTES - 128)
    throw new WorkerError("PUBLICATION_TOO_LARGE");
  return publication;
}

export async function applyDeliveredCommand(workspace: Workspace, journal: WorkerJournal,
  command: AddressedCommand): Promise<TerminalReceipt> {
  const previous = journal.begin(command);
  if (previous) return previous;
  let receipt: TerminalReceipt;
  if (Date.parse(command.expiresAt) <= Date.now()) {
    receipt = { commandId: command.commandId, status: "expired", updatedAt: new Date().toISOString() };
  } else {
    try {
      await dispatchCommand(workspace, command.command);
      receipt = { commandId: command.commandId, status: "applied", updatedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof LeaseExpiredError) {
        log("error", "worker.command_rejected", { code: error.code, commandId: command.commandId });
        receipt = { commandId: command.commandId, status: "rejected", code: error.code, updatedAt: new Date().toISOString() };
      } else {
        // 未知异常可能发生在业务提交之后，不能把它冒充确定未应用的拒绝。
        log("error", "worker.command_unknown", { commandId: command.commandId });
        receipt = { commandId: command.commandId, status: "unknown", code: "CRASH_WINDOW", updatedAt: new Date().toISOString() };
      }
    }
  }
  // 业务方法只负责接收命令，不等待长期任务；取消可以在后续同步中独立送达。
  const result = journal.finish(receipt);
  log("info", "worker.command_finished", { commandId: command.commandId, status: result.status });
  return result;
}

export interface WorkerOptions {
  workspace: Workspace;
  dataDir: string;
  origin: string;
  credential: DeviceCredential;
  lease: ExecutionLease;
  syncIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  sensitiveValues?: string[];
  autoStart?: boolean;
}

export function startWorker(options: WorkerOptions): {
  stop(): Promise<void>;
  syncOnce(): Promise<void>;
} {
  const origin = loopbackOrigin(options.origin);
  const credential = DeviceCredentialSchema.parse(options.credential);
  if (options.workspace.remoteLease() !== options.lease) throw new WorkerError("WORKSPACE_LEASE_MISMATCH");
  const journal = new WorkerJournal(options.dataDir);
  const fetcher = options.fetch ?? globalThis.fetch;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFailure: string | undefined;
  let revoked = false;
  const knownSecrets = new Set([credential.token, ...(options.sensitiveValues ?? [])]);

  async function sync(): Promise<void> {
    try {
      for (const secret of options.workspace.publicationSecrets()) knownSecrets.add(secret);
      const current = await options.workspace.snapshot();
      // snapshot 会等待执行器探测；期间本地可能换 key，上传前再次收集且保留旧值。
      for (const secret of options.workspace.publicationSecrets()) knownSecrets.add(secret);
      const bootstrapPath = join(options.dataDir, "bootstrap-token");
      if (existsSync(bootstrapPath)) knownSecrets.add(readFileSync(bootstrapPath, "utf8").trim());
      const snapshot = publishableSnapshot(current, {
        sensitiveValues: [...knownSecrets],
        localPaths: [resolve(options.dataDir), realpathSync(options.dataDir), homedir(), process.env.HOME ?? ""],
      });
      if (stopped) return;
      const receipts = journal.receipts(credential);
      const payload = SyncInputSchema.parse({
        deviceId: credential.deviceId, generation: credential.generation,
        receipts, publication: journal.publication(snapshot),
      });
      request = new AbortController();
      const started = options.lease.requestStarted();
      const response = await fetcher(`${origin}/worker/sync`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new WorkerError(response.status === 401 || response.status === 403 ? "WORKER_REVOKED" : "SYNC_REJECTED");
      const reply = SyncReplySchema.parse(await readWorkerResponse(response));
      if (stopped) return;
      if (reply.command && (reply.command.deviceId !== credential.deviceId || reply.command.generation !== credential.generation))
        throw new WorkerError("COMMAND_GENERATION_MISMATCH");
      journal.acknowledge(reply.acknowledgedIds, receipts);
      options.lease.renew(reply.leaseMs, started);
      if (lastFailure) log("info", "worker.sync_recovered");
      lastFailure = undefined;
      if (reply.command) await applyDeliveredCommand(options.workspace, journal, reply.command);
    } catch (error) {
      options.lease.invalidate("SYNC_FAILED");
      const code = error instanceof WorkerError ? error.code : "SYNC_FAILED";
      if (!stopped && code !== lastFailure) log("error", "worker.sync_failed", { code });
      lastFailure = code;
      if (code === "WORKER_REVOKED") revoked = true;
      throw error instanceof WorkerError ? error : new WorkerError(code);
    } finally { request = undefined; }
  }

  function syncOnce(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (revoked) return Promise.reject(new WorkerError("WORKER_REVOKED"));
    if (!inFlight) inFlight = sync().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  async function poll(): Promise<void> {
    try { await syncOnce(); }
    catch { /* sync 已记录安全错误码，轮询保留重连机会。 */ }
    if (!stopped && !revoked) {
      timer = setTimeout(() => { void poll(); }, options.syncIntervalMs ?? 1000);
      timer.unref();
    }
  }
  if (options.autoStart !== false) void poll();
  return {
    syncOnce,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      options.lease.invalidate("WORKER_STOPPED");
      request?.abort();
      await inFlight?.catch(() => { log("info", "worker.sync_stopped"); });
      journal.close();
    },
  };
}
