import { chmodSync, existsSync, fsyncSync, openSync, closeSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DeviceCredentialSchema, PairInputSchema, loopbackOrigin } from "../shared/relay.ts";
import { WorkerError } from "./worker-journal.ts";
import { log } from "./log.ts";

const ConfigSchema = z.object({ origin: z.string().transform(loopbackOrigin), credential: DeviceCredentialSchema }).strict();
export function loadWorkerConfig(dataDir: string): z.infer<typeof ConfigSchema> {
  const path = join(dataDir, "worker-credential.json");
  if (!existsSync(path)) throw new WorkerError("WORKER_NOT_PAIRED");
  chmodSync(path, 0o600);
  try { return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new WorkerError("WORKER_CONFIG_INVALID"); }
}

export async function readWorkerResponse(response: Response, maxBytes = 256 * 1024): Promise<unknown> {
  if (!response.body) throw new WorkerError("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new WorkerError("RESPONSE_TOO_LARGE");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => { log("error", "worker.response_cancel_failed"); });
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export async function pairWorker(options: {
  origin: string; code: string; dataDir: string; fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const origin = loopbackOrigin(options.origin);
  const body = PairInputSchema.parse({ code: options.code });
  const response = await (options.fetch ?? globalThis.fetch)(`${origin}/worker/pair`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new WorkerError("PAIR_REJECTED");
  const credential = DeviceCredentialSchema.parse(await readWorkerResponse(response, 4096));
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(options.dataDir, 0o700);
  const path = join(options.dataDir, "worker-credential.json");
  const temp = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify({ origin, credential }));
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temp, path);
  chmodSync(path, 0o600);
  log("info", "worker.paired");
}

async function readPairCode(): Promise<string> {
  if (!process.stdin.isTTY) throw new WorkerError("INTERACTIVE_STDIN_REQUIRED");
  process.stderr.write("粘贴云端一次性配对码并回车（输入不回显）：");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((done, reject) => {
    let code = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else done(code);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return finish(new WorkerError("PAIR_CANCELLED"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") code = code.slice(0, -1);
        else if (/^[a-f0-9]$/.test(char) && code.length < 64) code += char;
        else return finish(new WorkerError("INVALID_PAIR_CODE"));
      }
    };
    process.stdin.on("data", onData);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const origin = loopbackOrigin(process.env.JARVIS_CLOUD_ORIGIN ?? "http://127.0.0.1:4321");
    const dataDir = resolve(process.env.JARVIS_DATA_DIR ?? join(root, ".jarvis-worker"));
    await pairWorker({ origin, dataDir, code: await readPairCode() });
    process.stderr.write("配对已保存。请使用 worker 模式启动；模型配置仍只在 Mac 本地修改。\n");
  } catch (error) {
    log("error", "worker.pair_failed", { code: error instanceof WorkerError ? error.code : "PAIR_FAILED" });
    process.exitCode = 1;
  }
}
