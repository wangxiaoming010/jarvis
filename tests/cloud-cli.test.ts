import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { CloudStore } from "../server/cloud-store.ts";

const cli = new URL("../server/cloud-main.ts", import.meta.url).pathname;
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const password = "fixture-cli-password-not-real";

test("CLI init/reset 只经 stdin，隔离默认目录，失败不覆盖身份或输出密码", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-cloud-cli-"));
  const run = (action: string, input: string, args: string[] = []) => spawnSync(process.execPath,
    ["--import", loader, cli, action, ...args], { cwd: root, input, encoding: "utf8", timeout: 10000 });
  try {
    const initialized = run("init", `${password}\n${password}\n`);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /身份已初始化/);
    assert.equal((initialized.stdout + initialized.stderr).includes(password), false);
    await assert.rejects(access(join(root, ".jarvis")));
    await assert.rejects(access(join(root, ".jarvis-worker")));
    const path = join(root, ".jarvis-cloud");
    assert.equal((await stat(join(path, "cloud.sqlite"))).mode & 0o777, 0o600);
    await assert.rejects(access(join(path, "instance.lock")));
    const bytes = await readFile(join(path, "cloud.sqlite"));
    assert.equal(bytes.includes(Buffer.from(password)), false);
    const duplicate = run("init", `${password}\n${password}\n`);
    assert.equal(duplicate.status, 1);
    const mismatch = run("reset", `${password}\ndifferent-password\n`);
    assert.equal(mismatch.status, 1);
    const argv = run("reset", "", ["--password", "canary-secret-in-argv"]);
    assert.equal(argv.status, 1);
    assert.equal((argv.stdout + argv.stderr).includes("canary-secret-in-argv"), false);
    const before = new CloudStore(path);
    const session = await before.login(password);
    before.close();
    const replacement = "replacement-cli-password";
    const reset = run("reset", `${replacement}\n${replacement}\n`);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal((reset.stdout + reset.stderr).includes(replacement), false);
    const after = new CloudStore(path);
    try {
      assert.equal(after.session(session.token), null);
      assert.ok((await after.login(replacement)).token);
    } finally { after.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI start 实际 loopback 监听、阻止并发目录实例、SIGTERM 正常清锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-cloud-start-"));
  const dataDir = join(root, "cloud");
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => reserve.close(() => done()));
  const store = new CloudStore(dataDir);
  await store.initialize(password);
  store.close();
  const args = ["--import", loader, cli, "start", "--data-dir", dataDir, "--port", String(port)];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 10000;
    while (!stderr.includes('"cloud.listening"')) {
      if (child.exitCode !== null || Date.now() >= deadline) assert.fail(`CLI 未启动，exit=${child.exitCode}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/mode`, { headers: { Connection: "close" } });
    assert.deepEqual(await response.json(), { mode: "cloud" });
    const duplicate = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(duplicate.status, 1);
    assert.equal(stderr.includes(password), false);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    await assert.rejects(access(join(dataDir, "instance.lock")));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
