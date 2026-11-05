import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type {
  Gateways,
  ModelInput,
  ModelReply,
  SecretProfile,
  ExecutionRequest,
} from "./ports.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 60_000;
const EXECUTION_TIMEOUT_MS = 600_000;
const ProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    instruction: z.string().trim().min(1).max(16000),
    criteria: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
    employeeId: z.string().uuid().optional(),
  })
  .strict();
const proposalParameters = {
  type: "object",
  properties: {
    title: { type: "string" },
    instruction: { type: "string" },
    criteria: { type: "array", items: { type: "string" } },
    employeeId: {
      type: "string",
      description: "可选的已存在员工 UUID，不得编造。",
    },
  },
  required: ["title", "instruction", "criteria"],
  additionalProperties: false,
};
const proposalDescription =
  "仅建议一个待人工批准的任务。此工具不执行命令、不创建已批准任务。";
const OpenAIReply = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().optional(),
          tool_calls: z
            .array(
              z.object({
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .max(12)
            .optional(),
        }),
      }),
    )
    .min(1),
});
const AnthropicReply = z.object({
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("tool_use"),
          name: z.string(),
          input: z.unknown(),
        }),
        z.object({
          type: z.literal("thinking"),
          thinking: z.string(),
          signature: z.string().optional(),
        }),
        z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
      ]),
    )
    .max(32),
});
const CodexEvent = z.object({
  type: z.literal("item.completed"),
  item: z.object({ type: z.literal("agent_message"), text: z.string() }),
});

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
function aborted(): Error {
  return new DOMException("执行已取消，进程退出已确认。", "AbortError");
}
function failure(code: string, message: string): never {
  throw new GatewayError(code, message);
}
function endpoint(profile: SecretProfile): URL {
  if (!profile.apiKey.trim())
    failure("MISSING_API_KEY", "尚未配置模型 API Key。");
  let url: URL;
  try {
    url = new URL(profile.endpoint);
  } catch {
    return failure("INVALID_ENDPOINT", "模型端点格式不正确。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    failure(
      "INVALID_ENDPOINT",
      "模型端点必须是无凭据、查询参数和 fragment 的 HTTPS 地址。",
    );
  }
  const suffix =
    profile.provider === "anthropic" ? "/messages" : "/chat/completions";
  url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
  return url;
}
function parseProposal(value: unknown) {
  const parsed = ProposalSchema.safeParse(value);
  if (!parsed.success) failure("MODEL_PROTOCOL", "模型返回了无效的任务建议。");
  return parsed.data;
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return failure("MODEL_PROTOCOL", "模型响应不是有效的 JSON。");
  }
}
function decode(profile: SecretProfile, value: unknown): ModelReply {
  if (profile.provider === "anthropic") {
    const parsed = AnthropicReply.safeParse(value);
    if (!parsed.success)
      failure("MODEL_PROTOCOL", "Anthropic 响应格式不正确。");
    const text: string[] = [];
    const proposals: ModelReply["proposals"] = [];
    for (const part of parsed.data.content) {
      if (part.type === "text") text.push(part.text);
      if (part.type === "tool_use") {
        if (part.name !== "propose_task")
          failure("MODEL_PROTOCOL", "模型请求了未授权工具。");
        proposals.push(parseProposal(part.input));
      }
    }
    return { text: text.join("\n"), proposals };
  }
  const parsed = OpenAIReply.safeParse(value);
  if (!parsed.success) failure("MODEL_PROTOCOL", "OpenAI 兼容响应格式不正确。");
  const message = parsed.data.choices[0]?.message;
  if (!message) return failure("MODEL_PROTOCOL", "模型没有返回消息。");
  const proposals = (message.tool_calls ?? []).map((call) => {
    if (call.function.name !== "propose_task")
      failure("MODEL_PROTOCOL", "模型请求了未授权工具。");
    return parseProposal(parseJson(call.function.arguments));
  });
  // 工具调用只产生提案，不发送工具结果或续轮请求，因此无需丢弃后再回传 reasoning_content。
  return { text: message.content ?? "", proposals };
}
function modelBody(
  profile: SecretProfile,
  input: ModelInput,
  attention: boolean,
): object {
  if (
    profile.thinking &&
    !["deepseek", "openai", "anthropic"].includes(profile.provider)
  ) {
    failure(
      "UNSUPPORTED_THINKING",
      "当前兼容适配器尚未实现此供应商的 thinking 参数；请关闭 thinking 或选择已支持协议。",
    );
  }
  const system = attention
    ? `${input.system}\n你只判断是否需要该员工响应。只返回 JSON 布尔值 true 或 false。不得生成任务或使用工具。`
    : `${input.system}\n需要执行任务时只能调用 propose_task 提交建议，必须等用户另行批准。`;
  if (profile.provider === "anthropic")
    return {
      model: profile.model,
      max_tokens: 4096,
      system,
      messages: input.messages,
      ...(profile.thinking
        ? { thinking: { type: "enabled", budget_tokens: 1024 } }
        : {}),
      ...(!attention
        ? {
            tools: [
              {
                name: "propose_task",
                description: proposalDescription,
                input_schema: proposalParameters,
              },
            ],
          }
        : {}),
    };
  // DeepSeek thinking + tools 的原生续轮要求完整 reasoning_content；当前端口仅有文本历史。
  // 将历史作为本轮 user 上下文，保持单轮提案协议，不伪造或丢失续轮所需的推理字段。
  const messages =
    profile.provider === "deepseek" && profile.thinking && !attention
      ? [
          {
            role: "user",
            content: `以下 JSON 是会话上下文。请根据最后的用户请求回应。\n${JSON.stringify(input.messages)}`,
          },
        ]
      : input.messages;
  return {
    model: profile.model,
    messages: [{ role: "system", content: system }, ...messages],
    ...(profile.provider === "openai"
      ? { max_completion_tokens: 4096 }
      : { max_tokens: 4096 }),
    ...(profile.provider === "deepseek"
      ? { thinking: { type: profile.thinking ? "enabled" : "disabled" } }
      : {}),
    ...(profile.provider === "openai" && profile.thinking
      ? { reasoning_effort: "high" }
      : {}),
    ...(!attention
      ? {
          tools: [
            {
              type: "function",
              function: {
                name: "propose_task",
                description: proposalDescription,
                parameters: proposalParameters,
              },
            },
          ],
        }
      : {}),
  };
}

export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export interface GatewayDependencies {
  fetch?: typeof globalThis.fetch;
  spawn?: ProcessSpawner;
  probe?: (
    executor: "codex" | "claude-code",
  ) => Promise<{ available: boolean; detail: string }>;
  kill?: typeof process.kill;
  modelTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  exitConfirmationMs?: number;
}
function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "SYSTEMROOT",
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}
function inspectCli(
  executor: "codex" | "claude-code",
): Promise<{ available: boolean; detail: string }> {
  const command = executor === "codex" ? "codex" : "claude";
  const args = executor === "codex" ? ["exec", "--help"] : ["--version"];
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 5000,
        maxBuffer: 128 * 1024,
        env: childEnvironment(),
        shell: false,
      },
      (error, stdout) => {
        if (error)
          return resolve({
            available: false,
            detail: `${command} 不可用或探测失败；未读取凭据。`,
          });
        if (executor === "claude-code")
          return resolve({
            available: false,
            detail: `已探测 Claude Code ${stdout.trim().slice(0, 80)}；当前适配器不能可靠限定非交互写范围，已禁用。`,
          });
        const flags = [
          "--ignore-user-config",
          "--sandbox",
          "--skip-git-repo-check",
          "--json",
          "--color",
        ];
        const available = flags.every((flag) => stdout.includes(flag));
        resolve({
          available,
          detail: available
            ? "已检测 Codex exec 必要参数；登录状态和真实模型执行尚未验证。"
            : "本机 Codex 缺少必要安全参数，已禁用。",
        });
      },
    );
  });
}

export function createGateways(
  dependencies: GatewayDependencies = {},
): Gateways {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const spawner: ProcessSpawner =
    dependencies.spawn ??
    ((command, args, options) =>
      spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  const probe = dependencies.probe ?? inspectCli;
  const kill = dependencies.kill ?? process.kill.bind(process);
  const maxBytes = Math.min(
    dependencies.maxOutputBytes ?? MAX_BYTES,
    MAX_BYTES,
  );
  const modelTimeout = Math.min(
    dependencies.modelTimeoutMs ?? MODEL_TIMEOUT_MS,
    MODEL_TIMEOUT_MS,
  );
  const executionTimeout = Math.min(
    dependencies.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS,
    EXECUTION_TIMEOUT_MS,
  );
  const grace = Math.min(dependencies.terminationGraceMs ?? 1000, 1000);
  const confirmation = Math.min(dependencies.exitConfirmationMs ?? 4000, 4000);

  async function request(
    profile: SecretProfile,
    input: ModelInput,
    signal: AbortSignal,
    attention: boolean,
  ): Promise<ModelReply> {
    const url = endpoint(profile);
    if (signal.aborted) throw new DOMException("请求已取消。", "AbortError");
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), modelTimeout);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (profile.provider === "anthropic") {
        headers["x-api-key"] = profile.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else headers.Authorization = `Bearer ${profile.apiKey}`;
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(modelBody(profile, input, attention)),
        signal: combined,
        redirect: "error",
      });
      if (!response.ok) {
        timeout.abort();
        failure(
          "MODEL_HTTP",
          `模型服务返回 HTTP ${response.status}；响应正文已隐藏。`,
        );
      }
      if (response.redirected)
        failure("MODEL_REDIRECT", "模型请求发生了未授权重定向。");
      if (!response.body) failure("MODEL_PROTOCOL", "模型服务未返回响应正文。");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            timeout.abort();
            failure("OUTPUT_LIMIT", "模型输出超过安全大小上限。");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const result = decode(
        profile,
        parseJson(Buffer.concat(chunks).toString("utf8")),
      );
      if (attention && result.proposals.length)
        failure("MODEL_PROTOCOL", "注意力判断不允许工具调用。");
      return result;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (signal.aborted) throw new DOMException("请求已取消。", "AbortError");
      if (timeout.signal.aborted) failure("MODEL_TIMEOUT", "模型请求超时。");
      return failure(
        "MODEL_CONNECTION",
        "模型连接失败；未返回底层错误或供应商响应正文。",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(request: ExecutionRequest): Promise<{ text: string }> {
    if (request.executor !== "codex")
      failure(
        "EXECUTOR_UNAVAILABLE",
        "Claude Code 当前无法可靠限制写范围，不允许执行，也不会替换工具。",
      );
    if (!isAbsolute(request.workspace))
      failure("INVALID_WORKSPACE", "执行目录必须为专用绝对路径。");
    if (request.signal.aborted) throw aborted();
    const detected = await probe("codex");
    if (!detected.available)
      failure("EXECUTOR_UNAVAILABLE", "Codex 不可用；未切换其它执行器。");
    if (request.signal.aborted) throw aborted();
    const args = [
      "exec",
      "--ignore-user-config",
      "-c",
      'approval_policy="never"',
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--json",
      "--color",
      "never",
      "-C",
      request.workspace,
    ];
    if (request.model.trim()) args.push("--model", request.model.trim());
    args.push("-");
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawner("codex", args, {
          cwd: request.workspace,
          env: childEnvironment(),
          shell: false,
          detached: true,
        });
      } catch {
        reject(
          new GatewayError(
            "EXECUTOR_SPAWN",
            "无法启动 Codex；底层错误已隐藏。",
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let closed = false;
      let settled = false;
      let stopReason:
        "cancel" | "timeout" | "output" | "io" | "orphan" | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => stop("timeout"), executionTimeout);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        clearTimeout(deadline);
        clearTimeout(poll);
        request.signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve({ text: text ?? "" });
      };
      const signalGroup = (
        signal: NodeJS.Signals | 0,
      ): "gone" | "present" | "unknown" => {
        if (!child.pid) return "unknown";
        try {
          kill(-child.pid, signal);
          return "present";
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return "gone";
          return "unknown";
        }
      };
      const confirmExit = () => {
        if (settled || !stopReason) return;
        if (closed && signalGroup(0) === "gone") {
          if (stopReason === "cancel") finish(aborted());
          else if (stopReason === "orphan")
            finish(
              new GatewayError(
                "UNKNOWN_PROCESS",
                "主进程退出后仍有后台进程，已尝试停止，需要人工核实任务目录。",
              ),
            );
          else
            finish(
              new GatewayError(
                stopReason === "output"
                  ? "OUTPUT_LIMIT"
                  : stopReason === "timeout"
                    ? "EXECUTION_TIMEOUT"
                    : "EXECUTOR_IO",
                "执行已终止并确认退出；达到时间、输出或输入输出安全限制。",
              ),
            );
          return;
        }
        poll = setTimeout(confirmExit, 20);
      };
      function stop(reason: "cancel" | "timeout" | "output" | "io" | "orphan") {
        if (settled || stopReason) return;
        stopReason = reason;
        // 必须终止整个进程组，并同时确认 close 和进程组消失，不能把发送信号当作已取消。
        signalGroup("SIGTERM");
        escalation = setTimeout(() => signalGroup("SIGKILL"), grace);
        deadline = setTimeout(
          () =>
            finish(
              new GatewayError(
                "UNKNOWN_PROCESS",
                "无法确认执行进程组已完全退出，任务必须标记为中断。",
              ),
            ),
          confirmation,
        );
        confirmExit();
      }
      const onAbort = () => stop("cancel");
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > maxBytes) stop("output");
        else if (!stopReason) chunks.push(data);
      });
      child.stderr.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > maxBytes) stop("output");
      });
      child.stdin.on("error", () => stop("io"));
      child.on("error", () => {
        if (!child.pid)
          finish(
            new GatewayError(
              "EXECUTOR_SPAWN",
              "无法启动 Codex；未读取或返回用户凭据。",
            ),
          );
        else stop("io");
      });
      child.on("close", (code) => {
        closed = true;
        if (stopReason) return;
        // 主进程的正常退出不能证明其后台子进程已退出。
        if (signalGroup(0) !== "gone") {
          stop("orphan");
          return;
        }
        if (code !== 0) {
          finish(
            new GatewayError(
              "EXECUTOR_EXIT",
              "Codex 退出失败；stderr 已隐藏。",
            ),
          );
          return;
        }
        const messages: string[] = [];
        for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            finish(
              new GatewayError("EXECUTOR_PROTOCOL", "Codex 返回了无效 JSONL。"),
            );
            return;
          }
          const parsed = CodexEvent.safeParse(value);
          if (parsed.success) messages.push(parsed.data.item.text);
        }
        if (!messages.length) {
          finish(
            new GatewayError("EXECUTOR_PROTOCOL", "Codex 未返回最终文本。"),
          );
          return;
        }
        finish(undefined, messages.join("\n"));
      });
      child.stdin.end(request.instruction);
    });
  }
  return {
    models: {
      respond: (profile, input, signal) =>
        request(profile, input, signal, false),
      attention: async (profile, input, signal) => {
        const result = await request(profile, input, signal, true);
        const value = parseJson(result.text.trim());
        if (typeof value !== "boolean")
          failure("MODEL_PROTOCOL", "注意力模型必须返回 JSON 布尔值。");
        return value;
      },
    },
    executors: {
      status: async () => {
        const codex = await probe("codex");
        const claude = await probe("claude-code");
        return [
          { executor: "codex", ...codex },
          { executor: "claude-code", available: false, detail: claude.detail },
        ];
      },
      run: execute,
    },
  };
}
