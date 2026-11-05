import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

async function start(dataDir: string, code?: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/cloud-browser-worker.ts"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify({ dataDir, ...(code ? { code } : {}) }));
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("worker fixture startup timeout"));
    }, 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker fixture exited ${code}`));
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.stdout.on("data", (data) => {
      if (String(data).includes("fixture-ready")) {
        clearTimeout(timer);
        done();
      }
    });
  });
  return child;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker fixture stop timeout"));
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

test("独立 cloud 与 Mac 进程完成配对、模型本地配置、派单、验收及离线重连", async ({
  page,
  context,
}) => {
  test.setTimeout(100000);
  const dataDir = await mkdtemp(resolve(tmpdir(), "jarvis-mac-browser-"));
  let child: ChildProcess | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await page.getByLabel("管理员密码").fill("browser-fixture-password-only");
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "连接你的 Mac" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "生成 Mac 配对码" }).click();
    const code = await page.getByLabel("一次性配对码").inputValue();
    child = await start(dataDir, code);
    await expect(
      page.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Mac 已连接", { exact: true })).toBeVisible();
    const navigate = async (name: string) => {
      await page
        .locator("nav")
        .getByRole("button", { name: new RegExp(name) })
        .click();
    };
    await navigate("设置");
    await expect(
      page.getByRole("heading", { name: "模型配置只在 Mac 维护" }),
    ).toBeVisible();
    await expect(page.getByLabel("API 密钥")).toHaveCount(0);

    const local = await context.newPage();
    await local.goto("http://127.0.0.1:4333/#token=cloud-mac-fixture-only");
    await local.locator("nav").getByRole("button", { name: /设置/ }).click();
    const form = local
      .locator("form")
      .filter({
        has: local.getByRole("heading", { name: "主会话模型", exact: true }),
      });
    await form.getByLabel("模型名称", { exact: true }).fill("fixture-model");
    await form.getByLabel("API 密钥").fill("fixture-key-private-mac-only");
    await form.getByRole("button", { name: "保存主模型" }).click();
    await expect(form.getByText("已保存密钥")).toBeVisible();
    await local.close();
    await expect(
      page.getByText("主会话模型 · deepseek / fixture-model", { exact: true }),
    ).toBeVisible({ timeout: 15000 });

    await navigate("数字员工");
    await page.getByRole("button", { name: "＋ 添加员工" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称", { exact: true }).fill("远程助手");
    await dialog.getByLabel("角色与职责").fill("仅运行隔离测试");
    await dialog.getByRole("button", { name: "保存员工" }).click();
    await expect(page.getByRole("status")).toContainText("已由云端接收");
    await expect(
      page.getByRole("heading", { name: "远程助手", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await navigate("会话");
    await page.getByRole("button", { name: "＋ 新建会话" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("会话名称").fill("远程会话");
    await dialog.getByRole("radio").check();
    await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
    await page.getByRole("button", { name: /远程会话/ }).click();
    await page
      .getByPlaceholder("输入消息，明确你希望完成的事…")
      .fill("请确认远端消息。");
    await page.getByRole("button", { name: "发送消息 ↑" }).click();
    await expect(
      page.getByText("云端会话已由 Mac fixture 回复。未调用真实模型。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 });

    await navigate("任务");
    await page.getByRole("button", { name: "＋ 新建任务" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("任务名称").fill("跨进程验收");
    await dialog.getByLabel("任务说明").fill("在新任务隔离目录写测试文件");
    await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
    await page.getByRole("button", { name: "查看并批准" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("mac-task:");
    await dialog.getByRole("button", { name: "确认并批准" }).click();
    await expect(page.getByText("待验收", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    const taskDirs = await readdir(resolve(dataDir, "tasks"));
    expect(taskDirs).toHaveLength(1);
    expect(
      await readFile(
        resolve(dataDir, "tasks", taskDirs[0], "fixture-proof.txt"),
        "utf8",
      ),
    ).toBe("dedicated-workspace-only\n");
    await navigate("交付物");
    await page.getByRole("button", { name: "确认验收" }).click();
    await expect(page.getByText("已验收", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await page.screenshot({
      path: "test-results/cloud-workbench.png",
      fullPage: true,
    });

    await stop(child);
    child = undefined;
    await expect(page.getByText("Mac 离线", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await navigate("数字员工");
    await page.getByRole("button", { name: "＋ 添加员工" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称", { exact: true }).fill("离线排队助手");
    await dialog.getByLabel("角色与职责").fill("连接后才能创建");
    await dialog.getByRole("button", { name: "保存员工" }).click();
    await expect(
      page.getByRole("heading", { name: "离线排队助手", exact: true }),
    ).toHaveCount(0);
    await page.locator(".receipts summary").click();
    await expect(page.getByText("待 Mac 接收", { exact: true })).toBeVisible();
    child = await start(dataDir);
    await expect(
      page.getByRole("heading", { name: "离线排队助手", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByLabel("管理员密码")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await stop(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
