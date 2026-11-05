import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const notices = [];
async function inspect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await inspect(path);
      continue;
    }
    const files = await readdir(path);
    if (!files.includes("package.json")) continue;
    const pkg = JSON.parse(
      await readFile(resolve(path, "package.json"), "utf8"),
    );
    const licenseFiles = files
      .sort()
      .filter((name) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(name));
    const texts = [];
    for (const name of licenseFiles)
      texts.push({ label: name, bytes: await readFile(resolve(path, name)) });
    if (
      !texts.length &&
      (pkg.name.startsWith("@esbuild/") || pkg.name.startsWith("@rollup/"))
    ) {
      const owner = pkg.name.startsWith("@esbuild/") ? "esbuild" : "rollup";
      const ownerPath = resolve(root, "node_modules", owner);
      const ownerPackage = JSON.parse(
        await readFile(resolve(ownerPath, "package.json"), "utf8"),
      );
      if (
        !pkg.repository?.url ||
        ownerPackage.repository?.url !== pkg.repository.url ||
        ownerPackage.version !== pkg.version ||
        ownerPackage.license !== pkg.license
      )
        throw new Error(`License owner mismatch: ${pkg.name}`);
      for (const name of (await readdir(ownerPath))
        .sort()
        .filter((name) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(name))) {
        texts.push({
          label: `同一发布仓库及版本 ${owner} 的 ${name}`,
          bytes: await readFile(resolve(ownerPath, name)),
        });
      }
    }
    if (!texts.length && pkg.license !== "UNLICENSED")
      throw new Error(`Missing license text: ${pkg.name}`);
    notices.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      texts,
    });
    if (files.includes("node_modules"))
      await inspect(resolve(path, "node_modules"));
  }
}
await inspect(resolve(root, "node_modules"));
notices.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const index = [
  "# 第三方依赖许可索引",
  "",
  "由 `npm run notices` 根据本机实际安装依赖生成，包含开发工具；不是全部平台可选依赖清单。本源码仓库不包含第三方依赖实现或 Node.js 运行时。",
  "",
  "本文件只列依赖元数据，不是完整版权声明或许可原文。`npm run build` 在构建结束后自动生成 `dist/THIRD_PARTY_NOTICES.txt`，保留安装包中收集到的完整原文，也可在工作台的“第三方许可”入口查看。",
  "",
  "安装依赖中的 LICENSE / NOTICE 不作改写。分发包含第三方实现的构建包时，必须附带相应完整声明并遵守各依赖许可；不能用本索引替代。",
  "",
  "| 依赖 | 版本 | 声明许可 | 来源 |",
  "| --- | --- | --- | --- |",
];
const full = [
  Buffer.from(
    "Jarvis 第三方依赖声明\n\n按本机实际安装依赖收集，包含开发工具。以下各原文块保留源文件字节。平台包未附许可文件时，收录同一仓库、版本及声明许可的父包原文。此清单不构成对其他分发义务的鉴定。\n",
  ),
];
for (const item of notices) {
  const license =
    typeof item.license === "string"
      ? item.license
      : JSON.stringify(item.license);
  index.push(
    `| ${item.name} | ${item.version} | ${license} | [npm](https://www.npmjs.com/package/${encodeURIComponent(item.name)}/v/${encodeURIComponent(item.version)}) |`,
  );
  full.push(
    Buffer.from(`\n\n## ${item.name} ${item.version}\n声明许可：${license}\n`),
  );
  for (const text of item.texts) {
    full.push(Buffer.from(`\n### ${text.label}\n\n`), text.bytes);
  }
}
const sourceIndex = index.join("\n") + "\n";
if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(sourceIndex))
  throw new Error(
    "Source catalog contains contact information; review dependency metadata.",
  );
// 构建产物包含依赖代码，声明原文只能按字节保留，不能套用源码索引的字段投影。
await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(
  resolve(root, "dist/THIRD_PARTY_NOTICES.txt"),
  Buffer.concat(full),
);
await writeFile(resolve(root, "THIRD_PARTY_NOTICES.md"), sourceIndex);
process.stdout.write(
  `已生成 ${notices.length} 个依赖的源码索引及构建许可原文。\n`,
);
