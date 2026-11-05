import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Workspace } from "../server/workspace.ts";
import { createHttpServer } from "../server/http.ts";
import type { Gateways } from "../server/ports.ts";

const dataDir = await mkdtemp(resolve(tmpdir(), "jarvis-browser-"));
const gateways: Gateways = {
  models: {
    respond: async () => ({
      text: "浏览器测试回复，未调用真实模型。",
      proposals: [],
    }),
    attention: async () => true,
  },
  executors: {
    status: async () => [
      { executor: "codex", available: true, detail: "浏览器隔离测试执行器" },
      { executor: "claude-code", available: false, detail: "未启用" },
    ],
    run: async (request) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("fixture取消", "AbortError"));
          },
          { once: true },
        );
      });
      return {
        text: "浏览器测试交付物。这是隔离 fixture，不是真实员工完成的工作。",
      };
    },
  },
};
const workspace = new Workspace({ dataDir, gateways });
const server = createHttpServer({
  workspace,
  origin: "http://127.0.0.1:4331",
  distDir: resolve("dist"),
  bootstrapToken: "browser-fixture-only",
});
server.listen(4331, "127.0.0.1");
async function close() {
  await workspace.close();
  server.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
