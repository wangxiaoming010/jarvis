import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const path of paths) {
  if (
    /(^|\/)(\.jarvis(?:-cloud|-worker)?|\.data|node_modules|dist|test-results|playwright-report)(\/|$)|(^|\/)\.env($|\.)|bootstrap-token|worker-credential\.json$|secrets\.json$|\.sqlite(?:-wal|-shm)?$/.test(
      path,
    )
  )
    failures.push(`不应发布的路径：${path}`);
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text))
    failures.push(`源码文件包含邮箱，请核实发布范围：${path}`);
  if (
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{40,}/.test(
      text,
    )
  )
    failures.push(`疑似凭据：${path}`);
}
if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(
  `已检查 ${paths.length} 个受版本管理文件，未发现禁用路径、邮箱或匹配的凭据模式。\n`,
);
