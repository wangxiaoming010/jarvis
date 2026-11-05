import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Workspace } from "./workspace.ts";
import { createGateways } from "./integrations.ts";
import { createHttpServer } from "./http.ts";
import { log } from "./log.ts";
import { claimInstanceLock } from "./instance-lock.ts";
import { ExecutionLease } from "./lease.ts";
import { startWorker } from "./worker.ts";
import { loadWorkerConfig } from "./worker-pair.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerMode = process.env.JARVIS_MODE === "worker" || process.argv.includes("--worker");
const dataDir = resolve(
  process.env.JARVIS_DATA_DIR || resolve(root, workerMode ? ".jarvis-worker" : ".jarvis"),
);
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.JARVIS_PORT || (workerMode ? 4322 : 4320));
const origin = `http://127.0.0.1:${port}`;
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const unlock = claimInstanceLock(dataDir);
function releaseLock(): void {
  try {
    unlock();
  } catch {
    log("error", "lock.release_failed");
  }
}
process.on("exit", releaseLock);
const bootstrapToken = randomBytes(32).toString("hex");
writeFileSync(resolve(dataDir, "bootstrap-token"), bootstrapToken, {
  mode: 0o600,
});
chmodSync(resolve(dataDir, "bootstrap-token"), 0o600);
const lease = workerMode ? new ExecutionLease() : undefined;
const workerConfig = workerMode ? loadWorkerConfig(dataDir) : undefined;
const workspace = new Workspace({ dataDir, gateways: createGateways(), lease });
const worker = workerConfig && lease ? startWorker({
  workspace, dataDir, lease, ...workerConfig, sensitiveValues: [bootstrapToken],
}) : undefined;
const server = createHttpServer({
  workspace,
  origin,
  distDir: resolve(root, "dist"),
  bootstrapToken,
});
let closing = false;
async function stop(signal: string) {
  if (closing) return;
  closing = true;
  log("info", "service.stopping", { signal });
  server.close();
  try {
    await worker?.stop();
    await workspace.close();
  } catch {
    log("error", "workspace.close_failed");
  }
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", () => {
  void stop("SIGINT");
});
process.on("SIGTERM", () => {
  void stop("SIGTERM");
});
server.on("error", (error) => {
  log("error", "service.listen_failed", {
    code: "code" in error ? String(error.code) : "UNKNOWN",
  });
  void (async () => {
    await worker?.stop();
    await workspace.close();
  })().finally(() => {
    releaseLock();
    process.exit(1);
  });
});
server.listen(port, "127.0.0.1", () => {
  log("info", "service.started", { port });
  process.stderr.write(
    `Jarvis 工作台已启动：${origin}\n本机登录凭据保存在 ${workerMode ? ".jarvis-worker" : ".jarvis"}/bootstrap-token，不要提交或分享。\n`,
  );
  if (process.env.JARVIS_OPEN === "1" && process.platform === "darwin") {
    const browser = spawn("open", [`${origin}/#token=${bootstrapToken}`], {
      stdio: "ignore",
    });
    browser.on("error", () => log("error", "browser.open_failed"));
  }
});
