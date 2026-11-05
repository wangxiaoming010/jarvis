import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CommandSchema,
  SubmitSchema,
  canonicalJson,
  loopbackOrigin,
  UpdateEmployee,
  PublishedSnapshotSchema,
} from "../shared/relay.ts";

test("remote commands are closed and cannot carry secrets or execution paths", () => {
  const command = {
    kind: "task.create",
    input: { title: "测试", instruction: "生成说明", employeeId: randomUUID() },
  };
  assert.equal(CommandSchema.parse(command).kind, "task.create");
  for (const field of [
    "workspace",
    "cwd",
    "shell",
    "env",
    "apiKey",
    "provider",
    "endpoint",
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...command,
        input: { ...command.input, [field]: "not-allowed" },
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({ kind: "model.update", input: {} }).success,
    false,
  );
  assert.equal(
    SubmitSchema.safeParse({ requestId: randomUUID(), command, extra: true })
      .success,
    false,
  );
});

test("canonical payload is independent of property ordering", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: 1, a: 2 }], a: true }),
    canonicalJson({ a: true, b: [2, { a: 2, z: 1 }] }),
  );
});

test("remote transport rejects public, authenticated and redirect-like origins", () => {
  assert.equal(
    loopbackOrigin("http://127.0.0.1:4321"),
    "http://127.0.0.1:4321",
  );
  for (const origin of [
    "http://0.0.0.0:4321",
    "http://localhost:4321",
    "https://127.0.0.1:4321",
    "http://127.0.0.1:4321/path",
    "http://127.0.0.1:4321/#secret",
    "http://user:pass@127.0.0.1:4321",
  ])
    assert.throws(() => loopbackOrigin(origin));
});

test("partial employee edits do not reset attention mode", () => {
  assert.deepEqual(UpdateEmployee.parse({ role: "新职责" }), {
    role: "新职责",
  });
});

test("published view rejects nested unknown fields instead of accepting secrets", () => {
  const snapshot = {
    employees: [],
    conversations: [],
    messages: [],
    tasks: [],
    artifacts: [],
    memories: [],
    notices: [],
    rules: [],
    executors: [],
    settings: {
      main: {
        provider: "deepseek",
        endpoint: "https://local.invalid",
        model: "fixture",
        thinking: false,
        hasKey: true,
      },
      attention: null,
      attentionUseMain: true,
      maxWorkers: 1,
      codexModel: "",
    },
  };
  assert.equal(PublishedSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(
    PublishedSnapshotSchema.safeParse({
      ...snapshot,
      settings: {
        ...snapshot.settings,
        main: { ...snapshot.settings.main, apiKey: "forbidden" },
      },
    }).success,
    false,
  );
});
