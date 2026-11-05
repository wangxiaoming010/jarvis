import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { z } from "zod";
import { CloudError, CloudStore, createCloudServer } from "./cloud.ts";
import { claimInstanceLock } from "./instance-lock.ts";
import { log } from "./log.ts";

type Options = { action: "init" | "reset" | "start"; dataDir: string; port: number };
function options(args: string[]): Options {
  const action = z.enum(["init", "reset", "start"]).parse(args[0]);
  let dataDir = resolve(process.cwd(), ".jarvis-cloud");
  let port = 4321;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || seen.has(key)) throw new Error("启动参数不正确。");
    seen.add(key);
    if (key === "--data-dir") dataDir = resolve(value);
    else if (key === "--port" && /^\d+$/.test(value)) port = z.number().int().min(1024).max(65535).parse(Number(value));
    else throw new Error("只支持 --data-dir 与 --port，不接受命令行密码。");
  }
  return { action, dataDir, port };
}
async function passwordFromStdin(): Promise<string> {
  // readline 负责终端编辑，输出流丢弃回显；密码不进入 argv、环境变量或日志。
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) });
  const lines = input[Symbol.asyncIterator]();
  try {
    process.stdout.write("输入新的云端密码（16 至 256 字符，不回显）: ");
    const first = await lines.next();
    process.stdout.write("\n再次输入密码: ");
    const second = await lines.next();
    process.stdout.write("\n");
    if (first.done || second.done || first.value !== second.value)
      throw new Error("两次密码不一致，或未完整输入。");
    return z.string().min(16).max(256).parse(first.value);
  } finally {
    input.close();
  }
}
export async function runCloudCli(args: string[]): Promise<void> {
  const config = options(args);
  const store = new CloudStore(config.dataDir);
  let release: (() => void) | undefined;
  let running = false;
  try {
    release = claimInstanceLock(store.dataDir);
    if (config.action !== "start") {
      const password = await passwordFromStdin();
      if (config.action === "init") await store.initialize(password);
      else await store.resetPassword(password);
      process.stdout.write(config.action === "init" ? "云端身份已初始化。\n" : "云端密码已重置，旧会话与设备已撤销。\n");
      return;
    }
    const origin = `http://127.0.0.1:${config.port}`;
    const server = createCloudServer({
      store, origin, distDir: resolve(dirname(fileURLToPath(import.meta.url)), "../dist"),
    });
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
    running = true;
    log("info", "cloud.listening", { origin });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close((error) => {
        try {
          store.close();
          release?.();
          if (error) {
            log("error", "cloud.shutdown_failed");
            process.exitCode = 1;
          }
        } catch {
          log("error", "cloud.shutdown_failed");
          process.exitCode = 1;
        }
      });
      server.closeIdleConnections();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } finally {
    if (!running) {
      store.close();
      release?.();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCloudCli(process.argv.slice(2)).catch((error: unknown) => {
    log("error", "cloud.start_failed", {
      code: error instanceof CloudError ? error.code : error instanceof z.ZodError ? "VALIDATION" : "START_FAILED",
    });
    process.stderr.write("云端命令失败。请检查输入、端口与专用目录状态；未自动覆盖现有身份。\n");
    process.exitCode = 1;
  });
}
