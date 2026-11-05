import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { claimInstanceLock } from "../server/instance-lock.ts";

test("原子锁不会替换活跃实例，正常释放后可重新启动", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "jarvis-lock-"));
  try {
    const release = claimInstanceLock(directory);
    assert.equal(
      JSON.parse(readFileSync(resolve(directory, "instance.lock"), "utf8")).pid,
      process.pid,
    );
    assert.throws(() => claimInstanceLock(directory), /已有运行/);
    assert.deepEqual(readdirSync(directory), ["instance.lock"]);
    release();
    claimInstanceLock(directory)();
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("历史损坏锁给出可操作错误，不自动删除不明所有者锁", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "jarvis-lock-"));
  try {
    writeFileSync(resolve(directory, "instance.lock"), "");
    assert.throws(() => claimInstanceLock(directory), /核实.*移走/);
    assert.deepEqual(readdirSync(directory), ["instance.lock"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
