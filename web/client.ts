import { z } from "zod";
import { SnapshotSchema } from "../shared/domain";
import {
  CloudViewSchema,
  CommandSchema,
  ReceiptSchema,
  canonicalJson,
  type Command,
} from "../shared/relay";

const SessionSchema = z.object({ csrf: z.string().min(1) });
export function commandFor(
  path: string,
  method: string,
  input: unknown,
): Command {
  const parts = path.split("/").filter(Boolean);
  let command: unknown;
  if (path === "/api/employees" && method === "POST")
    command = { kind: "employee.create", input };
  else if (parts[1] === "employees" && parts.length === 3 && method === "PATCH")
    command = { kind: "employee.update", id: parts[2], input };
  else if (path === "/api/conversations" && method === "POST")
    command = { kind: "conversation.create", input };
  else if (
    parts[1] === "conversations" &&
    parts[3] === "messages" &&
    parts.length === 4 &&
    method === "POST"
  )
    command = { kind: "message.send", id: parts[2], input };
  else if (path === "/api/tasks" && method === "POST")
    command = { kind: "task.create", input };
  else if (
    parts[1] === "tasks" &&
    parts[3] === "action" &&
    parts.length === 4 &&
    method === "POST"
  )
    command = { kind: "task.action", id: parts[2], input };
  else if (path === "/api/settings/execution" && method === "POST")
    command = { kind: "execution.update", input };
  else if (path === "/api/memories" && method === "POST")
    command = { kind: "memory.create", input };
  else if (parts[1] === "memories" && parts.length === 3 && method === "DELETE")
    command = { kind: "memory.delete", id: parts[2] };
  else if (path === "/api/rules" && method === "POST")
    command = { kind: "rule.create", input };
  else if (parts[1] === "rules" && parts.length === 3 && method === "PATCH")
    command = {
      kind: "rule.update",
      id: parts[2],
      ...z.object({ enabled: z.boolean() }).strict().parse(input),
    };
  else if (
    parts[1] === "notices" &&
    parts[3] === "read" &&
    parts.length === 4 &&
    method === "POST"
  )
    command = { kind: "notice.read", id: parts[2] };
  else throw new Error("这项设置只能在 Mac 本地工作台修改。");
  return CommandSchema.parse(command);
}

export class WorkbenchClient {
  mode: "local" | "cloud" = "local";
  private csrf = "";
  private initialized: Promise<void> | null = null;
  constructor(
    private readonly transport: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}
  initialize(): Promise<void> {
    if (!this.initialized)
      this.initialized = this.raw("/api/mode")
        .then((data) => {
          this.mode = z
            .object({ mode: z.enum(["local", "cloud"]) })
            .parse(data).mode;
        })
        .catch((error: unknown) => {
          this.initialized = null;
          throw error;
        });
    return this.initialized;
  }
  private async raw(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.transport(path, {
      method,
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers:
        method === "GET"
          ? {}
          : {
              "Content-Type": "application/json",
              "X-Jarvis-Request": "1",
              ...(this.csrf ? { "X-Jarvis-CSRF": this.csrf } : {}),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      if (response.status === 401) this.csrf = "";
      const error = z.object({ error: z.string() }).safeParse(data);
      throw new Error(
        `${error.success ? error.data.error : "请求失败"} (${response.status})`,
      );
    }
    return data;
  }
  async signIn(value: string): Promise<void> {
    await this.initialize();
    const response = await this.raw(
      "/api/session",
      "POST",
      this.mode === "cloud" ? { password: value } : { token: value },
    );
    if (this.mode === "cloud") this.csrf = SessionSchema.parse(response).csrf;
  }
  async read() {
    await this.initialize();
    if (this.mode === "local")
      return {
        snapshot: SnapshotSchema.parse(await this.raw("/api/snapshot")),
        cloud: null,
      };
    if (!this.csrf)
      this.csrf = SessionSchema.parse(await this.raw("/api/session")).csrf;
    const cloud = CloudViewSchema.parse(await this.raw("/api/cloud/view"));
    return { snapshot: cloud.snapshot, cloud };
  }
  async mutate(path: string, method: string, body: unknown) {
    if (this.mode === "local") {
      await this.raw(path, method, body);
      return null;
    }
    let command = commandFor(path, method, body);
    const fingerprint =
      command.kind === "message.send"
        ? { ...command, input: { ...command.input, id: "message" } }
        : command;
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalJson(fingerprint)),
        ),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const key = `jarvis-command:${digest}`;
    const requestId = sessionStorage.getItem(key) || crypto.randomUUID();
    // 只保存摘要和 ID。网络结果不明时，重提同一表单沿用 ID，不重复应用业务。
    sessionStorage.setItem(key, requestId);
    if (command.kind === "message.send")
      command = { ...command, input: { ...command.input, id: requestId } };
    const receipt = ReceiptSchema.parse(
      await this.raw("/api/cloud/commands", "POST", { requestId, command }),
    );
    sessionStorage.removeItem(key);
    return receipt;
  }
  async pair() {
    return z
      .object({ code: z.string(), expiresAt: z.string().datetime() })
      .parse(await this.raw("/api/cloud/pair", "POST", {}));
  }
  async revoke(): Promise<void> {
    await this.raw("/api/cloud/revoke", "POST", {});
  }
  async logout(): Promise<void> {
    await this.raw("/api/logout", "POST", {});
    this.csrf = "";
  }
}
