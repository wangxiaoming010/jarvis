import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "jarvis-notices-"));
  await mkdir(resolve(root, "scripts"));
  await copyFile(
    resolve("scripts/notices.mjs"),
    resolve(root, "scripts/notices.mjs"),
  );
  return root;
}
async function dependency(
  root: string,
  path: string,
  name: string,
  license?: Buffer,
) {
  const directory = resolve(root, "node_modules", path);
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      license: "MIT",
      repository: { url: "https://example.invalid/fixture" },
    }),
  );
  if (license) await writeFile(resolve(directory, "LICENSE"), license);
}
function generate(root: string) {
  return execFileSync(
    process.execPath,
    [resolve(root, "scripts/notices.mjs")],
    { encoding: "utf8", stdio: "pipe" },
  );
}

test("源码许可索引不含邮箱，产物保留嵌套依赖和平台包许可原始字节", async () => {
  const root = await fixture();
  const license = Buffer.from(
    "Copyright Fixture  \r\n```text\r\n许可原始字节\r\n",
  );
  try {
    await dependency(root, "fixture", "fixture", license);
    await dependency(root, "fixture/node_modules/nested", "nested", license);
    await dependency(root, "esbuild", "esbuild", license);
    await dependency(root, "@esbuild/fixture", "@esbuild/fixture");
    generate(root);
    const index = await readFile(
      resolve(root, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    assert.match(index, /许可索引/);
    assert.match(index, /@esbuild\/fixture/);
    assert.match(index, /nested/);
    assert.doesNotMatch(index, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    assert.ok(!index.includes("Copyright Fixture"));
    const full = await readFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"));
    assert.equal(full.toString().split(license.toString()).length - 1, 4);
    assert.ok(full.includes(license));
    generate(root);
    assert.deepEqual(
      await readFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt")),
      full,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺少依赖许可原文时生成失败，不发布空声明", async () => {
  const root = await fixture();
  try {
    await dependency(root, "missing", "missing");
    assert.throws(() => generate(root), /Missing license text: missing/);
    await assert.rejects(
      readFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("平台包与父包版本不一致时拒绝借用许可", async () => {
  const root = await fixture();
  try {
    await dependency(
      root,
      "esbuild",
      "esbuild",
      Buffer.from("Copyright Fixture\n"),
    );
    await dependency(root, "@esbuild/fixture", "@esbuild/fixture");
    const path = resolve(root, "node_modules/@esbuild/fixture/package.json");
    const pkg = JSON.parse(await readFile(path, "utf8"));
    pkg.version = "2.0.0";
    await writeFile(path, JSON.stringify(pkg));
    assert.throws(() => generate(root), /License owner mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
