import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as nativeRequest } from "node:http";
import { Workspace } from "../server/workspace.ts";
import { createHttpServer } from "../server/http.ts";
import type { Gateways } from "../server/ports.ts";

test("HTTP 验证本机身份、跨站防护、幂等、密钥脱敏和静态边界", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jarvis-http-"));
  const dist = resolve(root, "dist");
  await mkdir(resolve(dist, "assets"), { recursive: true });
  await writeFile(resolve(dist, "index.html"), "<h1>Jarvis fixture</h1>");
  const noticePath = resolve(dist, "THIRD_PARTY_NOTICES.txt");
  const licenseBytes = Buffer.from("Copyright Fixture  \r\n许可原文\r\n");
  await writeFile(noticePath, licenseBytes);
  await writeFile(resolve(root, "private.txt"), "do not expose");
  await symlink(
    resolve(root, "private.txt"),
    resolve(dist, "assets", "secret.js"),
  );
  const gateways: Gateways = {
    models: {
      respond: async () => ({ text: "fixture reply", proposals: [] }),
      attention: async () => false,
    },
    executors: {
      status: async () => [
        { executor: "codex", available: true, detail: "fixture" },
        { executor: "claude-code", available: false, detail: "fixture" },
      ],
      run: async () => ({ text: "fixture result" }),
    },
  };
  const workspace = new Workspace({ dataDir: resolve(root, "data"), gateways });
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const server = createHttpServer({
    workspace,
    origin,
    distDir: dist,
    bootstrapToken: "fixture-token",
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let cookie = "";
  const call = (
    path: string,
    method = "GET",
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Jarvis-Request": "1",
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  try {
    assert.equal((await call("/api/snapshot")).status, 401);
    assert.equal((await call("/api/health")).status, 200);
    const notices = await call("/THIRD_PARTY_NOTICES.txt");
    assert.equal(notices.status, 200);
    assert.equal(
      notices.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.deepEqual(Buffer.from(await notices.arrayBuffer()), licenseBytes);
    const noticeHead = await call("/THIRD_PARTY_NOTICES.txt", "HEAD");
    assert.equal(noticeHead.status, 200);
    assert.equal(await noticeHead.text(), "");
    await rm(noticePath);
    assert.equal((await call("/THIRD_PARTY_NOTICES.txt")).status, 404);
    await symlink(resolve(root, "private.txt"), noticePath);
    assert.equal((await call("/THIRD_PARTY_NOTICES.txt")).status, 403);
    assert.equal(
      (
        await call(
          "/api/session",
          "POST",
          { token: "fixture-token" },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/session", "POST", { token: "wrong" })).status,
      401,
    );
    const login = await call("/api/session", "POST", {
      token: "fixture-token",
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
    assert.ok(cookie);
    assert.ok(cookie.startsWith(`jarvis_local_${port}=`), "不同本机端口不覆盖旧版会话 cookie");
    assert.match(
      login.headers.get("set-cookie") || "",
      /HttpOnly.*SameSite=Strict/,
    );
    assert.equal(
      (await call("/api/employees", "POST", {}, { "X-Jarvis-Request": "" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/employees", "POST", { name: "", executor: "codex" }))
        .status,
      400,
    );
    const employeeResponse = await call("/api/employees", "POST", {
      name: "测试员工",
      role: "执行测试",
      executor: "codex",
    });
    assert.equal(employeeResponse.status, 201);
    const employee = await employeeResponse.json();
    const conversation = await (
      await call("/api/conversations", "POST", {
        title: "测试私聊",
        kind: "direct",
        memberIds: [employee.id],
      })
    ).json();
    const payload = { id: crypto.randomUUID(), content: "你好", mentions: [] };
    assert.equal(
      (
        await call(
          `/api/conversations/${conversation.id}/messages`,
          "POST",
          payload,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          `/api/conversations/${conversation.id}/messages`,
          "POST",
          payload,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(`/api/conversations/${conversation.id}/messages`, "POST", {
          ...payload,
          content: "changed",
        })
      ).status,
      409,
    );
    const key = "fixture-secret-never-return";
    const model = await call("/api/settings/model", "POST", {
      purpose: "main",
      provider: "deepseek",
      endpoint: "https://api.deepseek.com",
      model: "test",
      thinking: false,
      apiKey: key,
    });
    assert.equal(model.status, 200);
    assert.ok(!(await model.text()).includes(key));
    const snapshot = await call("/api/snapshot");
    assert.equal(snapshot.status, 200);
    const snapshotText = await snapshot.text();
    assert.ok(!snapshotText.includes(key));
    assert.ok(snapshotText.includes("测试员工"));
    assert.equal((await call("/assets/secret.js")).status, 403);
    const externalHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = nativeRequest(
          origin + "/api/health",
          { headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(externalHost, 403);
    const secondLogin = await fetch(origin + "/api/session", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Jarvis-Request": "1",
      },
      body: JSON.stringify({ token: "fixture-token" }),
    });
    assert.equal(secondLogin.status, 401);
  } finally {
    await workspace.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
