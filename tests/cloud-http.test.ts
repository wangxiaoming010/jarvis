import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer as reserveServer } from "node:net";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { CloudStore, createCloudServer } from "../server/cloud.ts";
import { DeviceCredentialSchema, type Publication } from "../shared/relay.ts";

const password = "cloud-http-fixture-password";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-cloud-http-"));
  const distDir = join(root, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<h1>Cloud fixture</h1>");
  await writeFile(join(root, "private"), "secret-path-canary");
  await symlink(join(root, "private"), join(distDir, "assets", "private.js"));
  const licenseBytes = Buffer.from("Copyright fixture  \r\n许可原文\r\n");
  await writeFile(join(distDir, "THIRD_PARTY_NOTICES.txt"), licenseBytes);
  const reserve = reserveServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => reserve.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = join(root, "data");
  let store = new CloudStore(dataDir);
  await store.initialize(password);
  let server = createCloudServer({ store, origin, distDir });
  const start = async () => { server.listen(port, "127.0.0.1"); await once(server, "listening"); };
  await start();
  const closeServer = async () => {
    const closed = new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    server.closeAllConnections();
    await closed;
  };
  return {
    root, origin, distDir, licenseBytes, get store() { return store; }, get server() { return server; },
    restart: async () => { await closeServer(); store.close(); store = new CloudStore(dataDir); server = createCloudServer({ store, origin, distDir }); await start(); },
    cleanup: async () => { await closeServer(); store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function call(origin: string, path: string, method = "GET", payload?: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + path, {
    method, headers: { Connection: "close", Origin: origin, "Content-Type": "application/json", "X-Jarvis-Request": "1", ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error",
  });
}
async function login(origin: string) {
  const response = await call(origin, "/api/session", "POST", { password });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(body && typeof body === "object" && "csrf" in body && typeof body.csrf === "string");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\//);
  return { Cookie: cookie, "X-Jarvis-CSRF": body.csrf };
}

const snapshot: Publication["snapshot"] = {
  employees: [], conversations: [], messages: [], tasks: [], artifacts: [], memories: [], notices: [], rules: [],
  settings: { main: null, attention: null, attentionUseMain: true, maxWorkers: 2, codexModel: "" }, executors: [],
};

test("HTTP 持久登录、精确来源与 CSRF、退出后重登及安全错误", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await (await call(f.origin, "/api/mode")).json(), { mode: "cloud" });
    assert.equal((await call(f.origin, "/api/cloud/view")).status, 401);
    const rejectedHeaders: Record<string, string>[] = [{ Origin: "http://127.0.0.1:1" }, { "X-Jarvis-Request": "0" }];
    for (const headers of rejectedHeaders)
      assert.equal((await call(f.origin, "/api/session", "POST", { password }, headers)).status, 403);
    assert.equal((await call(f.origin, "/api/session", "POST", { password }, { "Content-Type": "application/json-evil" })).status, 415);
    assert.equal((await call(f.origin, "/api/session", "POST", { password: "wrong-but-long-enough" })).status, 401);
    assert.equal((await call(f.origin, "/api/session", "POST", { password, unexpected: true })).status, 400);
    const headers = await login(f.origin);
    const firstSession = await (await call(f.origin, "/api/session", "GET", undefined, headers)).json();
    assert.deepEqual(firstSession, { csrf: headers["X-Jarvis-CSRF"] });
    await f.restart();
    assert.equal((await call(f.origin, "/api/cloud/view", "GET", undefined, headers)).status, 200);
    assert.equal((await call(f.origin, "/api/cloud/pair", "POST", {}, { Cookie: headers.Cookie })).status, 403);
    assert.equal((await call(f.origin, "/api/cloud/pair", "POST", {}, { ...headers, "X-Jarvis-CSRF": "wrong" })).status, 403);
    const other = await login(f.origin);
    assert.equal((await call(f.origin, "/api/cloud/pair", "POST", {}, { ...headers, "X-Jarvis-CSRF": other["X-Jarvis-CSRF"] })).status, 403);
    assert.equal((await call(f.origin, "/api/cloud/view", "GET", undefined, { ...headers, Authorization: `Bearer ${"a".repeat(64)}` })).status, 403);
    assert.equal((await call(f.origin, "/api/cloud/pair", "POST", { extra: true }, headers)).status, 400);
    const large = await call(f.origin, "/api/session", "POST", { password: "CANARY-DO-NOT-ECHO".repeat(20000) });
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { error: "请求内容过大。", code: "BODY_TOO_LARGE" });
    const invalidJson = await fetch(f.origin + "/api/session", {
      method: "POST", headers: { Connection: "close", Origin: f.origin, "Content-Type": "application/json", "X-Jarvis-Request": "1" }, body: "CANARY-DO-NOT-ECHO",
    });
    assert.deepEqual(await invalidJson.json(), { error: "JSON 格式错误。", code: "INVALID_JSON" });
    assert.equal((await call(f.origin, "/api/logout", "POST", {}, headers)).status, 200);
    await f.restart();
    assert.equal((await call(f.origin, "/api/session", "GET", undefined, headers)).status, 401);
    assert.ok(await login(f.origin));
  } finally { await f.cleanup(); }
});

test("HTTP 设备和浏览器权限隔离、命令回执、旧代际拒绝", async () => {
  const f = await fixture();
  try {
    const headers = await login(f.origin);
    const pairingResponse = await call(f.origin, "/api/cloud/pair", "POST", {}, headers);
    const pairing = await pairingResponse.json();
    assert.equal(pairingResponse.status, 200);
    assert.equal((await call(f.origin, "/worker/pair", "POST", { code: pairing.code }, headers)).status, 403);
    const paired = await call(f.origin, "/worker/pair", "POST", { code: pairing.code });
    assert.equal(paired.status, 200);
    const device = DeviceCredentialSchema.parse(await paired.json());
    assert.equal((await call(f.origin, "/worker/pair", "POST", { code: pairing.code })).status, 401);
    const workerHeaders = { Authorization: `Bearer ${device.token}` };
    const sync = { deviceId: device.deviceId, generation: device.generation, receipts: [] };
    assert.equal((await call(f.origin, "/worker/sync", "POST", sync, { Cookie: headers.Cookie, ...workerHeaders })).status, 403);
    assert.equal((await call(f.origin, "/worker/sync", "POST", sync)).status, 401);
    assert.equal((await call(f.origin, "/worker/sync", "POST", { ...sync, generation: device.generation + 1 }, workerHeaders)).status, 401);
    assert.equal((await call(f.origin, "/worker/sync", "POST", { ...sync, leaked: "no" }, workerHeaders)).status, 400);
    const nestedSecret = { ...snapshot, settings: { ...snapshot.settings, main: {
      provider: "openai", endpoint: "https://local.invalid", model: "fixture", thinking: false, hasKey: true,
      apiKey: "NESTED-SECRET-CANARY",
    } } };
    const unsafe = await call(f.origin, "/worker/sync", "POST", { ...sync, publication: { revision: 1, snapshot: nestedSecret } }, workerHeaders);
    assert.equal(unsafe.status, 400);
    assert.equal((await unsafe.text()).includes("NESTED-SECRET-CANARY"), false);
    const requestId = randomUUID();
    const command = { kind: "employee.create", input: { name: "测试", role: "测试", executor: "codex" } };
    const submitted = await call(f.origin, "/api/cloud/commands", "POST", { requestId, command }, headers);
    assert.equal(submitted.status, 202);
    assert.equal((await submitted.json()).status, "queued");
    const delivered = await call(f.origin, "/worker/sync", "POST", { ...sync, publication: { revision: 1, snapshot } }, workerHeaders);
    assert.equal(delivered.status, 200);
    const delivery = await delivered.json();
    assert.equal(delivery.command.commandId, requestId);
    assert.equal(delivery.leaseMs, 15000);
    assert.equal((await call(f.origin, "/api/cloud/commands", "POST", { requestId, command }, headers)).status, 202);
    const acked = await call(f.origin, "/worker/sync", "POST", {
      ...sync, receipts: [{ commandId: requestId, status: "applied", updatedAt: new Date().toISOString() }],
    }, workerHeaders);
    assert.equal(acked.status, 200);
    assert.deepEqual((await acked.json()).acknowledgedIds, [requestId]);
    const view = await (await call(f.origin, "/api/cloud/view", "GET", undefined, headers)).json();
    assert.equal(view.receipts[0].status, "applied");
    assert.equal(view.link.state, "online");
    assert.ok(view.link.lastSyncedAt);
    assert.equal((await call(f.origin, "/api/cloud/revoke", "POST", {}, headers)).status, 200);
    const rejected = await call(f.origin, "/worker/sync", "POST", sync, workerHeaders);
    assert.equal(rejected.status, 401);
    const rejectedBody = await rejected.text();
    assert.equal(rejectedBody.includes(device.token), false);
    assert.equal(rejectedBody.includes(f.root), false);
    assert.equal((await call(f.origin, "/api/settings/model", "POST", { apiKey: "CANARY" }, headers)).status, 404);
  } finally { await f.cleanup(); }
});

test("HTTP 精确 Host、强制 loopback 与构建目录静态边界", async () => {
  const f = await fixture();
  try {
    const address = f.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    const forbidden = createCloudServer({ store: f.store, origin: f.origin, distDir: f.distDir });
    assert.throws(() => forbidden.listen(0, "0.0.0.0"), /127\.0\.0\.1/);
    assert.throws(() => forbidden.listen({ port: 0, host: "::" }), /127\.0\.0\.1/);
    assert.throws(() => forbidden.listen({ port: 0, fd: 123 }), /已有 socket/);
    assert.throws(() => forbidden.listen(join(f.root, "socket")), /loopback/);
    assert.throws(() => createCloudServer({ store: f.store, origin: "http://0.0.0.0:4321", distDir: f.distDir }));
    const response = await new Promise<{ status: number; body: string }>((done, reject) => {
      const req = request(f.origin + "/api/mode", { headers: { Host: "evil.invalid" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).code, "HOST_REJECTED");
    assert.match(await (await call(f.origin, "/")).text(), /Cloud fixture/);
    assert.equal((await call(f.origin, "/assets/private.js")).status, 403);
    assert.equal((await call(f.origin, "/assets/missing.js")).status, 404);
    const notices = await call(f.origin, "/THIRD_PARTY_NOTICES.txt");
    assert.deepEqual(Buffer.from(await notices.arrayBuffer()), f.licenseBytes);
    assert.equal(await (await call(f.origin, "/THIRD_PARTY_NOTICES.txt", "HEAD")).text(), "");
    await rm(join(f.distDir, "THIRD_PARTY_NOTICES.txt"));
    await symlink(join(f.root, "private"), join(f.distDir, "THIRD_PARTY_NOTICES.txt"));
    assert.equal((await call(f.origin, "/THIRD_PARTY_NOTICES.txt")).status, 403);
    assert.equal((await call(f.origin, "/api/mode?token=must-not-use-url")).status, 400);
  } finally { await f.cleanup(); }
});
