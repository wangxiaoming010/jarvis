import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CloudStore, createCloudServer } from "../server/cloud.ts";

const dataDir = await mkdtemp(resolve(tmpdir(), "jarvis-cloud-browser-"));
const store = new CloudStore(dataDir);
await store.initialize("browser-fixture-password-only");
const server = createCloudServer({
  store,
  origin: "http://127.0.0.1:4332",
  distDir: resolve("dist"),
});
server.listen(4332, "127.0.0.1");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void stop().catch(() => {
      process.exitCode = 1;
      console.error("cloud fixture cleanup failed");
    });
  });
