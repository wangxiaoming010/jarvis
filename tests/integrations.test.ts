import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createGateways,
  GatewayError,
  type ProcessSpawner,
} from "../server/integrations.ts";
import type { SecretProfile, ExecutionRequest } from "../server/ports.ts";

const profile: SecretProfile = {
  provider: "deepseek",
  endpoint: "https://model.example/v1",
  model: "deepseek-flash",
  thinking: true,
  apiKey: "secret-key-DO-NOT-LEAK",
};
const input = {
  system: "你是测试员工",
  messages: [
    { role: "user", content: "请安排任务" } satisfies {
      role: "user";
      content: string;
    },
  ],
};
const signal = () => new AbortController().signal;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function openai(text: string | null, toolCalls?: unknown[]) {
  return {
    choices: [
      {
        message: {
          content: text,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof GatewayError && error.code === expected;
}
const available = async () => ({ available: true, detail: "fixture only" });
function execution(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    executor: "codex",
    workspace: tmpdir(),
    instruction: "local fixture prompt",
    model: "",
    signal: signal(),
    ...overrides,
  };
}
function fixture(script: string): ProcessSpawner {
  return (_command, _args, options) =>
    spawn(process.execPath, ["-e", script], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
}
const successScript = `let text=''; process.stdin.on('data', d=>text+=d); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'received:'+text}}))});`;

test("OpenAI compatible native tool calls return proposals with one request only", async () => {
  let calls = 0;
  const gateways = createGateways({
    fetch: async (url, options) => {
      calls++;
      assert.equal(String(url), "https://model.example/v1/chat/completions");
      assert.equal(options?.redirect, "error");
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        `Bearer ${profile.apiKey}`,
      );
      const body = JSON.parse(String(options?.body));
      assert.equal(body.thinking.type, "enabled");
      assert.equal(body.tools[0].function.name, "propose_task");
      return json(
        openai(null, [
          {
            type: "function",
            function: {
              name: "propose_task",
              arguments: JSON.stringify({
                title: "整理",
                instruction: "生成报告",
                criteria: ["可读"],
              }),
            },
          },
        ]),
      );
    },
  });
  const reply = await gateways.models.respond(profile, input, signal());
  assert.deepEqual(reply, {
    text: "",
    proposals: [{ title: "整理", instruction: "生成报告", criteria: ["可读"] }],
  });
  assert.equal(calls, 1);
});

test("Anthropic uses native messages, header and input_schema", async () => {
  const gateways = createGateways({
    fetch: async (url, options) => {
      assert.equal(String(url), "https://model.example/v1/messages");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-api-key"), profile.apiKey);
      assert.equal(headers.get("Authorization"), null);
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.system.includes("测试员工"), true);
      assert.equal(body.messages[0].role, "user");
      assert.equal(body.tools[0].input_schema.type, "object");
      return json({
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "x" },
          { type: "text", text: "待批准" },
          {
            type: "tool_use",
            name: "propose_task",
            input: { title: "检查", instruction: "检查文件", criteria: [] },
          },
        ],
      });
    },
  });
  const reply = await gateways.models.respond(
    { ...profile, provider: "anthropic" },
    input,
    signal(),
  );
  assert.equal(reply.text, "待批准");
  assert.equal(reply.proposals.length, 1);
  assert.equal(JSON.stringify(reply).includes("private reasoning"), false);
});

test("attention sends no tools and strictly returns boolean", async () => {
  for (const provider of [
    "deepseek",
    "anthropic",
  ] satisfies SecretProfile["provider"][]) {
    const gateways = createGateways({
      fetch: async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        assert.equal("tools" in body, false);
        return json(
          provider === "anthropic"
            ? { content: [{ type: "text", text: "false" }] }
            : openai("false"),
        );
      },
    });
    assert.equal(
      await gateways.models.attention(
        { ...profile, provider },
        input,
        signal(),
      ),
      false,
    );
  }
  const invalid = createGateways({
    fetch: async () => json(openai('{"attend":true}')),
  });
  await assert.rejects(
    invalid.models.attention(profile, input, signal()),
    code("MODEL_PROTOCOL"),
  );
});

test("attention rejects unsolicited tools even if provider sends them", async () => {
  const gateways = createGateways({
    fetch: async () =>
      json(
        openai("true", [
          {
            type: "function",
            function: {
              name: "propose_task",
              arguments: '{"title":"a","instruction":"b","criteria":[]}',
            },
          },
        ]),
      ),
  });
  await assert.rejects(
    gateways.models.attention(profile, input, signal()),
    code("MODEL_PROTOCOL"),
  );
});

test("401 and network errors never expose response bodies, API key or underlying messages", async () => {
  const bad = createGateways({
    fetch: async () => new Response(`key=${profile.apiKey}`, { status: 401 }),
  });
  await assert.rejects(
    bad.models.respond(profile, input, signal()),
    (error) => {
      assert.equal(error instanceof GatewayError, true);
      assert.match(String(error), /401/);
      assert.equal(String(error).includes(profile.apiKey), false);
      return true;
    },
  );
  const network = createGateways({
    fetch: async () => {
      throw new Error(profile.apiKey);
    },
  });
  await assert.rejects(
    network.models.respond(profile, input, signal()),
    (error) =>
      !String(error).includes(profile.apiKey) &&
      code("MODEL_CONNECTION")(error),
  );
});

test("missing credentials and HTTP or embedded URL credentials are refused before fetch", async () => {
  let calls = 0;
  const gateways = createGateways({
    fetch: async () => {
      calls++;
      return json(openai("ok"));
    },
  });
  await assert.rejects(
    gateways.models.respond({ ...profile, apiKey: "" }, input, signal()),
    code("MISSING_API_KEY"),
  );
  for (const endpoint of [
    "http://127.0.0.1:1234",
    "https://user:pass@localhost",
    "https://example.com?api_key=secret",
  ]) {
    await assert.rejects(
      gateways.models.respond({ ...profile, endpoint }, input, signal()),
      code("INVALID_ENDPOINT"),
    );
  }
  assert.equal(calls, 0);
});

test("redirects are never followed and 302 body is hidden", async () => {
  const gateways = createGateways({
    fetch: async (_url, options) => {
      assert.equal(options?.redirect, "error");
      return new Response(profile.apiKey, {
        status: 302,
        headers: { Location: "https://evil.example" },
      });
    },
  });
  await assert.rejects(
    gateways.models.respond(profile, input, signal()),
    (error) =>
      code("MODEL_HTTP")(error) && !String(error).includes(profile.apiKey),
  );
});

test("model output is bounded and timeout is sanitized", async () => {
  const oversized = createGateways({
    maxOutputBytes: 100,
    fetch: async () => json(openai("x".repeat(200))),
  });
  await assert.rejects(
    oversized.models.respond(profile, input, signal()),
    code("OUTPUT_LIMIT"),
  );
  const timed = createGateways({
    modelTimeoutMs: 10,
    fetch: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error(profile.apiKey)),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    timed.models.respond(profile, input, signal()),
    code("MODEL_TIMEOUT"),
  );
});

test("invalid or unknown tool calls never reach execution gateway", async () => {
  const gateways = createGateways({
    fetch: async () =>
      json(
        openai(null, [
          {
            type: "function",
            function: { name: "execute_shell", arguments: "{}" },
          },
        ]),
      ),
  });
  await assert.rejects(
    gateways.models.respond(profile, input, signal()),
    code("MODEL_PROTOCOL"),
  );
});

test("Codex gets fixed safe arguments, stdin prompt, explicit model and allowlisted environment", async () => {
  process.env.OPENAI_API_KEY = "model-key-not-for-cli";
  process.env.ANTHROPIC_API_KEY = "another-secret";
  try {
    const gateways = createGateways({
      probe: available,
      spawn: (command, args, options) => {
        assert.equal(command, "codex");
        assert.equal(options.shell, false);
        assert.equal(options.detached, true);
        assert.equal(options.cwd, tmpdir());
        assert.equal(options.env?.OPENAI_API_KEY, undefined);
        assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
        assert.equal(args.includes("--ignore-user-config"), true);
        assert.equal(args.includes('approval_policy="never"'), true);
        assert.equal(args.includes("workspace-write"), true);
        assert.deepEqual(args.slice(-3), ["--model", "fixture-model", "-"]);
        assert.equal(args.includes("local fixture prompt"), false);
        assert.equal(
          args.some((arg) => arg.includes("bypass")),
          false,
        );
        return fixture(successScript)(command, args, options);
      },
    });
    assert.deepEqual(
      await gateways.executors.run(execution({ model: "fixture-model" })),
      { text: "received:local fixture prompt" },
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("Claude is unavailable even with positive probe and does not fall back", async () => {
  let spawnCalls = 0;
  const gateways = createGateways({
    probe: available,
    spawn: (...args) => {
      spawnCalls++;
      return fixture(successScript)(...args);
    },
  });
  const status = await gateways.executors.status();
  assert.equal(
    status.find((item) => item.executor === "claude-code")?.available,
    false,
  );
  await assert.rejects(
    gateways.executors.run(execution({ executor: "claude-code" })),
    code("EXECUTOR_UNAVAILABLE"),
  );
  assert.equal(spawnCalls, 0);
});

test("cancellation awaits real process close and confirmed dead process group", async () => {
  const controller = new AbortController();
  let closed = false;
  let pid: number | undefined;
  const gateways = createGateways({
    probe: available,
    spawn: (command, args, options) => {
      const child = fixture(
        "process.stdin.resume(); setInterval(()=>{},1000);",
      )(command, args, options);
      pid = child.pid;
      child.on("close", () => {
        closed = true;
      });
      setTimeout(() => controller.abort(), 30);
      return child;
    },
  });
  await assert.rejects(
    gateways.executors.run(execution({ signal: controller.signal })),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(closed, true);
  assert.equal(typeof pid, "number");
  const finishedPid = pid;
  if (finishedPid)
    assert.throws(
      () => process.kill(-finishedPid, 0),
      (error) =>
        error instanceof Error && "code" in error && error.code === "ESRCH",
    );
});

test("unknown process-group exit is UNKNOWN_PROCESS, not successful cancellation", async () => {
  const controller = new AbortController();
  const gateways = createGateways({
    probe: available,
    terminationGraceMs: 10,
    exitConfirmationMs: 100,
    kill: () => true,
    spawn: (command, args, options) => {
      const child = fixture(
        "process.stdin.resume(); setTimeout(()=>process.exit(0),40);",
      )(command, args, options);
      setTimeout(() => controller.abort(), 10);
      return child;
    },
  });
  await assert.rejects(
    gateways.executors.run(execution({ signal: controller.signal })),
    code("UNKNOWN_PROCESS"),
  );
});

test("execution output cap terminates the fixture and hides stderr", async () => {
  const gateways = createGateways({
    probe: available,
    maxOutputBytes: 100,
    spawn: fixture(
      `process.stderr.write('${profile.apiKey}'.repeat(20)); setInterval(()=>{},1000);`,
    ),
  });
  await assert.rejects(
    gateways.executors.run(execution()),
    (error) =>
      code("OUTPUT_LIMIT")(error) && !String(error).includes(profile.apiKey),
  );
});

test("execution timeout terminates the process and returns a safe error", async () => {
  const gateways = createGateways({
    probe: available,
    executionTimeoutMs: 25,
    spawn: fixture("setInterval(()=>{},1000);"),
  });
  await assert.rejects(
    gateways.executors.run(execution()),
    code("EXECUTION_TIMEOUT"),
  );
});

test("already cancelled requests never spawn and missing Codex never downgrades", async () => {
  const controller = new AbortController();
  controller.abort();
  const gateways = createGateways({
    probe: async () => ({ available: false, detail: "missing" }),
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    gateways.executors.run(execution({ signal: controller.signal })),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(
    gateways.executors.run(execution()),
    code("EXECUTOR_UNAVAILABLE"),
  );
});

test("DeepSeek thinking proposals use a fresh single protocol turn with text-only history context", async () => {
  const gateways = createGateways({
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(
        body.messages.map((message: { role: string }) => message.role),
        ["system", "user"],
      );
      assert.equal(body.messages[1].content.includes("之前的答案"), true);
      assert.equal(body.messages[1].content.includes("继续安排"), true);
      assert.equal(body.thinking.type, "enabled");
      return json({
        choices: [
          {
            message: {
              content: "需要审批",
              reasoning_content:
                "not persisted as an incomplete native continuation",
            },
          },
        ],
      });
    },
  });
  assert.deepEqual(
    await gateways.models.respond(
      profile,
      {
        system: "employee",
        messages: [
          { role: "user", content: "先说一下" },
          { role: "assistant", content: "之前的答案" },
          { role: "user", content: "继续安排" },
        ],
      },
      signal(),
    ),
    { text: "需要审批", proposals: [] },
  );
});

test("metadata-only providers never silently claim unsupported thinking behavior", async () => {
  let called = false;
  const gateways = createGateways({
    fetch: async () => {
      called = true;
      return json(openai("ok"));
    },
  });
  await assert.rejects(
    gateways.models.respond({ ...profile, provider: "qwen" }, input, signal()),
    code("UNSUPPORTED_THINKING"),
  );
  assert.equal(called, false);
});
