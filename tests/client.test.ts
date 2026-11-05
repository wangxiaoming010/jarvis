import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandFor, WorkbenchClient } from "../web/client.ts";

const id = randomUUID();
test("every remote workbench action maps to a strict domain command", () => {
  const cases: [string, string, unknown, string][] = [
    [
      "/api/employees",
      "POST",
      { name: "助手", role: "测试", executor: "codex" },
      "employee.create",
    ],
    [`/api/employees/${id}`, "PATCH", { enabled: false }, "employee.update"],
    [
      "/api/conversations",
      "POST",
      { title: "会话", kind: "direct", memberIds: [id] },
      "conversation.create",
    ],
    [
      `/api/conversations/${id}/messages`,
      "POST",
      { id, content: "你好" },
      "message.send",
    ],
    [
      "/api/tasks",
      "POST",
      { title: "测试", instruction: "测试", employeeId: id },
      "task.create",
    ],
    [
      `/api/tasks/${id}/action`,
      "POST",
      { action: "cancel", version: 1 },
      "task.action",
    ],
    [
      "/api/settings/execution",
      "POST",
      { maxWorkers: 1, codexModel: "", attentionUseMain: true },
      "execution.update",
    ],
    [
      "/api/memories",
      "POST",
      { employeeId: id, content: "中文" },
      "memory.create",
    ],
    [`/api/memories/${id}`, "DELETE", {}, "memory.delete"],
    [
      "/api/rules",
      "POST",
      { name: "观察", instruction: "检查", employeeId: id, intervalMinutes: 5 },
      "rule.create",
    ],
    [`/api/rules/${id}`, "PATCH", { enabled: false }, "rule.update"],
    [`/api/notices/${id}/read`, "POST", {}, "notice.read"],
  ];
  for (const [path, method, body, kind] of cases)
    assert.equal(commandFor(path, method, body).kind, kind);
  assert.throws(() =>
    commandFor("/api/settings/model", "POST", { apiKey: "not-accepted" }),
  );
  assert.throws(() =>
    commandFor(`/api/tasks/${id}/action/extra`, "POST", {
      action: "approve",
      version: 1,
    }),
  );
});

test("lost acknowledgement retries the same message ID without storing message contents", async () => {
  const storage = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  try {
    const calls: { requestId: string; command: { input: { id: string } } }[] =
      [];
    const client = new WorkbenchClient(async (path, options) => {
      if (path === "/api/mode") return Response.json({ mode: "cloud" });
      const body = JSON.parse(String(options?.body));
      calls.push(body);
      if (calls.length === 1)
        throw new Error("response lost after server commit");
      return Response.json(
        {
          commandId: body.requestId,
          status: "queued",
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
        { status: 202 },
      );
    });
    await client.initialize();
    const send = () =>
      client.mutate(`/api/conversations/${id}/messages`, "POST", {
        id: randomUUID(),
        content: "private-fixture-message",
      });
    await assert.rejects(send());
    assert.equal(
      JSON.stringify([...storage]).includes("private-fixture-message"),
      false,
    );
    await send();
    assert.equal(calls[0].requestId, calls[1].requestId);
    assert.equal(calls[0].command.input.id, calls[1].command.input.id);
    assert.equal(storage.size, 0);
    await send();
    assert.notEqual(calls[2].requestId, calls[1].requestId);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
