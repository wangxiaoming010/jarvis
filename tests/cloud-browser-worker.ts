import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Workspace } from "../server/workspace.ts";
import { createHttpServer } from "../server/http.ts";
import { startWorker } from "../server/worker.ts";
import { ExecutionLease } from "../server/lease.ts";
import { DeviceCredentialSchema } from "../shared/relay.ts";
import type { Gateways } from "../server/ports.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = z
  .object({ dataDir: z.string(), code: z.string().optional() })
  .strict()
  .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
const origin = "http://127.0.0.1:4332";
const credentialPath = resolve(input.dataDir, "fixture-device.json");
const credential = input.code
  ? DeviceCredentialSchema.parse(
      await (
        await fetch(`${origin}/worker/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: input.code }),
          redirect: "error",
        })
      ).json(),
    )
  : DeviceCredentialSchema.parse(
      JSON.parse(await readFile(credentialPath, "utf8")),
    );
await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
const lease = new ExecutionLease();
const gateways: Gateways = {
  models: {
    respond: async () => ({
      text: "云端会话已由 Mac fixture 回复。未调用真实模型。",
      proposals: [],
    }),
    attention: async () => true,
  },
  executors: {
    status: async () => [
      { executor: "codex", available: true, detail: "双进程 fixture 执行器" },
      { executor: "claude-code", available: false, detail: "未启用" },
    ],
    run: async (request) => {
      request.beforeStart?.();
      request.signal.throwIfAborted();
      await writeFile(
        resolve(request.workspace, "fixture-proof.txt"),
        "dedicated-workspace-only\n",
        { flag: "wx", mode: 0o600 },
      );
      return {
        text: "双进程 fixture 已在 Mac 专用任务目录生成证明文件。不是实际员工交付。",
      };
    },
  },
};
const workspace = new Workspace({ dataDir: input.dataDir, gateways, lease });
const worker = startWorker({
  workspace,
  dataDir: input.dataDir,
  origin,
  credential,
  lease,
  syncIntervalMs: 200,
});
const server = createHttpServer({
  workspace,
  origin: "http://127.0.0.1:4333",
  distDir: resolve("dist"),
  bootstrapToken: "cloud-mac-fixture-only",
});
server.listen(4333, "127.0.0.1", () => process.stdout.write("fixture-ready\n"));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await workspace.close();
  await new Promise<void>((done) => server.close(() => done()));
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void stop().catch(() => {
      process.exitCode = 1;
      console.error("worker fixture cleanup failed");
    });
  });
