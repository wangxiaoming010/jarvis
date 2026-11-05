import { test, expect } from "@playwright/test";

test("真实浏览器完成配置、协作、批准、交付、验收及窄屏导航", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#token=browser-fixture-only");
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("token");
  const noticePagePromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "第三方许可" }).click();
  const noticePage = await noticePagePromise;
  await expect(noticePage.locator("body")).toContainText(
    "Jarvis 第三方依赖声明",
  );
  await expect(noticePage.locator("body")).toContainText(
    "Permission is hereby granted",
  );
  await noticePage.close();
  await page.screenshot({ path: "test-results/local-workbench.png", fullPage: true });
  const navigate = async (name: string) => {
    await page
      .locator("nav")
      .getByRole("button", { name: new RegExp(name) })
      .click();
  };

  await navigate("设置");
  const mainModel = page.locator("form").filter({
    has: page.getByRole("heading", { name: "主会话模型", exact: true }),
  });
  await expect(mainModel.getByLabel("模型供应商")).toHaveValue("deepseek");
  expect(
    await mainModel.getByLabel("模型供应商").locator("option").count(),
  ).toBe(9);
  await mainModel.getByLabel("模型名称", { exact: true }).fill("fixture-model");
  await mainModel.getByLabel("API 密钥").fill("fixture-key-browser");
  await mainModel.getByRole("button", { name: "保存主模型" }).click();
  await expect(mainModel.getByText("已保存密钥")).toBeVisible();
  await expect(mainModel.getByLabel("API 密钥")).toHaveValue("");

  await navigate("数字员工");
  await page.getByRole("button", { name: "＋ 添加员工" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("验收助手");
  await dialog
    .getByLabel("角色与职责")
    .fill("仅用于隔离浏览器验收，不是真实员工任务。");
  await dialog.getByRole("button", { name: "保存员工" }).click();
  await expect(
    page.getByRole("heading", { name: "验收助手", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理记忆" }).click();
  await page.getByPlaceholder("添加一条长期记忆").fill("测试回复使用中文。");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("测试回复使用中文。")).toBeVisible();

  await navigate("会话");
  await page.getByRole("button", { name: "＋ 新建会话" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("会话名称").fill("本地验收会话");
  await dialog.getByLabel("会话类型").selectOption("group");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
  await page.getByRole("button", { name: /本地验收会话/ }).click();
  await page.locator(".composer").getByRole("checkbox").check();
  await page
    .getByPlaceholder("输入消息，明确你希望完成的事…")
    .fill("请确认本地会话流程。");
  await page.getByRole("button", { name: "发送消息 ↑" }).click();
  await expect(
    page.getByText("浏览器测试回复，未调用真实模型。", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[role=alert]")).toHaveCount(0);

  await navigate("任务");
  await page.getByRole("button", { name: "＋ 新建任务" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("任务名称").fill("工作台验收任务");
  await dialog
    .getByLabel("任务说明")
    .fill("验证任务状态流转，不执行真实 CLI。");
  await dialog.getByLabel("验收标准").fill("有明确的 fixture 交付结果。");
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  await page.getByRole("button", { name: "查看并批准" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("workspace-write")).toBeVisible();
  await expect(dialog.getByText("批准后 30 分钟")).toBeVisible();
  await dialog.getByRole("button", { name: "确认并批准" }).click();
  await expect(page.getByText("待验收", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await navigate("交付物");
  await expect(
    page.getByText(
      "浏览器测试交付物。这是隔离 fixture，不是真实员工完成的工作。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认验收" }).click();
  await expect(page.getByText("已验收", { exact: true })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  await navigate("任务");
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate("设置");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-fixture.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
