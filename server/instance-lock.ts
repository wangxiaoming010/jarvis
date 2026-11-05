import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const Lock = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
});
export function claimInstanceLock(dataDir: string): () => void {
  const lockPath = resolve(dataDir, "instance.lock");
  const instanceId = randomUUID();
  const candidate = resolve(dataDir, `instance-${instanceId}.tmp`);
  const fd = openSync(candidate, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, instanceId }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // 先完整写入再原子占位，其他进程不会读到半个锁文件。
    linkSync(candidate, lockPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    let previous: z.infer<typeof Lock>;
    try {
      previous = Lock.parse(JSON.parse(readFileSync(lockPath, "utf8")));
    } catch {
      throw new Error(
        `锁文件不完整。请核实没有 Jarvis 或遗留任务进程后，移走 ${lockPath} 再启动。`,
      );
    }
    try {
      process.kill(previous.pid, 0);
    } catch (probe) {
      if (probe instanceof Error && "code" in probe && probe.code === "ESRCH") {
        throw new Error(
          `旧服务已退出，但任务进程可能仍在运行。核实后移走 ${lockPath} 再启动；任务不会自动重放。`,
        );
      }
      throw new Error("无法确认旧实例状态，保留锁文件并拒绝重复启动。");
    }
    throw new Error("同一数据目录已有运行中的实例，请使用现有窗口。");
  } finally {
    unlinkSync(candidate);
  }
  return () => {
    try {
      const lock = Lock.parse(JSON.parse(readFileSync(lockPath, "utf8")));
      if (lock.instanceId === instanceId) unlinkSync(lockPath);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  };
}
